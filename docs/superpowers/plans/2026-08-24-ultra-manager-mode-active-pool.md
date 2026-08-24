# Ultra Manager Mode and Active Pool Implementation Plan

**Goal:** Add an explicit collaborator/manager toggle, then evolve strict Manager mode into a durable, bounded, resumable active-pool scheduler without weakening Ultra authority.

**Architecture:** Phase 1 adds a durable parent decision gate to the existing exact-wave protocol. Phase 2 adds a journaled job/lease scheduler and narrowly authorised worker resume support in the `pi-subagents` fork. Existing Collaborator behavior stays safe and remains the migration default.

## Phase 1 — Manager mode

### Task 1: Add mode settings, layering, and menu/status visibility

**Files:** `extensions/ultra-config.ts`, `extensions/ultra-session-settings.ts`, `extensions/ultra-menu.ts`, `extensions/ultra.ts`, tests and README.

- Add `orchestrationMode: 'collaborator' | 'manager'` to complete global settings and session patches.
- Preserve absent patch inheritance; default all migrations to `collaborator`.
- Add clearly scoped menu controls and `Ultra: collaborator|manager` status text.
- Reject invalid mode values globally/session-locally under existing fail-closed rules.

**Proof:** independent session/global override, reset, reload, invalid-value, and menu-callback tests.

### Task 2: Persist manager decisions and gate parent mutation

**Files:** new `extensions/ultra-manager-state.ts`, `extensions/ultra.ts`, operation/session tests.

- Append an immutable `ultra.manager.v1` scope/decision journal rooted in an explicit current user-message entry; define open, supersede, terminal-close, reload, continuation, and fork/tree semantics.
- Add `ultra_begin_scope` and `ultra_takeover` structured tools; takeover reasons must be state-evidence eligible, not merely syntactically typed.
- In Manager mode, default-deny every unknown/custom/parent work tool outside a small explicit read-only/decision allowlist until an active scope and eligible decision exist.
- Keep read-only inspection usable before a decision; dispatch never grants general parent mutation; only a bounded takeover grant or candidate-materialization path can do so.
- Represent `verified-off`, enabled collaborator, enabled manager, and blocked/unknown separately. Direct `subagent` is allowed only in verified-off and blocked in both enabled modes and unknown/blocked states.
- Fence decisions against reload, cancellation, global/session policy revision changes, stale scopes, Goal-X continuation, compaction, and new root user input.

**Proof:** invoke real registered handlers in FakePi; prove dispatch cannot authorize `write`/`edit`/`bash`, custom mutator tools fail closed, all takeover eligibility reasons are checked, off restores ordinary subagents, and restart/new-user/continuation state cannot inherit old grants.

### Task 3: Make writer handoff and review mandatory

**Files:** `extensions/ultra-protocol.ts`, `extensions/ultra-operations.ts`, `extensions/ultra.ts`, role prompts, tests.

- Persist an idempotent `queued/admitted + launchAttemptId` record before permit issue; bind the attempt to spawn/receipt correlation and reconcile every crash boundary without relaunching.
- Consume the current fork's durable patch handoff manifest—never a worker branch/commit that cleanup force-deletes—and verify its base revision, digest, changed paths, commands, and validation evidence.
- Materialize a verified patch only into a dedicated candidate checkout. Launch a separately preflighted reviewer after materialization; reject writer/reviewer mixing in one Manager-mode writer wave.
- Add `awaiting_handoff`, `candidate_materialized`, `reviewer_running`, `awaiting_manager_disposition`, `verified`, `repair_queued`, and `taken_over` operation transitions plus structured reviewer findings and explicit manager disposition.
- Permit one repair reservation exactly as today, but require a bound reviewer finding and prevent acceptance of disposable/uncommitted worktree claims.

**Proof:** real-fork integration tests prove candidate materialization survives worker cleanup; fault injection covers before permit, after permit, after spawn, and before receipt persistence; lifecycle tests cover forged/missing handoff, reviewer ordering/binding, mismatched base/paths, one repair, takeover, and reload recovery.

