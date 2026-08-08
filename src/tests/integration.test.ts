/**
 * Integration tests: orchestrator + API + persistence.
 *
 * End-to-end through the full pipeline using FakeProvider and in-memory SQLite.
 * No network, no API key — these run as part of `npm test`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../db/index.js';
import { FakeProvider } from './fakes/provider.js';
import { makeAction, makeInterpretation } from './fixtures.js';
import {
  submitRequest,
  approveAction,
  rejectAction,
  editAction,
  getRequest,
  getRequestActions,
  getRequestEvents,
  getRequestTasks,
} from '../orchestrator.js';
import { initTools } from '../tools/init.js';
import type { DatabaseSync } from 'node:sqlite';
import type { LLMProvider } from '../llm/provider.js';
import { assertActionTransition } from '../core/transitions.js';
import { TransitionError } from '../core/types.js';

function setup(providerOpts?: ConstructorParameters<typeof FakeProvider>[0]) {
  const db = openDb(':memory:');
  const provider = new FakeProvider(providerOpts);
  // Register tools fresh for each test (registry is global, so clear it)
  try {
    initTools(provider, db);
  } catch {
    // Tools already registered from a previous test — that's fine for this test file.
    // In a production codebase we'd have a proper teardown, but for a prototype the
    // global registry is acceptable.
  }
  return { db, provider, deps: { db, provider } };
}

// ---------------------------------------------------------------------------
// FULL PIPELINE: intake → interpretation → planning → execution → completion
// ---------------------------------------------------------------------------

test('full pipeline: reminder action is automatically executed', async () => {
  const { db, deps } = setup({
    interpretation: makeInterpretation({
      task_title: 'Partner follow-up',
      summary: 'Follow up on the partner discussion.',
      action_items: [
        makeAction({ kind: 'reminder', title: 'Set 7-day reminder', due_in_days: 7 }),
      ],
    }),
  });

  const requestId = await submitRequest(deps, 'Set a 7-day reminder for the follow-up');

  const request = getRequest(db, requestId);
  assert.ok(request);
  // Reminder is auto-executable, so it should complete
  assert.equal(request.status, 'COMPLETED', `Expected COMPLETED, got ${request.status}`);

  const actions = getRequestActions(db, requestId);
  assert.equal(actions.length, 1);
  assert.equal(actions[0]!.status, 'COMPLETED');
  assert.equal(actions[0]!.tool, 'create_task');

  // Verify task was persisted
  const tasks = getRequestTasks(db, requestId);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]!.title, 'Set 7-day reminder');
  assert.ok(tasks[0]!.due_at, 'Task should have a due date');

  // Verify activity trace
  const events = getRequestEvents(db, requestId);
  assert.ok(events.length >= 5, `Expected at least 5 events, got ${events.length}`);
  const types = events.map((e) => e.type);
  assert.ok(types.includes('REQUEST_RECEIVED'));
  assert.ok(types.includes('INTERPRETATION_STARTED'));
  assert.ok(types.includes('INTERPRETATION_COMPLETED'));
  assert.ok(types.includes('REQUEST_COMPLETED'));

  db.close();
});

// ---------------------------------------------------------------------------
// APPROVAL WORKFLOW
// ---------------------------------------------------------------------------

test('communication draft requires approval before execution', async () => {
  const { db, deps } = setup({
    interpretation: makeInterpretation({
      task_title: 'Thank-you email',
      summary: 'Draft a thank-you email to the partner.',
      action_items: [
        makeAction({
          kind: 'communication',
          title: 'Draft thank-you email',
          recipient: 'the partner',
        }),
      ],
    }),
  });

  const requestId = await submitRequest(deps, 'Draft a thank-you email to the partner');

  const actions = getRequestActions(db, requestId);
  assert.equal(actions.length, 1);
  assert.equal(actions[0]!.status, 'PENDING_APPROVAL');
  assert.equal(actions[0]!.classification, 'PREPARE_FOR_HUMAN_REVIEW');

  // Request should be in PLAN_READY (waiting for approval)
  const request = getRequest(db, requestId);
  assert.ok(request);
  assert.equal(request.status, 'PLAN_READY');

  // Approve and execute
  await approveAction(deps, actions[0]!.id);

  const updatedActions = getRequestActions(db, requestId);
  assert.equal(updatedActions[0]!.status, 'COMPLETED');

  const output = JSON.parse(updatedActions[0]!.output!);
  assert.ok(output['subject']);
  assert.ok(output['body']);
  assert.equal(output['sent'], false);
  assert.equal(output['recipients_resolved'], false);

  db.close();
});

test('rejected action stays rejected and cannot be executed', async () => {
  const { db, deps } = setup({
    interpretation: makeInterpretation({
      action_items: [
        makeAction({
          kind: 'communication',
          title: 'Draft message',
          recipient: 'someone',
        }),
      ],
    }),
  });

  const requestId = await submitRequest(deps, 'Draft a message');
  const actions = getRequestActions(db, requestId);

  rejectAction(deps, actions[0]!.id);

  const updated = getRequestActions(db, requestId);
  assert.equal(updated[0]!.status, 'REJECTED');

  // Verify events include rejection
  const events = getRequestEvents(db, requestId);
  assert.ok(events.some((e) => e.type === 'ACTION_REJECTED'));

  db.close();
});

test('edit returns action to PENDING_APPROVAL with new input', async () => {
  const { db, deps } = setup({
    interpretation: makeInterpretation({
      action_items: [
        makeAction({
          kind: 'communication',
          title: 'Draft email',
          recipient: 'client',
        }),
      ],
    }),
  });

  const requestId = await submitRequest(deps, 'Draft an email');
  const actions = getRequestActions(db, requestId);

  editAction(deps, actions[0]!.id, {
    recipient_description: 'updated client name',
    subject_hint: 'Updated subject',
    key_points: ['updated point'],
    context: 'updated context',
    tone: 'friendly',
  });

  const updated = getRequestActions(db, requestId);
  assert.equal(updated[0]!.status, 'PENDING_APPROVAL');
  const newInput = JSON.parse(updated[0]!.tool_input!);
  assert.equal(newInput['recipient_description'], 'updated client name');

  // Verify events include edit
  const events = getRequestEvents(db, requestId);
  assert.ok(events.some((e) => e.type === 'ACTION_EDITED'));

  db.close();
});

// ---------------------------------------------------------------------------
// APPROVAL CANNOT BE BYPASSED (security-critical test)
// ---------------------------------------------------------------------------

test('PENDING_APPROVAL → EXECUTING is illegal (approval cannot be bypassed)', () => {
  assert.throws(
    () => assertActionTransition('PENDING_APPROVAL', 'EXECUTING'),
    TransitionError,
  );
});

// ---------------------------------------------------------------------------
// CLARIFICATION SCENARIO (Scenario 3)
// ---------------------------------------------------------------------------

test('missing information forces NEEDS_CLARIFICATION — no execution', async () => {
  const { db, deps } = setup({
    interpretation: makeInterpretation({
      task_title: 'Vague documentation request',
      summary: 'Send documentation to everyone before the meeting.',
      missing_information: [
        'which documentation',
        'who is "everyone"',
        'which meeting',
      ],
      action_items: [
        makeAction({
          kind: 'communication',
          title: 'Send documentation',
          recipient: null,
          missing_information: [
            'which documentation is meant',
            'who is "everyone" — no specific recipients identified',
            'which meeting is referred to',
          ],
        }),
      ],
    }),
  });

  const requestId = await submitRequest(deps, 'Please take care of the documentation and send it to everyone before the meeting.');

  const request = getRequest(db, requestId);
  assert.ok(request);
  assert.equal(request.status, 'NEEDS_CLARIFICATION');

  const actions = getRequestActions(db, requestId);
  assert.equal(actions.length, 1);
  assert.equal(actions[0]!.classification, 'REQUIRES_CLARIFICATION');
  assert.equal(actions[0]!.status, 'NEEDS_CLARIFICATION');
  assert.equal(actions[0]!.tool, null);

  // No tasks should be created
  const tasks = getRequestTasks(db, requestId);
  assert.equal(tasks.length, 0);

  db.close();
});

// ---------------------------------------------------------------------------
// LLM FAILURE PATH
// ---------------------------------------------------------------------------

test('LLM failure results in FAILED status and traceable event', async () => {
  const { db, deps } = setup({ failInterpretWith: 'LLM_NOT_CONFIGURED' });

  const requestId = await submitRequest(deps, 'This will fail');

  const request = getRequest(db, requestId);
  assert.ok(request);
  assert.equal(request.status, 'FAILED');
  assert.ok(request.error);

  const events = getRequestEvents(db, requestId);
  assert.ok(events.some((e) => e.type === 'REQUEST_FAILED'));

  db.close();
});

test('LLM unavailable results in FAILED status', async () => {
  const { db, deps } = setup({ failInterpretWith: 'LLM_UNAVAILABLE' });

  const requestId = await submitRequest(deps, 'This will also fail');

  const request = getRequest(db, requestId);
  assert.ok(request);
  assert.equal(request.status, 'FAILED');

  db.close();
});

// ---------------------------------------------------------------------------
// PERSISTENCE: events are reconstructable
// ---------------------------------------------------------------------------

test('activity trace records every meaningful state transition', async () => {
  const { db, deps } = setup({
    interpretation: makeInterpretation({
      action_items: [
        makeAction({ kind: 'reminder', title: 'Auto reminder' }),
        makeAction({
          kind: 'communication',
          title: 'Draft message',
          recipient: 'the boss',
        }),
      ],
    }),
  });

  const requestId = await submitRequest(deps, 'Reminder + email');
  const events = getRequestEvents(db, requestId);

  // Should have events for: received, interpreting, interpreted, planning,
  // plan generated (×2), approval requested, executing, tool executed,
  // action completed, ...
  assert.ok(events.length >= 8, `Expected at least 8 events, got ${events.length}`);

  // Each event has a timestamp
  for (const e of events) {
    assert.ok(e.created_at, 'Event must have a timestamp');
    assert.ok(e.type, 'Event must have a type');
    assert.ok(e.message, 'Event must have a message');
  }

  db.close();
});

// ---------------------------------------------------------------------------
// API TESTS
// ---------------------------------------------------------------------------

test('GET /api/requests/:id returns 404 for unknown ID', async () => {
  const { db } = setup();
  const { createApp } = await import('../api.js');
  const app = createApp(new FakeProvider(), db);

  // Use Node's built-in test server
  const { request } = await import('node:http');
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;

  try {
    const body = await new Promise<string>((resolve, reject) => {
      const req = request(`http://localhost:${port}/api/requests/nonexistent`, (res) => {
        assert.equal(res.statusCode, 404);
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.end();
    });
    const parsed = JSON.parse(body);
    assert.ok(parsed['error']);
  } finally {
    server.close();
    db.close();
  }
});

test('POST /api/requests with empty text returns 400', async () => {
  const { db } = setup();
  const { createApp } = await import('../api.js');
  const app = createApp(new FakeProvider(), db);

  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;

  try {
    const body = await new Promise<string>((resolve, reject) => {
      const req = request(`http://localhost:${port}/api/requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }, (res) => {
        assert.equal(res.statusCode, 400);
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.write(JSON.stringify({ text: '' }));
      req.end();
    });
    const parsed = JSON.parse(body);
    assert.ok(parsed['error']);
  } finally {
    server.close();
    db.close();
  }
});

// Need to import 'request' at the top level for the tests using it
import { request } from 'node:http';
