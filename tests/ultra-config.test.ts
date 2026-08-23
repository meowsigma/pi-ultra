import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

// ── module under test ──────────────────────────────────────────────
// We import lazily so the test file parses/imports even before the
// module exists – only the import-site test function will fail.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ultra: any;
async function loadUltraModule() {
  // Dynamic import – fails at runtime if module is missing (RED phase)
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

  // Constants
  assert.equal(ultra.ULTRA_CONFIG_VERSION, 1);
  assert.equal(ultra.ULTRA_MIN_LANES, 1);
  assert.equal(ultra.ULTRA_MAX_LANES, 8);
  assert.deepEqual(ultra.ULTRA_ROLE_NAMES, ['scout', 'worker', 'reviewer']);
  assert.equal(ultra.ULTRA_SETTINGS_FILE, 'pi-ultra.json');

  // Defaults
  assert.deepEqual(ultra.DEFAULT_ULTRA_SETTINGS, {
    version: 1,
    enabled: true,
    routingMode: 'role-defaults',
    minLanes: 2,
    maxLanes: 4,
  });

  // Functions exist
  assert.equal(typeof ultra.normalizeUltraSettings, 'function');
  assert.equal(typeof ultra.loadUltraSettings, 'function');
  assert.equal(typeof ultra.saveUltraSettings, 'function');
  assert.equal(typeof ultra.effectiveUniformModel, 'function');

  // Types – can only test runtime shape, not TS types
  assert.equal(typeof ultra.UltraSettings, 'undefined'); // interface only
});

// ── NORMALIZE DEFAULTS / PARTIAL ──────────────────────────────────
test('normalizeUltraSettings fills defaults for partial input', async () => {
  await loadUltraModule();
  const { normalizeUltraSettings, DEFAULT_ULTRA_SETTINGS } = ultra;

  // Empty object → full defaults
  const r1 = normalizeUltraSettings({});
  assert.equal(r1.version, 1);
  assert.equal(r1.enabled, true);
  assert.equal(r1.routingMode, 'role-defaults');
  assert.equal(r1.minLanes, 2);
  assert.equal(r1.maxLanes, 4);
  assert.equal('workerModel' in r1, false);

  // Partial overrides
  const r2 = normalizeUltraSettings({ enabled: false, maxLanes: 6 });
  assert.equal(r2.enabled, false);
  assert.equal(r2.maxLanes, 6);
  assert.equal(r2.minLanes, 2); // from default
  assert.equal(r2.routingMode, 'role-defaults'); // from default

  // workerModel absent when not supplied
  const r3 = normalizeUltraSettings({ workerModel: '  ' });
  assert.equal('workerModel' in r3, false);
  const r4 = normalizeUltraSettings({ workerModel: 'gpt-4o' });
  assert.equal(r4.workerModel, 'gpt-4o');

  // Trimmed non-empty
  const r5 = normalizeUltraSettings({ workerModel: '  claude-3  ' });
  assert.equal(r5.workerModel, 'claude-3');

  // version must be 1
  assert.throws(() => normalizeUltraSettings({ version: 2 }), /version/);
  assert.throws(() => normalizeUltraSettings({ version: 0 }), /version/);

  // enabled must be boolean
  assert.throws(() => normalizeUltraSettings({ enabled: 1 }), /enabled/);
  assert.throws(() => normalizeUltraSettings({ enabled: 'yes' }), /enabled/);

  // routingMode validation
  assert.doesNotThrow(() => normalizeUltraSettings({ routingMode: 'uniform' }));
  assert.doesNotThrow(() => normalizeUltraSettings({ routingMode: 'role-defaults' }));
  assert.throws(() => normalizeUltraSettings({ routingMode: 'invalid' }), /routingMode/);

  // min/max safe integers
  assert.throws(() => normalizeUltraSettings({ minLanes: 0 }), /minLanes/);
  assert.throws(() => normalizeUltraSettings({ minLanes: 9 }), /minLanes/);
  assert.throws(() => normalizeUltraSettings({ maxLanes: 0 }), /maxLanes/);
  assert.throws(() => normalizeUltraSettings({ maxLanes: 9 }), /maxLanes/);
  assert.throws(() => normalizeUltraSettings({ minLanes: 1.5 }), /minLanes/);
  assert.throws(() => normalizeUltraSettings({ maxLanes: 1.5 }), /maxLanes/);

  // min <= max
  assert.throws(() => normalizeUltraSettings({ minLanes: 5, maxLanes: 3 }), /min.*max/i);

  // Reversed range rejected
  assert.throws(() => normalizeUltraSettings({ minLanes: 7, maxLanes: 4 }), /min.*max/i);
  assert.doesNotThrow(() => normalizeUltraSettings({ minLanes: 8, maxLanes: 8 })); // equal OK
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
  // Must be a clone, not same reference
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

  // Original bytes must be preserved (not overwritten)
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

  // Start with extra fields
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

  // File exists and is valid JSON
  const content = await readFile(p, 'utf8');
  const parsed = JSON.parse(content);
  assert.equal(typeof parsed, 'object');
  assert.ok(parsed.version === 1);
  assert.equal(typeof parsed.enabled, 'boolean');

  // load should succeed
  const result = await loadUltraSettings(p);
  assert.equal(result.kind, 'loaded');
  await rm(dir, { recursive: true, force: true });
});

// ── AUTOMATIC DISTINCTIONS ────────────────────────────────────────
test('Automatic behavior distinctions shown exactly', async () => {
  await loadUltraModule();
  const { normalizeUltraSettings, effectiveUniformModel, DEFAULT_ULTRA_SETTINGS } = ultra;

  // default (role-defaults) → workerModel absent, effectiveUniformModel undefined
  const def = normalizeUltraSettings({});
  assert.equal('workerModel' in def, false);
  assert.equal(effectiveUniformModel(def), undefined);

  // uniform without explicit workerModel → workerModel absent, effective 'automatic'
  const uniNoModel = normalizeUltraSettings({ routingMode: 'uniform' });
  assert.equal('workerModel' in uniNoModel, false);
  assert.equal(effectiveUniformModel(uniNoModel), 'automatic');

  // uniform WITH workerModel → workerModel present, effective equals it
  const uniWithModel = normalizeUltraSettings({ routingMode: 'uniform', workerModel: 'claude-3-opus' });
  assert.equal(uniWithModel.workerModel, 'claude-3-opus');
  assert.equal(effectiveUniformModel(uniWithModel), 'claude-3-opus');

  // role-defaults with workerModel → workerModel present but effective undefined
  const roleWithModel = normalizeUltraSettings({ routingMode: 'role-defaults', workerModel: 'gpt-4o' });
  assert.equal(roleWithModel.workerModel, 'gpt-4o');
  assert.equal(effectiveUniformModel(roleWithModel), undefined);
});