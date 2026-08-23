import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ULTRA_OPERATION_ENTRY,
  createUltraOperationStore,
  type UltraOperationLane,
} from '../extensions/ultra-operations.js';

function lane(overrides: Partial<UltraOperationLane> = {}): UltraOperationLane {
  return {
    id: 'worker-a', role: 'worker', agent: 'ultra-worker',
    requestedModel: 'openai/test', modelCandidates: ['openai/test'], expectedFixedModel: 'openai/test',
    launchContractDigest: 'a'.repeat(64), ownedPaths: ['src/parser'],
    ...overrides,
  };
}

function launch(store: ReturnType<typeof createUltraOperationStore>, overrides: Record<string, unknown> = {}) {
  return store.recordLaunch({
    operationId: String(overrides.operationId ?? 'op-1'),
    runId: String(overrides.runId ?? 'run-1'),
    objective: 'Implement parser.',
    acceptance: ['Run tests.'],
    lanes: [lane()],
    receipt: { details: { runId: String(overrides.runId ?? 'run-1') } },
    ...(overrides.repairOf ? { repairOf: String(overrides.repairOf) } : {}),
  });
}

test('persists bounded launch snapshots and restores latest state from the active branch', () => {
  const entries: any[] = [];
  const store = createUltraOperationStore({ append: (data) => entries.push({ type: 'custom', customType: ULTRA_OPERATION_ENTRY, data }), now: () => 100 });
  const operation = launch(store);
  assert.equal(operation.status, 'running');
  assert.equal(operation.rootOperationId, 'op-1');
  assert.equal(operation.repairCount, 0);
  assert.equal(entries.length, 1);

  const restored = createUltraOperationStore({ append: () => assert.fail('restore must not append'), now: () => 200 });
  restored.restore(entries);
  assert.deepEqual(restored.get('op-1'), operation);
});

test('resolves one root repair slot and rejects paused, sibling, repair-of-repair, reload, and second repair attempts', () => {
  const snapshots: any[] = [];
  const store = createUltraOperationStore({ append: (data) => snapshots.push({ type: 'custom', customType: ULTRA_OPERATION_ENTRY, data }), now: () => 100 });
  launch(store);
  assert.throws(() => store.assertRepairAllowed('op-1'), /terminal/i);
  store.applyCompletion({ runId: 'run-1', state: 'failed', results: [] });
  const allowed = store.assertRepairAllowed('op-1');
  assert.deepEqual(allowed, { rootOperationId: 'op-1', repairCount: 1 });
  const reservation = store.reserveRepair('op-1', 'reservation-1');
  assert.equal(reservation.state, 'reserved');
  store.recordLaunch({
    operationId: 'op-repair', runId: 'run-repair', objective: 'Repair.', acceptance: ['Test.'], lanes: [lane()], receipt: {},
    repairOf: 'op-1', repairReservationId: 'reservation-1',
  });
  assert.throws(() => store.assertRepairAllowed('op-1'), /one repair|take over/i);
  assert.throws(() => store.assertRepairAllowed('op-repair'), /one repair|take over/i);

  const restored = createUltraOperationStore({ append: () => undefined, now: () => 200 });
  restored.restore(snapshots);
  assert.throws(() => restored.assertRepairAllowed('op-1'), /one repair|take over/i);
});

test('a crash-persisted repair reservation blocks a second repair after reload', () => {
  const entries: any[] = [];
  const store = createUltraOperationStore({ append: (data) => entries.push({ type: 'custom', customType: ULTRA_OPERATION_ENTRY, data }) });
  launch(store);
  store.applyCompletion({ runId: 'run-1', state: 'failed', results: [] });
  store.reserveRepair('op-1', 'reservation-release');
  store.releaseRepair('reservation-release');
  assert.deepEqual(store.assertRepairAllowed('op-1'), { rootOperationId: 'op-1', repairCount: 1 });
  store.reserveRepair('op-1', 'reservation-crash');
  const restored = createUltraOperationStore({ append: () => undefined });
  restored.restore(entries);
  assert.throws(() => restored.assertRepairAllowed('op-1'), /reserved|one repair|take over/i);
});

