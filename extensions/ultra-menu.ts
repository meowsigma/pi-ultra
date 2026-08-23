// ── Ultra control menu — pure data build functions and TUI adapter ──

import {
  defineMenu,
  runMenu,
} from '@narumitw/pi-tui-kit';
import type {
  ActionsScreen,
  ChoiceScreen,
  MenuActionHandler,
  MenuDefinition,
  MenuScreenFactory,
  RunMenuOptions,
  RunMenuResult,
  SettingsScreen,
  MenuActionContext,
} from '@narumitw/pi-tui-kit';
import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import {
  ULTRA_MAX_LANES,
  ULTRA_MIN_LANES,
  effectiveUniformModel,
  normalizeUltraSettings,
} from './ultra-config.js';
import type { UltraSettings } from './ultra-config.js';

// ── Constants ─────────────────────────────────────────────────────

const LANE_OPTIONS: readonly string[] = (() => {
  const opts: string[] = [];
  for (let i = ULTRA_MIN_LANES; i <= ULTRA_MAX_LANES; i++) {
    opts.push(String(i));
  }
  return opts;
})();

// ── Exported types ────────────────────────────────────────────────

export type UltraScreenId = 'main' | 'settings' | 'help' | 'model-select';
export type UltraActionId =
  | 'enable-ultra'
  | 'disable-ultra'
  | 'set-ultra'
  | 'set-routing'
  | 'set-model'
  | 'set-min-lanes'
  | 'set-max-lanes';

/**
 * Input context for showUltraMenu.
 * Covers the ExtensionCommandContext subset needed to render the menu
 * and resolve available models.
 */
