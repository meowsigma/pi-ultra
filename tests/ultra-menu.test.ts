import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { createRpcHarness, createTuiHarness, type RpcHarness, type TuiHarness } from '@narumitw/pi-tui-kit/testing';
import {
  buildBlockedMenu,
  buildLaneRangeScreen,
  buildMainMenu,
  buildModelCatalog,
  buildModelChoiceScreen,
  buildSettingsScreen,
  laneRangeLabel,
  parseCustomLaneRange,
  showUltraMenu,
  type ShowUltraMenuOptions,
  type UltraMenuContext,
} from '../extensions/ultra-menu.js';
import { UltraSettingsCleanupError } from '../extensions/ultra-config.js';
import type { LoadUltraSettingsResult, UltraSettings, UltraSettingsPatch, ValidUltraSettingsResult } from '../extensions/ultra-config.js';

/** Session-flavored effective state (as if a session override had been applied). */
const SETTINGS: UltraSettings = {
  version: 1, enabled: true, routingMode: 'uniform', workerModel: 'openai/model-a', minLanes: 2, maxLanes: 4,
};
/** Distinct global defaults so reset results are provably not session state. */
const GLOBAL_SETTINGS: UltraSettings = {
  version: 1, enabled: true, routingMode: 'role-defaults', minLanes: 1, maxLanes: 2,
};
const VALID: LoadUltraSettingsResult = { kind: 'loaded', settings: SETTINGS, revision: 'r1', path: '/tmp/pi-ultra.json' };
const BLOCKED: LoadUltraSettingsResult = { kind: 'invalid', reason: 'malformed file', path: '/tmp/pi-ultra.json' };
type PiModel = NonNullable<ExtensionCommandContext['model']>;

function model(provider: string, id: string, name = id): PiModel {
  return {
    id, name, provider, api: 'openai-completions', baseUrl: 'https://example.invalid', reasoning: false,
    input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 16_384, maxTokens: 4_096,
  };
}

function rpcContext(rpc: RpcHarness, models: PiModel[] = []) {
  const notifications: string[] = [];
  const ctx: UltraMenuContext = {
    mode: 'rpc', hasUI: true, model: undefined, scopedModels: [],
    modelRegistry: { getAvailable: () => models },
    ui: {
      ...rpc.ui,
      confirm: async () => true,
      notify: (message) => notifications.push(message),
    },
  };
  return { ctx, notifications };
}

function tuiContext(tui: TuiHarness, models: PiModel[] = [], input?: string | Array<string | undefined>, confirm = true) {
  const notifications: string[] = [];
  const drafts = Array.isArray(input) ? [...input] : [input];
  const ctx: UltraMenuContext = {
    mode: 'tui', hasUI: true, model: undefined, scopedModels: [],
    modelRegistry: { getAvailable: () => models },
    ui: {
      custom: tui.custom,
      input: async () => drafts.shift(),
      select: async () => undefined,
      confirm: async () => confirm,
      notify: (message) => notifications.push(message),
    },
  };
  return { ctx, notifications };
}

interface UpdaterRecorder {
  sessionPatches: UltraSettingsPatch[];
  globalPatches: UltraSettingsPatch[];
  resetCalls: number;
  readonly state: LoadUltraSettingsResult;
  updateSession(patch: any): Promise<ValidUltraSettingsResult>;
  updateGlobal(patch: any): Promise<ValidUltraSettingsResult>;
  resetSession(): Promise<ValidUltraSettingsResult>;
}

/**
 * Records every scoped updater callback exactly as the real extension wires
 * them: updateSession/updateGlobal apply patches, resetSession swaps the
 * displayed state to the pristine global defaults.
 */
