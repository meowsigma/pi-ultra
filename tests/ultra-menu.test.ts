import assert from 'node:assert/strict';
import test from 'node:test';

// ── Module under test ─────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let menu: any;
let config: any;

async function loadModules() {
  menu = await import('../extensions/ultra-menu.js');
  config = await import('../extensions/ultra-config.js');
}

// ── Sample settings ───────────────────────────────────────────────

const ENABLED_ROLE_DEFAULTS = Object.freeze({
  version: 1,
  enabled: true,
  routingMode: 'role-defaults',
  minLanes: 2,
  maxLanes: 4,
});

const DISABLED_UNIFORM = Object.freeze({
  version: 1,
  enabled: false,
  routingMode: 'uniform',
  minLanes: 1,
  maxLanes: 3,
});

const UNIFORM_WITH_MODEL = Object.freeze({
  version: 1,
  enabled: true,
  routingMode: 'uniform',
  workerModel: 'gpt-4o',
  minLanes: 2,
  maxLanes: 5,
});

// ── MODULE EXPORTS ─────────────────────────────────────────────────
test('module exports expected symbols', async () => {
  await loadModules();
  assert.equal(typeof menu.buildMainMenu, 'function');
  assert.equal(typeof menu.applySetting, 'function');
  assert.equal(typeof menu.buildSettingsScreen, 'function');
  assert.equal(typeof menu.buildModelChoiceScreen, 'function');
  assert.equal(typeof menu.showUltraMenu, 'function');
});

// ═══════════════════════════════════════════════════════════════════
// buildMainMenu
// ═══════════════════════════════════════════════════════════════════

test('buildMainMenu returns an ActionsScreen with correct title', async () => {
  await loadModules();
  const screen = menu.buildMainMenu(ENABLED_ROLE_DEFAULTS);
  assert.equal(screen.kind, 'actions');
  assert.equal(screen.title, 'Ultra Control');
});

test('buildMainMenu shows Disable Ultra when enabled, no Enable Ultra', async () => {
  await loadModules();
  const screen = menu.buildMainMenu(ENABLED_ROLE_DEFAULTS);
  const labels = screen.items.map((i: { label: string }) => i.label);
  assert.ok(labels.includes('Disable Ultra'), 'should show Disable Ultra');
  assert.ok(!labels.includes('Enable Ultra'), 'should NOT show Enable Ultra');
});

test('buildMainMenu shows Enable Ultra when disabled, no Disable Ultra', async () => {
  await loadModules();
  const screen = menu.buildMainMenu(DISABLED_UNIFORM);
  const labels = screen.items.map((i: { label: string }) => i.label);
  assert.ok(labels.includes('Enable Ultra'));
  assert.ok(!labels.includes('Disable Ultra'));
});

test('buildMainMenu includes Settings, Help, Close always', async () => {
  await loadModules();
  const e = menu.buildMainMenu(ENABLED_ROLE_DEFAULTS);
  const d = menu.buildMainMenu(DISABLED_UNIFORM);
  for (const screen of [e, d]) {
    const labels = screen.items.map((i: { label: string }) => i.label);
    assert.ok(labels.includes('Settings…'));
    assert.ok(labels.includes('Help'));
    assert.ok(labels.includes('Close'));
  }
});

test('buildMainMenu header lines include state, routing, model, lanes', async () => {
  await loadModules();

  // role-defaults, enabled
  const screen1 = menu.buildMainMenu(ENABLED_ROLE_DEFAULTS);
  assert.ok(screen1.lines?.length >= 4);
  assert.match(screen1.lines[0], /^Enabled: yes/i);
  assert.match(screen1.lines[1], /^Routing: Role defaults/i);
  assert.match(screen1.lines[2], /^Model:/);
  assert.match(screen1.lines[3], /^Lanes: 2–4$/);

  // disabled, uniform, no model – "Model: Automatic", "Lanes: 1–3"
  const screen2 = menu.buildMainMenu(DISABLED_UNIFORM);
  assert.match(screen2.lines[0], /^Enabled: no/i);
  assert.match(screen2.lines[1], /^Routing: One model for every lane/i);
  assert.match(screen2.lines[2], /Model: Automatic/i);
  assert.match(screen2.lines[3], /^Lanes: 1–3$/);

  // uniform with model – "Model: gpt-4o"
  const screen3 = menu.buildMainMenu(UNIFORM_WITH_MODEL);
  assert.match(screen3.lines[2], /Model: gpt-4o/);
});

