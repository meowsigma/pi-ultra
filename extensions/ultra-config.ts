import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

// ── Constants ──────────────────────────────────────────────────────

export const ULTRA_CONFIG_VERSION = 1 as const;
export const ULTRA_MIN_LANES = 1 as const;
export const ULTRA_MAX_LANES = 8 as const;
export const ULTRA_ROLE_NAMES = ['scout', 'worker', 'reviewer'] as const;
export const ULTRA_SETTINGS_FILE = 'pi-ultra.json';

// ── Types ──────────────────────────────────────────────────────────

export type RoutingMode = 'uniform' | 'role-defaults';

export type UltraRole = (typeof ULTRA_ROLE_NAMES)[number];

export interface UltraSettings {
  version: 1;
  enabled: boolean;
  routingMode: RoutingMode;
  workerModel?: string;
  minLanes: number;
  maxLanes: number;
}

// ── Defaults ───────────────────────────────────────────────────────

export const DEFAULT_ULTRA_SETTINGS: UltraSettings = {
  version: 1,
  enabled: true,
  routingMode: 'role-defaults',
  minLanes: 2,
  maxLanes: 4,
};

// ── Load result types ──────────────────────────────────────────────

export interface MissingResult {
  kind: 'missing';
  settings: UltraSettings;
}

export interface LoadedResult {
  kind: 'loaded';
  settings: UltraSettings;
}

export interface InvalidResult {
  kind: 'invalid';
  reason: string;
  settings: UltraSettings;
}

export type LoadUltraSettingsResult = MissingResult | LoadedResult | InvalidResult;

// ── Helpers ────────────────────────────────────────────────────────

function cloneDefaults(): UltraSettings {
  return { ...DEFAULT_ULTRA_SETTINGS };
}

const VALID_ROUTING_MODES = new Set<RoutingMode>(['uniform', 'role-defaults']);

interface NormalizedFields {
  version: 1;
  enabled: boolean;
  routingMode: RoutingMode;
  workerModel?: string;
  minLanes: number;
  maxLanes: number;
}

type UltraFields = keyof NormalizedFields;

/**
 * Validate and normalize raw input into a valid UltraSettings, or throw.
 */
export function normalizeUltraSettings(value: Record<string, unknown>): UltraSettings {
  const out: UltraSettings = cloneDefaults();

  // version – only 1 accepted
  if (value.version !== undefined) {
    if (value.version !== 1) {
      throw new Error(`Invalid version: expected 1, got ${JSON.stringify(value.version)}`);
    }
    out.version = 1;
  }

  // enabled – strict boolean
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== 'boolean') {
      throw new Error(`Invalid enabled: expected boolean, got ${JSON.stringify(value.enabled)}`);
    }
    out.enabled = value.enabled;
  }

  // routingMode
  if (value.routingMode !== undefined) {
    if (!VALID_ROUTING_MODES.has(value.routingMode as RoutingMode)) {
      throw new Error(`Invalid routingMode: expected 'uniform' or 'role-defaults', got ${JSON.stringify(value.routingMode)}`);
    }
    out.routingMode = value.routingMode as RoutingMode;
  }

  // workerModel – optional, must be trimmed non-empty string when present
  if (value.workerModel !== undefined) {
    const vm = value.workerModel;
    if (typeof vm !== 'string') {
      throw new Error(`Invalid workerModel: expected string, got ${JSON.stringify(vm)}`);
    }
    const trimmed = vm.trim();
    if (trimmed.length === 0) {
      // whitespace-only → treat as absent
      delete out.workerModel;
    } else {
      out.workerModel = trimmed;
    }
  }

  // minLanes – safe integer 1..8
  if (value.minLanes !== undefined) {
    const ml = value.minLanes;
    if (typeof ml !== 'number' || !Number.isSafeInteger(ml) || ml < ULTRA_MIN_LANES || ml > ULTRA_MAX_LANES) {
      throw new Error(`Invalid minLanes: expected safe integer between ${ULTRA_MIN_LANES} and ${ULTRA_MAX_LANES}, got ${JSON.stringify(ml)}`);
    }
    out.minLanes = ml;
  }

  // maxLanes – safe integer 1..8
  if (value.maxLanes !== undefined) {
    const ml = value.maxLanes;
    if (typeof ml !== 'number' || !Number.isSafeInteger(ml) || ml < ULTRA_MIN_LANES || ml > ULTRA_MAX_LANES) {
      throw new Error(`Invalid maxLanes: expected safe integer between ${ULTRA_MIN_LANES} and ${ULTRA_MAX_LANES}, got ${JSON.stringify(ml)}`);
    }
    out.maxLanes = ml;
  }

  // minLanes <= maxLanes
  if (out.minLanes > out.maxLanes) {
    throw new Error(`Invalid range: minLanes (${out.minLanes}) cannot exceed maxLanes (${out.maxLanes})`);
  }

  return out;
}

/**
 * Return the effective uniform model string.
 * - 'role-defaults' routing → undefined regardless of workerModel
 * - 'uniform' with no workerModel → 'automatic'
 * - 'uniform' with workerModel → the model string
 */
