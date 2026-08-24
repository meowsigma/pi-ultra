import { createHash } from 'node:crypto';

export const ULTRA_OPERATION_ENTRY = 'ultra.operation.v1' as const;
const MAX_OPERATIONS = 256;
const MAX_ENTRY_BYTES = 131_072;
const MAX_RESULTS = 64;
const MAX_CHANGED_PATHS = 128;
const MAX_LAUNCH_ATTEMPTS = 512;
const MAX_IDEMPOTENCY_KEY_CHARS = 256;
const MAX_FAILURE_REASON_CHARS = 2_048;

export type UltraOperationStatus = 'running' | 'paused' | 'completed' | 'failed' | 'stopped';
export type UltraOperationOutbox = 'none' | 'ready' | 'sent';

export interface UltraOperationLane {
  id: string;
  role: 'scout' | 'worker' | 'reviewer';
  agent: string;
  requestedModel?: string;
  modelCandidates: string[];
  expectedFixedModel?: string;
  launchContractDigest: string;
  ownedPaths?: string[];
}

export interface UltraActualLane {
  id: string;
  status?: string;
  agent?: string;
  model?: string;
  launchContractDigest?: string;
  authorityLaunchContractDigest?: string;
  changedFiles: string[];
  artifactPaths: string[];
  mismatches: string[];
}

export interface UltraRepairReservation {
  version: 1;
  kind: 'repair-reservation';
  reservationId: string;
  repairOf: string;
  rootOperationId: string;
  state: 'reserved' | 'released' | 'consumed';
  createdAt: number;
  updatedAt: number;
}

/**
 * Durable launch-attempt lifecycle.
 *
 * - 'queued': durably recorded BEFORE any permit is issued or child spawned.
 * - 'admitted': permit granted; last durable write BEFORE spawn confirmation.
 *   An attempt found here (especially after restore/replay) is ambiguous: the
 *   child may or may not exist, so it must be inspected, never auto-relaunched.
 * - 'launched': child spawn confirmed by the runtime.
 * - 'failed-pre-spawn': deterministically failed before any child could spawn,
 *   so a retry under a NEW idempotency key is safe. Terminal.
 */
export type UltraLaunchAttemptState = 'queued' | 'admitted' | 'launched' | 'failed-pre-spawn';

export interface UltraLaunchAttempt {
  version: 1;
  kind: 'launch-attempt';
  idempotencyKey: string;
  operationId: string;
  runId: string;
  lanes: UltraOperationLane[];
  receipt: unknown;
  state: UltraLaunchAttemptState;
  reason?: string;
  createdAt: number;
  updatedAt: number;
}

export type UltraOperationEntry = UltraOperation | UltraRepairReservation | UltraLaunchAttempt;

export interface UltraOperation {
  version: 1;
  operationId: string;
  rootOperationId: string;
  repairOf?: string;
  repairCount: 0 | 1;
  runId: string;
  objective: string;
  acceptance: string[];
  lanes: UltraOperationLane[];
  receipt: unknown;
  status: UltraOperationStatus;
  outbox: UltraOperationOutbox;
  actualLanes?: UltraActualLane[];
  /** Exact read-only admission facts that bind a writer handoff to its source. */
  writerBase?: { repositoryRoot: string; baseCommit: string };
  /** Durable evidence that a validated worker patch was materialized elsewhere. */
  handoffCandidate?: { manifestPath: string; candidatePath: string; createdAt: number };
  review?: { state: 'reviewer-running' | 'awaiting-manager-disposition' | 'verified' | 'repair-queued' | 'taken-over'; reviewerRunId?: string; findings?: string; updatedAt: number };
  createdAt: number;
  updatedAt: number;
}

export interface UltraOutboxItem {
  operationId: string;
  runId: string;
  content: string;
  details: Record<string, unknown>;
}

