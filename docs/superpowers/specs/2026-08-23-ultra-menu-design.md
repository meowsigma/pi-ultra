# Ultra menu and passive delegation design

## Purpose

Turn `pi-ultra` from a prompt-only package into a Pi extension with a Goal-style `/ultra` control menu and a passive, delegation-first execution controller. The extension owns the route from task intake to validated subagent launch; it does not rely on an LLM prompt alone to enforce lane count or model-routing policy.

## Decisions

- Configuration is global at `~/.pi/agent/pi-ultra.json`.
- Ultra is either enabled or disabled. When enabled, it is armed for eligible ordinary coding requests as well as explicit `/ultra <task>` requests.
- The **Ultra planner/orchestrator inherits the active main-session model**. The selected Ultra worker model applies only to worker lanes.
- Routing has two modes:
  - **One model for every lane:** every Ultra lane uses the selected Ultra worker model.
  - **Role defaults:** the fixed roster uses configured specialist bindings: `scout` for reconnaissance, `worker` for implementation/debugging, and `reviewer` for validation.
- Lane bounds are inclusive integers from 1 through 8. Defaults are `minLanes: 2` and `maxLanes: 4`.
- `minLanes` is an eligibility threshold, never an instruction to manufacture fake parallel work. `maxLanes` is a hard launch cap.
- A logical ready fleet is not a set of idle child processes. It costs nothing until a qualifying task produces a valid plan.

## Dependencies and compatibility

Ultra requires a compatible, separately installed and enabled `pi-subagents` extension. Installing it only as an npm dependency is insufficient because Pi must load the extension in the current process.

At startup and before a launch, Ultra waits for the `subagents:rpc:v1:ready` event and uses the advertised RPC capabilities. If pi-subagents is missing, disabled, too old, or does not advertise the required structured delegation and async workflow/RPC support, Ultra fails closed with installation/reload guidance.

The package declares compatible Pi, pi-subagents, and menu-toolkit versions, ships its extension files in the packed artifact, and tests the generated tarball instead of only the repository checkout.

## Command contract

| Command | Behavior |
|---|---|
| `/ultra` | Opens the interactive control menu in TUI mode. In print/JSON modes, returns an actionable error naming direct commands. |
| `/ultra on` | Enables Ultra globally. |
| `/ultra off` | Disables Ultra globally. |
| `/ultra toggle` | Flips the global enabled state. |
| `/ultra help` | Shows help in TUI; in non-TUI, returns a documented actionable error/output contract. |
| `/ultra <task>` | Starts the explicit Ultra controller when enabled. When disabled, rejects with instructions to enable it. |

The menu remains available while disabled. There is no silent fallback from an explicit Ultra request to an ordinary prompt.

## Persistent configuration

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

`workerModel` may be omitted for **Automatic**.

- In **uniform** mode, Automatic resolves one common usable/scoped model for the entire wave using pi-subagents' normal default-model resolution; the resolved model is recorded and verified before accepting results.
- In **role-default** mode, Automatic has no effect because each fixed role resolves through its configured binding/default.
- The picker lists session-scoped, registry-available models. Launch preflight distinguishes unavailable, unscoped, and unauthenticated selections.

Writes take an exclusive lock, re-read the current document under that lock, validate the complete schema, then atomically replace it. Every command and eligible turn reloads current configuration, so separately running Pi sessions converge on the next action. Invalid/unreadable configuration is never overwritten; safe defaults apply for that action with the file path and validation error reported.

## User interface

Ultra uses the same menu toolkit and interaction pattern as `/goal`.

### Main menu

The header shows enabled/disabled state, passive-fleet readiness, routing mode, selected model or Automatic, and lane range.

Actions:

1. Enable Ultra or Disable Ultra
2. Settings…
3. Help
4. Close

### Settings

- enable/disable toggle;
- routing mode: **One model for every lane** or **Role defaults**;
- worker-model picker, including **Automatic**;
- minimum subagents;
- maximum subagents.

Invalid bounds (`minLanes > maxLanes`) are rejected before persistence. A saved unavailable model remains visible as unavailable and is never silently substituted.

## Authoritative execution protocol

### 1. Passive eligibility gate

The extension’s `input` hook marks Ultra-owned messages and uses a deterministic, testable classifier:

- bypass empty input, extension/built-in slash commands, greetings, acknowledgements, and clearly conversational short requests;
- consider normal requests that contain a coding action or a substantive codebase/task description;
- route uncertain requests normally rather than pretending semantic classification is infallible.

The marker survives the queued handoff to prevent an explicit Ultra message or extension-injected follow-up from being planned twice. Skills, templates, RPC input, queued messages, reload, and explicit `/ultra` traffic are tested separately.

### 2. Structured planning

