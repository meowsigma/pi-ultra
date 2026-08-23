import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

// ── module under test ──────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ultra: any;
async function loadUltraModule() {
  ultra = await import('../extensions/ultra-config.js');
}

// ── helpers ────────────────────────────────────────────────────────
async function tmpDir(): Promise<string> {
  const d = join(import.meta.dirname, '..', '.test-tmp', randomUUID());
  await mkdir(d, { recursive: true });
  return d;
}

async function writeSettings(dir: string, data: unknown): Promise<string> {
  const p = join(dir, 'pi-ultra.json');
  await writeFile(p, JSON.stringify(data, null, 2));
  return p;
}

// ── BASIC EXPORTS ──────────────────────────────────────────────────
test('module exports all required symbols', async () => {
  await loadUltraModule();

  assert.equal(ultra.ULTRA_CONFIG_VERSION, 1);
  assert.equal(ultra.ULTRA_MIN_LANES, 1);
  assert.equal(ultra.ULTRA_MAX_LANES, 8);
  assert.deepEqual(ultra.ULTRA_ROLE_NAMES, ['scout', 'worker', 'reviewer']);
  assert.equal(ultra.ULTRA_SETTINGS_FILE, 'pi-ultra.json');

  assert.deepEqual(ultra.DEFAULT_ULTRA_SETTINGS, {
    version: 1,
    enabled: true,
    routingMode: 'role-defaults',
    minLanes: 2,
    maxLanes: 4,
  });

  assert.equal(typeof ultra.normalizeUltraSettings, 'function');
  assert.equal(typeof ultra.loadUltraSettings, 'function');
  assert.equal(typeof ultra.saveUltraSettings, 'undefined');
  assert.equal(typeof ultra.updateUltraSettings, 'function');
  assert.equal(typeof ultra.effectiveUniformModel, 'function');
  assert.equal(typeof ultra.UltraSettings, 'undefined'); // interface only
});

// ── NORMALIZE — VALID ─────────────────────────────────────────────
test('normalizeUltraSettings fills defaults for partial object', async () => {
  await loadUltraModule();
  const { normalizeUltraSettings } = ultra;

  // Empty object → full defaults
  const r1 = normalizeUltraSettings({});
  assert.notEqual(r1, undefined);
  assert.equal(r1.version, 1);
  assert.equal(r1.enabled, true);
  assert.equal(r1.routingMode, 'role-defaults');
  assert.equal(r1.minLanes, 2);
  assert.equal(r1.maxLanes, 4);
  assert.equal('workerModel' in r1, false);

  // Partial overrides
  const r2 = normalizeUltraSettings({ enabled: false, maxLanes: 6 });
  assert.notEqual(r2, undefined);
  assert.equal(r2.enabled, false);
  assert.equal(r2.maxLanes, 6);
  assert.equal(r2.minLanes, 2);
  assert.equal(r2.routingMode, 'role-defaults');

  // workerModel absent when whitespace-only or not supplied
  const r3 = normalizeUltraSettings({ workerModel: '  ' });
  assert.notEqual(r3, undefined);
  assert.equal('workerModel' in r3, false);

  const r4 = normalizeUltraSettings({ workerModel: 'openai/gpt-4o' });
  assert.notEqual(r4, undefined);
  assert.equal(r4.workerModel, 'openai/gpt-4o');

  // Trimmed canonical id
  const r5 = normalizeUltraSettings({ workerModel: '  anthropic/claude-3  ' });
  assert.notEqual(r5, undefined);
  assert.equal(r5.workerModel, 'anthropic/claude-3');

  // valid routing modes
  const u = normalizeUltraSettings({ routingMode: 'uniform' });
  assert.notEqual(u, undefined);
  assert.equal(u.routingMode, 'uniform');

  const rd = normalizeUltraSettings({ routingMode: 'role-defaults' });
  assert.notEqual(rd, undefined);
  assert.equal(rd.routingMode, 'role-defaults');

  // Equal min/max allowed
  const eq = normalizeUltraSettings({ minLanes: 8, maxLanes: 8 });
  assert.notEqual(eq, undefined);
  assert.equal(eq.minLanes, 8);
  assert.equal(eq.maxLanes, 8);
});

