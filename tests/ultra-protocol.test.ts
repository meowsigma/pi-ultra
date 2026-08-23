import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ROLE_AGENTS,
  buildUltraWorkflow,
  launchUltraWave,
  prepareUltraWave,
  validateUltraDelegateInput,
  type UltraDelegateInput,
  type UltraLaunchAuthorityHandle,
  type UltraPreparedLane,
} from '../extensions/ultra-protocol.js';
import type { UltraSettings } from '../extensions/ultra-config.js';
import { FakeEventBus } from './fixtures/fake-pi.js';

const FIXED: UltraSettings = {
  version: 1,
  enabled: true,
  routingMode: 'uniform',
  workerModel: 'openai/test-model',
  minLanes: 2,
  maxLanes: 4,
};

const ROLE_DEFAULTS: UltraSettings = { ...FIXED, routingMode: 'role-defaults' };
const AUTOMATIC: UltraSettings = { ...FIXED, workerModel: undefined };

function input(lanes: UltraDelegateInput['lanes'] = [
  { id: 'inspect', role: 'scout', task: 'Inspect parser behavior.', deliverable: 'Parser evidence.' },
  { id: 'implement', role: 'worker', task: 'Implement parser change.', deliverable: 'Parser patch.', ownedPaths: ['src/parser'] },
]): UltraDelegateInput {
  return {
    objective: 'Improve the parser safely.',
    lanes,
    acceptance: ['Run parser tests.', 'Review the final diff.'],
  };
}

function prepared(role: keyof typeof ROLE_AGENTS, id = role): UltraPreparedLane {
  return {
    lane: {
      id,
      role,
      task: `${role} task`,
      deliverable: `${role} deliverable`,
      ...(role === 'worker' ? { ownedPaths: [`src/${id}`] } : {}),
    },
    agent: ROLE_AGENTS[role],
    modelCandidates: ['openai/test-model'],
    requestedModel: 'openai/test-model',
    launchContractDigest: id.padEnd(64, 'a').slice(0, 64).replace(/[^a-f0-9]/gu, 'a'),
  };
}

test('validates exact tool schema, hard bounds, role-derived ownership, and repair id', () => {
  const validated = validateUltraDelegateInput(input(), { minLanes: 2, maxLanes: 4 });
  assert.equal(validated.lanes[1]?.ownedPaths?.[0], 'src/parser');
  assert.equal('write' in validated.lanes[1]!, false);

  assert.throws(() => validateUltraDelegateInput({ ...input(), extra: true } as any, { minLanes: 2, maxLanes: 4 }), /unsupported field/i);
  assert.throws(() => validateUltraDelegateInput({ ...input(), lanes: input().lanes.slice(0, 1) }, { minLanes: 2, maxLanes: 4 }), /between 2 and 4/i);
  assert.throws(() => validateUltraDelegateInput({ ...input(), lanes: [...input().lanes, ...input().lanes, ...input().lanes] }, { minLanes: 2, maxLanes: 4 }), /at most|between/i);
  assert.throws(() => validateUltraDelegateInput({ ...input(), repairOf: '../bad' }, { minLanes: 2, maxLanes: 4 }), /repairOf/i);
  assert.throws(() => validateUltraDelegateInput({ ...input(), lanes: [{ ...input().lanes[0]!, write: true }, input().lanes[1]!] } as any, { minLanes: 2, maxLanes: 4 }), /unsupported field/i);
  assert.throws(() => validateUltraDelegateInput({ ...input(), lanes: [{ ...input().lanes[0]!, ownedPaths: ['src'] }, input().lanes[1]!] }, { minLanes: 2, maxLanes: 4 }), /ownedPaths.*worker/i);
  assert.throws(() => validateUltraDelegateInput({ ...input(), lanes: [input().lanes[0]!, { ...input().lanes[1]!, ownedPaths: undefined }] }, { minLanes: 2, maxLanes: 4 }), /ownedPaths/i);
});

