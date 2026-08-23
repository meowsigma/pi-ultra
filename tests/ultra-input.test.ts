import assert from 'node:assert/strict';
import test from 'node:test';
import type { UltraSettings, LoadUltraSettingsResult } from '../extensions/ultra-config.js';
import {
  createUltraExtension,
  type UltraExtensionDependencies,
  type UltraPolicyRegistration,
} from '../extensions/ultra.js';
import type { UltraDelegateInput, UltraPreparedWave } from '../extensions/ultra-protocol.js';
import { FakePi } from './fixtures/fake-pi.js';

const ENABLED: UltraSettings = {
  version: 1, enabled: true, routingMode: 'uniform', workerModel: 'openai/test-model', minLanes: 2, maxLanes: 4,
};
const DISABLED: UltraSettings = { ...ENABLED, enabled: false };

function delegateInput(): UltraDelegateInput {
  return {
    objective: 'Implement parser.',
    lanes: [
      { id: 'inspect', role: 'scout', task: 'Inspect parser.', deliverable: 'Evidence.' },
      { id: 'worker', role: 'worker', task: 'Implement parser.', deliverable: 'Patch.', ownedPaths: ['src/parser'] },
    ],
    acceptance: ['Run tests.'],
  };
}

function prepared(settings: UltraSettings, revision = 'revision-1'): UltraPreparedWave {
  const lanes = [
    { lane: delegateInput().lanes[0]!, agent: 'ultra-scout', modelCandidates: ['openai/test-model'], requestedModel: 'openai/test-model', launchContractDigest: 'a'.repeat(64) },
    { lane: delegateInput().lanes[1]!, agent: 'ultra-worker', modelCandidates: ['openai/test-model'], requestedModel: 'openai/test-model', launchContractDigest: 'b'.repeat(64) },
  ];
  const script = 'return await runs.all([]);';
  return {
    objective: 'Implement parser.', acceptance: ['Run tests.'], revision, settings, lanes, script,
    params: { workflowScript: script, cwd: '/repo', context: 'fresh', async: true, mission: false },
  };
}

function resultText(result: any): string {
  return result.content?.map((item: any) => item.text ?? '').join('\n') ?? '';
}

function harness(options: {
  loaded?: LoadUltraSettingsResult;
  capabilities?: boolean;
  launchReceipt?: unknown;
  queryResult?: unknown;
} = {}) {
  let loaded: LoadUltraSettingsResult = options.loaded ?? { kind: 'loaded', settings: { ...ENABLED }, revision: 'revision-1', path: '/tmp/pi-ultra.json' };
  const policyInstalls: Array<'blocked' | 'enabled'> = [];
  const policySessions: string[] = [];
  const registrations: UltraPolicyRegistration[] = [];
  const preparedInputs: any[] = [];
  const launches: any[] = [];
  let watcher: (() => void) | undefined;
  let watcherError: ((error: Error) => void) | undefined;
  let menuCalls = 0;
  let uuid = 0;

  const authority = { issueOnce: () => 'permit', revokeUnused() {}, dispose() {} };
  const deps: UltraExtensionDependencies = {
    loadSettings: async () => loaded,
    updateSettings: async (patch) => {
      if (loaded.kind === 'invalid') throw new Error('blocked config');
      const nextPatch = typeof patch === 'function' ? patch(loaded.settings) : patch;
      const settings = { ...loaded.settings, ...nextPatch } as UltraSettings;
      loaded = { kind: 'loaded', settings, revision: `revision-${++uuid + 1}`, path: '/tmp/pi-ultra.json' };
      return loaded;
    },
    backupAndReset: async () => { throw new Error('not used'); },
    showMenu: async () => { menuCalls += 1; return { kind: 'closed', reason: 'close' } as any; },
    checkCapabilities: async () => options.capabilities ?? true,
    installPolicy: async ({ mode, sessionId }) => {
      policyInstalls.push(mode);
      policySessions.push(sessionId);
      const registration: UltraPolicyRegistration = {
        mode,
        operational: mode === 'enabled',
        ...(mode === 'enabled' ? { authority: authority as any, capabilityCeiling: { version: 1, allowedAgents: ['ultra-scout', 'ultra-worker', 'ultra-reviewer'], allowedTools: ['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write', 'contact_supervisor'], denyExtensions: true, sources: ['ultra'] } } : {}),
        dispose() { (registration as any).disposed = true; },
      } as UltraPolicyRegistration & { disposed?: boolean };
      registrations.push(registration);
      return registration;
    },
    watchSettings: (onChange, onError) => { watcher = onChange; watcherError = onError; return () => { watcher = undefined; watcherError = undefined; }; },
    prepareWave: async (value) => { preparedInputs.push(value); return prepared(value.settings, value.revision); },
    launchWave: async (value) => { launches.push(value); return options.launchReceipt ?? { text: 'Async workflow', details: { runId: 'run-1', asyncDir: '/tmp/run-1' } }; },
    queryStatus: async () => options.queryResult,
    randomId: () => `op-${++uuid}`,
  };
  const pi = new FakePi('tui', '/repo');
  pi.availableModels.push({ provider: 'openai', id: 'test-model' });
  pi.context.model = { provider: 'openai', id: 'manager' };
  createUltraExtension(deps)(pi as any);

  return {
    pi, deps, policyInstalls, policySessions, registrations, preparedInputs, launches,
    setLoaded(value: LoadUltraSettingsResult) { loaded = value; },
    async start() { await pi.emit('session_start', { type: 'session_start' }); },
    async change() { await watcher?.(); await new Promise((resolve) => setImmediate(resolve)); },
    async failWatcher(message = 'watch failed') { await watcherError?.(new Error(message)); await new Promise((resolve) => setImmediate(resolve)); },
    get menuCalls() { return menuCalls; },
  };
}

