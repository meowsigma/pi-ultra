import { randomUUID } from 'node:crypto';
import {
  SUBAGENT_DELEGATION_REQUEST_EVENT,
  SUBAGENT_DELEGATION_RESPONSE_EVENT,
  type SubagentDelegationRequest,
  type SubagentDelegationResponse,
} from 'pi-subagents/delegation';
import {
  ULTRA_MAX_LANES,
  ULTRA_MIN_LANES,
  ULTRA_ROLE_NAMES,
  type UltraRole,
} from './ultra-config.js';

export const SUBAGENT_RPC_READY = 'subagents:rpc:v1:ready' as const;
export const SUBAGENT_RPC_REQUEST = 'subagents:rpc:v1:request' as const;
export const subagentRpcReply = (id: string): string => `subagents:rpc:v1:reply:${id}`;

const DEFAULT_PROTOCOL_TIMEOUT_MS = 1_500;
const DEFAULT_PLAN_TIMEOUT_MS = 120_000;
const MAX_OBJECTIVE_LENGTH = 4_096;
const MAX_TASK_LENGTH = 16_384;
const MAX_LIST_STRING_LENGTH = 2_048;
const MAX_LIST_ITEMS = 32;
const MAX_PLANNED_LANES = 64;
const LANE_ID = /^[a-z][a-z0-9-]{0,47}$/;
const ROLE_NAMES: ReadonlySet<string> = new Set(ULTRA_ROLE_NAMES);

export interface UltraEventBus {
  on(event: string, handler: (data: unknown) => void): (() => void) | void;
  emit(event: string, data: unknown): void;
}

export interface UltraLane {
  id: string;
  role: UltraRole;
  task: string;
  write: boolean;
}

export type UltraPlanMode = 'wave' | 'no-wave' | 'over-cap';

export interface UltraPlan {
  objective: string;
  evidence: string[];
  mode: UltraPlanMode;
  lanes: UltraLane[];
  acceptance: string[];
}

export interface UltraPlanBounds {
  minLanes: number;
  maxLanes: number;
}

export interface RequestPlanInput {
  events: UltraEventBus;
  task: string;
  cwd: string;
  /** Foreground delegation and local correlation timeout in milliseconds. */
  timeout?: number;
  timeoutMs?: number;
}

export interface PreflightLaneInput {
  agent: string;
  task: string;
  cwd: string;
  availableModels?: ReadonlyArray<unknown>;
  /** Model sent to package-owned launch resolution. */
  model?: string;
  /** When set, fail closed unless the resolved model is exactly this value. */
  expectedModel?: string;
  /** Convenience alias for a uniform requested and expected model. */
  uniformModel?: string;
}

export interface UltraLaunchContract {
  context: 'fresh' | 'fork';
  model?: string;
  [key: string]: unknown;
}

type PreflightResult =
  | { ok: true; contract: UltraLaunchContract }
  | { ok: false; code: string; message: string };

const PREFLIGHT_MODULE = 'pi-subagents/preflight';

async function resolveLaunchContract(input: Record<string, unknown>): Promise<PreflightResult> {
  // Keep this runtime import opaque to the consumer's TypeScript compiler: the
  // dependency publishes TypeScript sources whose internal .ts specifiers are
  // valid in Pi but are not type-checkable under every package's tsconfig.
  const module = await import(PREFLIGHT_MODULE) as {
    resolveSubagentLaunchContract(value: Record<string, unknown>): Promise<PreflightResult>;
  };
  return module.resolveSubagentLaunchContract(input);
}

