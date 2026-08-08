import test from 'node:test';
import assert from 'node:assert/strict';

import { hasActionableWork, plan, statusAfterPlanning } from '../core/planner.js';
import { ACTION_KINDS } from '../core/schemas.js';
import { makeAction, makeInterpretation } from './fixtures.js';

const REQ = 'req-test-1';

function planOne(action: ReturnType<typeof makeAction>) {
  const interp = makeInterpretation({ action_items: [action] });
  const [planned] = plan(interp, REQ);
  assert.ok(planned, 'planner must return an action');
  return planned;
}

// ---------------------------------------------------------------------------
// THE CORE GUARANTEE
// ---------------------------------------------------------------------------

test('missing information forces REQUIRES_CLARIFICATION for EVERY kind of action', () => {
  for (const kind of ACTION_KINDS) {
    const planned = planOne(
      makeAction({
        kind,
        missing_information: ['which document is meant'],
        // Everything below argues for automation. None of it may win.
        can_be_automated: true,
        requires_human_confirmation: false,
        recipient: 'the team',
        target_url: 'https://example.com',
        due_in_days: 7,
      }),
    );

    assert.equal(planned.classification, 'REQUIRES_CLARIFICATION', `kind=${kind}`);
    assert.equal(planned.tool, null, `kind=${kind} must not be routed to a tool`);
    assert.equal(planned.toolInput, null, `kind=${kind} must not have tool input built`);
    assert.equal(planned.status, 'NEEDS_CLARIFICATION');
    assert.match(planned.reason, /which document is meant/);
  }
});

test('can_be_automated from the model can never promote an action to automatic execution', () => {
  const planned = planOne(
    makeAction({
      kind: 'communication',
      recipient: 'Dana at Acme',
      can_be_automated: true,
      requires_human_confirmation: false,
    }),
  );
  // draft_communication always needs a human, whatever the model suggested.
  assert.equal(planned.classification, 'PREPARE_FOR_HUMAN_REVIEW');
});

test('requires_human_confirmation can only add caution, never remove it', () => {
  const auto = planOne(makeAction({ kind: 'reminder', requires_human_confirmation: false }));
  assert.equal(auto.classification, 'EXECUTE_AUTOMATICALLY');

  const gated = planOne(makeAction({ kind: 'reminder', requires_human_confirmation: true }));
  assert.equal(gated.classification, 'PREPARE_FOR_HUMAN_REVIEW');
});

// ---------------------------------------------------------------------------
// CLASSIFICATION TABLE
// ---------------------------------------------------------------------------

const CASES = [
  {
    name: 'reminder with all information -> automatic',
    action: makeAction({ kind: 'reminder', due_in_days: 7 }),
    classification: 'EXECUTE_AUTOMATICALLY',
    tool: 'create_task',
  },
  {
    name: 'website review with a valid URL -> automatic',
    action: makeAction({ kind: 'website_review', target_url: 'https://hedamo.com' }),
    classification: 'EXECUTE_AUTOMATICALLY',
    tool: 'website_check',
  },
  {
    name: 'summary -> automatic',
    action: makeAction({ kind: 'summary' }),
    classification: 'EXECUTE_AUTOMATICALLY',
    tool: 'generate_brief',
  },
  {
    name: 'communication with a named recipient -> human review',
    action: makeAction({ kind: 'communication', recipient: 'Dana at Acme' }),
    classification: 'PREPARE_FOR_HUMAN_REVIEW',
    tool: 'draft_communication',
  },
  {
    name: 'communication with no recipient -> clarification',
    action: makeAction({ kind: 'communication', recipient: null }),
    classification: 'REQUIRES_CLARIFICATION',
    tool: 'draft_communication',
  },
  {
    name: 'website review with no URL -> clarification',
    action: makeAction({ kind: 'website_review', target_url: null }),
    classification: 'REQUIRES_CLARIFICATION',
    tool: 'website_check',
  },
  {
    name: 'website review with a non-http URL -> clarification',
    action: makeAction({ kind: 'website_review', target_url: 'file:///etc/passwd' }),
    classification: 'REQUIRES_CLARIFICATION',
    tool: 'website_check',
  },
  {
    name: 'unsupported kind -> cannot execute',
    action: makeAction({ kind: 'other' }),
    classification: 'CANNOT_EXECUTE',
    tool: null,
  },
] as const;