test('registers one command/tool, removes passive input interception, and appends manager policy to the active model', async () => {
  const h = harness();
  await h.start();
  assert.deepEqual([...h.pi.commands.keys()], ['ultra']);
  assert.deepEqual([...h.pi.tools.keys()], ['ultra_delegate']);
  assert.equal(h.pi.handlerCount('input'), 0);
  const turn = await h.pi.inputToAgentStart('Implement the parser.');
  assert.equal(turn.prompt, 'Implement the parser.');
  assert.match(turn.systemPrompt ?? '', /active session model is the Ultra manager/i);
  assert.match(turn.systemPrompt ?? '', /one focused repair/i);
  assert.doesNotMatch(turn.systemPrompt ?? '', /ultra-planner/i);
  assert.deepEqual(h.policyInstalls, ['blocked', 'enabled']);
  assert.deepEqual(h.policySessions, ['/tmp/fake-session.jsonl', '/tmp/fake-session.jsonl']);
});

test('keeps the exact command contract and sends explicit tasks to the active main model', async () => {
  const h = harness();
  await h.start();
  await h.pi.command('ultra', 'Implement the controller.');
  assert.equal(h.pi.userMessages.length, 1);
  assert.match(String(h.pi.userMessages[0]?.content), /Ultra-managed task:\nImplement the controller\./);
  assert.deepEqual(h.pi.userMessages[0]?.options, { deliverAs: 'followUp' });

  const rpc = harness();
  rpc.pi.context.mode = 'rpc';
  await rpc.start();
  await rpc.pi.command('ultra');
  assert.equal(rpc.pi.notifications.at(-1)?.message, '/ultra menu requires TUI mode; use /ultra on, /ultra off, or /ultra toggle.');
  assert.equal(rpc.menuCalls, 0);
});

test('disabled explicit tasks reject exactly and off disposes policy', async () => {
  const h = harness({ loaded: { kind: 'loaded', settings: { ...DISABLED }, revision: 'off', path: '/tmp/pi-ultra.json' } });
  await h.start();
  await h.pi.command('ultra', 'Implement it.');
  assert.equal(h.pi.notifications.at(-1)?.message, 'Run /ultra on first.');
  assert.equal(h.pi.userMessages.length, 0);
  assert.deepEqual(h.policyInstalls, ['blocked']);
  assert.equal((h.registrations[0] as any).disposed, true);
});

test('ultra_delegate prepares one wave, records receipt evidence, and never claims acceptance', async () => {
  const h = harness();
  await h.start();
  const result = await h.pi.tool('ultra_delegate', delegateInput()) as any;
  assert.equal(result.isError, undefined);
  assert.equal(h.preparedInputs.length, 1);
  assert.equal(h.launches.length, 1);
  assert.match(resultText(result), /operation op-1.*run run-1/i);
  assert.doesNotMatch(resultText(result), /accepted|successful/i);
  assert.equal(h.pi.entries.some((entry) => entry.customType === 'ultra.operation.v1'), true);
});

