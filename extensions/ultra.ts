import { randomUUID } from 'node:crypto';
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  backupAndResetUltraSettings,
  loadUltraSettings,
  updateUltraSettings,
  watchUltraSettings,
  type LoadUltraSettingsResult,
  type UltraSettings,
  type UltraSettingsMutator,
  type UltraSettingsPatch,
  type ValidUltraSettingsResult,
} from './ultra-config.js';
import { showUltraMenu } from './ultra-menu.js';
import {
  ROLE_AGENTS,
  SUBAGENT_RPC_REQUEST,
  ULTRA_DELEGATE_SCHEMA,
  launchUltraWave,
  prepareUltraWave,
  subagentRpcReply,
  type PrepareUltraWaveInput,
  type UltraCapabilityCeiling,
  type UltraDelegateInput,
  type UltraLaunchAuthorityHandle,
  type UltraPreparedWave,
} from './ultra-protocol.js';
import {
  ULTRA_OPERATION_ENTRY,
  createUltraOperationStore,
  type UltraOperation,
  type UltraOperationLane,
  type UltraOutboxItem,
} from './ultra-operations.js';

const ULTRA_COMMAND_DESCRIPTION = 'Configure Ultra or send an Ultra-managed task to the active session model';
const MENU_REQUIRES_TUI = '/ultra menu requires TUI mode; use /ultra on, /ultra off, or /ultra toggle.';
const ENABLE_FIRST = 'Run /ultra on first.';
const COMPLETE_EVENT = 'subagent:async-complete';
const CAPABILITY_MODULE = 'pi-subagents/capability-ceiling';
const AUTHORITY_MODULE = 'pi-subagents/launch-authority';
const SAFE_SUBAGENT_ACTIONS = new Set([
  'list', 'get', 'models', 'guide', 'doctor', 'debug.run', 'status', 'stop', 'interrupt', 'children.list',
  'mission.list', 'mission.show', 'refine.show', 'inspector.status', 'project.status',
  'watchdog.status', 'watchdog.check', 'watchdog.recommend-model',
  'schedule.list', 'schedule.show', 'schedule.history', 'schedule.pause', 'schedule.delete',
]);
const STRICT_TOOLS = ['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write', 'contact_supervisor'];
const MAX_COMPLETION_BUFFER = 32;
const COMPLETION_BUFFER_TTL_MS = 60_000;
const RECONCILE_DELAYS = [0, 250, 750, 1_500] as const;

export interface UltraPolicyRegistration {
  mode: 'blocked' | 'enabled';
  operational: boolean;
  authority?: UltraLaunchAuthorityHandle;
  capabilityCeiling?: UltraCapabilityCeiling;
  dispose(): void;
}

export interface UltraExtensionDependencies {
  loadSettings(): Promise<LoadUltraSettingsResult>;
  updateSettings(patch: UltraSettingsPatch | UltraSettingsMutator): Promise<ValidUltraSettingsResult>;
  backupAndReset(): Promise<{ backupPath: string; committed: ValidUltraSettingsResult }>;
  showMenu(options: {
    ctx: ExtensionCommandContext;
    state: LoadUltraSettingsResult;
    update(patch: UltraSettingsPatch | UltraSettingsMutator): Promise<ValidUltraSettingsResult>;
    recover(): Promise<{ backupPath: string; committed: ValidUltraSettingsResult }>;
  }): Promise<unknown>;
  checkCapabilities(events: ExtensionAPI['events']): Promise<boolean>;
  installPolicy(input: {
    sessionId: string;
    mode: 'blocked' | 'enabled';
    validateRevision(revision: string, signal: AbortSignal): Promise<boolean>;
  }): Promise<UltraPolicyRegistration>;
  watchSettings(onChange: () => void | Promise<void>, onError: (error: Error) => void): () => void;
  prepareWave(input: PrepareUltraWaveInput): Promise<UltraPreparedWave>;
  launchWave(input: Parameters<typeof launchUltraWave>[0]): Promise<unknown>;
  queryStatus(events: ExtensionAPI['events'], runId: string, signal: AbortSignal): Promise<unknown | undefined>;
  randomId(): string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '').trim().slice(0, 1_024) || 'Unknown Ultra error.';
}