// ── NORMALIZE — INVALID (returns undefined, never throws) ─────────
test('normalizeUltraSettings returns undefined for invalid inputs', async () => {
  await loadUltraModule();
  const { normalizeUltraSettings } = ultra;

  // Non-object types
  assert.equal(normalizeUltraSettings(null), undefined);
  assert.equal(normalizeUltraSettings([1, 2, 3]), undefined);
  assert.equal(normalizeUltraSettings('hello'), undefined);
  assert.equal(normalizeUltraSettings(42), undefined);
  assert.equal(normalizeUltraSettings(true), undefined);
  assert.equal(normalizeUltraSettings(undefined), undefined);

  // Bad version
  assert.equal(normalizeUltraSettings({ version: 2 }), undefined);
  assert.equal(normalizeUltraSettings({ version: 0 }), undefined);

  // Bad enabled
  assert.equal(normalizeUltraSettings({ enabled: 1 }), undefined);
  assert.equal(normalizeUltraSettings({ enabled: 'yes' }), undefined);

  // Bad routingMode
  assert.equal(normalizeUltraSettings({ routingMode: 'invalid' }), undefined);

  // Bad workerModel
  assert.equal(normalizeUltraSettings({ workerModel: 123 }), undefined);

  // min/max out of range
  assert.equal(normalizeUltraSettings({ minLanes: 0 }), undefined);
  assert.equal(normalizeUltraSettings({ minLanes: 9 }), undefined);
  assert.equal(normalizeUltraSettings({ maxLanes: 0 }), undefined);
  assert.equal(normalizeUltraSettings({ maxLanes: 9 }), undefined);

  // non-integer lanes
  assert.equal(normalizeUltraSettings({ minLanes: 1.5 }), undefined);
  assert.equal(normalizeUltraSettings({ maxLanes: 1.5 }), undefined);

  // Reversed ranges
  assert.equal(normalizeUltraSettings({ minLanes: 5, maxLanes: 3 }), undefined);
  assert.equal(normalizeUltraSettings({ minLanes: 7, maxLanes: 4 }), undefined);
  assert.equal(normalizeUltraSettings({ minLanes: 4, maxLanes: 2 }), undefined);
});

// ── EFFECTIVE UNIFORM MODEL ───────────────────────────────────────
test('effectiveUniformModel returns correct values', async () => {
  await loadUltraModule();
  const { effectiveUniformModel } = ultra;

  // role-defaults → undefined
  assert.equal(effectiveUniformModel({ routingMode: 'role-defaults' } as any), undefined);
  assert.equal(effectiveUniformModel({ routingMode: 'role-defaults', workerModel: 'gpt-4o' } as any), undefined);

  // uniform, no workerModel → 'automatic'
  assert.equal(effectiveUniformModel({ routingMode: 'uniform' } as any), 'automatic');
  assert.equal(effectiveUniformModel({ routingMode: 'uniform', workerModel: undefined } as any), 'automatic');

  // uniform, with workerModel → the model string
  assert.equal(effectiveUniformModel({ routingMode: 'uniform', workerModel: 'gpt-4o' } as any), 'gpt-4o');
  assert.equal(effectiveUniformModel({ routingMode: 'uniform', workerModel: 'claude-3-5-sonnet' } as any), 'claude-3-5-sonnet');
});

// ── LOAD – MISSING ────────────────────────────────────────────────
test('loadUltraSettings returns kind:missing when file does not exist', async () => {
  await loadUltraModule();
  const { loadUltraSettings, DEFAULT_ULTRA_SETTINGS } = ultra;

  const dir = await tmpDir();
  const result = await loadUltraSettings(join(dir, 'nonexistent.json'));
  assert.equal(result.kind, 'missing');
  assert.deepEqual(result.settings, DEFAULT_ULTRA_SETTINGS);
  assert.notEqual(result.settings, DEFAULT_ULTRA_SETTINGS);
  assert.equal(result.settings.version, 1);
  await rm(dir, { recursive: true, force: true });
});

