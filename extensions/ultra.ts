import { createHash, randomUUID } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { Type } from 'typebox';
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  backupAndResetUltraSettings,
  loadUltraSettings,
  updateUltraSettings,
  watchUltraSettings,
  type LoadUltraSettingsResult,
  UltraSettingsCleanupError,
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
  ultraLaunchIdempotencyKey,
  type UltraOperationLane,
  type UltraOutboxItem,
} from './ultra-operations.js';
import {
  admitUltraWave,
  type UltraWriterAdmissionResult,
} from './ultra-writer-admission.js';
import {
  createUltraManagerState,
  ULTRA_MANAGER_ENTRY,
  type UltraManagerBinding,
  type UltraTakeoverReason,
} from './ultra-manager-state.js';
import {
  appendSessionUltraOverrides,
  clearSessionUltraOverrides,
  CommittedSessionUpdateError,
  resolveEffectiveUltraSettings,
  scanSessionUltraOverrides,
  type SessionOverridesScanResult,
  type UltraSessionOverrides,
} from './ultra-session-settings.js';

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
// Non-model-visible journal entry recording sanitized diagnostics for malformed
// session override snapshots found during restore. At most one entry is appended
// per distinct malformed set.
const SESSION_OVERRIDE_DIAGNOSTIC_TYPE = 'pi-ultra-session-settings-diagnostic';
const MAX_DIAGNOSTIC_TEXT = 512;
const execFile = promisify(execFileCallback);
const MANAGER_SCOPE_SCHEMA = Type.Object({
  scopeId: Type.String({ minLength: 1, maxLength: 128 }),
}, { additionalProperties: false });
const MANAGER_TAKEOVER_SCHEMA = Type.Object({
  scopeId: Type.String({ minLength: 1, maxLength: 128 }),
  reason: Type.Union([
    Type.Literal('inseparable-work'), Type.Literal('dirty-worktree'), Type.Literal('repair-exhausted'),
    Type.Literal('worker-capability-failure'), Type.Literal('urgent-user-directed'),
  ]),
  explanation: Type.String({ minLength: 1, maxLength: 512 }),
}, { additionalProperties: false });
const MANAGER_READ_ONLY_TOOLS = new Set(['read', 'grep', 'find', 'ls']);

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
    /** Whether the active session carries any explicit override snapshots. */
    hasSessionOverrides: boolean;
    /** Session-scope updater: appends current-session overrides only, never the global file. */
    updateSession(patch: UltraSettingsPatch | UltraSettingsMutator): Promise<ValidUltraSettingsResult>;
    /** Appends one explicit empty snapshot and returns the effective global defaults. */
    resetSession(): Promise<ValidUltraSettingsResult>;
    /** Global-scope updater: transactional pi-ultra.json write plus active-session resync. */
    updateGlobal(patch: UltraSettingsPatch | UltraSettingsMutator): Promise<ValidUltraSettingsResult>;
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
  admitWriterWave(input: { lanes: ReadonlyArray<{ id: string; role: 'scout' | 'worker' | 'reviewer' }>; cwd: string }): Promise<UltraWriterAdmissionResult>;
  randomId(): string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '').trim().slice(0, 1_024) || 'Unknown Ultra error.';
}

function sanitizeDiagnostic(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '').trim().slice(0, MAX_DIAGNOSTIC_TEXT);
}

/** Canonical (key-sorted) JSON digest so a session patch binds stably regardless of key order. */
function stablePatchDigest(patch: UltraSessionOverrides): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]));
    }
    return value;
  };
  return createHash('sha256').update(JSON.stringify(canonical(patch))).digest('hex');
}

/** Permit revision binding both the global revision and the session patch digest. */
function bindRevision(globalRevision: string, patchDigest: string): string {
  return createHash('sha256').update(`v1:${globalRevision}:${patchDigest}`).digest('hex');
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
      const replay = capabilities && isRecord(capabilities.resultReplay) ? capabilities.resultReplay : undefined;
      const preflight = capabilities && isRecord(capabilities.launchPreflight) ? capabilities.launchPreflight : undefined;
      const methods = data && Array.isArray(data.methods) ? data.methods : [];
      finish(payload.success === true && authority?.version === 1 && replay?.version === 1 && preflight?.version === 1 && methods.includes('spawn') && methods.includes('result') && methods.includes('preflight'));
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
    events.emit(SUBAGENT_RPC_REQUEST, { version: 1, requestId, method: 'result', params: { id: runId }, source: { extension: 'pi-ultra' } });
  });
}

