# Ultra menu and passive delegation design

## Purpose

Turn `pi-ultra` from a prompt-only package into a Pi extension with a Goal-style `/ultra` control menu. The extension makes Ultra state, subagent-routing policy, and lane bounds persistent and visible while preserving delegation only for real independent work.

## Decisions

- Configuration is global, stored at `~/.pi/agent/pi-ultra.json`.
- A single selected **Ultra worker model** is scoped to Ultra. It does not alter ordinary `pi-subagents` defaults.
- Routing has two modes:
  - **One model for every lane:** the selected Ultra worker model is used for every Ultra lane.
  - **Role defaults:** configured specialist agents retain their own model bindings.
- Lane bounds are inclusive integers from 1 through 8. Defaults are `minLanes: 2` and `maxLanes: 4`.
- The lower bound is an eligibility threshold, not a requirement to manufacture parallel work. If a task lacks enough genuine independent seams, Ultra remains dormant or the main manager handles it directly.
- Ultra is passive when enabled: normal coding requests receive a delegation-first Ultra policy automatically. It remains dormant for greetings, ordinary questions, deterministic tiny edits, and control commands.
- `/ultra <task>` explicitly requests Ultra execution. It is rejected when Ultra is disabled; there is no silent fallback to a normal prompt.

## Command contract

| Command | Behavior |
|---|---|
| `/ultra` | Opens the interactive control menu in TUI mode; displays status/help in non-TUI modes. |
| `/ultra on` | Enables Ultra globally. |
| `/ultra off` | Disables Ultra globally. |
| `/ultra toggle` | Flips the global enabled state. |
| `/ultra help` | Shows command and policy help. |
| `/ultra <task>` | Runs the explicit Ultra workflow only when enabled. |

The menu remains available while disabled so the user can re-enable Ultra or adjust settings.

## Persistent configuration

`~/.pi/agent/pi-ultra.json` has a versioned schema:

```json
{
  "version": 1,
  "enabled": true,
  "routingMode": "uniform",
  "workerModel": "openrouter/stealth/ox-alpha",
  "minLanes": 2,
  "maxLanes": 4
}
```

`workerModel` may be omitted to select **Automatic**, which restores Ultra's normal model-choice policy. Writes are atomic. An invalid or unreadable configuration is reported without overwriting the file; built-in defaults remain effective for that session.

## User interface

The package will use the same menu toolkit and interaction pattern as `/goal`.

### Main menu

The header shows:

- whether Ultra is enabled and whether passive delegation is armed;
- routing mode and selected model or `Automatic`;
- minimum and maximum lane counts.

Actions:

1. Enable Ultra or Disable Ultra
2. Settings…
3. Help
4. Close

### Settings

Settings expose:

- enable/disable toggle;
- routing mode: **One model for every lane** or **Role defaults**;
- Ultra worker model picker;
- minimum subagents;
- maximum subagents.

The model picker is populated from Pi's current model registry and includes an **Automatic** option. A saved model missing from the active registry is displayed as unavailable and is never substituted silently.

## Execution model

### Explicit `/ultra <task>`

The extension checks that Ultra is enabled, reads the configuration, injects the Ultra manager instructions from `prompts/ultra.md`, and applies the configured routing and lane policy to the resulting launch plan.

### Passive mode

On normal user prompts, `before_agent_start` injects concise Ultra operating policy when enabled. The manager is instructed to prefer bounded delegation for codebase reconnaissance, implementation, debugging, tests, and review. It does not create idle child processes: the fleet is logical and ready, not token-consuming, until a task warrants a lane.

Slash commands, menu/settings actions, simple conversation, and clearly trivial deterministic work bypass the passive policy.

### Policy enforcement

The extension-owned Ultra launch path validates the lane plan against `minLanes` and `maxLanes`, applies the selected routing mode, and routes workers through pi-subagents' public extension API. In uniform mode it creates or reuses an Ultra worker binding pinned to `workerModel`; in role-default mode it launches specialist roles with their configured bindings. The task planner decides whether independent seams exist; the extension enforces the resulting policy rather than inventing work.

## Package layout

- `extensions/ultra.ts`: command registration, passive-policy hook, status indicator, and launch coordination.
- `extensions/ultra-config.ts`: schema validation, load/save, defaults, and atomic writes.
- `extensions/ultra-menu.ts`: Goal-style menu, settings, and model selection screens.
- `prompts/ultra.md`: manager instructions shared by explicit and passive paths.
- `package.json`: declares the extension and required runtime menu dependency.

## Failure handling

- Invalid configuration: retain safe in-memory defaults and show the file path and validation error.
- Invalid range: reject the edit before persistence with a clear `min ≤ max` explanation.
- Missing selected model: mark it unavailable; require an explicit replacement or Automatic.
- Ultra disabled: reject explicit task execution and point to `/ultra on` or the menu.
- Too few independent seams: do not launch a fake wave.
- Menu unavailable outside TUI: provide status/help and preserve direct commands.

## Validation plan

1. Unit tests for config defaults, malformed files, atomic-save behavior, model selection, and lane-bound validation.
2. Smoke test extension discovery/loading and the direct `/ultra`, `on`, `off`, `toggle`, and `help` paths.
3. Verify passive policy injection applies to eligible ordinary messages and skips command/control/trivial paths.
4. Verify uniform routing produces the selected worker binding and role-default routing preserves specialist bindings.
5. Update README with installation, menu behavior, configuration, passive-mode semantics, and logical-versus-live fleet behavior.
