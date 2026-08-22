---
description: Launch a configurable parallel worker wave — specify task, optionally lanes/model/thinking; manager audits everything
argument-hint: <task> [lanes=N] [model=provider/id] [thinking=off|minimal|low|medium|high|xhigh|max]
---

Coordinate a parallel implementation wave for: $ARGUMENTS

## Parse configuration from the request

Extract any of `lanes=<N>`, `model=<provider/id>`, `thinking=<level>` from the arguments. Everything else is the task. If unspecified:

- **lanes**: choose 2–4 based on how many genuinely independent seams the task has. Fewer is better than fake parallelism.
- **model**: choose the cheapest capable worker available, escalating only if task difficulty demands it. Prefer free/cheap routes for brute-force volume. State your choice and why in one line before launching.
- **thinking**: lowest level that fits the subtask difficulty (mechanical → low; multi-file logic → medium; genuinely hard lane → high/xhigh). Never max by default.

These rules apply regardless of which model you yourself are running: never assume your own model name, provider, or agent roster — check what actually exists via `subagent { action: "list" }` and the live registry before choosing.

## Routing: bind models via named agents, never per-launch overrides

Per-launch `model:`/`thinking:` parameters do not route reliably in every launch environment. Agent-level bindings do. Therefore:

1. Map each lane to an existing named agent whose binding matches your target (e.g. whichever configured agents pin your desired model/thinking).
2. If no existing agent matches a lane's requested model/thinking, FIRST write a minimal agent file to the user agents directory (`~/.pi/agent/agents/wave-<slug>.md`) — it MUST include an explicit `name: wave-<slug>` field (filename-derived names do not register), plus `model:` and `thinking:` in the frontmatter and a one-line generic worker prompt. THEN launch that lane by agent name. Reuse one file for all lanes sharing identical routing; remove the file when the wave completes if it was one-off.
3. Never rely on per-run `model=`/`thinking=` overrides for this wave. If you cannot bind a lane's routing through an agent file, say so instead of launching mis-routed work.

## Fleet mechanics

- Launch lanes as separate single-child subagent delegations issued together in one batch (parallel tool calls) — this is the most portable execution shape. Use a scripted workflow only if lanes need chaining, gates, or steering.
- Each lane: `worktree: true` when the repo is a git repository (skip worktrees otherwise and give lanes disjoint file ownership plus explicit cwd), context `fresh`, resumable so repairs return to the SAME child.
- Before launch record a lane board: Lane | agent name | claimed files/seam | isolation path | authority | next gate. Overlapping work merges into one lane.

## Worker contracts

Each lane gets: exact objective, owned files, constraints, what NOT to change, validation steps (run the tests), expected evidence. No vague dumps.

## Manager audit duties (non-negotiable)

Hold worker output to exactly the standard you would meet doing it yourself:

0. ROUTING VERIFICATION: when each lane returns, check its result metadata `model` field against the agent's binding. On mismatch, treat as failed launch: report it explicitly and relaunch that lane. Never silently accept mis-routed work.
1. Await completion, then read every lane diff yourself against its contract before accepting anything.
2. Verify success criteria with real commands (tests, builds), not worker claims alone.
3. Bounded defects → precise repair request back to the same resumable lane → re-audit.
4. Escalate by classification only: retry cheap on another worker for recoverable defects; escalate to the strongest available reasoning capability only for genuinely hard problems.
5. Never reimplement accepted worker output; never accept unaudited edits.

Report at the end: per-lane agent + actual model used, tokens/cost where reported, tests/validation run, verdicts, integrated result, residual risks.

If the task is too small to warrant multiple lanes (single-file change, tiny edit), say so and use fewer lanes or do it directly — never ceremonial delegation.