export interface UltraMenuContext {
  mode: ExtensionCommandContext['mode'];
  hasUI: boolean;
  ui: Record<string, unknown>;
  scopedModels?: readonly { id: string; name?: string }[];
  modelRegistry?: { getAvailable(): readonly { id: string; name?: string }[] };
  signal?: AbortSignal;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

export interface ShowUltraMenuOptions {
  /** The Pi extension context (or compatible subset). */
  ctx: UltraMenuContext;
  /** Current ultra settings. */
  settings: UltraSettings;
  /**
   * Async save function called exactly once after every successful
   * setting change that passes normalizeUltraSettings. Throwing from
   * this function signals a save failure — in-memory state is not
   * corrupted because the caller retains the previous settings.
   */
  save(settings: UltraSettings): Promise<void>;
  /** Optional abort signal. */
  signal?: AbortSignal;
}

// ── Help text ─────────────────────────────────────────────────────

const HELP_LINES: readonly string[] = [
  'Ultra Control — manage parallel subagent wave execution.',
  '',
  'Enable Ultra to delegate bounded work to parallel lanes of',
  'worker agents. Each lane has a role (scout, worker, or',
  'reviewer) with corresponding authority.',
  '',
  'Routing modes:',
  '\u2022 One model for every lane — all lanes use the same model',
  '\u2022 Role defaults — each role uses its configured default model',
  '',
  'Lanes: Minimum to maximum subagents deployed per wave.',
  'Min 1, max 8.',
  '',
  'Settings persist in pi-ultra.json.',
];

// ── Routing label helpers ─────────────────────────────────────────

function routingLabel(mode: 'uniform' | 'role-defaults'): string {
  return mode === 'uniform' ? 'One model for every lane' : 'Role defaults';
}

function routingValue(label: string): 'uniform' | 'role-defaults' | undefined {
  if (label === 'One model for every lane') return 'uniform';
  if (label === 'Role defaults') return 'role-defaults';
  return undefined;
}

// ── Pure screen builders ──────────────────────────────────────────

/**
 * Build the main actions screen.
 *
 * Lines show:
 *   Enabled: yes|no
 *   Routing: <label>
 *   Model: <model name> | Automatic | –
 *   Lanes: <min>–<max>
 */
export function buildMainMenu(settings: UltraSettings): ActionsScreen<UltraScreenId, UltraActionId> {
  const enabledText = settings.enabled ? 'yes' : 'no';
  const routeLabel = routingLabel(settings.routingMode);
  const effective = effectiveUniformModel(settings);
  const modelLabel = settings.routingMode === 'role-defaults' ? '\u2013' : (effective ?? 'Automatic');
  const lanesLabel = `Lanes: ${settings.minLanes}\u2013${settings.maxLanes}`;

  // Build with spread to avoid readonly-array mutation
  const enableDisable: ActionsScreen<UltraScreenId, UltraActionId>['items'] = settings.enabled
    ? [{ id: 'disable-ultra', label: 'Disable Ultra', action: 'disable-ultra' }]
    : [{ id: 'enable-ultra', label: 'Enable Ultra', action: 'enable-ultra' }];

  const items: ActionsScreen<UltraScreenId, UltraActionId>['items'] = [
    ...enableDisable,
    { id: 'settings', label: 'Settings\u2026', to: 'settings' },
    { id: 'help', label: 'Help', to: 'help' },
    { id: 'close', label: 'Close', close: true },
  ];

  return {
    kind: 'actions',
    title: 'Ultra Control',
    lines: [
      `Enabled: ${enabledText}`,
      `Routing: ${routeLabel}`,
      `Model: ${modelLabel}`,
      lanesLabel,
    ],
    items,
    hint: 'close',
  };
}

/**
 * Build the settings screen.
 *
 * Items: Ultra (enabled toggle), Routing mode, Worker model,
 * Minimum subagents, Maximum subagents.
 *
 * The Worker model item does NOT carry values — model selection
 * uses a dedicated ChoiceScreen (buildModelChoiceScreen).
 *
 * @param params.settings – current UltraSettings
 * @param params.availableModels – optional list of model IDs from
 *   ctx.scopedModels or ctx.modelRegistry.getAvailable().
 *   When provided, the Worker model item is disabled if the saved
 *   model is not in this list.
 */
export function buildSettingsScreen(params: {
  settings: UltraSettings;
  availableModels?: readonly string[];
}): SettingsScreen<UltraActionId> {
  const { settings, availableModels } = params;

  const savedModel = settings.workerModel;
  const modelUnavailable =
    savedModel !== undefined &&
    availableModels !== undefined &&
    !availableModels.includes(savedModel);

  const items: SettingsScreen<UltraActionId>['items'] = [
    {
      id: 'ultra',
      label: 'Ultra',
      currentValue: settings.enabled ? 'Enabled' : 'Disabled',
      values: ['Enabled', 'Disabled'],
      action: 'set-ultra',
    },
    {
      id: 'routing-mode',
      label: 'Routing mode',
      currentValue: routingLabel(settings.routingMode),
      values: ['One model for every lane', 'Role defaults'],
      action: 'set-routing',
    },
    {
      id: 'worker-model',
      label: 'Worker model',
      currentValue: savedModel ?? 'Automatic',
      action: 'set-model',
      ...(modelUnavailable ? { disabled: true as const, description: 'Saved model no longer available' } : {}),
    },
    {
      id: 'min-subagents',
      label: 'Minimum subagents',
      currentValue: String(settings.minLanes),
      values: [...LANE_OPTIONS],
      action: 'set-min-lanes',
    },
    {
      id: 'max-subagents',
      label: 'Maximum subagents',
      currentValue: String(settings.maxLanes),
      values: [...LANE_OPTIONS],
      action: 'set-max-lanes',
    },
  ];

  return {
    kind: 'settings',
    title: 'Ultra Settings',
    items,
  };
}

/**
 * Build the model choice screen.
 *
 * Items: Automatic first, then available models.
 * If the saved workerModel is set and not in the available list,
 * it is appended as a disabled item with a "Not available" reason.
 */
export function buildModelChoiceScreen(params: {
  settings: UltraSettings;
  availableModels: readonly string[];
}): ChoiceScreen<UltraActionId> {
  const { settings, availableModels } = params;
  const savedModel = settings.workerModel;

  // Build items via flat arrays to avoid readonly mutation
  const modelItems: ChoiceScreen<UltraActionId>['items'] = availableModels.map((modelId) => ({
    id: modelId,
    label: modelId,
  }));

  const unavailableItem: ChoiceScreen<UltraActionId>['items'] =
    savedModel !== undefined && !availableModels.includes(savedModel)
      ? [{
          id: savedModel,
          label: savedModel,
          disabled: true,
          disabledReason: 'Not available',
          details: ['This model was previously selected but is no longer available.'],
        }]
      : [];

  const items: ChoiceScreen<UltraActionId>['items'] = [
    {
      id: 'automatic',
      label: 'Automatic',
      description: 'Let the system select the best model',
    },
    ...modelItems,
    ...unavailableItem,
  ];

  const currentItemId = savedModel ?? 'automatic';

  return {
    kind: 'choice',
    title: 'Worker model',
    items,
    action: 'set-model',
    currentItemId,
  };
}

// ── applySetting ──────────────────────────────────────────────────

/**
 * Apply a single field change to an UltraSettings object.
 *
 * Returns a complete next-settings copy (via normalizeUltraSettings)
 * or undefined if the change would produce an invalid state.
 *
 * Key behaviors:
 * - Returns a new object (does not mutate the input).
 * - Setting workerModel to 'Automatic' or undefined removes the field.
 * - String lane values are parsed as integers.
 * - Invalid values (out-of-range lanes, bad routing mode) cause
 *   undefined to be returned.
 * - The result is always a full normalized settings object.
 */
export function applySetting(
  settings: UltraSettings,
  field: string,
  value: unknown,
): UltraSettings | undefined {
  // Build the candidate object from a copy of the original settings
  const next: Record<string, unknown> = {
    version: settings.version,
    enabled: settings.enabled,
    routingMode: settings.routingMode,
    minLanes: settings.minLanes,
    maxLanes: settings.maxLanes,
  };

  if ('workerModel' in settings && settings.workerModel !== undefined) {
    next.workerModel = settings.workerModel;
  }

  // Apply the change
  if (field === 'workerModel') {
    if (value === 'Automatic' || value === undefined || value === '') {
      delete next.workerModel;
    } else if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        delete next.workerModel;
      } else {
        next.workerModel = trimmed;
      }
    } else {
      // Non-string workerModel — let normalize reject it
      next.workerModel = value;
    }
  } else if (field === 'minLanes' || field === 'maxLanes') {
    // Parse lane strings to numbers
    if (typeof value === 'string') {
      const parsed = parseInt(value, 10);
      if (Number.isNaN(parsed) || !Number.isSafeInteger(parsed)) return undefined;
      next[field] = parsed;
    } else {
      next[field] = value;
    }
  } else {
    next[field] = value;
  }

  return normalizeUltraSettings(next);
}