async function defaultAdmitWriterWave(input: Parameters<UltraExtensionDependencies['admitWriterWave']>[0]): Promise<UltraWriterAdmissionResult> {
  const git = async (args: string[]): Promise<string | null> => {
    try { return (await execFile('git', ['-C', input.cwd, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 })).stdout.trim(); }
    catch { return null; }
  };
  return admitUltraWave({
    lanes: input.lanes,
    cwd: input.cwd,
    probes: {
      repositoryRoot: async () => git(['rev-parse', '--show-toplevel']),
      headCommit: async () => git(['rev-parse', '--verify', 'HEAD']),
      resolveRef: async (_cwd, ref) => git(['rev-parse', '--verify', ref]),
      mergeBase: async (_cwd, one, two) => git(['merge-base', one, two]),
      worktreeStatus: async () => (await execFile('git', ['-C', input.cwd, 'status', '--porcelain=v1', '--untracked-files=all'], { encoding: 'utf8', maxBuffer: 256 * 1024 })).stdout,
    },
  });
}

const DEFAULT_DEPENDENCIES: UltraExtensionDependencies = {
  loadSettings: () => loadUltraSettings(),
  updateSettings: (patch) => updateUltraSettings(patch),
  backupAndReset: () => backupAndResetUltraSettings(),
  showMenu: ({ ctx, state, hasSessionOverrides, updateSession, resetSession, updateGlobal, recover }) =>
    showUltraMenu({ ctx, state, hasSessionOverrides, updateSession, resetSession, updateGlobal, recover }),
  checkCapabilities: defaultCheckCapabilities,
  installPolicy: defaultInstallPolicy,
  watchSettings: (onChange, onError) => watchUltraSettings(onChange, undefined, onError),
  prepareWave: prepareUltraWave,
  launchWave: launchUltraWave,
  queryStatus: defaultQueryStatus,
  admitWriterWave: defaultAdmitWriterWave,
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

function sessionIdentity(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId();
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
    let effective: UltraSettings | undefined;
    let effectiveRevisionValue: string | undefined;
    let sessionPatch: UltraSessionOverrides = {};
    let reportedDiagnosticKey: string | undefined;
    let policy: UltraPolicyRegistration | undefined;
    let capabilityCompatible: boolean | undefined;
    let watcherFailed: string | undefined;
    let lastContext: ExtensionContext | undefined;
    let disposed = false;
    let lifecycleGeneration = 0;
    let disposeWatcher: (() => void) | undefined;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const reconciliationAbort = new AbortController();
    const completionBuffer = new Map<string, { payload: unknown; expiresAt: number }>();

    const operations = createUltraOperationStore({ append: (data) => pi.appendEntry(ULTRA_OPERATION_ENTRY, data) });
    const managerState = createUltraManagerState({ append: (data) => pi.appendEntry(ULTRA_MANAGER_ENTRY, data) });
    // Scope binding must survive leaf changes caused by compaction and reload.
    // A scope ID is still explicitly re-established per agent turn below, so
    // durable history cannot silently grant a newly started turn authority.
    let currentManagerScopeId: string | undefined;
    const managerBinding = (ctx: ExtensionContext, scopeId: string): UltraManagerBinding | undefined => {
      if (!effective || effective.orchestrationMode !== 'manager' || !effectiveRevisionValue) return undefined;
      return { scopeId, rootId: sessionIdentity(ctx), policyRevision: effectiveRevisionValue };
    };

    const appendSessionSnapshot = (patch: UltraSessionOverrides): void => {
      appendSessionUltraOverrides((customType, data) => pi.appendEntry(customType, data), patch);
    };

    // At most one non-model-visible diagnostic entry per distinct malformed
    // override set; text is sanitized before any UI/message consumer sees it.
    const reportOverrideDiagnostics = (scan: SessionOverridesScanResult): void => {
      if (scan.ignoredCount === 0) {
        reportedDiagnosticKey = undefined;
        return;
      }
      const key = JSON.stringify([scan.ignored.map((item) => `${sanitizeDiagnostic(item.id)}::${sanitizeDiagnostic(item.reason)}`), scan.ignoredCount]);
      if (key === reportedDiagnosticKey) return;
      reportedDiagnosticKey = key;
      pi.appendEntry(SESSION_OVERRIDE_DIAGNOSTIC_TYPE, {
        version: 1,
        ignoredCount: scan.ignoredCount,
        reasons: scan.ignored.map((item) => sanitizeDiagnostic(item.reason)),
      });
    };

    // Rescans the Pi branch so appended snapshots and restored branches both
    // feed the same latest-valid-wins patch.
    const refreshSessionOverrides = (ctx: ExtensionContext): void => {
      const scan = scanSessionUltraOverrides(ctx.sessionManager.getBranch());
      sessionPatch = scan.patch;
      reportOverrideDiagnostics(scan);
    };

    const notify = (ctx: ExtensionContext, message: string, level: 'info' | 'warning' | 'error' = 'info') => {
      if (ctx.hasUI) ctx.ui.notify(message, level);
      else pi.sendMessage({ customType: 'ultra-diagnostic', content: message, display: false, details: { level } });
    };

    // Post-durable-write refresh shared by the session update/reset menu
    // callbacks. Everything after the snapshot append/clear counts as a
    // committed outcome, so any refresh failure surfaces as a
    // CommittedSessionUpdateError instead of an ordinary rollback-shaped
    // rejection; failures before any durable write are never wrapped.
    // Disabled sessions intentionally leave `effective` undefined, so the
    // reported state is rebuilt from freshly loaded globals plus the
    // independently resolved session patch instead of the synchronization
    // cache. A synchronize transition that ended blocked or stale can never
    // yield a verified result: even when a later load succeeds, policy
    // enforcement was not confirmed, so this throws and the caller surfaces a
    // committed-but-unverified outcome instead of an optimistic one.
    const verifiedPostCommitState = async (ctx: ExtensionContext): Promise<ValidUltraSettingsResult> => {
      const synced = await synchronize(ctx);
      const refreshed = await dependencies.loadSettings();
      if (refreshed.kind === 'invalid') {
        throw new Error(`Ultra configuration is blocked: ${refreshed.reason}`);
      }
      let applied: UltraSettings;
      try {
        applied = resolveEffectiveUltraSettings(refreshed.settings, sessionPatch);
      } catch (error) {
        throw new Error(boundedMessage(error));
      }
      if (applied.enabled ? synced !== 'on' : synced !== 'off') {
        throw new Error(`synchronize ended '${synced ?? 'stale'}' while computing ${applied.enabled ? 'enabled' : 'disabled'} state; refusing a verified result.`);
      }
      return {
        kind: 'loaded',
        settings: applied,
        revision: bindRevision(refreshed.revision, stablePatchDigest(sessionPatch)),
        path: refreshed.path,
      } satisfies ValidUltraSettingsResult;
    };

    const refreshAfterCommittedSnapshot = async (ctx: ExtensionContext): Promise<ValidUltraSettingsResult> => {
      try {
        return await verifiedPostCommitState(ctx);
      } catch (error) {
        throw new CommittedSessionUpdateError(
          `Session settings were saved, but the refreshed state could not be verified (${boundedMessage(error)}); Ultra stays fail-closed until a successful resync.`,
          { cause: error },
        );
      }
    };

    const status = (ctx: ExtensionContext, value: 'on' | 'off' | 'blocked', settings?: UltraSettings) => {
      const mode = settings?.orchestrationMode ?? effective?.orchestrationMode ?? 'collaborator';
      if (ctx.hasUI) ctx.ui.setStatus('ultra', value === 'on' ? `Ultra: ${mode}` : `Ultra: ${value}`);
    };

    const validateRevision = async (revision: string, _signal: AbortSignal): Promise<boolean> => {
      const loaded = await dependencies.loadSettings();
      if (loaded.kind === 'invalid') return false;
      try {
        if (!resolveEffectiveUltraSettings(loaded.settings, sessionPatch).enabled) return false;
      } catch {
        return false;
      }
      return bindRevision(loaded.revision, stablePatchDigest(sessionPatch)) === revision;
    };

    /** Final state of one synchronize transition; undefined when fenced stale/disposed. */
    type SynchronizeOutcome = 'on' | 'off' | 'blocked' | undefined;
    let syncTail: Promise<SynchronizeOutcome> = Promise.resolve(undefined);
    const synchronize = (ctx: ExtensionContext): Promise<SynchronizeOutcome> => {
      const run = async (): Promise<SynchronizeOutcome> => {
        if (disposed) return undefined;
        const generation = lifecycleGeneration;
        const stale = () => disposed || generation !== lifecycleGeneration;
        lastContext = ctx;
        refreshSessionOverrides(ctx);
        let guard: UltraPolicyRegistration | undefined;
        let next: UltraPolicyRegistration | undefined;
        try {
          guard = await dependencies.installPolicy({ sessionId: sessionIdentity(ctx), mode: 'blocked', validateRevision });
          if (stale()) { guard.dispose(); return undefined; }
          if (watcherFailed) {
            policy?.dispose();
            policy = guard;
            effective = undefined;
            effectiveRevisionValue = undefined;
            status(ctx, 'blocked');
            return 'blocked';
          }
          const loaded = await dependencies.loadSettings();
          if (stale()) { guard.dispose(); return undefined; }
          if (loaded.kind === 'invalid') {
            policy?.dispose();
            policy = guard;
            effective = undefined;
            effectiveRevisionValue = undefined;
            status(ctx, 'blocked');
            notify(ctx, `Ultra configuration is blocked: ${loaded.reason}`, 'error');
            return 'blocked';
          }
          let resolved: UltraSettings;
          try {
            resolved = resolveEffectiveUltraSettings(loaded.settings, sessionPatch);
          } catch (error) {
            policy?.dispose();
            policy = guard;
            effective = undefined;
            effectiveRevisionValue = undefined;
            status(ctx, 'blocked');
            notify(ctx, `Ultra configuration is blocked: ${boundedMessage(error)}`, 'error');
            return 'blocked';
          }
          if (!resolved.enabled) {
            policy?.dispose();
            guard.dispose();
            policy = undefined;
            effective = undefined;
            effectiveRevisionValue = undefined;
            status(ctx, 'off');
            return 'off';
          }
          capabilityCompatible ??= await dependencies.checkCapabilities(pi.events);
          if (stale()) { guard.dispose(); return undefined; }
          if (!capabilityCompatible) {
            policy?.dispose();
            policy = guard;
            effective = undefined;
            effectiveRevisionValue = undefined;
            status(ctx, 'blocked');
            notify(ctx, 'Ultra is blocked: installed pi-subagents lacks launch-authority v1. Install the pinned compatible fork and /reload.', 'error');
            return 'blocked';
          }
          next = await dependencies.installPolicy({ sessionId: sessionIdentity(ctx), mode: 'enabled', validateRevision });
          if (stale()) { next.dispose(); guard.dispose(); return undefined; }
          policy?.dispose();
          policy = next;
          guard.dispose();
          effective = resolved;
          effectiveRevisionValue = bindRevision(loaded.revision, stablePatchDigest(sessionPatch));
          status(ctx, 'on', resolved);
          return 'on';
        } catch (error) {
          next?.dispose();
          if (stale()) { guard?.dispose(); return undefined; }
          if (guard) {
            policy?.dispose();
            policy = guard;
          }
          effective = undefined;
          effectiveRevisionValue = undefined;
          status(ctx, 'blocked');
          notify(ctx, `Ultra is blocked: ${boundedMessage(error)}`, 'error');
          return 'blocked';
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
      const generation = lifecycleGeneration;
      const timer = setTimeout(async () => {
        timers.delete(timer);
        if (disposed || generation !== lifecycleGeneration || reconciliationAbort.signal.aborted) return;
        const payload = await dependencies.queryStatus(pi.events, operation.runId, reconciliationAbort.signal);
        if (disposed || generation !== lifecycleGeneration || reconciliationAbort.signal.aborted) return;
        if (payload && applyCompletion(payload)) return;
        const latest = operations.get(operation.operationId);
        if (latest && (latest.status === 'running' || latest.status === 'paused')) scheduleReconciliation(latest, attempt + 1);
      }, RECONCILE_DELAYS[attempt]);
      timer.unref?.();
      timers.add(timer);
    };

    pi.registerTool({
      name: 'ultra_begin_scope',
      label: 'Ultra Begin Manager Scope',
      description: 'Open one durable Manager-mode decision scope for the current turn. This never grants parent mutation.',
      promptSnippet: 'Open a Manager-mode scope before choosing governed dispatch or explicit takeover.',
      executionMode: 'sequential',
      parameters: MANAGER_SCOPE_SCHEMA,
      async execute(_toolCallId, params, _toolSignal, _onUpdate, ctx) {
        const scopeId = isRecord(params) && typeof params.scopeId === 'string' ? params.scopeId : undefined;
        const binding = scopeId ? managerBinding(ctx, scopeId) : undefined;
        if (!binding) return toolError('Ultra Manager mode is not active and synchronized.');
        try {
          managerState.openScope({ ...binding, createdAt: Date.now() });
          currentManagerScopeId = scopeId;
          return { content: [{ type: 'text' as const, text: `Ultra Manager scope ${scopeId} opened. Choose governed dispatch or an eligible explicit takeover.` }], details: { kind: 'manager-scope', scopeId } };
        } catch (error) {
          return toolError(boundedMessage(error));
        }
      },
    });

    pi.registerTool({
      name: 'ultra_takeover',
      label: 'Ultra Manager Takeover',
      description: 'Grant bounded parent mutation for an active Manager-mode scope when the recorded reason is eligible.',
      promptSnippet: 'Record an accountable, evidence-bound Manager-mode takeover before mutating the project directly.',
      executionMode: 'sequential',
      parameters: MANAGER_TAKEOVER_SCHEMA,
      async execute(_toolCallId, params, _toolSignal, _onUpdate, ctx) {
        const scopeId = isRecord(params) && typeof params.scopeId === 'string' ? params.scopeId : undefined;
        const reason = isRecord(params) && typeof params.reason === 'string' ? params.reason as UltraTakeoverReason : undefined;
        const explanation = isRecord(params) && typeof params.explanation === 'string' ? params.explanation.trim() : '';
        const binding = scopeId ? managerBinding(ctx, scopeId) : undefined;
        if (!binding || !reason || !explanation) return toolError('Ultra Manager takeover requires an active synchronized scope, valid reason, and explanation.');
        try {
          managerState.recordTakeover({ ...binding, reason, explanation: explanation.slice(0, 512), createdAt: Date.now() });
          return { content: [{ type: 'text' as const, text: `Ultra Manager takeover recorded for scope ${scopeId}: ${reason}. Parent mutation is now limited to this scope and policy revision.` }], details: { kind: 'manager-takeover', scopeId, reason } };
        } catch (error) {
          return toolError(boundedMessage(error));
        }
      },
    });

    pi.registerTool({
      name: 'ultra_delegate',
      label: 'Ultra Delegate',
      description: 'Launch one exact, preflighted Ultra worker wave. Use only for genuinely independent lanes; completion is evidence, not acceptance.',
      promptSnippet: 'Delegate one bounded, atomic worker wave while the active model remains manager.',
      executionMode: 'sequential',
      parameters: ULTRA_DELEGATE_SCHEMA,
      async execute(_toolCallId, params, toolSignal, _onUpdate, ctx) {
        const generation = lifecycleGeneration;
        const stale = () => disposed || generation !== lifecycleGeneration;
        const signal = toolSignal ? AbortSignal.any([toolSignal, reconciliationAbort.signal]) : reconciliationAbort.signal;
        let repairReservationId: string | undefined;
        let launchAttemptId: string | undefined;
        try {
          // RPC/model work can race session_start. Re-run the fail-closed policy
          // synchronization here so no delegation observes uninitialized state.
          const synced = await synchronize(ctx);
          if (stale()) throw new Error('Ultra extension reloaded before delegation initialized.');
          // A blocked transition can retain a stale enabled registration whose
          // operational authority still passes the gate below; blocked must
          // deny every new launch outright before any preflight or wave action.
          if (synced === 'blocked') {
            return toolError('Ultra is blocked because launch authority could not be synchronized. The main model must take over directly.');
          }
          refreshSessionOverrides(ctx);
          const loaded = await dependencies.loadSettings();
          if (stale()) throw new Error('Ultra extension reloaded before delegation completed.');
          if (loaded.kind === 'invalid') return toolError(`Ultra configuration is blocked: ${loaded.reason}`);
          let resolved: UltraSettings;
          try {
            resolved = resolveEffectiveUltraSettings(loaded.settings, sessionPatch);
          } catch (error) {
            return toolError(boundedMessage(error));
          }
          if (!resolved.enabled) return toolError(ENABLE_FIRST);
          if (resolved.orchestrationMode === 'manager') {
            const scopeId = currentManagerScopeId;
            const binding = scopeId ? managerBinding(ctx, scopeId) : undefined;
            if (!binding || !managerState.hasActiveScope(binding)) {
              return toolError('Ultra Manager mode requires an active durable scope before dispatch. Call ultra_begin_scope, then dispatch one exact independent wave or record an eligible takeover.');
            }
          }
          if (!policy?.operational || !policy.authority) return toolError('Ultra is blocked because compatible launch authority is unavailable. The main model must take over directly.');
          const input = params as UltraDelegateInput;
          const admission = await dependencies.admitWriterWave({
            lanes: input.lanes.map((lane) => ({ id: lane.id, role: lane.role })),
            cwd: ctx.cwd,
          });
          if (!admission.admitted) {
            const scopeId = currentManagerScopeId;
            const binding = scopeId ? managerBinding(ctx, scopeId) : undefined;
            if (binding && admission.reason === 'dirty-worktree') {
              managerState.recordEvidence({ ...binding, evidence: 'dirty-worktree', createdAt: Date.now() });
            }
            return toolError(`Ultra writer admission denied (${admission.reason}): ${admission.diagnostics.join(' ') || 'repository safety could not be verified.'}`);
          }
          if (input.repairOf) operations.assertRepairAllowed(input.repairOf);
          const revision = bindRevision(loaded.revision, stablePatchDigest(sessionPatch));
          const prepared = await dependencies.prepareWave({
            input,
            settings: resolved,
            cwd: ctx.cwd,
            sessionId: sessionIdentity(ctx),
            revision,
            availableModels: ctx.modelRegistry.getAvailable().map((model) => ({ provider: model.provider, id: model.id, fullId: `${model.provider}/${model.id}`, reasoning: model.reasoning })),
            parentModel: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
            capabilityCeiling: policy.capabilityCeiling,
            events: pi.events,
          });
          if (stale()) throw new Error('Ultra extension reloaded during wave preflight.');
          effective = resolved;
          effectiveRevisionValue = revision;
          const operationId = dependencies.randomId();
          launchAttemptId = ultraLaunchIdempotencyKey({ operationId, attemptIndex: 0 });
          operations.recordQueuedLaunch({
            idempotencyKey: launchAttemptId,
            operationId,
            runId: `pending:${operationId}`,
            lanes: operationLanes(prepared),
            receipt: { state: 'queued-before-permit' },
          });
          if (input.repairOf) {
            repairReservationId = `${operationId}.repair`;
            operations.reserveRepair(input.repairOf, repairReservationId);
          }
          let receipt: unknown;
          try {
            // The admitted record is durable before the spawn RPC. On a crash,
            // restore surfaces it as ambiguous and never blindly relaunches.
            operations.markLaunchAdmitted(launchAttemptId);
            receipt = await dependencies.launchWave({ events: pi.events, authority: policy.authority, prepared, signal });
            operations.markLaunched(launchAttemptId);
          } catch (error) {
            if (launchAttemptId && !signal.aborted && !stale()) operations.markFailedPreSpawn(launchAttemptId, boundedMessage(error));
            if (repairReservationId && !signal.aborted && !stale()) operations.releaseRepair(repairReservationId);
            throw error;
          }
          if (stale()) throw new Error('Ultra extension reloaded after wave admission; the durable repair reservation remains fail-closed.');
          const runId = receiptRunId(receipt);
          if (!runId) return toolError('Ultra launch receipt could not be correlated. Do not relaunch; inspect subagent status and let the main model take over.');
          const operation = operations.recordLaunch({
            operationId,
            runId,
            objective: prepared.objective,
            acceptance: prepared.acceptance,
            lanes: operationLanes(prepared),
            receipt,
            ...(admission.evidence?.repositoryRoot && admission.evidence.headCommit
              ? { writerBase: { repositoryRoot: admission.evidence.repositoryRoot, baseCommit: admission.evidence.headCommit } }
              : {}),
            ...(input.repairOf ? { repairOf: input.repairOf, repairReservationId } : {}),
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
            const loaded = await dependencies.loadSettings();
            let state: LoadUltraSettingsResult;
            if (loaded.kind === 'invalid') {
              state = loaded;
            } else {
              try {
                const resolved = resolveEffectiveUltraSettings(loaded.settings, sessionPatch);
                state = {
                  kind: 'loaded',
                  settings: resolved,
                  revision: bindRevision(loaded.revision, stablePatchDigest(sessionPatch)),
                  path: loaded.path,
                };
              } catch (error) {
                state = { kind: 'invalid', reason: boundedMessage(error), path: loaded.path };
              }
            }
            await dependencies.showMenu({
              ctx,
              state,
              hasSessionOverrides: Object.keys(sessionPatch).length > 0,
              // Session-scope updater: menu edits append session overrides and
              // never touch the global settings file.
              updateSession: async (patchInput) => {
                const baseSettings = state.kind === 'invalid' ? undefined : state.settings;
                const patch = typeof patchInput === 'function' && baseSettings
                  ? patchInput(baseSettings)
                  : patchInput;
                const override: UltraSessionOverrides = { ...sessionPatch };
                const record = isRecord(patch) ? patch : {};
                if (record.enabled !== undefined) override.enabled = record.enabled === true;
                if (record.routingMode !== undefined) override.routingMode = record.routingMode;
                if (record.orchestrationMode !== undefined) override.orchestrationMode = record.orchestrationMode;
                // Key presence, not value: an explicit undefined (menu
                // Automatic) must override any inherited model, while an
                // absent field keeps inheriting.
                if ('workerModel' in record) {
                  const model = record.workerModel;
                  override.workerModel = typeof model === 'string' && model.trim() ? model.trim() : null;
                }
                if (record.minLanes !== undefined || record.maxLanes !== undefined) {
                  override.minLanes = record.minLanes ?? baseSettings?.minLanes;
                  override.maxLanes = record.maxLanes ?? baseSettings?.maxLanes;
                }
                appendSessionSnapshot(override);
                // The snapshot is durable from here on; refresh failures are
                // committed outcomes and must not roll the display back.
                return refreshAfterCommittedSnapshot(ctx);
              },
              // Reset: one explicit empty session snapshot clears every
              // override; the global file stays untouched and the reported
              // state is the effective global defaults.
              resetSession: async () => {
                clearSessionUltraOverrides((customType, data) => pi.appendEntry(customType, data));
                // Symmetric with updateSession: the empty clear snapshot is
                // durable from here on; refresh failures are committed
                // outcomes and must not roll provenance back to Active.
                return refreshAfterCommittedSnapshot(ctx);
              },
              // Global-scope updater: the existing transactional locked write,
              // then resync this session; inheriting sessions observe the same
              // change through the settings watcher without losing patched
              // fields. The returned state is the refreshed session-effective
              // result — raw globals would make the menu render unpatched
              // values under "This session" while overrides are active.
              updateGlobal: async (patchInput) => {
                await dependencies.updateSettings(patchInput);
                // The global write is durable here; any post-write failure is
                // a committed outcome, never an ordinary rollback-shaped
                // rejection or an optimistic verified result while the
                // synchronize transition ended blocked/stale.
                try {
                  return await verifiedPostCommitState(ctx);
                } catch (error) {
                  throw new CommittedSessionUpdateError(
                    `Global settings were saved, but the refreshed session state could not be verified (${boundedMessage(error)}); Ultra stays fail-closed until a successful resync.`,
                    { cause: error },
                  );
                }
              },
              recover: async () => {
                try {
                  const recovered = await dependencies.backupAndReset();
                  await synchronize(ctx);
                  return recovered;
                } catch (error) {
                  if (error instanceof UltraSettingsCleanupError) await synchronize(ctx);
                  throw error;
                }
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
            // Session-scoped: only the active session override changes; the
            // global settings file stays untouched.
            const nextEnabled = keyword === 'toggle' ? !(effective?.enabled ?? false) : keyword === 'on';
            appendSessionSnapshot({ ...sessionPatch, enabled: nextEnabled });
            await synchronize(ctx);
          } catch (error) {
            notify(ctx, boundedMessage(error), 'error');
          }
          return;
        }
        refreshSessionOverrides(ctx);
        const loaded = await dependencies.loadSettings();
        if (loaded.kind === 'invalid') {
          notify(ctx, `Ultra configuration is blocked: ${loaded.reason}`, 'error');
          return;
        }
        let resolved: UltraSettings;
        try {
          resolved = resolveEffectiveUltraSettings(loaded.settings, sessionPatch);
        } catch (error) {
          notify(ctx, boundedMessage(error), 'error');
          return;
        }
        if (!resolved.enabled) {
          notify(ctx, ENABLE_FIRST, 'error');
          return;
        }
        pi.sendUserMessage(`Ultra-managed task:\n${args}`, { deliverAs: 'followUp' });
      },
    });

    pi.on('before_agent_start', (event, ctx) => {
      // Each turn gets a fresh fence. A restored/replayed scope is durable
      // evidence, never an inherited authority grant for a new turn.
      currentManagerScopeId = undefined;
      if (!effective?.enabled || !policy?.operational) return;
      return { systemPrompt: `${event.systemPrompt}\n\n${managerPolicy(effective)}` };
    });

    pi.on('tool_call', (event, ctx) => {
      const governed = !effective || effective.enabled === true || policy?.mode === 'blocked';
      if (event.toolName === 'subagent') {
        if (!governed || isSafeSubagentCall(event.input)) return;
        return { block: true, reason: 'Ultra governs new subagent launches. Use ultra_delegate for one exact authorized wave, or let the main model take over directly.' };
      }
      if (!effective?.enabled || effective.orchestrationMode !== 'manager' || !policy?.operational) return;
      if (event.toolName === 'ultra_begin_scope' || event.toolName === 'ultra_takeover' || event.toolName === 'ultra_delegate' || MANAGER_READ_ONLY_TOOLS.has(event.toolName)) return;
      // There is no sound heuristic for shell/custom-tool mutability. Unknown
      // tools are therefore denied until a durable takeover matches this turn.
      const scopeId = currentManagerScopeId;
      const permitted = scopeId ? managerState.allowsMutation(managerBinding(ctx, scopeId) ?? { scopeId: '', rootId: '', policyRevision: '' }) : false;
      if (!permitted) return { block: true, reason: 'Ultra Manager mode blocks parent mutation and unknown tools until an active scoped takeover is recorded.' };
    });

    pi.on('session_start', async (_event, ctx) => {
      const generation = lifecycleGeneration;
      lastContext = ctx;
      // Restore uses Pi branch order as supplied; scan the branch for the
      // session override patch before the fail-closed synchronization.
      operations.restore(ctx.sessionManager.getBranch());
      managerState.restore(ctx.sessionManager.getBranch());
      refreshSessionOverrides(ctx);
      await synchronize(ctx);
      if (disposed || generation !== lifecycleGeneration) return;
      deliverPendingOutbox();
      for (const operation of operations.list()) if (operation.status === 'running' || operation.status === 'paused') scheduleReconciliation(operation);
      disposeWatcher?.();
      disposeWatcher = dependencies.watchSettings(
        () => {
          watcherFailed = undefined;
          // The watcher only needs the transition side effect; the outcome
          // value is consumed by post-commit updaters, not here.
          return lastContext ? synchronize(lastContext).then(() => undefined) : undefined;
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
      lifecycleGeneration += 1;
      reconciliationAbort.abort(new Error('Ultra extension session shut down.'));
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
