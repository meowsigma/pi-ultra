# /ultra — configurable parallel worker waves for [Pi](https://github.com/earendil-works/pi-coding-agent)

A single prompt template that turns your main model into a **wave manager**: it decomposes a task into bounded lanes, launches cheap workers in parallel (worktree-isolated, resumable), then audits every diff itself before accepting anything.

The manager stays responsible for judgment; workers burn the brute-force tokens.

```text
/ultra migrate all REST endpoints to the new error envelope
/ultra lanes=3 fix issue #142 across api/ and web/
/ultra lanes=2 model=openrouter/deepseek/deepseek-v4-flash thinking=low — two independent module rewrites
```

## Install

```bash
pi install git:github.com/meowsigma/pi-ultra
# or pin a tag:
pi install git:github.com/meowsigma/pi-ultra@v0.1.0
# or try without installing:
pi -e git:github.com/meowsigma/pi-ultra
```

Then use `/ultra <task> [lanes=N] [model=provider/id] [thinking=level]` in any session. Requires [pi-subagents](https://www.npmjs.com/package/pi-subagents) for the actual delegation.

## What the manager does

1. **Parses configuration** from the request (`lanes`, `model`, `thinking`). Anything you omit, it chooses: lane count from real independent seams (2–4), cheapest capable worker for brute-force volume, lowest sufficient thinking level. Never max reasoning by default.
2. **Binds routing via named agents** — it writes a minimal `wave-<slug>.md` agent file (explicit `name:`, `model:`, `thinking:` frontmatter) instead of relying on per-launch overrides, then launches by agent name.
3. **Records a lane board** before launch: claimed files/seam per lane, isolation path, authority. Overlapping work merges into one lane; conflicting-seam requests are refused rather than merged badly.
4. **Launches one worktree-isolated, fresh-context, resumable child per lane** (falls back to disjoint file ownership outside git repos).
5. **Audits like it wrote the code itself**: reads every diff against its contract, reruns tests, sends precise repair contracts back to the same resumable lane, and only escalates to stronger models on classified-hard failures.
6. **Never accepts unaudited edits, never reimplements accepted worker output**, and refuses ceremonial waves for tasks too small to parallelize.

## Why named-agent bindings?

Per-launch `model:` parameters do not route reliably in every Pi launch environment (headless `-p` runs can drop them before spawn). Agent-frontmatter bindings are honored everywhere. `/ultra` therefore treats agent files as the routing mechanism of record — which also makes each wave's routing visible in `~/.pi/agent/agents/`.

## Example role bindings

[`examples/agents/`](examples/agents/) contains the role files this pattern was validated with (Ox Alpha / DeepSeek V4 Flash workers via OpenRouter, GPT-5.6 Luna/Terra/Sol via a ChatGPT subscription). They are **not auto-loaded** — copy the ones you want into `~/.pi/agent/agents/` and adjust models to your own providers:

| File | Binding idea |
|---|---|
| `luna.md` | fast lightweight worker, subscription route |
| `hard-manager.md` | escalation manager for genuinely hard problems |
| `debugger.md` | debugging worker with cheap fallback |
| `reviewer-cheap.md` | adversarial second-opinion reviewer |
| `test-worker.md` | test-writing specialist |

## Optional manager-side settings

Pair well with a `subagents` block in `~/.pi/agent/settings.json` so everyday delegations route cheaply even outside `/ultra`:

```json
{
  "defaultProvider": "openai-codex",
  "defaultModel": "gpt-5.6-terra",
  "subagents": {
    "defaultModel": "openrouter/stealth/ox-alpha",
    "agentOverrides": {
      "worker":   { "model": "openrouter/stealth/ox-alpha", "thinking": "high",
                    "fallbackModels": ["openrouter/deepseek/deepseek-v4-flash"] },
      "scout":    { "model": "openrouter/stealth/ox-alpha", "thinking": "low" },
      "reviewer": { "model": "openai-codex/gpt-5.6-terra", "thinking": "medium" },
      "oracle":   { "model": "openai-codex/gpt-5.6-sol", "thinking": "high" }
    }
  }
}
```

Adjust provider/model ids to whatever your registry actually offers — `/ultra` itself never hardcodes them.

## Known caveat

Headless `pi -p` sessions currently drop per-launch model params in pi-subagents ≤ 0.54.x. `/ultra`'s routing verification detects this and refuses mis-routed work loudly instead of accepting it. Run waves interactively, or pin `--model` at the `pi` invocation level for scripted use.

## License

MIT
