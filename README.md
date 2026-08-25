# pi-ultra

`pi-ultra` adds session-wide, policy-governed subagent waves to [Pi](https://github.com/earendil-works/pi-coding-agent).

The **active Pi session model remains the manager and final reviewer**. Ultra does not replace it with a foreground planner. The manager decides whether genuinely independent lanes exist, calls `ultra_delegate` for one exact wave, continues working, and audits worker evidence before acceptance.

## Compatibility and installation

Ultra requires Pi `>=0.84.0` and the reviewed launch-authority fork of `pi-subagents`:

```bash
# Remove an older npm pi-subagents identity so two extensions do not load.
pi remove npm:pi-subagents

# Install the reviewed controlled-resume release.
pi install git:github.com/meowsigma/pi-subagents@v0.56.0-ultra.0

# Install Ultra (pin the release in production).
pi install git:github.com/meowsigma/pi-ultra@v0.4.0
```

Ultra bundles the same reviewed fork release from its immutable HTTPS archive as a runtime API dependency because Pi packages have separate module roots. The separately installed fork is the active `subagent` extension; both copies share a versioned process registry. If the active extension does not advertise launch-authority v1, Ultra shows **blocked** and denies new subagent execution instead of partially enforcing policy.

After installation, run `/reload` or start a fresh Pi session. Use `pi list` to verify that exactly one `pi-subagents` identity and one `pi-ultra` identity are enabled.

## Settings

The global JSON file is the **baseline** configuration that every Pi session starts from:

```json
{
  "version": 1,
  "enabled": true,
  "routingMode": "uniform",
  "orchestrationMode": "collaborator",
  "workerModel": "openai-codex/gpt-5.6-sol",
  "minLanes": 4,
  "maxLanes": 100
}
```

Lane bounds are inclusive and custom ranges are limited to `1–100`. Changes use lock-scoped read/modify/write transactions, preserve unknown top-level fields, and are committed through exclusive temporary files plus atomic rename.

A missing file uses validated defaults. A malformed, unreadable, or invalid file does **not** expose executable defaults: Ultra enters `Ultra: blocked`, preserves the exact bytes, and installs an empty-agent capability ceiling. The TUI recovery action asks for confirmation, writes an exact timestamped backup, then resets to disabled defaults.

Every live session watches the global file, including atomic replacement. Malformed replacement and recovery transitions update policy in fail-closed order.

### Session overrides

Ordinary edits are **session-scoped**: opening `/ultra` and using `/ultra on`, `/ultra off`, or `/ultra toggle` changes only the current Pi session and never writes the global file. Each edit appends an immutable, non-model-visible snapshot to the session journal, so session overrides persist in that Pi session across reload/resume; the latest valid snapshot wins on restore.

- The menu's **Global defaults** screens are explicit for global edits: only they write `~/.pi/agent/pi-ultra.json` for every inheriting session.
- **Reset this session to global defaults** removes the override with one explicit empty snapshot, after which the session follows the global file again.
- Independent sessions can differ in enabled state, routing mode, worker model, and lane range.
- An invalid global config blocks all sessions, even overridden ones: effective settings always resolve against a valid global baseline.
- If a session change commits but post-commit verification fails, Ultra stays fail-closed and surfaces a warning instead of claiming the settings applied.

### Manager mode

`orchestrationMode` defaults to `collaborator`, which preserves the normal governed-wave workflow. In `manager` mode, Ultra fail-closes unknown or mutating parent tools until the manager opens a scope and records an eligible durable takeover. Direct `subagent` spawning remains blocked in both enabled modes.

Writer work requires a clean, existing Git repository and is denied before permit issuance when that cannot be verified; Ultra never initializes Git, stashes, stages, commits, or modifies the source checkout. The Manager-mode lifecycle is explicit:

1. `ultra_begin_scope` then `ultra_delegate` for an exact writer wave;
2. `ultra_materialize_handoff` validates the worker manifest and applies patches only in a fresh candidate clone;
3. `ultra_review_candidate` launches a separate read-only reviewer wave against that candidate;
4. `ultra_record_review_findings` then `ultra_dispose_handoff` records `verified`, one `repair-queued`, or `taken-over`.

Worker output, patches, and reviewer reports are evidence only; none is accepted automatically.

### Pi Goal-X coexistence

Ultra is compatible with `pi-goal-x` as a peer extension. Goal-X tracks the main-session goal, task state, auto-continuation, and independent completion auditing; Ultra supplies isolated worker-wave evidence. They do not share private APIs or worker-session extensions.

Use them together by having the main-session manager launch an Ultra wave, inspect its receipts and repository evidence, then explicitly update the relevant Goal-X task or request goal completion. Worker claims never auto-complete Goal-X tasks, suppress its continuation policy, or bypass its auditor.

## Commands

- `/ultra` — open the TUI control menu (session scope).
- `/ultra on` — enable Ultra in this session only; the global file stays untouched.
- `/ultra off` — disable Ultra in this session and restore ordinary pi-subagents behavior there.
- `/ultra toggle` — toggle this session under the settings lock.
- `/ultra help` — show ownership, routing, escalation, and recovery guidance.
- `/ultra <task>` — send an explicit Ultra-managed task to the active main model.

Bare `/ultra` is TUI-only. Non-TUI modes report:

```text
/ultra menu requires TUI mode; use /ultra on, /ultra off, or /ultra toggle.
```

An explicit task while disabled reports exactly:

```text
Run /ultra on first.
```

Normal user input is never passively intercepted or requeued.

## Menu

The menu provides:

- enable/disable;
- routing mode;
- searchable worker model selection;
- one atomic lane-range control;
- blocked-config recovery.

The model picker searches every authenticated model from `ctx.modelRegistry.getAvailable()` by provider, ID, canonical `provider/id`, and display name. It does not narrow the catalog to the current scoped models. Saved values are canonical raw IDs, not rendered labels.

Lane presets are:

- **Small** — `1–2`
- **Balanced** — `2–4`
- **Large** — `4–8`
- **Custom** — validated `MIN-MAX` within `1–100`

Bounds are hard per admitted wave. The main session is not a lane, and Ultra never manufactures filler work to meet a minimum. A custom 100-lane wave starts **100 concurrent workers** in one atomic `runs.all` request; it is not a queued pool. Choose a range your provider rate limits, account budget, and local worktree capacity can sustain.

## Routing

### Uniform

With a fixed selection, every scout, worker, and reviewer lane has exactly that canonical model as its sole candidate. Agent defaults and fallbacks are rejected.

With **Automatic**, Ultra resolves one canonical model once, then explicitly pins it as the sole candidate for the complete wave. `automatic` is never sent as a model ID.

Changing the global selection invalidates unused old-revision permits; the next admitted wave uses the new model.

### Role defaults

Each strict role may use its configured candidate chain. Ultra records:

- requested model, if any;
- the exact preflight candidate list;
- fixed uniform expectation, if any;
- actual runtime model.

An actual role-default model is valid only when it belongs to the permitted candidate list and the runtime launch-contract digest matches preflight.

## Strict roles and lane ownership

Ultra ships package-owned agents:

- `ultra-scout` — read/search only;
- `ultra-reviewer` — read/search only;
- `ultra-worker` — bounded implementation tools in a managed worktree.

None exposes `subagent`; ambient/configured extensions are denied by the inherited capability ceiling. Worker `ownedPaths` are normalized coordination boundaries, not an operating-system sandbox. Ultra compares reported changed paths with ownership and flags out-of-scope changes for main-model rejection.

A tool request contains an objective, acceptance checks, and lanes with unique IDs, tasks, deliverables, and worker paths. Ultra rejects duplicate task/deliverable padding, overlapping writer roots, unsafe paths, invalid roles, and waves outside the current hard range.

## Session-wide launch authority

While Ultra is on, pi-subagents requires an opaque, one-use, short-lived permit from every active session authority. Before any child starts, the active fork:

1. normalizes and hashes the exact RPC spawn request;
2. parses one static literal `runs.all` wave;
3. repeats current launch preflight;
4. compares ordered keys, agents, model candidates, bounds, and launch-contract digests;
5. rechecks config revision, authority generation, revocation, disposal, and expiry;
6. atomically admits the complete wave or starts nothing.

Direct tools, slash/prompt delegation, extension RPC, and structured delegation use the guarded executor boundary. Dynamic workflows, nested subagent launching, schedule creation/firing, resume/revival, and recovery-capable steer are denied while Ultra is enabled. Read-only/status/stop/interrupt and non-recovering steer remain available.

This protects ordinary supported ingress paths in a trusted parent process. It does not claim an OS or same-realm sandbox against deliberately malicious code already executing inside Pi.

## Escalation and completion

The manager follows:

1. one initial worker wave;
2. at most one focused repair wave for the same root operation;
3. main-model takeover.

A repair is itself a new wave and must satisfy the current lane range. If there are not enough genuine independent repair lanes, the manager takes over rather than padding.

Operation and completion snapshots are appended to the Pi session. Ultra handles completion-before-receipt, receipt-before-completion, paused/nonterminal states, reload restoration, bounded status reconciliation, and duplicate terminal events.

Pi 0.84 has no transactional/idempotent custom-message API, so terminal audit delivery is **at least once**, keyed by stable operation ID. Normal execution sends one follow-up; uncertain crash/reload delivery may retry the same operation ID. The message explicitly tells the manager that worker output is evidence, not acceptance.

## Verification

```bash
npm run typecheck
npm test
npm run smoke:packed
```

The packed smoke installs the tarball into an isolated Pi agent directory, loads the actual packed extensions, checks command/tool uniqueness and strict agent discovery, and proves an unpermitted under-minimum launch is rejected before a run ID is created.

## License

MIT