function updaters(initial: LoadUltraSettingsResult = VALID): UpdaterRecorder {
  let state = initial;
  const sessionPatches: UltraSettingsPatch[] = [];
  const globalPatches: UltraSettingsPatch[] = [];
  let resetCalls = 0;
  const applied = (scope: string, patches: UltraSettingsPatch[], resolved: UltraSettingsPatch): ValidUltraSettingsResult => {
    if (state.kind === 'invalid') throw new Error('blocked');
    patches.push(resolved);
    state = { kind: 'loaded', settings: { ...state.settings, ...resolved }, revision: `${scope}-${patches.length}`, path: state.path };
    return state;
  };
  return {
    sessionPatches,
    globalPatches,
    get resetCalls() { return resetCalls; },
    get state() { return state; },
    updateSession: async (patch) => applied('session', sessionPatches, typeof patch === 'function' ? patch(state.kind === 'invalid' ? SETTINGS : state.settings) : patch),
    updateGlobal: async (patch) => applied('global', globalPatches, typeof patch === 'function' ? patch(state.kind === 'invalid' ? GLOBAL_SETTINGS : state.settings) : patch),
    resetSession: async () => {
      resetCalls += 1;
      if (state.kind === 'invalid') throw new Error('blocked');
      state = { kind: 'loaded', settings: { ...GLOBAL_SETTINGS }, revision: 'global-effective', path: state.path };
      return state;
    },
  };
}

type MenuRunOptions = Omit<ShowUltraMenuOptions, 'ctx'>;

function menuOptions(recorder: UpdaterRecorder, overrides: Partial<MenuRunOptions> = {}): MenuRunOptions {
  return {
    state: overrides.state ?? recorder.state,
    hasSessionOverrides: overrides.hasSessionOverrides ?? false,
    updateSession: overrides.updateSession ?? recorder.updateSession,
    resetSession: overrides.resetSession ?? recorder.resetSession,
    updateGlobal: overrides.updateGlobal ?? recorder.updateGlobal,
    recover: overrides.recover ?? (async () => assert.fail('not blocked')),
  };
}

test('main screen proves session override provenance and scopes both settings titles', () => {
  const active = buildMainMenu(SETTINGS, { hasSessionOverrides: true });
  assert.equal(active.lines?.includes('Session overrides: Active'), true);
  const none = buildMainMenu(SETTINGS, { hasSessionOverrides: false });
  assert.equal(none.lines?.includes('Session overrides: None'), true);
  assert.deepEqual(
    none.items.map((item) => item.label),
    ['Disable Ultra', 'Settings…', 'Reset this session to global defaults', 'Global defaults…', 'Help', 'Close'],
  );

  assert.equal(buildSettingsScreen(SETTINGS, [], 'session').title, 'Ultra Settings — This session');
  assert.equal(buildSettingsScreen(GLOBAL_SETTINGS, [], 'global').title, 'Ultra Global Defaults — All sessions');
  assert.deepEqual(buildSettingsScreen(SETTINGS, []).items.map((item) => item.label), ['Ultra', 'Routing mode', 'Worker model', 'Lane range']);
  assert.equal(laneRangeLabel({ ...SETTINGS, minLanes: 3, maxLanes: 6 }), 'Custom · 3–6');
});

test('global settings screen renders disabled, Automatic, and small range with global-only action ids', () => {
  const screen = buildSettingsScreen({ ...GLOBAL_SETTINGS, enabled: false }, [], 'global');
  assert.equal(screen.title, 'Ultra Global Defaults — All sessions');
  assert.deepEqual(screen.items.map((item) => item.action), ['set-ultra-global', 'set-routing-global', 'set-model-global', 'set-lane-range-global']);
  assert.equal(screen.items.find((item) => item.id === 'ultra')?.currentValue, 'Disabled');
  assert.equal(screen.items.find((item) => item.id === 'worker-model')?.currentValue, 'Automatic');
  assert.equal(screen.items.find((item) => item.id === 'lane-range')?.currentValue, 'Small · 1–2');

  const chooser = buildModelChoiceScreen({ settings: GLOBAL_SETTINGS, catalog: buildModelCatalog([]), scope: 'global' });
  assert.match(chooser.title, /All sessions/);
  assert.equal(chooser.action, 'set-model-global');
  assert.equal(chooser.currentItemId, 'automatic');
  assert.equal(buildLaneRangeScreen(GLOBAL_SETTINGS, 'global').action, 'set-lane-range-global');
});

