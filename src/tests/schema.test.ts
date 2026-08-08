import test from 'node:test';
import assert from 'node:assert/strict';

import { InterpretationSchema } from '../core/schemas.js';
import { makeAction, makeInterpretation } from './fixtures.js';

/** The eight fields the assignment requires the interpretation to carry. */
const REQUIRED_FIELDS = [
  'task_title',
  'summary',
  'action_items',
  'priority',
  'detected_deadline',
  'missing_information',
  'what_can_be_automated',
  'what_requires_human_confirmation',
] as const;

test('a well-formed interpretation parses and exposes all eight required fields', () => {
  const input = makeInterpretation({
    task_title: 'Partner follow-up',
    summary: 'Summarise the discussion and follow up.',
    priority: 'high',
    detected_deadline: 'within 7 days',
    action_items: [makeAction({ kind: 'communication', recipient: 'the partner' })],
    missing_information: [],
    what_can_be_automated: ['creating the reminder'],
    what_requires_human_confirmation: ['sending the email'],
  });

  const result = InterpretationSchema.safeParse(input);
  assert.ok(result.success, 'expected a valid interpretation to parse');

  for (const field of REQUIRED_FIELDS) {
    assert.ok(field in result.data, `missing required field: ${field}`);
  }
});

// ---------------------------------------------------------------------------
// MALFORMED MODEL OUTPUT — each must be rejected, never coerced
// ---------------------------------------------------------------------------

test('rejects output missing a required field', () => {
  const { summary, ...withoutSummary } = makeInterpretation();
  void summary;
  assert.equal(InterpretationSchema.safeParse(withoutSummary).success, false);
});

test('rejects a field of the wrong type', () => {
  const bad = { ...makeInterpretation(), priority: 7 };
  assert.equal(InterpretationSchema.safeParse(bad).success, false);
});

test('rejects null where an array is required', () => {
  const bad = { ...makeInterpretation(), action_items: null };
  assert.equal(InterpretationSchema.safeParse(bad).success, false);
});

test('rejects free-form prose instead of an object', () => {
  const prose = 'Sure! Here is what I understood about your request: ...';
  assert.equal(InterpretationSchema.safeParse(prose).success, false);
});

test('rejects a priority outside the allowed set', () => {
  const bad = { ...makeInterpretation(), priority: 'catastrophic' };
  assert.equal(InterpretationSchema.safeParse(bad).success, false);
});

test('rejects an action item with an unknown kind', () => {
  const bad = makeInterpretation({
    action_items: [{ ...makeAction(), kind: 'send_email_now' } as never],
  });
  assert.equal(InterpretationSchema.safeParse(bad).success, false);
});

// ---------------------------------------------------------------------------
// RUNTIME-ONLY CONSTRAINTS (.refine — deliberately absent from the JSON Schema)
// ---------------------------------------------------------------------------

test('rejects a blank task_title even though the JSON Schema carries no minLength', () => {
  const bad = makeInterpretation({ task_title: '   ' });
  const result = InterpretationSchema.safeParse(bad);
  assert.equal(result.success, false);
});

test('rejects a blank summary', () => {
  assert.equal(InterpretationSchema.safeParse(makeInterpretation({ summary: '' })).success, false);
});

test('rejects a blank action title', () => {
  const bad = makeInterpretation({ action_items: [makeAction({ title: '  ' })] });
  assert.equal(InterpretationSchema.safeParse(bad).success, false);
});

// ---------------------------------------------------------------------------
// VALID EDGE CASES — must NOT be rejected
// ---------------------------------------------------------------------------

test('accepts nulls for genuinely absent optional facts', () => {
  const input = makeInterpretation({
    detected_deadline: null,
    action_items: [makeAction({ recipient: null, target_url: null, due_in_days: null })],
  });
  assert.ok(InterpretationSchema.safeParse(input).success);
});

test('accepts an empty action list', () => {
  assert.ok(InterpretationSchema.safeParse(makeInterpretation({ action_items: [] })).success);
});
