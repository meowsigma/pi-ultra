import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ULTRA_MANAGER_ENTRY,
  createUltraManagerState,
  type UltraManagerEvent,
} from '../extensions/ultra-manager-state.js';

function event(overrides: Partial<UltraManagerEvent> = {}): UltraManagerEvent {
  return {
    version: 1,
    id: 'event-1',
    scopeId: 'scope-1',
    rootId: 'leaf-1',
    kind: 'scope-opened',
    policyRevision: 'revision-1',
    createdAt: 1,
    ...overrides,
  };
}

test('manager state requires an active matching takeover before parent mutation', () => {
  const persisted: UltraManagerEvent[] = [];
  const state = createUltraManagerState({ append: (entry) => persisted.push(entry) });
  state.restore([]);
  assert.equal(state.allowsMutation({ scopeId: 'scope-1', rootId: 'leaf-1', policyRevision: 'revision-1' }), false);

  state.openScope({ scopeId: 'scope-1', rootId: 'leaf-1', policyRevision: 'revision-1', createdAt: 1 });
  assert.equal(state.allowsMutation({ scopeId: 'scope-1', rootId: 'leaf-1', policyRevision: 'revision-1' }), false);

  state.recordTakeover({ scopeId: 'scope-1', rootId: 'leaf-1', policyRevision: 'revision-1', reason: 'urgent-user-directed', createdAt: 2 });
  assert.equal(state.allowsMutation({ scopeId: 'scope-1', rootId: 'leaf-1', policyRevision: 'revision-1' }), true);
  assert.equal(state.allowsMutation({ scopeId: 'scope-1', rootId: 'leaf-2', policyRevision: 'revision-1' }), false);
  assert.equal(state.allowsMutation({ scopeId: 'scope-1', rootId: 'leaf-1', policyRevision: 'revision-2' }), false);
  assert.deepEqual(persisted.map((entry) => entry.kind), ['scope-opened', 'takeover']);
});

test('manager state accepts only persisted evidence eligible takeover reasons', () => {
  const state = createUltraManagerState({ append: () => undefined });
  state.openScope({ scopeId: 'scope-1', rootId: 'leaf-1', policyRevision: 'revision-1', createdAt: 1 });
  assert.throws(() => state.recordTakeover({ scopeId: 'scope-1', rootId: 'leaf-1', policyRevision: 'revision-1', reason: 'dirty-worktree', createdAt: 2 }), /evidence/i);
  state.recordEvidence({ scopeId: 'scope-1', rootId: 'leaf-1', policyRevision: 'revision-1', evidence: 'dirty-worktree', createdAt: 2 });
  state.recordTakeover({ scopeId: 'scope-1', rootId: 'leaf-1', policyRevision: 'revision-1', reason: 'dirty-worktree', createdAt: 3 });
  assert.equal(state.allowsMutation({ scopeId: 'scope-1', rootId: 'leaf-1', policyRevision: 'revision-1' }), true);
});

test('restore is fail closed for malformed, superseded, and terminal scopes', () => {
  const state = createUltraManagerState({ append: () => undefined });
  state.restore([
    { type: 'custom', customType: ULTRA_MANAGER_ENTRY, data: event({ kind: 'scope-opened' }) },
    { type: 'custom', customType: ULTRA_MANAGER_ENTRY, data: event({ id: 'event-2', kind: 'takeover', createdAt: 2, reason: 'urgent-user-directed' }) },
    { type: 'custom', customType: ULTRA_MANAGER_ENTRY, data: { nope: true } },
    { type: 'custom', customType: ULTRA_MANAGER_ENTRY, data: event({ id: 'event-3', kind: 'scope-closed', createdAt: 3 }) },
  ]);
  assert.equal(state.allowsMutation({ scopeId: 'scope-1', rootId: 'leaf-1', policyRevision: 'revision-1' }), false);
});