// ── LOAD – VALID ──────────────────────────────────────────────────
test('loadUltraSettings returns kind:loaded for valid file', async () => {
  await loadUltraModule();
  const { loadUltraSettings } = ultra;

  const dir = await tmpDir();
  const p = await writeSettings(dir, { version: 1, enabled: false, routingMode: 'uniform', minLanes: 3, maxLanes: 5 });

  const result = await loadUltraSettings(p);
  assert.equal(result.kind, 'loaded');
  assert.equal(result.settings.enabled, false);
  assert.equal(result.settings.routingMode, 'uniform');
  assert.equal(result.settings.minLanes, 3);
  assert.equal(result.settings.maxLanes, 5);
  await rm(dir, { recursive: true, force: true });
});

// ── LOAD – INVALID JSON ───────────────────────────────────────────
test('loadUltraSettings returns kind:invalid for malformed JSON', async () => {
  await loadUltraModule();
  const { loadUltraSettings, DEFAULT_ULTRA_SETTINGS } = ultra;

  const dir = await tmpDir();
  const p = join(dir, 'pi-ultra.json');
  await writeFile(p, 'this is not json');

  const result = await loadUltraSettings(p);
  assert.equal(result.kind, 'invalid');
  assert.ok(result.reason);
  assert.equal('settings' in result, false);

  // Original bytes must be preserved
  const bytes = await readFile(p, 'utf8');
  assert.equal(bytes, 'this is not json');
  await rm(dir, { recursive: true, force: true });
});

// ── LOAD – INVALID SHAPE ──────────────────────────────────────────
test('loadUltraSettings returns kind:invalid for invalid shape (bad version)', async () => {
  await loadUltraModule();
  const { loadUltraSettings, DEFAULT_ULTRA_SETTINGS } = ultra;

  const dir = await tmpDir();
  const p = await writeSettings(dir, { version: 99, enabled: true, routingMode: 'uniform', minLanes: 2, maxLanes: 4 });

  const result = await loadUltraSettings(p);
  assert.equal(result.kind, 'invalid');
  assert.ok(result.reason);
  assert.equal('settings' in result, false);

  // File must not be overwritten
  const saved = JSON.parse(await readFile(p, 'utf8'));
  assert.equal(saved.version, 99);
  await rm(dir, { recursive: true, force: true });
});

// ── TRANSACTIONAL UPDATE VALIDATION ───────────────────────────────
test('updateUltraSettings rejects invalid patches and preserves invalid files', async () => {
  await loadUltraModule();
  const { updateUltraSettings } = ultra;
  const dir = await tmpDir();
  const p = join(dir, 'pi-ultra.json');
  await assert.rejects(() => updateUltraSettings({ version: 99 } as any, p));
  await assert.rejects(() => updateUltraSettings({ enabled: 'yes' } as any, p));
  await assert.rejects(() => updateUltraSettings({ minLanes: 0 } as any, p));
  await writeFile(p, 'broken json{{{');
  await assert.rejects(() => updateUltraSettings({ enabled: true }, p));
  assert.equal(await readFile(p, 'utf8'), 'broken json{{{');
  await rm(dir, { recursive: true, force: true });
});

