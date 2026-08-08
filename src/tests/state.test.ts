import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTION_TRANSITIONS,
  REQUEST_TRANSITIONS,
  assertActionTransition,
  assertRequestTransition,
  canTransitionAction,
  canTransitionRequest,
  isTerminalActionStatus,
  isTerminalRequestStatus,
} from '../core/transitions.js';
import { ACTION_STATUSES, REQUEST_STATUSES, TransitionError } from '../core/types.js';

test('every declared request transition is permitted', () => {
  for (const from of REQUEST_STATUSES) {
    for (const to of REQUEST_TRANSITIONS[from]) {
      assert.doesNotThrow(() => assertRequestTransition(from, to), `${from} -> ${to}`);
    }
  }
});

test('every declared action transition is permitted', () => {
  for (const from of ACTION_STATUSES) {
    for (const to of ACTION_TRANSITIONS[from]) {
      assert.doesNotThrow(() => assertActionTransition(from, to), `${from} -> ${to}`);
    }
  }
});

test('any transition not declared is rejected', () => {
  for (const from of REQUEST_STATUSES) {
    for (const to of REQUEST_STATUSES) {
      if (REQUEST_TRANSITIONS[from].includes(to)) continue;
      assert.throws(() => assertRequestTransition(from, to), TransitionError, `${from} -> ${to}`);
    }
  }
  for (const from of ACTION_STATUSES) {
    for (const to of ACTION_STATUSES) {
      if (ACTION_TRANSITIONS[from].includes(to)) continue;
      assert.throws(() => assertActionTransition(from, to), TransitionError, `${from} -> ${to}`);
    }
  }
});

// The security-critical case: nothing may run without passing through APPROVED.
test('approval cannot be skipped: PENDING_APPROVAL -> EXECUTING is illegal', () => {
  assert.equal(canTransitionAction('PENDING_APPROVAL', 'EXECUTING'), false);
  assert.throws(() => assertActionTransition('PENDING_APPROVAL', 'EXECUTING'), TransitionError);

  // The only route to execution from awaiting-approval is via APPROVED.
  assert.ok(canTransitionAction('PENDING_APPROVAL', 'APPROVED'));
  assert.ok(canTransitionAction('APPROVED', 'EXECUTING'));
});

test('an edit returns an action to PENDING_APPROVAL rather than advancing it', () => {
  assert.ok(canTransitionAction('PENDING_APPROVAL', 'PENDING_APPROVAL'));
});

test('rejected and completed actions are terminal', () => {
  for (const s of ['COMPLETED', 'REJECTED', 'FAILED', 'BLOCKED', 'NEEDS_CLARIFICATION'] as const) {
    assert.ok(isTerminalActionStatus(s), `${s} should be terminal`);
  }
  assert.equal(isTerminalActionStatus('PENDING_APPROVAL'), false);
});

test('terminal request statuses accept no further transitions', () => {
  for (const s of ['COMPLETED', 'FAILED', 'NEEDS_CLARIFICATION'] as const) {
    assert.ok(isTerminalRequestStatus(s));
    for (const to of REQUEST_STATUSES) {
      assert.equal(canTransitionRequest(s, to), false, `${s} -> ${to} must be rejected`);
    }
  }
});

test('a rejected action can never later be executed or completed', () => {
  for (const to of ACTION_STATUSES) {
    assert.equal(canTransitionAction('REJECTED', to), false);
  }
});