export interface UltraTerminalUpdate {
  operation: UltraOperation;
  content: string;
  details: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeJsonClone<T>(value: T, label: string): T {
  let json: string;
  try { json = JSON.stringify(value); } catch { throw new Error(`${label} must be JSON-safe.`); }
  if (Buffer.byteLength(json, 'utf8') > MAX_ENTRY_BYTES) throw new Error(`${label} exceeds ${MAX_ENTRY_BYTES} bytes.`);
  return JSON.parse(json) as T;
}

function operationClone(operation: UltraOperation): UltraOperation {
  return safeJsonClone(operation, 'Ultra operation');
}

function attemptClone(attempt: UltraLaunchAttempt): UltraLaunchAttempt {
  return safeJsonClone(attempt, 'Ultra launch attempt');
}

/**
 * Derives a deterministic idempotency key for a launch attempt from stable
 * intent inputs. Identical inputs always produce the identical key across
 * restarts and processes, so crash-recovery can look up whether an attempt was
 * already durably recorded instead of blindly launching again.
 */
export function ultraLaunchIdempotencyKey(input: {
  operationId: string;
  runId?: string;
  laneId?: string;
  attemptIndex?: number;
}): string {
  const parts = [
    String(input.operationId ?? ''),
    String(input.runId ?? ''),
    String(input.laneId ?? ''),
    String(input.attemptIndex ?? 0),
  ];
  return `ula1:${createHash('sha256').update(parts.join('\u001f'), 'utf8').digest('hex')}`;
}

function terminalStatus(value: unknown): UltraOperationStatus | undefined {
  if (value === 'complete' || value === 'completed' || value === 'success') return 'completed';
  if (value === 'failed' || value === 'error' || value === 'cancelled') return 'failed';
  if (value === 'stopped' || value === 'aborted') return 'stopped';
  return undefined;
}

function stateFromPayload(payload: Record<string, unknown>): unknown {
  return payload.state ?? payload.status ?? (payload.success === true ? 'complete' : payload.success === false ? 'failed' : undefined);
}

function normalizePath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  // Preserve escaping/absolute reports as evidence: actualForLane will mark
  // them outside the owned path rather than silently erasing an authority
  // violation from the audit record.
  const path = value.trim().replace(/\\/gu, '/').replace(/^\.\//u, '');
  return path || undefined;
}

function collectArtifactPaths(result: Record<string, unknown>): string[] {
  const values: unknown[] = [];
  // Fork completion payloads put the durable patch manifest at
  // payload.parallelHandoff.path. Preserve that exact reference as evidence;
  // materialization validates it later instead of trusting a disposable branch.
  const payload = isRecord(result.payload) ? result.payload : undefined;
  for (const source of [result, payload]) {
    if (!source) continue;
    for (const field of ['artifactPath', 'outputPath', 'savedOutputPath', 'sessionPath', 'sessionFile']) values.push(source[field]);
    if (isRecord(source.artifactPaths)) values.push(...Object.values(source.artifactPaths));
    if (isRecord(source.parallelHandoff)) values.push(source.parallelHandoff.path);
  }
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).map((value) => value.trim().slice(0, 4_096)))].slice(0, 32);
}

function collectChangedFiles(result: Record<string, unknown>): string[] {
  const values: unknown[] = [];
  if (Array.isArray(result.changedFiles)) values.push(...result.changedFiles);
  if (isRecord(result.diffSummary) && Array.isArray(result.diffSummary.changedFiles)) values.push(...result.diffSummary.changedFiles);
  if (isRecord(result.effects) && isRecord(result.effects.fileMutation) && Array.isArray(result.effects.fileMutation.changedFiles)) {
    values.push(...result.effects.fileMutation.changedFiles);
  }
  return [...new Set(values.map(normalizePath).filter((path): path is string => Boolean(path)))].slice(0, MAX_CHANGED_PATHS);
}

function withinOwnedPath(path: string, owned: readonly string[]): boolean {
  return owned.some((root) => path === root || path.startsWith(`${root}/`));
}