export function effectiveUniformModel(settings: UltraSettings): string | undefined {
  if (settings.routingMode === 'role-defaults') {
    return undefined;
  }
  // uniform mode
  if (settings.workerModel === undefined || settings.workerModel === undefined) {
    return 'automatic';
  }
  return settings.workerModel;
}

// ── Load ──────────────────────────────────────────────────────────

async function readJsonFile(path: string): Promise<unknown> {
  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw);
}

/**
 * Load UltraSettings from a JSON file.
 *
 * @param settingsPath – absolute path to the JSON file; defaults to
 *   `join(getAgentDir(), ULTRA_SETTINGS_FILE)`.
 */
export async function loadUltraSettings(settingsPath?: string): Promise<LoadUltraSettingsResult> {
  const path = settingsPath ?? join(getAgentDir(), ULTRA_SETTINGS_FILE);

  if (!existsSync(path)) {
    return { kind: 'missing', settings: cloneDefaults() };
  }

  let raw: unknown;
  try {
    raw = await readJsonFile(path);
  } catch (err) {
    return {
      kind: 'invalid',
      reason: String(err),
      settings: cloneDefaults(),
    };
  }

  if (typeof raw !== 'object' || raw === null) {
    return {
      kind: 'invalid',
      reason: `Expected object, got ${typeof raw}`,
      settings: cloneDefaults(),
    };
  }

  try {
    const settings = normalizeUltraSettings(raw as Record<string, unknown>);
    return { kind: 'loaded', settings };
  } catch (err) {
    return {
      kind: 'invalid',
      reason: String(err),
      settings: cloneDefaults(),
    };
  }
}

// ── Save ──────────────────────────────────────────────────────────

const LOCK_RETRY_MS = 2_000; // 2 seconds total
const LOCK_RETRY_INTERVAL = 50;

async function acquireLock(lockDir: string): Promise<void> {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await mkdir(lockDir, { recursive: false });
      return;
    } catch (err: unknown) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'EEXIST') {
        if (Date.now() - start >= LOCK_RETRY_MS) {
          throw new Error(`Could not acquire lock at ${lockDir}: timeout`);
        }
        // Wait before retry
        await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_INTERVAL));
        continue;
      }
      throw err;
    }
  }
}

async function releaseLock(lockDir: string): Promise<void> {
  try {
    await rm(lockDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

const ULTRA_FIELDS: Set<string> = new Set([
  'version',
  'enabled',
  'routingMode',
  'workerModel',
  'minLanes',
  'maxLanes',
]);

/**
 * Save UltraSettings to a JSON file with lock-based atomic write.
 *
 * @param settings – partial settings object (will be normalized)
 * @param settingsPath – absolute path; defaults to
 *   `join(getAgentDir(), ULTRA_SETTINGS_FILE)`.
 */
export async function saveUltraSettings(
  settings: Record<string, unknown>,
  settingsPath?: string,
): Promise<void> {
  const path = settingsPath ?? join(getAgentDir(), ULTRA_SETTINGS_FILE);
  const lockDir = `${path}.lock`;
  const dir = dirname(path);

  // 1. Validate input
  const normalized = normalizeUltraSettings(settings);

  // 2. Acquire lock
  await acquireLock(lockDir);

  try {
    // 3. Re-read existing file under lock – reject if invalid
    if (existsSync(path)) {
      let raw: unknown;
      try {
        raw = await readJsonFile(path);
      } catch {
        throw new Error(`Refusing to overwrite invalid file: ${path} (parse error)`);
      }

      if (typeof raw !== 'object' || raw === null) {
        throw new Error(`Refusing to overwrite invalid file: ${path} (not an object)`);
      }

      try {
        normalizeUltraSettings(raw as Record<string, unknown>);
      } catch {
        throw new Error(`Refusing to overwrite invalid file: ${path} (invalid shape)`);
      }
    }

    // 4. Build output – preserve unknown top-level fields
    let existing: Record<string, unknown> = {};
    if (existsSync(path)) {
      try {
        existing = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      } catch {
        // if re-read fails, proceed with empty existing
      }
      if (typeof existing !== 'object' || existing === null) {
        existing = {};
      }
    }

    const output: Record<string, unknown> = {};
    // Copy unknown (non-Ultra) fields from existing
    for (const [key, val] of Object.entries(existing)) {
      if (!ULTRA_FIELDS.has(key)) {
        output[key] = val;
      }
    }
    // Set Ultra fields from normalized settings
    for (const key of ULTRA_FIELDS) {
      const k = key as keyof UltraSettings;
      if (k === 'workerModel') {
        if (normalized.workerModel !== undefined) {
          output.workerModel = normalized.workerModel;
        } else {
          delete output.workerModel;
        }
      } else if (k in normalized) {
        output[k] = normalized[k];
      }
    }

    const jsonContent = JSON.stringify(output, null, 2) + '\n';

    // 5. Write to UUID temp path with flag wx, then atomic rename
    const tempPath = join(dir, `.tmp-${randomUUID()}.json`);
    try {
      await writeFile(tempPath, jsonContent, { flag: 'wx' });
      await rename(tempPath, path);
    } catch (err) {
      // Clean up temp file on failure
      try { await rm(tempPath, { force: true }); } catch { /* ignore */ }
      throw err;
    }
  } finally {
    await releaseLock(lockDir);
  }
}