import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { watch, watchFile, unwatchFile } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export const ULTRA_CONFIG_VERSION = 1 as const;
export const ULTRA_MIN_LANES = 1 as const;
export const ULTRA_MAX_LANES = 8 as const;
export const ULTRA_ROLE_NAMES = ['scout', 'worker', 'reviewer'] as const;
export const ULTRA_SETTINGS_FILE = 'pi-ultra.json';

const LOCK_TIMEOUT_MS = 2_000;
const LOCK_RETRY_MS = 50;
const STALE_LOCK_MS = 30_000;
const MAX_MODEL_BYTES = 256;
const MAX_REASON_LENGTH = 512;
const ULTRA_FIELDS = new Set(['version', 'enabled', 'routingMode', 'workerModel', 'minLanes', 'maxLanes']);
const MODEL_ID = /^[^\s\u0000-\u001f\u007f/]+\/[^\s\u0000-\u001f\u007f]+$/u;

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

export const DEFAULT_ULTRA_SETTINGS: UltraSettings = {
  version: 1,
  enabled: true,
  routingMode: 'role-defaults',
  minLanes: 2,
  maxLanes: 4,
};

export interface ValidUltraSettingsResult {
  kind: 'missing' | 'loaded';
  settings: UltraSettings;
  revision: string;
  path: string;
}

export interface InvalidUltraSettingsResult {
  kind: 'invalid';
  reason: string;
  path: string;
}

export type LoadUltraSettingsResult = ValidUltraSettingsResult | InvalidUltraSettingsResult;
export type UltraSettingsPatch = Partial<Omit<UltraSettings, 'version'>> & { version?: 1 };
export type UltraSettingsMutator = (current: Readonly<UltraSettings>) => UltraSettingsPatch | UltraSettings;

export class UltraSettingsCleanupError extends Error {
  readonly committed: ValidUltraSettingsResult;
  readonly backupPath?: string;

  constructor(message: string, committed: ValidUltraSettingsResult, options?: ErrorOptions & { backupPath?: string }) {
    super(message, options);
    this.name = 'UltraSettingsCleanupError';
    this.committed = committed;
    this.backupPath = options?.backupPath;
  }
}

export interface UltraConfigLockOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  isProcessAlive?: (pid: number) => boolean | undefined;
  lockTimeoutMs?: number;
}

interface LockOwner {
  pid: number;
  createdAt: number;
  nonce: string;
}

interface ParsedFile {
  settings: UltraSettings;
  raw: Record<string, unknown>;
  content: string;
}

function settingsPath(path?: string): string {
  return path ?? join(getAgentDir(), ULTRA_SETTINGS_FILE);
}

function cloneSettings(settings: UltraSettings = DEFAULT_ULTRA_SETTINGS): UltraSettings {
  return { ...settings };
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function missingRevision(): string {
  return digest(`missing:${JSON.stringify(DEFAULT_ULTRA_SETTINGS)}`);
}

function boundedReason(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const sanitized = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '').trim();
  return (sanitized || 'Unknown configuration error').slice(0, MAX_REASON_LENGTH);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeUltraSettings(value: unknown): UltraSettings | undefined {
  if (!isRecord(value)) return undefined;
  const out = cloneSettings();
  if (value.version !== undefined && value.version !== ULTRA_CONFIG_VERSION) return undefined;
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== 'boolean') return undefined;
    out.enabled = value.enabled;
  }
  if (value.routingMode !== undefined) {
    if (value.routingMode !== 'uniform' && value.routingMode !== 'role-defaults') return undefined;
    out.routingMode = value.routingMode;
  }
  if (value.workerModel !== undefined) {
    if (typeof value.workerModel !== 'string') return undefined;
    const model = value.workerModel.trim();
    if (model) {
      if (Buffer.byteLength(model, 'utf8') > MAX_MODEL_BYTES || !MODEL_ID.test(model)) return undefined;
      out.workerModel = model;
    }
  }
  for (const field of ['minLanes', 'maxLanes'] as const) {
    if (value[field] === undefined) continue;
    const lane = value[field];
    if (typeof lane !== 'number' || !Number.isSafeInteger(lane) || lane < ULTRA_MIN_LANES || lane > ULTRA_MAX_LANES) return undefined;
    out[field] = lane;
  }
  if (out.minLanes > out.maxLanes) return undefined;
  return out;
}

export function effectiveUniformModel(settings: UltraSettings): string | undefined {
  if (settings.routingMode === 'role-defaults') return undefined;
  return settings.workerModel ?? 'automatic';
}

