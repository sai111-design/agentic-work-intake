/**
 * The ONLY test that touches the real Gemini API.
 *
 * Run with `npm run test:live` (requires GEMINI_API_KEY). It is deliberately
 * kept out of dist/tests/ so `npm test` physically cannot reach the network —
 * a Google outage or an exhausted quota must never turn the default suite red.
 *
 * It doubles as the live half of the SDK verification spike: it prints the
 * observed response shape so docs/sdk-spike.md can be checked against reality.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { isLlmConfigured } from '../config.js';
import { InterpretationSchema } from '../core/schemas.js';
import { GeminiProvider } from '../llm/gemini.js';
import { interpretationJsonSchema } from '../llm/schema-to-json.js';

const SCENARIO_1 =
  'Summarize a partner discussion, extract follow-ups, draft a thank-you email, and set a 7-day reminder.';

const configured = isLlmConfigured();

test(
  'live: Gemini returns a schema-valid interpretation for the routine-work scenario',
  { skip: configured ? false : 'GEMINI_API_KEY is not set — skipping the live call' },
  async () => {
    const provider = new GeminiProvider();
    assert.equal(provider.name, 'gemini');

    const interpretation = await provider.interpret(SCENARIO_1);

    // The provider validates internally; re-validating here proves the object
    // that crossed the port really does satisfy the contract.
    const result = InterpretationSchema.safeParse(interpretation);
    assert.ok(result.success, 'interpretation returned by the provider must be schema-valid');

    assert.ok(interpretation.task_title.trim().length > 0);
    assert.ok(interpretation.summary.trim().length > 0);
    assert.ok(interpretation.action_items.length > 0, 'expected at least one action item');

    console.log('\n--- SPIKE EVIDENCE: model =', provider.model, '---');
    console.log('schema bytes sent:', JSON.stringify(interpretationJsonSchema).length);
    console.log('task_title:', interpretation.task_title);
    console.log('priority:', interpretation.priority);
    console.log('detected_deadline:', interpretation.detected_deadline);
    console.log(
      'action kinds:',
      interpretation.action_items.map((a) => a.kind).join(', '),
    );
    console.log('missing_information:', JSON.stringify(interpretation.missing_information));
  },
);

test(
  'live: the ambiguous request yields missing information rather than invented detail',
  { skip: configured ? false : 'GEMINI_API_KEY is not set — skipping the live call' },
  async () => {
    const provider = new GeminiProvider();
    const interpretation = await provider.interpret(
      'Please take care of the documentation and send it to everyone before the meeting.',
    );

    const allMissing = [
      ...interpretation.missing_information,
      ...interpretation.action_items.flatMap((a) => a.missing_information),
    ];

    assert.ok(
      allMissing.length > 0,
      'the model must report missing information for a request this under-specified',
    );

    // No communication action may claim a concrete recipient here — "everyone"
    // is not a recipient, and inventing one is the failure this project exists
    // to prevent.
    for (const action of interpretation.action_items) {
      if (action.kind !== 'communication') continue;
      const recipient = (action.recipient ?? '').toLowerCase();
      assert.ok(
        recipient === '' || recipient.includes('everyone'),
        `model invented a recipient: ${action.recipient}`,
      );
    }

    console.log('\n--- SPIKE EVIDENCE: ambiguous request ---');
    console.log('missing_information:', JSON.stringify(allMissing, null, 2));
  },
);
