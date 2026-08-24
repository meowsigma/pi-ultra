# Ultra Session Overrides Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every task has an Acceptance Contract; do not mark a task complete until its Quality Gate review returns PASS.

**Goal:** Make Ultra settings session-local by default, durable across reload/resume, and safely layered over explicit global defaults.

**Architecture:** Keep the existing transactional JSON file as the global baseline. Add a session-journaled, schema-validated override patch whose latest snapshot is restored from Pi custom entries; resolve it with the global settings before all policy, UI, command, and wave decisions. Global invalidity remains a process-wide fail-closed condition.

**Tech Stack:** TypeScript, Pi Extension API custom entries/session branch, `@narumitw/pi-tui-kit`, Node test runner with `tsx`.

---

## File structure

| File | Responsibility |
|---|---|
| `extensions/ultra-session-settings.ts` | Validate, append, restore, clear, and layer per-session override snapshots. |
| `extensions/ultra-config.ts` | Export reusable field validation and resolve a complete settings object from global defaults plus an override patch. |
| `extensions/ultra.ts` | Restore session overrides, derive effective settings, apply session-local commands, and refresh authority policy from effective settings. |
| `extensions/ultra-menu.ts` | Show setting provenance and provide session-local, reset, and explicit-global menu actions. |
| `tests/ultra-session-settings.test.ts` | Unit coverage for patch invariants, append/restore, corruption, and layering. |
| `tests/ultra-input.test.ts` | Extension lifecycle coverage for independent sessions, commands, global changes, invalid global config, and effective preflight input. |
| `tests/ultra-menu.test.ts` | Menu rendering/action coverage for scope labels, reset, and explicit global-default controls. |
| `README.md` | Document global defaults vs persistent session overrides and exact user controls. |

### Task 1: Session override persistence and effective-settings resolver

**Files:**
- Create: `extensions/ultra-session-settings.ts`
- Modify: `extensions/ultra-config.ts`
- Create: `tests/ultra-session-settings.test.ts`

**Acceptance Contract:**
- User-visible behavior: An Ultra session can persist only its explicitly changed fields and restore the same effective settings after reload/resume.
- Wiring proof command: `node --import tsx --test tests/ultra-session-settings.test.ts`
- Expected output / observable behavior: TAP reports the override restore, atomic range, reset, corrupt-snapshot, and layering cases as passing.
- Test-quality proof: The restore test must build a Pi-shaped `custom` branch containing two snapshots and prove the last snapshot wins; it fails if journal parsing is disconnected.
- Regression proof command: `node --import tsx --test tests/ultra-config.test.ts`
- Failure this catches: A partial/invalid patch, global mutation by a session edit, or incorrect inheritance after resume.

- [ ] **Step 1: Write failing persistence and resolver tests.**

```ts
import {
  ULTRA_SESSION_SETTINGS_ENTRY,
  appendSessionUltraOverrides,
  clearSessionUltraOverrides,
  restoreSessionUltraOverrides,
} from '../extensions/ultra-session-settings.js';
import { resolveEffectiveUltraSettings } from '../extensions/ultra-config.js';

test('last valid session snapshot restores and only overrides declared fields', () => {
  const branch = [
    { type: 'custom', customType: ULTRA_SESSION_SETTINGS_ENTRY, data: { version: 1, patch: { enabled: false } } },
    { type: 'custom', customType: ULTRA_SESSION_SETTINGS_ENTRY, data: { version: 1, patch: { workerModel: 'openai/sol', routingMode: 'uniform' } } },
  ];
  assert.deepEqual(restoreSessionUltraOverrides(branch).patch, { workerModel: 'openai/sol', routingMode: 'uniform' });
  assert.deepEqual(resolveEffectiveUltraSettings(GLOBAL, restoreSessionUltraOverrides(branch).patch), {
    ...GLOBAL, routingMode: 'uniform', workerModel: 'openai/sol',
  });
});

test('lane bounds are patched and cleared atomically', () => {
  assert.throws(() => normalizeSessionUltraOverrides({ minLanes: 2 }), /minLanes.*maxLanes/i);
  assert.deepEqual(resolveEffectiveUltraSettings({ ...GLOBAL, workerModel: 'openai/global' }, { workerModel: null }), {
    ...GLOBAL, workerModel: undefined,
  });
  assert.deepEqual(clearSessionUltraOverrides(), { version: 1, patch: {} });
});
```

