// Session-scoped Ultra settings: durable snapshots stored as Pi custom entries
// (non-model-visible) plus a resolver that overlays the latest valid session
// patch on top of valid global defaults.
import type { CustomEntry } from '@earendil-works/pi-coding-agent';
import {
  MAX_MODEL_BYTES,
  MODEL_ID,
  ULTRA_MAX_LANES,
  ULTRA_MIN_LANES,
  normalizeUltraSettings,
  type RoutingMode,
  type UltraSettings,
} from './ultra-config.js';

/** Custom-entry type for session-local Ultra settings. Never visible to the model. */
export const ULTRA_SESSION_SETTINGS_CUSTOM_TYPE = 'pi-ultra-session-settings';
export const ULTRA_SESSION_JOURNAL_VERSION = 1 as const;

const MAX_REASON_LENGTH = 512;
const MAX_IGNORED_DIAGNOSTICS = 32;

/**
 * Session overlay on global Ultra defaults. Distinct from UltraSettingsPatch:
 * no version field, and workerModel may be null.
 * - workerModel absent: inherit the globally selected model.
 * - workerModel null: explicit Automatic (remove any global selected model).
 * - non-null workerModel: provider-qualified id ('provider/model').
 */
export interface UltraSessionOverrides {
  enabled?: boolean;
  routingMode?: RoutingMode;
  workerModel?: string | null;
  minLanes?: number;
  maxLanes?: number;
}

/** Journal payload appended as custom-entry data. Entries are exactly this shape. */
export interface SessionUltraJournalEntry {
  version: typeof ULTRA_SESSION_JOURNAL_VERSION;
  patch: UltraSessionOverrides;
}

export interface SessionOverrideDiagnostic {
  id: string;
  reason: string;
}

export interface SessionOverridesScanResult {
  /** Latest valid patch in branch order; {} when none found or after an explicit reset. */
  patch: UltraSessionOverrides;
  /** Bounded diagnostics for ignored malformed pi-ultra-session-settings entries. */
  ignored: SessionOverrideDiagnostic[];
  ignoredCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedReason(text: string): string {
  return (text.trim() || 'Unknown session settings error').slice(0, MAX_REASON_LENGTH);
}

function invalid(field: string, detail: string): never {
  throw new Error(boundedReason(`Invalid session Ultra override '${field}': ${detail}`));
}

/**
 * Validate a raw session patch. Throws with a bounded message on any of:
 * non-object data, unknown fields, invalid types, bad routing mode, invalid
 * model strings, and one-sided minLanes/maxLanes overrides. Paired bounds must
 * be safe integers within 1..8 and ordered. Returns a fresh plain object.
 */
export function validateUltraSessionOverrides(value: unknown): UltraSessionOverrides {
  if (!isRecord(value)) throw new Error('Session Ultra overrides must be an object.');
  const allowed = new Set(['enabled', 'routingMode', 'workerModel', 'minLanes', 'maxLanes']);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(boundedReason(`Unsupported session Ultra override field '${key}'.`));
  }
  const out: UltraSessionOverrides = {};
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== 'boolean') invalid('enabled', 'expected a boolean.');
    out.enabled = value.enabled;
  }
  if (value.routingMode !== undefined) {
    if (value.routingMode !== 'uniform' && value.routingMode !== 'role-defaults') invalid('routingMode', "expected 'uniform' or 'role-defaults'.");
    out.routingMode = value.routingMode;
  }
  if (value.workerModel !== undefined) {
    if (value.workerModel === null) {
      // Explicit Automatic: remove any globally selected model.
      out.workerModel = null;
    } else if (typeof value.workerModel === 'string') {
      const model = value.workerModel.trim();
      if (!model) invalid('workerModel', 'must be a non-empty provider-qualified id or null.');
      if (Buffer.byteLength(model, 'utf8') > MAX_MODEL_BYTES) invalid('workerModel', `exceeds ${MAX_MODEL_BYTES} bytes.`);
      if (!MODEL_ID.test(model)) invalid('workerModel', "must be provider-qualified like 'provider/model' without whitespace or control characters.");
      out.workerModel = model;
    } else {
      invalid('workerModel', 'expected a provider-qualified string or null.');
    }
  }
  const hasMin = value.minLanes !== undefined;
  const hasMax = value.maxLanes !== undefined;
  if (hasMin !== hasMax) throw new Error('Invalid session Ultra override: minLanes and maxLanes must be overridden together.');
  if (hasMin) {
    for (const field of ['minLanes', 'maxLanes'] as const) {
      const lane = value[field];
      if (typeof lane !== 'number' || !Number.isSafeInteger(lane) || lane < ULTRA_MIN_LANES || lane > ULTRA_MAX_LANES) {
        invalid(field, 'must be an integer between 1 and 8.');
      }
    }
    if ((value.minLanes as number) > (value.maxLanes as number)) {
      throw new Error('Invalid session Ultra override: minLanes must not exceed maxLanes.');
    }
    out.minLanes = value.minLanes as number;
    out.maxLanes = value.maxLanes as number;
  }
  return out;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as object)) deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value as Readonly<T>;
}