async function defaultCheckCapabilities(events: ExtensionAPI['events']): Promise<boolean> {
  const requestId = randomUUID();
  const reply = subagentRpcReply(requestId);
  return new Promise((resolve) => {
    let done = false;
    let dispose: (() => void) | void;
    const finish = (value: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (typeof dispose === 'function') dispose();
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), 1_500);
    dispose = events.on(reply, (payload) => {
      if (!isRecord(payload) || payload.requestId !== requestId) return;
      const data = isRecord(payload.data) ? payload.data : undefined;
      const capabilities = data && isRecord(data.capabilities) ? data.capabilities : undefined;
      const authority = capabilities && isRecord(capabilities.launchAuthority) ? capabilities.launchAuthority : undefined;
      const methods = data && Array.isArray(data.methods) ? data.methods : [];
      finish(payload.success === true && authority?.version === 1 && methods.includes('spawn'));
    });
    events.emit(SUBAGENT_RPC_REQUEST, { version: 1, requestId, method: 'ping', source: { extension: 'pi-ultra' } });
  });
}

async function defaultInstallPolicy(input: Parameters<UltraExtensionDependencies['installPolicy']>[0]): Promise<UltraPolicyRegistration> {
  const capabilityModule = await import(CAPABILITY_MODULE) as {
    registerSubagentCapabilityCeiling(value: { sessionId: string; source: string; ceiling: Record<string, unknown> }): { dispose(): void };
  };
  const ceilingValue = input.mode === 'blocked'
    ? { allowedAgents: [] as string[], allowedTools: [] as string[], denyExtensions: true }
    : { allowedAgents: Object.values(ROLE_AGENTS), allowedTools: STRICT_TOOLS, denyExtensions: true };
  const ceilingHandle = capabilityModule.registerSubagentCapabilityCeiling({ sessionId: input.sessionId, source: 'pi-ultra', ceiling: ceilingValue });
  if (input.mode === 'blocked') {
    return { mode: 'blocked', operational: false, dispose: () => ceilingHandle.dispose() };
  }
  try {
    const authorityModule = await import(AUTHORITY_MODULE) as {
      registerSubagentLaunchAuthority(value: {
        sessionId: string;
        source: string;
        defaultNewSpawnDecision: 'deny';
        validateConfigRevision(revision: string, signal: AbortSignal): Promise<boolean>;
      }): UltraLaunchAuthorityHandle;
    };
    const authority = authorityModule.registerSubagentLaunchAuthority({
      sessionId: input.sessionId,
      source: 'pi-ultra',
      defaultNewSpawnDecision: 'deny',
      validateConfigRevision: input.validateRevision,
    });
    const capabilityCeiling: UltraCapabilityCeiling = {
      version: 1,
      allowedAgents: Object.values(ROLE_AGENTS),
      allowedTools: [...STRICT_TOOLS],
      denyExtensions: true,
      sources: ['pi-ultra'],
    };
    let disposed = false;
    return {
      mode: 'enabled', operational: true, authority, capabilityCeiling,
      dispose() {
        if (disposed) return;
        disposed = true;
        authority.dispose();
        ceilingHandle.dispose();
      },
    };
  } catch (error) {
    ceilingHandle.dispose();
    throw error;
  }
}

async function defaultQueryStatus(events: ExtensionAPI['events'], runId: string, signal: AbortSignal): Promise<unknown | undefined> {
  const requestId = randomUUID();
  const reply = subagentRpcReply(requestId);
  return new Promise((resolve) => {
    let done = false;
    let dispose: (() => void) | void;
    const finish = (value: unknown | undefined) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (typeof dispose === 'function') dispose();
      resolve(value);
    };
    const abort = () => finish(undefined);
    const timer = setTimeout(() => finish(undefined), 1_500);
    signal.addEventListener('abort', abort, { once: true });
    dispose = events.on(reply, (payload) => {
      if (!isRecord(payload) || payload.requestId !== requestId) return;
      finish(payload.success === true ? payload.data : undefined);
    });
    events.emit(SUBAGENT_RPC_REQUEST, { version: 1, requestId, method: 'status', params: { id: runId }, source: { extension: 'pi-ultra' } });
  });
}

const DEFAULT_DEPENDENCIES: UltraExtensionDependencies = {
  loadSettings: () => loadUltraSettings(),
  updateSettings: (patch) => updateUltraSettings(patch),
  backupAndReset: () => backupAndResetUltraSettings(),
  showMenu: ({ ctx, state, update, recover }) => showUltraMenu({ ctx, state, update, recover }),
  checkCapabilities: defaultCheckCapabilities,
  installPolicy: defaultInstallPolicy,
  watchSettings: (onChange, onError) => watchUltraSettings(onChange, undefined, onError),
  prepareWave: prepareUltraWave,
  launchWave: launchUltraWave,
  queryStatus: defaultQueryStatus,
  randomId: randomUUID,
};