function actualForLane(expected: UltraOperationLane, result: Record<string, unknown>): UltraActualLane {
  const status = typeof result.status === 'string' ? result.status : typeof result.state === 'string' ? result.state : undefined;
  const agent = typeof result.agent === 'string' ? result.agent : undefined;
  const model = typeof result.model === 'string' ? result.model : undefined;
  const launchContractDigest = typeof result.launchContractDigest === 'string' ? result.launchContractDigest : undefined;
  const authorityLaunchContractDigest = typeof result.authorityLaunchContractDigest === 'string' ? result.authorityLaunchContractDigest : undefined;
  const changedFiles = collectChangedFiles(result);
  const artifactPaths = collectArtifactPaths(result);
  const mismatches: string[] = [];
  if (agent && agent !== expected.agent) mismatches.push(`agent expected '${expected.agent}' but ran '${agent}'`);
  if (!agent) mismatches.push(`actual agent was not reported for '${expected.id}'`);
  if (expected.expectedFixedModel) {
    if (model && model !== expected.expectedFixedModel) mismatches.push(`model expected fixed '${expected.expectedFixedModel}' but ran '${model}'`);
    if (!model) mismatches.push(`actual model was not reported for '${expected.id}'`);
  } else if (model && !expected.modelCandidates.includes(model)) {
    mismatches.push(`model '${model}' was outside the permitted candidate list`);
  }
  if (authorityLaunchContractDigest && authorityLaunchContractDigest !== expected.launchContractDigest) mismatches.push('authority launch-contract digest mismatch');
  if (!authorityLaunchContractDigest) mismatches.push(`authority launch-contract digest was not reported for '${expected.id}'`);
  if (expected.role === 'worker' && expected.ownedPaths) {
    for (const path of changedFiles) if (!withinOwnedPath(path, expected.ownedPaths)) mismatches.push(`changed path '${path}' is outside owned paths`);
  } else if (changedFiles.length > 0) {
    mismatches.push(`read-only lane reported changed paths: ${changedFiles.join(', ')}`);
  }
  return { id: expected.id, ...(status ? { status } : {}), ...(agent ? { agent } : {}), ...(model ? { model } : {}), ...(launchContractDigest ? { launchContractDigest } : {}), ...(authorityLaunchContractDigest ? { authorityLaunchContractDigest } : {}), changedFiles, artifactPaths, mismatches };
}

function boundedJoined(values: readonly string[], itemLimit: number, totalLimit: number): string {
  const parts: string[] = [];
  let used = 0;
  let omitted = 0;
  for (const value of values) {
    const part = value.slice(0, itemLimit);
    if (used + part.length + (parts.length ? 3 : 0) > totalLimit) { omitted += 1; continue; }
    parts.push(part);
    used += part.length + (parts.length > 1 ? 3 : 0);
  }
  const suffix = omitted ? ` … (${omitted} omitted)` : '';
  return `${parts.join(' | ')}${suffix}` || '(none)';
}

function outboxFor(operation: UltraOperation): UltraOutboxItem {
  const actual = operation.actualLanes ?? [];
  const mismatchCount = actual.reduce((total, lane) => total + lane.mismatches.length, 0);
  const laneLines = operation.lanes.map((expected) => {
    const actualLane = actual.find((lane) => lane.id === expected.id);
    const expectedModel = expected.expectedFixedModel ?? `[${expected.modelCandidates.join(', ')}]`;
    const actualModel = actualLane?.model ?? '(unreported)';
    const actualAgent = actualLane?.agent ?? '(unreported)';
    const laneStatus = actualLane?.status ?? '(unreported)';
    const artifacts = actualLane?.artifactPaths.length ? boundedJoined(actualLane.artifactPaths, 256, 768) : '(none reported)';
    const mismatches = actualLane?.mismatches.length ? boundedJoined(actualLane.mismatches, 256, 1_024) : 'none';
    return `- ${expected.id}: status=${laneStatus.slice(0, 64)}; expected agent=${expected.agent.slice(0, 128)}, model=${expectedModel.slice(0, 512)}; actual agent=${actualAgent.slice(0, 128)}, model=${actualModel.slice(0, 128)}; artifacts=${artifacts}; mismatches=${mismatches}`.slice(0, 2_560);
  });
  const lines = [
    `Ultra operation ${operation.operationId} reached terminal state '${operation.status}' for run ${operation.runId}.`,
    `Acceptance: ${boundedJoined(operation.acceptance, 256, 4_096)}`,
    `Routing/authority mismatches: ${mismatchCount}.`,
    ...laneLines,
    'This packet is evidence only. Inspect referenced artifacts and diffs, run acceptance checks, and decide independently.',
    'If this same operation ID appears again, treat it as an at-least-once delivery retry rather than a second wave.',
  ];
  return {
    operationId: operation.operationId,
    runId: operation.runId,
    content: lines.join('\n'),
    details: {
      kind: 'terminal',
      operationId: operation.operationId,
      runId: operation.runId,
      status: operation.status,
      acceptance: [...operation.acceptance],
      expectedLanes: operation.lanes.map((lane) => ({ ...lane })),
      actualLanes: actual.map((lane) => ({ ...lane })),
      mismatchCount,
      delivery: 'at-least-once',
    },
  };
}

