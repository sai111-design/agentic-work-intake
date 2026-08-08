/**
 * Orchestrator. Drives a request through the state machine:
 *
 *   RECEIVED → INTERPRETING → INTERPRETED → PLANNING → PLAN_READY
 *     → EXECUTING → COMPLETED
 *
 * Alternative paths: NEEDS_CLARIFICATION, FAILED
 *
 * Every state change goes through assertRequestTransition / assertActionTransition
 * (from transitions.ts), so illegal moves throw rather than silently corrupt.
 *
 * The orchestrator owns the "what happens next" logic. It does NOT own business
 * rules about which tool runs (the planner does that) or how the LLM is called
 * (the provider does that).
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { plan, statusAfterPlanning } from './core/planner.js';
import { InterpretationSchema, type Interpretation } from './core/schemas.js';
import {
  assertActionTransition,
  assertRequestTransition,
  isTerminalActionStatus,
} from './core/transitions.js';
import type { ActionStatus, EventType, PlannedAction, RequestStatus, ToolName } from './core/types.js';
import { nowIso } from './db/index.js';
import type { LLMProvider } from './llm/provider.js';
import { getTool, isKnownTool } from './tools/registry.js';

// ---------------------------------------------------------------------------
// DB helpers (prepared-statement style, parameterised, no string concat)
// ---------------------------------------------------------------------------

interface RequestRow {
  id: string;
  raw_text: string;
  status: RequestStatus;
  interpretation: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

interface ActionRow {
  id: string;
  request_id: string;
  seq: number;
  title: string;
  classification: string;
  reason: string;
  tool: string | null;
  tool_input: string | null;
  status: ActionStatus;
  output: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  id: number;
  request_id: string;
  action_id: string | null;
  type: string;
  message: string;
  data: string | null;
  created_at: string;
}

interface TaskRow {
  id: string;
  request_id: string;
  action_id: string;
  title: string;
  due_at: string | null;
  status: string;
  created_at: string;
}

function updateRequestStatus(db: DatabaseSync, id: string, from: RequestStatus, to: RequestStatus, extra?: { interpretation?: string; error?: string }): void {
  assertRequestTransition(from, to);
  const now = nowIso();
  if (extra?.interpretation !== undefined) {
    db.prepare(`UPDATE requests SET status = ?, interpretation = ?, updated_at = ? WHERE id = ?`).run(to, extra.interpretation, now, id);
  } else if (extra?.error !== undefined) {
    db.prepare(`UPDATE requests SET status = ?, error = ?, updated_at = ? WHERE id = ?`).run(to, extra.error, now, id);
  } else {
    db.prepare(`UPDATE requests SET status = ?, updated_at = ? WHERE id = ?`).run(to, now, id);
  }
}

function updateActionStatus(db: DatabaseSync, id: string, from: ActionStatus, to: ActionStatus, extra?: { output?: string; error?: string; tool_input?: string }): void {
  assertActionTransition(from, to);
  const now = nowIso();
  if (extra?.output !== undefined) {
    db.prepare(`UPDATE actions SET status = ?, output = ?, updated_at = ? WHERE id = ?`).run(to, extra.output, now, id);
  } else if (extra?.error !== undefined) {
    db.prepare(`UPDATE actions SET status = ?, error = ?, updated_at = ? WHERE id = ?`).run(to, extra.error, now, id);
  } else if (extra?.tool_input !== undefined) {
    db.prepare(`UPDATE actions SET status = ?, tool_input = ?, updated_at = ? WHERE id = ?`).run(to, extra.tool_input, now, id);
  } else {
    db.prepare(`UPDATE actions SET status = ?, updated_at = ? WHERE id = ?`).run(to, now, id);
  }
}

function addEvent(db: DatabaseSync, requestId: string, type: EventType, message: string, actionId?: string, data?: Record<string, unknown>): void {
  db.prepare(
    `INSERT INTO events (request_id, action_id, type, message, data, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(requestId, actionId ?? null, type, message, data ? JSON.stringify(data) : null, nowIso());
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface OrchestratorDeps {
  db: DatabaseSync;
  provider: LLMProvider;
}

/**
 * Submit a new request. Returns the request ID.
 * Drives through: RECEIVED → INTERPRETING → INTERPRETED → PLANNING → (terminal or PLAN_READY)
 */