function receiptRunId(receipt: unknown): string | undefined {
  if (!isRecord(receipt)) return undefined;
  for (const key of ['runId', 'asyncId', 'id'] as const) {
    if (typeof receipt[key] === 'string' && receipt[key].trim()) return receipt[key].trim();
  }
  for (const key of ['details', 'data'] as const) {
    const nested = receiptRunId(receipt[key]);
    if (nested) return nested;
  }
  return undefined;
}

function operationLanes(prepared: UltraPreparedWave): UltraOperationLane[] {
  return prepared.lanes.map(({ lane, agent, requestedModel, modelCandidates, launchContractDigest }) => ({
    id: lane.id,
    role: lane.role,
    agent,
    ...(requestedModel ? { requestedModel, expectedFixedModel: requestedModel } : {}),
    modelCandidates: [...modelCandidates],
    launchContractDigest,
    ...(lane.ownedPaths ? { ownedPaths: [...lane.ownedPaths] } : {}),
  }));
}

function managerPolicy(settings: UltraSettings): string {
  const model = settings.routingMode === 'uniform' ? settings.workerModel ?? 'one automatically resolved model' : 'strict role-default candidate chains';
  return [
    'Ultra manager policy:',
    '- The active session model is the Ultra manager and final reviewer; no planner subagent owns the user prompt.',
    `- Delegate only genuinely independent waves of ${settings.minLanes}-${settings.maxLanes} lanes through ultra_delegate; never pad a wave.`,
    `- Routing uses ${model}. Preserve scout, worker, and reviewer roles.`,
    '- Prefer an initial worker attempt, then at most one focused repair. After one repair or persistent capability failure, take over directly.',
    '- You may directly handle genuinely hard or quality-critical work; state the reason.',
    '- Worker completion is evidence, never acceptance. Inspect diffs/artifacts and run validation yourself.',
  ].join('\n');
}

function isSafeSubagentCall(input: unknown): boolean {
  if (!isRecord(input) || typeof input.action !== 'string') return false;
  const action = input.action.trim();
  if (action === 'steer') return input.steeringRecovery === false;
  return SAFE_SUBAGENT_ACTIONS.has(action);
}

function toolError(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true, details: { kind: 'error' } };
}