test('blocked screen exposes only explicit backup/reset recovery with no global controls', () => {
  const screen = buildBlockedMenu(BLOCKED as any);
  assert.match(screen.title, /Blocked/);
  assert.match(screen.lines?.join('\n') ?? '', /malformed file/);
  assert.deepEqual(screen.items.map((item) => item.label), ['Back up invalid file and reset disabled…', 'Help', 'Close']);
});

test('full registry catalog deduplicates deterministically and unions searchable metadata', () => {
  const forward = buildModelCatalog([
    { provider: 'zeta', id: 'm', name: 'Zulu' },
    { provider: 'openai', id: 'model-a', name: 'Alpha' },
    { provider: 'openai', id: 'model-a', name: 'Alternate' },
  ]);
  const reverse = buildModelCatalog([
    { provider: 'openai', id: 'model-a', name: 'Alternate' },
    { provider: 'openai', id: 'model-a', name: 'Alpha' },
    { provider: 'zeta', id: 'm', name: 'Zulu' },
  ]);
  assert.deepEqual(forward, reverse);
  assert.deepEqual(forward.map((entry) => entry.id), ['openai/model-a', 'zeta/m']);
  assert.match(forward[0]?.searchText ?? '', /openai.*model-a.*Alpha.*Alternate/);
  assert.deepEqual(buildModelCatalog([
    { provider: 'p', id: 'é', name: 'é' },
    { provider: 'p', id: 'Z', name: 'Z' },
    { provider: 'p', id: 'a', name: 'a' },
  ]).map((entry) => entry.id), ['p/Z', 'p/a', 'p/é']);
});

test('model ChoiceScreen enables fuzzy search, bounds viewport, saves raw ids, and recovers unavailable selection', () => {
  const catalog = buildModelCatalog([model('anthropic', 'model-b', 'Claude B')]);
  const screen = buildModelChoiceScreen({ settings: SETTINGS, catalog });
  assert.equal(screen.items[0]?.id, 'automatic');
  assert.equal(screen.enableSearch, true);
  assert.equal(screen.viewportSize, 10);
  assert.equal(screen.currentItemId, 'openai/model-a');
  assert.equal(screen.initialItemId, 'automatic');
  assert.equal(screen.items.find((item) => item.id === 'openai/model-a')?.disabled, true);
  assert.match(screen.items.find((item) => item.id === 'anthropic/model-b')?.searchText ?? '', /anthropic.*model-b.*Claude B/);
});

test('lane presets and custom parser enforce inclusive 1–8 ranges', () => {
  assert.deepEqual(buildLaneRangeScreen(SETTINGS).items.map((item) => item.label), ['Small — 1–2', 'Balanced — 2–4', 'Large — 4–8', 'Custom…']);
  assert.deepEqual(parseCustomLaneRange(' 3 – 6 '), { minLanes: 3, maxLanes: 6 });
  assert.deepEqual(parseCustomLaneRange('1-8'), { minLanes: 1, maxLanes: 8 });
  for (const invalid of ['0-2', '4-3', '1-9', '1.5-2', '1', 'a-b']) assert.equal(parseCustomLaneRange(invalid), undefined, invalid);
});

test('session routing, model, and lane-range edits call only the session updater', async () => {
  const rpc = createRpcHarness([
    { kind: 'select', response: 'Settings…' },
    { kind: 'select', response: 'Routing mode (One model for every lane)' },
    { kind: 'select', response: 'Back' },
    { kind: 'select', response: 'Settings…' },
    { kind: 'select', response: 'Worker model (openai/model-a)' },
    { kind: 'select', response: 'Claude B · anthropic/model-b' },
    { kind: 'select', response: 'Back' },
    { kind: 'select', response: 'Lane range (Balanced · 2–4)' },
    { kind: 'select', response: 'Large — 4–8' },
    { kind: 'select', response: 'Back' },
    { kind: 'select', response: 'Back' },
    { kind: 'select', response: 'Close' },
  ]);
  const { ctx } = rpcContext(rpc, [model('zeta', 'm', 'Zulu'), model('anthropic', 'model-b', 'Claude B')]);
  const updates = updaters();
  await showUltraMenu({ ctx, ...menuOptions(updates, { hasSessionOverrides: true }) });
  rpc.assertConsumed();
  assert.deepEqual(updates.sessionPatches, [
    { routingMode: 'role-defaults' },
    { workerModel: 'anthropic/model-b' },
    { minLanes: 4, maxLanes: 8 },
  ]);
  assert.deepEqual(updates.globalPatches, []);
  assert.equal(updates.resetCalls, 0);
});

