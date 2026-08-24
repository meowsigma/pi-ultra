import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ULTRA_OPERATION_ENTRY,
  createUltraOperationStore,
  ultraLaunchIdempotencyKey,
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
    results: [{ workflowKey: 'worker-a', agent: 'other-worker', model: 'openai/other', launchContractDigest: 'b'.repeat(64), authorityLaunchContractDigest: 'b'.repeat(64), changedFiles: ['src/other.ts'] }],
  });
  assert.ok(terminal);
  assert.equal(terminal.operation.status, 'completed');
  assert.equal(terminal.operation.outbox, 'ready');
  assert.deepEqual(terminal.operation.actualLanes?.[0]?.mismatches, [
    "agent expected 'ultra-worker' but ran 'other-worker'",
    "model expected fixed 'openai/test' but ran 'openai/other'",
    'authority launch-contract digest mismatch',
    "changed path 'src/other.ts' is outside owned paths",
  ]);
  const count = appended.length;
  assert.equal(store.applyCompletion({ runId: 'run-1', state: 'complete', results: [] }), undefined);
  assert.equal(appended.length, count);
});

test('retains escaping changed paths as ownership mismatches instead of dropping their evidence', () => {
  const store = createUltraOperationStore({ append: () => undefined });
  launch(store);
  const terminal = store.applyCompletion({
    runId: 'run-1', state: 'complete',
    results: [{ workflowKey: 'worker-a', agent: 'ultra-worker', model: 'openai/test', launchContractDigest: 'a'.repeat(64), authorityLaunchContractDigest: 'a'.repeat(64), changedFiles: ['/etc/cron.d/x', '../secrets'] }],
  });
  assert.ok(terminal);
  assert.deepEqual(terminal.operation.actualLanes?.[0]?.changedFiles, ['/etc/cron.d/x', '../secrets']);
  assert.match(terminal.operation.actualLanes?.[0]?.mismatches.join('\n') ?? '', /outside owned paths/);
});