const PLAN_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    objective: { type: 'string', minLength: 1, maxLength: MAX_OBJECTIVE_LENGTH },
    evidence: {
      type: 'array',
      maxItems: MAX_LIST_ITEMS,
      items: { type: 'string', minLength: 1, maxLength: MAX_LIST_STRING_LENGTH },
    },
    mode: { enum: ['wave', 'no-wave', 'over-cap'] },
    lanes: {
      type: 'array',
      maxItems: MAX_PLANNED_LANES,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', pattern: LANE_ID.source, maxLength: 48 },
          role: { enum: [...ULTRA_ROLE_NAMES] },
          task: { type: 'string', minLength: 1, maxLength: MAX_TASK_LENGTH },
          write: { type: 'boolean' },
        },
        required: ['id', 'role', 'task', 'write'],
        additionalProperties: false,
      },
    },
    acceptance: {
      type: 'array',
      maxItems: MAX_LIST_ITEMS,
      items: { type: 'string', minLength: 1, maxLength: MAX_LIST_STRING_LENGTH },
    },
  },
  required: ['objective', 'evidence', 'mode', 'lanes', 'acceptance'],
  additionalProperties: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function unsubscribe(dispose: (() => void) | void): void {
  if (typeof dispose === 'function') dispose();
}

function positiveTimeout(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
    throw new Error(`${label} must be a positive safe integer no greater than 2147483647.`);
  }
  return value;
}

function protocolTimeout<T>(
  events: UltraEventBus,
  event: string,
  timeoutMs: number,
  label: string,
  handle: (payload: unknown, resolve: (value: T) => void, reject: (error: Error) => void) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let dispose: (() => void) | void;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe(dispose);
      callback();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error(`${label} timed out after ${timeoutMs}ms.`)));
    }, timeoutMs);
    dispose = events.on(event, (payload) => {
      handle(
        payload,
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error)),
      );
    });
  });
}

export function waitForSubagentCapabilities(
  events: UltraEventBus,
  timeout = DEFAULT_PROTOCOL_TIMEOUT_MS,
): Promise<unknown> {
  const timeoutMs = positiveTimeout(timeout, 'Readiness timeout');
  return protocolTimeout(events, SUBAGENT_RPC_READY, timeoutMs, 'Subagent capability readiness', (payload, resolve) => {
    resolve(payload);
  });
}

export function requestPlan(input: RequestPlanInput): Promise<unknown> {
  if (typeof input.task !== 'string' || input.task.trim().length === 0 || input.task.length > MAX_TASK_LENGTH) {
    return Promise.reject(new Error(`Planner task must be a non-empty string no longer than ${MAX_TASK_LENGTH} characters.`));
  }
  if (typeof input.cwd !== 'string' || input.cwd.trim().length === 0) {
    return Promise.reject(new Error('Planner cwd must be a non-empty string.'));
  }

  const timeoutMs = positiveTimeout(input.timeoutMs ?? input.timeout ?? DEFAULT_PLAN_TIMEOUT_MS, 'Planner timeout');
  const request: SubagentDelegationRequest = {
    requestId: randomUUID(),
    ownerRunId: randomUUID(),
    nodeId: 'ultra-plan',
    agent: 'ultra-planner',
    task: input.task,
    context: 'fresh',
    cwd: input.cwd,
    timeoutMs,
    result: { kind: 'structured', schema: PLAN_SCHEMA },
  };

  const pending = protocolTimeout<unknown>(
    input.events,
    SUBAGENT_DELEGATION_RESPONSE_EVENT,
    timeoutMs,
    'Ultra planner response',
    (payload, resolve, reject) => {
      if (!isRecord(payload)) return;
      const response = payload as unknown as SubagentDelegationResponse;
      if (
        response.requestId !== request.requestId
        || response.ownerRunId !== request.ownerRunId
        || response.nodeId !== request.nodeId
      ) return;
      if (response.status !== 'completed') {
        reject(new Error(response.error || `Ultra planner failed with status ${response.status}.`));
        return;
      }
      if (response.result?.kind !== 'structured' || !isRecord(response.result.value)) {
        reject(new Error('Ultra planner returned no structured object result.'));
        return;
      }
      resolve(response.result.value);
    },
  );
  input.events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, request);
  return pending;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unexpected) throw new Error(`${label} contains unsupported field '${unexpected}'.`);
}

function boundedString(value: unknown, label: string, maxLength: number): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    throw new Error(`${label} must be a non-empty string no longer than ${maxLength} characters.`);
  }
}

function boundedStringList(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) {
    throw new Error(`${label} must be an array of at most ${MAX_LIST_ITEMS} strings.`);
  }
  value.forEach((entry, index) => boundedString(entry, `${label}[${index}]`, MAX_LIST_STRING_LENGTH));
}

