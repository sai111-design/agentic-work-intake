/** Shared vocabulary for the whole system. No behaviour, no I/O. */

export const REQUEST_STATUSES = [
  'RECEIVED',
  'INTERPRETING',
  'INTERPRETED',
  'PLANNING',
  'PLAN_READY',
  'EXECUTING',
  'COMPLETED',
  'FAILED',
  'NEEDS_CLARIFICATION',
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const ACTION_STATUSES = [
  'PENDING',
  'PENDING_APPROVAL',
  'APPROVED',
  'EXECUTING',
  'COMPLETED',
  'REJECTED',
  'FAILED',
  'BLOCKED',
  'NEEDS_CLARIFICATION',
] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

/** The four categories every planned action must fall into. */
export const CLASSIFICATIONS = [
  'EXECUTE_AUTOMATICALLY',
  'PREPARE_FOR_HUMAN_REVIEW',
  'CANNOT_EXECUTE',
  'REQUIRES_CLARIFICATION',
] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

/**
 * The complete, fixed set of tools. The router switches over exactly these,
 * so the model cannot name a tool into existence.
 */
export const TOOL_NAMES = [
  'draft_communication',
  'create_task',
  'website_check',
  'generate_brief',
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** Activity-trace event types. Written verbatim into events.type. */
export const EVENT_TYPES = [
  'REQUEST_RECEIVED',
  'INTERPRETATION_STARTED',
  'INTERPRETATION_COMPLETED',
  'VALIDATION_PASSED',
  'VALIDATION_FAILED',
  'PLAN_GENERATED',
  'TOOL_SELECTED',
  'TOOL_EXECUTED',
  'TOOL_FAILED',
  'APPROVAL_REQUESTED',
  'APPROVAL_RECEIVED',
  'ACTION_REJECTED',
  'ACTION_EDITED',
  'ACTION_COMPLETED',
  'REQUEST_COMPLETED',
  'REQUEST_FAILED',
  'CLARIFICATION_NEEDED',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** A single action after the deterministic planner has classified it. */
export interface PlannedAction {
  seq: number;
  title: string;
  classification: Classification;
  /** Always populated — every classification must be explainable. */
  reason: string;
  tool: ToolName | null;
  toolInput: Record<string, unknown> | null;
  /** Initial persisted status implied by the classification. */
  status: ActionStatus;
}

export class TransitionError extends Error {
  constructor(kind: string, from: string, to: string) {
    super(`Illegal ${kind} transition: ${from} -> ${to}`);
    this.name = 'TransitionError';
  }
}
