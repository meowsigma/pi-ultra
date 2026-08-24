import assert from 'node:assert/strict';
import test from 'node:test';
import { UltraSettingsCleanupError, effectiveUniformModel } from '../extensions/ultra-config.js';
import type { UltraSettings, LoadUltraSettingsResult } from '../extensions/ultra-config.js';
import {
  createUltraExtension,
  type UltraExtensionDependencies,
  type UltraPolicyRegistration,
} from '../extensions/ultra.js';
import type { UltraDelegateInput, UltraPreparedWave } from '../extensions/ultra-protocol.js';
import { validateUltraDelegateInput } from '../extensions/ultra-protocol.js';
import { buildSettingsScreen } from '../extensions/ultra-menu.js';
import { appendSessionUltraOverrides, CommittedSessionUpdateError } from '../extensions/ultra-session-settings.js';
import { FakePi, type FakePiOptions } from './fixtures/fake-pi.js';

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

/** showMenu dependency options, so tests can capture menu callbacks directly. */
type ShowMenuOptions = Parameters<UltraExtensionDependencies['showMenu']>[0];

function harness(options: {
  loaded?: LoadUltraSettingsResult;
  capabilities?: boolean;
  launchReceipt?: unknown;
  queryResult?: unknown;
  writerAdmission?: { admitted: boolean; checkedGit: boolean; reason: any; diagnostics: readonly string[] };
  /** Shared global-settings box so multiple sessions observe the same file. */
  globals?: { current: LoadUltraSettingsResult };
  /** Distinct FakePi session identity and seeded branch entries. */
  session?: FakePiOptions;
} = {}) {
  const state = options.globals ?? { current: options.loaded ?? { kind: 'loaded', settings: { ...ENABLED }, revision: 'revision-1', path: '/tmp/pi-ultra.json' } as LoadUltraSettingsResult };
  const policyInstalls: Array<'blocked' | 'enabled'> = [];
  const policySessions: string[] = [];
  const revisionValidators: Array<(revision: string, signal: AbortSignal) => Promise<boolean>> = [];
  const registrations: UltraPolicyRegistration[] = [];
  const preparedInputs: any[] = [];
  const launches: any[] = [];
  let watcher: (() => void) | undefined;
  let watcherError: ((error: Error) => void) | undefined;
  let menuCalls = 0;
  let uuid = 0;
  const authority = { issueOnce: () => 'permit', revokeUnused() {}, dispose() {} };
  const deps: UltraExtensionDependencies = {
    loadSettings: async () => state.current,
    updateSettings: async (patch) => {
      if (state.current.kind === 'invalid') throw new Error('blocked config');
      const nextPatch = typeof patch === 'function' ? patch(state.current.settings) : patch;
      const settings = { ...state.current.settings, ...nextPatch } as UltraSettings;
      state.current = { kind: 'loaded', settings, revision: `revision-${++uuid + 1}`, path: '/tmp/pi-ultra.json' };
      return state.current;
    },
    backupAndReset: async () => { throw new Error('not used'); },
    showMenu: async () => { menuCalls += 1; return { kind: 'closed', reason: 'close' } as any; },
    checkCapabilities: async () => options.capabilities ?? true,
    installPolicy: async ({ mode, sessionId, validateRevision }) => {
      policyInstalls.push(mode);
      policySessions.push(sessionId);
      if (mode === 'enabled') revisionValidators.push(validateRevision);
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
    prepareWave: async (value) => {
      // Validate against the session-effective bounds exactly like the real preflight.
      const validated = validateUltraDelegateInput(value.input, { minLanes: value.settings.minLanes, maxLanes: value.settings.maxLanes });
      preparedInputs.push({ ...value, input: validated });
      return prepared(value.settings, value.revision);
    },
    launchWave: async (value) => { launches.push(value); return options.launchReceipt ?? { text: 'Async workflow', details: { runId: 'run-1', asyncDir: '/tmp/run-1' } }; },
    queryStatus: async () => options.queryResult,
    admitWriterWave: async () => options.writerAdmission ?? ({ admitted: true, checkedGit: true, reason: 'admitted', diagnostics: [] }),
    randomId: () => `op-${++uuid}`,
  };
  const pi = new FakePi('tui', '/repo', options.session);
  pi.availableModels.push({ provider: 'openai', id: 'test-model' }, { provider: 'openai', id: 'session-model' });
  pi.context.model = { provider: 'openai', id: 'manager' };
  createUltraExtension(deps)(pi as any);

  return {
    pi, deps, policyInstalls, policySessions, registrations, preparedInputs, launches, revisionValidators,
    setLoaded(value: LoadUltraSettingsResult) { state.current = value; },
    async start() { await pi.emit('session_start', { type: 'session_start' }); },
    async change() { await watcher?.(); await new Promise((resolve) => setImmediate(resolve)); },
    async failWatcher(message = 'watch failed') { await watcherError?.(new Error(message)); await new Promise((resolve) => setImmediate(resolve)); },
    get watcherActive() { return watcher !== undefined; },
    get menuCalls() { return menuCalls; },
  };
}

test('registers one command/tool, removes passive input interception, and appends manager policy to the active model', async () => {
  const h = harness();
  await h.start();
  assert.deepEqual([...h.pi.commands.keys()], ['ultra']);
  assert.deepEqual([...h.pi.tools.keys()], ['ultra_begin_scope', 'ultra_takeover', 'ultra_delegate']);
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

test('ultra_delegate closes an RPC startup race by synchronizing before session_start completes', async () => {
  const h = harness();
  const result = await h.pi.tool('ultra_delegate', delegateInput()) as any;
  assert.equal(result.isError, undefined);
  assert.deepEqual(h.policyInstalls, ['blocked', 'enabled']);
  assert.equal(h.launches.length, 1);
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
  const operationEntries = h.pi.entries.filter((entry) => entry.customType === 'ultra.operation.v1');
  assert.deepEqual(operationEntries.map((entry: any) => entry.data.kind ?? 'operation'), ['launch-attempt', 'launch-attempt', 'launch-attempt', 'operation']);
  assert.deepEqual(operationEntries.slice(0, 3).map((entry: any) => entry.data.state), ['queued', 'admitted', 'launched']);
});

test('writer admission denies before preflight or permit spending and keeps read-only authority intact', async () => {
  const h = harness({ writerAdmission: { admitted: false, checkedGit: true, reason: 'dirty-worktree', diagnostics: ['Repository has uncommitted changes.'] } });
  await h.start();
  const result = await h.pi.tool('ultra_delegate', delegateInput()) as any;
  assert.equal(result.isError, true);
  assert.match(resultText(result), /writer admission denied.*dirty-worktree/i);
  assert.equal(h.preparedInputs.length, 0);
  assert.equal(h.launches.length, 0);
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

test('coexists with a Goal-X-like peer lifecycle extension without bypassing Ultra authority', async () => {
  const h = harness();
  const peerToolCalls: string[] = [];
  h.pi.on('before_agent_start', (event: any) => ({ systemPrompt: `${event.systemPrompt}\n\n[PI GOAL peer policy]` }));
  h.pi.on('tool_call', (event: any) => { peerToolCalls.push(event.toolName); });
  await h.start();

  const turn = await h.pi.inputToAgentStart('Complete the tracked task.');
  assert.match(turn.systemPrompt ?? '', /Ultra manager/i);
  assert.match(turn.systemPrompt ?? '', /PI GOAL peer policy/);

  const [direct] = await h.pi.emit('tool_call', { toolName: 'subagent', input: { agent: 'worker', task: 'bypass' } });
  assert.equal((direct as any).block, true);
  assert.deepEqual(peerToolCalls, ['subagent']);

  await h.pi.tool('ultra_delegate', delegateInput());
  assert.deepEqual(peerToolCalls, ['subagent']);
  assert.equal(h.launches.length, 1);
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
  assert.equal(h.pi.statuses.at(-1)?.value, 'Ultra: collaborator');
  h.setLoaded({ kind: 'invalid', reason: 'replaced badly', path: '/tmp/pi-ultra.json' });
  await h.change();
  assert.equal(h.pi.statuses.at(-1)?.value, 'Ultra: blocked');
  assert.equal(h.policyInstalls.at(-1), 'blocked');
});

test('blocked synchronize denies ultra_delegate launches until a successful resync restores delegation', async () => {
  const h = harness();
  await h.start();
  assert.equal(h.pi.statuses.at(-1)?.value, 'Ultra: collaborator');

  // Persistent installPolicy failure after a previous enabled policy exists:
  // synchronize reports blocked but retains the stale enabled registration,
  // so the tool gate alone must not decide launch authority.
  const realInstall = h.deps.installPolicy.bind(h.deps);
  h.deps.installPolicy = async () => { throw new Error('authority service down'); };
  await h.change();
  assert.equal(h.pi.statuses.at(-1)?.value, 'Ultra: blocked');
  const staleEnabled = h.registrations.filter((registration) => registration.mode === 'enabled').at(-1);
  assert.equal(staleEnabled?.operational, true, 'precondition: stale enabled registration retains operational authority');

  const blocked = await h.pi.tool('ultra_delegate', delegateInput()) as any;
  assert.equal(blocked.isError, true);
  assert.match(resultText(blocked), /blocked/i);
  assert.equal(h.preparedInputs.length, 0, 'no preflight while policy is blocked');
  assert.equal(h.launches.length, 0, 'no launch while policy is blocked');

  // A subsequent successful watcher resync restores normal authorized delegation.
  h.deps.installPolicy = realInstall;
  await h.change();
  assert.equal(h.pi.statuses.at(-1)?.value, 'Ultra: collaborator');
  const delegated = await h.pi.tool('ultra_delegate', delegateInput()) as any;
  assert.equal(delegated.isError, undefined);
  assert.equal(h.preparedInputs.length, 1);
  assert.equal(h.launches.length, 1);
});

test('watcher failure remains blocked until a successful watcher change resynchronizes', async () => {
  const h = harness();
  await h.start();
  await h.failWatcher();
  assert.equal(h.pi.statuses.at(-1)?.value, 'Ultra: blocked');
  const blocked = await h.pi.tool('ultra_delegate', delegateInput()) as any;
  assert.equal(blocked.isError, true);
  await h.change();
  assert.equal(h.pi.statuses.at(-1)?.value, 'Ultra: collaborator');
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
  assert.equal(policyHarness.watcherActive, false);
  assert.notEqual(policyHarness.pi.statuses.at(-1)?.value, 'Ultra: collaborator');

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
  // Shutdown after durable admission retains the ambiguous attempt rather than
  // erasing it and risking a blind relaunch after restore.
  assert.deepEqual(spawnHarness.pi.entries.map((entry: any) => entry.data.state), ['queued', 'admitted']);
});

test('shutdown fences a reconciliation reply resolved immediately before shutdown', async () => {
  const h = harness();
  let release!: (value: unknown) => void;
  let queryStarted!: () => void;
  const started = new Promise<void>((resolve) => { queryStarted = resolve; });
  h.deps.queryStatus = async () => {
    queryStarted();
    return new Promise((resolve) => { release = resolve; });
  };
  await h.start();
  await h.pi.tool('ultra_delegate', delegateInput());
  await new Promise((resolve) => setTimeout(resolve, 5));
  await started;
  release({ runId: 'run-1', state: 'complete', results: [] });
  await h.pi.emit('session_shutdown', { type: 'session_shutdown' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.pi.messages.length, 0);
  assert.equal(h.pi.entries.filter((entry) => (entry.data as any)?.status === 'completed').length, 0);
});

test('committed cleanup errors still resynchronize menu recovery; menu updates stay session-local', async () => {
  const direct = harness();
  await direct.start();
  direct.deps.updateSettings = async () => { throw new Error('global writes must not happen from slash commands'); };
  await direct.pi.command('ultra', 'off');
  assert.equal(direct.pi.statuses.at(-1)?.value, 'Ultra: off');
  assert.equal(direct.pi.entries.some((entry) => entry.customType === 'pi-ultra-session-settings'), true);

  const off = { kind: 'loaded' as const, settings: { ...DISABLED }, revision: 'off-cleanup', path: '/tmp/pi-ultra.json' };

  // Invoke the captured update callback directly; asserting through the /ultra
  // command handler would swallow errors via its catch-and-notify wrapper.
  const menu = harness();
  await menu.start();
  menu.deps.updateSettings = async () => {
    menu.setLoaded(off);
    throw new UltraSettingsCleanupError('committed cleanup warning', off);
  };
  let menuUpdate!: ShowMenuOptions['updateSession'];
  menu.deps.showMenu = async (options) => { menuUpdate = options.updateSession; return {}; };
  await menu.pi.command('ultra');
  const disabled = await menuUpdate({ enabled: false });
  assert.equal(disabled.kind, 'loaded');
  assert.equal(disabled.settings.enabled, false);
  assert.match(disabled.revision, /^[a-f0-9]{64}$/u);
  assert.equal(menu.pi.statuses.at(-1)?.value, 'Ultra: off');

  // Recovery cleanup errors keep their exact shape and still resynchronize.
  const recovery = harness({ loaded: { kind: 'invalid', reason: 'bad', path: '/tmp/pi-ultra.json' } });
  await recovery.start();
  recovery.deps.backupAndReset = async () => {
    recovery.setLoaded(off);
    throw new UltraSettingsCleanupError('recovery cleanup warning', off, { backupPath: '/tmp/backup.bak' });
  };
  let menuRecover!: ShowMenuOptions['recover'];
  recovery.deps.showMenu = async (options) => { menuRecover = options.recover; return {}; };
  await recovery.pi.command('ultra');
  await assert.rejects(() => menuRecover(), (error: unknown) =>
    error instanceof UltraSettingsCleanupError &&
    error.message === 'recovery cleanup warning' &&
    error.backupPath === '/tmp/backup.bak' &&
    error.committed === off);
  assert.equal(recovery.pi.statuses.at(-1)?.value, 'Ultra: off');
});

test('menu disable resolves a bound off result without touching globals and rejects on invalid globals', async () => {
  const h = harness();
  await h.start();
  let update!: ShowMenuOptions['updateSession'];
  let hasOverridesAtOpen: boolean | undefined;
  h.deps.showMenu = async (options) => { update = options.updateSession; hasOverridesAtOpen = options.hasSessionOverrides; return {}; };
  await h.pi.command('ultra');
  assert.equal(hasOverridesAtOpen, false, 'fresh session reports no overrides on the main screen');

  const disabled = await update({ enabled: false });
  assert.equal(disabled.kind, 'loaded');
  assert.deepEqual(disabled.settings, { ...ENABLED, enabled: false, orchestrationMode: 'collaborator' }, 'absent fields inherit global defaults');
  assert.match(disabled.revision, /^[a-f0-9]{64}$/u, 'revision binds global revision and session patch digest');
  assert.equal(disabled.path, '/tmp/pi-ultra.json');
  assert.equal(h.pi.statuses.at(-1)?.value, 'Ultra: off');
  const snapshots = h.pi.entries.filter((entry) => entry.customType === SESSION_OVERRIDE_TYPE);
  assert.equal(snapshots.length, 1);
  assert.deepEqual((snapshots[0]?.data as any).patch, { enabled: false });

  h.setLoaded({ kind: 'invalid', reason: 'rewritten badly', path: '/tmp/pi-ultra.json' });
  await assert.rejects(() => update({ enabled: true }), /rewritten badly/);
  assert.equal(h.pi.statuses.at(-1)?.value, 'Ultra: blocked');
});

test('post-append resync failure rejects as a committed session update and keeps truthful provenance', async () => {
  const h = harness();
  await h.start();
  let update!: ShowMenuOptions['updateSession'];
  let opts!: ShowMenuOptions;
  h.deps.showMenu = async (options) => { opts = options; update = options.updateSession; return {}; };
  await h.pi.command('ultra');

  const globalWrites: unknown[] = [];
  const innerUpdateSettings = h.deps.updateSettings;
  h.deps.updateSettings = async (patch) => { globalWrites.push(patch); return innerUpdateSettings(patch); };
  const innerLoad = h.deps.loadSettings;
  h.deps.loadSettings = async () => { throw new Error('load exploded'); };

  await assert.rejects(() => update({ enabled: false }), (error: unknown) =>
    error instanceof CommittedSessionUpdateError &&
    error.committed === true &&
    error.cause instanceof Error &&
    /load exploded/.test(error.cause.message), 'a durable append followed by a failed resync must surface as a committed outcome');

  // Enforcement stays fail-closed after the failed post-commit refresh.
  assert.equal(h.pi.statuses.at(-1)?.value, 'Ultra: blocked');
  // The snapshot durably committed exactly once and the global file was never written.
  const snapshots = h.pi.entries.filter((entry) => entry.customType === SESSION_OVERRIDE_TYPE);
  assert.equal(snapshots.length, 1);
  assert.deepEqual((snapshots[0]?.data as any).patch, { enabled: false });
  assert.deepEqual(globalWrites, []);

  // Provenance is truthful on reopen: an override snapshot exists.
  h.deps.loadSettings = innerLoad;
  await h.pi.command('ultra');
  assert.equal(opts.hasSessionOverrides, true);
});

test('reset that clears but fails post-clear resync rejects as a committed outcome and provenance becomes None', async () => {
  const h = harness();
  await h.start();
  await applySessionPatch(h, { minLanes: 4, maxLanes: 8 });

  let opts!: ShowMenuOptions;
  h.deps.showMenu = async (options) => { opts = options; return {}; };
  await h.pi.command('ultra');
  assert.equal(opts.hasSessionOverrides, true);

  const innerLoad = h.deps.loadSettings;
  h.deps.loadSettings = async () => { throw new Error('load exploded'); };

  await assert.rejects(() => opts.resetSession(), (error: unknown) =>
    error instanceof CommittedSessionUpdateError && error.committed === true,
  'a durable clear followed by a failed resync must surface as a committed outcome');

  assert.equal(h.pi.statuses.at(-1)?.value, 'Ultra: blocked');
  const snapshots = h.pi.entries.filter((entry) => entry.customType === SESSION_OVERRIDE_TYPE);
  assert.deepEqual((snapshots.at(-1)?.data as any).patch, {}, 'the explicit empty clear snapshot committed');

  h.deps.loadSettings = innerLoad;
  // The reopened menu captures fresh options; provenance must truthfully report the committed clear.
  await h.pi.command('ultra');
  assert.equal(opts.hasSessionOverrides, false);
});

test('pre-append validation failure stays an ordinary rejection and appends nothing', async () => {
  const h = harness();
  await h.start();
  let update!: ShowMenuOptions['updateSession'];
  h.deps.showMenu = async (options) => { update = options.updateSession; return {}; };
  await h.pi.command('ultra');

  await assert.rejects(() => update({ workerModel: 'missing-provider-separator' }), (error: unknown) =>
    !(error instanceof CommittedSessionUpdateError));
  assert.equal(h.pi.entries.some((entry) => entry.customType === SESSION_OVERRIDE_TYPE), false, 'nothing was durably appended before validation failed');
  assert.equal(h.pi.statuses.at(-1)?.value, 'Ultra: collaborator', 'failed-before-append updates do not disturb effective enforcement');
});

test('menu Automatic maps an explicit clear to workerModel null and restores across a new FakePi branch', async () => {
  const first = harness({ session: { sessionId: 'auto-model', sessionFile: '/tmp/auto-model.jsonl' } });
  await first.start();
  // A selected session model must first be overridable by Automatic.
  await applySessionPatch(first, { routingMode: 'uniform', workerModel: 'openai/session-model' });
  let update!: ShowMenuOptions['updateSession'];
  first.deps.showMenu = async (options) => { update = options.updateSession; return {}; };
  await first.pi.command('ultra');

  const automatic = await update({ workerModel: undefined });
  assert.equal(automatic.kind, 'loaded');
  assert.equal('workerModel' in automatic.settings, false, 'Automatic removes the effective worker model');
  assert.equal(automatic.settings.routingMode, 'uniform');
  assert.equal(effectiveUniformModel(automatic.settings), 'automatic');
  assert.equal(first.pi.statuses.at(-1)?.value, 'Ultra: collaborator');
  let snapshots = first.pi.entries.filter((entry) => entry.customType === SESSION_OVERRIDE_TYPE);
  assert.deepEqual((snapshots.at(-1)?.data as any).patch, { routingMode: 'uniform', workerModel: null });

  // Blank models are also explicit Automatic intent.
  const blank = await update({ workerModel: '   ' });
  assert.equal('workerModel' in blank.settings, false);
  snapshots = first.pi.entries.filter((entry) => entry.customType === SESSION_OVERRIDE_TYPE);
  assert.deepEqual((snapshots.at(-1)?.data as any).patch, { routingMode: 'uniform', workerModel: null });

  const second = harness({
    session: { sessionId: 'auto-model', sessionFile: '/tmp/auto-model.jsonl', branch: [...first.pi.entries] },
  });
  await second.start();
  assert.equal(second.pi.statuses.at(-1)?.value, 'Ultra: collaborator');
  const delegated = await second.pi.tool('ultra_delegate', delegateInput()) as any;
  assert.equal(delegated.isError, undefined);
  assert.equal('workerModel' in second.preparedInputs[0]!.settings, false, 'restored branch keeps explicit Automatic');
  assert.equal(second.preparedInputs[0]!.settings.routingMode, 'uniform');
});

test('menu global updater writes pi-ultra.json transactionally while reset only appends an empty snapshot', async () => {
  const h = harness();
  await h.start();
  await applySessionPatch(h, { minLanes: 4, maxLanes: 8 });

  let opts!: ShowMenuOptions;
  h.deps.showMenu = async (options) => { opts = options; return {}; };
  await h.pi.command('ultra');
  assert.equal(opts.hasSessionOverrides, true);

  const globalWrites: unknown[] = [];
  const innerUpdateSettings = h.deps.updateSettings;
  h.deps.updateSettings = async (patch) => {
    globalWrites.push(patch);
    return innerUpdateSettings(patch);
  };

  const committed = await opts.updateGlobal({ enabled: false });
  assert.equal(committed.kind, 'loaded');
  assert.deepEqual(globalWrites, [{ enabled: false }], 'only the explicit global updater writes the global file');
  assert.equal(committed.settings.enabled, false);
  assert.equal(h.pi.statuses.at(-1)?.value, 'Ultra: off', 'active session resynchronizes after the global write');

  // The session updater keeps writing only local snapshots.
  await opts.updateSession({ enabled: true });
  assert.deepEqual(globalWrites, [{ enabled: false }]);
  assert.equal(h.pi.statuses.at(-1)?.value, 'Ultra: collaborator');

  // Reset appends exactly one empty snapshot and returns effective global defaults.
  const before = h.pi.entries.filter((entry) => entry.customType === SESSION_OVERRIDE_TYPE).length;
  const reset = await opts.resetSession();
  assert.equal(reset.kind, 'loaded');
  assert.deepEqual(
    reset.settings,
    { version: 1, enabled: false, routingMode: 'uniform', orchestrationMode: 'collaborator', workerModel: 'openai/test-model', minLanes: 2, maxLanes: 4 },
    'reset reports the effective global defaults, not the prior session patch',
  );
  const snapshots = h.pi.entries.filter((entry) => entry.customType === SESSION_OVERRIDE_TYPE);
  assert.equal(snapshots.length, before + 1);
  assert.deepEqual((snapshots.at(-1)?.data as any).patch, {}, 'reset appends one explicit empty snapshot');
  assert.deepEqual(globalWrites, [{ enabled: false }], 'reset never writes the global file');
  assert.equal(h.pi.statuses.at(-1)?.value, 'Ultra: off');

  let reopened!: ShowMenuOptions;
  h.deps.showMenu = async (options) => { reopened = options; return {}; };
  await h.pi.command('ultra');
  assert.equal(reopened.hasSessionOverrides, false, 'a cleared session reports no overrides');
});

test('menu global updater returns session-effective state so post-edit screens show overrides, not raw globals', async () => {
  const h = harness();
  await h.start();
  await applySessionPatch(h, { workerModel: 'openai/session-model' });

  let opts!: ShowMenuOptions;
  h.deps.showMenu = async (options) => { opts = options; return {}; };
  await h.pi.command('ultra');
  assert.equal(opts.hasSessionOverrides, true);

  const globalWrites: unknown[] = [];
  const innerUpdateSettings = h.deps.updateSettings;
  h.deps.updateSettings = async (patch) => {
    globalWrites.push(patch);
    return innerUpdateSettings(patch);
  };

  // Global-scope edit of a non-model field while a session workerModel override is active.
  const refreshed = await opts.updateGlobal({ minLanes: 3 });
  assert.equal(refreshed.kind, 'loaded');
  assert.deepEqual(globalWrites, [{ minLanes: 3 }], 'the global file is transactionally updated exactly once');
  assert.equal(refreshed.settings.minLanes, 3, 'the committed global edit is reflected in the returned state');
  assert.equal(refreshed.settings.workerModel, 'openai/session-model', 'returned state overlays the session override instead of raw globals');
  assert.match(refreshed.revision, /^[a-f0-9]{64}$/u, 'revision binds the refreshed global revision with the stable session patch digest');
  assert.equal(refreshed.path, '/tmp/pi-ultra.json');

  // The menu commits this exact updater result into its displayed state, so
  // rendering it as session-scoped state must show effective values after
  // the global edit — not the raw pi-ultra.json globals.
  const screen = buildSettingsScreen(refreshed.settings, [], 'session');
  assert.equal(screen.title, 'Ultra Settings — This session');
  assert.equal(screen.items.find((item) => item.id === 'worker-model')?.currentValue, 'openai/session-model', 'menu displays the session model after a global edit');
  assert.equal(screen.items.find((item) => item.id === 'lane-range')?.currentValue.includes('3'), true, 'menu displays the freshly edited global lane range');
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

const SESSION_OVERRIDE_TYPE = 'pi-ultra-session-settings';
const SESSION_DIAGNOSTIC_TYPE = 'pi-ultra-session-settings-diagnostic';

function twoSharedSessions() {
  const globals = { current: { kind: 'loaded' as const, settings: { ...ENABLED }, revision: 'revision-shared', path: '/tmp/pi-ultra.json' } };
  const one = harness({ globals, session: { sessionId: 'session-one', sessionFile: '/tmp/session-one.jsonl' } });
  const two = harness({ globals, session: { sessionId: 'session-two', sessionFile: '/tmp/session-two.jsonl' } });
  return { globals, one, two };
}

async function applySessionPatch(h: ReturnType<typeof harness>, patch: Parameters<typeof appendSessionUltraOverrides>[1]): Promise<void> {
  appendSessionUltraOverrides((customType, data) => h.pi.appendEntry(customType, data), patch);
  await h.change();
}

function laneInput(laneCount: number): UltraDelegateInput {
  const roles = ['scout', 'worker', 'reviewer'] as const;
  return {
    objective: 'Implement parser.',
    lanes: Array.from({ length: laneCount }, (_unused, index) => ({
      id: `lane-${index}`,
      role: roles[index % roles.length]!,
      task: `Task ${index} for parser.`,
      deliverable: `Deliverable ${index}.`,
      ...(roles[index % roles.length] === 'worker' ? { ownedPaths: [`src/module-${index}`] } : {}),
    })),
    acceptance: ['Run tests.'],
  };
}

test('two fake sessions sharing global defaults diverge in enabled, model, and lane range', async () => {
  const { globals, one, two } = twoSharedSessions();
  await one.start();
  await two.start();

  // Session one patches every overridable field; session two stays on global defaults.
  await applySessionPatch(one, { enabled: false, workerModel: 'openai/session-model', minLanes: 4, maxLanes: 8 });

  assert.equal(one.pi.statuses.at(-1)?.value, 'Ultra: off');
  assert.equal(two.pi.statuses.at(-1)?.value, 'Ultra: collaborator');

  const blocked = await one.pi.tool('ultra_delegate', laneInput(4)) as any;
  assert.equal(blocked.isError, true);
  assert.match(resultText(blocked), /Run \/ultra on first\./);

  const oneTurn = await one.pi.inputToAgentStart('Work.');
  assert.equal(oneTurn.systemPrompt, '');
  const twoTurn = await two.pi.inputToAgentStart('Work.');
  assert.match(twoTurn.systemPrompt ?? '', /active session model is the Ultra manager/i);
  assert.match(twoTurn.systemPrompt ?? '', /openai\/test-model/);

  const delegated = await two.pi.tool('ultra_delegate', delegateInput()) as any;
  assert.equal(delegated.isError, undefined);
  assert.deepEqual(
    { workerModel: two.preparedInputs[0]?.settings.workerModel, minLanes: two.preparedInputs[0]?.settings.minLanes, maxLanes: two.preparedInputs[0]?.settings.maxLanes },
    { workerModel: 'openai/test-model', minLanes: 2, maxLanes: 4 },
  );

  // The shared global baseline is untouched by either session.
  assert.deepEqual(globals.current.settings, { ...ENABLED });
  assert.equal(globals.current.revision, 'revision-shared');
});

test('off in session one appends only a local snapshot and leaves session two and globals intact', async () => {
  const { globals, one, two } = twoSharedSessions();
  await one.start();
  await two.start();
  await one.pi.command('ultra', 'off');
  assert.equal(one.pi.statuses.at(-1)?.value, 'Ultra: off');
  assert.equal(two.pi.statuses.at(-1)?.value, 'Ultra: collaborator');

  const snapshots = one.pi.entries.filter((entry) => entry.customType === SESSION_OVERRIDE_TYPE);
  assert.equal(snapshots.length, 1);
  assert.deepEqual((snapshots[0]?.data as any).patch, { enabled: false });
  assert.equal(two.pi.entries.some((entry) => entry.customType === SESSION_OVERRIDE_TYPE), false);

  const turn = await two.pi.inputToAgentStart('Work.');
  assert.match(turn.systemPrompt ?? '', /openai\/test-model/);
  assert.deepEqual(globals.current.settings, { ...ENABLED });
  assert.equal(globals.current.revision, 'revision-shared');
});

test('a new FakePi built from a prior branch restores the session override state', async () => {
  const first = harness({ session: { sessionId: 'restored', sessionFile: '/tmp/restored.jsonl' } });
  await first.start();
  await first.pi.command('ultra', 'off');
  await applySessionPatch(first, { enabled: false, workerModel: 'openai/session-model', minLanes: 4, maxLanes: 8 });

  const second = harness({
    session: { sessionId: 'restored', sessionFile: '/tmp/restored.jsonl', branch: [...first.pi.entries] },
  });
  await second.start();
  assert.equal(second.pi.statuses.at(-1)?.value, 'Ultra: off');
  const turn = await second.pi.inputToAgentStart('Work.');
  assert.equal(turn.systemPrompt, '');
  const blocked = await second.pi.tool('ultra_delegate', laneInput(4)) as any;
  assert.match(resultText(blocked), /Run \/ultra on first\./);

  await second.pi.command('ultra', 'on');
  assert.equal(second.pi.statuses.at(-1)?.value, 'Ultra: collaborator');
  const revived = await second.pi.tool('ultra_delegate', laneInput(4)) as any;
  assert.equal(revived.isError, undefined);
  assert.equal(second.preparedInputs[0]?.settings.workerModel, 'openai/session-model');
  assert.equal(second.preparedInputs[0]?.settings.minLanes, 4);
  assert.equal(second.preparedInputs[0]?.settings.maxLanes, 8);
});

test('ultra_delegate preflights with session-effective settings including 4-8 lane bounds', async () => {
  const h = harness();
  await h.start();
  await applySessionPatch(h, { routingMode: 'uniform', workerModel: 'openai/session-model', minLanes: 4, maxLanes: 8 });

  const result = await h.pi.tool('ultra_delegate', laneInput(4)) as any;
  assert.equal(result.isError, undefined);
  const sent = h.preparedInputs[0] as any;
  assert.equal(sent.settings.routingMode, 'uniform');
  assert.equal(sent.settings.workerModel, 'openai/session-model');
  assert.equal(sent.settings.minLanes, 4);
  assert.equal(sent.settings.maxLanes, 8);
  assert.notEqual(sent.revision, 'revision-1');
  assert.match(sent.revision, /^[a-f0-9]{64}$/u);
  assert.equal((sent.input as UltraDelegateInput).lanes.length, 4);
  assert.equal(h.launches.length, 1);

  // Effective 4-lane minimum rejects a two-lane wave before launch.
  const tooFew = await h.pi.tool('ultra_delegate', delegateInput()) as any;
  assert.equal(tooFew.isError, true);
  assert.match(resultText(tooFew), /between 4 and 8 entries/i);
  assert.equal(h.launches.length, 1);
});

test('global watcher updates inherited fields while explicitly patched session fields persist', async () => {
  const h = harness();
  await h.start();
  await applySessionPatch(h, { routingMode: 'role-defaults', minLanes: 4, maxLanes: 8 });

  h.setLoaded({ kind: 'loaded', settings: { ...ENABLED, workerModel: 'openai/global-new' }, revision: 'global-rev-2', path: '/tmp/pi-ultra.json' });
  await h.change();
  await h.pi.tool('ultra_delegate', laneInput(4));
  let sent = h.preparedInputs.at(-1) as any;
  assert.equal(sent.settings.workerModel, 'openai/global-new', 'changed global inherited model must take effect');
  assert.equal(sent.settings.minLanes, 4);
  assert.equal(sent.settings.maxLanes, 8);

  await applySessionPatch(h, { workerModel: 'openai/session-model' });
  h.setLoaded({ kind: 'loaded', settings: { ...ENABLED, workerModel: 'openai/global-newer' }, revision: 'global-rev-3', path: '/tmp/pi-ultra.json' });
  await h.change();
  await h.pi.tool('ultra_delegate', delegateInput());
  sent = h.preparedInputs.at(-1) as any;
  assert.equal(sent.settings.workerModel, 'openai/session-model', 'explicitly patched session model must survive global changes');
});

test('invalid global configuration blocks a fully overridden session and ultra_delegate', async () => {
  const h = harness();
  await h.start();
  await applySessionPatch(h, { workerModel: 'openai/session-model', minLanes: 4, maxLanes: 8 });
  assert.equal(h.pi.statuses.at(-1)?.value, 'Ultra: collaborator');

  h.setLoaded({ kind: 'invalid', reason: 'rewritten badly', path: '/tmp/pi-ultra.json' });
  await h.change();
  assert.equal(h.pi.statuses.at(-1)?.value, 'Ultra: blocked');
  assert.equal(h.policyInstalls.at(-1), 'blocked');

  const [direct] = await h.pi.emit('tool_call', { toolName: 'subagent', input: { agent: 'worker', task: 'bypass' } });
  assert.equal((direct as any).block, true);

  const delegated = await h.pi.tool('ultra_delegate', laneInput(4)) as any;
  assert.equal(delegated.isError, true);
  assert.match(resultText(delegated), /blocked/i);
  assert.equal(h.launches.length, 0);
});

test('permit revision validation fails when the session patch or global revision changes', async () => {
  const h = harness();
  await h.start();
  await applySessionPatch(h, { minLanes: 4, maxLanes: 8 });
  const delegated = await h.pi.tool('ultra_delegate', laneInput(4)) as any;
  assert.equal(delegated.isError, undefined);
  const boundRevision = (h.preparedInputs[0] as any).revision;
  const validate = h.revisionValidators.at(-1)!;
  const signal = new AbortController().signal;

  assert.equal(await validate(boundRevision, signal), true);

  appendSessionUltraOverrides((customType, data) => h.pi.appendEntry(customType, data), { minLanes: 2, maxLanes: 4 });
  await h.change();
  assert.equal(await validate(boundRevision, signal), false, 'stale permit must not cross a session patch change');

  await h.pi.tool('ultra_delegate', delegateInput());
  const reboundRevision = (h.preparedInputs.at(-1) as any).revision;
  assert.notEqual(reboundRevision, boundRevision);
  assert.equal(await h.revisionValidators.at(-1)!(reboundRevision, signal), true);

  h.setLoaded({ kind: 'loaded', settings: { ...ENABLED }, revision: 'global-rev-next', path: '/tmp/pi-ultra.json' });
  assert.equal(await validate(reboundRevision, signal), false, 'stale permit must not cross a global revision change');
});

test('a blocked synchronize transition never yields a verified-looking session update result', async () => {
  const h = harness();
  await h.start();
  let update!: ShowMenuOptions['updateSession'];
  h.deps.showMenu = async (options) => { update = options.updateSession; return {}; };
  await h.pi.command('ultra');

  // Internal synchronize failure: the blocked guard installs (or the previous
  // policy stays), but the post-commit load would still succeed and must not
  // be reported as a verified operational result.
  const innerInstall = h.deps.installPolicy;
  h.deps.installPolicy = async (input) => {
    throw new Error('policy install exploded');
  };

  await assert.rejects(() => update({ enabled: true }), (error: unknown) =>
    error instanceof CommittedSessionUpdateError &&
    error.committed === true &&
    /could not be verified/.test(error.message),
  'a committed snapshot followed by a blocked resync must stay committed-but-unverified, never verified-looking');

  // Enforcement is fail-closed and the snapshot committed exactly once.
  assert.equal(h.pi.statuses.at(-1)?.value, 'Ultra: blocked');
  const snapshots = h.pi.entries.filter((entry) => entry.customType === SESSION_OVERRIDE_TYPE);
  assert.equal(snapshots.length, 1);
  assert.deepEqual((snapshots[0]?.data as any).patch, { enabled: true });

  // A later successful watcher change restores the on-state with the patch applied.
  h.deps.installPolicy = innerInstall;
  await h.change();
  assert.equal(h.pi.statuses.at(-1)?.value, 'Ultra: collaborator');
});

test('a blocked synchronize transition never yields a verified-looking global update result', async () => {
  const h = harness();
  await h.start();
  await applySessionPatch(h, { minLanes: 4, maxLanes: 8 });

  let opts!: ShowMenuOptions;
  h.deps.showMenu = async (options) => { opts = options; return {}; };
  await h.pi.command('ultra');

  const globalWrites: unknown[] = [];
  const innerUpdateSettings = h.deps.updateSettings;
  h.deps.updateSettings = async (patch) => { globalWrites.push(patch); return innerUpdateSettings(patch); };
  const innerInstall = h.deps.installPolicy;
  h.deps.installPolicy = async () => { throw new Error('policy install exploded'); };

  // The global write commits before synchronize runs, so even a blocked
  // transition must surface as committed-but-unverified rather than either an
  // optimistic verified result or an ordinary rollback-shaped rejection.
  await assert.rejects(() => opts.updateGlobal({ enabled: true }), (error: unknown) =>
    error instanceof CommittedSessionUpdateError && error.committed === true,
  'the durable global write followed by a blocked resync must surface as a committed outcome');
  assert.deepEqual(globalWrites, [{ enabled: true }], 'the global edit durably committed exactly once');
  assert.equal(h.pi.statuses.at(-1)?.value, 'Ultra: blocked');

  h.deps.installPolicy = innerInstall;
  await h.change();
  assert.equal(h.pi.statuses.at(-1)?.value, 'Ultra: collaborator');
});

test('malformed restored overrides record at most one sanitized non-model diagnostic per distinct set', async () => {
  const malformedBranch = [
    { type: 'custom', customType: SESSION_OVERRIDE_TYPE, id: 'bad-1', data: { version: 1, patch: { enabled: 'yes' } } },
    { type: 'custom', customType: SESSION_OVERRIDE_TYPE, id: 'bad-2', data: { version: 1, patch: { 'bad\u0007field': 1 } } },
    { type: 'custom', customType: 'unrelated.entry', id: 'skip', data: {} },
    { type: 'custom', customType: SESSION_OVERRIDE_TYPE, id: 'good', data: { version: 1, patch: { enabled: true } } },
  ];
  const h = harness({ session: { sessionId: 'diag', sessionFile: '/tmp/diag.jsonl', branch: malformedBranch } });
  await h.start();
  const diagnostics = h.pi.entries.filter((entry) => entry.customType === SESSION_DIAGNOSTIC_TYPE);
  assert.equal(diagnostics.length, 1);
  const serialized = JSON.stringify(diagnostics);
  assert.doesNotMatch(serialized, /[\u0000-\u001f\u007f]/gu);
  assert.match(serialized, /Unsupported session Ultra override field/);
  assert.equal(h.pi.statuses.at(-1)?.value, 'Ultra: collaborator', 'valid later snapshot still applies');

  await h.change();
  assert.equal(h.pi.entries.filter((entry) => entry.customType === SESSION_DIAGNOSTIC_TYPE).length, 1, 'no duplicate diagnostics for the same set');
});