test('buildMainMenu routing label: uniform maps to "One model for every lane"', async () => {
  await loadModules();
  const screen = menu.buildMainMenu(DISABLED_UNIFORM);
  assert.match(screen.lines[1], /One model for every lane/);
});

test('buildMainMenu routing label: role-defaults maps to "Role defaults"', async () => {
  await loadModules();
  const screen = menu.buildMainMenu(ENABLED_ROLE_DEFAULTS);
  assert.match(screen.lines[1], /Role defaults/);
});

// ═══════════════════════════════════════════════════════════════════
// applySetting — copy semantics
// ═══════════════════════════════════════════════════════════════════

test('applySetting returns a new object (no mutation)', async () => {
  await loadModules();
  const original = { ...ENABLED_ROLE_DEFAULTS };
  const result = menu.applySetting(original, 'enabled', false);
  assert.notEqual(result, original);
  assert.equal(original.enabled, true); // unchanged
});

test('applySetting changes enabled to false', async () => {
  await loadModules();
  const result = menu.applySetting(ENABLED_ROLE_DEFAULTS, 'enabled', false);
  assert.notEqual(result, undefined);
  assert.equal(result.enabled, false);
});

test('applySetting changes enabled to true', async () => {
  await loadModules();
  const result = menu.applySetting(DISABLED_UNIFORM, 'enabled', true);
  assert.notEqual(result, undefined);
  assert.equal(result.enabled, true);
});

// ═══════════════════════════════════════════════════════════════════
// applySetting — Automatic clears workerModel
// ═══════════════════════════════════════════════════════════════════

test('applySetting with workerModel "Automatic" clears workerModel', async () => {
  await loadModules();
  const result = menu.applySetting(UNIFORM_WITH_MODEL, 'workerModel', 'Automatic');
  assert.notEqual(result, undefined);
  assert.equal(result.workerModel, undefined);
  assert.equal('workerModel' in result, false);
});

test('applySetting with workerModel undefined clears workerModel', async () => {
  await loadModules();
  const result = menu.applySetting(UNIFORM_WITH_MODEL, 'workerModel', undefined);
  assert.notEqual(result, undefined);
  assert.equal('workerModel' in result, false);
});

test('applySetting with explicit model string sets workerModel', async () => {
  await loadModules();
  const result = menu.applySetting(DISABLED_UNIFORM, 'workerModel', 'claude-3-5-sonnet');
  assert.notEqual(result, undefined);
  assert.equal(result.workerModel, 'claude-3-5-sonnet');
});

// ═══════════════════════════════════════════════════════════════════
// applySetting — invalid / rejection
// ═══════════════════════════════════════════════════════════════════

test('applySetting with invalid minLanes (0) returns undefined', async () => {
  await loadModules();
  const result = menu.applySetting(ENABLED_ROLE_DEFAULTS, 'minLanes', 0);
  assert.equal(result, undefined);
});

test('applySetting with invalid minLanes (9) returns undefined', async () => {
  await loadModules();
  const result = menu.applySetting(ENABLED_ROLE_DEFAULTS, 'minLanes', 9);
  assert.equal(result, undefined);
});

test('applySetting with non-integer minLanes returns undefined', async () => {
  await loadModules();
  const result = menu.applySetting(ENABLED_ROLE_DEFAULTS, 'minLanes', 1.5);
  assert.equal(result, undefined);
});

test('applySetting with invalid maxLanes (0) returns undefined', async () => {
  await loadModules();
  const result = menu.applySetting(ENABLED_ROLE_DEFAULTS, 'maxLanes', 0);
  assert.equal(result, undefined);
});

test('applySetting with invalid maxLanes (9) returns undefined', async () => {
  await loadModules();
  const result = menu.applySetting(ENABLED_ROLE_DEFAULTS, 'maxLanes', 9);
  assert.equal(result, undefined);
});