export function createUltraExtension(dependencies: UltraExtensionDependencies = DEFAULT_DEPENDENCIES): (pi: ExtensionAPI) => void {
  return (pi: ExtensionAPI): void => {
    let current: LoadUltraSettingsResult | undefined;
    let policy: UltraPolicyRegistration | undefined;
    let capabilityCompatible: boolean | undefined;
    let watcherFailed: string | undefined;
    let lastContext: ExtensionContext | undefined;
    let disposed = false;
    let disposeWatcher: (() => void) | undefined;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const reconciliationAbort = new AbortController();
    const completionBuffer = new Map<string, { payload: unknown; expiresAt: number }>();

    const operations = createUltraOperationStore({ append: (data) => pi.appendEntry(ULTRA_OPERATION_ENTRY, data) });

    const notify = (ctx: ExtensionContext, message: string, level: 'info' | 'warning' | 'error' = 'info') => {
      if (ctx.hasUI) ctx.ui.notify(message, level);
      else pi.sendMessage({ customType: 'ultra-diagnostic', content: message, display: false, details: { level } });
    };

    const status = (ctx: ExtensionContext, value: 'on' | 'off' | 'blocked') => {
      if (ctx.hasUI) ctx.ui.setStatus('ultra', `Ultra: ${value}`);
    };

    const validateRevision = async (revision: string, _signal: AbortSignal): Promise<boolean> => {
      const loaded = await dependencies.loadSettings();
      return loaded.kind !== 'invalid' && loaded.settings.enabled && loaded.revision === revision;
    };

    let syncTail: Promise<void> = Promise.resolve();
    const synchronize = (ctx: ExtensionContext): Promise<void> => {
      const run = async () => {
        if (disposed) return;
        lastContext = ctx;
        const guard = await dependencies.installPolicy({ sessionId: ctx.sessionManager.getSessionId(), mode: 'blocked', validateRevision });
        let next: UltraPolicyRegistration | undefined;
        try {
          if (watcherFailed) {
            policy?.dispose();
            policy = guard;
            current = { kind: 'invalid', reason: watcherFailed, path: 'unknown' };
            status(ctx, 'blocked');
            return;
          }
          const loaded = await dependencies.loadSettings();
          current = loaded;
          if (loaded.kind === 'invalid') {
            policy?.dispose();
            policy = guard;
            status(ctx, 'blocked');
            notify(ctx, `Ultra configuration is blocked: ${loaded.reason}`, 'error');
            return;
          }
          if (!loaded.settings.enabled) {
            policy?.dispose();
            guard.dispose();
            policy = undefined;
            status(ctx, 'off');
            return;
          }
          capabilityCompatible ??= await dependencies.checkCapabilities(pi.events);
          if (!capabilityCompatible) {
            policy?.dispose();
            policy = guard;
            status(ctx, 'blocked');
            notify(ctx, 'Ultra is blocked: installed pi-subagents lacks launch-authority v1. Install the pinned compatible fork and /reload.', 'error');
            return;
          }
          next = await dependencies.installPolicy({ sessionId: ctx.sessionManager.getSessionId(), mode: 'enabled', validateRevision });
          policy?.dispose();
          policy = next;
          guard.dispose();
          status(ctx, 'on');
        } catch (error) {
          next?.dispose();
          policy?.dispose();
          policy = guard;
          current = { kind: 'invalid', reason: boundedMessage(error), path: 'unknown' };
          status(ctx, 'blocked');
          notify(ctx, `Ultra is blocked: ${boundedMessage(error)}`, 'error');
        }
      };
      syncTail = syncTail.then(run, run);
      return syncTail;
    };

    const sendOutbox = (item: UltraOutboxItem): void => {
      if (disposed) return;
      pi.sendMessage({ customType: 'ultra-wave', content: item.content, display: true, details: item.details }, { triggerTurn: true, deliverAs: 'followUp' });
      operations.markOutboxSent(item.operationId);
    };

    const deliverPendingOutbox = (): void => {
      for (const item of operations.pendingOutbox()) sendOutbox(item);
    };

    const applyCompletion = (payload: unknown): boolean => {
      const terminal = operations.applyCompletion(payload);
      if (!terminal) return false;
      deliverPendingOutbox();
      return true;
    };

    const bufferCompletion = (payload: unknown): void => {
      if (!isRecord(payload)) return;
      const runId = typeof payload.runId === 'string' ? payload.runId : typeof payload.id === 'string' ? payload.id : undefined;
      if (!runId) return;
      for (const [key, value] of completionBuffer) if (value.expiresAt <= Date.now()) completionBuffer.delete(key);
      if (completionBuffer.size >= MAX_COMPLETION_BUFFER) completionBuffer.delete(completionBuffer.keys().next().value!);
      completionBuffer.set(runId, { payload, expiresAt: Date.now() + COMPLETION_BUFFER_TTL_MS });
    };

    const completionDispose = pi.events.on(COMPLETE_EVENT, (payload) => {
      if (disposed) return;
      if (!applyCompletion(payload)) bufferCompletion(payload);
    });

    const scheduleReconciliation = (operation: UltraOperation, attempt = 0): void => {
      if (disposed || attempt >= RECONCILE_DELAYS.length) return;
      const timer = setTimeout(async () => {
        timers.delete(timer);
        if (disposed || reconciliationAbort.signal.aborted) return;
        const payload = await dependencies.queryStatus(pi.events, operation.runId, reconciliationAbort.signal);
        if (payload && applyCompletion(payload)) return;
        const latest = operations.get(operation.operationId);
        if (latest && (latest.status === 'running' || latest.status === 'paused')) scheduleReconciliation(latest, attempt + 1);
      }, RECONCILE_DELAYS[attempt]);
      timer.unref?.();
      timers.add(timer);
    };

    pi.registerTool({
      name: 'ultra_delegate',
      label: 'Ultra Delegate',
      description: 'Launch one exact, preflighted Ultra worker wave. Use only for genuinely independent lanes; completion is evidence, not acceptance.',
      promptSnippet: 'Delegate one bounded, atomic worker wave while the active model remains manager.',
      executionMode: 'sequential',
      parameters: ULTRA_DELEGATE_SCHEMA,
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        try {
          const loaded = await dependencies.loadSettings();
          current = loaded;
          if (loaded.kind === 'invalid') return toolError(`Ultra configuration is blocked: ${loaded.reason}`);
          if (!loaded.settings.enabled) return toolError(ENABLE_FIRST);
          if (!policy?.operational || !policy.authority) return toolError('Ultra is blocked because compatible launch authority is unavailable. The main model must take over directly.');
          const input = params as UltraDelegateInput;
          if (input.repairOf) operations.assertRepairAllowed(input.repairOf);
          const prepared = await dependencies.prepareWave({
            input,
            settings: loaded.settings,
            cwd: ctx.cwd,
            sessionId: ctx.sessionManager.getSessionId(),
            revision: loaded.revision,
            availableModels: ctx.modelRegistry.getAvailable().map((model) => ({ provider: model.provider, id: model.id, fullId: `${model.provider}/${model.id}`, reasoning: model.reasoning })),
            parentModel: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
            capabilityCeiling: policy.capabilityCeiling,
          });
          const receipt = await dependencies.launchWave({ events: pi.events, authority: policy.authority, prepared });
          const runId = receiptRunId(receipt);
          if (!runId) return toolError('Ultra launch receipt did not contain a run ID. No operation was accepted.');
          const operationId = dependencies.randomId();
          const operation = operations.recordLaunch({
            operationId,
            runId,
            objective: prepared.objective,
            acceptance: prepared.acceptance,
            lanes: operationLanes(prepared),
            receipt,
            ...(input.repairOf ? { repairOf: input.repairOf } : {}),
          });
          const buffered = completionBuffer.get(runId);
          if (buffered) {
            completionBuffer.delete(runId);
            applyCompletion(buffered.payload);
          } else {
            scheduleReconciliation(operation);
          }
          return {
            content: [{ type: 'text' as const, text: `Ultra operation ${operationId} received launch receipt for run ${runId}. Completion remains evidence subject to main-model validation.` }],
            details: { kind: 'receipt', operationId, runId, receipt, lanes: prepared.lanes.map((lane) => lane.lane.id) },
          };
        } catch (error) {
          return toolError(boundedMessage(error));
        }
      },
    });

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
            const state = await dependencies.loadSettings();
            await dependencies.showMenu({
              ctx,
              state,
              update: async (patch) => {
                const committed = await dependencies.updateSettings(patch);
                await synchronize(ctx);
                return committed;
              },
              recover: async () => {
                const recovered = await dependencies.backupAndReset();
                await synchronize(ctx);
                return recovered;
              },
            });
          } catch (error) {
            notify(ctx, boundedMessage(error), 'error');
          }
          return;
        }
        if (keyword === 'help') {
          notify(ctx, 'Usage: /ultra, /ultra on, /ultra off, /ultra toggle, /ultra help, or /ultra <task>. The active model manages one worker attempt, one focused repair, then direct takeover.');
          return;
        }
        if (keyword === 'on' || keyword === 'off' || keyword === 'toggle') {
          try {
            await dependencies.updateSettings((settings) => ({ enabled: keyword === 'toggle' ? !settings.enabled : keyword === 'on' }));
            await synchronize(ctx);
          } catch (error) {
            notify(ctx, boundedMessage(error), 'error');
          }
          return;
        }
        const loaded = await dependencies.loadSettings();
        current = loaded;
        if (loaded.kind === 'invalid') {
          notify(ctx, `Ultra configuration is blocked: ${loaded.reason}`, 'error');
          return;
        }
        if (!loaded.settings.enabled) {
          notify(ctx, ENABLE_FIRST, 'error');
          return;
        }
        pi.sendUserMessage(`Ultra-managed task:\n${args}`, { deliverAs: 'followUp' });
      },
    });

    pi.on('before_agent_start', (event) => {
      if (current?.kind === 'invalid' || !current?.settings.enabled || !policy?.operational) return;
      return { systemPrompt: `${event.systemPrompt}\n\n${managerPolicy(current.settings)}` };
    });

    pi.on('tool_call', (event) => {
      if (event.toolName !== 'subagent') return;
      const governed = current?.kind === 'invalid' || current?.settings.enabled === true || policy?.mode === 'blocked';
      if (!governed || isSafeSubagentCall(event.input)) return;
      return { block: true, reason: 'Ultra governs new subagent launches. Use ultra_delegate for one exact authorized wave, or let the main model take over directly.' };
    });

    pi.on('session_start', async (_event, ctx) => {
      lastContext = ctx;
      operations.restore(ctx.sessionManager.getBranch());
      await synchronize(ctx);
      deliverPendingOutbox();
      for (const operation of operations.list()) if (operation.status === 'running' || operation.status === 'paused') scheduleReconciliation(operation);
      disposeWatcher?.();
      disposeWatcher = dependencies.watchSettings(
        () => {
          watcherFailed = undefined;
          return lastContext ? synchronize(lastContext) : undefined;
        },
        async (error) => {
          if (!lastContext || disposed) return;
          watcherFailed = `Settings watcher failed: ${boundedMessage(error)}`;
          await synchronize(lastContext);
          notify(lastContext, watcherFailed, 'error');
        },
      );
    });

    pi.on('session_shutdown', () => {
      if (disposed) return;
      disposed = true;
      reconciliationAbort.abort();
      disposeWatcher?.();
      disposeWatcher = undefined;
      policy?.dispose();
      policy = undefined;
      if (typeof completionDispose === 'function') completionDispose();
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      completionBuffer.clear();
    });
  };
}

export default createUltraExtension();
