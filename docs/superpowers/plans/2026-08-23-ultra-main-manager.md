# Ultra Main-Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every task has an Acceptance Contract; do not mark a task complete until its Quality Gate review returns PASS.

**Goal:** Ship a production-ready Ultra extension in which the active Pi model remains manager and every Ultra-on pi-subagents launch is admitted as one exact, bounded, model-pinned wave.

**Architecture:** Add a public, session-scoped one-use launch-permit boundary to the pinned `meowsigma/pi-subagents` fork, then consume it from pi-ultra through RPC authorization metadata. Replace passive planner interception with a main-owned `ultra_delegate` tool, strict package agents, durable operation records, lock-scoped settings, and the approved searchable menu. Unsupported pi-subagents versions and invalid settings fail closed by installing an empty-agent capability ceiling.

**Tech Stack:** TypeScript ESM, Pi extension API 0.84.2, pi-subagents 0.55 fork, TypeBox, Node test runner, pi-tui-kit, npm packed-package RPC smoke tests.

---

## Repository map

- `/home/sigma/pi-subagents` — fork branch `feature/ultra-launch-authority`; owns generic permit registration, request admission, RPC authorization metadata, and ingress tests.
- `/home/sigma/pi-ultra/.worktrees/ultra-main-manager` — branch `feature/ultra-main-manager`; owns Ultra policy, strict agents, tool, persistence, UI, docs, and packed integration tests.
- `src/runs/shared/launch-authority.ts` — isolated generic authority registry and one-use permit state machine.
- `src/api/launch-authority.ts` — public export surface for trusted extensions.
- `src/runs/foreground/subagent-executor.ts` — one admission check at each public/delegated/scheduled entrypoint; internal children of an admitted workflow remain inside that admission.
- `src/extension/rpc.ts` — bounded authorization envelope and capability advertisement.
- `extensions/ultra-config.ts` — validated revisioned loading, lock-scoped patch updates, stale-lock recovery, and backup/reset.
- `extensions/ultra-protocol.ts` — lane validation, preflight binding, exact workflow generation, permit-bound RPC, and lifecycle RPC helpers.
- `extensions/ultra-operations.ts` — durable operation snapshots, terminal reconciliation, repair ancestry, and bounded result evidence.
- `extensions/ultra-menu.ts` — all-registry model search and atomic lane-range UI.
- `extensions/ultra.ts` — command/tool/event composition only.

## Task 1: Add generic one-use launch authority to pi-subagents

**Files:**
- Create: `/home/sigma/pi-subagents/src/runs/shared/launch-authority.ts`
- Create: `/home/sigma/pi-subagents/src/api/launch-authority.ts`
- Modify: `/home/sigma/pi-subagents/package.json`
- Test: `/home/sigma/pi-subagents/test/unit/launch-authority.test.ts`

**Acceptance Contract:**
- User-visible behavior: A trusted extension can register a deny-by-default session authority, issue one exact short-lived permit, and prevent replay, expiry, revision mismatch, or another authority from bypassing it.
- Wiring proof command: `cd /home/sigma/pi-subagents && node --experimental-strip-types --import ./test/support/isolated-temp-root.mjs --test test/unit/launch-authority.test.ts`
- Expected output / observable behavior: all authority tests pass; direct launch without every active authority permit is rejected; management inspection is allowed.
- Test-quality proof: tests call the public `pi-subagents/launch-authority` export and delete/replay/mutate permits so disconnected registries or non-consuming tokens fail.
- Regression proof command: `cd /home/sigma/pi-subagents && npm run typecheck && npm run test:unit -- --test-name-pattern='capability ceiling|public execution'`
- Failure this catches: forgeable/reusable permits, non-intersecting authorities, unbounded payloads, unsafe action classification, and disposal leaks.