function parseContent(content: string, path: string): ParsedFile {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (error) {
    throw new Error(`Invalid JSON in ${path}: ${boundedReason(error)}`);
  }
  if (!isRecord(raw)) throw new Error(`Invalid settings in ${path}: expected an object.`);
  const settings = normalizeUltraSettings(raw);
  if (!settings) throw new Error(`Invalid settings shape in ${path}.`);
  return { settings, raw, content };
}

async function readParsed(path: string): Promise<ParsedFile | undefined> {
  try {
    return parseContent(await readFile(path, 'utf8'), path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function loadUltraSettings(pathInput?: string): Promise<LoadUltraSettingsResult> {
  const path = settingsPath(pathInput);
  try {
    const parsed = await readParsed(path);
    if (!parsed) return { kind: 'missing', settings: cloneSettings(), revision: missingRevision(), path };
    return { kind: 'loaded', settings: cloneSettings(parsed.settings), revision: digest(parsed.content), path };
  } catch (error) {
    return { kind: 'invalid', reason: boundedReason(error), path };
  }
}

function defaultProcessAlive(pid: number): boolean | undefined {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    return undefined;
  }
}

function normalizeOwner(value: unknown): LockOwner | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid <= 0) return undefined;
  if (typeof value.createdAt !== 'number' || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0) return undefined;
  if (typeof value.nonce !== 'string' || !/^[a-f0-9-]{16,64}$/u.test(value.nonce)) return undefined;
  return { pid: value.pid, createdAt: value.createdAt, nonce: value.nonce };
}

async function readLockOwner(lockDir: string): Promise<LockOwner | undefined> {
  try {
    return normalizeOwner(JSON.parse(await readFile(join(lockDir, 'owner.json'), 'utf8')));
  } catch {
    return undefined;
  }
}

async function acquireLock(path: string, options: UltraConfigLockOptions): Promise<{ lockDir: string; owner: LockOwner }> {
  const lockDir = `${path}.lock`;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const isProcessAlive = options.isProcessAlive ?? defaultProcessAlive;
  const timeoutMs = options.lockTimeoutMs ?? LOCK_TIMEOUT_MS;
  const startedAt = now();
  while (true) {
    const owner: LockOwner = { pid: process.pid, createdAt: now(), nonce: randomUUID() };
    try {
      await mkdir(lockDir, { mode: 0o700 });
      try {
        await writeFile(join(lockDir, 'owner.json'), `${JSON.stringify(owner)}\n`, { flag: 'wx', mode: 0o600 });
      } catch (error) {
        await rm(lockDir, { recursive: true, force: true });
        throw error;
      }
      return { lockDir, owner };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await readLockOwner(lockDir);
      if (existing && now() - existing.createdAt > STALE_LOCK_MS && isProcessAlive(existing.pid) === false) {
        const quarantine = `${lockDir}.stale-${randomUUID()}`;
        try {
          await rename(lockDir, quarantine);
          await rm(quarantine, { recursive: true, force: true });
          continue;
        } catch (reclaimError) {
          if ((reclaimError as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw new Error(`Failed to reclaim stale lock ${lockDir}: ${boundedReason(reclaimError)}`);
        }
      }
      if (now() - startedAt >= timeoutMs) throw new Error(`Could not acquire lock at ${lockDir}: timeout`);
      await sleep(Math.min(LOCK_RETRY_MS, Math.max(1, timeoutMs - (now() - startedAt))));
    }
  }
}

async function releaseLock(lock: { lockDir: string; owner: LockOwner }): Promise<void> {
  const current = await readLockOwner(lock.lockDir);
  if (!current || current.nonce !== lock.owner.nonce) throw new Error(`Refusing to release lock not owned by this process: ${lock.lockDir}`);
  await rm(lock.lockDir, { recursive: true, force: false });
}

function mergeOutput(existing: Record<string, unknown>, settings: UltraSettings): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(existing)) if (!ULTRA_FIELDS.has(key)) output[key] = value;
  output.version = settings.version;
  output.enabled = settings.enabled;
  output.routingMode = settings.routingMode;
  if (settings.workerModel !== undefined) output.workerModel = settings.workerModel;
  output.minLanes = settings.minLanes;
  output.maxLanes = settings.maxLanes;
  return output;
}

