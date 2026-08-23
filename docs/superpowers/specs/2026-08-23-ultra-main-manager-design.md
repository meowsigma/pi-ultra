# Ultra Main-Manager Redesign

**Date:** 2026-08-23  
**Status:** Approved design; implementation not started  
**Branch:** `feature/ultra-main-manager`

## 1. Purpose

Ultra must make the active Pi session model the manager. The main model receives the user's task, decides how to decompose it, delegates bounded work, continues working in the session, and makes the final quality decision. Ultra must not replace the main model with a foreground planner subagent.

The redesign also provides:

- a searchable worker-model picker over all authenticated models;
- Small, Balanced, Large, and Custom lane-range controls;
- delegation-first escalation with one worker repair before main-model takeover;
- executable role authority rather than prompt-only authority;
- durable, race-safe completion delivery;
- lock-safe settings updates and explicit invalid-config recovery;
- a real packed-extension load smoke test.

## 2. User-approved decisions

1. **The active session model is the manager.** Remove foreground `ultra-planner` ownership of user prompts.
2. **Delegation-first, not delegation-only.** The main model normally delegates independent implementation work, but may take hard or quality-critical work directly.
3. **Escalation:** initial worker attempt, one focused worker repair, then main-model takeover.
4. **Model catalog:** the Ultra picker searches all models returned by `ctx.modelRegistry.getAvailable()`, regardless of current session scope.
5. **Lane controls:** Small `1–2`, Balanced `2–4`, Large `4–8`, plus Custom.
6. **`/ultra` is a TUI menu.** RPC adapters remain testable, but RPC-side menu search is not a product requirement.

## 3. Audit baseline

The existing release passes typecheck and 51 tests, but the deep audit found material runtime gaps:

- foreground planning blocks the active model;
- uniform routing replaces every role with `worker` rather than changing only the model;
- read-only authority is prose while some resolved agents retain `bash`/`write`;
- separate group spawns can partially launch and then let the main model duplicate work;
- passive interception mishandles mid-stream and extension-originated input;
- completion can race receipt storage, consume paused events, disappear on reload, and omit model-visible evidence;
- missing `pi-subagents` can stall planning for 120 seconds;
- invalid configuration fails open to enabled defaults;
- settings locks protect bytes but not atomic read-modify-write semantics;
- stale lock directories are not recoverable;
- packed-file inspection does not prove the packed extension loads.

This design treats those findings as release blockers for the redesign rather than preserving the old controller.

## 4. Alternatives considered

### 4.1 Main-owned `ultra_delegate` tool — selected

The main model receives every prompt. Ultra injects a dynamic manager policy and exposes a validated tool that preflights and launches one worker workflow.

**Why selected:** preserves main-session ownership while retaining enforceable schema, routing, lane bounds, tool authority, receipts, retries, and completion auditing.

### 4.2 Prompt-only use of the normal `subagent` tool — rejected

This is simpler, but cannot reliably enforce Ultra settings, role authority, model binding, one-repair limits, durable receipts, or consistent result delivery.

### 4.3 Main model plus background planner — rejected

Parallel planning creates duplicate decomposition, concurrent ownership, conflicting edits, and unclear authority. It preserves the visible symptom rather than solving it.

## 5. Main-session execution model

### 5.1 No passive input interception

Ultra removes the ordinary `input` handler and the ownership-prefix/requeue mechanism. User prompts, steers, follow-ups, images, and extension-originated messages flow to Pi normally.

This eliminates:

- foreground planner blocking;
- message loss during streaming;
- accidental interception of another extension's messages;
- hidden duplicate work after partial launch;
- the misleading `main → ultra-planner` run in the subagent inspector.

### 5.2 Dynamic manager policy

When Ultra is enabled and configuration is valid, `before_agent_start` appends a bounded Ultra policy to the current system prompt. It must preserve the existing system prompt and state:

- the active model is manager and final reviewer;
- delegate genuinely independent work before implementing when workers are suitable;
- use `ultra_delegate` for worker waves;
- never invent lanes to meet a minimum;
- initial delegated attempt may receive one focused repair;
- after that repair, or when worker capability remains inadequate, the main model takes over;
- the main model may directly handle genuinely hard or quality-critical work and should state the reason;
- worker completion is evidence, never acceptance.

Delegation-first is a model/tool contract, not a blockade on Pi's mutation tools. This preserves the approved main-model override for hard and quality-critical cases.

When Ultra is disabled or configuration is invalid, no delegation policy is injected.

### 5.3 Explicit `/ultra <task>`