export async function submitRequest(deps: OrchestratorDeps, rawText: string): Promise<string> {
  const { db, provider } = deps;
  const id = randomUUID();
  const now = nowIso();

  // Persist as RECEIVED
  db.prepare(
    `INSERT INTO requests (id, raw_text, status, created_at, updated_at)
     VALUES (?, ?, 'RECEIVED', ?, ?)`,
  ).run(id, rawText, now, now);

  addEvent(db, id, 'REQUEST_RECEIVED', `Request received (${rawText.length} chars)`);

  // --- INTERPRETING ---
  updateRequestStatus(db, id, 'RECEIVED', 'INTERPRETING');
  addEvent(db, id, 'INTERPRETATION_STARTED', 'Sending to language model for interpretation');

  let interpretation: Interpretation;
  try {
    interpretation = await provider.interpret(rawText);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateRequestStatus(db, id, 'INTERPRETING', 'FAILED', { error: message });
    addEvent(db, id, 'REQUEST_FAILED', `Interpretation failed: ${message}`);
    return id;
  }

  // Persist interpretation
  const interpJson = JSON.stringify(interpretation);
  updateRequestStatus(db, id, 'INTERPRETING', 'INTERPRETED', { interpretation: interpJson });
  addEvent(db, id, 'INTERPRETATION_COMPLETED', `Interpreted: "${interpretation.task_title}" — ${interpretation.action_items.length} actions`);

  // --- PLANNING ---
  updateRequestStatus(db, id, 'INTERPRETED', 'PLANNING');

  const actions = plan(interpretation, id);
  const nextStatus = statusAfterPlanning(actions);

  // Persist planned actions
  for (const action of actions) {
    const actionId = randomUUID();
    db.prepare(
      `INSERT INTO actions (id, request_id, seq, title, classification, reason, tool, tool_input, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(actionId, id, action.seq, action.title, action.classification, action.reason, action.tool, action.toolInput ? JSON.stringify(action.toolInput) : null, action.status, now, now);

    addEvent(db, id, 'PLAN_GENERATED', `Action ${action.seq}: "${action.title}" → ${action.classification}`, actionId, {
      tool: action.tool,
      classification: action.classification,
    });

    if (action.classification === 'REQUIRES_CLARIFICATION') {
      addEvent(db, id, 'CLARIFICATION_NEEDED', `"${action.title}" needs clarification: ${action.reason}`, actionId);
    }
    if (action.classification === 'PREPARE_FOR_HUMAN_REVIEW') {
      addEvent(db, id, 'APPROVAL_REQUESTED', `"${action.title}" awaiting human approval`, actionId);
    }
  }

  updateRequestStatus(db, id, 'PLANNING', nextStatus);

  if (nextStatus === 'NEEDS_CLARIFICATION') {
    addEvent(db, id, 'CLARIFICATION_NEEDED', 'Request needs clarification before any work can proceed');
    return id;
  }

  if (nextStatus === 'COMPLETED') {
    addEvent(db, id, 'REQUEST_COMPLETED', 'No actionable work identified');
    return id;
  }

  // PLAN_READY — execute automatic actions
  await executeReadyActions(deps, id);

  return id;
}

/**
 * Execute all PENDING (automatic) actions for a request.
 * PENDING_APPROVAL actions are skipped — they wait for human approval.
 */
async function executeReadyActions(deps: OrchestratorDeps, requestId: string): Promise<void> {
  const { db } = deps;

  const actions = db.prepare(
    `SELECT * FROM actions WHERE request_id = ? ORDER BY seq`,
  ).all(requestId) as unknown as ActionRow[];

  // Move request to EXECUTING
  const request = db.prepare(`SELECT status FROM requests WHERE id = ?`).get(requestId) as { status: RequestStatus } | undefined;
  if (!request) return;

  if (request.status === 'PLAN_READY') {
    updateRequestStatus(db, requestId, 'PLAN_READY', 'EXECUTING');
  }

  for (const action of actions) {
    if (action.status === 'PENDING') {
      await executeSingleAction(deps, action);
    }
  }

  // Check if all actions are terminal now
  await checkRequestCompletion(deps, requestId);
}

/**
 * Execute a single action. The action must be in PENDING or APPROVED status.
 * PENDING_APPROVAL → EXECUTING is ILLEGAL — approval cannot be skipped.
 */
async function executeSingleAction(deps: OrchestratorDeps, action: ActionRow): Promise<void> {
  const { db } = deps;

  // Only PENDING and APPROVED can transition to EXECUTING
  if (action.status !== 'PENDING' && action.status !== 'APPROVED') {
    return;
  }

  if (!action.tool || !isKnownTool(action.tool)) {
    updateActionStatus(db, action.id, action.status, 'FAILED', { error: `Unknown or missing tool: ${action.tool}` });
    addEvent(db, action.request_id, 'TOOL_FAILED', `Unknown tool "${action.tool}"`, action.id);
    return;
  }

  const toolFn = getTool(action.tool);
  if (!toolFn) {
    updateActionStatus(db, action.id, action.status, 'FAILED', { error: `Tool "${action.tool}" not registered` });
    addEvent(db, action.request_id, 'TOOL_FAILED', `Tool "${action.tool}" not registered`, action.id);
    return;
  }

  // Parse tool input
  let toolInput: Record<string, unknown> = {};
  if (action.tool_input) {
    try {
      toolInput = JSON.parse(action.tool_input) as Record<string, unknown>;
    } catch {
      updateActionStatus(db, action.id, action.status, 'FAILED', { error: 'Invalid tool input JSON' });
      addEvent(db, action.request_id, 'TOOL_FAILED', 'Invalid tool input JSON', action.id);
      return;
    }
  }

  // Inject request_id and action_id for tools that need them
  toolInput['request_id'] = action.request_id;
  toolInput['action_id'] = action.id;

  // Transition to EXECUTING
  updateActionStatus(db, action.id, action.status, 'EXECUTING');
  addEvent(db, action.request_id, 'TOOL_EXECUTED', `Executing ${action.tool}`, action.id);

  try {
    const result = await toolFn(toolInput);
    if (result.ok) {
      updateActionStatus(db, action.id, 'EXECUTING', 'COMPLETED', { output: JSON.stringify(result.data) });
      addEvent(db, action.request_id, 'ACTION_COMPLETED', result.summary, action.id, result.data);
    } else {
      updateActionStatus(db, action.id, 'EXECUTING', 'FAILED', { error: result.summary, output: JSON.stringify(result.data) });
      addEvent(db, action.request_id, 'TOOL_FAILED', result.summary, action.id, result.data);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateActionStatus(db, action.id, 'EXECUTING', 'FAILED', { error: message });
    addEvent(db, action.request_id, 'TOOL_FAILED', `Tool crashed: ${message}`, action.id);
  }
}

/**
 * Check if all actions for a request are terminal. If so, complete/fail the request.
 */
async function checkRequestCompletion(deps: OrchestratorDeps, requestId: string): Promise<void> {
  const { db } = deps;

  const request = db.prepare(`SELECT status FROM requests WHERE id = ?`).get(requestId) as { status: RequestStatus } | undefined;
  if (!request || request.status !== 'EXECUTING') return;

  const actions = db.prepare(`SELECT status FROM actions WHERE request_id = ?`).all(requestId) as unknown as { status: ActionStatus }[];

  const allTerminal = actions.every((a) => isTerminalActionStatus(a.status));
  const hasPending = actions.some((a) => a.status === 'PENDING_APPROVAL');

  if (hasPending) {
    // Still waiting for approvals — go back to PLAN_READY
    updateRequestStatus(db, requestId, 'EXECUTING', 'PLAN_READY');
    return;
  }

  if (allTerminal) {
    const anyFailed = actions.some((a) => a.status === 'FAILED');
    if (anyFailed) {
      updateRequestStatus(db, requestId, 'EXECUTING', 'FAILED', { error: 'One or more actions failed' });
      addEvent(db, requestId, 'REQUEST_FAILED', 'One or more actions failed');
    } else {
      updateRequestStatus(db, requestId, 'EXECUTING', 'COMPLETED');
      addEvent(db, requestId, 'REQUEST_COMPLETED', 'All actions completed');
    }
  }
}

// ---------------------------------------------------------------------------
// Approval / Rejection / Edit
// ---------------------------------------------------------------------------

/**
 * Approve an action. Transitions PENDING_APPROVAL → APPROVED → EXECUTING.
 */
export async function approveAction(deps: OrchestratorDeps, actionId: string): Promise<void> {
  const { db } = deps;

  const action = db.prepare(`SELECT * FROM actions WHERE id = ?`).get(actionId) as unknown as ActionRow | undefined;
  if (!action) throw new Error(`Action not found: ${actionId}`);

  updateActionStatus(db, action.id, action.status as ActionStatus, 'APPROVED');
  addEvent(db, action.request_id, 'APPROVAL_RECEIVED', `"${action.title}" approved`, action.id);

  // Execute immediately
  const updated = { ...action, status: 'APPROVED' as ActionStatus };
  await executeSingleAction(deps, updated);

  // Check if request should complete
  await checkRequestCompletion(deps, action.request_id);

  // If request is still PLAN_READY or NEEDS_CLARIFICATION, check if we should re-enter EXECUTING
  const request = db.prepare(`SELECT status FROM requests WHERE id = ?`).get(action.request_id) as { status: RequestStatus } | undefined;
  if (request?.status === 'PLAN_READY') {
    await executeReadyActions(deps, action.request_id);
  }
}

/**
 * Reject an action. Transitions PENDING_APPROVAL → REJECTED.
 */
export function rejectAction(deps: OrchestratorDeps, actionId: string): void {
  const { db } = deps;

  const action = db.prepare(`SELECT * FROM actions WHERE id = ?`).get(actionId) as unknown as ActionRow | undefined;
  if (!action) throw new Error(`Action not found: ${actionId}`);

  updateActionStatus(db, action.id, action.status as ActionStatus, 'REJECTED');
  addEvent(db, action.request_id, 'ACTION_REJECTED', `"${action.title}" rejected`, action.id);
}

/**
 * Edit an action's tool input. Transitions PENDING_APPROVAL → PENDING_APPROVAL (self-transition).
 */
export function editAction(deps: OrchestratorDeps, actionId: string, newInput: Record<string, unknown>): void {
  const { db } = deps;

  const action = db.prepare(`SELECT * FROM actions WHERE id = ?`).get(actionId) as unknown as ActionRow | undefined;
  if (!action) throw new Error(`Action not found: ${actionId}`);

  updateActionStatus(db, action.id, action.status as ActionStatus, 'PENDING_APPROVAL', { tool_input: JSON.stringify(newInput) });
  addEvent(db, action.request_id, 'ACTION_EDITED', `"${action.title}" edited`, action.id, newInput);
}

// ---------------------------------------------------------------------------
// Queries (read-only — for the API layer)
// ---------------------------------------------------------------------------

export function getRequest(db: DatabaseSync, id: string): RequestRow | undefined {
  return db.prepare(`SELECT * FROM requests WHERE id = ?`).get(id) as unknown as RequestRow | undefined;
}

export function getRequestActions(db: DatabaseSync, requestId: string): ActionRow[] {
  return db.prepare(`SELECT * FROM actions WHERE request_id = ? ORDER BY seq`).all(requestId) as unknown as ActionRow[];
}

export function getRequestEvents(db: DatabaseSync, requestId: string): EventRow[] {
  return db.prepare(`SELECT * FROM events WHERE request_id = ? ORDER BY id`).all(requestId) as unknown as EventRow[];
}

export function getRequestTasks(db: DatabaseSync, requestId: string): TaskRow[] {
  return db.prepare(`SELECT * FROM tasks WHERE request_id = ?`).all(requestId) as unknown as TaskRow[];
}

export type { RequestRow, ActionRow, EventRow, TaskRow };