test('treats paused as nonterminal, dedupes terminal events, and records actual binding mismatches', () => {
  const appended: any[] = [];
  const store = createUltraOperationStore({ append: (data) => appended.push(data), now: () => appended.length + 1 });
  launch(store);
  assert.equal(store.applyCompletion({ runId: 'run-1', state: 'paused' }), undefined);
  assert.equal(store.get('op-1')?.status, 'paused');
  const terminal = store.applyCompletion({
    runId: 'run-1', state: 'complete',
    results: [{ workflowKey: 'worker-a', agent: 'other-worker', model: 'openai/other', launchContractDigest: 'b'.repeat(64), changedFiles: ['src/other.ts'] }],
  });
  assert.ok(terminal);
  assert.equal(terminal.operation.status, 'completed');
  assert.equal(terminal.operation.outbox, 'ready');
  assert.deepEqual(terminal.operation.actualLanes?.[0]?.mismatches, [
    "agent expected 'ultra-worker' but ran 'other-worker'",
    "model expected fixed 'openai/test' but ran 'openai/other'",
    'launch-contract digest mismatch',
    "changed path 'src/other.ts' is outside owned paths",
  ]);
  const count = appended.length;
  assert.equal(store.applyCompletion({ runId: 'run-1', state: 'complete', results: [] }), undefined);
  assert.equal(appended.length, count);
});

test('accepts role-default fallback only inside the exact candidate list', () => {
  const store = createUltraOperationStore({ append: () => undefined });
  store.recordLaunch({
    operationId: 'op-role', runId: 'run-role', objective: 'Review.', acceptance: ['Check.'], receipt: {},
    lanes: [lane({ requestedModel: undefined, expectedFixedModel: undefined, modelCandidates: ['openai/one', 'openai/two'], role: 'reviewer', ownedPaths: undefined })],
  });
  const terminal = store.applyCompletion({ runId: 'run-role', state: 'complete', results: [{ workflowKey: 'worker-a', agent: 'ultra-worker', model: 'openai/two', launchContractDigest: 'a'.repeat(64) }] });
  assert.ok(terminal);
  assert.equal(terminal.operation.actualLanes?.[0]?.mismatches.some((item) => item.includes('model')), false);
});

test('uses a durable at-least-once outbox with stable duplicate-safe content', () => {
  const entries: any[] = [];
  const store = createUltraOperationStore({ append: (data) => entries.push({ type: 'custom', customType: ULTRA_OPERATION_ENTRY, data }) });
  launch(store);
  const terminal = store.applyCompletion({ runId: 'run-1', state: 'failed', results: [] });
  assert.ok(terminal);
  assert.match(terminal.content, /operation op-1/i);
  assert.match(terminal.content, /Acceptance: Run tests\./i);
  assert.match(terminal.content, /worker-a.*expected agent=ultra-worker.*actual agent=/is);
  assert.match(terminal.content, /evidence only/i);
  assert.deepEqual(store.pendingOutbox().map((item) => item.operationId), ['op-1']);

  const uncertainReload = createUltraOperationStore({ append: () => undefined });
  uncertainReload.restore(entries);
  assert.deepEqual(uncertainReload.pendingOutbox().map((item) => item.operationId), ['op-1']);
  uncertainReload.markOutboxSent('op-1');
  assert.deepEqual(uncertainReload.pendingOutbox(), []);
});

test('never positionally reuses keyed partial results for a missing lane', () => {
  const store = createUltraOperationStore({ append: () => undefined });
  store.recordLaunch({
    operationId: 'op-keyed', runId: 'run-keyed', objective: 'Two lanes.', acceptance: ['Check.'], receipt: {},
    lanes: [lane({ id: 'a' }), lane({ id: 'b', ownedPaths: ['src/b'] })],
  });
  const terminal = store.applyCompletion({ runId: 'run-keyed', state: 'complete', results: [
    { workflowKey: 'b', agent: 'ultra-worker', model: 'openai/test', launchContractDigest: 'a'.repeat(64), changedFiles: ['src/b/file.ts'] },
  ] });
  assert.ok(terminal);
  assert.equal(terminal.operation.actualLanes?.[0]?.agent, undefined);
  assert.equal(terminal.operation.actualLanes?.[1]?.agent, 'ultra-worker');
});

test('bounds malformed restore entries and unknown completions', () => {
  const store = createUltraOperationStore({ append: () => undefined });
  store.restore([
    { type: 'custom', customType: ULTRA_OPERATION_ENTRY, data: { version: 999, operationId: 'bad' } },
    { type: 'custom', customType: 'other', data: { version: 1 } },
    { type: 'custom', customType: ULTRA_OPERATION_ENTRY, data: 'not-object' },
  ]);
  assert.deepEqual(store.list(), []);
  assert.equal(store.applyCompletion({ runId: 'unknown', state: 'complete' }), undefined);
});