test('direct subagent spawn is blocked while enabled but proven non-spawning management remains available', async () => {
  const h = harness();
  await h.start();
  const [direct] = await h.pi.emit('tool_call', { toolName: 'subagent', input: { agent: 'worker', task: 'bypass' } });
  assert.equal((direct as any).block, true);
  assert.match((direct as any).reason, /ultra_delegate/i);
  const [status] = await h.pi.emit('tool_call', { toolName: 'subagent', input: { action: 'status', id: 'run' } });
  assert.equal((status as any)?.block, undefined);
  const [safeSteer] = await h.pi.emit('tool_call', { toolName: 'subagent', input: { action: 'steer', id: 'run', message: 'x', steeringRecovery: false } });
  assert.equal((safeSteer as any)?.block, undefined);
  const [recoveringSteer] = await h.pi.emit('tool_call', { toolName: 'subagent', input: { action: 'steer', id: 'run', message: 'x' } });
  assert.equal((recoveringSteer as any).block, true);
});

test('invalid or incompatible configuration stays blocked with an empty ceiling and fast tool failure', async () => {
  for (const h of [
    harness({ loaded: { kind: 'invalid', reason: 'bad json', path: '/tmp/pi-ultra.json' } }),
    harness({ capabilities: false }),
  ]) {
    await h.start();
    assert.equal(h.pi.statuses.at(-1)?.value, 'Ultra: blocked');
    const result = await h.pi.tool('ultra_delegate', delegateInput()) as any;
    assert.equal(result.isError, true);
    assert.match(resultText(result), /blocked|incompatible|configuration/i);
    assert.equal(h.launches.length, 0);
    assert.equal(h.policyInstalls.filter((mode) => mode === 'enabled').length, 0);
  }
});

test('completion before or after receipt produces one normal-path duplicate-safe follow-up', async () => {
  const h = harness();
  await h.start();
  h.pi.events.emit('subagent:async-complete', { runId: 'run-1', state: 'complete', results: [
    { workflowKey: 'inspect', agent: 'ultra-scout', model: 'openai/test-model', launchContractDigest: 'a'.repeat(64) },
    { workflowKey: 'worker', agent: 'ultra-worker', model: 'openai/test-model', launchContractDigest: 'b'.repeat(64), changedFiles: ['src/parser/index.ts'] },
  ] });
  await h.pi.tool('ultra_delegate', delegateInput());
  assert.equal(h.pi.messages.length, 1);
  assert.match(h.pi.messages[0]?.message.content ?? '', /operation op-1/i);
  assert.match(h.pi.messages[0]?.message.content ?? '', /evidence only/i);
  assert.deepEqual(h.pi.messages[0]?.options, { triggerTurn: true, deliverAs: 'followUp' });
  h.pi.events.emit('subagent:async-complete', { runId: 'run-1', state: 'complete', results: [] });
  assert.equal(h.pi.messages.length, 1);
});

test('structured result replay finalizes a missed completion after receipt or reload', async () => {
  const h = harness({ queryResult: { runId: 'run-1', state: 'complete', results: [
    { workflowKey: 'inspect', agent: 'ultra-scout', model: 'openai/test-model', launchContractDigest: 'a'.repeat(64), status: 'completed' },
    { workflowKey: 'worker', agent: 'ultra-worker', model: 'openai/test-model', launchContractDigest: 'b'.repeat(64), status: 'completed', outputPath: '/tmp/output.md' },
  ] } });
  await h.start();
  await h.pi.tool('ultra_delegate', delegateInput());
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(h.pi.messages.length, 1);
  assert.match(h.pi.messages[0]?.message.content ?? '', /output\.md/);
  assert.match(h.pi.messages[0]?.message.content ?? '', /expected agent=ultra-worker.*actual agent=ultra-worker/is);
});

test('restores a ready outbox after reload and retries with the same operation id', async () => {
  const first = harness();
  await first.start();
  await first.pi.tool('ultra_delegate', delegateInput());
  first.pi.events.emit('subagent:async-complete', { runId: 'run-1', state: 'failed', results: [] });
  const ready = first.pi.entries.filter((entry) => entry.customType === 'ultra.operation.v1').at(-2);
  assert.ok(ready, 'terminal ready snapshot precedes sent snapshot');

  const second = harness();
  second.pi.entries.push(...first.pi.entries.slice(0, -1));
  await second.start();
  assert.equal(second.pi.messages.length, 1);
  assert.match(second.pi.messages[0]?.message.content ?? '', /operation op-1/i);
});

