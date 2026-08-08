/**
 * The port between the application and whichever LLM is behind it.
 *
 * Nothing outside src/llm/ imports a vendor SDK. The orchestrator, planner,
 * router, and every tool depend only on this file, which is what lets the
 * whole test suite run offline against a fake and what made swapping
 * providers a two-file change rather than a redesign.
 */

import { z } from 'zod';
import type { Interpretation } from '../core/schemas.js';

/**
 * Application-level failure codes. Vendor errors are translated into these at
 * the adapter boundary, so no caller ever sees a Google (or any other) type.
 */
export type LlmErrorCode =
  | 'LLM_NOT_CONFIGURED'
  | 'LLM_UNAVAILABLE'
  | 'LLM_RATE_LIMITED'
  | 'LLM_REFUSED'
  | 'LLM_TRUNCATED'
  | 'VALIDATION_FAILED';

export class LlmError extends Error {
  constructor(
    readonly code: LlmErrorCode,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

/** Human-readable text for the activity trace. No vendor jargon. */
export const LLM_ERROR_MESSAGES: Record<LlmErrorCode, string> = {
  LLM_NOT_CONFIGURED: 'No language-model API key is configured, so the request cannot be interpreted.',
  LLM_UNAVAILABLE: 'The language model could not be reached.',
  LLM_RATE_LIMITED: 'The language model rejected the request because of rate limits.',
  LLM_REFUSED: 'The language model declined to answer this request.',
  LLM_TRUNCATED: 'The language model response was cut off before it was complete.',
  VALIDATION_FAILED: 'The language model returned data that did not match the required schema.',
};

export interface DraftInput {
  recipient_description: string;
  subject_hint: string;
  key_points: string[];
  context: string;
  tone: 'formal' | 'friendly';
}

/** Schema-constrained shape of a generated draft. */
export const DraftSchema = z.object({
  subject: z.string().describe('A concise subject line for the message.'),
  body: z.string().describe('The full message body, ready for a human to review and edit.'),
});

export type DraftOutput = z.infer<typeof DraftSchema>;

export interface LLMProvider {
  /** Provider identifier for /api/health, e.g. 'gemini'. */
  readonly name: string;
  /** Model identifier for /api/health, e.g. 'gemini-2.5-flash'. */
  readonly model: string;
  /** Whether credentials are present. Never exposes the credential itself. */
  readonly configured: boolean;

  /**
   * Turn unstructured text into a validated Interpretation.
   * Returns only schema-valid data, or throws LlmError. Validation happens
   * inside the adapter so no caller can forget it.
   */
  interpret(rawText: string): Promise<Interpretation>;

  /** Generate a message draft. Never sends anything. */
  draftCommunication(input: DraftInput): Promise<DraftOutput>;
}
