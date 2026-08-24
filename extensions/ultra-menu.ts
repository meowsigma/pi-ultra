import { defineMenu, runMenu } from '@narumitw/pi-tui-kit';
import type {
  ActionsScreen,
  ChoiceScreen,
  MenuActionContext,
  MenuActionHandler,
  MenuActionResult,
  MenuScreenFactory,
  RunMenuOptions,
  RunMenuResult,
  SettingsScreen,
} from '@narumitw/pi-tui-kit';
import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { UltraSettingsCleanupError } from './ultra-config.js';
import type {
  InvalidUltraSettingsResult,
  LoadUltraSettingsResult,
  UltraSettings,
  UltraSettingsPatch,
  UltraSettingsMutator,
  ValidUltraSettingsResult,
} from './ultra-config.js';

/** Which settings surface an edit targets: this session's overrides or all-session global defaults. */
export type UltraMenuScope = 'session' | 'global';

/** Menu runtime state shared by every screen factory and action handler. */
export interface UltraMenuState {
  state: LoadUltraSettingsResult;
}

export type UltraScreenId =
  | 'main' | 'settings' | 'global-settings' | 'help'
  | 'model-select' | 'global-model-select' | 'lane-range' | 'global-lane-range';

export type UltraActionId =
  | 'enable-ultra' | 'disable-ultra'
  // Session-scoped (current-session override) setting edits.
  | 'set-ultra' | 'set-routing' | 'set-model' | 'set-lane-range'
  // Global-defaults (pi-ultra.json) setting edits.
  | 'set-ultra-global' | 'set-routing-global' | 'set-model-global' | 'set-lane-range-global'
  | 'reset-session' | 'recover-config';

export interface UltraMenuContext extends Pick<ExtensionCommandContext, 'mode' | 'hasUI' | 'model' | 'scopedModels'> {
  ui: Pick<ExtensionCommandContext['ui'], 'custom' | 'input' | 'select' | 'confirm' | 'notify'>;
  modelRegistry: Pick<ExtensionCommandContext['modelRegistry'], 'getAvailable'>;
}

export interface UltraMainMenuOptions {
  /** Whether the active session carries any explicit override snapshots. */
  hasSessionOverrides?: boolean;
}

export interface ShowUltraMenuOptions {
  ctx: UltraMenuContext;
  /** Effective state for the active session (globals overlaid with its patch). */
  state: LoadUltraSettingsResult;
  hasSessionOverrides: boolean;
  /** Session-scope updater: appends a current-session override snapshot only. */
  updateSession(patch: UltraSettingsPatch | UltraSettingsMutator): Promise<ValidUltraSettingsResult>;
  /** Clears every session override via one explicit empty snapshot and returns the effective global defaults. */
  resetSession(): Promise<ValidUltraSettingsResult>;
  /** Global-scope updater: the transactional pi-ultra.json write path. */
  updateGlobal(patch: UltraSettingsPatch | UltraSettingsMutator): Promise<ValidUltraSettingsResult>;
  recover(): Promise<{ backupPath: string; committed: ValidUltraSettingsResult }>;
  signal?: AbortSignal;
}

const HELP_LINES = [
  'Ultra keeps the active session model as manager and final reviewer.',
  'It launches only exact, preflighted, independent worker waves.',
  'Escalation: one initial attempt, one focused repair, then main-model takeover.',
  'Uniform routing pins every role lane to one canonical model.',
  'Role defaults preserve each strict role candidate chain.',
  'Lane ranges are hard per-wave bounds; Ultra never manufactures padding.',
  'Worker completion is evidence, never acceptance.',
  'This session writes only current-session overrides; Global defaults writes pi-ultra.json for every inheriting session.',
] as const;

const PRESETS = [
  { id: 'small', label: 'Small — 1–2', minLanes: 1, maxLanes: 2 },
  { id: 'balanced', label: 'Balanced — 2–4', minLanes: 2, maxLanes: 4 },
  { id: 'large', label: 'Large — 4–8', minLanes: 4, maxLanes: 8 },
] as const;

const RESET_SESSION_LABEL = 'Reset this session to global defaults';
const GLOBAL_DEFAULTS_LABEL = 'Global defaults…';
const ROUTING_UNIFORM_LABEL = 'One model for every lane';
const ROUTING_ROLE_DEFAULTS_LABEL = 'Role defaults';