test('transactional update then load returns committed settings and preserves unknown fields', async () => {
  await loadUltraModule();
  const { updateUltraSettings, loadUltraSettings } = ultra;
  const dir = await tmpDir();
  const p = join(dir, 'pi-ultra.json');
  await writeFile(p, JSON.stringify({
    version: 1, enabled: true, routingMode: 'role-defaults', minLanes: 2, maxLanes: 4,
    customField: 'keep-me', anotherExtra: { nested: true },
  }));
  await updateUltraSettings({ enabled: false, routingMode: 'uniform', minLanes: 1, maxLanes: 3, workerModel: 'openai/gpt-4o' }, p);
  const result = await loadUltraSettings(p);
  assert.equal(result.kind, 'loaded');
  assert.deepEqual(result.settings, { version: 1, enabled: false, routingMode: 'uniform', minLanes: 1, maxLanes: 3, workerModel: 'openai/gpt-4o' });
  const saved = JSON.parse(await readFile(p, 'utf8'));
  assert.equal(saved.customField, 'keep-me');
  assert.deepEqual(saved.anotherExtra, { nested: true });
  await rm(dir, { recursive: true, force: true });
});

// ── AUTOMATIC DISTINCTIONS ────────────────────────────────────────
test('Automatic behavior distinctions shown exactly', async () => {
  await loadUltraModule();
  const { normalizeUltraSettings, effectiveUniformModel } = ultra;

  // default (role-defaults) → workerModel absent, effectiveUniformModel undefined
  const def = normalizeUltraSettings({});
  assert.notEqual(def, undefined);
  assert.equal('workerModel' in def, false);
  assert.equal(effectiveUniformModel(def), undefined);

  // uniform without explicit workerModel → workerModel absent, effective 'automatic'
  const uniNoModel = normalizeUltraSettings({ routingMode: 'uniform' });
  assert.notEqual(uniNoModel, undefined);
  assert.equal('workerModel' in uniNoModel, false);
  assert.equal(effectiveUniformModel(uniNoModel), 'automatic');

  // uniform WITH workerModel → workerModel present, effective equals it
  const uniWithModel = normalizeUltraSettings({ routingMode: 'uniform', workerModel: 'anthropic/claude-3-opus' });
  assert.notEqual(uniWithModel, undefined);
  assert.equal(uniWithModel.workerModel, 'anthropic/claude-3-opus');
  assert.equal(effectiveUniformModel(uniWithModel), 'anthropic/claude-3-opus');

  // role-defaults with workerModel → workerModel present but effective undefined
  const roleWithModel = normalizeUltraSettings({ routingMode: 'role-defaults', workerModel: 'openai/gpt-4o' });
  assert.notEqual(roleWithModel, undefined);
  assert.equal(roleWithModel.workerModel, 'openai/gpt-4o');
  assert.equal(effectiveUniformModel(roleWithModel), undefined);
});

test('updateUltraSettings composes concurrent field patches and serializes toggles', async () => {
  await loadUltraModule();
  const { updateUltraSettings, loadUltraSettings } = ultra;
  const dir = await tmpDir();
  const p = join(dir, 'pi-ultra.json');
  await updateUltraSettings({ enabled: true, routingMode: 'uniform', workerModel: 'openai/base', minLanes: 2, maxLanes: 4 }, p);

  await Promise.all([
    updateUltraSettings({ enabled: false }, p),
    updateUltraSettings({ workerModel: 'openai/changed' }, p),
  ]);
  const composed = await loadUltraSettings(p);
  assert.equal(composed.kind, 'loaded');
  assert.equal(composed.settings.enabled, false);
  assert.equal(composed.settings.workerModel, 'openai/changed');

  await Promise.all([
    updateUltraSettings((current: any) => ({ enabled: !current.enabled }), p),
    updateUltraSettings((current: any) => ({ enabled: !current.enabled }), p),
  ]);
  const toggled = await loadUltraSettings(p);
  assert.equal(toggled.kind, 'loaded');
  assert.equal(toggled.settings.enabled, false, 'two serialized toggles restore the original value');
  await rm(dir, { recursive: true, force: true });
});

