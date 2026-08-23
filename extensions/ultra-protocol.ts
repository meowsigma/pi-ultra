import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { Type } from 'typebox';
import {
  ULTRA_MAX_LANES,
  ULTRA_ROLE_NAMES,
  type UltraRole,
  type UltraSettings,
} from './ultra-config.js';

export const SUBAGENT_RPC_REQUEST = 'subagents:rpc:v1:request' as const;
export const subagentRpcReply = (id: string): string => `subagents:rpc:v1:reply:${id}`;
export const ROLE_AGENTS = {
  scout: 'ultra-scout',
  worker: 'ultra-worker',
  reviewer: 'ultra-reviewer',
} as const satisfies Record<UltraRole, string>;

const ROLE_SET = new Set<string>(ULTRA_ROLE_NAMES);
const LANE_ID = /^[a-z][a-z0-9-]{0,47}$/u;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const MAX_OBJECTIVE = 4_096;
const MAX_TASK = 16_384;
const MAX_DELIVERABLE = 2_048;
const MAX_ACCEPTANCE = 32;
const MAX_ACCEPTANCE_ITEM = 2_048;
const MAX_PATHS = 32;
const MAX_PATH = 512;
const DEFAULT_RPC_TIMEOUT_MS = 1_500;
const PERMIT_EXPIRY_MS = 5_000;
const MUTATING_TOOLS = new Set(['bash', 'edit', 'write', 'subagent']);

export const ULTRA_DELEGATE_SCHEMA = Type.Object({
  objective: Type.String({ minLength: 1, maxLength: MAX_OBJECTIVE }),
  lanes: Type.Array(Type.Object({
    id: Type.String({ pattern: LANE_ID.source, minLength: 1, maxLength: 48 }),
    role: Type.Union(ULTRA_ROLE_NAMES.map((role) => Type.Literal(role))),
    task: Type.String({ minLength: 1, maxLength: MAX_TASK }),
    deliverable: Type.String({ minLength: 1, maxLength: MAX_DELIVERABLE }),
    ownedPaths: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: MAX_PATH }), { minItems: 1, maxItems: MAX_PATHS })),
  }, { additionalProperties: false }), { minItems: 1, maxItems: ULTRA_MAX_LANES }),
  acceptance: Type.Array(Type.String({ minLength: 1, maxLength: MAX_ACCEPTANCE_ITEM }), { minItems: 1, maxItems: MAX_ACCEPTANCE }),
  repairOf: Type.Optional(Type.String({ pattern: OPERATION_ID.source, minLength: 1, maxLength: 128 })),
}, { additionalProperties: false });

export interface UltraDelegateLane {
  id: string;
  role: UltraRole;
  task: string;
  deliverable: string;
  ownedPaths?: string[];
}

export interface UltraDelegateInput {
  objective: string;
  lanes: UltraDelegateLane[];
  acceptance: string[];
  repairOf?: string;
}

export interface UltraLaunchAuthorityLane {
  key: string;
  agent: string;
  modelCandidates: string[];
  launchContractDigest: string;
}

export interface UltraLaunchAuthorityHandle {
  issueOnce(input: {
    configRevision: string;
    expiresInMs: number;
    requestDigest: string;
    minLanes: number;
    maxLanes: number;
    lanes: UltraLaunchAuthorityLane[];
  }): string;
  revokeUnused(): void;
  dispose(): void;
}

export interface UltraCapabilityCeiling {
  version: 1;
  allowedTools?: string[];
  allowedAgents?: string[];
  denyExtensions: boolean;
  sources: string[];
}

export interface UltraLaunchContract {
  agent: { name: string; localName?: string };
  context: 'fresh' | 'fork';
  model?: string;
  modelCandidates: string[];
  tools: {
    effectiveAllowlist: string[];
    runtimeExtensions: string[];
    configuredExtensions: string[];
    disableAmbientExtensions: boolean;
  };
  launchContractDigest: string;
}

export type UltraLaunchContractResult =
  | { ok: true; contract: UltraLaunchContract }
  | { ok: false; code: string; message: string };

