/**
 * Tool tests.
 *
 * Each tool is tested with valid inputs, invalid inputs, and failure cases.
 * Uses FakeProvider and in-memory SQLite — no network, no API key.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../db/index.js';
import { FakeProvider } from './fakes/provider.js';
import { makeDraftCommunication } from '../tools/draft-communication.js';
import { makeCreateTask } from '../tools/create-task.js';
import { makeGenerateBrief } from '../tools/generate-brief.js';
import { getTool, isKnownTool, registerTool, registeredToolNames } from '../tools/registry.js';
import type { ToolResult } from '../tools/registry.js';

// ---------------------------------------------------------------------------
// REGISTRY
// ---------------------------------------------------------------------------

test('isKnownTool rejects invented tool names', () => {
  assert.equal(isKnownTool('run_arbitrary_code'), false);
  assert.equal(isKnownTool('hack_nasa'), false);
  assert.equal(isKnownTool(''), false);
});

// ---------------------------------------------------------------------------
// DRAFT COMMUNICATION
// ---------------------------------------------------------------------------

test('draft communication produces subject and body', async () => {
  const provider = new FakeProvider({
    draft: { subject: 'Thank you', body: 'Dear partner, thank you for the meeting.' },
  });
  const tool = makeDraftCommunication(provider);

  const result = await tool({
    recipient_description: 'the partner',
    subject_hint: 'Follow-up',
    key_points: ['Thank you for the discussion'],
    context: 'Partner meeting follow-up',
    tone: 'formal',
  });

  assert.equal(result.ok, true);
  assert.equal(result.data['subject'], 'Thank you');
  assert.equal(result.data['body'], 'Dear partner, thank you for the meeting.');
  assert.equal(result.data['recipients_resolved'], false);
  assert.equal(result.data['sent'], false);
});

test('draft communication fails without a recipient', async () => {
  const provider = new FakeProvider();
  const tool = makeDraftCommunication(provider);

  const result = await tool({ recipient_description: '' });
  assert.equal(result.ok, false);
  assert.match(result.summary, /recipient/i);
});

test('draft communication handles LLM failure gracefully', async () => {
  const provider = new FakeProvider({ failDraftWith: 'LLM_UNAVAILABLE' });
  const tool = makeDraftCommunication(provider);

  const result = await tool({
    recipient_description: 'the client',
    subject_hint: 'Test',
    key_points: ['point 1'],
    context: 'test',
    tone: 'formal',
  });

  assert.equal(result.ok, false);
  assert.match(result.summary, /[Ff]ail/);
});

// ---------------------------------------------------------------------------
// CREATE TASK
// ---------------------------------------------------------------------------

test('create task persists a row in SQLite', async () => {
  const db = openDb(':memory:');
  const tool = makeCreateTask(db);

  // Insert a dummy request + action so FK constraints are satisfied
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO requests (id, raw_text, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
  ).run('req-1', 'test', 'RECEIVED', now, now);
  db.prepare(
    `INSERT INTO actions (id, request_id, seq, title, classification, reason, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('act-1', 'req-1', 0, 'Test action', 'EXECUTE_AUTOMATICALLY', 'test', 'PENDING', now, now);

  const result = await tool({
    title: 'Set 7-day reminder',
    due_in_days: 7,
    notes: 'Follow up on the partner discussion',
    request_id: 'req-1',
    action_id: 'act-1',
  });

  assert.equal(result.ok, true);
  assert.equal(result.data['title'], 'Set 7-day reminder');
  assert.equal(result.data['due_in_days'], 7);
  assert.ok(result.data['due_at'], 'should compute a due date');
  assert.equal(result.data['status'], 'OPEN');

  // Verify persistence
  const row = db.prepare(`SELECT * FROM tasks WHERE request_id = ?`).get('req-1') as Record<string, unknown>;
  assert.ok(row);
  assert.equal(row['title'], 'Set 7-day reminder');

  db.close();
});

test('create task without a title fails', async () => {
  const db = openDb(':memory:');
  const tool = makeCreateTask(db);

  const result = await tool({ title: '', request_id: 'req-1', action_id: 'act-1' });
  assert.equal(result.ok, false);
  assert.match(result.summary, /title/i);

  db.close();
});

test('create task is idempotent for the same action_id', async () => {
  const db = openDb(':memory:');
  const tool = makeCreateTask(db);

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO requests (id, raw_text, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
  ).run('req-2', 'test', 'RECEIVED', now, now);
  db.prepare(
    `INSERT INTO actions (id, request_id, seq, title, classification, reason, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('act-2', 'req-2', 0, 'Test', 'EXECUTE_AUTOMATICALLY', 'test', 'PENDING', now, now);

  const first = await tool({
    title: 'Reminder',
    request_id: 'req-2',
    action_id: 'act-2',
  });
  assert.equal(first.ok, true);

  const second = await tool({
    title: 'Reminder',
    request_id: 'req-2',
    action_id: 'act-2',
  });
  assert.equal(second.ok, true); // idempotent success
  assert.match(second.summary, /already exists/i);

  db.close();
});

test('create task with no due_in_days produces null due_at', async () => {
  const db = openDb(':memory:');
  const tool = makeCreateTask(db);

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO requests (id, raw_text, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
  ).run('req-3', 'test', 'RECEIVED', now, now);
  db.prepare(
    `INSERT INTO actions (id, request_id, seq, title, classification, reason, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('act-3', 'req-3', 0, 'Test', 'EXECUTE_AUTOMATICALLY', 'test', 'PENDING', now, now);

  const result = await tool({
    title: 'No deadline task',
    request_id: 'req-3',
    action_id: 'act-3',
  });

  assert.equal(result.ok, true);
  assert.equal(result.data['due_at'], null);

  db.close();
});

// ---------------------------------------------------------------------------
// GENERATE BRIEF
// ---------------------------------------------------------------------------

test('generate brief produces markdown from database data', async () => {
  const db = openDb(':memory:');
  const tool = makeGenerateBrief(db);

  const now = new Date().toISOString();
  const interp = JSON.stringify({
    task_title: 'Partner Follow-up',
    summary: 'Summarise and follow up on the partner discussion.',
    priority: 'high',
    detected_deadline: 'within 7 days',
    missing_information: [],
  });

  db.prepare(
    `INSERT INTO requests (id, raw_text, status, interpretation, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('req-brief', 'test input', 'COMPLETED', interp, now, now);

  db.prepare(
    `INSERT INTO actions (id, request_id, seq, title, classification, reason, tool, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('act-brief', 'req-brief', 0, 'Draft email', 'PREPARE_FOR_HUMAN_REVIEW', 'Needs review', 'draft_communication', 'COMPLETED', now, now);

  const result = await tool({ request_id: 'req-brief' });

  assert.equal(result.ok, true);
  const md = String(result.data['markdown']);
  assert.match(md, /Partner Follow-up/);
  assert.match(md, /Priority.*high/);
  assert.match(md, /Draft email/);

  db.close();
});

test('generate brief returns error for unknown request', async () => {
  const db = openDb(':memory:');
  const tool = makeGenerateBrief(db);

  const result = await tool({ request_id: 'nonexistent' });
  assert.equal(result.ok, false);
  assert.match(result.summary, /not found/i);

  db.close();
});

test('generate brief returns error without request_id', async () => {
  const db = openDb(':memory:');
  const tool = makeGenerateBrief(db);

  const result = await tool({});
  assert.equal(result.ok, false);

  db.close();
});