### Task 4: Add writer admission checks for worktrees

**Files:** `extensions/ultra.ts`, `extensions/ultra-protocol.ts`, tests.

- Check Git worktree viability/base state before consuming a worker permit.
- On dirty/unsafe source state, deny only write lanes before launch; allow read-only work where valid.
- Require typed dirty-tree takeover or explicit user cleanup; never auto-stash or downgrade isolation.

**Proof:** dirty tree creates zero writer runs/permits, retains a diagnosable job state, and permits the typed takeover route.

### Phase 1 verification

- `npm run check`
- `npm run smoke:packed`
- new multi-session lifecycle, unknown-custom-tool, verified-off, direct-spawn, launch-crash, handoff-materialization, reviewer-order, and scope-replay regression tests
- fresh-Pi live probe showing Manager mode blocks parent work before a scoped takeover, accepts only an authorized `ultra_delegate` wave, and fails closed across reload/watcher races.

## Phase 2 — durable active-pool scheduler

### Task 5: Define journaled jobs, leases, slot state, and dashboard

**Files:** new `extensions/ultra-pool.ts`, `extensions/ultra-menu.ts`, `extensions/ultra.ts`, tests.

- Persist append-only job, lease, slot, handoff, review, and terminal events.
- Implement state transition validation for queued/admitted/running/suspended/review/repair/takeover/terminal transitions.
- Display real queue, active lease, slot, failure, and retry state in a dashboard; replace ambiguous `Ultra: on`-only reporting.

**Proof:** deterministic transition tests, corruption recovery, reload/replay, cancellation, lease expiry, and UI rendering tests.

### Task 6: Add bounded scheduler admission

**Files:** `extensions/ultra-pool.ts`, `extensions/ultra.ts`, tests.

- Add a configurable concurrency ceiling independent from per-wave max lanes.
- Enforce fair queue admission, repair priority, read-only parallelism, disjoint writer ownership, and default barrier join.
- Ensure capacity, provider failure, shutdown, and stale policies never strand an admitted lease.

**Proof:** simulated scheduler tests for concurrent leases, fairness, disjoint-path checks, retry ordering, cancellation, and no double admission after reload.

### Task 7: Extend fork authority for controlled resume

**Repositories:** `pi-subagents` fork and `pi-ultra`.

- Define resume/continue permit schema bound to exact worker identity, role, model contract, workspace base, lease ID, prompt digest, policy revision, and expiry.
- Repeat preflight before every resume; deny generic resume/revival while Ultra is active.
- Add end-to-end RPC route, one-use consumption, idempotency, revocation, shutdown, and cross-instance authority tests.

**Proof:** fork unit/integration tests prove exact continuation succeeds once; every altered identity/model/workspace/prompt/revision/lease and all generic resume paths fail closed.

### Task 8: Integrate retained-worker repair and final takeover

**Files:** Ultra pool/controller/operations modules, role prompts, integration tests.

- Prefer a valid retained worker only for its bound repair lease; otherwise create a labelled same-role fallback.
- Record provider/timeout/workspace/reviewer failure classes and consume bounded retry budgets.
- Transition exhaustions to mandatory Manager takeover, preserving all artifacts for the main model and optional Goal-X updates.

**Proof:** live-like fake workflow with failure, retained resume, fallback, reviewer rejection, final takeover, and exactly-once completion/outbox delivery.

### Phase 2 verification and release

- full Ultra and fork suites;
- packed smoke using distinct active/bundled fork copies;
- no direct-spawn/resume bypass probes;
- fresh-session active-pool probe with queue, cancellation, one repair, and takeover evidence;
- versioned releases of both packages, installation, and explicit reload/restart instructions.

## Sequencing rule

Do not begin Phase 2 implementation until Phase 1 has shipped and been live-verified. The resume authority and durable pool depend on stable parent decision, handoff, review, and takeover invariants; adding a pool first would create an unbounded bypass surface.