test('explicit global defaults screen calls only the global updater for every ordinary setting', async () => {
  const rpc = createRpcHarness([
    { kind: 'select', response: 'Global defaults…' },
    { kind: 'select', response: 'Ultra (Enabled)' },
    { kind: 'select', response: 'Routing mode (Role defaults)' },
    { kind: 'select', response: 'Worker model (Automatic)' },
    { kind: 'select', response: 'Claude B · anthropic/model-b' },
    { kind: 'select', response: 'Back' },
    { kind: 'select', response: 'Lane range (Small · 1–2)' },
    { kind: 'select', response: 'Large — 4–8' },
    { kind: 'select', response: 'Back' },
    { kind: 'select', response: 'Back' },
    { kind: 'select', response: 'Close' },
  ]);
  const { ctx } = rpcContext(rpc, [model('anthropic', 'model-b', 'Claude B')]);
  const updates = updaters({
    kind: 'loaded', settings: { ...GLOBAL_SETTINGS }, revision: 'g0', path: '/tmp/pi-ultra.json',
  });
  await showUltraMenu({ ctx, ...menuOptions(updates) });
  rpc.assertConsumed();
  assert.deepEqual(updates.globalPatches, [
    { enabled: false },
    { routingMode: 'uniform' },
    { workerModel: 'anthropic/model-b' },
    { minLanes: 4, maxLanes: 8 },
  ]);
  assert.deepEqual(updates.sessionPatches, []);
  assert.equal(updates.resetCalls, 0);
  // The displayed state follows the committed global writes.
  const last = updates.state as ValidUltraSettingsResult;
  assert.equal(last.settings.enabled, false);
  assert.equal(last.settings.workerModel, 'anthropic/model-b');
  assert.deepEqual({ minLanes: last.settings.minLanes, maxLanes: last.settings.maxLanes }, { minLanes: 4, maxLanes: 8 });
});

test('reset this session appends no patch, calls no scoped updater, and displays effective global defaults', async () => {
  const rpc = createRpcHarness([
    { kind: 'select', response: 'Reset this session to global defaults' },
    { kind: 'select', response: 'Close' },
  ]);
  const { ctx } = rpcContext(rpc);
  const updates = updaters();
  await showUltraMenu({ ctx, ...menuOptions(updates, { hasSessionOverrides: true }) });
  rpc.assertConsumed();
  assert.equal(updates.resetCalls, 1);
  assert.deepEqual(updates.sessionPatches, []);
  assert.deepEqual(updates.globalPatches, []);
  const mainAgain = JSON.stringify(rpc.dialogs.at(-1));
  assert.match(mainAgain, /Session overrides: None/);
  assert.match(mainAgain, /Role defaults/);
  assert.match(mainAgain, /Small · 1–2/);
  assert.doesNotMatch(mainAgain, /openai\/model-a/);
});

test('preset selection performs one paired session update transaction', async () => {
  const rpc = createRpcHarness([
    { kind: 'select', response: 'Settings…' },
    { kind: 'select', response: 'Lane range (Balanced · 2–4)' },
    { kind: 'select', response: 'Large — 4–8' },
    { kind: 'select', response: 'Back' },
    { kind: 'select', response: 'Back' },
    { kind: 'select', response: 'Close' },
  ]);
  const { ctx } = rpcContext(rpc);
  const updates = updaters();
  await showUltraMenu({ ctx, ...menuOptions(updates) });
  rpc.assertConsumed();
  assert.deepEqual(updates.sessionPatches, [{ minLanes: 4, maxLanes: 8 }]);
});

