import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildWaveWorkflow,
  preflightLane,
  requestPlan,
  spawnWave,
  validatePlan,
  waitForSubagentCapabilities,
} from '../extensions/ultra-protocol.js';
import { FakeEventBus } from './fixtures/fake-pi.js';

const READY = 'subagents:rpc:v1:ready';
const DELEGATION_REQUEST = 'prompt-template:subagent:request';
const DELEGATION_RESPONSE = 'prompt-template:subagent:response';
const RPC_REQUEST = 'subagents:rpc:v1:request';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function validPlan() {
  return {
    objective: 'Implement the bounded change',
    evidence: ['The requested files are independent.'],
    mode: 'wave',
    lanes: [
      { id: 'worker-a', role: 'worker', task: 'Implement module A.', write: true },
      { id: 'review-a', role: 'reviewer', task: 'Review module A.', write: false },
    ],
    acceptance: ['Focused tests pass.'],
  };
}

test('waitForSubagentCapabilities returns readiness and times out cleanly', async () => {
  const readyEvents = new FakeEventBus();
  const waiting = waitForSubagentCapabilities(readyEvents, 50);
  readyEvents.emit(READY, { version: 1, capabilities: { asyncSpawn: true } });
  assert.deepEqual(await waiting, { version: 1, capabilities: { asyncSpawn: true } });
  assert.equal(readyEvents.listenerCount(READY), 0);

  const timeoutEvents = new FakeEventBus();
  await assert.rejects(waitForSubagentCapabilities(timeoutEvents, 5), /timed out/i);
  assert.equal(timeoutEvents.listenerCount(READY), 0);
});

test('requestPlan emits owned structured delegation and returns its exact successful result', async () => {
  const events = new FakeEventBus();
  const pending = requestPlan({ events, task: 'Plan this change.', cwd: '/repo', timeout: 100 });
  const emission = events.lastEmission(DELEGATION_REQUEST);
  assert.ok(emission);
  const request = emission.data as Record<string, any>;
  assert.match(request.requestId, UUID);
  assert.match(request.ownerRunId, UUID);
  assert.notEqual(request.requestId, request.ownerRunId);
  assert.equal(request.nodeId, 'ultra-plan');
  assert.equal(request.agent, 'ultra-planner');
  assert.equal(request.context, 'fresh');
  assert.equal(request.cwd, '/repo');
  assert.equal(request.result.kind, 'structured');
  assert.equal(request.result.schema.additionalProperties, false);

  events.emit(DELEGATION_RESPONSE, {
    requestId: crypto.randomUUID(),
    ownerRunId: request.ownerRunId,
    nodeId: request.nodeId,
    status: 'completed',
    result: { kind: 'structured', value: { ignored: true } },
  });
  events.emit(DELEGATION_RESPONSE, {
    requestId: request.requestId,
    ownerRunId: request.ownerRunId,
    nodeId: request.nodeId,
    status: 'completed',
    result: { kind: 'structured', value: validPlan() },
  });

  assert.deepEqual(await pending, validPlan());
  assert.equal(events.listenerCount(DELEGATION_RESPONSE), 0);
});

test('requestPlan rejects malformed and failed terminal responses and removes listeners', async () => {
  for (const response of [
    { status: 'completed', result: { kind: 'text', text: '{}' } },
    { status: 'completed', result: { kind: 'structured', value: undefined } },
    { status: 'failed', error: 'planner exploded' },
  ]) {
    const events = new FakeEventBus();
    const pending = requestPlan({ events, task: 'Plan.', cwd: '/repo', timeout: 100 });
    const request = events.lastEmission(DELEGATION_REQUEST)!.data as Record<string, unknown>;
    events.emit(DELEGATION_RESPONSE, {
      requestId: request.requestId,
      ownerRunId: request.ownerRunId,
      nodeId: request.nodeId,
      ...response,
    });
    await assert.rejects(pending, response.status === 'failed' ? /planner exploded/ : /structured/i);
    assert.equal(events.listenerCount(DELEGATION_RESPONSE), 0);
  }
});

test('validatePlan enforces Ultra roles, lane IDs, uniqueness, string bounds, and mode counts', () => {
  assert.deepEqual(validatePlan(validPlan(), { minLanes: 1, maxLanes: 4 }), validPlan());

  const debuggerPlan = validPlan();
  debuggerPlan.lanes[0]!.role = 'debugger' as any;
  assert.throws(() => validatePlan(debuggerPlan, { minLanes: 1, maxLanes: 4 }), /role/i);

  for (const id of ['Bad', 'two_words', '-bad', `a${'b'.repeat(48)}`]) {
    const plan = validPlan();
    plan.lanes[0]!.id = id;
    assert.throws(() => validatePlan(plan, { minLanes: 1, maxLanes: 4 }), /lane id/i);
  }

  const duplicate = validPlan();
  duplicate.lanes[1]!.id = duplicate.lanes[0]!.id;
  assert.throws(() => validatePlan(duplicate, { minLanes: 1, maxLanes: 4 }), /unique/i);

  const tooLong = validPlan();
  tooLong.lanes[0]!.task = 'x'.repeat(16_385);
  assert.throws(() => validatePlan(tooLong, { minLanes: 1, maxLanes: 4 }), /task/i);
});