for (const c of CASES) {
  test(`classification: ${c.name}`, () => {
    const planned = planOne(c.action);
    assert.equal(planned.classification, c.classification);
    assert.equal(planned.tool, c.tool);
  });
}

test('every classification carries a non-empty reason', () => {
  for (const c of CASES) {
    const planned = planOne(c.action);
    assert.ok(planned.reason.trim().length > 0, `${c.name} produced an empty reason`);
  }
});

test('a whitespace-only recipient is treated as no recipient', () => {
  const planned = planOne(makeAction({ kind: 'communication', recipient: '   ' }));
  assert.equal(planned.classification, 'REQUIRES_CLARIFICATION');
});

// ---------------------------------------------------------------------------
// TOOL INPUT
// ---------------------------------------------------------------------------

test('tool input is built only for actions that will run', () => {
  const runnable = planOne(makeAction({ kind: 'reminder', due_in_days: 7 }));
  assert.deepEqual(runnable.toolInput, {
    title: 'Do the thing',
    due_in_days: 7,
    notes: 'Context drawn from the request.',
  });

  const blocked = planOne(makeAction({ kind: 'website_review', target_url: null }));
  assert.equal(blocked.toolInput, null);
});

test('draft input carries the recipient verbatim and never fabricates one', () => {
  const planned = planOne(makeAction({ kind: 'communication', recipient: 'Dana at Acme' }));
  assert.equal(planned.toolInput?.['recipient_description'], 'Dana at Acme');
});

// ---------------------------------------------------------------------------
// PLAN-LEVEL BEHAVIOUR
// ---------------------------------------------------------------------------

test('generate_brief is ordered last so it can render earlier tool output', () => {
  const interp = makeInterpretation({
    action_items: [
      makeAction({ title: 'Write the brief', kind: 'summary' }),
      makeAction({ title: 'Check the site', kind: 'website_review', target_url: 'https://hedamo.com' }),
      makeAction({ title: 'Set a reminder', kind: 'reminder', due_in_days: 7 }),
    ],
  });

  const actions = plan(interp, REQ);
  assert.equal(actions.at(-1)?.tool, 'generate_brief');
  assert.deepEqual(
    actions.map((a) => a.seq),
    [0, 1, 2],
    'seq must be renumbered after reordering',
  );
});

test('statusAfterPlanning reflects whether anything can proceed', () => {
  const actionable = plan(
    makeInterpretation({ action_items: [makeAction({ kind: 'reminder' })] }),
    REQ,
  );
  assert.equal(statusAfterPlanning(actionable), 'PLAN_READY');
  assert.equal(hasActionableWork(actionable), true);

  const blocked = plan(
    makeInterpretation({
      action_items: [makeAction({ kind: 'reminder', missing_information: ['when'] })],
    }),
    REQ,
  );
  assert.equal(statusAfterPlanning(blocked), 'NEEDS_CLARIFICATION');
  assert.equal(hasActionableWork(blocked), false);

  const impossible = plan(
    makeInterpretation({ action_items: [makeAction({ kind: 'other' })] }),
    REQ,
  );
  assert.equal(statusAfterPlanning(impossible), 'COMPLETED');
});

test('an empty action list yields an empty plan and no actionable work', () => {
  const actions = plan(makeInterpretation({ action_items: [] }), REQ);
  assert.deepEqual(actions, []);
  assert.equal(hasActionableWork(actions), false);
});