test('RPC adapter receives deterministic unfiltered all-registry model choices and saves canonical item id', async () => {
  const rpc = createRpcHarness([
    { kind: 'select', response: 'Settings…' },
    { kind: 'select', response: 'Worker model (openai/model-a)' },
    { kind: 'select', response: 'Claude B · anthropic/model-b' },
    { kind: 'select', response: 'Back' },
    { kind: 'select', response: 'Back' },
    { kind: 'select', response: 'Close' },
  ]);
  const { ctx } = rpcContext(rpc, [model('zeta', 'm', 'Zulu'), model('anthropic', 'model-b', 'Claude B')]);
  ctx.scopedModels = [{ model: model('scoped', 'hidden') } as any];
  const updates = updaters();
  await showUltraMenu({ ctx, ...menuOptions(updates) });
  rpc.assertConsumed();
  const options = rpc.dialogs[2]?.options ?? [];
  assert.deepEqual(options.slice(0, 3), ['Automatic', 'Claude B · anthropic/model-b', 'Zulu · zeta/m']);
  assert.equal(options.some((option) => option.includes('scoped/hidden')), false);
  assert.deepEqual(updates.sessionPatches, [{ workerModel: 'anthropic/model-b' }]);
});

test('set-model Automatic sends an explicit workerModel key so presence-based merges see the clear', async () => {
  const rpc = createRpcHarness([
    { kind: 'select', response: 'Settings…' },
    { kind: 'select', response: 'Worker model (openai/model-a)' },
    { kind: 'select', response: 'Automatic' },
    { kind: 'select', response: 'Back' },
    { kind: 'select', response: 'Back' },
    { kind: 'select', response: 'Close' },
  ]);
  const { ctx } = rpcContext(rpc, [model('openai', 'model-a')]);
  const updates = updaters();
  await showUltraMenu({ ctx, ...menuOptions(updates) });
  rpc.assertConsumed();
  assert.equal(updates.sessionPatches.length, 1);
  assert.equal('workerModel' in updates.sessionPatches[0], true, 'Automatic must not drop the workerModel key');
  assert.equal(updates.sessionPatches[0].workerModel, undefined);
});

test('invalid custom draft remains available for correction and saves exactly one valid pair', async () => {
  for (const [drafts, expected] of [[['bad', undefined], []], [['bad', '3–6'], [{ minLanes: 3, maxLanes: 6 }]]] as const) {
    const tui = createTuiHarness({ width: 50, rows: 10 });
    const { ctx } = tuiContext(tui, [], [...drafts]);
    const updates = updaters();
    const running = showUltraMenu({ ctx, ...menuOptions(updates) });
    await tui.waitForOpen();
    tui.press('tui.select.down');
    tui.press('tui.select.confirm');
    await tui.waitForOpen();
    tui.press('tui.select.down');
    tui.press('tui.select.down');
    tui.press('tui.select.down');
    tui.press('tui.select.confirm');
    await tui.waitForPending();
    await tui.waitForOpen();
    tui.press('tui.select.down');
    tui.press('tui.select.down');
    tui.press('tui.select.confirm');
    await tui.waitForPending();
    await tui.waitForOpen();
    assert.deepEqual(updates.sessionPatches, expected, JSON.stringify(drafts));
    tui.press('ctrl+c');
    await running;
  }
});