test('paired lane updates are atomic and revisions identify exact committed bytes', async () => {
  await loadUltraModule();
  const { updateUltraSettings, loadUltraSettings } = ultra;
  const dir = await tmpDir();
  const p = join(dir, 'pi-ultra.json');
  const first = await updateUltraSettings({ minLanes: 1, maxLanes: 2 }, p);
  const second = await updateUltraSettings({ minLanes: 4, maxLanes: 8 }, p);
  assert.notEqual(first.revision, second.revision);
  const loaded = await loadUltraSettings(p);
  assert.equal(loaded.kind, 'loaded');
  assert.equal(loaded.revision, second.revision);
  assert.deepEqual([loaded.settings.minLanes, loaded.settings.maxLanes], [4, 8]);
  await rm(dir, { recursive: true, force: true });
});

test('invalid files expose no executable defaults and explicit recovery preserves exact bytes then resets off', async () => {
  await loadUltraModule();
  const { loadUltraSettings, backupAndResetUltraSettings } = ultra;
  const dir = await tmpDir();
  const p = join(dir, 'pi-ultra.json');
  const original = '{"enabled":true, broken';
  await writeFile(p, original);
  const blocked = await loadUltraSettings(p);
  assert.equal(blocked.kind, 'invalid');
  assert.equal('settings' in blocked, false);

  const recovery = await backupAndResetUltraSettings(p);
  assert.equal(await readFile(recovery.backupPath, 'utf8'), original);
  assert.equal(recovery.committed.settings.enabled, false);
  const loaded = await loadUltraSettings(p);
  assert.equal(loaded.kind, 'loaded');
  assert.equal(loaded.settings.enabled, false);
  assert.equal(existsSync(`${p}.lock`), false);
  await rm(dir, { recursive: true, force: true });
});

test('recovery preserves invalid UTF-8 bytes exactly', async () => {
  await loadUltraModule();
  const { backupAndResetUltraSettings } = ultra;
  const dir = await tmpDir();
  const p = join(dir, 'pi-ultra.json');
  const bytes = Buffer.from([0x7b, 0x22, 0xff, 0x00, 0x7d]);
  await writeFile(p, bytes);
  const recovery = await backupAndResetUltraSettings(p);
  assert.deepEqual(await readFile(recovery.backupPath), bytes);
  await rm(dir, { recursive: true, force: true });
});

test('reclaims only old dead locks and times out for unknown liveness', async () => {
  await loadUltraModule();
  const { updateUltraSettings } = ultra;
  const dir = await tmpDir();
  const p = join(dir, 'pi-ultra.json');
  const lock = `${p}.lock`;
  await mkdir(lock, { recursive: true });
  await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: 999999, createdAt: 1, nonce: '12345678-1234-1234-1234-123456789abc' }));
  const reclaimed = await updateUltraSettings({ enabled: false }, p, {
    now: () => 40_001,
    isProcessAlive: () => false,
  });
  assert.equal(reclaimed.settings.enabled, false);
  assert.equal(existsSync(lock), false);

  await mkdir(lock, { recursive: true });
  await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: 999999, createdAt: 1, nonce: '12345678-1234-1234-1234-123456789abc' }));
  let now = 40_001;
  await assert.rejects(() => updateUltraSettings({ enabled: true }, p, {
    now: () => now,
    sleep: async (ms: number) => { now += ms; },
    isProcessAlive: () => undefined,
    lockTimeoutMs: 10,
  }), /timeout/i);
  assert.equal(existsSync(lock), true, 'unknown liveness must not steal the lock');
  await rm(dir, { recursive: true, force: true });
});

test('canonical model identifiers are bounded and control-safe', async () => {
  await loadUltraModule();
  const { normalizeUltraSettings } = ultra;
  assert.equal(normalizeUltraSettings({ workerModel: 'bare-model' }), undefined);
  assert.equal(normalizeUltraSettings({ workerModel: 'openai/model with space' }), undefined);
  assert.equal(normalizeUltraSettings({ workerModel: `openai/${'x'.repeat(300)}` }), undefined);
  assert.equal(normalizeUltraSettings({ workerModel: 'openai/model\u0000' }), undefined);
  assert.equal(normalizeUltraSettings({ workerModel: 'openai/gpt-5.6-sol' })?.workerModel, 'openai/gpt-5.6-sol');
});