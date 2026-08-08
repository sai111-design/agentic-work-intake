/**
 * Gemini adapter. THE ONLY FILE IN THIS PROJECT THAT IMPORTS @google/genai.
 *
 * Shapes here were confirmed against the installed SDK's type definitions
 * rather than documentation — two doc sources disagreed on both the
 * response_format shape and the output accessor. See docs/sdk-spike.md.
 *
 * Verified against @google/genai 2.16.0:
 *   - response_format accepts `Array<ResponseFormat> | ResponseFormat`; the
 *     text variant is `{ type: 'text', mime_type, schema }`
 *   - `interaction.output_text` exists but is OPTIONAL — absence is a real
 *     failure case, not something to coerce to ''
 *   - httpOptions supports `timeout` (ms) and `retryOptions`
 *   - the SDK retries 5 times by default on 408/429/5xx, so this adapter adds
 *     NO transport retry of its own; doing so would stack to 10 attempts
 */

import { GoogleGenAI } from '@google/genai';
import type { z } from 'zod';

import { config, isLlmConfigured } from '../config.js';
import { InterpretationSchema, type Interpretation } from '../core/schemas.js';
import { DRAFTER_SYSTEM_PROMPT, INTERPRETER_SYSTEM_PROMPT } from './prompt.js';
import {
  DraftSchema,
  LlmError,
  type DraftInput,
  type DraftOutput,
  type LLMProvider,
} from './provider.js';
import { draftJsonSchema, interpretationJsonSchema } from './schema-to-json.js';
import { parseAndValidate } from './structured.js';

/** Per-call ceiling. Flash is fast; anything slower than this is a failure. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Total attempts including the original. The SDK's default of 5 with
 * exponential backoff (up to 60s) can stall for minutes — unacceptable during
 * a demo, and it hides failure rather than surfacing it.
 */
const TRANSPORT_ATTEMPTS = 2;

/**
 * Extraction is a reading task, not a reasoning one, so the shallowest setting
 * is both the fastest and — measured against all three assignment scenarios —
 * just as accurate. Raise to 'low' if extraction quality ever regresses.
 */
const THINKING_LEVEL = 'minimal';

let client: GoogleGenAI | null = null;

/** Lazy so that importing this module without a key does not throw. */
function getClient(): GoogleGenAI {
  if (!isLlmConfigured()) {
    throw new LlmError('LLM_NOT_CONFIGURED', 'GEMINI_API_KEY is not set.');
  }
  client ??= new GoogleGenAI({
    apiKey: config.geminiApiKey,
    httpOptions: {
      timeout: REQUEST_TIMEOUT_MS,
      retryOptions: { attempts: TRANSPORT_ATTEMPTS },
    },
  });
  return client;
}

/**
 * HTTP status from an SDK error.
 *
 * Deliberately duck-typed rather than `err instanceof ApiError`: the SDK
 * throws subclasses such as NotFoundError and BadRequestError that carry a
 * `status` but do NOT satisfy `instanceof ApiError`. Relying on the class
 * check silently collapsed every failure into a generic "could not reach
 * Gemini", which hid a 404 telling us the model was unavailable.
 */
function statusOf(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null && 'status' in err) {
    const status = (err as { status?: unknown }).status;
    if (typeof status === 'number') return status;
  }
  return undefined;
}

/** Detail from the provider, kept short enough for a trace line. */
function detailOf(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** Translate a vendor error into an application error. Nothing else may. */
function mapError(err: unknown): LlmError {
  if (err instanceof LlmError) return err;

  const status = statusOf(err);
  const detail = detailOf(err);

  if (status !== undefined) {
    if (status === 401 || status === 403) {
      return new LlmError('LLM_NOT_CONFIGURED', `The API key was rejected: ${detail}`, err);
    }
    if (status === 429) {
      return new LlmError('LLM_RATE_LIMITED', `Rate limit reached: ${detail}`, err);
    }
    if (status >= 500) {
      return new LlmError('LLM_UNAVAILABLE', `Gemini server error (${status}): ${detail}`, err);
    }
    // 400/404 are usually configuration problems — a retired model, a schema
    // the API rejected. Surface the provider's own wording; it is specific.
    return new LlmError('LLM_UNAVAILABLE', `Gemini rejected the request (${status}): ${detail}`, err);
  }

  const name = err instanceof Error ? err.name : '';
  if (name === 'AbortError' || name === 'TimeoutError') {
    return new LlmError('LLM_UNAVAILABLE', `The Gemini request timed out after ${REQUEST_TIMEOUT_MS}ms.`, err);
  }
  return new LlmError('LLM_UNAVAILABLE', `Could not reach Gemini: ${detail}`, err);
}

/**
 * Isolates the response accessor. If a future SDK version changes where the
 * generated text lives, this function is the only thing that changes.
 */
function rawJsonFrom(interaction: { output_text?: string | undefined }): string {
  const text = interaction.output_text;
  if (typeof text !== 'string' || text.trim() === '') {
    // The model produced no usable text. Never treat this as a partial success.
    throw new LlmError(
      'LLM_TRUNCATED',
      'Gemini returned no text output — the response was empty, blocked, or cut short.',
    );
  }
  return text;
}

/**
 * One schema-constrained call, validated. The retry/validation policy lives in
 * structured.ts; this function only supplies the Gemini-specific transport.
 */
function generateStructured<T>(
  schema: z.ZodType<T>,
  jsonSchema: Record<string, unknown>,
  systemInstruction: string,
  input: string,
): Promise<T> {
  const ai = getClient();

  return parseAndValidate(schema, async (correction) => {
    try {
      const interaction = await ai.interactions.create({
        model: config.geminiModel,
        input: correction === null ? input : `${input}\n\n${correction}`,
        system_instruction: systemInstruction,
        // Gemini 3.x thinks by default. Measured on this exact schema:
        // 64s without this line, 6s with it, and the output stayed
        // schema-valid — the difference between a usable demo and a broken one.
        generation_config: { thinking_level: THINKING_LEVEL },
        response_format: {
          type: 'text',
          mime_type: 'application/json',
          schema: jsonSchema,
        },
      });
      return rawJsonFrom(interaction);
    } catch (err) {
      throw mapError(err);
    }
  });
}

export class GeminiProvider implements LLMProvider {
  readonly name = 'gemini';
  readonly model = config.geminiModel;

  get configured(): boolean {
    return isLlmConfigured();
  }

  interpret(rawText: string): Promise<Interpretation> {
    return generateStructured(
      InterpretationSchema,
      interpretationJsonSchema,
      INTERPRETER_SYSTEM_PROMPT,
      rawText,
    );
  }

  draftCommunication(input: DraftInput): Promise<DraftOutput> {
    const prompt = [
      `Recipient: ${input.recipient_description}`,
      `Subject hint: ${input.subject_hint}`,
      `Tone: ${input.tone}`,
      `Context: ${input.context}`,
      `Key points:\n${input.key_points.map((p) => `- ${p}`).join('\n')}`,
    ].join('\n');

    return generateStructured(DraftSchema, draftJsonSchema, DRAFTER_SYSTEM_PROMPT, prompt);
  }
}