test('TUI fuzzy search filters a large catalog and remains usable at narrow width', async () => {
  const tui = createTuiHarness({ width: 32, rows: 8 });
  const models = Array.from({ length: 40 }, (_, index) => model('provider', `model-${index}`, `Display ${index}`));
  const { ctx } = tuiContext(tui, models);
  const updates = updaters({ kind: 'loaded', settings: { ...SETTINGS, workerModel: undefined }, revision: 'r', path: '/tmp/pi-ultra.json' });
  const running = showUltraMenu({ ctx, ...menuOptions(updates) });
  await tui.waitForOpen();
  tui.press('tui.select.down');
  tui.press('tui.select.confirm');
  await tui.waitForOpen();
  tui.press('tui.select.down');
  tui.press('tui.select.down');
  tui.press('tui.select.confirm');
  await tui.waitForPending();
  await tui.waitForOpen();
  tui.type('model-37');
  const rendered = tui.render().join('\n');
  assert.match(rendered, /model-37/);
  assert.doesNotMatch(rendered, /model-1\b/);
  tui.type('no-such-model');
  assert.match(tui.render().join('\n'), /no match/i);
  tui.press('ctrl+c');
  await running;
});

test('committed cleanup errors refresh menu state instead of rolling back the displayed value', async () => {
  const rpc = createRpcHarness([
    { kind: 'select', response: 'Disable Ultra' },
    { kind: 'select', response: 'Close' },
  ]);
  const { ctx, notifications } = rpcContext(rpc);
  const committed = { kind: 'loaded' as const, settings: { ...SETTINGS, enabled: false }, revision: 'r2', path: '/tmp/pi-ultra.json' };
  const updates = updaters();
  await showUltraMenu({
    ctx,
    ...menuOptions(updates, {
      updateSession: async () => { throw new UltraSettingsCleanupError('committed but cleanup failed', committed); },
    }),
  });
  rpc.assertConsumed();
  assert.match(rpc.dialogs.at(-1)?.title ?? '', /Ultra: Disabled/);
  assert.match(notifications[0] ?? '', /cleanup failed/i);
  assert.equal(updates.globalPatches.length, 0);
});

test('committed cleanup errors on the global updater behave identically', async () => {
  const rpc = createRpcHarness([
    { kind: 'select', response: 'Global defaults…' },
    { kind: 'select', response: 'Ultra (Enabled)' },
    { kind: 'select', response: 'Back' },
    { kind: 'select', response: 'Close' },
  ]);
  const { ctx, notifications } = rpcContext(rpc);
  const committed = { kind: 'loaded' as const, settings: { ...GLOBAL_SETTINGS, enabled: false }, revision: 'gc', path: '/tmp/pi-ultra.json' };
  const updates = updaters({ kind: 'loaded', settings: { ...GLOBAL_SETTINGS }, revision: 'g0', path: '/tmp/pi-ultra.json' });
  await showUltraMenu({
    ctx,
    ...menuOptions(updates, {
      updateGlobal: async () => { throw new UltraSettingsCleanupError('committed but cleanup failed', committed); },
    }),
  });
  rpc.assertConsumed();
  assert.match(rpc.dialogs.at(-1)?.title ?? '', /Ultra: Disabled/);
  assert.match(notifications[0] ?? '', /cleanup failed/i);
  assert.equal(updates.sessionPatches.length, 0);
});

test('blocked recovery confirms, calls backup/reset once, and reports backup path', async () => {
  const rpc = createRpcHarness([
    { kind: 'select', response: 'Back up invalid file and reset disabled…' },
    { kind: 'select', response: 'Close' },
  ]);
  const { ctx, notifications } = rpcContext(rpc);
  let calls = 0;
  await showUltraMenu({
    ctx, state: BLOCKED,
    hasSessionOverrides: false,
    updateSession: async () => assert.fail('blocked state must not update'),
    resetSession: async () => assert.fail('blocked state must not reset'),
    updateGlobal: async () => assert.fail('blocked state must not update'),
    recover: async () => {
      calls += 1;
      return { backupPath: '/tmp/pi-ultra.invalid.bak', committed: { kind: 'loaded', settings: { ...SETTINGS, enabled: false }, revision: 'reset', path: '/tmp/pi-ultra.json' } };
    },
  });
  rpc.assertConsumed();
  assert.equal(calls, 1);
  assert.match(notifications[0] ?? '', /invalid\.bak.*reset disabled/i);
});
