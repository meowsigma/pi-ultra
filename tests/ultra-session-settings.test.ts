import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';

// ── module under test ──────────────────────────────────────────────
import {
  ULTRA_SESSION_SETTINGS_CUSTOM_TYPE,
  appendSessionUltraOverrides,
  clearSessionUltraOverrides,
  resolveEffectiveUltraSettings,
  scanSessionUltraOverrides,
  validateUltraSessionOverrides,
  type SessionOverrideDiagnostic,
  type SessionOverridesScanResult,
  type UltraSessionOverrides,
} from '../extensions/ultra-session-settings.js';
import { DEFAULT_ULTRA_SETTINGS, effectiveUniformModel, type UltraSettings } from '../extensions/ultra-config.js';
import type { CustomEntry } from '@earendil-works/pi-coding-agent';

// ── helpers ────────────────────────────────────────────────────────
let nextId = 0;

function customEntry(customType: string, data: unknown, id?: string): CustomEntry {
  nextId += 1;
  return {
    type: 'custom',
    customType,
    id: id ?? `entry-${nextId}-${randomUUID().slice(0, 8)}`,
    parentId: null,
    timestamp: new Date(0).toISOString(),
    data,
  };
}

function sessionEntry(patch: unknown, id?: string): CustomEntry {
  return customEntry(ULTRA_SESSION_SETTINGS_CUSTOM_TYPE, { version: 1, patch }, id);
}

function globalSettings(overrides: Partial<UltraSettings> = {}): UltraSettings {
  return { ...DEFAULT_ULTRA_SETTINGS, ...overrides };
}

function ignoreReasons(scan: SessionOverridesScanResult): string[] {
  return scan.ignored.map((d: SessionOverrideDiagnostic) => d.reason);
}

type AppendSpy = { calls: Array<{ customType: string; data: unknown }> };
function appendSpy(): AppendSpy & ((customType: string, data?: unknown) => void) {
  const spy: AppendSpy = { calls: [] };
  const fn = (customType: string, data?: unknown) => {
    spy.calls.push({ customType, data });
  };
  return Object.assign(fn, { calls: spy.calls });
}

// ── CUSTOM TYPE CONSTANT ───────────────────────────────────────────
test('custom-entry type constant is the non-model-visible journal identifier', () => {
  assert.equal(ULTRA_SESSION_SETTINGS_CUSTOM_TYPE, 'pi-ultra-session-settings');
});

// ── VALIDATION ─────────────────────────────────────────────────────
test('validate accepts declared optional fields and trims provider-qualified models', () => {
  const patch = validateUltraSessionOverrides({
    enabled: false,
    routingMode: 'uniform',
    orchestrationMode: 'manager',
    workerModel: '  openai/gpt-5.6-sol  ',
    minLanes: 2,
    maxLanes: 6,
  });
  assert.deepEqual(patch, {
    enabled: false,
    routingMode: 'uniform',
    orchestrationMode: 'manager',
    workerModel: 'openai/gpt-5.6-sol',
    minLanes: 2,
    maxLanes: 6,
  });
  const empty = validateUltraSessionOverrides({});
  assert.deepEqual(empty, {});
});

test('validate rejects unknown fields, bad types, bad routing, invalid models, non-objects', () => {
  assert.throws(() => validateUltraSessionOverrides(null), /object/i);
  assert.throws(() => validateUltraSessionOverrides('nope'), /object/i);
  assert.throws(() => validateUltraSessionOverrides([1]), /object/i);
  assert.throws(() => validateUltraSessionOverrides({ version: 1 }), /Unsupported|unknown/i);
  assert.throws(() => validateUltraSessionOverrides({ extra: true }), /extra/i);
  assert.throws(() => validateUltraSessionOverrides({ enabled: 'yes' }), /enabled/i);
  assert.throws(() => validateUltraSessionOverrides({ routingMode: 'chaos' }), /routingMode/i);
  assert.throws(() => validateUltraSessionOverrides({ orchestrationMode: 'swarm' }), /orchestrationMode/i);
  assert.throws(() => validateUltraSessionOverrides({ workerModel: 42 }), /workerModel/i);
  assert.throws(() => validateUltraSessionOverrides({ workerModel: '' }), /workerModel/i);
  assert.throws(() => validateUltraSessionOverrides({ workerModel: '   ' }), /workerModel/i);
  assert.throws(() => validateUltraSessionOverrides({ workerModel: 'bare-model' }), /workerModel/i);
  assert.throws(() => validateUltraSessionOverrides({ workerModel: 'openai/model with space' }), /workerModel/i);
  assert.throws(() => validateUltraSessionOverrides({ minLanes: 0, maxLanes: 4 }), /minLanes/i);
  assert.throws(() => validateUltraSessionOverrides({ minLanes: 2, maxLanes: 101 }), /maxLanes/i);
  assert.throws(() => validateUltraSessionOverrides({ minLanes: 5, maxLanes: 3 }), /maxLanes|minLanes/i);
});

