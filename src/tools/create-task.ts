/**
 * Tool 2 — Create Task / Reminder
 *
 * Persists a task in SQLite. For "set a 7-day reminder", this produces a real
 * persisted row with a computed due date. A real calendar integration is not
 * required — the persisted representation is sufficient.
 *
 * Idempotent per action_id (enforced by UNIQUE constraint on tasks.action_id).
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { nowIso } from '../db/index.js';
import type { ToolResult } from './registry.js';

/**
 * Creates the create_task tool function, closed over the database handle.
 */
export function makeCreateTask(db: DatabaseSync) {
  return async function createTask(input: Record<string, unknown>): Promise<ToolResult> {
    const title = String(input['title'] ?? '').trim();
    const dueInDays = typeof input['due_in_days'] === 'number' ? input['due_in_days'] : null;
    const notes = String(input['notes'] ?? '').trim();
    const requestId = String(input['request_id'] ?? '');
    const actionId = String(input['action_id'] ?? '');

    if (!title) {
      return {
        ok: false,
        summary: 'Cannot create a task without a title.',
        data: { error: 'missing_title' },
      };
    }

    const id = randomUUID();
    const now = nowIso();

    let dueAt: string | null = null;
    if (dueInDays !== null && dueInDays > 0) {
      const due = new Date();
      due.setDate(due.getDate() + dueInDays);
      dueAt = due.toISOString();
    }

    try {
      db.prepare(
        `INSERT INTO tasks (id, request_id, action_id, title, due_at, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'OPEN', ?)`,
      ).run(id, requestId, actionId, title, dueAt, now);

      return {
        ok: true,
        summary: dueAt
          ? `Created task "${title}" due ${dueAt.slice(0, 10)}`
          : `Created task "${title}" (no due date)`,
        data: {
          task_id: id,
          title,
          due_at: dueAt,
          due_in_days: dueInDays,
          notes,
          status: 'OPEN',
          created_at: now,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // UNIQUE constraint on action_id means this is a duplicate
      if (message.includes('UNIQUE constraint failed')) {
        return {
          ok: true,
          summary: `Task for this action already exists (idempotent).`,
          data: { error: 'already_exists', action_id: actionId },
        };
      }
      return {
        ok: false,
        summary: `Failed to create task: ${message}`,
        data: { error: message },
      };
    }
  };
}
