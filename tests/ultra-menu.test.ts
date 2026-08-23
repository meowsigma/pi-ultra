import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import {
  createRpcHarness,
  createTuiHarness,
  type RpcHarness,
  type TuiHarness,
} from '@narumitw/pi-tui-kit/testing';
import {
  applySetting,
  buildMainMenu,
  buildModelChoiceScreen,
  buildSettingsScreen,
  showUltraMenu,
  type UltraMenuContext,
} from '../extensions/ultra-menu.js';
import type { UltraSettings } from '../extensions/ultra-config.js';

const DISABLED_UNIFORM = {
  version: 1,
  enabled: false,
  routingMode: 'uniform',
  minLanes: 1,
  maxLanes: 3,
} satisfies UltraSettings;

const ENABLED_ROLE_DEFAULTS = {
  version: 1,
  enabled: true,
  routingMode: 'role-defaults',
  minLanes: 2,
  maxLanes: 4,
} satisfies UltraSettings;

const UNIFORM_WITH_MODEL = {
  version: 1,
  enabled: true,
  routingMode: 'uniform',
  workerModel: 'openai/model-a',
  minLanes: 2,
  maxLanes: 5,
} satisfies UltraSettings;

type PiModel = NonNullable<ExtensionCommandContext['model']>;

function model(provider: string, id: string): PiModel {
  return {
    id,
    name: id,
    api: 'openai-completions',
    provider,
    baseUrl: 'https://example.invalid',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 16_384,
    maxTokens: 4_096,
  };
}

interface ContextModels {
  scopedModels?: ExtensionCommandContext['scopedModels'];
  registryModels?: PiModel[];
  currentModel?: PiModel;
}

function rpcContext(
  rpc: RpcHarness,
  models: ContextModels = {},
): { ctx: UltraMenuContext; notifications: string[] } {
  const notifications: string[] = [];
  const ctx: UltraMenuContext = {
    mode: 'rpc',
    hasUI: true,
    ui: {
      ...rpc.ui,
      notify: (message) => notifications.push(message),
    },
    scopedModels: models.scopedModels ?? [],
    modelRegistry: { getAvailable: () => models.registryModels ?? [] },
    model: models.currentModel,
  };
  return { ctx, notifications };
}

function tuiContext(
  tui: TuiHarness,
  models: ContextModels = {},
): { ctx: UltraMenuContext; notifications: string[] } {
  const notifications: string[] = [];
  const ctx: UltraMenuContext = {
    mode: 'tui',
    hasUI: true,
    ui: {
      custom: tui.custom,
      input: async () => undefined,
      select: async () => undefined,
      notify: (message) => notifications.push(message),
    },
    scopedModels: models.scopedModels ?? [],
    modelRegistry: { getAvailable: () => models.registryModels ?? [] },
    model: models.currentModel,
  };
  return { ctx, notifications };
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => resolvePromise?.(),
  };
}

async function pickerOptions(models: ContextModels): Promise<readonly string[]> {
  const rpc = createRpcHarness([
    { kind: 'select', response: 'Settings…' },
    { kind: 'select', response: 'Worker model (Automatic)' },
    { kind: 'select', response: 'Back' },
    { kind: 'select', response: 'Back' },
    { kind: 'select', response: 'Close' },
  ]);
  const { ctx } = rpcContext(rpc, models);
  await showUltraMenu({ ctx, settings: DISABLED_UNIFORM, save: async () => undefined });
  rpc.assertConsumed();
  const options = rpc.dialogs[2]?.options;
  assert.ok(options, 'model picker must be the third dialog');
  return options;
}

// Pure screen and normalization behavior.

test('buildMainMenu reports exact state, routing, Automatic, and lane labels', () => {
  const disabled = buildMainMenu(DISABLED_UNIFORM);
  assert.equal(disabled.title, 'Ultra Control');
  assert.deepEqual(disabled.lines, [
    'Enabled: no',
    'Routing: One model for every lane',
    'Model: Automatic',
    'Lanes: 1–3',
  ]);
  assert.deepEqual(disabled.items.map((item) => item.label), [
    'Enable Ultra',
    'Settings…',
    'Help',
    'Close',
  ]);

  const enabled = buildMainMenu(ENABLED_ROLE_DEFAULTS);
  assert.equal(enabled.lines?.[1], 'Routing: Role defaults');
  assert.equal(enabled.lines?.[2], 'Model: –');
  assert.equal(enabled.items[0]?.label, 'Disable Ultra');
});