- [ ] **Step 1: Write failing public API tests** covering registration validation, deterministic request digesting, management classification, no-permit denial, exact permit acceptance, replay, expiry, async revision validation, two-authority intersection, revocation, update, and disposal.
- [ ] **Step 2: Verify RED** with the wiring proof; expect module-export resolution or missing-symbol failures.
- [ ] **Step 3: Implement the bounded API** with these public shapes:

```ts
export interface LaunchAuthorityLane {
  key: string;
  agent: string;
  modelCandidates: string[];
  launchContractDigest: string;
}
export interface RegisterSubagentLaunchAuthorityOptions {
  sessionId: string;
  source: string;
  defaultNewSpawnDecision: "deny";
  validateConfigRevision?(revision: string): boolean | Promise<boolean>;
}
export interface SubagentLaunchAuthorityHandle {
  issueOnce(input: {
    configRevision: string;
    expiresInMs: number;
    requestDigest: string;
    minLanes: number;
    maxLanes: number;
    lanes: LaunchAuthorityLane[];
  }): string;
  revokeUnused(): void;
  dispose(): void;
}
```

Store registrations under a versioned `Symbol.for` registry keyed by session ID. Tokens use `randomBytes(32)` and constant-time equality is unnecessary because lookups are opaque map keys. Reserve all matching tokens before awaiting validators, consume on every validation outcome, and roll no permit back to reusable state.
- [ ] **Step 4: Export request projection/digest and admission helpers**. Canonical projection must reject non-JSON values, control characters, oversized strings/lists, and authorization fields; allow only an explicit safe management-action allowlist when authorities are active. Unknown actions fail closed.
- [ ] **Step 5: Verify GREEN**, run regression proof, then run `git diff --check`.
- [ ] **Step 6: Commit** with `feat: add session launch authority permits`.

## Task 2: Enforce authority at every pi-subagents ingress

**Files:**
- Modify: `/home/sigma/pi-subagents/src/extension/rpc.ts`
- Modify: `/home/sigma/pi-subagents/src/runs/foreground/subagent-executor.ts`
- Modify: `/home/sigma/pi-subagents/package.json`
- Modify: `/home/sigma/pi-subagents/CHANGELOG.md`
- Test: `/home/sigma/pi-subagents/test/unit/rpc.test.ts`
- Test: `/home/sigma/pi-subagents/test/integration/async-execution.test.ts`
- Test: `/home/sigma/pi-subagents/test/unit/launch-authority-ingress.test.ts`

**Acceptance Contract:**
- User-visible behavior: While a session authority is active, direct tool/slash, RPC, structured delegation, schedule/revive, and nested public launch paths cannot start work without an exact permit; safe management remains usable.
- Wiring proof command: `cd /home/sigma/pi-subagents && node --experimental-strip-types --import ./test/support/register-loader.mjs --test test/integration/async-execution.test.ts --test-name-pattern='launch authority'`
- Expected output / observable behavior: zero launch callbacks occur for unpermitted requests; one authorized static workflow starts; replay and changed workflow params are rejected before storage or child launch.
- Test-quality proof: ingress tests invoke `executePublic`, `executeDelegated`, `executeScheduled`, and the real RPC bridge with launch spies, rather than calling the registry admission helper directly.
- Regression proof command: `cd /home/sigma/pi-subagents && npm run typecheck && npm run test:unit && npm run test:integration`
- Failure this catches: policy enforcement only on one tool path, authorization hidden inside model parameters, partial workflow starts, and missing capability advertisement.