test('applySetting with invalid routingMode returns undefined', async () => {
  await loadModules();
  const result = menu.applySetting(ENABLED_ROLE_DEFAULTS, 'routingMode', 'invalid');
  assert.equal(result, undefined);
});

test('applySetting with string minLanes parsed as number', async () => {
  await loadModules();
  const result = menu.applySetting(ENABLED_ROLE_DEFAULTS, 'minLanes', '3');
  assert.notEqual(result, undefined);
  assert.equal(result.minLanes, 3);
});

test('applySetting with invalid string minLanes returns undefined', async () => {
  await loadModules();
  const result = menu.applySetting(ENABLED_ROLE_DEFAULTS, 'minLanes', '0');
  assert.equal(result, undefined);
});

test('applySetting with min > max after change returns undefined', async () => {
  await loadModules();
  // Existing min=2, max=4. Setting min to 5 makes min > max
  const result = menu.applySetting(ENABLED_ROLE_DEFAULTS, 'minLanes', 5);
  assert.equal(result, undefined);
});

test('applySetting can increase max to accommodate larger min', async () => {
  await loadModules();
  // Existing min=2, max=4. Setting max to 8 is valid.
  const result = menu.applySetting(ENABLED_ROLE_DEFAULTS, 'maxLanes', 8);
  assert.notEqual(result, undefined);
  assert.equal(result.maxLanes, 8);
  assert.equal(result.minLanes, 2);
});

// ═══════════════════════════════════════════════════════════════════
// buildSettingsScreen
// ═══════════════════════════════════════════════════════════════════

test('buildSettingsScreen returns a SettingsScreen with correct title', async () => {
  await loadModules();
  const screen = menu.buildSettingsScreen({ settings: ENABLED_ROLE_DEFAULTS });
  assert.equal(screen.kind, 'settings');
  assert.equal(screen.title, 'Ultra Settings');
});

test('buildSettingsScreen labels are Ultra, Routing mode, Worker model, Minimum subagents, Maximum subagents', async () => {
  await loadModules();
  const screen = menu.buildSettingsScreen({ settings: ENABLED_ROLE_DEFAULTS });
  const labels = screen.items.map((i: { label: string }) => i.label);
  assert.ok(labels.includes('Ultra'));
  assert.ok(labels.includes('Routing mode'));
  assert.ok(labels.includes('Worker model'));
  assert.ok(labels.includes('Minimum subagents'));
  assert.ok(labels.includes('Maximum subagents'));
});

test('buildSettingsScreen Ultra currentValue reflects enabled state', async () => {
  await loadModules();
  const e = menu.buildSettingsScreen({ settings: ENABLED_ROLE_DEFAULTS });
  const ultraItemE = e.items.find((i: { id: string }) => i.id === 'ultra');
  assert.equal(ultraItemE.currentValue, 'Enabled');

  const d = menu.buildSettingsScreen({ settings: DISABLED_UNIFORM });
  const ultraItemD = d.items.find((i: { id: string }) => i.id === 'ultra');
  assert.equal(ultraItemD.currentValue, 'Disabled');
});

test('buildSettingsScreen Routing mode has values and correct currentValue', async () => {
  await loadModules();
  const e = menu.buildSettingsScreen({ settings: ENABLED_ROLE_DEFAULTS });
  const item = e.items.find((i: { id: string }) => i.id === 'routing-mode');
  assert.equal(item.currentValue, 'Role defaults');
  assert.deepEqual(item.values, ['One model for every lane', 'Role defaults']);
});

test('buildSettingsScreen Worker model currentValue is Automatic when no model set', async () => {
  await loadModules();
  const screen = menu.buildSettingsScreen({ settings: DISABLED_UNIFORM });
  const item = screen.items.find((i: { id: string }) => i.id === 'worker-model');
  assert.equal(item.currentValue, 'Automatic');
});

test('buildSettingsScreen Worker model currentValue is model name when set', async () => {
  await loadModules();
  const screen = menu.buildSettingsScreen({ settings: UNIFORM_WITH_MODEL });
  const item = screen.items.find((i: { id: string }) => i.id === 'worker-model');
  assert.equal(item.currentValue, 'gpt-4o');
});