function validateBounds(bounds: UltraPlanBounds): void {
  if (
    !Number.isSafeInteger(bounds.minLanes)
    || !Number.isSafeInteger(bounds.maxLanes)
    || bounds.minLanes < ULTRA_MIN_LANES
    || bounds.maxLanes > ULTRA_MAX_LANES
    || bounds.minLanes > bounds.maxLanes
  ) {
    throw new Error(`Plan bounds must be safe integers with ${ULTRA_MIN_LANES} <= minLanes <= maxLanes <= ${ULTRA_MAX_LANES}.`);
  }
}

export function validatePlan(plan: unknown, bounds: UltraPlanBounds): UltraPlan {
  validateBounds(bounds);
  if (!isRecord(plan)) throw new Error('Ultra plan must be an object.');
  exactKeys(plan, ['objective', 'evidence', 'mode', 'lanes', 'acceptance'], 'Ultra plan');
  boundedString(plan.objective, 'Plan objective', MAX_OBJECTIVE_LENGTH);
  boundedStringList(plan.evidence, 'Plan evidence');
  boundedStringList(plan.acceptance, 'Plan acceptance');
  if (plan.mode !== 'wave' && plan.mode !== 'no-wave' && plan.mode !== 'over-cap') {
    throw new Error('Plan mode must be wave, no-wave, or over-cap.');
  }
  if (!Array.isArray(plan.lanes) || plan.lanes.length > MAX_PLANNED_LANES) {
    throw new Error(`Plan lanes must be an array of at most ${MAX_PLANNED_LANES} lanes.`);
  }

  const ids = new Set<string>();
  for (const [index, rawLane] of plan.lanes.entries()) {
    if (!isRecord(rawLane)) throw new Error(`Lane ${index} must be an object.`);
    exactKeys(rawLane, ['id', 'role', 'task', 'write'], `Lane ${index}`);
    if (typeof rawLane.id !== 'string' || !LANE_ID.test(rawLane.id)) {
      throw new Error(`Lane id at index ${index} must match ${LANE_ID.source}.`);
    }
    if (ids.has(rawLane.id)) throw new Error(`Lane ids must be unique; duplicate '${rawLane.id}'.`);
    ids.add(rawLane.id);
    if (typeof rawLane.role !== 'string' || !ROLE_NAMES.has(rawLane.role)) {
      throw new Error(`Lane role at index ${index} must be one of: ${ULTRA_ROLE_NAMES.join(', ')}.`);
    }
    boundedString(rawLane.task, `Lane task at index ${index}`, MAX_TASK_LENGTH);
    if (typeof rawLane.write !== 'boolean') throw new Error(`Lane write at index ${index} must be boolean.`);
  }

  const count = plan.lanes.length;
  if (plan.mode === 'no-wave' && count !== 0) throw new Error('A no-wave plan must contain zero lanes.');
  if (plan.mode === 'wave' && (count < bounds.minLanes || count > bounds.maxLanes)) {
    throw new Error(`A wave plan must contain between ${bounds.minLanes} and ${bounds.maxLanes} lanes.`);
  }
  if (plan.mode === 'over-cap' && count <= bounds.maxLanes) {
    throw new Error(`An over-cap plan must contain more than ${bounds.maxLanes} lanes and must not be launched.`);
  }

  return plan as unknown as UltraPlan;
}

