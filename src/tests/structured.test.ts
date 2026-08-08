import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import { LlmError } from '../llm/provider.js';
import { parseAndValidate } from '../llm/structured.js';

const Schema = z.object({ name: z.string(), count: z.number() });
const VALID = JSON.stringify({ name: 'ok', count: 1 });

/** Returns each scripted reply in turn, recording the corrections it was sent. */
function scriptedModel(replies: string[]) {
  const corrections: Array<string | null> = [];
  const call = async (correction: string | null): Promise<string> => {
    corrections.push(correction);
    const next = replies[corrections.length - 1];
    if (next === undefined) throw new Error('model called more times than scripted');
    return next;
  };
  return { call, corrections };
}

test('valid output on the first attempt is returned without a retry', async () => {
  const { call, corrections } = scriptedModel([VALID]);
  const result = await parseAndValidate(Schema, call);

  assert.deepEqual(result, { name: 'ok', count: 1 });
  assert.equal(corrections.length, 1, 'should call the model exactly once');
  assert.equal(corrections[0], null, 'first attempt carries no correction');
});

test('non-JSON prose is retried once with corrective feedback, then succeeds', async () => {
  const prose = 'Sure! Here is the information you asked for.';
  const { call, corrections } = scriptedModel([prose, VALID]);

  const result = await parseAndValidate(Schema, call);

  assert.deepEqual(result, { name: 'ok', count: 1 });
  assert.equal(corrections.length, 2);
  assert.ok(corrections[1], 'second attempt must carry a correction');
  assert.match(corrections[1], /not valid JSON/i);
});

test('schema-mismatched JSON is retried once with the specific problems', async () => {
  const wrongTypes = JSON.stringify({ name: 'ok', count: 'not-a-number' });
  const { call, corrections } = scriptedModel([wrongTypes, VALID]);

  await parseAndValidate(Schema, call);

  assert.ok(corrections[1], 'expected a correction on the retry');
  assert.match(corrections[1], /count/, 'correction should name the offending field');
});

test('prose twice fails loudly as VALIDATION_FAILED — never coerced', async () => {
  const { call, corrections } = scriptedModel(['not json', 'still not json']);

  await assert.rejects(
    () => parseAndValidate(Schema, call),
    (err: unknown) => {
      assert.ok(err instanceof LlmError);
      assert.equal(err.code, 'VALIDATION_FAILED');
      return true;
    },
  );
  assert.equal(corrections.length, 2, 'retries must be bounded at exactly one');
});

test('persistently invalid data fails rather than returning partial results', async () => {
  const bad = JSON.stringify({ name: 'ok' }); // count missing
  const { call } = scriptedModel([bad, bad]);

  await assert.rejects(
    () => parseAndValidate(Schema, call),
    (err: unknown) => err instanceof LlmError && err.code === 'VALIDATION_FAILED',
  );
});

test('an empty JSON object is rejected, not treated as an empty success', async () => {
  const { call } = scriptedModel(['{}', '{}']);
  await assert.rejects(
    () => parseAndValidate(Schema, call),
    (err: unknown) => err instanceof LlmError && err.code === 'VALIDATION_FAILED',
  );
});

test('transport errors propagate unchanged and are NOT retried here', async () => {
  let calls = 0;
  const call = async (): Promise<string> => {
    calls++;
    throw new LlmError('LLM_RATE_LIMITED', 'rate limited');
  };

  await assert.rejects(
    () => parseAndValidate(Schema, call),
    (err: unknown) => {
      assert.ok(err instanceof LlmError);
      // Must stay LLM_RATE_LIMITED — not relabelled as a validation problem.
      assert.equal(err.code, 'LLM_RATE_LIMITED');
      return true;
    },
  );
  // The SDK already retries transport failures; retrying here would stack.
  assert.equal(calls, 1, 'transport failures must not be retried in this layer');
});

test('a JSON array where an object is required is rejected', async () => {
  const { call } = scriptedModel(['[]', '[]']);
  await assert.rejects(
    () => parseAndValidate(Schema, call),
    (err: unknown) => err instanceof LlmError && err.code === 'VALIDATION_FAILED',
  );
});
