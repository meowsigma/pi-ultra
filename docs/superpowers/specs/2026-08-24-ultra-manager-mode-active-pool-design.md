# Ultra Manager Mode and Active Pool design

**Status:** Approved for planning

## Objective

Turn Ultra from an optional, governed delegation capability into a selectable manager system without weakening its existing launch authority. Users choose between:

- **Collaborator mode** — the main model may work directly or launch a strictly governed Ultra wave when parallel work is valuable.
- **Manager mode** — the main model must make an explicit, durable decision to dispatch governed work or take over itself before it can mutate the project. Worker output is reviewed, can receive one focused repair, and then yields to accountable main-model takeover.

After Manager mode is stable, add a durable, bounded active-pool scheduler. The pool represents durable role slots, task leases, artifacts, and resumable worker state—not permanently running or permanently billed model threads.

## Product model

Ultra is not ordinary `pi-subagents` when in Collaborator mode. Even optional Ultra work retains:

- exact preflight and one-use launch permits;
- package-owned scout, worker, and reviewer roles;
- ambient-extension denial and strict tool contracts;
- worker ownership/worktree constraints;
- durable operation receipts and completion evidence;
- direct-spawn denial while Ultra is enabled.

Turning Ultra **off** remains the explicit way to restore ordinary ungoverned `pi-subagents` behavior.

## Settings and UI

Add a complete settings field:

```ts
type UltraOrchestrationMode = 'collaborator' | 'manager';
```

The global config and session override patch layer this field like existing settings. New and migrated sessions default to `collaborator` to avoid silently changing an existing user’s execution behavior.

The main menu has a first-class **Orchestration mode** item:

- **Collaborator — manager may delegate when useful**
- **Manager — dispatch or explicit takeover required**

The status line shows `Ultra: collaborator` or `Ultra: manager`, not merely `Ultra: on`. Menu help explains that a 100-lane bound is capacity admission, not a 100-thread idle pool.

## Phase 1: enforced Manager lifecycle

### Decision gate

Manager mode adds a durable decision gate for each substantive main-session work scope. A scope opens from an explicit `ultra_begin_scope` call linked to the current root user-message entry and closes only through a terminal disposition. A new root user input always opens a new scope and cannot inherit a prior grant; continuations, compaction, reload, and Goal-X auto-continuation retain only the active scope's append-only state.

Before a parent can use any tool outside a small explicit read-only/decision allowlist, it must have an active, valid scope and exactly one current decision:

1. **Dispatch** — invoke `ultra_delegate` for an exact, independently justified wave. Dispatch never grants general parent mutation; it only permits the narrowly defined candidate-materialization step after the job's verified handoff.
2. **Take over** — invoke `ultra_takeover` with a typed, state-eligible reason and concrete scope. Only takeover grants bounded parent mutation.

Direct `subagent` spawning remains blocked in both modes. Unknown/custom tools are denied before a decision rather than guessed to be harmless. `bash` is never classified by a shell-string heuristic: it is denied unless on the explicit read-only allowlist, or covered by the active takeover grant. The allowlist is not a sandbox and is never used to permit writes.

Runtime gating is separately represented as `verified-off`, `enabled-collaborator`, `enabled-manager`, or `blocked/unknown`. `blocked/unknown` always fails closed; only `verified-off` restores ordinary `subagent` behavior.

### Dispatch path

`ultra_delegate` becomes the sole dispatch decision implementation. It appends an idempotent `queued/admitted` launch-attempt record before the permit is issued, binds that ID into the permit/request correlation, and attaches a receipt idempotently after spawn. Restore reconciles an admitted attempt by its idempotency key; it never blindly relaunches after the permit/spawn/receipt crash boundaries. Manager mode does not invent lanes: if the work has no genuine independent decomposition, dispatch must be rejected and the manager must select takeover instead.

### Takeover path

`ultra_takeover` is a manager-only structured tool. It permits parent mutation for its recorded scope and requires one of:

- `inseparable-work` — no honest independent lane split;
- `dirty-worktree` — writer worktree admission cannot be safe;
- `repair-exhausted` — the one permitted repair did not satisfy review;
- `worker-capability-failure` — preflight/runtime worker limitation;
- `urgent-user-directed` — user explicitly needs direct handling.

It records a bounded explanation and links to the prior job if present. Eligibility is evidence-derived: `dirty-worktree`, `repair-exhausted`, and `worker-capability-failure` require their corresponding persisted event; `urgent-user-directed` requires a linked user entry; and `inseparable-work` requires explicit user confirmation or a separately reviewed decomposition decision. A user-visible diagnostic makes direct takeover inspectable after reload.

### Writer handoff and review

A write worker must return the fork's existing durable patch handoff manifest, including its verified base revision, changed paths, commands, and validation evidence. Phase 1 does **not** rely on a worker branch or commit surviving cleanup: the current fork force-deletes managed worktree branches. The manager verifies the patch manifest against the recorded base and materializes it only into a dedicated immutable candidate checkout. A future fork branch-preservation contract is a separate change, not an assumed property.

Review is sequential, never a concurrent lane in the originating writer wave:

