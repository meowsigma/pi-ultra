# /ultra — persistent manager mode for [Pi](https://github.com/earendil-works/pi-coding-agent)

`pi-ultra` makes `/ultra` a durable toggle, not a one-turn prompt expansion. While it is on, every agent turn — including compaction recovery, `/goal` continuations, and other workflows — receives a manager-worker delegation policy.

The primary agent owns decisions, decomposition, integration, validation, and accountability. It delegates only bounded implementation, exploration, research, and test work to the cheapest capable workers, then audits every returned diff and command result itself.

## Install

```bash
pi install git:github.com/meowsigma/pi-ultra
```

`pi-ultra` expects [pi-subagents](https://www.npmjs.com/package/pi-subagents) when you want the manager to delegate work. Install it separately if it is not already present:

```bash
pi install npm:pi-subagents
```

After installing or updating, start a new Pi session or use `/reload`.

## Usage

```text
/ultra       # toggle
/ultra on    # force on
/ultra off   # force off
```

The setting is global, like `pi-effort`'s `/fast` toggle, and stays active until you explicitly turn it off. `⚡ultra` appears in the footer while enabled.

Use it with a goal by arming Ultra first:

```text
/ultra on
/goal Ship the migration: tests green, build clean, docs updated
```

The goal supplies the outcome and completion evidence; Ultra supplies the persistent delegation discipline for each subsequent turn.

## Manager policy

When enabled, the system prompt tells the primary agent to:

- inspect the live agent roster with `subagent { action: "list" }` and choose the cheapest capable worker;
- delegate only bounded packages; retain decisions requiring the primary context;
- use disjoint ownership, fresh context, and worktrees for parallel write lanes;
- record lane ownership and validation gates before launching workers;
- bind model routing through named agents and verify returned model metadata;
- audit each diff and rerun real validation before accepting it; return bounded defects to the same worker for repair;
- work directly when delegation would be ceremonial or cost more than it saves.

Your existing `AGENTS.md`, named agents, and explicit user constraints remain authoritative. The policy intentionally names common roles only as examples; the live roster is the source of truth.

## State file

The toggle is stored atomically at:

```text
~/.pi/agent/pi-ultra.json
```

The optional `note` property is appended to the manager policy, which is useful for local rules such as a lane cap or worker preference:

```json
{
  "enabled": true,
  "note": "Use at most two concurrent workers unless the task has disjoint ownership."
}
```

Treat this as trusted local configuration: the note becomes part of the system prompt.

## Migrating from v0.1

v0.1 provided a one-shot `/ultra <task>` prompt template. v0.2 intentionally removes that template to avoid a command collision and to let manager mode survive goal continuations and compaction. Replace old task invocations with `/ultra on`, then state the task normally (or set a `/goal`).

## Development

```bash
npm install
npm test
npm run check
```

## License

MIT
