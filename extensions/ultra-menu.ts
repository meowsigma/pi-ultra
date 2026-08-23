import { defineMenu, runMenu } from '@narumitw/pi-tui-kit';
import type {
  ActionsScreen,
  ChoiceScreen,
  MenuActionContext,
  MenuActionHandler,
  MenuScreenFactory,
  RunMenuOptions,
  RunMenuResult,
  SettingsScreen,
} from '@narumitw/pi-tui-kit';
import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import type {
  InvalidUltraSettingsResult,
  LoadUltraSettingsResult,
  UltraSettings,
  UltraSettingsMutator,
  UltraSettingsPatch,
  ValidUltraSettingsResult,
} from './ultra-config.js';

export type UltraScreenId = 'main' | 'settings' | 'help' | 'model-select' | 'lane-range';
export type UltraActionId =
  | 'enable-ultra' | 'disable-ultra' | 'set-ultra' | 'set-routing' | 'set-model'
  | 'set-lane-range' | 'recover-config';

export type UltraMenuContext = Pick<ExtensionCommandContext, 'mode' | 'hasUI' | 'model' | 'scopedModels'> & {
  ui: Pick<ExtensionCommandContext['ui'], 'custom' | 'input' | 'select' | 'confirm' | 'notify'>;
  modelRegistry: Pick<ExtensionCommandContext['modelRegistry'], 'getAvailable'>;
};

export interface ShowUltraMenuOptions {
  ctx: UltraMenuContext;
  state: LoadUltraSettingsResult;
  update(patch: UltraSettingsPatch | UltraSettingsMutator): Promise<ValidUltraSettingsResult>;
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
] as const;

const PRESETS = [
  { id: 'small', label: 'Small — 1–2', minLanes: 1, maxLanes: 2 },
  { id: 'balanced', label: 'Balanced — 2–4', minLanes: 2, maxLanes: 4 },
  { id: 'large', label: 'Large — 4–8', minLanes: 4, maxLanes: 8 },
] as const;

function isValidState(state: LoadUltraSettingsResult): state is ValidUltraSettingsResult {
  return state.kind !== 'invalid';
}

function routingLabel(mode: UltraSettings['routingMode']): string {
  return mode === 'uniform' ? 'One model for every lane' : 'Role defaults';
}

function presetFor(settings: UltraSettings): (typeof PRESETS)[number] | undefined {
  return PRESETS.find((preset) => preset.minLanes === settings.minLanes && preset.maxLanes === settings.maxLanes);
}

export function laneRangeLabel(settings: UltraSettings): string {
  const preset = presetFor(settings);
  return preset ? `${preset.label.split(' — ')[0]} · ${settings.minLanes}–${settings.maxLanes}` : `Custom · ${settings.minLanes}–${settings.maxLanes}`;
}

