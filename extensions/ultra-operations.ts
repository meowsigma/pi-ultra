export const ULTRA_OPERATION_ENTRY = 'ultra.operation.v1' as const;
const MAX_OPERATIONS = 256;
const MAX_ENTRY_BYTES = 131_072;
const MAX_RESULTS = 64;
const MAX_CHANGED_PATHS = 128;

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

export type UltraOperationEntry = UltraOperation | UltraRepairReservation;

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
  const path = value.trim().replace(/\\/gu, '/').replace(/^\.\//u, '');
  if (!path || path.startsWith('/') || path.startsWith('../') || path.includes('/../')) return undefined;
  return path;
}

function collectArtifactPaths(result: Record<string, unknown>): string[] {
  const values: unknown[] = [];
  for (const field of ['artifactPath', 'outputPath', 'savedOutputPath', 'sessionPath', 'sessionFile']) values.push(result[field]);
  if (isRecord(result.artifactPaths)) values.push(...Object.values(result.artifactPaths));
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

function validSnapshot(value: unknown): value is UltraOperation {
  if (!isRecord(value) || value.version !== 1) return false;
  if (typeof value.operationId !== 'string' || typeof value.rootOperationId !== 'string' || typeof value.runId !== 'string') return false;
  if (!Array.isArray(value.lanes) || !Array.isArray(value.acceptance)) return false;
  if (!['running', 'paused', 'completed', 'failed', 'stopped'].includes(String(value.status))) return false;
  if (!['none', 'ready', 'sent'].includes(String(value.outbox))) return false;
  if (value.repairCount !== 0 && value.repairCount !== 1) return false;
  return true;
}

export function createUltraOperationStore(options: {
  append(data: UltraOperationEntry): void;
  now?: () => number;
}) {
  const operations = new Map<string, UltraOperation>();
  const reservations = new Map<string, UltraRepairReservation>();
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

  const api = {
    restore(entries: readonly unknown[]): void {
      operations.clear();
      reservations.clear();
      runToOperation.clear();
      for (const entry of entries.slice(-10_000)) {
        if (!isRecord(entry) || entry.type !== 'custom' || entry.customType !== ULTRA_OPERATION_ENTRY) continue;
        try {
          if (validReservation(entry.data)) {
            const reservation = safeJsonClone(entry.data, 'Ultra repair reservation');
            reservations.set(reservation.reservationId, reservation);
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

    recordLaunch(input: {
      operationId: string;
      runId: string;
      objective: string;
      acceptance: string[];
      lanes: UltraOperationLane[];
      receipt: unknown;
      repairOf?: string;
      repairReservationId?: string;
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
        status: 'running',
        outbox: 'none',
        createdAt: timestamp,
        updatedAt: timestamp,
      };
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
