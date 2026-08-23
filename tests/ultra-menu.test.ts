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
  type UltraMenuContext,
} from '../extensions/ultra-menu.js';
import type { LoadUltraSettingsResult, UltraSettings, UltraSettingsPatch } from '../extensions/ultra-config.js';

const SETTINGS: UltraSettings = {
  version: 1, enabled: true, routingMode: 'uniform', workerModel: 'openai/model-a', minLanes: 2, maxLanes: 4,
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

function tuiContext(tui: TuiHarness, models: PiModel[] = [], input?: string, confirm = true) {
  const notifications: string[] = [];
  const ctx: UltraMenuContext = {
    mode: 'tui', hasUI: true, model: undefined, scopedModels: [],
    modelRegistry: { getAvailable: () => models },
    ui: {
      custom: tui.custom,
      input: async () => input,
      select: async () => undefined,
      confirm: async () => confirm,
      notify: (message) => notifications.push(message),
    },
  };
  return { ctx, notifications };
}

function updater(initial = VALID) {
  let state = initial;
  const patches: UltraSettingsPatch[] = [];
  return {
    patches,
    async update(patch: any) {
      assert.notEqual(state.kind, 'invalid');
      if (state.kind === 'invalid') throw new Error('blocked');
      const resolved = typeof patch === 'function' ? patch(state.settings) : patch;
      patches.push(resolved);
      state = { kind: 'loaded', settings: { ...state.settings, ...resolved }, revision: `r${patches.length + 1}`, path: state.path };
      return state as any;
    },
    get state() { return state; },
  };
}

test('main/settings screens show truthful model and one atomic lane-range row', () => {
  const main = buildMainMenu(SETTINGS);
  assert.deepEqual(main.lines, [
    'Ultra: Enabled',
    'Routing: One model for every lane',
    'Model: openai/model-a',
    'Lane range: Balanced · 2–4',
  ]);
  const settings = buildSettingsScreen(SETTINGS, ['openai/model-a']);
  assert.deepEqual(settings.items.map((item) => item.label), ['Ultra', 'Routing mode', 'Worker model', 'Lane range']);
  assert.equal(settings.items.some((item) => /Minimum|Maximum/.test(item.label)), false);
  assert.equal(laneRangeLabel({ ...SETTINGS, minLanes: 3, maxLanes: 6 }), 'Custom · 3–6');
});

test('blocked screen exposes only explicit backup/reset recovery', () => {
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
  const updates = updater();
  await showUltraMenu({ ctx, state: VALID, update: updates.update, recover: async () => assert.fail('not blocked') });
  rpc.assertConsumed();
  const options = rpc.dialogs[2]?.options ?? [];
  assert.deepEqual(options.slice(0, 3), ['Automatic', 'Claude B · anthropic/model-b', 'Zulu · zeta/m']);
  assert.equal(options.some((option) => option.includes('scoped/hidden')), false);
  assert.deepEqual(updates.patches, [{ workerModel: 'anthropic/model-b' }]);
});

test('preset selection performs one paired update transaction', async () => {
  const rpc = createRpcHarness([
    { kind: 'select', response: 'Settings…' },
    { kind: 'select', response: 'Lane range (Balanced · 2–4)' },
    { kind: 'select', response: 'Large — 4–8' },
    { kind: 'select', response: 'Back' },
    { kind: 'select', response: 'Back' },
    { kind: 'select', response: 'Close' },
  ]);
  const { ctx } = rpcContext(rpc);
  const updates = updater();
  await showUltraMenu({ ctx, state: VALID, update: updates.update, recover: async () => assert.fail('not blocked') });
  rpc.assertConsumed();
  assert.deepEqual(updates.patches, [{ minLanes: 4, maxLanes: 8 }]);
});

test('invalid custom draft causes zero saves while valid draft saves one pair', async () => {
  for (const [draft, expected] of [['bad', []], ['3–6', [{ minLanes: 3, maxLanes: 6 }]]] as const) {
    const tui = createTuiHarness({ width: 50, rows: 10 });
    const { ctx } = tuiContext(tui, [], draft);
    const updates = updater();
    const running = showUltraMenu({ ctx, state: VALID, update: updates.update, recover: async () => assert.fail('not blocked') });
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
    assert.deepEqual(updates.patches, expected, draft);
    tui.press('ctrl+c');
    await running;
  }
});

test('TUI fuzzy search filters a large catalog and remains usable at narrow width', async () => {
  const tui = createTuiHarness({ width: 32, rows: 8 });
  const models = Array.from({ length: 40 }, (_, index) => model('provider', `model-${index}`, `Display ${index}`));
  const { ctx } = tuiContext(tui, models);
  const updates = updater({ kind: 'loaded', settings: { ...SETTINGS, workerModel: undefined }, revision: 'r', path: '/tmp/pi-ultra.json' });
  const running = showUltraMenu({ ctx, state: updates.state, update: updates.update, recover: async () => assert.fail('not blocked') });
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

test('blocked recovery confirms, calls backup/reset once, and reports backup path', async () => {
  const rpc = createRpcHarness([
    { kind: 'select', response: 'Back up invalid file and reset disabled…' },
    { kind: 'select', response: 'Close' },
  ]);
  const { ctx, notifications } = rpcContext(rpc);
  let calls = 0;
  await showUltraMenu({
    ctx, state: BLOCKED,
    update: async () => assert.fail('blocked state must not update'),
    recover: async () => {
      calls += 1;
      return { backupPath: '/tmp/pi-ultra.invalid.bak', committed: { kind: 'loaded', settings: { ...SETTINGS, enabled: false }, revision: 'reset', path: '/tmp/pi-ultra.json' } };
    },
  });
  rpc.assertConsumed();
  assert.equal(calls, 1);
  assert.match(notifications[0] ?? '', /invalid\.bak.*reset disabled/i);
});