- [ ] **Step 2: Run the focused test to verify it fails.**

Run: `node --import tsx --test tests/ultra-session-settings.test.ts`

Expected: FAIL because `ultra-session-settings.ts`, `resolveEffectiveUltraSettings`, and the session snapshot contract do not exist.

- [ ] **Step 3: Implement the bounded session journal adapter and resolver.**

```ts
export const ULTRA_SESSION_SETTINGS_ENTRY = 'pi-ultra-session-settings';
export interface UltraSessionOverrides {
  enabled?: boolean;
  routingMode?: RoutingMode;
  workerModel?: string | null; // null explicitly selects Automatic; absent inherits global
  minLanes?: number;
  maxLanes?: number;
}
export interface UltraSessionOverrideSnapshot {
  version: 1;
  patch: UltraSessionOverrides;
}

export function normalizeSessionUltraOverrides(value: unknown): UltraSessionOverrides | undefined {
  // reject unknown keys; require minLanes/maxLanes together; validate a null
  // workerModel as an explicit Automatic override, otherwise normalize the
  // provider-qualified model over DEFAULT_ULTRA_SETTINGS; retain declared keys.
}

export function restoreSessionUltraOverrides(branch: unknown[]): { patch: UltraSessionOverrides; diagnostics: string[] } {
  // scan bounded custom entries in order; a valid `{ version: 1, patch }`
  // replaces the current patch; `{ version: 1, patch: {} }` is an explicit reset.
}

export function appendSessionUltraOverrides(append: (type: string, data: unknown) => void, patch: UltraSessionOverrides): void {
  append(ULTRA_SESSION_SETTINGS_ENTRY, { version: 1, patch: normalizeSessionUltraOverrides(patch) });
}

export function resolveEffectiveUltraSettings(global: UltraSettings, patch: UltraSessionOverrides): UltraSettings {
  const { workerModel, ...rest } = patch;
  const effective = normalizeUltraSettings({ ...global, ...rest, ...(workerModel === null ? { workerModel: undefined } : workerModel !== undefined ? { workerModel } : {}) });
  if (!effective) throw new Error('Invalid effective Ultra session settings.');
  return effective;
}
```

Do not put a session override on disk. `appendEntry` provides the durable session journal and keeps the data non-model-visible.

- [ ] **Step 4: Run focused tests to verify they pass.**

Run: `node --import tsx --test tests/ultra-session-settings.test.ts tests/ultra-config.test.ts`

Expected: PASS; snapshots restore deterministically and all prior global settings tests remain green.

- [ ] **Step 5: Run the Acceptance Contract proof.**

Run: `node --import tsx --test tests/ultra-session-settings.test.ts`

Expected: TAP PASS with assertions for last-valid snapshot, corrupt-entry diagnostic/fallback, atomic bounds, clear snapshot, and global-overlay behavior.

- [ ] **Step 6: Run regression proof.**

Run: `npm run typecheck && node --import tsx --test tests/ultra-config.test.ts`

Expected: both commands exit 0.

- [ ] **Step 7: Commit.**

```bash
git add extensions/ultra-config.ts extensions/ultra-session-settings.ts tests/ultra-session-settings.test.ts
git commit -m "feat: persist session-scoped ultra overrides"
```

### Task 2: Derive effective settings in the extension lifecycle and commands

**Files:**
- Modify: `extensions/ultra.ts`
- Modify: `tests/fixtures/fake-pi.ts`
- Modify: `tests/ultra-input.test.ts`