test('applySetting clears Automatic and strictly validates decimal lane values', () => {
  const cleared = applySetting(UNIFORM_WITH_MODEL, 'workerModel', 'Automatic');
  assert.ok(cleared);
  assert.equal('workerModel' in cleared, false);

  assert.equal(applySetting(DISABLED_UNIFORM, 'minLanes', '2.9'), undefined);
  assert.equal(applySetting(DISABLED_UNIFORM, 'minLanes', '2junk'), undefined);
  assert.equal(applySetting(DISABLED_UNIFORM, 'minLanes', '+2'), undefined);
  assert.equal(applySetting(DISABLED_UNIFORM, 'minLanes', '4'), undefined, 'min > max');
  assert.equal(applySetting(DISABLED_UNIFORM, 'maxLanes', '9'), undefined);
  assert.equal(applySetting(DISABLED_UNIFORM, 'minLanes', ' 2 ')?.minLanes, 2);
});

test('settings keeps an unavailable Worker model row enabled for recovery', () => {
  const screen = buildSettingsScreen({
    settings: UNIFORM_WITH_MODEL,
    availableModels: ['anthropic/model-b'],
  });
  const workerModel = screen.items.find((item) => item.id === 'worker-model');
  assert.ok(workerModel);
  assert.notEqual(workerModel.disabled, true);
  assert.match(workerModel.description ?? '', /no longer available/i);

  const min = screen.items.find((item) => item.id === 'min-subagents');
  assert.deepEqual(min?.values, ['1', '2', '3', '4', '5', '6', '7', '8']);
});

test('model picker shows Automatic, canonical choices, and disabled unavailable saved model', () => {
  const screen = buildModelChoiceScreen({
    settings: UNIFORM_WITH_MODEL,
    availableModels: ['anthropic/model-b'],
  });
  assert.equal(screen.items[0]?.id, 'automatic');
  assert.equal(screen.items[0]?.label, 'Automatic');
  assert.equal(screen.items[1]?.id, 'anthropic/model-b');
  const unavailable = screen.items.find((item) => item.id === 'openai/model-a');
  assert.equal(unavailable?.disabled, true);
  assert.equal(unavailable?.disabledReason, 'Not available');
  assert.equal(screen.currentItemId, 'openai/model-a');
});

// Real pi-tui-kit adapter exercises.

test('RPC menu navigates Settings Worker model to ChoiceScreen and saves selected itemId', async () => {
  const rpc = createRpcHarness([
    { kind: 'select', response: 'Settings…' },
    { kind: 'select', response: 'Worker model (Automatic)' },
    { kind: 'select', response: 'openai/model-a' },
    { kind: 'select', response: 'Back' },
    { kind: 'select', response: 'Back' },
    { kind: 'select', response: 'Close' },
  ]);
  const { ctx } = rpcContext(rpc, { registryModels: [model('openai', 'model-a')] });
  const saved: UltraSettings[] = [];

  const result = await showUltraMenu({
    ctx,
    settings: DISABLED_UNIFORM,
    save: async (settings) => {
      saved.push(settings);
    },
  });

  assert.deepEqual(result, { kind: 'closed', reason: 'close' });
  rpc.assertConsumed();
  assert.equal(rpc.dialogs[2]?.title, 'Worker model');
  assert.equal(saved.length, 1);
  assert.equal(saved[0]?.workerModel, 'openai/model-a');
  assert.equal(saved[0]?.routingMode, 'uniform');
});

test('RPC SettingsScreen callback saves exactly one complete normalized lane update', async () => {
  const rpc = createRpcHarness([
    { kind: 'select', response: 'Settings…' },
    { kind: 'select', response: 'Minimum subagents (1)' },
    { kind: 'select', response: 'Back' },
    { kind: 'select', response: 'Close' },
  ]);
  const { ctx } = rpcContext(rpc);
  const saved: UltraSettings[] = [];

  await showUltraMenu({
    ctx,
    settings: DISABLED_UNIFORM,
    save: async (settings) => {
      saved.push(settings);
    },
  });

  rpc.assertConsumed();
  assert.deepEqual(saved, [{
    version: 1,
    enabled: false,
    routingMode: 'uniform',
    minLanes: 2,
    maxLanes: 3,
  }]);
  assert.ok(rpc.dialogs[2]?.options?.includes('Minimum subagents (2)'));
});

