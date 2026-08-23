import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
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

const ULTRA_FIELDS: ReadonlySet<string> = new Set([
  'version',
  'enabled',
  'routingMode',
  'workerModel',
  'minLanes',
  'maxLanes',
]);

/**
 * Normalize raw input into a valid UltraSettings, or return undefined
 * if the input is null, a non-object, or fails any validation rule.
 *
 * Never throws.
 */
export function normalizeUltraSettings(value: unknown): UltraSettings | undefined {
  // Reject null, arrays, and non-object primitives
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const input = value as Record<string, unknown>;
  const out: UltraSettings = cloneDefaults();

  // version – only 1 accepted
  if (input.version !== undefined) {
    if (input.version !== 1) return undefined;
  }

  // enabled – strict boolean
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') return undefined;
    out.enabled = input.enabled;
  }

  // routingMode
  if (input.routingMode !== undefined) {
    if (!VALID_ROUTING_MODES.has(input.routingMode as RoutingMode)) return undefined;
    out.routingMode = input.routingMode as RoutingMode;
  }

  // workerModel – optional, must be trimmed non-empty string when present
  if (input.workerModel !== undefined) {
    if (typeof input.workerModel !== 'string') return undefined;
    const trimmed = input.workerModel.trim();
    if (trimmed.length > 0) {
      out.workerModel = trimmed;
    }
    // whitespace-only → leave absent (already cloned without it)
  }

  // minLanes – safe integer 1..8
  if (input.minLanes !== undefined) {
    const ml = input.minLanes;
    if (typeof ml !== 'number' || !Number.isSafeInteger(ml) || ml < ULTRA_MIN_LANES || ml > ULTRA_MAX_LANES) return undefined;
    out.minLanes = ml;
  }

  // maxLanes – safe integer 1..8
  if (input.maxLanes !== undefined) {
    const ml = input.maxLanes;
    if (typeof ml !== 'number' || !Number.isSafeInteger(ml) || ml < ULTRA_MIN_LANES || ml > ULTRA_MAX_LANES) return undefined;
    out.maxLanes = ml;
  }

  // minLanes <= maxLanes
  if (out.minLanes > out.maxLanes) return undefined;

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
  if (settings.workerModel === undefined) {
    return 'automatic';
  }
  return settings.workerModel;
}

// ── Load ──────────────────────────────────────────────────────────

/**
 * Read a JSON file, returning the parsed value.
 * Re-throws on any error (caller handles ENOENT vs parse failure).
 */
async function readJsonFile(path: string): Promise<unknown> {
  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw);
}

/**
 * Load UltraSettings from a JSON file.
 *
 * Uses readFile directly (no TOCTOU existsSync) — an ENOENT error is
 * classified as `kind:'missing'`; any other read or parse error is
 * `kind:'invalid'`.
 *
 * @param settingsPath – absolute path to the JSON file; defaults to
 *   `join(getAgentDir(), ULTRA_SETTINGS_FILE)`.
 */
export async function loadUltraSettings(settingsPath?: string): Promise<LoadUltraSettingsResult> {
  const path = settingsPath ?? join(getAgentDir(), ULTRA_SETTINGS_FILE);

  let raw: unknown;
  try {
    raw = await readJsonFile(path);
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr?.code === 'ENOENT') {
      return { kind: 'missing', settings: cloneDefaults() };
    }
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

  const settings = normalizeUltraSettings(raw);
  if (settings === undefined) {
    return {
      kind: 'invalid',
      reason: 'Invalid settings shape',
      settings: cloneDefaults(),
    };
  }

  return { kind: 'loaded', settings };
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

/**
 * Build the output object by merging normalized Ultra fields into any
 * existing unknown (non-Ultra) top-level fields.
 */
function mergeOutput(
  existing: Record<string, unknown>,
  normalized: UltraSettings,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};

  // Copy unknown (non-Ultra) fields from existing
  for (const [key, val] of Object.entries(existing)) {
    if (!ULTRA_FIELDS.has(key)) {
      output[key] = val;
    }
  }

  // Set Ultra fields from normalized settings
  for (const key of ULTRA_FIELDS) {
    if (key === 'workerModel') {
      if (normalized.workerModel !== undefined) {
        output.workerModel = normalized.workerModel;
      } else {
        delete output.workerModel;
      }
    } else {
      output[key] = (normalized as unknown as Record<string, unknown>)[key];
    }
  }

  return output;
}

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

  // 1. Validate input — reject invalid
  const normalized = normalizeUltraSettings(settings);
  if (normalized === undefined) {
    throw new Error('Invalid settings: normalization failed');
  }

  // 2. Acquire lock
  await acquireLock(lockDir);

  try {
    // 3. Read existing file under lock — single read, no TOCTOU
    let existingRaw: unknown = undefined;
    let existingContent: string | undefined;
    try {
      existingContent = await readFile(path, 'utf8');
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr?.code !== 'ENOENT') {
        // Some real read error — surface it
        throw new Error(`Failed to read ${path}: ${err}`);
      }
      // ENOENT → file doesn't exist yet, that's fine
    }

    // If the file exists, parse and validate it in one pass
    if (existingContent !== undefined) {
      try {
        existingRaw = JSON.parse(existingContent);
      } catch {
        throw new Error(`Refusing to overwrite invalid file: ${path} (parse error)`);
      }

      if (typeof existingRaw !== 'object' || existingRaw === null) {
        throw new Error(`Refusing to overwrite invalid file: ${path} (not an object)`);
      }

      if (normalizeUltraSettings(existingRaw) === undefined) {
        throw new Error(`Refusing to overwrite invalid file: ${path} (invalid shape)`);
      }
    }

    // 4. Build output — preserve unknown top-level fields
    const existing: Record<string, unknown> =
      (existingRaw !== undefined && typeof existingRaw === 'object' && !Array.isArray(existingRaw))
        ? (existingRaw as Record<string, unknown>)
        : {};

    const output = mergeOutput(existing, normalized);
    const jsonContent = JSON.stringify(output, null, 2) + '\n';

    // 5. Write to UUID temp path with flag wx, then atomic rename
    const tempPath = join(dir, `.tmp-${randomUUID()}.json`);
    try {
      await writeFile(tempPath, jsonContent, { flag: 'wx' });
      await rename(tempPath, path);
    } catch (err) {
      try { await rm(tempPath, { force: true }); } catch { /* ignore */ }
      throw err;
    }
  } finally {
    await releaseLock(lockDir);
  }
}