export async function preflightLane(input: PreflightLaneInput): Promise<UltraLaunchContract> {
  boundedString(input.agent, 'Preflight agent', 96);
  boundedString(input.task, 'Preflight task', MAX_TASK_LENGTH);
  boundedString(input.cwd, 'Preflight cwd', 4_096);

  const uniformModel = input.uniformModel;
  const requestedModel = input.model ?? (uniformModel === 'automatic' ? undefined : uniformModel);
  const expectedModel = input.expectedModel ?? (uniformModel === 'automatic' ? undefined : uniformModel);
  const result = await resolveLaunchContract({
    agent: input.agent,
    task: input.task,
    context: 'fresh',
    cwd: input.cwd,
    availableModels: input.availableModels,
    ...(requestedModel !== undefined ? { model: requestedModel } : {}),
  });
  if (!result.ok) throw new Error(`Lane preflight failed (${result.code}): ${result.message}`);
  if (result.contract.context !== 'fresh') {
    throw new Error(`Lane preflight resolved unexpected context '${result.contract.context}'.`);
  }
  if (expectedModel !== undefined && result.contract.model !== expectedModel) {
    throw new Error(`Uniform model mismatch: expected '${expectedModel}', resolved '${result.contract.model ?? 'none'}'.`);
  }
  return result.contract;
}

export function buildWaveWorkflow(lanes: readonly UltraLane[], agent: string): string {
  boundedString(agent, 'Workflow agent', 96);
  if (!Array.isArray(lanes) || lanes.length === 0 || lanes.length > ULTRA_MAX_LANES) {
    throw new Error(`A launchable workflow requires 1..${ULTRA_MAX_LANES} lanes.`);
  }

  const keys = new Set<string>();
  const launches = lanes.map((lane, index) => {
    if (!isRecord(lane)) throw new Error(`Workflow lane ${index} must be an object.`);
    if (typeof lane.id !== 'string' || !LANE_ID.test(lane.id)) throw new Error(`Workflow lane id at index ${index} is invalid.`);
    if (keys.has(lane.id)) throw new Error(`Workflow lane ids must be unique; duplicate '${lane.id}'.`);
    keys.add(lane.id);
    if (typeof lane.role !== 'string' || !ROLE_NAMES.has(lane.role)) throw new Error(`Workflow lane role '${String(lane.role)}' is not an Ultra role.`);
    boundedString(lane.task, `Workflow lane task at index ${index}`, MAX_TASK_LENGTH);
    if (typeof lane.write !== 'boolean') throw new Error(`Workflow lane write at index ${index} must be boolean.`);

    const authority = lane.write
      ? 'Authority: WRITE only within this assigned lane. Do not change files outside the lane ownership stated in the task.'
      : 'Authority: READ-ONLY. Inspect and report; do not edit any file.';
    const task = `Role: ${lane.role}\n${authority}\nTask:\n${lane.task}`;
    return {
      key: lane.id,
      agent,
      task,
      context: 'fresh' as const,
      ...(lane.write ? { worktree: true as const } : {}),
      output: true as const,
    };
  });

  return `return await runs.all(${JSON.stringify(launches)});`;
}

export function spawnWave(events: UltraEventBus, script: string, cwd: string): Promise<unknown> {
  boundedString(script, 'Workflow script', 1_048_576);
  boundedString(cwd, 'Workflow cwd', 4_096);
  const requestId = randomUUID();
  const replyEvent = subagentRpcReply(requestId);
  const pending = protocolTimeout<unknown>(
    events,
    replyEvent,
    DEFAULT_PROTOCOL_TIMEOUT_MS,
    'Subagent spawn RPC',
    (payload, resolve, reject) => {
      if (!isRecord(payload) || payload.requestId !== requestId) return;
      if (payload.version !== 1) {
        reject(new Error(`Subagent spawn RPC returned unsupported version '${String(payload.version)}'.`));
        return;
      }
      if (payload.method !== undefined && payload.method !== 'spawn') {
        reject(new Error(`Subagent spawn RPC returned mismatched method '${String(payload.method)}'.`));
        return;
      }
      if (payload.success === true) {
        resolve(payload.data);
        return;
      }
      if (payload.success === false) {
        const error = isRecord(payload.error) && typeof payload.error.message === 'string'
          ? payload.error.message
          : 'Subagent spawn RPC failed without an error message.';
        reject(new Error(error));
        return;
      }
      reject(new Error('Subagent spawn RPC returned a malformed reply.'));
    },
  );
  events.emit(SUBAGENT_RPC_REQUEST, {
    version: 1,
    requestId,
    method: 'spawn',
    params: {
      workflowScript: script,
      cwd,
      async: true,
      context: 'fresh',
    },
  });
  return pending;
}
