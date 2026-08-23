import { randomUUID } from 'node:crypto';
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {
  DEFAULT_ULTRA_SETTINGS,
  effectiveUniformModel,
  loadUltraSettings,
  saveUltraSettings,
  type LoadUltraSettingsResult,
  type UltraSettings,
} from './ultra-config.js';
import { showUltraMenu } from './ultra-menu.js';
import {
  SUBAGENT_RPC_REQUEST,
  buildWaveWorkflow,
  preflightLane,
  requestPlan,
  subagentRpcReply,
  validatePlan,
  type PreflightLaneInput,
  type UltraLane,
  type UltraLaunchContract,
  type UltraPlan,
} from './ultra-protocol.js';

export const ULTRA_OWNED_PREFIX = '<pi-ultra-owned>' as const;

const ULTRA_COMMAND_DESCRIPTION = "Configure or run Ultra's validated subagent controller";
const MENU_REQUIRES_TUI = '/ultra menu requires TUI mode; use /ultra on, /ultra off, or /ultra toggle.';
const ENABLE_FIRST = 'Run /ultra on first.';
const RPC_READY_EVENT = 'subagents:rpc:v1:ready';
const MAX_RESULT_PATHS = 32;
const MAX_RESULT_PATH_LENGTH = 4_096;
const MAX_RESULT_STRING_LENGTH = 2_048;
const MAX_MANAGER_INSTRUCTIONS_LENGTH = 4_096;

export type UltraInputClassification = 'bypass' | 'consider' | 'owned';

export interface SpawnGroupInput {
  events: {
    on(event: string, handler: (data: unknown) => void): (() => void) | void;
    emit(event: string, data: unknown): void;
  };
  script: string;
  cwd: string;
  model?: string;
}

export interface UltraExtensionDependencies {
  loadSettings(): Promise<LoadUltraSettingsResult>;
  saveSettings(settings: UltraSettings): Promise<void>;
  showMenu(options: {
    ctx: ExtensionCommandContext;
    settings: UltraSettings;
    save(settings: UltraSettings): Promise<void>;
  }): Promise<unknown>;
  requestPlan(input: {
    events: SpawnGroupInput['events'];
    task: string;
    cwd: string;
  }): Promise<unknown>;
  validatePlan(plan: unknown, bounds: { minLanes: number; maxLanes: number }): UltraPlan;
  preflightLane(input: PreflightLaneInput): Promise<UltraLaunchContract>;
  buildWaveWorkflow(lanes: readonly UltraLane[], agent: string): string;
  spawnGroup(input: SpawnGroupInput): Promise<unknown>;
}

interface BoundLane {
  lane: UltraLane;
  agent: string;
  model?: string;
  artifactPath?: string;
}

interface StoredReceipt {
  runId: string;
  receipt: unknown;
  laneIds: string[];
  resolvedAgents: string[];
  resolvedModels: string[];
  validationRequirements: string[];
  preflightArtifactPaths: string[];
}

interface ControllerOutcome {
  kind: 'disabled' | 'launched' | 'requeued' | 'failed';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function bounded(value: unknown, maxLength = MAX_RESULT_STRING_LENGTH): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '').trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

function stripOwnedPrefix(text: string): string {
  let stripped = text.trimStart();
  while (stripped.startsWith(ULTRA_OWNED_PREFIX)) {
    stripped = stripped.slice(ULTRA_OWNED_PREFIX.length).trimStart();
  }
  return stripped;
}

function ownedText(text: string): string {
  return `${ULTRA_OWNED_PREFIX}${stripOwnedPrefix(text)}`;
}

/** Narrow passive classifier: social text and commands never enter the controller. */
export function classifyUltraInput(text: string): UltraInputClassification {
  if (typeof text !== 'string') return 'bypass';
  const trimmed = text.trim();
  if (trimmed.startsWith(ULTRA_OWNED_PREFIX)) return 'owned';
  if (!trimmed || trimmed.startsWith('/')) return 'bypass';
  const social = trimmed.toLowerCase().replace(/[.!?,;:]+$/u, '').trim();
  if (/^(?:(?:hi|hello|hey)(?: there| team)?|good (?:morning|afternoon|evening)|(?:thanks|thank you|thx|cheers)(?: for (?:that|this|your help|the help))?)$/u.test(social)) {
    return 'bypass';
  }
  if (/\b(?:implement|fix|debug|refactor|code|coding|test|tests|typescript|javascript|module|function|class|api|build|compile|repository|repo|file|files|parser|controller|migration)\b/iu.test(trimmed)) {
    return 'consider';
  }
  return 'bypass';
}

function statusText(settings: UltraSettings): string {
  return `Ultra: ${settings.enabled ? 'on' : 'off'}`;
}