- [ ] **Step 1: Write RED ingress tests** for public direct child, workflow, delegated request, scheduled request, RPC spawn, RPC status/stop, and authorization-envelope size/shape.
- [ ] **Step 2: Verify RED** and confirm each failure is an observed launch or missing capability, not test setup.
- [ ] **Step 3: Extend RPC v1 compatibly** with optional top-level `authorization: { launchPermits: string[] }`; never place tokens in `params`, logs, replies, receipts, status, or child environments. Advertise `capabilities.launchAuthority = { version: 1 }`.
- [ ] **Step 4: Gate the three executor boundaries** (`executePublic`, `executeDelegated`, `executeScheduled`) before run IDs, workflow storage, missions, schedules, or child processes are created. Bind RPC permits to normalized params through module-private metadata. Parse only one static literal `return await runs.all([...])`; repeat current launch preflight for every child and compare exact ordered keys, agents, candidate lists, bounds, and launch-contract digests against every authority manifest before entering the inner executor.
- [ ] **Step 5: Prove supported-path closure**. Tool, slash, RPC, and structured bridges call gated wrappers. Schedule creation/manual launch is rejected at the public boundary; unattended timer firing checks active authority before run ID/history/lock creation. Recovery-capable steer, resume, schedules, and dynamic workflows are denied. Authorized Ultra agents receive a ceiling that denies ambient extensions and omits `subagent`, so nested ingress does not exist inside those children.
- [ ] **Step 6: Set fork version `0.55.1-ultra.4`**, export `./launch-authority`, document the compatibility API, run GREEN/regressions, and commit `feat: enforce launch authority at execution ingress`.

## Task 3: Replace Ultra persistence with lock-scoped revisioned updates

**Files:**
- Rewrite: `extensions/ultra-config.ts`
- Test: `tests/ultra-config.test.ts`

**Acceptance Contract:**
- User-visible behavior: Concurrent commands compose, lane ranges save atomically, stale dead locks recover, malformed files block execution without data loss, and explicit recovery backs up then resets disabled.
- Wiring proof command: `cd /home/sigma/pi-ultra/.worktrees/ultra-main-manager && node --import tsx --test tests/ultra-config.test.ts`
- Expected output / observable behavior: tests pass with exact backup paths, revision changes, composed field patches, and no orphan lock/temp files.
- Test-quality proof: concurrent tests hold one mutator between read/write and assert the second update sees committed state; malformed-byte tests compare exact bytes before recovery.
- Regression proof command: `cd /home/sigma/pi-ultra/.worktrees/ultra-main-manager && npm run typecheck && node --import tsx --test tests/package-layout.test.ts`
- Failure this catches: stale-snapshot lost updates, fail-open defaults, lock theft from live processes, and destructive recovery.

- [ ] **Step 1: Replace tests with RED cases** for `revision`, `updateUltraSettings`, paired range patches, toggle under lock, owner metadata, dead/old reclamation, live timeout, cleanup errors, invalid preservation, and `backupAndResetUltraSettings`.
- [ ] **Step 2: Verify RED** against the old snapshot-save implementation.
- [ ] **Step 3: Implement load results** where `loaded`/`missing` include a SHA-256 revision and `invalid` has no executable settings. Missing defaults remain valid; every non-`ENOENT` read/parse/shape error is blocked and never exposes enabled defaults. Bound and sanitize model IDs/reasons.
- [ ] **Step 4: Implement one-lock read/validate/mutate/normalize/merge/write** with unknown-field preservation, exclusive same-directory temp files, atomic rename, owner `{pid, createdAt, nonce}`, bounded waiting, and conservative liveness checks.
- [ ] **Step 5: Implement backup/reset** under the same lock, copying exact bytes and committing validated defaults with `enabled:false` only after backup and temp writes succeed.
- [ ] **Step 6: Run GREEN/regressions and commit** `feat: make ultra settings updates transactional`.

## Task 4: Add strict role agents and the permit-bound Ultra protocol

**Files:**
- Delete: `agents/ultra-planner.md`
- Delete: `prompts/ultra-planner.md`
- Delete: `prompts/ultra-manager.md`
- Create: `agents/ultra-scout.md`
- Create: `agents/ultra-worker.md`
- Create: `agents/ultra-reviewer.md`
- Rewrite: `extensions/ultra-protocol.ts`
- Test: `tests/ultra-protocol.test.ts`
- Test: `tests/package-layout.test.ts`