test('rejects duplicate semantic padding, unsafe paths, and overlapping worker ownership', () => {
  assert.throws(() => validateUltraDelegateInput(input([
    { id: 'a', role: 'scout', task: 'Inspect   parser.', deliverable: 'Evidence.' },
    { id: 'b', role: 'reviewer', task: 'inspect parser', deliverable: 'Different.' },
  ]), { minLanes: 2, maxLanes: 4 }), /duplicate task/i);
  assert.throws(() => validateUltraDelegateInput(input([
    { id: 'a', role: 'scout', task: 'Inspect A.', deliverable: 'Same evidence.' },
    { id: 'b', role: 'reviewer', task: 'Inspect B.', deliverable: 'same   evidence' },
  ]), { minLanes: 2, maxLanes: 4 }), /duplicate deliverable/i);
  for (const path of ['/etc/passwd', '../escape', 'src/*', 'C:\\escape']) {
    assert.throws(() => validateUltraDelegateInput(input([
      input().lanes[0]!,
      { ...input().lanes[1]!, ownedPaths: [path] },
    ]), { minLanes: 2, maxLanes: 4 }), /owned path/i, path);
  }
  assert.throws(() => validateUltraDelegateInput(input([
    { id: 'a', role: 'worker', task: 'Implement A.', deliverable: 'Patch A.', ownedPaths: ['src/parser'] },
    { id: 'b', role: 'worker', task: 'Implement B.', deliverable: 'Patch B.', ownedPaths: ['src/parser/tests'] },
  ]), { minLanes: 2, maxLanes: 4 }), /overlap/i);
});

test('builds one strict static runs.all workflow preserving roles and worker-only isolation', () => {
  const lanes = [prepared('scout'), prepared('worker'), prepared('reviewer')];
  const script = buildUltraWorkflow(lanes);
  assert.ok(script.startsWith('return await runs.all('));
  const items = JSON.parse(script.slice('return await runs.all('.length, -2));
  assert.deepEqual(items.map((item: any) => item.agent), ['ultra-scout', 'ultra-worker', 'ultra-reviewer']);
  assert.deepEqual(items.map((item: any) => item.model), ['openai/test-model', 'openai/test-model', 'openai/test-model']);
  assert.deepEqual(items.map((item: any) => item.worktree), [undefined, true, undefined]);
  assert.ok(items[0].task.includes('READ-ONLY'));
  assert.ok(items[1].task.includes('Owned paths: src/worker'));
  assert.equal(items.every((item: any) => item.context === 'fresh' && item.output === true), true);
});

test('preflights fixed uniform, automatic, and role-default model contracts exactly', async () => {
  const calls: any[] = [];
  const preflight = async (value: any) => {
    calls.push(value);
    const requested = value.model as string | undefined;
    const automatic = requested ?? 'openai/auto-model';
    return {
      ok: true as const,
      contract: {
        version: 2,
        agent: { name: value.agent },
        context: 'fresh' as const,
        model: automatic,
        modelCandidates: [automatic],
        tools: {
          effectiveAllowlist: value.agent === 'ultra-worker'
            ? ['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write', 'contact_supervisor']
            : ['read', 'grep', 'find', 'ls'],
          runtimeExtensions: [], configuredExtensions: [], disableAmbientExtensions: true,
        },
        launchContractDigest: `${calls.length}`.repeat(64).slice(0, 64),
      },
    } as any;
  };
  const common = {
    input: input(), cwd: '/repo', sessionId: 'session', revision: 'revision',
    availableModels: [{ provider: 'openai', id: 'test-model' }],
    parentModel: { provider: 'openai', id: 'manager' },
    resolveContract: preflight,
    capabilityCeiling: { version: 1 as const, allowedAgents: Object.values(ROLE_AGENTS), allowedTools: ['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write', 'contact_supervisor'], denyExtensions: true, sources: ['ultra'] },
  };

  const fixed = await prepareUltraWave({ ...common, settings: FIXED });
  assert.deepEqual(fixed.lanes.map((lane) => lane.agent), ['ultra-scout', 'ultra-worker']);
  assert.deepEqual(fixed.lanes.map((lane) => lane.modelCandidates), [['openai/test-model'], ['openai/test-model']]);
  assert.equal(calls.every((call) => call.model === 'openai/test-model'), true);

  calls.length = 0;
  const automatic = await prepareUltraWave({ ...common, settings: AUTOMATIC });
  assert.deepEqual(automatic.lanes.map((lane) => lane.requestedModel), ['openai/auto-model', 'openai/auto-model']);
  assert.equal(calls[0]?.agent, 'ultra-worker', 'automatic seed uses strict worker');
  assert.equal(calls.slice(1).every((call) => call.model === 'openai/auto-model'), true);

  calls.length = 0;
  const defaults = await prepareUltraWave({ ...common, settings: ROLE_DEFAULTS });
  assert.equal(defaults.lanes.every((lane) => lane.requestedModel === undefined), true);
  assert.equal(calls.every((call) => call.model === undefined), true);
});