function notify(ctx: ExtensionContext, message: string, level: 'info' | 'warning' | 'error' = 'info'): void {
  if (ctx.hasUI) ctx.ui.notify(message, level);
}

function updateStatus(ctx: ExtensionContext, settings: UltraSettings): void {
  if (ctx.hasUI) ctx.ui.setStatus('ultra', statusText(settings));
}

function contractAgent(contract: UltraLaunchContract, fallback: string): string {
  const value = contract.agent;
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (isRecord(value) && typeof value.name === 'string' && value.name.trim()) return value.name.trim();
  return fallback;
}

function contractArtifactPath(contract: UltraLaunchContract): string | undefined {
  if (!isRecord(contract.roots)) return undefined;
  return bounded(contract.roots.outputPath, MAX_RESULT_PATH_LENGTH);
}

function receiptRunId(receipt: unknown): string | undefined {
  if (!isRecord(receipt)) return undefined;
  for (const key of ['runId', 'asyncId', 'id'] as const) {
    const value = bounded(receipt[key], 256);
    if (value) return value;
  }
  return isRecord(receipt.details) ? receiptRunId(receipt.details) : undefined;
}

function completionRunId(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  return bounded(payload.runId, 256) ?? bounded(payload.id, 256) ?? bounded(payload.asyncId, 256);
}

function collectArtifactPaths(payload: unknown): string[] {
  if (!isRecord(payload)) return [];
  const paths: string[] = [];
  const add = (value: unknown) => {
    const path = bounded(value, MAX_RESULT_PATH_LENGTH);
    if (path && !paths.includes(path) && paths.length < MAX_RESULT_PATHS) paths.push(path);
  };
  add(payload.artifactPath);
  add(payload.outputPath);
  if (isRecord(payload.savedOutput)) add(payload.savedOutput.path);
  if (Array.isArray(payload.results)) {
    for (const result of payload.results) {
      if (!isRecord(result)) continue;
      add(result.artifactPath);
      add(result.outputPath);
      if (isRecord(result.savedOutput)) add(result.savedOutput.path);
      if (paths.length >= MAX_RESULT_PATHS) break;
    }
  }
  return paths;
}

function uniqueBounded(values: readonly string[], maxItems = 32): string[] {
  const output: string[] = [];
  for (const value of values) {
    const item = bounded(value);
    if (item && !output.includes(item)) output.push(item);
    if (output.length >= maxItems) break;
  }
  return output;
}

function defaultSpawnGroup(input: SpawnGroupInput): Promise<unknown> {
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
      finish(() => reject(new Error('Subagent spawn RPC timed out after 1500ms.')));
    }, 1_500);
    dispose = input.events.on(replyEvent, (payload) => {
      if (!isRecord(payload) || payload.requestId !== requestId) return;
      if (payload.version !== 1) {
        finish(() => reject(new Error(`Subagent spawn RPC returned unsupported version '${String(payload.version)}'.`)));
        return;
      }
      if (payload.success === true) {
        finish(() => resolve(payload.data));
        return;
      }
      const message = isRecord(payload.error) && typeof payload.error.message === 'string'
        ? payload.error.message
        : 'Subagent spawn RPC failed.';
      finish(() => reject(new Error(message)));
    });
    input.events.emit(SUBAGENT_RPC_REQUEST, {
      version: 1,
      requestId,
      method: 'spawn',
      source: { extension: 'pi-ultra' },
      params: {
        workflowScript: input.script,
        cwd: input.cwd,
        context: 'fresh',
        async: true,
        ...(input.model ? { model: input.model } : {}),
      },
    });
  });
}

const DEFAULT_DEPENDENCIES: UltraExtensionDependencies = {
  loadSettings: () => loadUltraSettings(),
  saveSettings: (settings) => saveUltraSettings(settings as unknown as Record<string, unknown>),
  showMenu: (options) => showUltraMenu(options),
  requestPlan,
  validatePlan,
  preflightLane,
  buildWaveWorkflow,
  spawnGroup: defaultSpawnGroup,
};