`/ultra <task>` no longer runs a planner. When enabled, it injects a model-visible `ultra-explicit-task` message containing the original task and triggers the active main model. If the model is already running, delivery is queued as a follow-up. The dynamic policy marks the request as explicitly Ultra-managed.

When disabled, it reports exactly `Run /ultra on first.` and does not trigger a turn.

### 5.4 Tool contract

Ultra registers one main-session tool:

```ts
ultra_delegate({
  objective: string,
  lanes: Array<{
    id: string,
    role: "scout" | "worker" | "reviewer",
    task: string
  }>,
  acceptance: string[],
  repairOf?: string
})
```

The tool:

- is available in every session but fails fast when Ultra is disabled, configuration is invalid, or capabilities are unavailable;
- validates exact keys, bounded text, lane IDs, uniqueness, role allowlist, and configured lane range;
- derives mutation authority from role rather than accepting a contradictory `write` boolean;
- preflights every lane before launch;
- launches exactly one asynchronous workflow and returns an operation ID plus run receipt;
- never claims success or acceptance.

A main model that decides no qualified wave exists simply does not call the tool and continues normally.

## 6. Role and model routing

### 6.1 Package-owned strict agents

Replace the planner agent with three package-owned agents:

| Role | Agent binding | Tool authority | Isolation |
|---|---|---|---|
| scout | `ultra-scout` | `read`, `grep`, `find`, `ls` only | shared checkout, read-only |
| reviewer | `ultra-reviewer` | `read`, `grep`, `find`, `ls` only | shared checkout, read-only |
| worker | `ultra-worker` | bounded implementation tools including `bash`, `edit`, `write`, supervisor contact | managed worktree |

Package-owned names avoid overriding pi-subagents built-ins globally. Their agent files do not hard-code a provider/model. In role-default mode, pi-subagents resolves any user `agentOverrides` for `ultra-scout`, `ultra-worker`, and `ultra-reviewer`, then its configured package/global default. This keeps the package portable while allowing distinct role models. Preflight must verify the resolved effective allowlist. Scout/reviewer fail closed if mutation-capable tools are present; worker fails closed if required implementation/isolation capability is absent.

### 6.2 Routing modes

- **Role defaults:** each package-owned role agent resolves its configured/default model, including a matching user agent override when present.
- **Uniform:** the selected canonical `provider/id` is passed as a requested and expected model for every lane.

Uniform routing changes only model binding. It never changes the lane's role or agent.

`Automatic` means no fixed model request or expectation; it is never forwarded as a literal model ID.

## 7. Atomic workflow launch

After all lane preflights succeed, Ultra builds one JSON-safe workflow:

```ts
return await runs.all([
  { key, agent, model?, task, context: "fresh", output: true, worktree? },
  ...
]);
```

Each child carries its own resolved agent and optional model. Worker lanes set `worktree: true`; scout/reviewer lanes cannot request it and retain strict read-only tools.

The workflow is sent in one RPC `spawn`, creating one admission result, one run ID, and one terminal completion boundary. Ultra does not split role/model groups into independent RPC launches.

If preflight or admission fails, no lane is treated as launched. The tool returns bounded diagnostics to the main model immediately.

## 8. Delegation repair and takeover

Every accepted tool call creates a durable operation record:

- `operationId`;
- workflow `runId`;
- objective and bounded acceptance criteria;
- expected lane IDs, agents, models, and authority;
- `repairCount` (`0` for an initial wave);
- lifecycle/delivery state.

A repair call must set `repairOf` to a completed operation.

- The first repair is accepted with `repairCount: 1`.
- A second repair for the same operation is rejected with a model-visible instruction that the main model must take over.
- A repair may contain only focused lanes tied to failed or inadequate prior work.

Preflight/admission failure does not consume the single quality-repair allowance because no worker attempt ran. Repeated capability failure still tells the main model to proceed directly rather than loop.

## 9. Capability readiness and shutdown

On session start, Ultra requests the pi-subagents capability advertisement and stores the validated protocol version, events, and methods.

`ultra_delegate` waits at most the short protocol timeout (default 1.5 seconds) for readiness. It never enters the old 120-second planner wait. Failure identifies the missing/incompatible dependency and suggests install/update plus `/reload`.

Every RPC waiter accepts an abort signal. Session shutdown/reload:

- aborts active waiters;
- clears timers;
- removes listeners;
- prevents stale extension instances from storing receipts or sending messages.

## 10. Durable completion and manager delivery

### 10.1 Persistence and race closure