test('fails complete preflight for fallback uniform models or role authority drift', async () => {
  const common = {
    input: input(), settings: FIXED, cwd: '/repo', sessionId: 'session', revision: 'revision',
    availableModels: [{ provider: 'openai', id: 'test-model' }], parentModel: { provider: 'openai', id: 'manager' },
    capabilityCeiling: undefined,
  };
  await assert.rejects(() => prepareUltraWave({
    ...common,
    resolveContract: async (value: any) => ({ ok: true, contract: {
      agent: { name: value.agent }, context: 'fresh', model: value.model,
      modelCandidates: [value.model, 'openai/fallback'],
      tools: { effectiveAllowlist: value.agent === 'ultra-worker' ? ['read', 'bash', 'edit', 'write'] : ['read'], runtimeExtensions: [], configuredExtensions: [], disableAmbientExtensions: true },
      launchContractDigest: 'a'.repeat(64),
    } } as any),
  }), /sole candidate|uniform/i);
  await assert.rejects(() => prepareUltraWave({
    ...common,
    resolveContract: async (value: any) => ({ ok: true, contract: {
      agent: { name: value.agent }, context: 'fresh', model: value.model,
      modelCandidates: [value.model],
      tools: { effectiveAllowlist: ['read', 'write'], runtimeExtensions: [], configuredExtensions: [], disableAmbientExtensions: true },
      launchContractDigest: 'a'.repeat(64),
    } } as any),
  }), /read-only|mutation/i);
});

test('issues one permit after preflight and sends it only as RPC authorization metadata', async () => {
  const events = new FakeEventBus();
  const issued: any[] = [];
  const authority = {
    issueOnce(value: any) { issued.push(value); return 'opaque-permit'; },
    revokeUnused() {}, dispose() {},
  } satisfies UltraLaunchAuthorityHandle;
  const lanes = [prepared('scout'), prepared('worker')];
  const script = buildUltraWorkflow(lanes);
  const preparedWave = {
    objective: 'Objective', acceptance: ['Test'], revision: 'revision', settings: FIXED,
    lanes, script,
    params: { workflowScript: script, cwd: '/repo', context: 'fresh' as const, async: true as const, mission: false as const },
  };
  const pending = launchUltraWave({ events, authority, prepared: preparedWave, timeoutMs: 100 });
  await new Promise((resolve) => setImmediate(resolve));
  const request = events.lastEmission('subagents:rpc:v1:request')?.data as any;
  assert.equal(request.method, 'spawn');
  assert.deepEqual(request.authorization, { launchPermits: ['opaque-permit'] });
  assert.equal(JSON.stringify(request.params).includes('opaque-permit'), false);
  assert.equal(issued.length, 1);
  assert.equal(issued[0].requestDigest.length, 64);
  assert.deepEqual(issued[0].lanes.map((lane: any) => lane.key), ['scout', 'worker']);
  events.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
    version: 1, requestId: request.requestId, method: 'spawn', success: true,
    data: { text: 'Async workflow', details: { runId: 'run-1', asyncDir: '/tmp/run-1' } },
  });
  assert.deepEqual(await pending, { text: 'Async workflow', details: { runId: 'run-1', asyncDir: '/tmp/run-1' } });
});