test('incomplete lane ranges are rejected one-sided', () => {
  assert.throws(() => validateUltraSessionOverrides({ minLanes: 5 }), /both|minLanes|maxLanes/i);
  assert.throws(() => validateUltraSessionOverrides({ maxLanes: 3 }), /both|minLanes|maxLanes/i);
  // Paired bounds stay inside 1..100 and ordered
  assert.doesNotThrow(() => validateUltraSessionOverrides({ minLanes: 1, maxLanes: 100 }));
  assert.doesNotThrow(() => validateUltraSessionOverrides({ minLanes: 4, maxLanes: 4 }));
});

test('null workerModel is accepted as explicit Automatic', () => {
  assert.deepEqual(validateUltraSessionOverrides({ workerModel: null }), { workerModel: null });
});

// ── SCAN ───────────────────────────────────────────────────────────
test('latest valid snapshot wins over earlier snapshots', () => {
  const entries = [
    sessionEntry({ routingMode: 'uniform' }),
    sessionEntry({ enabled: false, minLanes: 1, maxLanes: 2 }),
  ];
  const scan = scanSessionUltraOverrides(entries);
  assert.deepEqual(scan.patch, { enabled: false, minLanes: 1, maxLanes: 2 });
  assert.equal(scan.ignoredCount, 0);
  assert.deepEqual(scan.ignored, []);
});

test('a later malformed entry does not shadow the previous valid snapshot', () => {
  const entries = [
    sessionEntry({ routingMode: 'uniform' }),
    sessionEntry({ routingMode: 'bogus' }, 'bad-1'),
  ];
  const scan = scanSessionUltraOverrides(entries);
  assert.deepEqual(scan.patch, { routingMode: 'uniform' });
  assert.equal(scan.ignoredCount, 1);
  assert.equal(scan.ignored[0].id, 'bad-1');
});

test('valid empty patch is an explicit reset back to inherit-global', () => {
  const entries = [
    sessionEntry({ enabled: false, workerModel: 'openai/gpt-4o' }),
    sessionEntry({}),
  ];
  const scan = scanSessionUltraOverrides(entries);
  assert.deepEqual(scan.patch, {});
  const effective = resolveEffectiveUltraSettings(globalSettings(), scan.patch);
  assert.deepEqual(effective, DEFAULT_ULTRA_SETTINGS);
});

test('malformed and unknown entries are safely ignored with bounded diagnostics', () => {
  const malformed: unknown[] = [
    'not-an-entry',
    customEntry(ULTRA_SESSION_SETTINGS_CUSTOM_TYPE, undefined),
    customEntry(ULTRA_SESSION_SETTINGS_CUSTOM_TYPE, null),
    customEntry(ULTRA_SESSION_SETTINGS_CUSTOM_TYPE, 'nope'),
    customEntry(ULTRA_SESSION_SETTINGS_CUSTOM_TYPE, { patch: {} }),
    customEntry(ULTRA_SESSION_SETTINGS_CUSTOM_TYPE, { version: 2, patch: {} }),
    customEntry(ULTRA_SESSION_SETTINGS_CUSTOM_TYPE, { version: 1, patch: { bogus: 1 } }),
    customEntry(ULTRA_SESSION_SETTINGS_CUSTOM_TYPE, { version: 1, patch: { minLanes: 3 } }),
    customEntry(ULTRA_SESSION_SETTINGS_CUSTOM_TYPE, { version: 1, patch: { workerModel: 'bare' } }),
    // Unknown entry kinds are skipped entirely
    customEntry('some-other-extension', { version: 1, patch: {} }),
    { type: 'message', id: 'm1', parentId: null, timestamp: '', message: {} },
  ];
  const scan = scanSessionUltraOverrides(malformed);
  assert.deepEqual(scan.patch, {});
  assert.equal(scan.ignoredCount, 8, 'only malformed pi-ultra-session entries are diagnosed');
  for (const diagnostic of scan.ignored) {
    assert.equal(typeof diagnostic.id, 'string');
    assert.ok(diagnostic.reason.length > 0);
    assert.ok(diagnostic.reason.length <= 512, 'diagnostics are bounded');
  }
});