function isValidState(state: LoadUltraSettingsResult): state is ValidUltraSettingsResult {
  return state.kind !== 'invalid';
}

function routingLabel(mode: UltraSettings['routingMode']): string {
  return mode === 'uniform' ? ROUTING_UNIFORM_LABEL : ROUTING_ROLE_DEFAULTS_LABEL;
}

function presetFor(settings: UltraSettings): (typeof PRESETS)[number] | undefined {
  return PRESETS.find((preset) => preset.minLanes === settings.minLanes && preset.maxLanes === settings.maxLanes);
}

export function laneRangeLabel(settings: UltraSettings): string {
  const preset = presetFor(settings);
  return preset ? `${preset.label.split(' — ')[0]} · ${settings.minLanes}–${settings.maxLanes}` : `Custom · ${settings.minLanes}–${settings.maxLanes}`;
}

export function sessionOverridesLine(hasSessionOverrides: boolean): string {
  return `Session overrides: ${hasSessionOverrides ? 'Active' : 'None'}`;
}

export function buildMainMenu(settings: UltraSettings, options: UltraMainMenuOptions = {}): ActionsScreen<UltraScreenId, UltraActionId> {
  const model = settings.routingMode === 'role-defaults' ? 'Role defaults' : settings.workerModel ?? 'Automatic';
  return {
    kind: 'actions',
    title: 'Ultra Control',
    lines: [
      `Ultra: ${settings.enabled ? 'Enabled' : 'Disabled'}`,
      `Routing: ${routingLabel(settings.routingMode)}`,
      `Model: ${model}`,
      `Lane range: ${laneRangeLabel(settings)}`,
      sessionOverridesLine(options.hasSessionOverrides === true),
    ],
    items: [
      settings.enabled
        ? { id: 'disable-ultra', label: 'Disable Ultra', action: 'disable-ultra' }
        : { id: 'enable-ultra', label: 'Enable Ultra', action: 'enable-ultra' },
      { id: 'settings', label: 'Settings…', to: 'settings' },
      { id: 'reset-session', label: RESET_SESSION_LABEL, action: 'reset-session' },
      { id: 'global-settings', label: GLOBAL_DEFAULTS_LABEL, to: 'global-settings' },
      { id: 'help', label: 'Help', to: 'help' },
      { id: 'close', label: 'Close', close: true },
    ],
    hint: 'close',
  };
}

export function buildBlockedMenu(state: InvalidUltraSettingsResult): ActionsScreen<UltraScreenId, UltraActionId> {
  return {
    kind: 'actions',
    title: 'Ultra Control — Blocked',
    lines: ['Ultra: Blocked', state.reason.slice(0, 512), 'New subagent launches remain denied until recovery or a valid off state is committed.'],
    items: [
      { id: 'recover', label: 'Back up invalid file and reset disabled…', action: 'recover-config' },
      { id: 'help', label: 'Help', to: 'help' },
      { id: 'close', label: 'Close', close: true },
    ],
    hint: 'close',
  };
}

/** Screen ids a scope's chooser actions navigate to. */
interface ScopeTargets {
  modelSelect: UltraScreenId;
  laneRange: UltraScreenId;
}

const SESSION_TARGETS: ScopeTargets = { modelSelect: 'model-select', laneRange: 'lane-range' };
const GLOBAL_TARGETS: ScopeTargets = { modelSelect: 'global-model-select', laneRange: 'global-lane-range' };

function settingsTitle(scope: UltraMenuScope): string {
  return scope === 'global' ? 'Ultra Global Defaults — All sessions' : 'Ultra Settings — This session';
}

function scopedAction(scope: UltraMenuScope, base: 'set-ultra' | 'set-routing' | 'set-model' | 'set-lane-range'): UltraActionId {
  return scope === 'global' ? `${base}-global` as UltraActionId : base;
}

function scopeSuffix(scope: UltraMenuScope): string {
  return scope === 'global' ? ' — All sessions' : '';
}