```
queued -> admitted -> running -> awaiting_handoff -> candidate_materialized
  -> reviewer_running -> awaiting_manager_disposition -> verified
  -> repair_queued -> repairing -> awaiting_handoff
  -> taken_over | blocked | cancelled
```

After materialization, Ultra launches a separately preflighted reviewer bound to `{ rootJobId, baseSHA, candidatePatchDigest }`. It appends a structured reviewer finding. Only an explicit manager disposition may mark a job verified, queue its one repair, or take it over. Exactly one focused repair is permitted for the root job. A reviewer finding after that repair requires `ultra_takeover`; it may not trigger unbounded re-dispatch. Completion remains evidence until independent review and explicit manager disposition.

### Dirty-tree handling

Before a writer lease is issued, Ultra checks worktree viability and records the repository base revision. A dirty repository blocks writer admission before model work is spent. Manager mode then offers only:

- read-only scout/reviewer work that requires no worktree;
- explicit `ultra_takeover({ reason: 'dirty-worktree' })`; or
- user cleanup/commit/stash followed by a new dispatch.

Ultra does not silently disable worktree isolation, auto-stash user changes, or use a shared dirty checkout.

## Phase 2: durable active-pool scheduler

### Pool semantics

The active pool is a per-session scheduler with a configured concurrency ceiling. Its durable state contains logical role slots and job leases; it does not keep one hundred models actively generating or pre-create one hundred Git worktrees.

A slot may be `idle`, `leased`, `running`, `waiting_review`, `suspended`, `failed`, or `retired`. Finished workers release their slot. A repair can prefer a retained/resumable worker identity only when its exact authority, capability ceiling, workspace/base revision, and lease all remain valid. Otherwise it creates an explicitly labelled same-role fallback.

### Queue and scheduling

Jobs are immutable declarations with stable IDs, role, input contract, required artifact, workspace/base revision, retry budget, and priority. The queue is persisted as Ultra-owned non-model-visible session entries. State transitions append events rather than mutating prior history.

Scheduling rules:

- admit only independently parameterized jobs;
- enforce configured concurrency rather than assuming provider capacity;
- prioritize an admitted job’s single repair ahead of new optional work without starving older queued jobs;
- permit concurrent read-only lanes;
- permit concurrent writers only when their paths and workspace bases are disjoint;
- use a barrier join by default for a wave, while exposing failures and partial results to the manager;
- propagate cancellation, lease expiry, and session shutdown to running work.

### Controlled resume support

The current Ultra authority intentionally authorizes one exact static `runs.all` spawn and denies resume/revival while enabled. Phase 2 requires an explicit extension to the `pi-subagents` authority fork:

- an opaque, one-use resume/continue permit bound to one prior worker run, role, model-candidate contract, workspace/base revision, lease ID, and prompt digest;
- re-preflight before resume;
- no arbitrary session resurrection, retargeting, model change, nested spawning, or authority widening;
- a fresh permit for every continuation;
- durable idempotency keys so a reload cannot double-deliver a lease.

This is a coordinated Ultra plus fork change and must not be emulated by allowing generic `subagent resume`.

### Failure and takeover policy

A job records a typed terminal/paused reason: `preflight_failed`, `dirty_worktree`, `provider_failed`, `timeout`, `handoff_missing`, `review_rejected`, `workspace_stale`, `cancelled`, or `manager_takeover`.

Retry behavior is explicit:

- transient provider/transport failure: one same-lease resume when safe;
- failed validation or reviewer rejection: one focused repair;
- stale base, dirty worktree, or unsafe ownership: never blind-retry;
- exhausted repair/failure budget: manager takeover.

## Goal-X coexistence

Goal-X remains a peer extension. Ultra neither imports its private internals nor marks Goal-X tasks complete automatically. Manager decisions, jobs, reviewer findings, and takeover evidence are available to the main model, which explicitly updates Goal-X task state only after verified work.

Goal-X auto-continuation may resume the manager, but its continuation does not bypass an unfinished Manager-mode decision gate.

## Security and reliability invariants

1. A direct `subagent` launch is blocked whenever either Ultra mode is enabled.
2. A Manager-mode parent tool call outside the explicit read-only/decision allowlist has a durable active scope and eligible takeover grant; dispatch alone never grants general parent mutation.
3. Worker launch/resume occurs only through an exact, preflighted, one-use permit and a durable idempotent launch/lease record.
4. No worker writes outside an owned path or into a shared dirty checkout.
5. Worker completion claims are not acceptance; candidate handoff, reviewer evidence, and manager disposition are distinct.
6. One root job receives at most one repair unless the user creates a new root objective.
7. Reload, session resume, cancellation, and stale-policy changes fail closed and preserve the operation/lease journal.
8. Collaborator mode never bypasses existing Ultra authority; it changes only the parent’s dispatch obligation.

## Non-goals

- A literal fixed population of permanently live/billed LLM workers.
- Auto-stashing, committing, pushing, or merging user code without explicit authority.
- Generic direct `subagent` access while Ultra is enabled.
- Automatic Goal-X task completion.
- Infinite retry or self-directed worker recursion.
