# pi-ultra

`pi-ultra` adds an `/ultra` controller to [Pi](https://github.com/earendil-works/pi-coding-agent). It plans bounded, independently auditable work lanes and delegates only when a task qualifies.

## Install and prerequisites

Pi and [`pi-subagents`](https://www.npmjs.com/package/pi-subagents) are required. Install the package with Pi:

```bash
pi install git:github.com/meowsigma/pi-ultra
# or pin a release
pi install git:github.com/meowsigma/pi-ultra@v0.1.0
```

Global settings live at `~/.pi/agent/pi-ultra.json`. A missing or malformed file is safe: Ultra falls back to its defaults rather than throwing or overwriting it.

```json
{
  "enabled": true,
  "routingMode": "role-defaults",
  "minLanes": 2,
  "maxLanes": 4
}
```

Lane bounds are inclusive `1`–`8`; the default is `2`–`4`. Choose lanes from real independent seams, not a fixed quota.

## Commands and behavior

- `/ultra` opens the configuration menu in TUI mode.
- `/ultra on`, `/ultra off`, and `/ultra toggle` control the controller.
- `/ultra help` shows command usage.
- `/ultra <task>` explicitly asks Ultra to assess and, when appropriate, run a wave.

When disabled, an explicit task is not delegated and reports that `/ultra on` is required. Passive input is also left to the main session unchanged. Passive eligibility is deliberately conservative: commands, social conversation, and ordinary prose bypass Ultra; only implementation-shaped requests are considered. A considered request that does not qualify for a wave is returned to the main session instead of forcing delegation.

A fleet is logical rather than a standing worker pool: only planned lanes are launched, so no idle paid workers are kept alive.

## Routing and verification

Choose one routing mode in the global config:

- `"uniform"` routes every selected lane to `workerModel` (or Pi's `automatic` selection when it is omitted).
- `"role-defaults"` uses the fixed `scout`, `worker`, and `reviewer` role defaults.

Before a lane launches, Ultra preflights the requested agent and available model. Missing agents, unavailable models, and other preflight failures are reported as diagnostics for explicit requests; Ultra does not silently substitute an unavailable route.

A completion receipt or result is evidence, not acceptance. The main session must inspect artifacts and diffs, run the stated validation, reconcile lane output, and make the final audit decision independently.

## License

MIT