export function buildSettingsScreen(
  settings: UltraSettings,
  availableIds: readonly string[],
  scope: UltraMenuScope = 'session',
): SettingsScreen<UltraActionId> {
  const unavailable = settings.workerModel !== undefined && !availableIds.includes(settings.workerModel);
  return {
    kind: 'settings',
    title: settingsTitle(scope),
    items: [
      { id: 'ultra', label: 'Ultra', currentValue: settings.enabled ? 'Enabled' : 'Disabled', values: ['Enabled', 'Disabled'], action: scopedAction(scope, 'set-ultra') },
      { id: 'routing-mode', label: 'Routing mode', currentValue: routingLabel(settings.routingMode), values: [ROUTING_UNIFORM_LABEL, ROUTING_ROLE_DEFAULTS_LABEL], action: scopedAction(scope, 'set-routing') },
      {
        id: 'worker-model', label: 'Worker model', currentValue: settings.workerModel ?? 'Automatic', values: [settings.workerModel ?? 'Automatic', 'Choose…'], action: scopedAction(scope, 'set-model'),
        description: unavailable ? 'Saved model is unavailable; used only by uniform routing' : 'Used only by uniform routing',
      },
      { id: 'lane-range', label: 'Lane range', currentValue: laneRangeLabel(settings), values: [laneRangeLabel(settings), 'Choose…'], action: scopedAction(scope, 'set-lane-range'), description: 'Hard per-wave eligibility bounds' },
    ],
  };
}

interface CatalogEntry {
  id: string;
  label: string;
  searchText: string;
}

function codePointCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function buildModelCatalog(models: ReadonlyArray<{ provider: string; id: string; name?: string }>): CatalogEntry[] {
  const grouped = new Map<string, Set<string>>();
  for (const model of models) {
    if (!model || typeof model.provider !== 'string' || typeof model.id !== 'string') continue;
    const provider = model.provider.trim();
    const id = model.id.trim();
    if (!provider || !id) continue;
    const canonical = `${provider}/${id}`;
    const names = grouped.get(canonical) ?? new Set<string>();
    if (typeof model.name === 'string' && model.name.trim()) names.add(model.name.trim());
    grouped.set(canonical, names);
  }
  return [...grouped.entries()].sort(([left], [right]) => codePointCompare(left, right)).map(([canonical, names]) => {
    const sortedNames = [...names].sort(codePointCompare);
    const displayName = sortedNames[0];
    return {
      id: canonical,
      label: displayName && displayName !== canonical ? `${displayName} · ${canonical}` : canonical,
      searchText: [canonical, canonical.split('/')[0], canonical.split('/').slice(1).join('/'), ...sortedNames].join(' '),
    };
  });
}

export function buildModelChoiceScreen(params: {
  settings: UltraSettings;
  catalog: readonly CatalogEntry[];
  scope?: UltraMenuScope;
}): ChoiceScreen<UltraActionId> {
  const scope = params.scope ?? 'session';
  const available = new Set(params.catalog.map((entry) => entry.id));
  const saved = params.settings.workerModel;
  return {
    kind: 'choice',
    title: `Worker model${scopeSuffix(scope)}`,
    lines: [`Uniform routing pins every role lane to this one model${scope === 'global' ? ' for every inheriting session' : ''}.`],
    items: [
      { id: 'automatic', label: 'Automatic', description: 'Resolve one model, then pin it for the complete wave', searchText: 'automatic default' },
      ...params.catalog.map((entry) => ({ id: entry.id, label: entry.label, searchText: entry.searchText })),
      ...(saved && !available.has(saved) ? [{ id: saved, label: saved, disabled: true, disabledReason: 'Not available', details: ['Previously selected canonical model is unavailable.'] }] : []),
    ],
    action: scopedAction(scope, 'set-model'),
    currentItemId: saved ?? 'automatic',
    initialItemId: saved && available.has(saved) ? saved : 'automatic',
    enableSearch: true,
    viewportSize: 10,
    hint: 'back',
  };
}

export function buildLaneRangeScreen(settings: UltraSettings, scope: UltraMenuScope = 'session'): ChoiceScreen<UltraActionId> {
  const preset = presetFor(settings);
  return {
    kind: 'choice',
    title: `Lane range${scopeSuffix(scope)}`,
    lines: ['Hard inclusive bounds for each admitted wave.'],
    items: [
      ...PRESETS.map((item) => ({ id: item.id, label: item.label })),
      { id: 'custom', label: 'Custom…', description: 'Enter MIN-MAX within 1–8' },
    ],
    action: scopedAction(scope, 'set-lane-range'),
    currentItemId: preset?.id ?? 'custom',
    initialItemId: preset?.id ?? 'custom',
    viewportSize: 6,
    hint: 'back',
  };
}

