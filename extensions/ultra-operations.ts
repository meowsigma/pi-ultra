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
  agent?: string;
  model?: string;
  launchContractDigest?: string;
  changedFiles: string[];
  mismatches: string[];
}

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
  const agent = typeof result.agent === 'string' ? result.agent : undefined;
  const model = typeof result.model === 'string' ? result.model : undefined;
  const launchContractDigest = typeof result.launchContractDigest === 'string' ? result.launchContractDigest : undefined;
  const changedFiles = collectChangedFiles(result);
  const mismatches: string[] = [];
  if (agent && agent !== expected.agent) mismatches.push(`agent expected '${expected.agent}' but ran '${agent}'`);
  if (!agent) mismatches.push(`actual agent was not reported for '${expected.id}'`);
  if (expected.expectedFixedModel) {
    if (model && model !== expected.expectedFixedModel) mismatches.push(`model expected fixed '${expected.expectedFixedModel}' but ran '${model}'`);
    if (!model) mismatches.push(`actual model was not reported for '${expected.id}'`);
  } else if (model && !expected.modelCandidates.includes(model)) {
    mismatches.push(`model '${model}' was outside the permitted candidate list`);
  }
  if (launchContractDigest && launchContractDigest !== expected.launchContractDigest) mismatches.push('launch-contract digest mismatch');
  if (!launchContractDigest) mismatches.push(`launch-contract digest was not reported for '${expected.id}'`);
  if (expected.role === 'worker' && expected.ownedPaths) {
    for (const path of changedFiles) if (!withinOwnedPath(path, expected.ownedPaths)) mismatches.push(`changed path '${path}' is outside owned paths`);
  } else if (changedFiles.length > 0) {
    mismatches.push(`read-only lane reported changed paths: ${changedFiles.join(', ')}`);
  }
  return { id: expected.id, ...(agent ? { agent } : {}), ...(model ? { model } : {}), ...(launchContractDigest ? { launchContractDigest } : {}), changedFiles, mismatches };
}

function outboxFor(operation: UltraOperation): UltraOutboxItem {
  const actual = operation.actualLanes ?? [];
  const mismatchCount = actual.reduce((total, lane) => total + lane.mismatches.length, 0);
  const lines = [
    `Ultra operation ${operation.operationId} reached terminal state '${operation.status}' for run ${operation.runId}.`,
    `Lanes: ${operation.lanes.map((lane) => lane.id).join(', ') || '(none)'}. Routing/authority mismatches: ${mismatchCount}.`,
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
  append(data: UltraOperation): void;
  now?: () => number;
}) {
  const operations = new Map<string, UltraOperation>();
  const runToOperation = new Map<string, string>();
  const now = options.now ?? Date.now;

  const persist = (operation: UltraOperation): UltraOperation => {
    const snapshot = operationClone(operation);
    operations.set(snapshot.operationId, snapshot);
    runToOperation.set(snapshot.runId, snapshot.operationId);
    options.append(operationClone(snapshot));
    return operationClone(snapshot);
  };

  const api = {
    restore(entries: readonly unknown[]): void {
      operations.clear();
      runToOperation.clear();
      for (const entry of entries.slice(-10_000)) {
        if (!isRecord(entry) || entry.type !== 'custom' || entry.customType !== ULTRA_OPERATION_ENTRY || !validSnapshot(entry.data)) continue;
        try {
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
      if ([...operations.values()].some((operation) => operation.rootOperationId === rootOperationId && operation.repairCount === 1)) {
        throw new Error(`Ultra permits one repair for root operation '${rootOperationId}'; the main model must take over.`);
      }
      if (!['completed', 'failed', 'stopped'].includes(source.status)) throw new Error(`Repair operation '${repairOf}' is not terminal.`);
      return { rootOperationId, repairCount: 1 };
    },

    recordLaunch(input: {
      operationId: string;
      runId: string;
      objective: string;
      acceptance: string[];
      lanes: UltraOperationLane[];
      receipt: unknown;
      repairOf?: string;
    }): UltraOperation {
      if (operations.has(input.operationId)) throw new Error(`Duplicate Ultra operation '${input.operationId}'.`);
      if (runToOperation.has(input.runId)) throw new Error(`Duplicate Ultra run '${input.runId}'.`);
      const repair = input.repairOf ? api.assertRepairAllowed(input.repairOf) : undefined;
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
      operation.actualLanes = operation.lanes.map((expected, index) => {
        const result = results.find((candidate) => candidate.workflowKey === expected.id || candidate.key === expected.id) ?? results[index] ?? {};
        return actualForLane(expected, result);
      });
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
