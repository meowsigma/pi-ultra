# Ultra 100-Lane Custom Range and Pi Goal-X Compatibility design

**Status:** Approved for planning

## Objective

Raise Ultra's custom per-wave lane range ceiling from eight to one hundred while retaining its exact, atomic, permit-governed `runs.all` launch contract. Verify and document safe coexistence with `pi-goal-x` without coupling Ultra to Goal-X private implementation details.

## Scope

This change affects Ultra lane bounds only. Preset ranges remain:

- Small: `1–2`
- Balanced: `2–4`
- Large: `4–8`

Custom ranges accept inclusive integer bounds satisfying:

```
1 <= minLanes <= maxLanes <= 100
```

No batching, concurrency queue, filler lanes, or automatic lane decomposition is introduced. A permitted 100-lane custom wave is one genuine static `runs.all` request for 100 independently specified lanes.

## Execution compatibility

The pinned `pi-subagents` runtime accepts static workflow manifests with up to 256 children. Therefore Ultra's new ceiling is within its launch authority and workflow parser capacity. Ultra must continue to issue a permit whose lane manifest exactly matches the preflighted workflow; it must never silently truncate or batch lanes.

A 100-lane launch represents 100 concurrent model calls. Provider capacity, quotas, cost, worktree volume, or rate limits may prevent an individual launch from succeeding. Those failures remain visible to the manager; Ultra does not weaken its preflight or authority rules to compensate.

## User experience

The Custom lane-range menu entry and correction loop say `1–100`. Invalid custom input remains in the correction loop. Settings/global/session snapshots containing values from 9 through 100 become valid after upgrade; values above 100 remain invalid and retain current fail-closed global/session behavior.

The menu help and README explicitly warn:

> A custom 100-lane wave launches 100 workers concurrently. Choose a range that your provider limits and budget can sustain.

## Pi Goal-X coexistence boundary

Pi Goal-X `0.30.0` is compatible as a peer extension:

- Both extensions append policy to `before_agent_start` and observe lifecycle/tool events through Pi's extension event bus.
- Goal-X persists goals, task state, auto-continuation, and independent completion auditing; Ultra persists only its own settings and operation evidence.
- Ultra worker lanes are isolated and do not receive ambient extensions, so Goal-X does not enter worker sessions.
- Main-session manager behavior is preserved: it alone invokes `ultra_delegate`, reviews worker receipts, and decides whether to update a Goal-X task or request goal completion.

Ultra must not import, inspect, or mutate Goal-X's private `_goalCore` or on-disk/journal formats. It must not auto-complete Goal-X tasks from worker claims, suppress Goal-X auto-continuation, or alter Goal-X auditing. Such behavior would make untrusted worker output lifecycle authority.

### Recommended joint workflow

1. Create or resume a Goal-X goal/task in the main session.
2. The manager delegates an exact Ultra wave when independent work is useful.
3. The manager validates operation receipts and repository evidence.
4. Only then does the manager explicitly use Goal-X task/goal tools to record verified progress or completion.

## Validation

Automated coverage must prove:

1. Config/global/session validation accepts exactly the inclusive upper bound of 100 and rejects 101.
2. Delegate validation and tool schema accept 100 lanes under a `1–100` effective policy.
3. Workflow construction emits all 100 lanes in one static `runs.all` script, preserving lane order and worker-only worktrees.
4. The existing strict preflight and one-use permit flow remains unchanged for high-count waves.
5. Menu parsing and text accept/display `1–100` and reject out-of-bounds input.
6. A Goal-X-like peer lifecycle extension can coexist with Ultra's prompt and tool hooks without bypassing Ultra authority; the test must not depend on Goal-X private internals.
7. README documentation accurately describes the new ceiling, atomic concurrency behavior, and Goal-X operating boundary.

## Non-goals

- Batching or provider-aware scheduling.
- Raising `pi-subagents`' 256-child static workflow ceiling.
- A runtime dependency on `pi-goal-x`.
- Automatic Goal-X task updates, goal completion, or auditor interaction.
- Changes to preset lane ranges or manager/final-review ownership.