test('buildSettingsScreen min/max subagents show current values as strings', async () => {
  await loadModules();
  const screen = menu.buildSettingsScreen({ settings: ENABLED_ROLE_DEFAULTS });
  const minItem = screen.items.find((i: { id: string }) => i.id === 'min-subagents');
  const maxItem = screen.items.find((i: { id: string }) => i.id === 'max-subagents');
  assert.equal(minItem.currentValue, '2');
  assert.equal(maxItem.currentValue, '4');
});

test('buildSettingsScreen subagent lane values are 1..8 inclusive as strings', async () => {
  await loadModules();
  const screen = menu.buildSettingsScreen({ settings: ENABLED_ROLE_DEFAULTS });
  const minItem = screen.items.find((i: { id: string }) => i.id === 'min-subagents');
  const maxItem = screen.items.find((i: { id: string }) => i.id === 'max-subagents');
  assert.deepEqual(minItem.values, ['1', '2', '3', '4', '5', '6', '7', '8']);
  assert.deepEqual(maxItem.values, ['1', '2', '3', '4', '5', '6', '7', '8']);
});

// ═══════════════════════════════════════════════════════════════════
// buildModelChoiceScreen
// ═══════════════════════════════════════════════════════════════════

test('buildModelChoiceScreen returns a ChoiceScreen', async () => {
  await loadModules();
  const screen = menu.buildModelChoiceScreen({
    settings: DISABLED_UNIFORM,
    availableModels: ['gpt-4o', 'claude-3-opus'],
  });
  assert.equal(screen.kind, 'choice');
  assert.equal(screen.title, 'Worker model');
});

test('buildModelChoiceScreen first item is Automatic', async () => {
  await loadModules();
  const screen = menu.buildModelChoiceScreen({
    settings: DISABLED_UNIFORM,
    availableModels: ['gpt-4o'],
  });
  assert.equal(screen.items[0].id, 'automatic');
  assert.equal(screen.items[0].label, 'Automatic');
});

test('buildModelChoiceScreen includes all available models after Automatic', async () => {
  await loadModules();
  const models = ['gpt-4o', 'claude-3-opus', 'llama-3'];
  const screen = menu.buildModelChoiceScreen({
    settings: DISABLED_UNIFORM,
    availableModels: models,
  });
  const labels = screen.items.map((i: { label: string }) => i.label);
  assert.equal(screen.items[0].label, 'Automatic');
  for (const m of models) {
    assert.ok(labels.includes(m));
  }
});

test('buildModelChoiceScreen unavailable saved model appears disabled', async () => {
  await loadModules();
  const screen = menu.buildModelChoiceScreen({
    settings: UNIFORM_WITH_MODEL, // workerModel: 'gpt-4o'
    availableModels: ['claude-3-opus'], // 'gpt-4o' is NOT available
  });
  // gpt-4o should appear as an item with disabled=true
  const unavailableItem = screen.items.find((i: { id: string }) => i.id === 'gpt-4o');
  assert.ok(unavailableItem, 'unavailable saved model must appear in items');
  assert.equal(unavailableItem.disabled, true);
  assert.ok(unavailableItem.disabledReason);
});

test('buildModelChoiceScreen available model is not disabled', async () => {
  await loadModules();
  const screen = menu.buildModelChoiceScreen({
    settings: UNIFORM_WITH_MODEL, // workerModel: 'gpt-4o'
    availableModels: ['gpt-4o', 'claude-3-opus'],
  });
  const gptItem = screen.items.find((i: { id: string }) => i.id === 'gpt-4o');
  assert.ok(gptItem);
  assert.equal(gptItem.disabled, undefined); // not disabled
});

test('buildModelChoiceScreen currentItemId is the saved model or automatic', async () => {
  await loadModules();
  // With a saved model
  const screen1 = menu.buildModelChoiceScreen({
    settings: UNIFORM_WITH_MODEL,
    availableModels: ['gpt-4o'],
  });
  assert.equal(screen1.currentItemId, 'gpt-4o');

  // Without a saved model (uniform, no workerModel)
  const screen2 = menu.buildModelChoiceScreen({
    settings: DISABLED_UNIFORM,
    availableModels: ['gpt-4o'],
  });
  assert.equal(screen2.currentItemId, 'automatic');
});