// ── TUI adapter ───────────────────────────────────────────────────

type MenuState = { settings: UltraSettings };

/**
 * Resolve available model IDs from the context.
 */
function resolveAvailableModels(ctx: UltraMenuContext): readonly string[] {
  if (ctx.scopedModels && ctx.scopedModels.length > 0) {
    return ctx.scopedModels.map((m) => m.id);
  }
  if (ctx.modelRegistry && typeof ctx.modelRegistry.getAvailable === 'function') {
    return ctx.modelRegistry.getAvailable().map((m: { id: string }) => m.id);
  }
  return [];
}

/**
 * Run the full Ultra control menu using the pi-tui-kit runtime.
 *
 * The menu renders in the Pi TUI or RPC adapter depending on the
 * context's mode. The supplied save function is called exactly once
 * after each successful setting change.
 *
 * On save failure, the error is surfaced but the in-memory state
 * is preserved (the caller retains its original settings).
 */
export async function showUltraMenu(
  options: ShowUltraMenuOptions,
): Promise<RunMenuResult> {
  const { ctx, settings, save, signal: externalSignal } = options;
  let currentSettings = { ...settings };

  const availableModels = resolveAvailableModels(ctx);

  // ── Screen factories ──────────────────────────────────────────

  const screens: Record<
    UltraScreenId,
    MenuScreenFactory<MenuState, UltraScreenId, UltraActionId>
  > = {
    main: () => buildMainMenu(currentSettings),
    settings: () => buildSettingsScreen({ settings: currentSettings, availableModels }),
    help: () => ({
      kind: 'detail' as const,
      title: 'Help',
      lines: [...HELP_LINES],
      hint: 'back' as const,
    }),
    'model-select': () =>
      buildModelChoiceScreen({
        settings: currentSettings,
        availableModels,
      }),
  };

  // ── Action handlers ───────────────────────────────────────────

  function settingAction(
    field: string,
    value: unknown,
  ): { kind: 'stay' } | { kind: 'rejected'; error: unknown } {
    const next = applySetting(currentSettings, field, value);
    if (next === undefined) {
      return { kind: 'rejected', error: `Invalid value for ${field}` };
    }
    // Call save once — fire and forget
    save(next).catch((err: unknown) => {
      // Save failed — in-memory state is preserved; error surfaces
      // via the runMenu onError option or as a rejected result.
      return { kind: 'rejected', error: err };
    });
    // Update in-memory state optimistically
    currentSettings = next;
    return { kind: 'stay' };
  }

  const actions: Record<
    UltraActionId,
    MenuActionHandler<MenuState, UltraScreenId, UltraMenuContext>
  > = {
    'enable-ultra': () => settingAction('enabled', true),
    'disable-ultra': () => settingAction('enabled', false),
    'set-ultra': (actCtx: MenuActionContext<MenuState, UltraMenuContext>) => {
      const enabled = actCtx.value === 'Enabled';
      return settingAction('enabled', enabled);
    },
    'set-routing': (actCtx: MenuActionContext<MenuState, UltraMenuContext>) => {
      const mode = routingValue(actCtx.value ?? '');
      if (mode === undefined) return { kind: 'rejected' as const, error: 'Invalid routing mode' };
      return settingAction('routingMode', mode);
    },
    'set-model': (actCtx: MenuActionContext<MenuState, UltraMenuContext>) => {
      // When called from the SettingsScreen Worker model item with no value,
      // navigate to the model choice screen.
      if (actCtx.value === undefined || actCtx.value === '') {
        return { kind: 'to' as const, screen: 'model-select' as const };
      }
      // When called from the model choice screen with a selected model ID:
      const modelId = actCtx.value;
      if (modelId === 'automatic') {
        return settingAction('workerModel', 'Automatic');
      }
      return settingAction('workerModel', modelId);
    },
    'set-min-lanes': (actCtx: MenuActionContext<MenuState, UltraMenuContext>) =>
      settingAction('minLanes', actCtx.value ?? ''),
    'set-max-lanes': (actCtx: MenuActionContext<MenuState, UltraMenuContext>) =>
      settingAction('maxLanes', actCtx.value ?? ''),
  };

  const definition = defineMenu<MenuState, UltraScreenId, UltraActionId, UltraMenuContext>({
    start: 'main',
    screens,
    actions,
  });

  const menuOptions: RunMenuOptions<MenuState, UltraMenuContext> = {
    getState: () => ({ settings: currentSettings }),
    signal: externalSignal,
  };

  return runMenu(ctx, definition, menuOptions);
}