Operation records are appended as bounded Pi custom session entries and restored from the active branch at `session_start`.

Ultra must handle both event orders:

- receipt before completion;
- completion before receipt storage.

Unknown completion events are held in a bounded short-lived buffer. After a receipt is stored, Ultra performs one correlated status/replay query to close the event race and reconcile operations restored after reload.

### 10.2 Terminal-state handling

Paused and other nonterminal events update state but never delete correlation or trigger final audit. Only an explicit terminal-state allowlist finalizes an operation. Delivered terminal markers are persisted for deduplication.

### 10.3 Runtime binding verification

Terminal data is parsed into bounded per-lane evidence. Actual runtime agent/model/status values are compared with preflight expectations. Mismatches are highlighted; expected values are never mislabeled as actual resolved values.

### 10.4 One model-visible follow-up

When the single workflow reaches terminal state, Ultra sends one `ultra-wave` custom message whose **content**, not only `details`, includes:

- operation and run IDs;
- lane IDs and terminal statuses;
- expected versus actual agents/models;
- artifact/output paths;
- acceptance/validation requirements;
- failures, pauses resolved to terminal, and routing mismatches;
- instruction to inspect diffs/artifacts and decide acceptance independently.

The message uses `triggerTurn: true` and follow-up delivery so the active main model performs the audit. `details` may retain structured UI metadata but is not the only evidence channel.

## 11. Settings persistence and recovery

### 11.1 Lock-scoped updates

Replace stale full-snapshot saves with a lock-scoped API:

```ts
updateUltraSettings(mutatorOrPatch, path?): Promise<UltraSettings>
```

Under one lock it:

1. reads and validates the latest settings;
2. applies only the requested field patch or paired range update;
3. normalizes the full result;
4. preserves unknown top-level fields;
5. writes a same-directory exclusive temp file and atomically renames it;
6. returns the committed settings.

Commands and menu actions update fresh locked state. Toggle is computed inside the lock. Concurrent independent changes compose instead of overwriting one another.

### 11.2 Invalid configuration

Malformed or invalid settings fail closed: Ultra is disabled for execution, the original bytes remain untouched, and a bounded reason is shown.

The TUI offers an explicit recovery action that:

1. asks for confirmation;
2. copies the exact invalid bytes to a timestamped backup under the lock;
3. prepares validated defaults in a same-directory exclusive temp file;
4. atomically replaces the invalid file only after the backup and temp write succeed;
5. reports both paths and committed state.

`/ultra on` never silently replaces an invalid file.

### 11.3 Stale locks

The lock directory contains bounded owner metadata (PID, creation time, nonce). A contender may reclaim only when the recorded process no longer exists and the lock is older than 30 seconds. On a platform where process liveness cannot be established, Ultra does not reclaim automatically. Live/young locks retain the two-second bounded wait. Cleanup failure is surfaced rather than silently ignored.

## 12. Menu redesign

### 12.1 Main and settings screens

Main displays:

- enabled/disabled;
- routing mode;
- `Model: Role defaults`, `Model: Automatic`, or canonical fixed model;
- lane range including preset name when exact.

Settings contains:

- Ultra;
- Routing mode;
- Worker model…;
- Lane range…;
- invalid-config recovery when required.

Worker model copy states that it is used only by uniform routing. Lane copy describes an eligibility range; Ultra never manufactures independent lanes to meet the minimum.

### 12.2 Searchable model picker

Use public `pi-tui-kit` `ChoiceScreen`, not Pi's internal `ModelSelectorComponent`.

- Source exclusively from `ctx.modelRegistry.getAvailable()`.
- Deduplicate and sort canonical `provider/id` values deterministically.
- `Automatic` is first.
- `enableSearch: true`; bounded viewport (8–10 rows).
- Search text includes provider, ID, canonical ID, and display name.
- Save the raw canonical item ID, never a rendered label.
- Preserve an unavailable saved model as a disabled row with a clear reason.
- Keep truthful `currentItemId`, but set `initialItemId: "automatic"` when the saved model is unavailable.
- Cancel/back never changes the saved model.

TUI fuzzy search is the required product behavior. RPC receives the deterministic unfiltered list.

### 12.3 Lane presets and Custom

Replace independent minimum/maximum rows with one `Lane range` row and a choice screen:

- Small — `1–2`
- Balanced — `2–4`
- Large — `4–8`
- Custom…

Selecting a preset updates both fields in one lock-scoped transaction and one save.