**Acceptance Contract:**
- User-visible behavior: `/ultra on`, `/ultra off`, and `/ultra toggle` alter only the current session; active policy, manager prompt, delegate bounds, and selected model use that session’s effective settings.
- Wiring proof command: `node --import tsx --test tests/ultra-input.test.ts`
- Expected output / observable behavior: Two fake sessions with one shared global source report different `Ultra:` statuses and pass different model/range arguments to `prepareWave`.
- Test-quality proof: The test invokes registered command/tool handlers through `FakePi`, not a standalone resolver, so it fails if extension wiring still reads global settings directly.
- Regression proof command: `node --import tsx --test tests/ultra-protocol.test.ts tests/ultra-operations.test.ts`
- Failure this catches: Cross-session setting leakage, stale policy after an override, or preflight using global instead of effective constraints.

- [ ] **Step 1: Write failing multi-session lifecycle tests.**

```ts
test('commands append a session-local override without changing global defaults', async () => {
  const global = loaded({ enabled: true, routingMode: 'uniform', workerModel: 'openai/global', minLanes: 2, maxLanes: 4 });
  const first = new FakePi();
  const second = new FakePi();
  first.context.sessionManager.getSessionId = () => 'one';
  second.context.sessionManager.getSessionId = () => 'two';
  createUltraExtension(depsWith(global))(first as any);
  createUltraExtension(depsWith(global))(second as any);
  await first.emit('session_start', {}, first.context);
  await second.emit('session_start', {}, second.context);
  await first.command('ultra', 'off');
  assert.equal(global.settings.enabled, true);
  assert.equal(lastSessionPatch(first).enabled, false);
  assert.equal(lastStatus(first), 'Ultra: off');
  assert.equal(lastStatus(second), 'Ultra: on');
});

test('delegate preflight receives session-effective model and lane bounds', async () => {
  // Restore a uniform sol / 4–8 snapshot, invoke `ultra_delegate`, and assert
  // deps.prepareWave receives exactly `{ workerModel: 'openai-codex/gpt-5.6-sol', minLanes: 4, maxLanes: 8 }`.
});
```

- [ ] **Step 2: Run the focused lifecycle tests to verify they fail.**

Run: `node --import tsx --test tests/ultra-input.test.ts`

Expected: FAIL because `/ultra off` currently calls global `updateSettings` and tool preflight receives `loaded.settings`.

- [ ] **Step 3: Wire one session override controller into `createUltraExtension`.**

Implement these boundaries:

```ts
let globalState: LoadUltraSettingsResult | undefined;
let sessionPatch: UltraSessionOverrides = {};
let effectiveState: LoadUltraSettingsResult | undefined;

const deriveEffective = (global: LoadUltraSettingsResult): LoadUltraSettingsResult => {
  if (global.kind === 'invalid') return global;
  return { ...global, settings: resolveEffectiveUltraSettings(global.settings, sessionPatch) };
};

const updateSession = (patchOrMutator: UltraSessionOverrides | UltraSettingsMutator) => {
  const next = resolveSessionPatch(sessionPatch, effectiveState!.settings, patchOrMutator);
  appendSessionUltraOverrides((type, data) => pi.appendEntry(type, data), next);
  sessionPatch = next;
};
```

At `session_start`, restore the override from `ctx.sessionManager.getBranch()` before `synchronize`. In `synchronize`, load the global state, fail closed if it is invalid, otherwise derive/store effective state and use its revision plus a stable patch digest in `validateRevision`. Replace every command, explicit-task gate, `before_agent_start`, `tool_call`, and `prepareWave` read of global `loaded.settings` with the derived effective state. Route `on/off/toggle` to `updateSession`, never `updateSettings`.

Extend `FakePi` to accept session ID/file/branch fixtures and expose its appended entries so reload tests can create a second instance with the first instance’s branch.

- [ ] **Step 4: Run focused lifecycle tests to verify they pass.**

