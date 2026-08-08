/**
 * Parse-and-validate loop for schema-constrained model output.
 *
 * Deliberately free of any vendor SDK: it takes a function that returns raw
 * text and knows nothing about how that text was obtained. That keeps the most
 * reliability-critical logic in the system directly unit-testable without a
 * network call or an API key.
 *
 * The contract: return validated data, or throw. There is no path that returns
 * partially-valid or best-effort data, because silently accepting malformed
 * model output is the specific failure this project is meant to avoid.
 */

import type { z } from 'zod';
import { LlmError } from './provider.js';

/**
 * Invokes the model. `correction` is null on the first attempt and carries
 * feedback about what was wrong on the second.
 */
export type ModelCall = (correction: string | null) => Promise<string>;

/** Attempts including the original. Exactly one retry, and only for validation. */
const MAX_VALIDATION_ATTEMPTS = 2;

const NOT_JSON_CORRECTION =
  'Your previous reply was not valid JSON. Reply with a single JSON object matching the required schema, and nothing else.';

function describeIssues(error: z.ZodError, limit: number): string {
  return error.issues
    .slice(0, limit)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}

export async function parseAndValidate<T>(schema: z.ZodType<T>, call: ModelCall): Promise<T> {
  let correction: string | null = null;

  for (let attempt = 0; attempt < MAX_VALIDATION_ATTEMPTS; attempt++) {
    const isLastAttempt = attempt === MAX_VALIDATION_ATTEMPTS - 1;

    // Transport failures propagate untouched — the caller has already mapped
    // them to an LlmError, and retrying them here would stack on the SDK's
    // own retry policy.
    const rawText = await call(correction);

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      if (isLastAttempt) {
        throw new LlmError(
          'VALIDATION_FAILED',
          'The model returned text that was not valid JSON, twice.',
        );
      }
      correction = NOT_JSON_CORRECTION;
      continue;
    }

    const result = schema.safeParse(parsed);
    if (result.success) return result.data;

    if (isLastAttempt) {
      throw new LlmError(
        'VALIDATION_FAILED',
        `The model returned data that did not match the required schema, twice: ${describeIssues(result.error, 3)}`,
      );
    }

    correction = `Your previous reply did not match the required schema. Fix these problems and reply again with only the JSON object: ${describeIssues(result.error, 6)}`;
  }

  // Unreachable: the loop either returns or throws on the last attempt.
  throw new LlmError('VALIDATION_FAILED', 'Exhausted validation attempts.');
}
