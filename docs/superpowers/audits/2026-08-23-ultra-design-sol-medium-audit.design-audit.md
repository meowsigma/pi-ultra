Turn budget wrap-up was requested after 12 assistant turns (soft limit 12, grace 2). Process-mode live steering is unavailable, so the child was warned at launch to wrap up by this budget. Output may be partial.

# Design audit: Ultra menu and passive delegation

## Blockers

### 1. No implementable enforcement path connects the manager’s plan to extension-owned launches

**Sections:** “Execution model” → “Explicit `/ultra <task>`”, “Passive mode”, “Policy enforcement”

The design says the extension injects manager instructions, then “applies the configured routing and lane policy to the resulting launch plan,” and that its launch path validates lane counts. It never defines how the extension receives a structured plan or prevents the manager from calling the ordinary model-facing `subagent` tool directly.

This is especially inconsistent in passive mode: `before_agent_start` can modify the prompt/system prompt, but cannot intercept an internal “launch plan.” Pi’s local extension documentation only gives that hook prompt injection capabilities (`docs/extensions.md`, `before_agent_start`). Consequently, prompt-driven launches bypass the claimed extension enforcement.

**Correction:** Define one authoritative execution protocol, such as an Ultra-owned model tool that accepts a schema-validated lane plan and exclusively performs launches. State how ordinary `subagent` calls are prevented or explicitly acknowledge that routing and bounds are advisory rather than enforced. Add tests proving out-of-range and mis-routed plans cannot launch.

### 2. The selected pi-subagents API cannot provide all promised fleet mechanics

**Sections:** “Policy enforcement”, “Package layout”; repository `prompts/ultra.md` → “Fleet mechanics”

The design generically says it will route through pi-subagents’ “public extension API,” without selecting an API. The installed `pi-subagents` 0.54.0 documentation exposes:

- structured delegation for one foreground leaf;
- async RPC `spawn` using a workflow script;
- runtime agent registration.

The structured request type in `src/api/delegation.ts` has no `worktree` field. Yet the retained manager prompt requires every git-repository lane to use `worktree: true`, fresh context, and resumability. The structured delegation API also does not itself expose the same resumable workflow control contract described by that prompt. RPC `spawn` is a different async API with different lifecycle and correlation requirements.

**Correction:** Select and specify the exact API and minimum pi-subagents version. If worktree-isolated, resumable lanes remain required, use and document an API that supports them, including lifecycle, cancellation, completion, repair/resume, and ownership. Otherwise remove those guarantees from `prompts/ultra.md` and README.

### 3. The approved design conflicts with the manager prompt it says it will inject

**Sections:** “Decisions”, “Persistent configuration”, “Execution model”, “Package layout”; repository `prompts/ultra.md`

The existing prompt instructs the manager to:

- parse per-request `lanes=`, `model=`, and `thinking=`;
- select a model and thinking level per task;
- create and delete files under `~/.pi/agent/agents/`;
- launch through those persistent file-based bindings.

The design instead establishes global `minLanes`/`maxLanes`, uniform versus role-default routing, one configured worker model, and an extension-owned runtime binding. Merely “sharing” the existing prompt between explicit and passive paths would preserve two conflicting authorities and allow request arguments to override global settings.

**Correction:** Make replacement of the prompt contract an explicit requirement. Remove legacy request parsing and user-agent-file mutation, define configuration precedence, and ensure the prompt directs all managed launches through the Ultra-owned protocol from finding 1.

## Major findings

### 4. pi-subagents installation, readiness, and compatibility are unspecified

**Sections:** “Package layout”, “Failure handling”, “Validation plan”; repository `package.json`

Current `package.json` has no dependencies or peer dependencies and declares only prompt resources. The design mentions a runtime menu dependency but does not define how pi-subagents is required, detected, version-gated, or reported unavailable. Installing pi-subagents merely as a nested npm dependency would not necessarily load its Pi extension.

The public APIs relied upon are version-specific; the locally installed package is 0.54.0 and documents readiness/RPC capability negotiation.

**Correction:** Declare the minimum compatible pi-subagents and Pi versions, installation relationship, readiness/capability handshake, timeout, and actionable unavailable/incompatible behavior. Test clean installation where pi-subagents is missing, installed but not loaded, too old, and loaded after Ultra.

### 5. Role-default routing has no defined specialist roster or discovery mechanism

**Sections:** “Decisions”, “Settings”, “Policy enforcement”

“Configured specialist agents retain their own model bindings,” but the design does not define:

- which agent names or roles constitute the roster;
- how the planner maps lanes to roles;
- how Ultra discovers configured agents;
- behavior for missing, ambiguous, disabled, or capability-ceiling-restricted agents.

The pi-subagents public runtime-agent API registers agents but is not a general configured-agent listing API. Preflight can resolve a known agent name, but Ultra still needs a source for those names.

**Correction:** Define a persisted or fixed role map and resolve each selected name through pi-subagents preflight before launch. Specify missing/ambiguous/restricted-role failures and test them.

### 6. “Status/help in non-TUI modes” assumes an output channel Pi does not provide

**Sections:** “Command contract”, “Failure handling”