test('RPC menu recovers from unavailable saved model by selecting Automatic', async () => {
  const rpc = createRpcHarness([
    { kind: 'select', response: 'Settings…' },
    { kind: 'select', response: 'Worker model (openai/model-a)' },
    { kind: 'select', response: 'Automatic' },
    { kind: 'select', response: 'Back' },
    { kind: 'select', response: 'Back' },
    { kind: 'select', response: 'Close' },
  ]);
  const { ctx } = rpcContext(rpc, { registryModels: [model('anthropic', 'model-b')] });
  const saved: UltraSettings[] = [];

  await showUltraMenu({
    ctx,
    settings: UNIFORM_WITH_MODEL,
    save: async (settings) => {
      saved.push(settings);
    },
  });

  rpc.assertConsumed();
  assert.ok(
    rpc.dialogs[2]?.options?.includes('[-] openai/model-a (unavailable: Not available)'),
    'unavailable saved model remains visible as a disabled choice',
  );
  assert.equal(saved.length, 1);
  assert.equal('workerModel' in (saved[0] ?? {}), false);
});

test('model source uses scoped .model entries, then registry, then current ctx.model', async () => {
  const scoped = model('scoped-provider', 'scoped-model');
  const registry = model('registry-provider', 'registry-model');
  const current = model('current-provider', 'current-model');

  const scopedOptions = await pickerOptions({
    scopedModels: [{ model: scoped }],
    registryModels: [registry],
    currentModel: current,
  });
  assert.ok(scopedOptions.includes('scoped-provider/scoped-model'));
  assert.ok(!scopedOptions.includes('registry-provider/registry-model'));
  assert.ok(!scopedOptions.includes('current-provider/current-model'));

  const registryOptions = await pickerOptions({ registryModels: [registry], currentModel: current });
  assert.ok(registryOptions.includes('registry-provider/registry-model'));
  assert.ok(!registryOptions.includes('current-provider/current-model'));

  const currentOptions = await pickerOptions({ currentModel: current });
  assert.ok(currentOptions.includes('current-provider/current-model'));
});

test('RPC menu awaits one save before committing and rendering next state', async () => {
  const rpc = createRpcHarness([
    { kind: 'select', response: 'Enable Ultra' },
    { kind: 'select', response: 'Close' },
  ]);
  const { ctx } = rpcContext(rpc);
  const saveStarted = deferred();
  const releaseSave = deferred();
  let saveCalls = 0;

  const running = showUltraMenu({
    ctx,
    settings: DISABLED_UNIFORM,
    save: async () => {
      saveCalls += 1;
      saveStarted.resolve();
      await releaseSave.promise;
    },
  });

  await saveStarted.promise;
  assert.equal(saveCalls, 1);
  assert.equal(rpc.dialogs.length, 1, 'menu must wait for persistence before re-rendering');
  releaseSave.resolve();
  await running;

  rpc.assertConsumed();
  assert.match(rpc.dialogs[1]?.title ?? '', /Enabled: yes/);
});

test('RPC menu reports rejected save and retains previous state', async () => {
  const rpc = createRpcHarness([
    { kind: 'select', response: 'Enable Ultra' },
    { kind: 'select', response: 'Close' },
  ]);
  const { ctx, notifications } = rpcContext(rpc);
  let saveCalls = 0;

  const result = await showUltraMenu({
    ctx,
    settings: DISABLED_UNIFORM,
    save: async () => {
      saveCalls += 1;
      throw new Error('disk full');
    },
  });

  assert.deepEqual(result, { kind: 'closed', reason: 'close' });
  rpc.assertConsumed();
  assert.equal(saveCalls, 1);
  assert.match(rpc.dialogs[1]?.title ?? '', /Enabled: no/);
  assert.ok(notifications.some((message) => /disk full/.test(message)));
});

test('TUI harness exercises showUltraMenu and does not render committed state before save resolves', async () => {
  const tui = createTuiHarness();
  const { ctx } = tuiContext(tui);
  const saveStarted = deferred();
  const releaseSave = deferred();

  const running = showUltraMenu({
    ctx,
    settings: DISABLED_UNIFORM,
    save: async () => {
      saveStarted.resolve();
      await releaseSave.promise;
    },
  });

  await tui.waitForOpen();
  assert.match(tui.render().join('\n'), /Model: Automatic/);
  tui.press('tui.select.confirm');
  await saveStarted.promise;
  assert.equal(tui.isOpen, false, 'next screen is blocked on the pending save');

  const reopened = tui.waitForOpen();
  releaseSave.resolve();
  await reopened;
  assert.match(tui.render().join('\n'), /Enabled: yes/);
  tui.press('ctrl+c');

  assert.deepEqual(await running, { kind: 'closed', reason: 'close' });
});
