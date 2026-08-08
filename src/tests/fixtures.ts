/** Shared test fixtures. Not a test file — no assertions here. */

import type { ActionItem, Interpretation } from '../core/schemas.js';

export function makeAction(over: Partial<ActionItem> = {}): ActionItem {
  return {
    title: 'Do the thing',
    detail: 'Context drawn from the request.',
    kind: 'reminder',
    recipient: null,
    target_url: null,
    missing_information: [],
    due_in_days: null,
    can_be_automated: true,
    requires_human_confirmation: false,
    ...over,
  };
}

export function makeInterpretation(over: Partial<Interpretation> = {}): Interpretation {
  return {
    task_title: 'Test request',
    summary: 'A short summary of what was asked.',
    priority: 'medium',
    detected_deadline: null,
    action_items: [],
    missing_information: [],
    what_can_be_automated: [],
    what_requires_human_confirmation: [],
    ...over,
  };
}
