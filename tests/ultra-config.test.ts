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
  assert.equal(typeof ultra.saveUltraSettings, 'function');
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

  const r4 = normalizeUltraSettings({ workerModel: 'gpt-4o' });
  assert.notEqual(r4, undefined);
  assert.equal(r4.workerModel, 'gpt-4o');

  // Trimmed non-empty
  const r5 = normalizeUltraSettings({ workerModel: '  claude-3  ' });
  assert.notEqual(r5, undefined);
  assert.equal(r5.workerModel, 'claude-3');

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
  assert.deepEqual(result.settings, DEFAULT_ULTRA_SETTINGS);

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
  assert.deepEqual(result.settings, DEFAULT_ULTRA_SETTINGS);

  // File must not be overwritten
  const saved = JSON.parse(await readFile(p, 'utf8'));
  assert.equal(saved.version, 99);
  await rm(dir, { recursive: true, force: true });
});

// ── SAVE – REJECT INVALID INPUT ───────────────────────────────────
test('saveUltraSettings rejects invalid settings', async () => {
  await loadUltraModule();
  const { saveUltraSettings } = ultra;

  const dir = await tmpDir();
  await assert.rejects(() => saveUltraSettings({ version: 99 } as any, join(dir, 'pi-ultra.json')));
  await assert.rejects(() => saveUltraSettings({ enabled: 'yes' } as any, join(dir, 'pi-ultra.json')));
  await assert.rejects(() => saveUltraSettings({ minLanes: 0 } as any, join(dir, 'pi-ultra.json')));
  await rm(dir, { recursive: true, force: true });
});

// ── SAVE – REJECT SAVE OVER INVALID FILE ──────────────────────────
test('saveUltraSettings rejects saving over invalid existing file', async () => {
  await loadUltraModule();
  const { saveUltraSettings } = ultra;

  const dir = await tmpDir();
  const p = join(dir, 'pi-ultra.json');
  await writeFile(p, 'broken json{{{');

  await assert.rejects(() => saveUltraSettings({ enabled: true } as any, p));

  // Original bytes preserved
  const bytes = await readFile(p, 'utf8');
  assert.equal(bytes, 'broken json{{{');
  await rm(dir, { recursive: true, force: true });
});

// ── SAVE – REJECT OVER INVALID SHAPE ──────────────────────────────
test('saveUltraSettings rejects saving over invalid-shape file', async () => {
  await loadUltraModule();
  const { saveUltraSettings } = ultra;

  const dir = await tmpDir();
  const p = await writeSettings(dir, { version: 99, enabled: true, routingMode: 'uniform' });

  await assert.rejects(() => saveUltraSettings({ enabled: false } as any, p));

  // File unchanged
  const saved = JSON.parse(await readFile(p, 'utf8'));
  assert.equal(saved.version, 99);
  await rm(dir, { recursive: true, force: true });
});

// ── SAVE -> LOAD CYCLE ────────────────────────────────────────────
test('save then load yields loaded with saved settings (false)', async () => {
  await loadUltraModule();
  const { saveUltraSettings, loadUltraSettings } = ultra;

  const dir = await tmpDir();
  const p = join(dir, 'pi-ultra.json');
  await saveUltraSettings({ enabled: false, routingMode: 'uniform', minLanes: 1, maxLanes: 3, workerModel: 'gpt-4o' }, p);

  const result = await loadUltraSettings(p);
  assert.equal(result.kind, 'loaded');
  assert.equal(result.settings.enabled, false);
  assert.equal(result.settings.routingMode, 'uniform');
  assert.equal(result.settings.minLanes, 1);
  assert.equal(result.settings.maxLanes, 3);
  assert.equal(result.settings.workerModel, 'gpt-4o');
  await rm(dir, { recursive: true, force: true });
});

// ── SAVE PRESERVES UNKNOWN TOP-LEVEL FIELDS ───────────────────────
test('save preserves unknown top-level fields while replacing Ultra fields', async () => {
  await loadUltraModule();
  const { saveUltraSettings, loadUltraSettings } = ultra;

  const dir = await tmpDir();
  const p = join(dir, 'pi-ultra.json');

  await writeFile(p, JSON.stringify({
    version: 1,
    enabled: true,
    routingMode: 'role-defaults',
    minLanes: 2,
    maxLanes: 4,
    customField: 'keep-me',
    anotherExtra: { nested: true },
  }));

  await saveUltraSettings({ enabled: false, routingMode: 'uniform', minLanes: 1, maxLanes: 3 }, p);

  const saved = JSON.parse(await readFile(p, 'utf8'));
  assert.equal(saved.enabled, false);
  assert.equal(saved.customField, 'keep-me');
  assert.deepEqual(saved.anotherExtra, { nested: true });
  assert.equal(saved.version, 1);
  await rm(dir, { recursive: true, force: true });
});

// ── CONCURRENT SAVES ──────────────────────────────────────────────
test('Promise.all two saves leaves parseable normalized JSON', async () => {
  await loadUltraModule();
  const { saveUltraSettings, loadUltraSettings } = ultra;

  const dir = await tmpDir();
  const p = join(dir, 'pi-ultra.json');

  await Promise.all([
    saveUltraSettings({ enabled: true, routingMode: 'uniform', minLanes: 2, maxLanes: 6, workerModel: 'model-a' }, p),
    saveUltraSettings({ enabled: false, routingMode: 'role-defaults', minLanes: 3, maxLanes: 5, workerModel: 'model-b' }, p),
  ]);

  const content = await readFile(p, 'utf8');
  const parsed = JSON.parse(content);
  assert.equal(typeof parsed, 'object');
  assert.ok(parsed.version === 1);
  assert.equal(typeof parsed.enabled, 'boolean');

  const result = await loadUltraSettings(p);
  assert.equal(result.kind, 'loaded');
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
  const uniWithModel = normalizeUltraSettings({ routingMode: 'uniform', workerModel: 'claude-3-opus' });
  assert.notEqual(uniWithModel, undefined);
  assert.equal(uniWithModel.workerModel, 'claude-3-opus');
  assert.equal(effectiveUniformModel(uniWithModel), 'claude-3-opus');

  // role-defaults with workerModel → workerModel present but effective undefined
  const roleWithModel = normalizeUltraSettings({ routingMode: 'role-defaults', workerModel: 'gpt-4o' });
  assert.notEqual(roleWithModel, undefined);
  assert.equal(roleWithModel.workerModel, 'gpt-4o');
  assert.equal(effectiveUniformModel(roleWithModel), undefined);
});