export function createUltraExtension(
  dependencies: UltraExtensionDependencies = DEFAULT_DEPENDENCIES,
): (pi: ExtensionAPI) => void {
  return (pi: ExtensionAPI): void => {
    let settings: UltraSettings = { ...DEFAULT_ULTRA_SETTINGS };
    const receipts = new Map<string, StoredReceipt>();
    let completionEvent: string | undefined;
    let disposeCompletion: (() => void) | undefined;
    let disposed = false;
    const protocolDisposers = new Set<() => void>();
    const protocolTimers = new Set<ReturnType<typeof setTimeout>>();

    const reloadSettings = async (): Promise<UltraSettings> => {
      const loaded = await dependencies.loadSettings();
      settings = { ...loaded.settings };
      return settings;
    };

    const bindCompletionEvent = (eventName: string): void => {
      if (!eventName || completionEvent === eventName || disposed) return;
      disposeCompletion?.();
      completionEvent = eventName;
      const dispose = pi.events.on(eventName, (payload) => {
        const runId = completionRunId(payload);
        if (!runId) return;
        const stored = receipts.get(runId);
        if (!stored) return;
        receipts.delete(runId);
        const advertisedPaths = collectArtifactPaths(payload);
        const artifactPaths = advertisedPaths.length > 0
          ? advertisedPaths
          : stored.preflightArtifactPaths.slice(0, MAX_RESULT_PATHS);
        const managerInstructions = (
          'Ultra manager instructions: inspect the referenced artifacts and diffs, run the listed validation requirements, '
          + 'reconcile lane outputs, and decide acceptance independently. This packet is evidence only.'
        ).slice(0, MAX_MANAGER_INSTRUCTIONS_LENGTH);
        pi.sendMessage({
          customType: 'ultra-wave',
          content: `Ultra wave result received for run ${runId}. Verify the bounded evidence before making any acceptance decision.`,
          display: true,
          details: {
            kind: 'result',
            runId,
            laneIds: stored.laneIds,
            resolvedAgents: stored.resolvedAgents,
            resolvedModels: stored.resolvedModels,
            artifactPaths,
            validationRequirements: stored.validationRequirements,
            managerInstructions,
          },
        });
      });
      disposeCompletion = typeof dispose === 'function' ? dispose : undefined;
    };

    const readAdvertisedCompletion = (payload: unknown): void => {
      const envelope = isRecord(payload) && isRecord(payload.data) ? payload.data : payload;
      if (!isRecord(envelope) || !isRecord(envelope.events)) return;
      const advertised = bounded(envelope.events.asyncComplete, 256);
      if (advertised) bindCompletionEvent(advertised);
    };

    const readyDispose = pi.events.on(RPC_READY_EVENT, readAdvertisedCompletion);
    if (typeof readyDispose === 'function') protocolDisposers.add(readyDispose);

    const requestCapabilityAdvertisement = (): void => {
      if (disposed) return;
      const requestId = randomUUID();
      const replyEvent = subagentRpcReply(requestId);
      let dispose: (() => void) | void;
      const cleanup = () => {
        if (typeof dispose === 'function') {
          dispose();
          protocolDisposers.delete(dispose);
        }
        clearTimeout(timer);
        protocolTimers.delete(timer);
      };
      dispose = pi.events.on(replyEvent, (payload) => {
        if (!isRecord(payload) || payload.requestId !== requestId) return;
        cleanup();
        if (payload.success === true) readAdvertisedCompletion(payload);
      });
      if (typeof dispose === 'function') protocolDisposers.add(dispose);
      const timer = setTimeout(cleanup, 1_500);
      protocolTimers.add(timer);
      pi.events.emit(SUBAGENT_RPC_REQUEST, {
        version: 1,
        requestId,
        method: 'ping',
        source: { extension: 'pi-ultra' },
      });
    };

    const requeue = (text: string): void => {
      pi.sendUserMessage(ownedText(text));
    };

    const runController = async (
      task: string,
      ctx: ExtensionContext,
      explicit: boolean,
    ): Promise<ControllerOutcome> => {
      try {
        const current = await reloadSettings();
        if (!current.enabled) {
          if (explicit) notify(ctx, ENABLE_FIRST, 'error');
          return { kind: 'disabled' };
        }

        const rawPlan = await dependencies.requestPlan({ events: pi.events, task, cwd: ctx.cwd });
        const plan = dependencies.validatePlan(rawPlan, {
          minLanes: current.minLanes,
          maxLanes: current.maxLanes,
        });
        if (plan.mode !== 'wave') {
          if (explicit) {
            requeue(`Ultra manager: no qualified wave (${plan.mode}).\nOriginal task:\n${stripOwnedPrefix(task)}`);
          } else {
            requeue(stripOwnedPrefix(task));
          }
          return { kind: 'requeued' };
        }

        const availableModels = ctx.modelRegistry.getAvailable();
        const uniformModel = effectiveUniformModel(current);
        const bound = await Promise.all(plan.lanes.map(async (lane): Promise<BoundLane> => {
          const requestedAgent = current.routingMode === 'uniform' ? 'worker' : lane.role;
          const contract = await dependencies.preflightLane({
            agent: requestedAgent,
            task: lane.task,
            cwd: ctx.cwd,
            availableModels,
            ...(current.routingMode === 'uniform' ? { uniformModel } : {}),
          });
          return {
            lane,
            agent: contractAgent(contract, requestedAgent),
            ...(contract.model ? { model: contract.model } : {}),
            ...(contractArtifactPath(contract) ? { artifactPath: contractArtifactPath(contract) } : {}),
          };
        }));

        const groups = new Map<string, { agent: string; model?: string; lanes: BoundLane[] }>();
        for (const lane of bound) {
          const key = JSON.stringify([lane.agent, lane.model ?? null]);
          const group = groups.get(key);
          if (group) group.lanes.push(lane);
          else groups.set(key, {
            agent: lane.agent,
            ...(lane.model ? { model: lane.model } : {}),
            lanes: [lane],
          });
        }

        const launches = await Promise.all([...groups.values()].map(async (group) => {
          const script = dependencies.buildWaveWorkflow(group.lanes.map(({ lane }) => lane), group.agent);
          const receipt = await dependencies.spawnGroup({
            events: pi.events,
            script,
            cwd: ctx.cwd,
            ...(group.model ? { model: group.model } : {}),
          });
          const runId = receiptRunId(receipt);
          if (!runId) throw new Error('Ultra spawn receipt did not advertise a run ID.');
          const stored: StoredReceipt = {
            runId,
            receipt,
            laneIds: group.lanes.map(({ lane }) => lane.id),
            resolvedAgents: uniqueBounded(group.lanes.map(({ agent }) => agent)),
            resolvedModels: uniqueBounded(group.lanes.flatMap(({ model }) => model ? [model] : [])),
            validationRequirements: uniqueBounded(plan.acceptance),
            preflightArtifactPaths: uniqueBounded(group.lanes.flatMap(({ artifactPath }) => artifactPath ? [artifactPath] : [])),
          };
          receipts.set(runId, stored);
          pi.sendMessage({
            customType: 'ultra-wave',
            content: `Ultra wave launch receipt received for run ${runId}. The run remains subject to independent validation.`,
            display: true,
            details: {
              kind: 'receipt',
              runId,
              receipt,
              laneIds: stored.laneIds,
              resolvedAgents: stored.resolvedAgents,
              resolvedModels: stored.resolvedModels,
            },
          });
          return stored;
        }));
        return launches.length > 0 ? { kind: 'launched' } : { kind: 'failed' };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (explicit) notify(ctx, message, 'error');
        return { kind: 'failed' };
      }
    };

    pi.registerCommand('ultra', {
      description: ULTRA_COMMAND_DESCRIPTION,
      handler: async (rawArgs, ctx) => {
        const args = rawArgs.trim();
        const keyword = args.toLowerCase();
        if (!args) {
          if (ctx.mode !== 'tui') {
            notify(ctx, MENU_REQUIRES_TUI, 'error');
            return;
          }
          try {
            const current = await reloadSettings();
            await dependencies.showMenu({
              ctx,
              settings: current,
              save: async (next) => {
                await dependencies.saveSettings(next);
                settings = { ...next };
                updateStatus(ctx, settings);
              },
            });
          } catch (error) {
            notify(ctx, error instanceof Error ? error.message : String(error), 'error');
          }
          return;
        }

        if (keyword === 'help') {
          notify(ctx, 'Usage: /ultra, /ultra on, /ultra off, /ultra toggle, /ultra help, or /ultra <task>.');
          return;
        }
        if (keyword === 'on' || keyword === 'off' || keyword === 'toggle') {
          try {
            const current = await reloadSettings();
            const enabled = keyword === 'toggle' ? !current.enabled : keyword === 'on';
            const next = { ...current, enabled };
            await dependencies.saveSettings(next);
            settings = next;
            updateStatus(ctx, settings);
          } catch (error) {
            notify(ctx, error instanceof Error ? error.message : String(error), 'error');
          }
          return;
        }

        await runController(args, ctx, true);
      },
    });

    pi.on('input', async (event, ctx) => {
      const classification = classifyUltraInput(event.text);
      if (classification === 'owned') {
        // Pi 0.84 has no prompt replacement in before_agent_start. Input
        // transform is the supported seam that strips ownership before model input.
        return { action: 'transform' as const, text: stripOwnedPrefix(event.text) };
      }
      if (classification === 'bypass') return { action: 'continue' as const };
      const outcome = await runController(event.text, ctx, false);
      return outcome.kind === 'launched' || outcome.kind === 'requeued'
        ? { action: 'handled' as const }
        : { action: 'continue' as const };
    });

    pi.on('session_start', async (_event, ctx) => {
      try {
        await reloadSettings();
        updateStatus(ctx, settings);
      } catch (error) {
        notify(ctx, error instanceof Error ? error.message : String(error), 'error');
      }
      requestCapabilityAdvertisement();
    });

    pi.on('session_shutdown', () => {
      if (disposed) return;
      disposed = true;
      disposeCompletion?.();
      disposeCompletion = undefined;
      completionEvent = undefined;
      for (const dispose of protocolDisposers) dispose();
      protocolDisposers.clear();
      for (const timer of protocolTimers) clearTimeout(timer);
      protocolTimers.clear();
      receipts.clear();
    });
  };
}

export default createUltraExtension();