export function buildMainMenu(settings: UltraSettings): ActionsScreen<UltraScreenId, UltraActionId> {
  const model = settings.routingMode === 'role-defaults' ? 'Role defaults' : settings.workerModel ?? 'Automatic';
  return {
    kind: 'actions',
    title: 'Ultra Control',
    lines: [
      `Ultra: ${settings.enabled ? 'Enabled' : 'Disabled'}`,
      `Routing: ${routingLabel(settings.routingMode)}`,
      `Model: ${model}`,
      `Lane range: ${laneRangeLabel(settings)}`,
    ],
    items: [
      settings.enabled
        ? { id: 'disable-ultra', label: 'Disable Ultra', action: 'disable-ultra' }
        : { id: 'enable-ultra', label: 'Enable Ultra', action: 'enable-ultra' },
      { id: 'settings', label: 'Settings…', to: 'settings' },
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

export function buildSettingsScreen(settings: UltraSettings, availableIds: readonly string[]): SettingsScreen<UltraActionId> {
  const unavailable = settings.workerModel !== undefined && !availableIds.includes(settings.workerModel);
  return {
    kind: 'settings',
    title: 'Ultra Settings',
    items: [
      { id: 'ultra', label: 'Ultra', currentValue: settings.enabled ? 'Enabled' : 'Disabled', values: ['Enabled', 'Disabled'], action: 'set-ultra' },
      { id: 'routing-mode', label: 'Routing mode', currentValue: routingLabel(settings.routingMode), values: ['One model for every lane', 'Role defaults'], action: 'set-routing' },
      {
        id: 'worker-model', label: 'Worker model', currentValue: settings.workerModel ?? 'Automatic', values: [settings.workerModel ?? 'Automatic', 'Choose…'], action: 'set-model',
        description: unavailable ? 'Saved model is unavailable; used only by uniform routing' : 'Used only by uniform routing',
      },
      { id: 'lane-range', label: 'Lane range', currentValue: laneRangeLabel(settings), values: [laneRangeLabel(settings), 'Choose…'], action: 'set-lane-range', description: 'Hard per-wave eligibility bounds' },
    ],
  };
}

interface CatalogEntry {
  id: string;
  label: string;
  searchText: string;
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
  return [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([canonical, names]) => {
    const sortedNames = [...names].sort((left, right) => left.localeCompare(right));
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
}): ChoiceScreen<UltraActionId> {
  const available = new Set(params.catalog.map((entry) => entry.id));
  const saved = params.settings.workerModel;
  return {
    kind: 'choice',
    title: 'Worker model',
    lines: ['Uniform routing pins every role lane to this one model.'],
    items: [
      { id: 'automatic', label: 'Automatic', description: 'Resolve one model, then pin it for the complete wave', searchText: 'automatic default' },
      ...params.catalog.map((entry) => ({ id: entry.id, label: entry.label, searchText: entry.searchText })),
      ...(saved && !available.has(saved) ? [{ id: saved, label: saved, disabled: true, disabledReason: 'Not available', details: ['Previously selected canonical model is unavailable.'] }] : []),
    ],
    action: 'set-model',
    currentItemId: saved ?? 'automatic',
    initialItemId: saved && available.has(saved) ? saved : 'automatic',
    enableSearch: true,
    viewportSize: 10,
    hint: 'back',
  };
}

export function buildLaneRangeScreen(settings: UltraSettings): ChoiceScreen<UltraActionId> {
  const preset = presetFor(settings);
  return {
    kind: 'choice',
    title: 'Lane range',
    lines: ['Hard inclusive bounds for each admitted wave.'],
    items: [
      ...PRESETS.map((item) => ({ id: item.id, label: item.label })),
      { id: 'custom', label: 'Custom…', description: 'Enter MIN-MAX within 1–8' },
    ],
    action: 'set-lane-range',
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

export async function showUltraMenu(options: ShowUltraMenuOptions): Promise<RunMenuResult> {
  let current = options.state;
  const catalog = buildModelCatalog(options.ctx.modelRegistry.getAvailable());
  const availableIds = catalog.map((entry) => entry.id);
  type State = { state: LoadUltraSettingsResult };

  const requireSettings = (): UltraSettings => {
    if (!isValidState(current)) throw new Error('Ultra configuration is blocked.');
    return current.settings;
  };

  const apply = async (patch: UltraSettingsPatch | UltraSettingsMutator) => {
    try {
      current = await options.update(patch);
      return { kind: 'stay' as const };
    } catch (error) {
      return { kind: 'rejected' as const, error };
    }
  };

  const screens: Record<UltraScreenId, MenuScreenFactory<State, UltraScreenId, UltraActionId>> = {
    main: () => isValidState(current) ? buildMainMenu(current.settings) : buildBlockedMenu(current),
    settings: () => buildSettingsScreen(requireSettings(), availableIds),
    help: () => ({ kind: 'detail', title: 'Ultra Help', lines: HELP_LINES, hint: 'back' }),
    'model-select': () => buildModelChoiceScreen({ settings: requireSettings(), catalog }),
    'lane-range': () => buildLaneRangeScreen(requireSettings()),
  };

  const actions: Record<UltraActionId, MenuActionHandler<State, UltraScreenId, UltraMenuContext>> = {
    'enable-ultra': () => apply({ enabled: true }),
    'disable-ultra': () => apply({ enabled: false }),
    'set-ultra': (ctx) => apply({ enabled: ctx.value === 'Enabled' }),
    'set-routing': (ctx) => {
      if (ctx.value === 'One model for every lane') return apply({ routingMode: 'uniform' });
      if (ctx.value === 'Role defaults') return apply({ routingMode: 'role-defaults' });
      return { kind: 'rejected', error: 'Invalid routing mode.' };
    },
    'set-model': (ctx) => {
      if (ctx.itemId === 'worker-model') return { kind: 'to', screen: 'model-select' };
      return apply(ctx.itemId === 'automatic' ? { workerModel: undefined } : { workerModel: ctx.itemId });
    },
    'set-lane-range': (ctx: MenuActionContext<State, UltraMenuContext>) => {
      if (ctx.itemId === 'lane-range') return { kind: 'to', screen: 'lane-range' };
      const preset = PRESETS.find((item) => item.id === ctx.itemId);
      if (preset) return apply({ minLanes: preset.minLanes, maxLanes: preset.maxLanes });
      if (ctx.itemId !== 'custom') return { kind: 'rejected', error: 'Invalid lane range selection.' };
      return (async () => {
        const draft = await options.ctx.ui.input('Custom lane range', 'MIN-MAX (1–8)');
        if (draft === undefined) return { kind: 'stay' as const };
        const parsed = parseCustomLaneRange(draft);
        if (!parsed) return { kind: 'rejected' as const, error: 'Enter MIN-MAX with 1 <= MIN <= MAX <= 8.' };
        return apply(parsed);
      })();
    },
    'recover-config': async () => {
      const confirmed = await options.ctx.ui.confirm('Recover Ultra configuration?', 'The exact invalid file will be backed up, then Ultra will reset to disabled defaults.');
      if (!confirmed) return { kind: 'stay' };
      try {
        const recovered = await options.recover();
        current = recovered.committed;
        options.ctx.ui.notify(`Ultra configuration backed up to ${recovered.backupPath} and reset disabled.`, 'info');
        return { kind: 'stay' };
      } catch (error) {
        return { kind: 'rejected', error };
      }
    },
  };

  const definition = defineMenu<State, UltraScreenId, UltraActionId, UltraMenuContext>({ start: 'main', screens, actions });
  const menuOptions: RunMenuOptions<State, UltraMenuContext> = { getState: () => ({ state: current }), signal: options.signal };
  return runMenu(options.ctx, definition, menuOptions);
}