export type ResolveLaunchContract = (input: Record<string, unknown>) => Promise<UltraLaunchContractResult>;

export interface UltraPreparedLane {
  lane: UltraDelegateLane;
  agent: string;
  modelCandidates: string[];
  requestedModel?: string;
  launchContractDigest: string;
}

export interface UltraPreparedWave {
  objective: string;
  acceptance: string[];
  revision: string;
  settings: UltraSettings;
  lanes: UltraPreparedLane[];
  script: string;
  params: {
    workflowScript: string;
    cwd: string;
    context: 'fresh';
    async: true;
    mission: false;
  };
}

export interface UltraEventBus {
  on(event: string, handler: (data: unknown) => void): (() => void) | void;
  emit(event: string, data: unknown): void;
}

const PREFLIGHT_MODULE = 'pi-subagents/preflight';
const AUTHORITY_MODULE = 'pi-subagents/launch-authority';

async function defaultResolveContract(input: Record<string, unknown>): Promise<UltraLaunchContractResult> {
  const module = await import(PREFLIGHT_MODULE) as {
    resolveSubagentLaunchContract(value: Record<string, unknown>): Promise<UltraLaunchContractResult>;
  };
  return module.resolveSubagentLaunchContract(input);
}

async function requestDigest(params: Record<string, unknown>): Promise<string> {
  const module = await import(AUTHORITY_MODULE) as {
    digestSubagentLaunchRequest(value: Record<string, unknown>, domain?: string): string;
  };
  return module.digestSubagentLaunchRequest(params, 'rpc.spawn');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const set = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !set.has(key));
  if (unexpected) throw new Error(`${label} contains unsupported field '${unexpected}'.`);
}

function boundedString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`);
  const normalized = value.trim();
  if (!normalized || value.length > maxLength || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} must be non-empty, control-safe, and no longer than ${maxLength} characters.`);
  }
  return normalized;
}

function semanticKey(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}]+/gu, ' ').replace(/\s+/gu, ' ').trim();
}