export function parseCustomLaneRange(value: string): { minLanes: number; maxLanes: number } | undefined {
  const normalized = value.normalize('NFKC').trim().replace(/\s*[–—]\s*/gu, '-');
  const match = normalized.match(/^(\d+)\s*-\s*(\d+)$/u);
  if (!match) return undefined;
  const minLanes = Number(match[1]);
  const maxLanes = Number(match[2]);
  if (!Number.isSafeInteger(minLanes) || !Number.isSafeInteger(maxLanes) || minLanes < 1 || maxLanes > 8 || minLanes > maxLanes) return undefined;
  return { minLanes, maxLanes };
}

type ScopedUpdater = (patch: UltraSettingsPatch | UltraSettingsMutator) => Promise<ValidUltraSettingsResult>;
/** Updater already wrapped to commit its result into displayed menu state. */
type ScopedApply = (patch: UltraSettingsPatch) => Promise<MenuActionResult<UltraScreenId>>;
type LaneRangeApply = (patch: { minLanes: number; maxLanes: number }) => Promise<MenuActionResult<UltraScreenId>>;
type SettingActionId = 'set-ultra' | 'set-routing' | 'set-model' | 'set-lane-range';

/**
 * Shared correction loop for custom lane ranges: invalid drafts stay in the
 * input for correction and exactly one valid pair is applied atomically.
 */
function customLaneRangeLoop(applyPair: LaneRangeApply, ui: ShowUltraMenuOptions['ctx']['ui']): Promise<MenuActionResult<UltraScreenId>> {
  return (async () => {
    let previousDraft: string | undefined;
    while (true) {
      const draft = await ui.input(previousDraft ? 'Correct custom lane range' : 'Custom lane range', previousDraft ?? 'MIN-MAX (1–8)');
      if (draft === undefined) return { kind: 'stay' as const };
      const parsed = parseCustomLaneRange(draft);
      if (parsed) return applyPair(parsed);
      previousDraft = draft;
      ui.notify('Enter MIN-MAX with 1 <= MIN <= MAX <= 8.', 'warning');
    }
  })();
}

/**
 * The four ordinary settings handlers, parameterized by target scope so
 * session and global screens share behavior and differ only in which updater
 * runs and which chooser screen they navigate to.
 */
function scopedSettingActions(targets: ScopeTargets, apply: ScopedApply): Record<SettingActionId, MenuActionHandler<UltraMenuState, UltraScreenId, UltraMenuContext>> {
  return {
    'set-ultra': (ctx) => apply({ enabled: ctx.value === 'Enabled' }),
    'set-routing': (ctx) => {
      if (ctx.value === ROUTING_UNIFORM_LABEL) return apply({ routingMode: 'uniform' });
      if (ctx.value === ROUTING_ROLE_DEFAULTS_LABEL) return apply({ routingMode: 'role-defaults' });
      return { kind: 'rejected', error: 'Invalid routing mode.' };
    },
    'set-model': (ctx) => {
      if (ctx.itemId === 'worker-model') return { kind: 'to', screen: targets.modelSelect };
      return apply(ctx.itemId === 'automatic' ? { workerModel: undefined } : { workerModel: ctx.itemId });
    },
    'set-lane-range': (ctx) => {
      if (ctx.itemId === 'lane-range') return { kind: 'to', screen: targets.laneRange };
      const preset = PRESETS.find((item) => item.id === ctx.itemId);
      if (preset) return apply({ minLanes: preset.minLanes, maxLanes: preset.maxLanes });
      if (ctx.itemId !== 'custom') return { kind: 'rejected', error: 'Invalid lane range selection.' };
      return customLaneRangeLoop(apply, ctx.ctx.ui);
    },
  };
}