test('accepts role-default fallback only inside the exact candidate list', () => {
  const store = createUltraOperationStore({ append: () => undefined });
  store.recordLaunch({
    operationId: 'op-role', runId: 'run-role', objective: 'Review.', acceptance: ['Check.'], receipt: {},
    lanes: [lane({ requestedModel: undefined, expectedFixedModel: undefined, modelCandidates: ['openai/one', 'openai/two'], role: 'reviewer', ownedPaths: undefined })],
  });
  const terminal = store.applyCompletion({ runId: 'run-role', state: 'complete', results: [{ workflowKey: 'worker-a', agent: 'ultra-worker', model: 'openai/two', launchContractDigest: 'runtime'.padEnd(64, 'a'), authorityLaunchContractDigest: 'a'.repeat(64) }] });
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

test('outbox budgets preserve every lane and final audit instruction under maximum acceptance input', () => {
  const store = createUltraOperationStore({ append: () => undefined });
  store.recordLaunch({
    operationId: 'op-bounded', runId: 'run-bounded', objective: 'Bound output.', receipt: {},
    acceptance: Array.from({ length: 32 }, (_, index) => `${index}-${'x'.repeat(2_048)}`),
    lanes: Array.from({ length: 8 }, (_, index) => lane({ id: `lane-${index}`, ownedPaths: [`src/${index}`] })),
  });
  const terminal = store.applyCompletion({ runId: 'run-bounded', state: 'complete', results: [] });
  assert.ok(terminal);
  assert.ok(terminal.content.length < 32_768);
  for (let index = 0; index < 8; index += 1) assert.match(terminal.content, new RegExp(`lane-${index}:`));
  assert.match(terminal.content, /evidence only/i);
  assert.match(terminal.content, /omitted/i);
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

test('rejects malformed restored snapshots before ready outbox rendering and unknown completions', () => {
  const store = createUltraOperationStore({ append: () => undefined });
  store.restore([
    { type: 'custom', customType: ULTRA_OPERATION_ENTRY, data: { version: 999, operationId: 'bad' } },
    { type: 'custom', customType: ULTRA_OPERATION_ENTRY, data: {
      version: 1, operationId: 'corrupt', rootOperationId: 'corrupt', runId: 'corrupt-run', objective: 'x',
      acceptance: [42], lanes: [{}], receipt: {}, status: 'failed', outbox: 'ready', repairCount: 0,
      createdAt: 1, updatedAt: 1,
    } },
    { type: 'custom', customType: 'other', data: { version: 1 } },
    { type: 'custom', customType: ULTRA_OPERATION_ENTRY, data: 'not-object' },
  ]);
  assert.deepEqual(store.list(), []);
  assert.deepEqual(store.pendingOutbox(), []);
  assert.equal(store.applyCompletion({ runId: 'unknown', state: 'complete' }), undefined);
});

test('persists a queued launch attempt before permit issue, then admits and launches through the append log', () => {
  const entries: any[] = [];
  const store = createUltraOperationStore({ append: (data) => entries.push({ type: 'custom', customType: ULTRA_OPERATION_ENTRY, data }), now: () => entries.length + 1 });
  const key = ultraLaunchIdempotencyKey({ operationId: 'op-1', laneId: 'worker-a', attemptIndex: 0 });
  const queued = store.recordQueuedLaunch({ idempotencyKey: key, operationId: 'op-1', runId: 'run-1', lanes: [lane()], receipt: { details: { runId: 'run-1' } } });

  assert.equal(queued.state, 'queued');
  assert.equal(queued.operationId, 'op-1');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].customType, ULTRA_OPERATION_ENTRY);
  assert.equal(entries[0].data.kind, 'launch-attempt');
  assert.equal(entries[0].data.state, 'queued');

  const admitted = store.markLaunchAdmitted(key);
  assert.equal(admitted.state, 'admitted');
  const launched = store.markLaunched(key);
  assert.equal(launched.state, 'launched');
  assert.equal(store.getLaunchAttempt(key)?.state, 'launched');
  assert.deepEqual(JSON.parse(JSON.stringify(entries.map((entry) => entry.data.state))), ['queued', 'admitted', 'launched']);

  // Terminal states are immutable; repeats of an already-recorded transition stay at-least-once safe.
  assert.deepEqual(store.markLaunched(key), launched);
  assert.equal(entries.length, 3);
  assert.throws(() => store.markLaunchAdmitted(key), /cannot move/i);
  assert.throws(() => store.markFailedPreSpawn(key, 'late failure'), /cannot move/i);
});

test('derives deterministic idempotency keys and dedupes duplicate queue requests without appending', () => {
  const input = { operationId: 'op-1', runId: 'run-1', laneId: 'worker-a', attemptIndex: 2 };
  assert.equal(ultraLaunchIdempotencyKey(input), ultraLaunchIdempotencyKey({ ...input }));
  assert.notEqual(ultraLaunchIdempotencyKey(input), ultraLaunchIdempotencyKey({ ...input, attemptIndex: 3 }));
  assert.notEqual(ultraLaunchIdempotencyKey(input), ultraLaunchIdempotencyKey({ ...input, laneId: 'worker-b' }));
  assert.notEqual(ultraLaunchIdempotencyKey(input), ultraLaunchIdempotencyKey({ operationId: 'op-2', runId: 'run-1', laneId: 'worker-a', attemptIndex: 2 }));

  const appended: any[] = [];
  const store = createUltraOperationStore({ append: (data) => appended.push(data), now: () => 1 });
  const key = ultraLaunchIdempotencyKey(input);
  const first = store.recordQueuedLaunch({ idempotencyKey: key, operationId: 'op-1', runId: 'run-1', lanes: [lane()], receipt: {} });
  const second = store.recordQueuedLaunch({ idempotencyKey: key, operationId: 'op-1', runId: 'run-1', lanes: [lane()], receipt: {} });
  assert.deepEqual(second, first);
  assert.equal(appended.length, 1);
  assert.equal(store.listLaunchAttempts().length, 1);
  assert.throws(
    () => store.recordQueuedLaunch({ idempotencyKey: key, operationId: 'other-op', runId: 'run-1', lanes: [lane()], receipt: {} }),
    /already belongs|conflict/i,
  );
});

test('records failed-pre-spawn from queued or admitted and keeps the failure durable across reload', () => {
  const entries: any[] = [];
  const store = createUltraOperationStore({ append: (data) => entries.push({ type: 'custom', customType: ULTRA_OPERATION_ENTRY, data }), now: () => 5 });
  const queuedKey = ultraLaunchIdempotencyKey({ operationId: 'op-a', attemptIndex: 0 });
  store.recordQueuedLaunch({ idempotencyKey: queuedKey, operationId: 'op-a', runId: 'run-a', lanes: [lane()], receipt: {} });

  const failedQueued = store.markFailedPreSpawn(queuedKey, 'permit denied before spawn');
  assert.equal(failedQueued.state, 'failed-pre-spawn');
  assert.equal(failedQueued.reason, 'permit denied before spawn');

  const admittedKey = ultraLaunchIdempotencyKey({ operationId: 'op-b', attemptIndex: 0 });
  store.recordQueuedLaunch({ idempotencyKey: admittedKey, operationId: 'op-b', runId: 'run-b', lanes: [lane()], receipt: {} });
  store.markLaunchAdmitted(admittedKey);
  const failedAdmitted = store.markFailedPreSpawn(admittedKey, new Array(3_000).fill('x').join(''));
  assert.equal(failedAdmitted.state, 'failed-pre-spawn');
  assert.equal(failedAdmitted.reason?.length, 2_048);

  assert.throws(() => store.markFailedPreSpawn(queuedKey, ''), /non-empty reason/i);

  const restored = createUltraOperationStore({ append: () => undefined, now: () => 6 });
  restored.restore(entries);
  assert.equal(restored.getLaunchAttempt(queuedKey)?.state, 'failed-pre-spawn');
  assert.equal(restored.getLaunchAttempt(queuedKey)?.reason, 'permit denied before spawn');
  assert.equal(restored.getLaunchAttempt(admittedKey)?.reason?.length, 2_048);
});

test('replays the append log and surfaces ambiguous admitted launches instead of relaunching them', () => {
  const entries: any[] = [];
  const store = createUltraOperationStore({ append: (data) => entries.push({ type: 'custom', customType: ULTRA_OPERATION_ENTRY, data }) });
  const crashedKey = ultraLaunchIdempotencyKey({ operationId: 'op-crash', laneId: 'worker-a' });
  const launchedKey = ultraLaunchIdempotencyKey({ operationId: 'op-ok', laneId: 'worker-a' });
  const failedKey = ultraLaunchIdempotencyKey({ operationId: 'op-bad', laneId: 'worker-a' });
  store.recordQueuedLaunch({ idempotencyKey: crashedKey, operationId: 'op-crash', runId: 'run-crash', lanes: [lane()], receipt: {} });
  store.recordQueuedLaunch({ idempotencyKey: launchedKey, operationId: 'op-ok', runId: 'run-ok', lanes: [lane()], receipt: {} });
  store.recordQueuedLaunch({ idempotencyKey: failedKey, operationId: 'op-bad', runId: 'run-bad', lanes: [lane()], receipt: {} });
  store.markLaunchAdmitted(crashedKey);
  store.markLaunchAdmitted(launchedKey);
  store.markLaunchAdmitted(failedKey);
  store.markLaunched(launchedKey);
  store.markFailedPreSpawn(failedKey, 'spawn rejected');

  // Crash before confirmation: replaying the durable log leaves exactly the
  // admitted-only attempt in the ambiguous window.
  const recovered = createUltraOperationStore({ append: () => undefined });
  recovered.restore(entries);
  assert.deepEqual(recovered.ambiguousAdmittedLaunches().map((attempt) => attempt.idempotencyKey), [crashedKey]);
  assert.equal(recovered.getLaunchAttempt(launchedKey)?.state, 'launched');
  assert.equal(recovered.getLaunchAttempt(failedKey)?.state, 'failed-pre-spawn');

  // Recovery resolves the ambiguity explicitly; relaunch decisions stay outside the store.
  const settled = recovered.markFailedPreSpawn(crashedKey, 'post-crash inspection found no child session');
  assert.equal(settled.state, 'failed-pre-spawn');
  assert.deepEqual(recovered.ambiguousAdmittedLaunches(), []);
});

test('guards launch-attempt transitions, JSON safety, and malformed restore entries', () => {
  const store = createUltraOperationStore({ append: () => undefined });
  assert.throws(() => store.markLaunched(ultraLaunchIdempotencyKey({ operationId: 'ghost' })), /not found/i);
  assert.throws(() => store.markLaunchAdmitted('missing-key'), /not found/i);
  assert.throws(
    () => store.recordQueuedLaunch({ idempotencyKey: '', operationId: 'op', runId: 'run', lanes: [], receipt: {} }),
    /idempotency key/i,
  );
  assert.throws(
    () => store.recordQueuedLaunch({ idempotencyKey: 'k', operationId: '', runId: '', lanes: [], receipt: {} }),
    /operationId and runId/i,
  );
  assert.throws(
    () => store.recordQueuedLaunch({ idempotencyKey: 'k-json', operationId: 'op', runId: 'run', lanes: [], receipt: { bad: 1n } }),
    /JSON-safe/i,
  );

  const restored = createUltraOperationStore({ append: () => undefined });
  restored.restore([
    { type: 'custom', customType: ULTRA_OPERATION_ENTRY, data: { version: 1, kind: 'launch-attempt', idempotencyKey: 'bad', operationId: 'op', runId: 'run', lanes: [], state: 'teleported' } },
    { type: 'custom', customType: ULTRA_OPERATION_ENTRY, data: 'junk' },
    { type: 'custom', customType: ULTRA_OPERATION_ENTRY, data: { version: 1, kind: 'launch-attempt', idempotencyKey: 'good', operationId: 'op', runId: 'run', lanes: [], receipt: null, state: 'queued', createdAt: 1, updatedAt: 1 } },
  ]);
  assert.equal(restored.listLaunchAttempts().length, 1);
  assert.equal(restored.getLaunchAttempt('good')?.state, 'queued');
});