test('validatePlan accepts only zero-lane no-wave and genuinely over-cap over-cap plans', () => {
  const noWave = { ...validPlan(), mode: 'no-wave', lanes: [] };
  assert.deepEqual(validatePlan(noWave, { minLanes: 1, maxLanes: 2 }), noWave);
  assert.throws(
    () => validatePlan({ ...validPlan(), mode: 'no-wave' }, { minLanes: 1, maxLanes: 2 }),
    /no-wave/i,
  );

  const overCap = {
    ...validPlan(),
    mode: 'over-cap',
    lanes: [
      ...validPlan().lanes,
      { id: 'worker-b', role: 'worker', task: 'Implement B.', write: true },
    ],
  };
  assert.deepEqual(validatePlan(overCap, { minLanes: 1, maxLanes: 2 }), overCap);
  assert.throws(
    () => validatePlan({ ...validPlan(), mode: 'over-cap' }, { minLanes: 1, maxLanes: 2 }),
    /over-cap/i,
  );
  assert.throws(
    () => validatePlan({ ...validPlan(), lanes: [validPlan().lanes[0]!] }, { minLanes: 2, maxLanes: 3 }),
    /between/i,
  );
});

test('buildWaveWorkflow safely quotes input, uses fresh context/output, and isolates writing lanes', () => {
  const hostile = `Do work.\n"}); throw new Error('injected');//`;
  const script = buildWaveWorkflow([
    { id: 'write-lane', role: 'worker', task: hostile, write: true },
    { id: 'read-lane', role: 'reviewer', task: 'Inspect only.', write: false },
  ], 'ultra-worker"}); process.exit();//');

  assert.ok(script.includes(JSON.stringify(hostile).slice(1, -1)));
  assert.ok(script.includes(JSON.stringify('ultra-worker"}); process.exit();//')));
  assert.match(script, /"context":"fresh"/);
  assert.match(script, /"output":true/);
  assert.match(script, /"worktree":true/);
  assert.match(script, /Authority: WRITE/);
  assert.match(script, /Authority: READ-ONLY/);
  assert.equal((script.match(/"worktree":true/g) ?? []).length, 1);
  assert.doesNotThrow(() => new Function('runs', `return (async () => { ${script} })();`));
});

test('preflightLane never forwards automatic as a requested or expected fixed model', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-ultra-preflight-'));
  await mkdir(join(cwd, '.pi', 'agents'), { recursive: true });
  await writeFile(join(cwd, '.pi', 'agents', 'test-lane.md'), `---\nname: test-lane\ndescription: test lane\nmodel: provider/agent-default\ntools: read\n---\nStay bounded.\n`);
  const availableModels = [
    { provider: 'provider', id: 'agent-default', fullId: 'provider/agent-default' },
    { provider: 'provider', id: 'uniform-fixed', fullId: 'provider/uniform-fixed' },
  ];
  try {
    const explicitAutomatic = await preflightLane({
      agent: 'test-lane',
      task: 'Inspect only.',
      cwd,
      availableModels,
      model: 'automatic',
      uniformModel: 'provider/uniform-fixed',
    });
    assert.equal(explicitAutomatic.model, 'provider/agent-default');

    const uniformAutomatic = await preflightLane({
      agent: 'test-lane',
      task: 'Inspect only.',
      cwd,
      availableModels,
      uniformModel: 'automatic',
    });
    assert.equal(uniformAutomatic.model, 'provider/agent-default');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('preflightLane gives an explicit fixed model request precedence but enforces a uniform binding', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-ultra-preflight-'));
  await mkdir(join(cwd, '.pi', 'agents'), { recursive: true });
  await writeFile(join(cwd, '.pi', 'agents', 'test-lane.md'), `---\nname: test-lane\ndescription: test lane\nmodel: inherit\ntools: read\n---\nStay bounded.\n`);
  const availableModels = [
    { provider: 'provider', id: 'explicit', fullId: 'provider/explicit' },
    { provider: 'provider', id: 'uniform', fullId: 'provider/uniform' },
  ];
  try {
    await assert.rejects(
      preflightLane({
        agent: 'test-lane',
        task: 'Inspect only.',
        cwd,
        availableModels,
        model: 'provider/explicit',
        uniformModel: 'provider/uniform',
      }),
      /model mismatch.*provider\/uniform.*provider\/explicit/i,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('spawnWave sends an async fresh workflow RPC and returns only its correlated success', async () => {
  const events = new FakeEventBus();
  const pending = spawnWave(events, 'return await runs.all([]);', '/repo');
  const emission = events.lastEmission(RPC_REQUEST);
  assert.ok(emission);
  const request = emission.data as Record<string, any>;
  assert.match(request.requestId, UUID);
  assert.equal(request.version, 1);
  assert.equal(request.method, 'spawn');
  assert.deepEqual(request.params, {
    workflowScript: 'return await runs.all([]);',
    cwd: '/repo',
    async: true,
    context: 'fresh',
  });

  const replyEvent = `subagents:rpc:v1:reply:${request.requestId}`;
  events.emit(replyEvent, { version: 1, requestId: crypto.randomUUID(), success: true, data: 'wrong' });
  events.emit(replyEvent, { version: 1, requestId: request.requestId, success: true, data: { runId: 'run-1' } });
  assert.deepEqual(await pending, { runId: 'run-1' });
  assert.equal(events.listenerCount(replyEvent), 0);
});

test('spawnWave surfaces RPC failure and unsubscribes', async () => {
  const events = new FakeEventBus();
  const pending = spawnWave(events, 'return 1;', '/repo');
  const request = events.lastEmission(RPC_REQUEST)!.data as Record<string, unknown>;
  const replyEvent = `subagents:rpc:v1:reply:${request.requestId}`;
  events.emit(replyEvent, {
    version: 1,
    requestId: request.requestId,
    success: false,
    error: { code: 'execution_failed', message: 'spawn refused' },
  });
  await assert.rejects(pending, /spawn refused/);
  assert.equal(events.listenerCount(replyEvent), 0);
});