Custom opens one input accepting `MIN-MAX` (spaces and an en dash may normalize to the same form). Both integers must be safe and within `1–8`, with `min <= max`. Validation and persistence are atomic; an invalid draft causes zero saves and remains available for correction. Save failure retains the prior committed range.

Exact ranges show their preset name; all other valid ranges show `Custom · MIN–MAX`.

## 13. Command behavior

- `/ultra` — TUI menu only.
- `/ultra on|off|toggle` — lock-scoped state update and status refresh.
- `/ultra help` — documents manager ownership, delegation-first escalation, routing, and recovery.
- `/ultra <task>` — sends the task to the active main model as an explicit Ultra-managed turn.

Non-TUI bare-menu invocation keeps the existing actionable error. Explicit command failures must also emit a mode-independent model/session-visible diagnostic, not only `ctx.ui.notify`.

## 14. Packaging and source of truth

Remove unused foreground-planner assets:

- `agents/ultra-planner.md`;
- `prompts/ultra-planner.md`;
- dead duplicated manager prompt text.

Add package-owned strict role agents:

- `agents/ultra-scout.md`;
- `agents/ultra-worker.md`;
- `agents/ultra-reviewer.md`.

Manager policy/instructions have one runtime source of truth in extension code, with tests asserting the model-visible contract. README and package smoke expectations follow that source rather than treating dead prompts as runtime behavior.

## 15. Verification strategy

### 15.1 Main-manager behavior

Tests prove:

- normal coding input reaches the active model unchanged;
- no foreground planner request or `main` planner subagent exists;
- enabled turns receive the bounded manager policy;
- `/ultra <task>` triggers the active main model;
- initial wave, one repair, second-repair rejection, and direct-main override guidance;
- disabled/invalid config fails fast.

### 15.2 Authority and routing

Use real preflight contracts to prove:

- scout/reviewer effective tools exclude `bash`, `edit`, and `write`;
- worker has required implementation tools and worktree isolation;
- reviewer/scout cannot become writing lanes;
- uniform routing preserves role agents and binds only the model;
- `Automatic` is never sent as a model ID;
- one workflow contains every per-lane agent/model binding.

### 15.3 Protocol and lifecycle

Cover:

- missing/incompatible pi-subagents short timeout;
- completion before receipt;
- paused then terminal completion;
- reload restore and status reconciliation;
- duplicate terminal event dedupe;
- actual-versus-expected binding mismatch;
- shutdown abort/listener cleanup;
- one model-visible aggregated follow-up.

### 15.4 Configuration

Cover:

- concurrent field updates compose;
- toggle is serialized;
- paired range update is atomic;
- malformed config fails closed and is preserved;
- explicit backup/reset;
- live lock timeout and stale lock reclamation;
- temp/lock cleanup errors.

### 15.5 Menu

Cover with Pi TUI/RPC harnesses:

- all registry models appear despite scoped models;
- search by provider, ID, canonical ID, and display name;
- large-catalog filtering, no-match, narrow width, and raw-ID save;
- unavailable model starts on Automatic but remains visible;
- preset one-save behavior;
- invalid/valid Custom draft behavior;
- save failure rollback.

### 15.6 Release smoke

A release test must:

1. build the tarball;
2. install it in an isolated temporary Pi agent directory without network dependency;
3. launch Pi RPC against the packed package;
4. assert exactly one `/ultra` command and one `ultra_delegate` tool;
5. verify all three strict agent files are discoverable;
6. fail on stale planner assets or duplicate registrations.

## 16. Acceptance criteria

The redesign is complete only when:

1. `/ultra` opens the approved menu and model search works over all available models.
2. The active session model receives and manages user tasks; no planner subagent owns the prompt.
3. Qualifying work is delegation-first with one repair then main takeover.
4. Role authority is enforced by strict tool contracts and worker isolation.
5. A wave has one atomic workflow receipt/completion boundary.
6. Completion survives event races and reload, verifies actual bindings, and triggers one model-visible audit follow-up.
7. Invalid config cannot enable execution or be silently overwritten.
8. Concurrent settings changes do not lose updates.
9. Focused, full, and packed-runtime smoke tests pass.
10. README accurately documents main-manager ownership, escalation, routing, lane presets, recovery, and evidence-not-acceptance semantics.

## 17. Explicit non-goals

- Running idle paid worker processes.
- Automatically manufacturing lanes to satisfy a minimum.
- Guaranteeing that every prompt delegates.
- Blocking the main model's mutation tools to enforce delegation.
- RPC-side fuzzy model search.
- Treating worker completion as acceptance.
- Supporting a second worker repair for one operation.