**Acceptance Contract:**
- User-visible behavior: One validated call launches only package-owned role agents, within the current hard range, with exact fixed/automatic uniform model binding and one atomic permit-bound workflow.
- Wiring proof command: `cd /home/sigma/pi-ultra/.worktrees/ultra-main-manager && node --import tsx --test tests/ultra-protocol.test.ts tests/package-layout.test.ts`
- Expected output / observable behavior: role tools/isolation are strict, duplicate padding and writer overlap reject, every failed preflight yields zero permit/spawn calls, and generated workflow has exact per-lane bindings.
- Test-quality proof: tests parse emitted RPC envelopes and workflow JSON payloads, use real pi-subagents preflight against fixture agents, and mutate one script byte after permit digesting.
- Regression proof command: `cd /home/sigma/pi-ultra/.worktrees/ultra-main-manager && npm run typecheck && node --import tsx --test tests/ultra-config.test.ts`
- Failure this catches: uniform mode replacing roles, fallback models, fake lane padding, partial grouped launches, literal `automatic`, and prompt-only read-only authority.

- [ ] **Step 1: Write RED protocol tests** for exact schema keys, bounded objective/task/deliverable/acceptance, IDs, role-derived authority, normalized duplicates, relative path ownership, prefix overlaps, hard bounds, repair bounds, and model routing.
- [ ] **Step 2: Write strict agents**. Scout/reviewer declare only read/search tools and no extension access. Worker declares bounded read/bash/edit/write/supervisor tools and relies on `worktree:true`; none includes `subagent`.
- [ ] **Step 3: Pin/install the exact bundled fork dependency**, then implement preflight routing using canonical package agent names. Fixed uniform requires `modelCandidates` exactly `[selected]`. Automatic preflights worker once, then explicitly re-preflights every lane with the resolved model. Role defaults preserve role candidate chains. Validate effective tools, extension denial, context, worktree intent, model candidates, and launch-contract digests.
- [ ] **Step 4: Generate exactly one static `runs.all` script** with unique keys, role instructions, deliverables, owned paths, per-lane agents, explicit uniform models, worker-only worktrees, and output capture.
- [ ] **Step 5: Compute the exact RPC params digest, issue one permit, and send it only in RPC authorization metadata**. Any preflight/permit/admission error returns bounded diagnostics and starts no lane.
- [ ] **Step 6: Run GREEN/regressions and commit** `feat: add strict permit-bound ultra waves`.

## Task 5: Make the active model manager and persist operation lifecycle

**Files:**
- Create: `extensions/ultra-operations.ts`
- Rewrite: `extensions/ultra.ts`
- Modify: `tests/fixtures/fake-pi.ts`
- Rewrite: `tests/ultra-input.test.ts`
- Create: `tests/ultra-operations.test.ts`

**Acceptance Contract:**
- User-visible behavior: Normal input reaches the active model unchanged; `ultra_delegate` launches waves; `/ultra <task>` triggers the main model; completion survives races/reloads and produces one evidence-only audit follow-up; only one repair is allowed.
- Wiring proof command: `cd /home/sigma/pi-ultra/.worktrees/ultra-main-manager && node --import tsx --test tests/ultra-input.test.ts tests/ultra-operations.test.ts`
- Expected output / observable behavior: no input interception/planner request occurs, direct spawn-shaped `subagent` calls block while enabled, safe management remains available, normal execution delivers one terminal follow-up, and uncertain crash/reload delivery retries at least once with the same operation ID.
- Test-quality proof: the fake Pi runs real registered tool definitions/events, records custom session entries, rehydrates a second extension instance, and exercises completion-before-receipt plus receipt-before-completion.
- Regression proof command: `cd /home/sigma/pi-ultra/.worktrees/ultra-main-manager && npm run typecheck && npm test`
- Failure this catches: foreground planner ownership, invalid-config fail-open, second repair, transient in-memory receipts, paused-as-terminal, duplicate follow-ups, and expected bindings mislabeled actual.