test('scan never throws on adversarial entry shapes', () => {
  assert.doesNotThrow(() =>
    scanSessionUltraOverrides([
      null,
      42,
      {},
      { type: 'custom' },
      { type: 'custom', customType: ULTRA_SESSION_SETTINGS_CUSTOM_TYPE, id: 7, data: Symbol('x') },
      [1, 2, 3],
    ] as unknown[]),
  );
});

test('same-type entry with Symbol version is ignored without throwing', () => {
  const goodEntry = customEntry(ULTRA_SESSION_SETTINGS_CUSTOM_TYPE, { version: 1, patch: { enabled: false } }, 'good-1');
  const scan = scanSessionUltraOverrides([
    goodEntry,
    customEntry(ULTRA_SESSION_SETTINGS_CUSTOM_TYPE, { version: Symbol('x'), patch: {} }, 'sym-1'),
  ]);
  assert.doesNotThrow(() => scanSessionUltraOverrides([customEntry(ULTRA_SESSION_SETTINGS_CUSTOM_TYPE, { version: Symbol('x'), patch: {} })]));
  assert.deepEqual(scan.patch, { enabled: false }, 'the valid snapshot before the malformed one still wins');
  assert.equal(scan.ignoredCount, 1);
  assert.equal(scan.ignored[0].id, 'sym-1');
  assert.ok(scan.ignored[0].reason.length > 0);
  assert.ok(/version/i.test(scan.ignored[0].reason), 'diagnostic mentions the unsupported version');
});

// ── RESOLVER ───────────────────────────────────────────────────────
test('session overrides touch only declared fields', () => {
  const global = globalSettings({ workerModel: 'anthropic/claude-opus' });
  const effective = resolveEffectiveUltraSettings(global, { routingMode: 'uniform', workerModel: 'openai/gpt-5.6-sol' });
  assert.equal(effective.routingMode, 'uniform');
  assert.equal(effective.workerModel, 'openai/gpt-5.6-sol');
  assert.equal(effective.enabled, true, 'undeclared fields inherit global');
  assert.equal(effective.minLanes, 2);
  assert.equal(effective.maxLanes, 4);
});

test('null workerModel defeats the global selected model so uniform selection is Automatic', () => {
  const global = globalSettings({ routingMode: 'uniform', workerModel: 'anthropic/claude-opus' });
  const effective = resolveEffectiveUltraSettings(global, { workerModel: null });
  assert.equal('workerModel' in effective, false);
  assert.equal(effectiveUniformModel(effective), 'automatic');
});

test('absent workerModel inherits the global selected model', () => {
  const global = globalSettings({ routingMode: 'uniform', workerModel: 'anthropic/claude-opus' });
  const effective = resolveEffectiveUltraSettings(global, { enabled: false });
  assert.equal(effective.workerModel, 'anthropic/claude-opus');
  assert.equal(effective.enabled, false);
});

test('resolver throws on invalid effective state instead of returning garbage', () => {
  const brokenGlobal = { version: 1, enabled: true, routingMode: 'role-defaults', minLanes: 6, maxLanes: 2 } as unknown as UltraSettings;
  assert.throws(() => resolveEffectiveUltraSettings(brokenGlobal, {}));
});