function validReservation(value: unknown): value is UltraRepairReservation {
  return isRecord(value)
    && value.version === 1
    && value.kind === 'repair-reservation'
    && typeof value.reservationId === 'string'
    && typeof value.repairOf === 'string'
    && typeof value.rootOperationId === 'string'
    && (value.state === 'reserved' || value.state === 'released' || value.state === 'consumed');
}

function validLaunchAttempt(value: unknown): value is UltraLaunchAttempt {
  return isRecord(value)
    && value.version === 1
    && value.kind === 'launch-attempt'
    && typeof value.idempotencyKey === 'string'
    && typeof value.operationId === 'string'
    && typeof value.runId === 'string'
    && Array.isArray(value.lanes)
    && ['queued', 'admitted', 'launched', 'failed-pre-spawn'].includes(String(value.state));
}

function validSnapshot(value: unknown): value is UltraOperation {
  if (!isRecord(value) || value.version !== 1) return false;
  if (typeof value.operationId !== 'string' || typeof value.rootOperationId !== 'string' || typeof value.runId !== 'string' || typeof value.objective !== 'string') return false;
  if (!Array.isArray(value.lanes) || !Array.isArray(value.acceptance) || !value.acceptance.every((item) => typeof item === 'string')) return false;
  if (!value.lanes.every((lane) => isRecord(lane)
    && typeof lane.id === 'string'
    && (lane.role === 'scout' || lane.role === 'worker' || lane.role === 'reviewer')
    && typeof lane.agent === 'string'
    && Array.isArray(lane.modelCandidates) && lane.modelCandidates.every((model) => typeof model === 'string')
    && typeof lane.launchContractDigest === 'string'
    && (lane.ownedPaths === undefined || Array.isArray(lane.ownedPaths) && lane.ownedPaths.every((path) => typeof path === 'string')))) return false;
  if (!['running', 'paused', 'completed', 'failed', 'stopped'].includes(String(value.status))) return false;
  if (!['none', 'ready', 'sent'].includes(String(value.outbox))) return false;
  if (value.repairCount !== 0 && value.repairCount !== 1) return false;
  if (value.writerBase !== undefined && (!isRecord(value.writerBase) || typeof value.writerBase.repositoryRoot !== 'string' || typeof value.writerBase.baseCommit !== 'string')) return false;
  if (value.handoffCandidate !== undefined && (!isRecord(value.handoffCandidate) || typeof value.handoffCandidate.manifestPath !== 'string' || typeof value.handoffCandidate.candidatePath !== 'string' || !Number.isSafeInteger(value.handoffCandidate.createdAt))) return false;
  if (value.review !== undefined && (!isRecord(value.review) || !['reviewer-running', 'awaiting-manager-disposition', 'verified', 'repair-queued', 'taken-over'].includes(String(value.review.state)) || !Number.isSafeInteger(value.review.updatedAt) || (value.review.reviewerRunId !== undefined && typeof value.review.reviewerRunId !== 'string') || (value.review.findings !== undefined && typeof value.review.findings !== 'string'))) return false;
  return true;
}