function journalEntry(patch: UltraSessionOverrides): Readonly<SessionUltraJournalEntry> {
  return deepFreeze({ version: ULTRA_SESSION_JOURNAL_VERSION, patch });
}

/**
 * Append an immutable session snapshot via a Pi append callback
 * (e.g. ctx.sessionManager.appendCustomEntry.bind(ctx.sessionManager)).
 * The patch is re-validated defensively; nothing is appended when invalid.
 */
export function appendSessionUltraOverrides(
  append: (customType: string, data?: unknown) => unknown,
  patch: UltraSessionOverrides,
): void {
  const validated = validateUltraSessionOverrides(patch);
  append(ULTRA_SESSION_SETTINGS_CUSTOM_TYPE, journalEntry(validated));
}

/** Append an explicit reset snapshot ({ version: 1, patch: {} }). */
export function clearSessionUltraOverrides(append: (customType: string, data?: unknown) => unknown): void {
  append(ULTRA_SESSION_SETTINGS_CUSTOM_TYPE, journalEntry({}));
}

interface ParsedSnapshot {
  ok: boolean;
  patch?: UltraSessionOverrides;
  reason?: string;
}

/**
 * Safe label for a malformed journal version. Explicitly handles Symbol
 * (whose string coercion via template interpolation throws TypeError) so
 * snapshot parsing stays diagnostic-only and never throws.
 */
function describeVersion(value: unknown): string {
  if (typeof value === 'symbol') return value.toString();
  if (typeof value === 'bigint') return `${value}n`;
  return String(value);
}

function parseSnapshotData(data: unknown): ParsedSnapshot {
  if (!isRecord(data)) return { ok: false, reason: boundedReason(`Journal entry data must be an object, got ${data === null ? 'null' : typeof data}.`) };
  if (data.version !== ULTRA_SESSION_JOURNAL_VERSION) {
    return { ok: false, reason: boundedReason(`Unsupported journal entry version ${describeVersion(data.version)}; expected ${ULTRA_SESSION_JOURNAL_VERSION}.`) };
  }
  try {
    return { ok: true, patch: validateUltraSessionOverrides(data.patch) };
  } catch (error) {
    return { ok: false, reason: boundedReason(error instanceof Error ? error.message : String(error)) };
  }
}

/**
 * Scan a Pi branch's custom entries (in branch order, oldest first) for
 * pi-ultra-session-settings snapshots; the latest valid snapshot wins, and a
 * valid empty patch is an explicit reset. Malformed same-type entries are
 * ignored with bounded diagnostics; unknown entry kinds are skipped silently.
 * Never throws.
 */
export function scanSessionUltraOverrides(entries: Iterable<unknown>): SessionOverridesScanResult {
  let latest: UltraSessionOverrides | undefined;
  let ignoredCount = 0;
  const ignored: SessionOverrideDiagnostic[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    if (entry.type !== 'custom' || entry.customType !== ULTRA_SESSION_SETTINGS_CUSTOM_TYPE) continue;
    const parsed = parseSnapshotData(entry.data);
    if (!parsed.ok) {
      ignoredCount += 1;
      if (ignored.length < MAX_IGNORED_DIAGNOSTICS) {
        ignored.push({
          id: typeof entry.id === 'string' ? entry.id : '<unknown>',
          reason: parsed.reason ?? 'Malformed session Ultra settings entry.',
        });
      }
      continue;
    }
    latest = parsed.patch;
  }
  return { patch: latest ?? {}, ignored, ignoredCount };
}

/**
 * Overlay a validated session patch on valid global defaults and return a full,
 * valid UltraSettings. Ordinary fields overlay directly; a null workerModel
 * removes any globally selected model so effective uniform selection is
 * Automatic. Inputs are never mutated. Throws when the effective state would be
 * invalid rather than returning garbage.
 */
export function resolveEffectiveUltraSettings(
  global: Readonly<UltraSettings>,
  patch?: Readonly<UltraSessionOverrides> | null,
): UltraSettings {
  const merged: Record<string, unknown> = { ...global };
  if (patch) {
    if (patch.enabled !== undefined) merged.enabled = patch.enabled;
    if (patch.routingMode !== undefined) merged.routingMode = patch.routingMode;
    if (patch.workerModel !== undefined) {
      if (patch.workerModel === null) delete merged.workerModel;
      else merged.workerModel = patch.workerModel;
    }
    if (patch.minLanes !== undefined) merged.minLanes = patch.minLanes;
    if (patch.maxLanes !== undefined) merged.maxLanes = patch.maxLanes;
  }
  const effective = normalizeUltraSettings(merged);
  if (!effective) throw new Error('Invalid effective Ultra settings after applying session overrides.');
  return effective;
}
