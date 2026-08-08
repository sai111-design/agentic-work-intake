import test from 'node:test';
import assert from 'node:assert/strict';

import { interpretationJsonSchema } from '../llm/schema-to-json.js';

/** Every key that appears anywhere in the generated schema tree. */
function collectKeys(node: unknown, found = new Set<string>(), insideProperties = false): Set<string> {
  if (Array.isArray(node)) {
    node.forEach((n) => collectKeys(n, found, false));
    return found;
  }
  if (node === null || typeof node !== 'object') return found;

  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    // Keys under `properties` are field names, not schema keywords.
    if (!insideProperties) found.add(key);
    collectKeys(value, found, key === 'properties');
  }
  return found;
}

/**
 * Keywords Gemini's schema subset does not accept. Zod emits several of these
 * on its own — notably minimum/maximum from .int() — so this test is what
 * stops a schema change from silently breaking structured output at runtime.
 */
const FORBIDDEN = [
  '$schema',
  '$id',
  '$ref',
  '$defs',
  'definitions',
  'additionalProperties',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'minItems',
  'maxItems',
  'uniqueItems',
  'default',
  'examples',
  'allOf',
  'oneOf',
  'not',
  'if',
  'then',
  'else',
  'patternProperties',
  'propertyNames',
];

test('the generated schema contains no keyword outside Gemini\'s accepted subset', () => {
  const keys = collectKeys(interpretationJsonSchema);
  const offenders = FORBIDDEN.filter((k) => keys.has(k));
  assert.deepEqual(offenders, [], `forbidden keywords leaked into the schema: ${offenders.join(', ')}`);
});

test('.refine() constraints stay out of the wire schema', () => {
  // task_title/summary use .refine() for non-emptiness. If that ever became
  // .min(1), minLength would appear here and Gemini could reject the schema.
  const json = JSON.stringify(interpretationJsonSchema);
  assert.equal(json.includes('minLength'), false);
});

test('the schema still describes the full interpretation contract', () => {
  const props = (interpretationJsonSchema as { properties: Record<string, unknown> }).properties;
  for (const field of [
    'task_title',
    'summary',
    'action_items',
    'priority',
    'detected_deadline',
    'missing_information',
    'what_can_be_automated',
    'what_requires_human_confirmation',
  ]) {
    assert.ok(field in props, `schema lost required field: ${field}`);
  }
});

test('descriptions survive sanitising — they carry the anti-invention rules', () => {
  const props = (interpretationJsonSchema as { properties: Record<string, { description?: string }> })
    .properties;
  assert.ok((props['detected_deadline']?.description ?? '').length > 0);
});

test('nullable fields survive as anyOf with a null branch', () => {
  const actionProps = (
    interpretationJsonSchema as {
      properties: {
        action_items: { items: { properties: Record<string, { anyOf?: Array<{ type?: string }> }> } };
      };
    }
  ).properties.action_items.items.properties;

  const dueInDays = actionProps['due_in_days'];
  assert.ok(dueInDays?.anyOf, 'due_in_days should be a nullable union');
  assert.ok(
    dueInDays.anyOf.some((b) => b.type === 'null'),
    'nullable union must retain its null branch',
  );
  assert.ok(
    dueInDays.anyOf.some((b) => b.type === 'integer'),
    'nullable union must retain its integer branch',
  );
});