function validatePatch(value: unknown): asserts value is UltraSettingsPatch {
  if (!isRecord(value)) throw new Error('Settings update must return an object patch.');
  for (const key of Object.keys(value)) if (!ULTRA_FIELDS.has(key)) throw new Error(`Unsupported Ultra settings field '${key}'.`);
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const tempPath = join(dirname(path), `.pi-ultra-${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, content, { flag: 'wx', mode: 0o600 });
    await rename(tempPath, path);
  } catch (error) {
    try {
      await rm(tempPath, { force: true });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `Atomic write and temporary-file cleanup both failed for ${path}.`);
    }
    throw error;
  }
}

export async function updateUltraSettings(
  mutatorOrPatch: UltraSettingsMutator | UltraSettingsPatch,
  pathInput?: string,
  options: UltraConfigLockOptions = {},
): Promise<ValidUltraSettingsResult> {
  const path = settingsPath(pathInput);
  await mkdir(dirname(path), { recursive: true });
  const lock = await acquireLock(path, options);
  let operationError: unknown;
  let committed: ValidUltraSettingsResult | undefined;
  try {
    const parsed = await readParsed(path);
    const current = cloneSettings(parsed?.settings);
    const patch = typeof mutatorOrPatch === 'function' ? mutatorOrPatch(Object.freeze(cloneSettings(current))) : mutatorOrPatch;
    validatePatch(patch);
    const normalized = normalizeUltraSettings({ ...current, ...patch });
    if (!normalized) throw new Error('Invalid settings update: normalization failed.');
    const content = `${JSON.stringify(mergeOutput(parsed?.raw ?? {}, normalized), null, 2)}\n`;
    await atomicWrite(path, content);
    committed = { kind: 'loaded', settings: cloneSettings(normalized), revision: digest(content), path };
    return committed;
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      await releaseLock(lock);
    } catch (releaseError) {
      if (operationError !== undefined) throw new AggregateError([operationError, releaseError], 'Settings update and lock cleanup both failed.');
      if (committed) throw new UltraSettingsCleanupError('Settings committed, but lock cleanup failed.', committed, { cause: releaseError });
      throw releaseError;
    }
  }
}

export function watchUltraSettings(
  onChange: () => void | Promise<void>,
  pathInput?: string,
  onError?: (error: Error) => void,
): () => void {
  const path = settingsPath(pathInput);
  let disposed = false;
  let pending = false;
  const trigger = () => {
    if (disposed || pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      if (disposed) return;
      Promise.resolve(onChange()).catch((error) => onError?.(error instanceof Error ? error : new Error(String(error))));
    });
  };
  watchFile(path, { interval: 500, persistent: false }, trigger);
  let directoryWatcher: ReturnType<typeof watch> | undefined;
  try {
    directoryWatcher = watch(dirname(path), { persistent: false }, (_event, filename) => {
      if (filename === null || filename.toString() === basename(path)) trigger();
    });
    directoryWatcher.on('error', (error) => onError?.(error));
  } catch (error) {
    onError?.(error instanceof Error ? error : new Error(String(error)));
  }
  return () => {
    if (disposed) return;
    disposed = true;
    unwatchFile(path, trigger);
    directoryWatcher?.close();
  };
}

export async function backupAndResetUltraSettings(
  pathInput?: string,
  options: UltraConfigLockOptions = {},
): Promise<{ backupPath: string; committed: ValidUltraSettingsResult }> {
  const path = settingsPath(pathInput);
  await mkdir(dirname(path), { recursive: true });
  const lock = await acquireLock(path, options);
  let operationError: unknown;
  let committed: ValidUltraSettingsResult | undefined;
  let committedBackupPath: string | undefined;
  try {
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`No invalid settings file exists at ${path}.`);
      throw error;
    }
    const content = bytes.toString('utf8');
    try {
      parseContent(content, path);
      throw new Error(`Settings file at ${path} is valid; recovery was not performed.`);
    } catch (error) {
      if (error instanceof Error && /is valid; recovery/.test(error.message)) throw error;
    }
    const stamp = new Date(options.now?.() ?? Date.now()).toISOString().replace(/[:.]/gu, '-');
    const backupPath = `${path}.invalid-${stamp}-${randomUUID()}.bak`;
    await writeFile(backupPath, bytes, { flag: 'wx', mode: 0o600 });
    const reset = { ...DEFAULT_ULTRA_SETTINGS, enabled: false };
    const resetContent = `${JSON.stringify(reset, null, 2)}\n`;
    await atomicWrite(path, resetContent);
    committedBackupPath = backupPath;
    committed = { kind: 'loaded', settings: reset, revision: digest(resetContent), path };
    return { backupPath, committed };
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      await releaseLock(lock);
    } catch (releaseError) {
      if (operationError !== undefined) throw new AggregateError([operationError, releaseError], 'Settings recovery and lock cleanup both failed.');
      if (committed) throw new UltraSettingsCleanupError('Settings recovery committed, but lock cleanup failed.', committed, { cause: releaseError, backupPath: committedBackupPath });
      throw releaseError;
    }
  }
}