export async function showUltraMenu(options: ShowUltraMenuOptions): Promise<RunMenuResult> {
  let current = options.state;
  let sessionOverridesPresent = options.hasSessionOverrides;
  const catalog = buildModelCatalog(options.ctx.modelRegistry.getAvailable());
  const availableIds = catalog.map((entry) => entry.id);

  const requireSettings = (): UltraSettings => {
    if (!isValidState(current)) throw new Error('Ultra configuration is blocked.');
    return current.settings;
  };

  // Commits any updater result into the displayed state; committed cleanup
  // errors keep the committed value visible instead of rolling back.
  const commitUpdaterResult = async (pending: Promise<ValidUltraSettingsResult>): Promise<MenuActionResult<UltraScreenId>> => {
    try {
      current = await pending;
      return { kind: 'stay' as const };
    } catch (error) {
      if (error instanceof UltraSettingsCleanupError) {
        current = error.committed;
        options.ctx.ui.notify(error.message, 'warning');
        return { kind: 'stay' as const };
      }
      return { kind: 'rejected' as const, error };
    }
  };

  const applySession: ScopedUpdater = (patch) => options.updateSession(patch);
  const applyGlobal: ScopedUpdater = (patch) => options.updateGlobal(patch);

  const screens: Record<UltraScreenId, MenuScreenFactory<UltraMenuState, UltraScreenId, UltraActionId>> = {
    main: () => isValidState(current)
      ? buildMainMenu(current.settings, { hasSessionOverrides: sessionOverridesPresent })
      : buildBlockedMenu(current),
    settings: () => buildSettingsScreen(requireSettings(), availableIds, 'session'),
    'global-settings': () => buildSettingsScreen(requireSettings(), availableIds, 'global'),
    help: () => ({ kind: 'detail', title: 'Ultra Help', lines: HELP_LINES, hint: 'back' }),
    'model-select': () => buildModelChoiceScreen({ settings: requireSettings(), catalog, scope: 'session' }),
    'global-model-select': () => buildModelChoiceScreen({ settings: requireSettings(), catalog, scope: 'global' }),
    'lane-range': () => buildLaneRangeScreen(requireSettings(), 'session'),
    'global-lane-range': () => buildLaneRangeScreen(requireSettings(), 'global'),
  };

  const sessionActions = scopedSettingActions(SESSION_TARGETS, (patch) => commitUpdaterResult(applySession(patch)));
  const globalActions = scopedSettingActions(GLOBAL_TARGETS, (patch) => commitUpdaterResult(applyGlobal(patch)));

  const actions: Record<UltraActionId, MenuActionHandler<UltraMenuState, UltraScreenId, UltraMenuContext>> = {
    ...sessionActions,
    'enable-ultra': () => commitUpdaterResult(applySession({ enabled: true })),
    'disable-ultra': () => commitUpdaterResult(applySession({ enabled: false })),
    'set-ultra-global': globalActions['set-ultra'],
    'set-routing-global': globalActions['set-routing'],
    'set-model-global': globalActions['set-model'],
    'set-lane-range-global': globalActions['set-lane-range'],
    'reset-session': () => commitUpdaterResult(options.resetSession().then((result) => {
      sessionOverridesPresent = false;
      return result;
    })),
    'recover-config': async () => {
      const confirmed = await options.ctx.ui.confirm('Recover Ultra configuration?', 'The exact invalid file will be backed up, then Ultra will reset to disabled defaults.');
      if (!confirmed) return { kind: 'stay' };
      try {
        const recovered = await options.recover();
        current = recovered.committed;
        options.ctx.ui.notify(`Ultra configuration backed up to ${recovered.backupPath} and reset disabled.`, 'info');
        return { kind: 'stay' };
      } catch (error) {
        if (error instanceof UltraSettingsCleanupError) {
          current = error.committed;
          options.ctx.ui.notify(`${error.message}${error.backupPath ? ` Backup: ${error.backupPath}` : ''}`, 'warning');
          return { kind: 'stay' };
        }
        return { kind: 'rejected', error };
      }
    },
  };

  const definition = defineMenu<UltraMenuState, UltraScreenId, UltraActionId, UltraMenuContext>({ start: 'main', screens, actions });
  const menuOptions: RunMenuOptions<UltraMenuState, UltraMenuContext> = { getState: () => ({ state: current }), signal: options.signal };
  return runMenu(options.ctx, definition, menuOptions);
}