Run: `node --import tsx --test tests/ultra-input.test.ts`

Expected: PASS; session-local status/model/range assertions and existing launch-authority lifecycle cases pass.

- [ ] **Step 5: Run the Acceptance Contract proof.**

Run: `node --import tsx --test tests/ultra-input.test.ts`

Expected: TAP PASS proving two sessions do not leak overrides, reload restoration works, and the delegate wiring receives the effective configuration.

- [ ] **Step 6: Run regression proof.**

Run: `npm run typecheck && node --import tsx --test tests/ultra-protocol.test.ts tests/ultra-operations.test.ts`

Expected: both commands exit 0.

- [ ] **Step 7: Commit.**

```bash
git add extensions/ultra.ts tests/fixtures/fake-pi.ts tests/ultra-input.test.ts
git commit -m "feat: apply ultra settings per session"
```

### Task 3: Add scoped menu controls and explicit global-default editing

**Files:**
- Modify: `extensions/ultra-menu.ts`
- Modify: `extensions/ultra.ts`
- Modify: `tests/ultra-menu.test.ts`
- Modify: `tests/ultra-input.test.ts`

**Acceptance Contract:**
- User-visible behavior: The menu identifies session overrides, saves ordinary edits locally, can reset them, and exposes shared-default changes only through a clearly labelled global path.
- Wiring proof command: `node --import tsx --test tests/ultra-menu.test.ts tests/ultra-input.test.ts`
- Expected output / observable behavior: Main/settings screens render `Session overrides: Active` or `None`; reset appends `{ version: 1, patch: {} }`; global action invokes only the global updater.
- Test-quality proof: Action tests execute `showUltraMenu` with recorded callbacks and assert which callback ran; labels alone are insufficient.
- Regression proof command: `node --import tsx --test tests/ultra-config.test.ts`
- Failure this catches: A visually ambiguous global write, reset that mutates global defaults, or menu state not refreshing after a scope change.

- [ ] **Step 1: Write failing menu scope/action tests.**

```ts
test('settings screen shows session provenance and reset action', () => {
  const screen = buildSettingsScreen(SETTINGS, IDS, { hasOverrides: true, scope: 'session' });
  assert.match(screen.title, /Session overrides/i);
  assert.ok(screen.items.some((item) => item.id === 'reset-session-overrides'));
});

test('ordinary menu change uses updateSession and global defaults action uses updateGlobal', async () => {
  const calls: string[] = [];
  await driveMenu({ updateSession: async () => { calls.push('session'); return STATE; }, updateGlobal: async () => { calls.push('global'); return STATE; } }, 'set-routing');
  assert.deepEqual(calls, ['session']);
  // Drive the labelled Global defaults screen/action separately and assert ['global'].
});
```

- [ ] **Step 2: Run the focused menu tests to verify they fail.**

Run: `node --import tsx --test tests/ultra-menu.test.ts`

Expected: FAIL because the current menu has one unscoped `update` callback and no reset/global actions.

- [ ] **Step 3: Implement explicit scope in the menu API and screens.**

Change `ShowUltraMenuOptions` to receive `effectiveState`, `hasSessionOverrides`, `updateSession`, `resetSession`, and `updateGlobal`. Add the screen/action IDs below:

```ts
export type UltraScreenId = 'main' | 'settings' | 'global-settings' | 'help' | 'model-select' | 'lane-range';
export type UltraActionId =
  | 'enable-ultra' | 'disable-ultra' | 'set-ultra' | 'set-routing' | 'set-model' | 'set-lane-range'
  | 'reset-session-overrides' | 'open-global-settings' | 'set-global-ultra' | 'set-global-routing'
  | 'set-global-model' | 'set-global-lane-range' | 'recover-config';
```

Put `Session overrides: Active` or `Session overrides: None` in the main screen. Label normal settings `Ultra Settings — This session`; add `Reset this session to global defaults`; add `Global defaults…`; make the global screen title `Ultra Global Defaults — All sessions`. Reuse model/range picker construction, but parameterize action IDs so global picker commits through `updateGlobal`. Preserve blocked recovery as a global-only action.

