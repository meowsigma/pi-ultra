# Ultra session overrides design

**Status:** Approved for planning

## Objective

Make Ultra configuration independent per Pi session without losing a safe, inspectable global baseline. Normal `/ultra` changes apply to the current session and persist across reload and session resume. Global defaults remain available only through an explicit UI action.

## Scope

The configurable fields are `enabled`, `routingMode`, `workerModel`, `minLanes`, and `maxLanes`. Existing global storage remains `~/.pi/agent/pi-ultra.json`.

No change is made to authority ownership, permits, lane admission, operation storage, or the rule that the active main model manages Ultra waves.

## Settings model

### Global defaults

`~/.pi/agent/pi-ultra.json` remains the single transactional, lock-protected source for global defaults. It supplies the initial values for new sessions and every field not overridden by a session.

### Session override patch

Each Pi session stores an Ultra-owned override snapshot as a non-model-visible Pi custom entry. The latest valid snapshot in that session’s branch is authoritative. The patch contains only fields explicitly changed in that session. It is schema-validated on write and restore. It is persisted with the Pi session, so it survives `/reload`, process restart, and opening the same session again.

The patch must never contain partial lane bounds: `minLanes` and `maxLanes` are recorded and removed atomically. A uniform `workerModel` is validated as a provider-qualified ID; it is absent for Automatic. Unknown fields and invalid patch values are rejected rather than silently normalized.

### Effective settings

The effective settings for a session are calculated as:

```
effective = normalize(global defaults overlaid by valid session patch)
```

A session patch overrides only fields it declares. A global change updates every session that inherits the changed field, but does not overwrite explicitly overridden session fields.

## User experience

`/ultra` remains the TUI menu.

- Ordinary menu edits write the current session patch, never the global file.
- The menu displays the scope of every setting: **Session override** or **Global default**.
- It shows the current effective state and whether the session has any overrides.
- **Reset this session to global defaults** removes the patch, then immediately recalculates and applies effective policy.
- **Global defaults…** enters a clearly labelled explicit sub-menu. Edits there retain the existing global transactional settings semantics and update inheriting sessions.
- `/ultra on`, `/ultra off`, and `/ultra toggle` are session-local, matching ordinary menu edits.
- `/ultra <task>` and `ultra_delegate` always use the effective settings for the active session.

Non-TUI command behavior remains clear: `/ultra on|off|toggle|help` works; bare `/ultra` still reports that it requires TUI mode.

## Failure and safety behavior

Global settings retain their current fail-closed contract. If the global settings file is invalid or unreadable, Ultra is blocked in every session, even one with a persisted override. This avoids allowing a stale per-session patch to bypass an explicit global safety/recovery incident.

An invalid or schema-invalid session snapshot is ignored and a diagnostic custom entry is appended; the session falls back to valid global defaults. It must never result in an accidental permissive policy. If cleanup/persistence fails after a committed session change, the UI refreshes from the committed state and surfaces the error, mirroring global cleanup handling.

On a global watcher event, each session recomputes effective settings and atomically swaps its policy in the existing fail-closed order. On session-patch changes, only that session performs the same policy transition. Lifecycle-generation fencing continues to prevent stale preflight or launch continuations from crossing policy changes.

## Persistence API

Introduce a small session-settings adapter behind the extension runtime so it can be tested independently of Pi’s custom-entry journal API:

- `restoreSessionUltraOverrides(branch)` scans the session branch and returns the latest valid snapshot.
- `appendSessionUltraOverrides(patch)` appends an immutable override snapshot.
- `clearSessionUltraOverrides()` appends an explicit cleared snapshot.
- `resolveEffectiveUltraSettings(global, patch)` computes the fully normalized effective value.

The adapter serializes writes for one session and returns a monotonic revision or content digest used by the policy refresh path. Global configuration APIs remain unchanged except for accepting a session-effective value at consumers.

## Testing

Add focused tests for:

1. Two sessions beginning at identical global defaults, then changing model, bounds, and enabled state independently.
2. `/reload` and resumed-session restoration of an override.
3. Global updates changing inherited fields but preserving overridden fields.
4. Reset restoring all inherited defaults, including atomic lane bounds.
5. Explicit global menu mutation being visible to an inheriting session and not to an overridden field.
6. Invalid global configuration blocking every session, including overridden sessions.
7. Invalid/corrupt session patch recovery without permissive launch and with preserved diagnostic evidence.
8. Effective settings being used by delegate validation, model selection, and permit policy refresh.
9. Existing global config, lifecycle fencing, and authority tests remaining green.

## Acceptance criteria

- Two simultaneously active sessions can use different enabled states, models, routing modes, and lane ranges.
- The default UI action is session-local.
- Session choices survive reload and resume.
- Global defaults remain explicit and transactional.
- No session override bypasses invalid-global fail-closed behavior.
- Existing one-use permit and exact preflight rules continue to operate on each session’s effective settings.