test('settings watcher applies global off-to-on and invalid transitions in fail-closed order', async () => {
  const h = harness({ loaded: { kind: 'loaded', settings: { ...DISABLED }, revision: 'off', path: '/tmp/pi-ultra.json' } });
  await h.start();
  h.setLoaded({ kind: 'loaded', settings: { ...ENABLED }, revision: 'on', path: '/tmp/pi-ultra.json' });
  await h.change();
  assert.equal(h.pi.statuses.at(-1)?.value, 'Ultra: on');
  h.setLoaded({ kind: 'invalid', reason: 'replaced badly', path: '/tmp/pi-ultra.json' });
  await h.change();
  assert.equal(h.pi.statuses.at(-1)?.value, 'Ultra: blocked');
  assert.equal(h.policyInstalls.at(-1), 'blocked');
});

test('watcher failure remains blocked until a successful watcher change resynchronizes', async () => {
  const h = harness();
  await h.start();
  await h.failWatcher();
  assert.equal(h.pi.statuses.at(-1)?.value, 'Ultra: blocked');
  const blocked = await h.pi.tool('ultra_delegate', delegateInput()) as any;
  assert.equal(blocked.isError, true);
  await h.change();
  assert.equal(h.pi.statuses.at(-1)?.value, 'Ultra: on');
});

test('shutdown fences delayed policy install, preflight, and spawn continuations', async () => {
  const policyHarness = harness();
  let releasePolicy!: () => void;
  const policyPending = new Promise<void>((resolve) => { releasePolicy = resolve; });
  const delayedRegistration: any = { mode: 'blocked', operational: false, disposed: false, dispose() { this.disposed = true; } };
  policyHarness.deps.installPolicy = async () => { await policyPending; return delayedRegistration; };
  const starting = policyHarness.pi.emit('session_start', { type: 'session_start' });
  await new Promise((resolve) => setImmediate(resolve));
  await policyHarness.pi.emit('session_shutdown', { type: 'session_shutdown' });
  releasePolicy();
  await starting;
  assert.equal(delayedRegistration.disposed, true);
  assert.notEqual(policyHarness.pi.statuses.at(-1)?.value, 'Ultra: on');

  const preflightHarness = harness();
  await preflightHarness.start();
  let releasePreflight!: () => void;
  const preflightPending = new Promise<void>((resolve) => { releasePreflight = resolve; });
  preflightHarness.deps.prepareWave = async (value) => { await preflightPending; return prepared(value.settings, value.revision); };
  const preflighting = preflightHarness.pi.tool('ultra_delegate', delegateInput()) as Promise<any>;
  await new Promise((resolve) => setImmediate(resolve));
  await preflightHarness.pi.emit('session_shutdown', { type: 'session_shutdown' });
  releasePreflight();
  const preflightResult = await preflighting;
  assert.equal(preflightResult.isError, true);
  assert.equal(preflightHarness.launches.length, 0);
  assert.equal(preflightHarness.pi.entries.length, 0);

  const spawnHarness = harness();
  await spawnHarness.start();
  spawnHarness.deps.launchWave = async ({ signal }) => new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  const spawning = spawnHarness.pi.tool('ultra_delegate', delegateInput()) as Promise<any>;
  await new Promise((resolve) => setImmediate(resolve));
  await spawnHarness.pi.emit('session_shutdown', { type: 'session_shutdown' });
  const spawnResult = await spawning;
  assert.equal(spawnResult.isError, true);
  assert.equal(spawnHarness.pi.entries.length, 0);
});

test('shutdown disposes policy, watcher, completion listeners, and prevents stale delivery', async () => {
  const h = harness();
  await h.start();
  assert.ok(h.pi.events.listenerCount('subagent:async-complete') > 0);
  await h.pi.emit('session_shutdown', { type: 'session_shutdown' });
  assert.equal(h.pi.events.listenerCount('subagent:async-complete'), 0);
  assert.equal((h.registrations.at(-1) as any).disposed, true);
  h.pi.events.emit('subagent:async-complete', { runId: 'run-1', state: 'complete' });
  assert.equal(h.pi.messages.length, 0);
});