In `ultra.ts`, provide callbacks that append/reset session snapshots then synchronize, and separate callbacks that call the existing transactional global APIs then synchronize. After either callback, return the refreshed effective state, including `UltraSettingsCleanupError.committed` handling.

- [ ] **Step 4: Run focused menu tests to verify they pass.**

Run: `node --import tsx --test tests/ultra-menu.test.ts tests/ultra-input.test.ts`

Expected: PASS; all scope labels, callback routing, range/model controls, reset behavior, and existing recovery behavior pass.

- [ ] **Step 5: Run the Acceptance Contract proof.**

Run: `node --import tsx --test tests/ultra-menu.test.ts`

Expected: TAP PASS with recorded evidence that ordinary actions never call the global updater and the explicit global screen does.

- [ ] **Step 6: Run regression proof.**

Run: `npm run typecheck && node --import tsx --test tests/ultra-config.test.ts`

Expected: both commands exit 0.

- [ ] **Step 7: Commit.**

```bash
git add extensions/ultra-menu.ts extensions/ultra.ts tests/ultra-menu.test.ts tests/ultra-input.test.ts
git commit -m "feat: add scoped ultra settings controls"
```

### Task 4: Harden failure, watcher, and reload behavior

**Files:**
- Modify: `extensions/ultra.ts`
- Modify: `tests/ultra-input.test.ts`
- Modify: `tests/ultra-session-settings.test.ts`

**Acceptance Contract:**
- User-visible behavior: Invalid global configuration blocks every session despite a valid override; global changes update only inherited fields; invalid session entries fall back safely and are diagnostically recorded.
- Wiring proof command: `node --import tsx --test tests/ultra-input.test.ts tests/ultra-session-settings.test.ts`
- Expected output / observable behavior: Each affected session reports `Ultra: blocked` after invalid global input; an inheriting session receives changed global settings while an overridden field is unchanged; invalid session snapshot produces no permitted launch.
- Test-quality proof: Tests drive the watcher callback and registered `ultra_delegate`, proving policy synchronization rather than only inspecting pure values.
- Regression proof command: `npm run check && npm run smoke:packed`
- Failure this catches: Session patches bypassing global fail-closed recovery, stale inherited values after watcher events, or stale launches crossing a session settings transition.

- [ ] **Step 1: Write failing global-invalidity and inherited-watcher tests.**

```ts
test('invalid global configuration blocks an overridden session and denies delegation', async () => {
  await startWithSessionPatch({ enabled: true, routingMode: 'uniform', workerModel: 'openai/sol', minLanes: 4, maxLanes: 8 });
  currentGlobal = { kind: 'invalid', reason: 'bad json', path: '/tmp/pi-ultra.json' };
  await watcherCallback();
  assert.equal(lastStatus(pi), 'Ultra: blocked');
  assert.match(errorText(await pi.tool('ultra_delegate', INPUT)), /blocked/i);
});

test('global watcher updates inherited fields but preserves session-owned fields', async () => {
  // Session overrides workerModel only. Change global lane range and worker model,
  // drive watcher, then assert effective workerModel remains local while range changes.
});
```

- [ ] **Step 2: Run the focused hardening tests to verify they fail.**

Run: `node --import tsx --test tests/ultra-input.test.ts tests/ultra-session-settings.test.ts`

Expected: FAIL until watcher synchronization derives from global-plus-patch and invalid globals dominate overrides.

- [ ] **Step 3: Implement fail-closed and lifecycle fencing details.**

Ensure `synchronize` always installs the blocked guard before reading either source, treats `globalState.kind === 'invalid'` as blocked before `resolveEffectiveUltraSettings`, and increments/fences lifecycle generation for both global watcher and session-patch transition. Append one bounded non-model-visible diagnostic entry when restore encounters malformed override data; do not append repeatedly on every synchronization. Make `validateRevision` verify both the global revision and session-patch digest so an admitted permit cannot cross either configuration change.