export function createUltraOperationStore(options: {
  append(data: UltraOperationEntry): void;
  now?: () => number;
}) {
  const operations = new Map<string, UltraOperation>();
  const reservations = new Map<string, UltraRepairReservation>();
  const launchAttempts = new Map<string, UltraLaunchAttempt>();
  const runToOperation = new Map<string, string>();
  const now = options.now ?? Date.now;

  const persist = (operation: UltraOperation): UltraOperation => {
    const snapshot = operationClone(operation);
    operations.set(snapshot.operationId, snapshot);
    runToOperation.set(snapshot.runId, snapshot.operationId);
    options.append(operationClone(snapshot));
    return operationClone(snapshot);
  };

  const persistReservation = (reservation: UltraRepairReservation): UltraRepairReservation => {
    const snapshot = safeJsonClone(reservation, 'Ultra repair reservation');
    reservations.set(snapshot.reservationId, snapshot);
    options.append(safeJsonClone(snapshot, 'Ultra repair reservation'));
    return safeJsonClone(snapshot, 'Ultra repair reservation');
  };

  const persistAttempt = (attempt: UltraLaunchAttempt): UltraLaunchAttempt => {
    const snapshot = attemptClone(attempt);
    launchAttempts.set(snapshot.idempotencyKey, snapshot);
    options.append(attemptClone(snapshot));
    return attemptClone(snapshot);
  };

  const transitionAttempt = (
    rawIdempotencyKey: unknown,
    allowedFrom: readonly UltraLaunchAttemptState[],
    state: UltraLaunchAttemptState,
    decorate?: (attempt: UltraLaunchAttempt) => Partial<UltraLaunchAttempt>,
  ): UltraLaunchAttempt => {
    const key = typeof rawIdempotencyKey === 'string' ? rawIdempotencyKey : '';
    const attempt = launchAttempts.get(key);
    if (!attempt) throw new Error(`Ultra launch attempt '${String(rawIdempotencyKey).slice(0, 128)}' was not found.`);
    if (attempt.state !== state && !allowedFrom.includes(attempt.state)) {
      throw new Error(`Ultra launch attempt '${key}' cannot move from '${attempt.state}' to '${state}'.`);
    }
    // Repeating an already-recorded transition is an at-least-once no-op.
    if (attempt.state === state) return attemptClone(attempt);
    attempt.state = state;
    attempt.updatedAt = now();
    if (decorate) Object.assign(attempt, decorate(attempt));
    return persistAttempt(attempt);
  };

  const api = {
    restore(entries: readonly unknown[]): void {
      operations.clear();
      reservations.clear();
      launchAttempts.clear();
      runToOperation.clear();
      for (const entry of entries.slice(-10_000)) {
        if (!isRecord(entry) || entry.type !== 'custom' || entry.customType !== ULTRA_OPERATION_ENTRY) continue;
        try {
          if (validReservation(entry.data)) {
            const reservation = safeJsonClone(entry.data, 'Ultra repair reservation');
            reservations.set(reservation.reservationId, reservation);
            continue;
          }
          if (validLaunchAttempt(entry.data)) {
            const attempt = attemptClone(entry.data);
            launchAttempts.set(attempt.idempotencyKey, attempt);
            if (launchAttempts.size > MAX_LAUNCH_ATTEMPTS) {
              const oldest = launchAttempts.keys().next().value as string | undefined;
              if (oldest) launchAttempts.delete(oldest);
            }
            continue;
          }
          if (!validSnapshot(entry.data)) continue;
          const snapshot = operationClone(entry.data);
          operations.set(snapshot.operationId, snapshot);
          runToOperation.set(snapshot.runId, snapshot.operationId);
          if (operations.size > MAX_OPERATIONS) {
            const oldest = operations.keys().next().value as string | undefined;
            if (oldest) operations.delete(oldest);
          }
        } catch { /* malformed/oversized entries are ignored */ }
      }
    },

    get(operationId: string): UltraOperation | undefined {
      const operation = operations.get(operationId);
      return operation ? operationClone(operation) : undefined;
    },

    list(): UltraOperation[] {
      return [...operations.values()].map(operationClone);
    },

    assertRepairAllowed(repairOf: string): { rootOperationId: string; repairCount: 1 } {
      const source = operations.get(repairOf);
      if (!source) throw new Error(`Repair operation '${repairOf}' was not found.`);
      const rootOperationId = source.rootOperationId;
      if ([...operations.values()].some((operation) => operation.rootOperationId === rootOperationId && operation.repairCount === 1)
        || [...reservations.values()].some((reservation) => reservation.rootOperationId === rootOperationId && reservation.state !== 'released')) {
        throw new Error(`Ultra permits one repair for root operation '${rootOperationId}'; a repair is already reserved/consumed and the main model must take over.`);
      }
      if (!['completed', 'failed', 'stopped'].includes(source.status)) throw new Error(`Repair operation '${repairOf}' is not terminal.`);
      if (source.handoffCandidate && source.review?.state !== 'repair-queued') throw new Error(`Repair operation '${repairOf}' requires a bound reviewer finding and Manager repair disposition.`);
      return { rootOperationId, repairCount: 1 };
    },

    reserveRepair(repairOf: string, reservationId: string): UltraRepairReservation {
      if (reservations.has(reservationId)) throw new Error(`Duplicate repair reservation '${reservationId}'.`);
      const allowed = api.assertRepairAllowed(repairOf);
      const timestamp = now();
      return persistReservation({
        version: 1,
        kind: 'repair-reservation',
        reservationId,
        repairOf,
        rootOperationId: allowed.rootOperationId,
        state: 'reserved',
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    },

    releaseRepair(reservationId: string): UltraRepairReservation {
      const reservation = reservations.get(reservationId);
      if (!reservation) throw new Error(`Repair reservation '${reservationId}' was not found.`);
      if (reservation.state !== 'reserved') return safeJsonClone(reservation, 'Ultra repair reservation');
      reservation.state = 'released';
      reservation.updatedAt = now();
      return persistReservation(reservation);
    },

    // --- Durable launch-attempt state (pre-spawn crash boundary) ---

    /**
     * Durably records a 'queued' attempt. Integration must call this BEFORE
     * issuing the permit/spawning so every launch has an on-disk record first.
     * Repeating the same idempotency key returns the stored attempt unchanged
     * (no duplicate append); conflicting reuse of a key is rejected.
     */
    recordQueuedLaunch(input: {
      idempotencyKey: string;
      operationId: string;
      runId: string;
      lanes: UltraOperationLane[];
      receipt?: unknown;
    }): UltraLaunchAttempt {
      const key = typeof input.idempotencyKey === 'string' ? input.idempotencyKey.trim() : '';
      if (!key || key.length > MAX_IDEMPOTENCY_KEY_CHARS) {
        throw new Error(`Ultra launch idempotency key must be a non-empty string of at most ${MAX_IDEMPOTENCY_KEY_CHARS} characters.`);
      }
      if (typeof input.operationId !== 'string' || !input.operationId || typeof input.runId !== 'string' || !input.runId) {
        throw new Error('Ultra launch attempt requires non-empty operationId and runId strings.');
      }
      const existing = launchAttempts.get(key);
      if (existing) {
        if (existing.operationId !== input.operationId || existing.runId !== input.runId) {
          throw new Error(`Ultra launch idempotency key '${key}' already belongs to operation '${existing.operationId}' run '${existing.runId}'; conflicting reuse is rejected.`);
        }
        return attemptClone(existing);
      }
      const timestamp = now();
      return persistAttempt({
        version: 1,
        kind: 'launch-attempt',
        idempotencyKey: key,
        operationId: input.operationId,
        runId: input.runId,
        lanes: input.lanes.slice(0, 8).map((lane) => ({ ...lane, modelCandidates: [...lane.modelCandidates], ...(lane.ownedPaths ? { ownedPaths: [...lane.ownedPaths] } : {}) })),
        receipt: safeJsonClone(input.receipt ?? null, 'Ultra launch receipt'),
        state: 'queued',
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    },

    markLaunchAdmitted(idempotencyKey: string): UltraLaunchAttempt {
      return transitionAttempt(idempotencyKey, ['queued'], 'admitted');
    },

    markLaunched(idempotencyKey: string): UltraLaunchAttempt {
      return transitionAttempt(idempotencyKey, ['admitted'], 'launched');
    },

    markFailedPreSpawn(idempotencyKey: string, reason: string): UltraLaunchAttempt {
      const text = typeof reason === 'string' ? reason.trim() : '';
      if (!text) throw new Error('Ultra pre-spawn failure requires a non-empty reason.');
      return transitionAttempt(idempotencyKey, ['queued', 'admitted'], 'failed-pre-spawn', (attempt) => ({ ...attempt, reason: text.slice(0, MAX_FAILURE_REASON_CHARS) }));
    },

    getLaunchAttempt(idempotencyKey: string): UltraLaunchAttempt | undefined {
      const attempt = launchAttempts.get(idempotencyKey);
      return attempt ? attemptClone(attempt) : undefined;
    },

    listLaunchAttempts(): UltraLaunchAttempt[] {
      return [...launchAttempts.values()].map(attemptClone);
    },

    /**
     * Attempts still in 'admitted' sit in the pre-spawn ambiguity window: the
     * durable log says admitted but spawn confirmation ('launched') was never
     * recorded. Callers must inspect these (session files, receipts) and settle
     * them explicitly via markLaunched/markFailedPreSpawn; the store never
     * relaunches them implicitly.
     */
    ambiguousAdmittedLaunches(): UltraLaunchAttempt[] {
      return [...launchAttempts.values()].filter((attempt) => attempt.state === 'admitted').map(attemptClone);
    },

    recordLaunch(input: {
      operationId: string;
      runId: string;
      objective: string;
      acceptance: string[];
      lanes: UltraOperationLane[];
      receipt: unknown;
      repairOf?: string;
      repairReservationId?: string;
      writerBase?: { repositoryRoot: string; baseCommit: string };
    }): UltraOperation {
      if (operations.has(input.operationId)) throw new Error(`Duplicate Ultra operation '${input.operationId}'.`);
      if (runToOperation.has(input.runId)) throw new Error(`Duplicate Ultra run '${input.runId}'.`);
      let repair: { rootOperationId: string; repairCount: 1 } | undefined;
      if (input.repairOf) {
        if (!input.repairReservationId) throw new Error('Repair launch requires a durable reservation.');
        const reservation = reservations.get(input.repairReservationId);
        if (!reservation || reservation.state !== 'reserved' || reservation.repairOf !== input.repairOf) throw new Error('Repair reservation is missing, stale, or mismatched.');
        reservation.state = 'consumed';
        reservation.updatedAt = now();
        persistReservation(reservation);
        repair = { rootOperationId: reservation.rootOperationId, repairCount: 1 };
      }
      const timestamp = now();
      const operation: UltraOperation = {
        version: 1,
        operationId: input.operationId,
        rootOperationId: repair?.rootOperationId ?? input.operationId,
        ...(input.repairOf ? { repairOf: input.repairOf } : {}),
        repairCount: repair?.repairCount ?? 0,
        runId: input.runId,
        objective: input.objective.slice(0, 4_096),
        acceptance: input.acceptance.slice(0, 32).map((item) => item.slice(0, 2_048)),
        lanes: input.lanes.slice(0, 8).map((lane) => ({ ...lane, modelCandidates: [...lane.modelCandidates], ...(lane.ownedPaths ? { ownedPaths: [...lane.ownedPaths] } : {}) })),
        receipt: safeJsonClone(input.receipt, 'Ultra receipt'),
        ...(input.writerBase ? { writerBase: { repositoryRoot: input.writerBase.repositoryRoot.slice(0, 4_096), baseCommit: input.writerBase.baseCommit.slice(0, 128) } } : {}),
        status: 'running',
        outbox: 'none',
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      return persist(operation);
    },

    recordMaterializedHandoff(operationId: string, input: { manifestPath: string; candidatePath: string }): UltraOperation {
      const operation = operations.get(operationId);
      if (!operation) throw new Error(`Ultra operation '${operationId}' was not found.`);
      if (operation.status !== 'completed') throw new Error('A handoff candidate requires a completed writer operation.');
      if (!operation.writerBase || !operation.lanes.some((lane) => lane.role === 'worker')) throw new Error('Only admitted writer operations may materialize a handoff candidate.');
      if (operation.handoffCandidate) throw new Error(`Ultra operation '${operationId}' already has a materialized handoff candidate.`);
      operation.handoffCandidate = { manifestPath: input.manifestPath.slice(0, 4_096), candidatePath: input.candidatePath.slice(0, 4_096), createdAt: now() };
      operation.updatedAt = now();
      return persist(operation);
    },

    beginReviewer(operationId: string, reviewerRunId: string): UltraOperation {
      const operation = operations.get(operationId);
      if (!operation?.handoffCandidate) throw new Error('Reviewer launch requires a materialized handoff candidate.');
      if (operation.review) throw new Error(`Ultra operation '${operationId}' already has reviewer state.`);
      if (!reviewerRunId.trim()) throw new Error('Reviewer launch requires a run ID.');
      operation.review = { state: 'reviewer-running', reviewerRunId: reviewerRunId.slice(0, 256), updatedAt: now() };
      operation.updatedAt = now();
      return persist(operation);
    },

    recordReviewerFindings(operationId: string, findings: string): UltraOperation {
      const operation = operations.get(operationId);
      if (!operation?.review || operation.review.state !== 'reviewer-running') throw new Error('Reviewer findings require a running bound reviewer.');
      const text = findings.trim();
      if (!text) throw new Error('Reviewer findings must be non-empty.');
      operation.review = { ...operation.review, state: 'awaiting-manager-disposition', findings: text.slice(0, MAX_FAILURE_REASON_CHARS), updatedAt: now() };
      operation.updatedAt = now();
      return persist(operation);
    },

    recordManagerDisposition(operationId: string, state: 'verified' | 'repair-queued' | 'taken-over'): UltraOperation {
      const operation = operations.get(operationId);
      if (!operation?.review || operation.review.state !== 'awaiting-manager-disposition') throw new Error('Manager disposition requires bound reviewer findings.');
      operation.review = { ...operation.review, state, updatedAt: now() };
      operation.updatedAt = now();
      return persist(operation);
    },

    applyCompletion(payload: unknown): UltraTerminalUpdate | undefined {
      if (!isRecord(payload)) return undefined;
      const runId = typeof payload.runId === 'string' ? payload.runId : typeof payload.id === 'string' ? payload.id : undefined;
      if (!runId) return undefined;
      const operationId = runToOperation.get(runId);
      if (!operationId) return undefined;
      const operation = operations.get(operationId)!;
      if (['completed', 'failed', 'stopped'].includes(operation.status)) return undefined;
      const state = stateFromPayload(payload);
      if (state === 'paused' || state === 'interrupted') {
        operation.status = 'paused';
        operation.updatedAt = now();
        persist(operation);
        return undefined;
      }
      const terminal = terminalStatus(state);
      if (!terminal) return undefined;
      const results = Array.isArray(payload.results) ? payload.results.filter(isRecord).slice(0, MAX_RESULTS) : [];
      const hasStableKeys = results.some((candidate) => typeof candidate.workflowKey === 'string' || typeof candidate.key === 'string');
      operation.actualLanes = operation.lanes.map((expected, index) => {
        const keyed = results.filter((candidate) => candidate.workflowKey === expected.id || candidate.key === expected.id);
        const result = hasStableKeys ? keyed[0] ?? {} : results[index] ?? {};
        const actual = actualForLane(expected, result);
        if (keyed.length > 1) actual.mismatches.push(`duplicate result key '${expected.id}'`);
        return actual;
      });
      if (hasStableKeys && operation.actualLanes.length > 0) {
        const expectedKeys = new Set(operation.lanes.map((lane) => lane.id));
        for (const result of results) {
          const key = typeof result.workflowKey === 'string' ? result.workflowKey : typeof result.key === 'string' ? result.key : undefined;
          if (key && !expectedKeys.has(key)) operation.actualLanes[0]!.mismatches.push(`unknown result key '${key}'`);
        }
      }
      operation.status = terminal;
      operation.outbox = 'ready';
      operation.updatedAt = now();
      const persisted = persist(operation);
      const packet = outboxFor(persisted);
      return { operation: persisted, content: packet.content, details: packet.details };
    },

    pendingOutbox(): UltraOutboxItem[] {
      return [...operations.values()].filter((operation) => operation.outbox === 'ready').map(outboxFor);
    },

    markOutboxSent(operationId: string): UltraOperation {
      const operation = operations.get(operationId);
      if (!operation) throw new Error(`Ultra operation '${operationId}' was not found.`);
      if (operation.outbox === 'sent') return operationClone(operation);
      if (operation.outbox !== 'ready') throw new Error(`Ultra operation '${operationId}' has no ready outbox item.`);
      operation.outbox = 'sent';
      operation.updatedAt = now();
      return persist(operation);
    },
  };
  return api;
}