A bundled, read-capable `ultra-planner` package agent inherits the active main-session model. Ultra invokes it through pi-subagents’ **structured delegation API**, requiring a schema-validated plan containing bounded lane contracts, role intent, mutation intent, and rationale for independence.

The planner is the only component allowed to decide whether real independent seams exist. It does not launch workers itself.

Outcomes:

| Plan outcome | Explicit `/ultra <task>` | Passive request |
|---|---|---|
| Fewer than `minLanes` genuine lanes | Notify “no qualified wave”; hand the original task to the main manager directly. | Let the original request proceed normally. |
| `minLanes` through `maxLanes` | Validate and launch the planned wave. | Validate and launch the planned wave. |
| More than `maxLanes` | Planner must consolidate; if still over the cap, reject with an actionable planning-limit notice. | Do not launch; let the request proceed normally with an observable reason. |

### 3. Preflight and worker launch

Ultra validates every proposed lane before launch:

- count is within the configured bounds;
- lane identifiers and contracts are unique and bounded;
- required role is in the supported fixed roster;
- effective model, tool availability, capability ceiling, and worktree eligibility pass pi-subagents preflight.

For **role defaults**, planner intents map only to the fixed `scout`, `worker`, and `reviewer` roles. Missing, ambiguous, disabled, or capability-ceiling-restricted roles fail closed; no arbitrary agent name from model output is trusted.

For **uniform** mode, Ultra creates or updates one extension-owned named worker binding at a reserved user-agent path, with the chosen model and minimal required worker contract. The generated binding is preflighted and its actual resolved model is verified in returned run metadata. It is the only permitted worker agent for that wave.

After validation, Ultra invokes pi-subagents’ **async RPC `spawn`** with a generated `workflowScript`. That workflow creates lanes with fresh context and `worktree: true` for mutation-capable git lanes, preserving pi-subagents lifecycle records, run IDs, repair/resume controls, and completion correlation. Read-only lanes do not claim write authority.

### 4. Completion and final judgment

Ultra listens for the RPC completion event, reads bounded result summaries/artifact references, verifies the returned model bindings, and injects an Ultra-owned completion message into the main session. The main session audits worker outputs, validates the resulting work, and decides whether and how to integrate it. Worker completion never silently becomes acceptance.

## Prompt migration

The existing public `prompts/ultra.md` contract is replaced. It currently lets a manager parse per-request model/lane overrides, mutate ad hoc user agent files, and call the ordinary `subagent` tool directly; those behaviors conflict with extension-owned policy.

Internal prompt assets are renamed and removed from Pi prompt-template discovery. Package metadata registers one extension-owned `/ultra` command, so command discovery has exactly one intended Ultra entry. Planner prompts direct it to return the structured plan only; manager follow-up prompts direct it to audit and integrate returned evidence rather than bypass the controller.

## Package layout

- `extensions/ultra.ts`: command registration, input ownership/eligibility, readiness, planner/launch coordination, completion delivery, and status indicator.
- `extensions/ultra-config.ts`: schema, lock-aware load/save, defaults, model/bound validation.
- `extensions/ultra-menu.ts`: Goal-style menu, settings, and model-picker screens.
- `agents/ultra-planner.md`: package agent for structured planning.
- `prompts/`: internal non-exported planner and manager instruction assets.
- `package.json`: extension, pi-subagents-agent, peer/runtime dependency, and packed-file declarations.

## Failure handling

- Missing/incompatible pi-subagents: no launch; explain how to install/enable/reload.
- Invalid configuration or range: preserve the previous valid file and report the precise issue.
- Unavailable model or role: fail preflight with the resolved reason; do not substitute silently.
- Planner gives no qualified wave: follow the outcome table; never create fake workers.
- RPC failure/cancellation: preserve lifecycle artifacts, report the run ID, and offer status/repair/resume guidance.
- Non-TUI mode: do not claim a rendered menu or notification channel exists.

## Validation plan

1. Unit tests: defaults, schema migration, malformed config, locking/concurrent writes, reload semantics, range validation, and Automatic behavior in both routing modes.
2. Input-flow tests: eligibility classifier, prompt/template/skill/RPC origins, explicit command ownership, queued-message marker, duplicate-prevention, and reload.
3. Protocol tests with a pi-subagents test double: readiness failure, structured-plan schema validation, below/over/in-range plans, fixed-role restriction, uniform binding creation, preflight failure, RPC workflow construction, and completion delivery.
4. Integration tests with compatible pi-subagents: fresh/worktree lane semantics, resolved-model verification, async lifecycle/status, stop/repair/resume, and failure modes for missing roles/models/capability ceilings.
5. Package tests: `npm pack`, inspect tarball contents, install from the tarball into a clean Pi config, verify extension and only one `/ultra` command are discovered.
6. Update README with installation/prerequisites, commands, settings schema, passive eligibility semantics, controller protocol, role roster, and logical-versus-live fleet behavior.