- [ ] **Step 1: Write RED manager/tool tests** asserting no `input` handler, additive bounded `before_agent_start` policy, exact disabled message, explicit main-task delivery, tool registration/schema, and direct `subagent` diagnostic guard.
- [ ] **Step 2: Write RED operation tests** for append/restore, root repair-slot ancestry, concurrent/sibling/repair-of-repair rejection, completion races, bounded reconciliation retry, terminal allowlist, in-session dedupe, at-least-once outbox replay, actual binding/candidate/path comparison, shutdown abort, and bounded unknown-event buffering.
- [ ] **Step 3: Register authority and capability ceiling by state**. Install a pessimistic empty-agent ceiling synchronously at session start. Valid enabled config gets deny-by-default launch authority plus strict agent/tool/extension ceiling. Invalid, incompatible, or watcher-failed config keeps the empty ceiling. Valid off disposes both only after a fresh committed revision. Watch the global file/directory with bounded polling fallback so every live session reacts fail-closed to on/off/malformed/recovery transitions.
- [ ] **Step 4: Register `ultra_delegate` with TypeBox** and sequential execution. Validate/reload current settings, enforce one repair, call protocol preflight/permit/spawn, persist the operation, and return receipt evidence without acceptance claims.
- [ ] **Step 5: Implement lifecycle persistence** with bounded `pi.appendEntry('ultra.operation.v1', snapshot)`, latest-per-operation restoration from the active branch, race buffer, bounded persisted status reconciliation, terminal dedupe, requested model/candidate/fixed expectation/actual model and changed-path evidence, plus a durable at-least-once outbox around `pi.sendMessage(..., {triggerTurn:true, deliverAs:'followUp'})`. Stable operation IDs make duplicate delivery explicit and safe.
- [ ] **Step 6: Implement commands/session lifecycle** with exact command contract, mode-independent diagnostics, `Ultra: on|off|blocked`, authority cleanup/revocation, listener/timer abort, and no stale-instance messages.
- [ ] **Step 7: Run GREEN/regressions and commit** `feat: make the main session manage ultra waves`.

## Task 6: Finish searchable model and atomic lane-range UI

**Files:**
- Rewrite: `extensions/ultra-menu.ts`
- Rewrite: `tests/ultra-menu.test.ts`

**Acceptance Contract:**
- User-visible behavior: `/ultra` offers searchable authenticated models from the full registry and one Small/Balanced/Large/Custom lane range control with atomic saves and recovery UI.
- Wiring proof command: `cd /home/sigma/pi-ultra/.worktrees/ultra-main-manager && node --import tsx --test tests/ultra-menu.test.ts`
- Expected output / observable behavior: ChoiceScreen exposes search metadata, deterministic canonical IDs, viewport 10, unavailable-current fallback, and one save for preset/custom ranges.
- Test-quality proof: real pi-tui-kit TUI and RPC harnesses navigate screens, filter a large catalog, inspect unfiltered RPC ordering, and assert save counts/rollback.
- Regression proof command: `cd /home/sigma/pi-ultra/.worktrees/ultra-main-manager && npm run typecheck && node --import tsx --test tests/ultra-config.test.ts tests/ultra-input.test.ts`
- Failure this catches: scoped-only models, saving display labels, inaccessible unavailable choices, independent min/max corruption, and invalid custom drafts writing state.

- [ ] **Step 1: Write RED screen/harness tests** for full registry sourcing, canonical dedupe/sort, provider/id/name search text, viewport/search flags, `currentItemId`/`initialItemId`, no-match/narrow-width behavior, and raw-ID saves.
- [ ] **Step 2: Write RED lane UI tests** for preset labels, one paired patch, custom `MIN-MAX` normalization, invalid zero-save correction, save rollback, and preset-name rendering.
- [ ] **Step 3: Implement model ChoiceScreen** with `enableSearch:true`, `viewportSize:10`, deterministic unfiltered RPC items, and disabled unavailable row.
- [ ] **Step 4: Implement one Lane range action** with Small `1–2`, Balanced `2–4`, Large `4–8`, and Custom input; call lock-scoped paired update exactly once.
- [ ] **Step 5: Add a discriminated valid/blocked menu input and backup/reset callback**, update truthful help/copy, and consume the committed fresh settings returned by every patch. Bare `/ultra` remains TUI-only; RPC harness coverage verifies pure deterministic unfiltered screen serialization rather than product-side RPC fuzzy search. Run GREEN/regressions and commit `feat: finish ultra model and lane controls`.