function normalizeOwnedPath(value: unknown, label: string): string {
  const raw = boundedString(value, label, MAX_PATH).replace(/\\/gu, '/');
  if (/^[A-Za-z]:\//u.test(raw) || raw.startsWith('/') || /[*?[\]{}]/u.test(raw)) throw new Error(`${label} is an unsafe owned path.`);
  const segments = raw.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) throw new Error(`${label} is an unsafe owned path.`);
  const normalized = posix.normalize(raw);
  if (normalized === '.' || normalized.startsWith('../')) throw new Error(`${label} is an unsafe owned path.`);
  return normalized;
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export function validateUltraDelegateInput(value: unknown, bounds: { minLanes: number; maxLanes: number }): UltraDelegateInput {
  if (!Number.isSafeInteger(bounds.minLanes) || !Number.isSafeInteger(bounds.maxLanes) || bounds.minLanes < 1 || bounds.maxLanes > ULTRA_MAX_LANES || bounds.minLanes > bounds.maxLanes) {
    throw new Error(`Lane bounds must satisfy 1 <= minLanes <= maxLanes <= ${ULTRA_MAX_LANES}.`);
  }
  if (!isRecord(value)) throw new Error('ultra_delegate input must be an object.');
  exactKeys(value, ['objective', 'lanes', 'acceptance', 'repairOf'], 'ultra_delegate input');
  const objective = boundedString(value.objective, 'objective', MAX_OBJECTIVE);
  if (!Array.isArray(value.lanes) || value.lanes.length < bounds.minLanes || value.lanes.length > bounds.maxLanes) {
    throw new Error(`lanes must contain between ${bounds.minLanes} and ${bounds.maxLanes} entries.`);
  }
  if (!Array.isArray(value.acceptance) || value.acceptance.length < 1 || value.acceptance.length > MAX_ACCEPTANCE) {
    throw new Error(`acceptance must contain 1..${MAX_ACCEPTANCE} entries.`);
  }
  const acceptance = value.acceptance.map((entry, index) => boundedString(entry, `acceptance[${index}]`, MAX_ACCEPTANCE_ITEM));
  if (new Set(acceptance.map(semanticKey)).size !== acceptance.length) throw new Error('acceptance entries must be semantically unique.');
  const repairOf = value.repairOf === undefined ? undefined : boundedString(value.repairOf, 'repairOf', 128);
  if (repairOf !== undefined && !OPERATION_ID.test(repairOf)) throw new Error('repairOf is invalid.');

  const ids = new Set<string>();
  const tasks = new Set<string>();
  const deliverables = new Set<string>();
  const writerPaths: Array<{ laneId: string; path: string }> = [];
  const lanes = value.lanes.map((raw, index): UltraDelegateLane => {
    if (!isRecord(raw)) throw new Error(`lanes[${index}] must be an object.`);
    exactKeys(raw, ['id', 'role', 'task', 'deliverable', 'ownedPaths'], `lanes[${index}]`);
    const id = boundedString(raw.id, `lanes[${index}].id`, 48);
    if (!LANE_ID.test(id)) throw new Error(`lanes[${index}].id is invalid.`);
    if (ids.has(id)) throw new Error(`Duplicate lane id '${id}'.`);
    ids.add(id);
    if (typeof raw.role !== 'string' || !ROLE_SET.has(raw.role)) throw new Error(`lanes[${index}].role is invalid.`);
    const role = raw.role as UltraRole;
    const task = boundedString(raw.task, `lanes[${index}].task`, MAX_TASK);
    const taskKey = semanticKey(task);
    if (tasks.has(taskKey)) throw new Error(`Duplicate task at lanes[${index}].`);
    tasks.add(taskKey);
    const deliverable = boundedString(raw.deliverable, `lanes[${index}].deliverable`, MAX_DELIVERABLE);
    const deliverableKey = semanticKey(deliverable);
    if (deliverables.has(deliverableKey)) throw new Error(`Duplicate deliverable at lanes[${index}].`);
    deliverables.add(deliverableKey);
    if (role !== 'worker' && raw.ownedPaths !== undefined) throw new Error(`ownedPaths are allowed only for worker lanes.`);
    if (role === 'worker' && (!Array.isArray(raw.ownedPaths) || raw.ownedPaths.length < 1 || raw.ownedPaths.length > MAX_PATHS)) {
      throw new Error(`Worker lane '${id}' requires 1..${MAX_PATHS} ownedPaths.`);
    }
    const ownedPaths = role === 'worker'
      ? (raw.ownedPaths as unknown[]).map((path, pathIndex) => normalizeOwnedPath(path, `lanes[${index}].ownedPaths[${pathIndex}]`))
      : undefined;
    if (ownedPaths && new Set(ownedPaths).size !== ownedPaths.length) throw new Error(`Worker lane '${id}' has duplicate ownedPaths.`);
    for (const path of ownedPaths ?? []) {
      const overlap = writerPaths.find((entry) => pathsOverlap(entry.path, path));
      if (overlap) throw new Error(`Worker owned paths overlap between '${overlap.laneId}' and '${id}'.`);
      writerPaths.push({ laneId: id, path });
    }
    return { id, role, task, deliverable, ...(ownedPaths ? { ownedPaths } : {}) };
  });
  return { objective, lanes, acceptance, ...(repairOf ? { repairOf } : {}) };
}

function roleMatches(contract: UltraLaunchContract, requested: string): boolean {
  return contract.agent.name === requested || contract.agent.localName === requested || contract.agent.name.endsWith(`.${requested}`);
}

function validateRoleContract(role: UltraRole, requestedAgent: string, contract: UltraLaunchContract): void {
  if (!roleMatches(contract, requestedAgent)) throw new Error(`Lane role '${role}' resolved unexpected agent '${contract.agent.name}'.`);
  if (contract.context !== 'fresh') throw new Error(`Lane role '${role}' resolved non-fresh context '${contract.context}'.`);
  if (!DIGEST.test(contract.launchContractDigest)) throw new Error(`Lane role '${role}' returned an invalid launch-contract digest.`);
  if (!Array.isArray(contract.modelCandidates) || contract.modelCandidates.length < 1 || contract.modelCandidates.some((model) => typeof model !== 'string' || !model.includes('/'))) {
    throw new Error(`Lane role '${role}' returned invalid model candidates.`);
  }
  const tools = new Set(contract.tools.effectiveAllowlist);
  if (role === 'worker') {
    for (const required of ['read', 'bash', 'edit', 'write']) if (!tools.has(required)) throw new Error(`Worker role is missing required mutation tool '${required}'.`);
    if (tools.has('subagent')) throw new Error('Worker role must not expose nested subagent launches.');
  } else {
    const mutation = [...MUTATING_TOOLS].find((tool) => tools.has(tool));
    if (mutation) throw new Error(`${role} role is not read-only; mutation tool '${mutation}' is present.`);
  }
  if (contract.tools.runtimeExtensions.length > 0 || contract.tools.configuredExtensions.length > 0 || contract.tools.disableAmbientExtensions !== true) {
    throw new Error(`Lane role '${role}' must deny ambient/configured extensions.`);
  }
}

async function preflight(
  input: PrepareUltraWaveInput,
  lane: UltraDelegateLane,
  model?: string,
): Promise<UltraLaunchContract> {
  const agent = ROLE_AGENTS[lane.role];
  const result = await (input.resolveContract ?? defaultResolveContract)({
    agent,
    cwd: input.cwd,
    task: lane.task,
    context: 'fresh',
    ...(model ? { model } : {}),
    availableModels: input.availableModels,
    parentModel: input.parentModel,
    capabilityCeiling: input.capabilityCeiling,
  });
  if (!result.ok) throw new Error(`Lane '${lane.id}' preflight failed (${result.code}): ${result.message}`);
  validateRoleContract(lane.role, agent, result.contract);
  return result.contract;
}

export interface PrepareUltraWaveInput {
  input: UltraDelegateInput;
  settings: UltraSettings;
  cwd: string;
  sessionId: string;
  revision: string;
  availableModels: ReadonlyArray<{ provider: string; id: string; fullId?: string; reasoning?: boolean }>;
  parentModel?: { provider: string; id?: string };
  capabilityCeiling?: UltraCapabilityCeiling;
  resolveContract?: ResolveLaunchContract;
}

export async function prepareUltraWave(input: PrepareUltraWaveInput): Promise<UltraPreparedWave> {
  const validated = validateUltraDelegateInput(input.input, { minLanes: input.settings.minLanes, maxLanes: input.settings.maxLanes });
  let uniformModel: string | undefined;
  if (input.settings.routingMode === 'uniform') {
    if (input.settings.workerModel) uniformModel = input.settings.workerModel;
    else {
      const seedLane: UltraDelegateLane = {
        id: 'automatic-seed', role: 'worker', task: 'Resolve the automatic Ultra worker model.',
        deliverable: 'One canonical model binding.', ownedPaths: ['automatic-seed'],
      };
      const seed = await preflight(input, seedLane);
      uniformModel = seed.model ?? seed.modelCandidates[0];
      if (!uniformModel) throw new Error('Automatic routing could not resolve a canonical model.');
    }
  }
  const lanes = await Promise.all(validated.lanes.map(async (lane): Promise<UltraPreparedLane> => {
    const contract = await preflight(input, lane, uniformModel);
    if (uniformModel && (contract.modelCandidates.length !== 1 || contract.modelCandidates[0] !== uniformModel || contract.model !== uniformModel)) {
      throw new Error(`Uniform model '${uniformModel}' must be the sole candidate for lane '${lane.id}'.`);
    }
    return {
      lane,
      agent: contract.agent.name,
      modelCandidates: [...contract.modelCandidates],
      ...(uniformModel ? { requestedModel: uniformModel } : {}),
      launchContractDigest: contract.launchContractDigest,
    };
  }));
  const script = buildUltraWorkflow(lanes);
  const params = { workflowScript: script, cwd: input.cwd, context: 'fresh' as const, async: true as const, mission: false as const };
  return { objective: validated.objective, acceptance: validated.acceptance, revision: input.revision, settings: { ...input.settings }, lanes, script, params };
}

function taskForLane(prepared: UltraPreparedLane): string {
  const { lane } = prepared;
  const authority = lane.role === 'worker'
    ? `WRITE only for the declared deliverable inside this managed worktree.\nOwned paths: ${lane.ownedPaths!.join(', ')}`
    : 'READ-ONLY. Inspect and report; do not mutate files or run mutation-capable tools.';
  return `Ultra role: ${lane.role}\nAuthority: ${authority}\nDeliverable: ${lane.deliverable}\nTask:\n${lane.task}`;
}

export function buildUltraWorkflow(lanes: readonly UltraPreparedLane[]): string {
  if (!Array.isArray(lanes) || lanes.length < 1 || lanes.length > ULTRA_MAX_LANES) throw new Error(`Ultra workflow requires 1..${ULTRA_MAX_LANES} lanes.`);
  const keys = new Set<string>();
  const items = lanes.map((prepared) => {
    if (keys.has(prepared.lane.id)) throw new Error(`Duplicate prepared lane '${prepared.lane.id}'.`);
    keys.add(prepared.lane.id);
    return {
      key: prepared.lane.id,
      agent: prepared.agent,
      task: taskForLane(prepared),
      context: 'fresh' as const,
      ...(prepared.requestedModel ? { model: prepared.requestedModel } : {}),
      ...(prepared.lane.role === 'worker' ? { worktree: true as const } : {}),
      output: true as const,
    };
  });
  return `return await runs.all(${JSON.stringify(items)});`;
}

function permitManifest(prepared: UltraPreparedWave): UltraLaunchAuthorityLane[] {
  return prepared.lanes.map((lane) => ({
    key: lane.lane.id,
    agent: lane.agent,
    modelCandidates: [...lane.modelCandidates],
    launchContractDigest: lane.launchContractDigest,
  }));
}

export async function launchUltraWave(input: {
  events: UltraEventBus;
  authority: UltraLaunchAuthorityHandle;
  prepared: UltraPreparedWave;
  timeoutMs?: number;
}): Promise<unknown> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error('RPC timeout must be a positive integer no greater than 60000ms.');
  const digest = await requestDigest(input.prepared.params);
  const permit = input.authority.issueOnce({
    configRevision: input.prepared.revision,
    expiresInMs: PERMIT_EXPIRY_MS,
    requestDigest: digest,
    minLanes: input.prepared.settings.minLanes,
    maxLanes: input.prepared.settings.maxLanes,
    lanes: permitManifest(input.prepared),
  });
  const requestId = randomUUID();
  const replyEvent = subagentRpcReply(requestId);
  return new Promise((resolve, reject) => {
    let settled = false;
    let dispose: (() => void) | void;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (typeof dispose === 'function') dispose();
      callback();
    };
    const timer = setTimeout(() => {
      input.authority.revokeUnused();
      finish(() => reject(new Error(`Subagent spawn RPC timed out after ${timeoutMs}ms.`)));
    }, timeoutMs);
    dispose = input.events.on(replyEvent, (payload) => {
      if (!isRecord(payload) || payload.requestId !== requestId) return;
      if (payload.version !== 1 || (payload.method !== undefined && payload.method !== 'spawn')) {
        input.authority.revokeUnused();
        finish(() => reject(new Error('Subagent spawn RPC returned an incompatible reply.')));
        return;
      }
      if (payload.success === true) {
        finish(() => resolve(payload.data));
        return;
      }
      const message = isRecord(payload.error) && typeof payload.error.message === 'string' ? payload.error.message : 'Subagent spawn RPC failed.';
      input.authority.revokeUnused();
      finish(() => reject(new Error(message)));
    });
    input.events.emit(SUBAGENT_RPC_REQUEST, {
      version: 1,
      requestId,
      method: 'spawn',
      source: { extension: 'pi-ultra' },
      params: input.prepared.params,
      authorization: { launchPermits: [permit] },
    });
  });
}