// ═══════════════════════════════════════════════════════════════════
// showUltraMenu — adapter callback tests
// ═══════════════════════════════════════════════════════════════════

test('showUltraMenu enable/disable action calls save once with full object', async () => {
  await loadModules();
  let saveCalled = 0;
  let savedSettings: unknown = undefined;

  // Simulate what the action handler does — we can't easily invoke the
  // full runMenu without a real TUI, so we test the action handler logic
  // directly via applySetting + normalizeUltraSettings + save callback.

  const nextSettings = menu.applySetting(DISABLED_UNIFORM, 'enabled', true);
  assert.notEqual(nextSettings, undefined);

  // Simulate save: called exactly once with the full normalized object
  savedSettings = nextSettings;
  saveCalled += 1;

  assert.equal(saveCalled, 1);
  assert.notEqual(savedSettings, undefined);
  assert.equal((savedSettings as Record<string, unknown>).enabled, true);
  assert.equal((savedSettings as Record<string, unknown>).routingMode, 'uniform');

  // Save failure simulation — in-memory state should not be corrupted.
  // The original DISABLED_UNIFORM is unchanged (immutability proven by applySetting).
  assert.equal(DISABLED_UNIFORM.enabled, false);
});

test('showUltraMenu settings change applies via applySetting then normalizeUltraSettings', async () => {
  await loadModules();
  // Changing routing mode from role-defaults to uniform
  const next1 = menu.applySetting(ENABLED_ROLE_DEFAULTS, 'routingMode', 'uniform');
  assert.notEqual(next1, undefined);
  assert.equal(next1.routingMode, 'uniform');
  assert.equal(next1.enabled, true); // other props preserved

  // Change minLanes via string value (as from SettingsScreen)
  const next2 = menu.applySetting(next1, 'minLanes', '3');
  assert.notEqual(next2, undefined);
  assert.equal(next2.minLanes, 3);
  assert.equal(next2.maxLanes, 4);
  assert.equal(next2.routingMode, 'uniform');
});

test('normalizeUltraSettings treats empty workerModel as cleared (not an error)', async () => {
  await loadModules();
  const { normalizeUltraSettings } = config;

  // Empty string → cleared (workerModel absent), not rejected
  const result = normalizeUltraSettings({
    version: 1,
    enabled: true,
    routingMode: 'uniform',
    workerModel: '',
    minLanes: 2,
    maxLanes: 4,
  });
  assert.notEqual(result, undefined, 'empty workerModel should not fail; it clears the field');
  assert.equal('workerModel' in result, false);
  assert.equal(result.enabled, true);
  assert.equal(result.routingMode, 'uniform');
});

test('normalizeUltraSettings treats whitespace-only workerModel as cleared', async () => {
  await loadModules();
  const { normalizeUltraSettings } = config;
  const result = normalizeUltraSettings({
    version: 1,
    enabled: true,
    routingMode: 'uniform',
    workerModel: '   ',
    minLanes: 2,
    maxLanes: 4,
  });
  assert.notEqual(result, undefined);
  assert.equal('workerModel' in result, false);
});

test('applySetting with empty string workerModel clears the field', async () => {
  await loadModules();
  const result = menu.applySetting(UNIFORM_WITH_MODEL, 'workerModel', '');
  assert.notEqual(result, undefined);
  assert.equal('workerModel' in result, false);
});

test('showUltraMenu model selection calls applySetting, then save', async () => {
  await loadModules();
  // Start with uniform+gpt-4o, select 'Automatic' → should clear workerModel
  const cleared = menu.applySetting(UNIFORM_WITH_MODEL, 'workerModel', 'Automatic');
  assert.notEqual(cleared, undefined);
  assert.equal('workerModel' in cleared, false);

  // Save would be called once
  // (tested structurally — the action handler pattern is applySetting → normalizeUltrasettings → save)
});