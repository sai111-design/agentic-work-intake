/**
 * Deterministic planner. No LLM, no I/O, no randomness — a pure function from
 * an Interpretation to a list of classified actions.
 *
 * This is where the agent's boundary is enforced. The model describes what the
 * work IS; this file decides what the system may DO about it. Two consequences
 * are load-bearing:
 *
 *   - An action with unresolved missing information can never reach a tool.
 *     Rule 1 runs before tool selection, so there is no code path from
 *     "we don't know who the recipient is" to "send something". This is what
 *     makes the ambiguous-request scenario a guarantee rather than a hope.
 *
 *   - can_be_automated from the model is advisory and can only ever make the
 *     system MORE cautious, never less. Nothing the model returns can promote
 *     an action to automatic execution on its own.
 */

import type { ActionItem, ActionKind, Interpretation } from './schemas.js';
import type {
  ActionStatus,
  Classification,
  PlannedAction,
  RequestStatus,
  ToolName,
} from './types.js';

/** Policy: which kind of work maps to which tool. Owned by code. */
const KIND_TO_TOOL: Record<ActionKind, ToolName | null> = {
  communication: 'draft_communication',
  reminder: 'create_task',
  website_review: 'website_check',
  summary: 'generate_brief',
  other: null,
};

/** Tools whose output a human must approve before it takes effect. */
const TOOLS_REQUIRING_APPROVAL: ReadonlySet<ToolName> = new Set<ToolName>(['draft_communication']);

/** The persisted status each classification starts in. */
const STATUS_FOR: Record<Classification, ActionStatus> = {
  EXECUTE_AUTOMATICALLY: 'PENDING',
  PREPARE_FOR_HUMAN_REVIEW: 'PENDING_APPROVAL',
  REQUIRES_CLARIFICATION: 'NEEDS_CLARIFICATION',
  CANNOT_EXECUTE: 'BLOCKED',
};

/**
 * Shape check only — is this something we could hand to the website tool?
 * The real SSRF defence runs inside the tool at execution time.
 */
function isPlausibleHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

type InputResult =
  | { ok: true; input: Record<string, unknown> }
  | { ok: false; missing: string };

/**
 * Build the tool input, or report which required value is absent.
 *
 * These checks are structural: they do not depend on the model having
 * remembered to populate missing_information. A communication with no
 * identified recipient is blocked because the field is null, full stop.
 */
function buildToolInput(
  tool: ToolName,
  action: ActionItem,
  interpretation: Interpretation,
  requestId: string,
): InputResult {
  switch (tool) {
    case 'draft_communication': {
      if (action.recipient === null || action.recipient.trim() === '') {
        return { ok: false, missing: 'the request does not identify a specific recipient' };
      }
      const keyPoints = [action.detail].filter((s) => s.trim().length > 0);
      return {
        ok: true,
        input: {
          recipient_description: action.recipient.trim(),
          subject_hint: action.title,
          key_points: keyPoints,
          context: interpretation.summary,
          tone: 'formal',
        },
      };
    }

    case 'create_task':
      return {
        ok: true,
        input: {
          title: action.title,
          due_in_days: action.due_in_days,
          notes: action.detail,
        },
      };

    case 'website_check': {
      if (action.target_url === null || !isPlausibleHttpUrl(action.target_url)) {
        return { ok: false, missing: 'the request does not name a valid http(s) URL to check' };
      }
      return { ok: true, input: { url: action.target_url } };
    }

    case 'generate_brief':
      return { ok: true, input: { request_id: requestId } };
  }
}

function classifyAction(
  action: ActionItem,
  seq: number,
  interpretation: Interpretation,
  requestId: string,
): PlannedAction {
  const base = { seq, title: action.title };

  // RULE 1 — missing information stops everything, before a tool is even
  // considered. Deliberately first; reordering this would break the core
  // guarantee that the agent never acts on information it does not have.
  if (action.missing_information.length > 0) {
    return {
      ...base,
      classification: 'REQUIRES_CLARIFICATION',
      reason: `Cannot proceed until a human supplies: ${action.missing_information.join('; ')}.`,
      tool: null,
      toolInput: null,
      status: STATUS_FOR.REQUIRES_CLARIFICATION,
    };
  }

  // RULE 2 — map the kind of work to a tool.
  const tool = KIND_TO_TOOL[action.kind];

  // RULE 3 — no tool in this system can do it. Say so rather than improvising.
  if (tool === null) {
    return {
      ...base,
      classification: 'CANNOT_EXECUTE',
      reason: 'No tool in this system can perform this kind of action.',
      tool: null,
      toolInput: null,
      status: STATUS_FOR.CANNOT_EXECUTE,
    };
  }

  // RULE 4 — a required input is structurally absent.
  const built = buildToolInput(tool, action, interpretation, requestId);
  if (!built.ok) {
    return {
      ...base,
      classification: 'REQUIRES_CLARIFICATION',
      reason: `Cannot run ${tool}: ${built.missing}.`,
      tool,
      toolInput: null,
      status: STATUS_FOR.REQUIRES_CLARIFICATION,
    };
  }

  // RULE 5 — approval. Either the tool always needs it, or the model flagged
  // this action for review. Both can only add caution.
  if (TOOLS_REQUIRING_APPROVAL.has(tool) || action.requires_human_confirmation) {
    const why = TOOLS_REQUIRING_APPROVAL.has(tool)
      ? `${tool} produces outward-facing content, so a human must approve it before it is treated as done`
      : 'the interpretation flagged this action as needing human confirmation';
    return {
      ...base,
      classification: 'PREPARE_FOR_HUMAN_REVIEW',
      reason: `Prepared but not executed: ${why}.`,
      tool,
      toolInput: built.input,
      status: STATUS_FOR.PREPARE_FOR_HUMAN_REVIEW,
    };
  }

  // RULE 6 — safe to run without a human.
  return {
    ...base,
    classification: 'EXECUTE_AUTOMATICALLY',
    reason: `All required information is present and ${tool} has no outward-facing effect.`,
    tool,
    toolInput: built.input,
    status: STATUS_FOR.EXECUTE_AUTOMATICALLY,
  };
}

/**
 * Classify every action item.
 *
 * generate_brief actions are moved to the end so the brief renders the outputs
 * of tools that have already run rather than an empty result set.
 */
export function plan(interpretation: Interpretation, requestId: string): PlannedAction[] {
  const classified = interpretation.action_items.map((a, i) =>
    classifyAction(a, i, interpretation, requestId),
  );

  const briefLast = [
    ...classified.filter((a) => a.tool !== 'generate_brief'),
    ...classified.filter((a) => a.tool === 'generate_brief'),
  ];

  return briefLast.map((a, i) => ({ ...a, seq: i }));
}

/** Whether any action in the plan can actually move forward. */
export function hasActionableWork(actions: readonly PlannedAction[]): boolean {
  return actions.some(
    (a) =>
      a.classification === 'EXECUTE_AUTOMATICALLY' ||
      a.classification === 'PREPARE_FOR_HUMAN_REVIEW',
  );
}

/** The request status implied by a freshly generated plan. */
export function statusAfterPlanning(actions: readonly PlannedAction[]): RequestStatus {
  if (hasActionableWork(actions)) return 'PLAN_READY';
  if (actions.some((a) => a.classification === 'REQUIRES_CLARIFICATION')) {
    return 'NEEDS_CLARIFICATION';
  }
  // Nothing to do and nothing to ask — e.g. every action was CANNOT_EXECUTE.
  return 'COMPLETED';
}