test('resolver does not mutate its inputs', () => {
  const global = globalSettings({ routingMode: 'uniform', workerModel: 'anthropic/claude-opus' });
  const globalCopy = { ...global };
  const patch: UltraSessionOverrides = { workerModel: null, enabled: false, minLanes: 1, maxLanes: 8 };
  const patchCopy = { ...patch };
  const effective = resolveEffectiveUltraSettings(global, patch);
  assert.deepEqual(global, globalCopy);
  assert.deepEqual(patch, patchCopy);
  assert.notEqual(effective, global, 'resolver returns a fresh settings object');
  assert.notEqual(effective, patchCopy);
});

test('validated patch objects are fresh copies, not caller references', () => {
  const input = { enabled: false };
  const validated = validateUltraSessionOverrides(input);
  assert.notEqual(validated, input);
  assert.deepEqual(validated, { enabled: false });
});

// ── APPEND / CLEAR ─────────────────────────────────────────────────
test('appendSessionUltraOverrides appends exactly one immutable journal entry', () => {
  const append = appendSpy();
  const patch: UltraSessionOverrides = { enabled: false, minLanes: 2, maxLanes: 3 };
  appendSessionUltraOverrides(append, patch);

  assert.equal(append.calls.length, 1);
  const call = append.calls[0];
  assert.equal(call.customType, ULTRA_SESSION_SETTINGS_CUSTOM_TYPE);
  assert.deepEqual(call.data, { version: 1, patch: { enabled: false, minLanes: 2, maxLanes: 3 } });

  const data = call.data as { version: number; patch: UltraSessionOverrides };
  assert.ok(Object.isFrozen(data), 'appended snapshot is immutable');
  assert.ok(Object.isFrozen(data.patch));
});

test('appended snapshots are decoupled from later caller mutations', () => {
  const append = appendSpy();
  const patch: UltraSessionOverrides = { routingMode: 'uniform' };
  appendSessionUltraOverrides(append, patch);
  patch.routingMode = 'role-defaults';
  const appended = append.calls[0].data as { patch: UltraSessionOverrides };
  assert.equal(appended.patch.routingMode, 'uniform');

  assert.throws(() => {
    'use strict';
    (append.calls[0].data as { version: number }).version = 2;
  }, TypeError);
});

test('appendSessionUltraOverrides refuses invalid patches', () => {
  const append = appendSpy();
  assert.throws(() => appendSessionUltraOverrides(append, { minLanes: 5 } as UltraSessionOverrides));
  assert.throws(() => appendSessionUltraOverrides(append, { workerModel: 'bare' } as UltraSessionOverrides));
  assert.equal(append.calls.length, 0, 'nothing is appended for invalid patches');
});

test('clearSessionUltraOverrides appends an explicit empty-patch reset entry', () => {
  const append = appendSpy();
  clearSessionUltraOverrides(append);
  assert.equal(append.calls.length, 1);
  const call = append.calls[0];
  assert.equal(call.customType, ULTRA_SESSION_SETTINGS_CUSTOM_TYPE);
  assert.deepEqual(call.data, { version: 1, patch: {} });
  const data = call.data as { patch: UltraSessionOverrides };
  assert.ok(Object.isFrozen(data.patch));
});

// ── END-TO-END JOURNAL SEMANTICS ───────────────────────────────────
test('journal replay matches resolver expectations end-to-end', () => {
  const append = appendSpy();
  appendSessionUltraOverrides(append, { routingMode: 'uniform', workerModel: 'openai/gpt-5.6-sol', minLanes: 1, maxLanes: 8 });
  appendSessionUltraOverrides(append, { workerModel: null });
  appendSessionUltraOverrides(append, { minLanes: 3, maxLanes: 3 });
  clearSessionUltraOverrides(append);

  const entries = append.calls.map((call) => customEntry(call.customType, call.data));
  const scan = scanSessionUltraOverrides(entries);
  assert.deepEqual(scan.patch, {});
  const effective = resolveEffectiveUltraSettings(globalSettings({ routingMode: 'uniform', workerModel: 'openai/gpt-5.6-sol' }), scan.patch);
  assert.equal(effective.workerModel, 'openai/gpt-5.6-sol');
});