- [ ] **Step 4: Run focused hardening tests to verify they pass.**

Run: `node --import tsx --test tests/ultra-input.test.ts tests/ultra-session-settings.test.ts`

Expected: PASS; blocked authority, session inheritance, reload restoration, and diagnostic behavior assertions all pass.

- [ ] **Step 5: Run the Acceptance Contract proof.**

Run: `node --import tsx --test tests/ultra-input.test.ts tests/ultra-session-settings.test.ts`

Expected: TAP PASS with real registered watcher/delegate paths proving no override escapes invalid-global blocking.

- [ ] **Step 6: Run regression proof.**

Run: `npm run check && npm run smoke:packed`

Expected: both commands exit 0; packed smoke still proves distinct API roots and denied direct launch.

- [ ] **Step 7: Commit.**

```bash
git add extensions/ultra.ts tests/ultra-input.test.ts tests/ultra-session-settings.test.ts
git commit -m "fix: fail closed across ultra session overrides"
```

### Task 5: Document, package, and perform release-level verification

**Files:**
- Modify: `README.md`
- Modify: `package.json`
- Modify: `tests/package-layout.test.ts`

**Acceptance Contract:**
- User-visible behavior: Documentation accurately tells users that ordinary changes are session-local and durable, and explains explicit global defaults/reset behavior.
- Wiring proof command: `npm run check && npm run smoke:packed && npm pack --dry-run`
- Expected output / observable behavior: All commands exit 0; pack output includes the session-settings module and README describes the scopes and fail-closed global incident behavior.
- Test-quality proof: Package-layout test asserts the session settings module is exported/included, so an unshipped persistence path fails before release.
- Regression proof command: `git diff --check && git status --short`
- Failure this catches: A release omitting the session adapter, documentation claiming per-session security semantics that are not implemented, or whitespace/untracked release pollution.

- [ ] **Step 1: Write failing package/documentation tests.**

```ts
test('package includes the durable session settings module', async () => {
  const files = await packedFileNames();
  assert.ok(files.includes('package/extensions/ultra-session-settings.ts'));
});
```

Add a README assertion only if the package test suite already reads documentation; otherwise verify README wording in the Acceptance Contract command to avoid brittle prose snapshots.

- [ ] **Step 2: Run the package test to verify it fails.**

Run: `node --import tsx --test tests/package-layout.test.ts`

Expected: FAIL until the new module is included by package files/exports as appropriate.

- [ ] **Step 3: Update package metadata and README.**

Document:

```md
### Settings scopes

`/ultra`, `/ultra on`, `/ultra off`, and `/ultra toggle` change only the current Pi session. The override is stored in that session and survives reload/resume. Use **Global defaults…** to change the baseline for new and inheriting sessions, and **Reset this session to global defaults** to remove its override.

If the global settings file is invalid, Ultra is blocked in every session until explicit backup/reset recovery; a session override does not bypass this safety state.
```

Update the version according to the repository release convention and ensure the new source file is included in the packed extension.

- [ ] **Step 4: Run package tests to verify they pass.**

Run: `node --import tsx --test tests/package-layout.test.ts`

Expected: PASS and `npm pack --dry-run` lists the session settings source.

- [ ] **Step 5: Run the Acceptance Contract proof.**

Run: `npm run check && npm run smoke:packed && npm pack --dry-run`

Expected: all commands exit 0; packed smoke output proves the packaged extension loads exactly once and still blocks unpermitted direct spawns.

- [ ] **Step 6: Run regression proof.**

Run: `git diff --check && git status --short`

Expected: no whitespace errors; only intended tracked files and deliberately ignored artifacts appear.

- [ ] **Step 7: Commit.**

```bash
git add README.md package.json tests/package-layout.test.ts
git commit -m "docs: explain session-scoped ultra configuration"
```
