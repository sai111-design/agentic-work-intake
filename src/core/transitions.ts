/**
 * Explicit state machine. Every status change in the system goes through
 * assertRequestTransition / assertActionTransition, so an illegal move is a
 * thrown error rather than a silently corrupt row.
 *
 * The security-relevant entry is ACTION_TRANSITIONS.PENDING_APPROVAL, which
 * does NOT list EXECUTING: approval cannot be skipped.
 */

import {
  TransitionError,
  type ActionStatus,
  type RequestStatus,
} from './types.js';

export const REQUEST_TRANSITIONS: Record<RequestStatus, readonly RequestStatus[]> = {
  RECEIVED: ['INTERPRETING'],
  INTERPRETING: ['INTERPRETED', 'FAILED'],
  INTERPRETED: ['PLANNING'],
  PLANNING: ['PLAN_READY', 'NEEDS_CLARIFICATION', 'FAILED'],
  PLAN_READY: ['EXECUTING', 'NEEDS_CLARIFICATION', 'COMPLETED'],
  EXECUTING: ['COMPLETED', 'FAILED', 'PLAN_READY'],
  COMPLETED: [],
  FAILED: [],
  NEEDS_CLARIFICATION: [],
};

export const ACTION_TRANSITIONS: Record<ActionStatus, readonly ActionStatus[]> = {
  PENDING: ['EXECUTING', 'PENDING_APPROVAL', 'BLOCKED', 'NEEDS_CLARIFICATION'],
  // Self-transition is the "EDITED" case: an edit returns the action to
  // PENDING_APPROVAL. Note EXECUTING is absent — approval is mandatory.
  PENDING_APPROVAL: ['APPROVED', 'REJECTED', 'PENDING_APPROVAL'],
  APPROVED: ['EXECUTING'],
  EXECUTING: ['COMPLETED', 'FAILED'],
  COMPLETED: [],
  REJECTED: [],
  FAILED: [],
  BLOCKED: [],
  NEEDS_CLARIFICATION: [],
};

export function canTransitionRequest(from: RequestStatus, to: RequestStatus): boolean {
  return REQUEST_TRANSITIONS[from].includes(to);
}

export function canTransitionAction(from: ActionStatus, to: ActionStatus): boolean {
  return ACTION_TRANSITIONS[from].includes(to);
}

export function assertRequestTransition(from: RequestStatus, to: RequestStatus): void {
  if (!canTransitionRequest(from, to)) throw new TransitionError('request', from, to);
}

export function assertActionTransition(from: ActionStatus, to: ActionStatus): void {
  if (!canTransitionAction(from, to)) throw new TransitionError('action', from, to);
}

/** Statuses from which no further progress is possible. */
export function isTerminalRequestStatus(s: RequestStatus): boolean {
  return REQUEST_TRANSITIONS[s].length === 0;
}

export function isTerminalActionStatus(s: ActionStatus): boolean {
  return ACTION_TRANSITIONS[s].length === 0;
}