## Task 7: Pin, pack, install, and verify the complete release

**Files:**
- Modify: `/home/sigma/pi-subagents/README.md`
- Modify: `/home/sigma/pi-subagents/package-lock.json`
- Modify: `package.json`
- Modify: `package-lock.json`
- Rewrite: `README.md`
- Rewrite: `tests/ultra-smoke.mjs`
- Modify: `tests/package-layout.test.ts`

**Acceptance Contract:**
- User-visible behavior: Installing the pinned fork plus packed pi-ultra loads exactly one `/ultra` command and `ultra_delegate`, blocks an unpermitted one-agent launch under a `4–8` policy, and admits one exact four-lane selected-model wave.
- Wiring proof command: `cd /home/sigma/pi-ultra/.worktrees/ultra-main-manager && npm run smoke:packed`
- Expected output / observable behavior: isolated Pi RPC reports one command/tool, three strict agents, blocked direct launch, authorized receipt, and no planner assets or duplicate registrations.
- Test-quality proof: smoke installs tarballs into a fresh agent directory and starts actual Pi RPC with only packed extensions; source-file imports cannot satisfy it.
- Regression proof command: `cd /home/sigma/pi-subagents && npm run typecheck && npm run test:all && cd /home/sigma/pi-ultra/.worktrees/ultra-main-manager && npm run check && npm pack --dry-run && git diff --check`
- Failure this catches: undeclared local patches, wrong package instance, packed-file omissions, stale planner registration, runtime load failures, and policy bypass in the shipped artifact.

- [ ] **Step 1: Add RED packed smoke** that installs the pinned `meowsigma/pi-subagents` tarball and pi-ultra tarball without network access, launches Pi RPC, and performs the acceptance behavior above.
- [ ] **Step 2: Pin compatibility** to immutable fork commit `876c6629ab6faf1f9975e6270e2e3102f7e50a0b`, bundle that runtime dependency for pi-ultra API resolution, keep `typebox` as host peer plus pinned dev dependency, add `smoke:packed`, and ensure package files include strict agents but no planner prompts. Separately install the same fork commit as the active extension and prove cross-instance `Symbol.for` registry sharing.
- [ ] **Step 3: Update both READMEs** with main ownership, launch authority, blocked state, exact model behavior, lane presets, repair takeover, recovery, installation of the compatible fork, and evidence-not-acceptance semantics.
- [ ] **Step 4: Run both complete suites and packed smoke**, fix only through new failing regression tests, then commit pi-subagents docs/release metadata and pi-ultra release changes.
- [ ] **Step 5: Run a four-lane independent final review wave** covering authority closure, Ultra runtime/lifecycle, UI/config, and packaging/install. Resolve every Critical/Important finding and re-run the affected review.
- [ ] **Step 6: Push reviewed branches, merge pi-ultra through a normal merge commit, tag immutable release commits, and verify remote refs**. Open an upstream pi-subagents PR for the generic launch-authority API; production remains pinned to the reviewed fork commit until upstream publishes compatibility.
- [ ] **Step 7: Remove duplicate legacy package identities, install the exact merged/tagged fork and pi-ultra SHAs under `~/.pi/agent`, run `/reload`, and verify live source paths, `/ultra` status/menu, a blocked under-minimum launch, and an authorized four-lane wave in a disposable repository. Record settings backup/restore, run IDs, actual models, artifacts, cleanup, installed HEADs, and tarball hashes.