The design promises `/ultra` status/help outside TUI. Pi distinguishes `tui`, `rpc`, `json`, and `print`; UI methods are unavailable/no-ops in print and JSON modes. The installed Goal implementation explicitly throws for status in print/JSON because “Pi does not expose an extension-command output channel” (`@narumitw/pi-goal/src/commands.ts`, `reportGoalStatus`).

**Correction:** Define behavior separately for TUI, RPC, JSON, and print. For print/JSON either return a documented error, trigger an agent turn deliberately, or expose a separate RPC/status API; do not promise direct status output without an available channel. Add mode-specific tests.

### 7. Passive bypass rules cannot be implemented solely in the stated hook

**Sections:** “Passive mode”

Pi processes extension commands before `input`; prompt templates are expanded before `before_agent_start`. Therefore, by the time `before_agent_start` receives `event.prompt`, it may no longer know that input originated as a slash template. Explicit `/ultra <task>` will also need to enqueue a user message, which may re-enter passive injection and duplicate/conflict with explicit policy.

“Simple conversation” and “clearly trivial deterministic work” also lack deterministic classification rules.

**Correction:** Track origin in the `input` hook and mark Ultra-owned queued prompts so `before_agent_start` can bypass them exactly once. Define conservative, testable eligibility rules; otherwise describe semantic triviality detection as advisory and accept false positives/negatives. Test templates, skills, RPC input, queued messages, explicit Ultra messages, and reloads.

### 8. Global atomic writes do not prevent concurrent lost updates or stale sessions

**Sections:** “Persistent configuration”, “User interface”

Atomic rename prevents partial files but not two Pi processes concurrently reading the same old configuration and overwriting each other’s changes. The design also does not say when long-lived sessions refresh global settings changed by another session. Menus, status indicators, and passive behavior can therefore disagree.

**Correction:** Specify cross-process update semantics: locking or generation/compare-and-swap for writes, plus reload-on-command/hook, file watching, or documented session snapshots. Serialize menu edits and preserve unrelated fields. Add concurrent-writer and cross-session refresh tests.

### 9. `Automatic` is undefined under uniform routing

**Sections:** “Decisions”, “Persistent configuration”, “Settings”

Uniform routing promises one selected model for every lane, while omitted `workerModel` means Automatic and “restores Ultra’s normal model-choice policy.” It is unclear whether Automatic selects one common model per wave, lets each lane resolve independently, inherits pi-subagents defaults, or uses role bindings. These choices yield materially different routing.

**Correction:** Define Automatic precisely for both routing modes, including fallback models, unavailable credentials, session model scoping, and how the effective model is verified before accepting work.

### 10. Minimum-lane behavior is internally ambiguous

**Sections:** “Decisions”, “Explicit `/ultra <task>`”, “Policy enforcement”, “Failure handling”

`minLanes` is called an eligibility threshold, but the extension also “validates the lane plan against `minLanes`,” while too few seams must not create a fake wave. The outcome for an enabled explicit `/ultra <task>` with only one seam is not stated: reject, execute in the manager, or run one worker despite `minLanes: 2`.

**Correction:** Specify the state transition and user-visible result for zero, one, and at-least-minimum seams in both explicit and passive modes. Validate `maxLanes` as a hard cap while treating below-minimum as a documented non-launch outcome rather than an unspecified validation failure.

## Minor findings

### 11. Model picker availability is underspecified

**Sections:** “Settings”, “Failure handling”

“Current model registry” does not say whether the picker respects current session scoping, provider authentication, or merely catalog presence. A catalogued model can still be unusable at launch.

**Correction:** Define “available” using Pi’s usable/scoped model data and confirm effective availability through launch preflight. Distinguish missing, unscoped, and unauthenticated models.

### 12. Packaging validation does not verify the published artifact

**Sections:** “Package layout”, “Validation plan”; repository `package.json`

Current `files` excludes `extensions`, and `pi` declares only prompts. Although the design says package metadata will change, its validation plan only smoke-tests discovery/loading from an unspecified source. A local checkout could pass while the packed npm/git artifact omits extension files or runtime dependencies.

**Correction:** Add `npm pack` inspection and installation from the generated tarball to validation. Verify `pi.extensions`, shipped files, runtime dependencies, command registration, and absence of legacy `/ultra` template ambiguity.

### 13. Existing prompt and extension command share the same slash name without an explicit migration decision

**Sections:** “Command contract”, “Package layout”; repository `package.json`, `prompts/ultra.md`

Pi checks extension commands before prompt-template expansion, so once `/ultra` is registered the currently exported `ultra.md` template becomes unreachable as a slash template. Keeping it exported also leaves confusing duplicate command discovery/source metadata.

**Correction:** Stop declaring `prompts/ultra.md` as a user-facing prompt template if it becomes an internal instruction asset, or rename the internal asset. Add command-discovery assertions showing exactly one intended `/ultra` entry.

## Verdict

The design is **not ready for implementation planning**. The primary unresolved issue is whether Ultra is genuinely an enforcing launcher or only prompt guidance. The exact pi-subagents execution API, plan handoff, worktree/resume mechanics, and rewritten prompt contract must be decided first.