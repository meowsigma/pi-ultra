# Ultra Controller Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every task has an Acceptance Contract; do not mark a task complete until its Quality Gate review returns PASS.

**Goal:** Ship a Goal-style `/ultra` Pi extension that persists global delegation policy and passively launches only validated, bounded subagent waves.

**Architecture:** The extension owns ordinary-input eligibility, creates a structured plan through a packaged planner agent, validates the plan, and starts worker waves through pi-subagents RPC. Configuration, UI, subagent transport, and orchestration are separate modules. The active main model plans and audits; the selected Ultra worker model applies only to uniform worker lanes.

**Tech Stack:** TypeScript ESM Pi extension; `@earendil-works/pi-coding-agent`; `@earendil-works/pi-tui`; `@narumitw/pi-tui-kit`; `pi-subagents` structured delegation, preflight, and event-bus RPC; Node built-in test runner via `tsx`.

---

## File structure

| File | Responsibility |
|---|---|
| `package.json` | Package manifest, Pi extension/agent discovery, peer/runtime dependencies, scripts, packed files. |
| `tsconfig.json` | TypeScript checking for extension, agent-adjacent helpers, and tests. |
| `agents/ultra-planner.md` | Read-capable package planner whose model is inherited from the main session. |
| `prompts/ultra-planner.md` | Internal structured-plan instructions; not a slash template. |
| `prompts/ultra-manager.md` | Internal final-audit/integration instructions; not a slash template. |
| `extensions/ultra-config.ts` | Versioned settings validation, lock-aware load/save, model/bounds helpers. |
| `extensions/ultra-protocol.ts` | Structured-plan schema, planner request/reply bridge, pi-subagents readiness/RPC/preflight adapters, workflow generation. |
| `extensions/ultra-menu.ts` | Goal-style main menu, settings UI, and model picker. |
| `extensions/ultra.ts` | Extension entry point, `/ultra` parsing, passive `input` flow, controller state, status, and completion delivery. |
| `tests/ultra-config.test.ts` | Config defaults, malformed file, lock/write, range, and Automatic tests. |
| `tests/ultra-protocol.test.ts` | Planner/RPC readiness, plan validation, fixed-role, uniform routing, workflow, and completion tests. |
| `tests/ultra-input.test.ts` | Passive eligibility and request-origin/deduplication tests. |
| `tests/fixtures/fake-pi.ts` | Deterministic extension API/event/UI test harness. |
| `README.md` | Install prerequisites, commands, settings, routing, passive behavior, and diagnostics. |

## Shared contracts

Every implementation task uses these exact values. Do not rename them in later tasks.

```ts
export const ULTRA_CONFIG_VERSION = 1 as const;
export const ULTRA_MIN_LANES = 1;
export const ULTRA_MAX_LANES = 8;
export const ULTRA_ROLE_NAMES = ["scout", "worker", "reviewer"] as const;

export type RoutingMode = "uniform" | "role-defaults";
export type UltraRole = (typeof ULTRA_ROLE_NAMES)[number];

export interface UltraSettings {
  version: typeof ULTRA_CONFIG_VERSION;
  enabled: boolean;
  routingMode: RoutingMode;
  workerModel?: string;
  minLanes: number;
  maxLanes: number;
}

export interface PlannedLane {
  id: string;
  title: string;
  task: string;
  role: UltraRole;
  writes: boolean;
  independence: string;
}

export interface UltraPlan {
  outcome: "wave" | "no-wave" | "over-cap";
  rationale: string;
  lanes: PlannedLane[];
}
```

---

### Task 1: Make the package an installable, testable Pi extension

**Files:**
- Modify: `package.json`
- Create: `tsconfig.json`
- Create: `tests/fixtures/fake-pi.ts`
- Create: `tests/package-layout.test.ts`
- Delete: `prompts/ultra.md`

**Acceptance Contract:**
- User-visible behavior: installing the packed package exposes extension resources and exactly one extension-owned `/ultra` command rather than the legacy prompt template.
- Wiring proof command: `npm run check && npm test && npm pack --dry-run`
- Expected output / observable behavior: all checks pass; pack listing includes `extensions/`, `agents/`, and internal prompts but no exported prompt-template declaration.
- Test-quality proof: `tests/package-layout.test.ts` reads `package.json`, failing if required Pi entries/files or test scripts are disconnected.
- Regression proof command: `npm pack --dry-run | rg 'prompts/ultra\.md'`
- Failure this catches: publishing a prompt-only tarball, duplicate `/ultra` discovery, or extension source excluded from npm output.

- [ ] **Step 1: Write the failing package-layout test**

```ts
// tests/package-layout.test.ts
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));

test("package exposes Ultra as an extension and a pi-subagents agent", () => {
  assert.deepEqual(packageJson.pi.extensions, ["./extensions"]);
  assert.deepEqual(packageJson.pi.subagents.agents, ["./agents"]);
  assert.equal(packageJson.pi.prompts, undefined);
  for (const path of ["extensions", "agents", "prompts"]) {
    assert.ok(packageJson.files.includes(path), `${path} must be packed`);
  }
  assert.ok(existsSync("agents/ultra-planner.md"));
  assert.ok(existsSync("prompts/ultra-planner.md"));
  assert.ok(existsSync("prompts/ultra-manager.md"));
  assert.equal(existsSync("prompts/ultra.md"), false);
});
```

- [ ] **Step 2: Run the new test and verify it fails**

Run: `node --import tsx --test tests/package-layout.test.ts`

Expected: FAIL because extension resources, scripts, and internal assets do not exist.

- [ ] **Step 3: Add manifest, compiler, and internal-asset wiring**

Replace the `pi` section and scripts with this shape, keep package identity fields, and add the stated dependencies:

```json
{
  "type": "module",
  "files": ["extensions", "agents", "prompts", "examples", "README.md", "LICENSE"],
  "scripts": {
    "test": "node --import tsx --test tests/*.test.ts",
    "typecheck": "tsc --noEmit",
    "check": "npm run typecheck && npm test",
    "pack:check": "npm pack --dry-run"
  },
  "pi": {
    "extensions": ["./extensions"],
    "subagents": { "agents": ["./agents"] }
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": ">=0.84.0",
    "pi-subagents": ">=0.54.0"
  },
  "dependencies": {
    "@narumitw/pi-tui-kit": "^0.57.0"
  },
  "devDependencies": {
    "@earendil-works/pi-coding-agent": "0.84.2",
    "@earendil-works/pi-tui": "0.84.2",
    "pi-subagents": "0.54.0",
    "tsx": "^4.20.0",
    "typescript": "^5.9.0"
  }
}
```

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "target": "ES2022",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["extensions/**/*.ts", "tests/**/*.ts"]
}
```

Create these exact internal assets, then delete the exported `prompts/ultra.md`:

```md
<!-- agents/ultra-planner.md -->
---
name: ultra-planner
description: Read-only planner for validated Ultra worker waves
model: inherit
thinking: medium
tools: read, grep, find, ls
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: false
defaultContext: fresh
acceptanceRole: read-only
---

Inspect only the task and repository evidence needed to identify independent seams.
Return the requested structured plan. Do not edit files, create agents, call subagents,
or claim a worker wave ran. Use only scout, worker, and reviewer role intents.
```

```md
<!-- prompts/ultra-planner.md -->
Return one JSON object matching the supplied schema. A `wave` has genuinely independent
lanes only. A `no-wave` has no lanes. An `over-cap` plan names all needed lanes so the
caller can report the cap; do not consolidate unrelated work by inventing dependencies.

<!-- prompts/ultra-manager.md -->
You are receiving completed Ultra lane evidence. Audit contracts, actual model bindings,
diffs, tests, and residual risks before deciding integration. Do not treat completion as
acceptance, and do not launch additional workers outside the Ultra controller.
```

- [ ] **Step 4: Install declared development dependencies**

Run: `npm install`

Expected: `package-lock.json` is created/updated and `npm ls --depth=0` reports the declared development/runtime dependencies without unmet peers.

- [ ] **Step 5: Re-run package tests and typecheck**

Run: `npm run check && npm run pack:check`

Expected: PASS; dry-run lists `extensions`, `agents`, and internal prompt files.

- [ ] **Step 6: Run the regression proof**

Run: `npm pack --dry-run 2>&1 | rg 'prompts/ultra\.md'`

Expected: exit code 1 (the removed legacy prompt is absent).

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json agents prompts tests/package-layout.test.ts
git commit -m "feat: package ultra as a Pi extension"
```

### Task 2: Add global, lock-safe Ultra configuration

**Files:**
- Create: `extensions/ultra-config.ts`
- Create: `tests/ultra-config.test.ts`

**Acceptance Contract:**
- User-visible behavior: `/ultra` settings persist globally, reject invalid lane bounds, and never silently replace malformed configuration.
- Wiring proof command: `node --import tsx --test tests/ultra-config.test.ts`
- Expected output / observable behavior: tests prove default settings, existing valid settings, lock-protected writes, malformed-file rejection, and explicit Automatic behavior.
- Test-quality proof: a test writes `{"minLanes":4,"maxLanes":2}` and expects `normalizeUltraSettings` to return `undefined`; it fails if bounds validation is removed.
- Regression proof command: `npm test`
- Failure this catches: partial/invalid settings writes, stale lost updates, invalid ranges, and uniform Automatic resolving per-lane.

- [ ] **Step 1: Write failing config tests**

```ts
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_ULTRA_SETTINGS,
  loadUltraSettings,
  normalizeUltraSettings,
  saveUltraSettings,
} from "../extensions/ultra-config.ts";

test("rejects a reversed lane range", () => {
  assert.equal(normalizeUltraSettings({ minLanes: 4, maxLanes: 2 }), undefined);
});

test("does not overwrite malformed settings", () => {
  const path = join(mkdtempSync(join(tmpdir(), "ultra-config-")), "pi-ultra.json");
  writeFileSync(path, "{not json", "utf8");
  assert.throws(() => saveUltraSettings(DEFAULT_ULTRA_SETTINGS, path));
  assert.equal(readFileSync(path, "utf8"), "{not json");
});

test("persists a validated update under the config lock", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "ultra-config-")), "pi-ultra.json");
  await saveUltraSettings({ ...DEFAULT_ULTRA_SETTINGS, enabled: false }, path);
  assert.deepEqual(loadUltraSettings(path), {
    kind: "loaded",
    settings: { ...DEFAULT_ULTRA_SETTINGS, enabled: false },
  });
});
```

- [ ] **Step 2: Run the tests and verify failure**

Run: `node --import tsx --test tests/ultra-config.test.ts`

Expected: FAIL because `extensions/ultra-config.ts` does not exist.

- [ ] **Step 3: Implement the settings contract**

Implement these exported values and functions exactly:

```ts
export const ULTRA_SETTINGS_FILE = "pi-ultra.json";
export const DEFAULT_ULTRA_SETTINGS: UltraSettings = {
  version: 1,
  enabled: true,
  routingMode: "role-defaults",
  minLanes: 2,
  maxLanes: 4,
};

export function normalizeUltraSettings(value: unknown): UltraSettings | undefined;
export function loadUltraSettings(path?: string):
  | { kind: "missing"; settings: UltraSettings }
  | { kind: "loaded"; settings: UltraSettings }
  | { kind: "invalid"; reason: string; settings: UltraSettings };
export async function saveUltraSettings(settings: UltraSettings, path?: string): Promise<void>;
export function effectiveUniformModel(settings: UltraSettings): string | "automatic" | undefined;
```

`normalizeUltraSettings` must merge omitted fields with `DEFAULT_ULTRA_SETTINGS`, accept only `version === 1`, `routingMode` values `uniform`/`role-defaults`, an optional trimmed nonempty `workerModel`, and safe integer bounds from 1 through 8 with `minLanes <= maxLanes`. `effectiveUniformModel` returns `undefined` in role-default mode, `"automatic"` for uniform mode without `workerModel`, and the selected model otherwise.

Use `mkdir(lockPath)` with `recursive: false` as an exclusive lock, retry `EEXIST` until a 2-second deadline, then re-read/validate before serializing to a UUID-named temporary file and `rename`. Always remove the temporary file and lock directory in `finally`. Never write after `loadUltraSettings` reports `invalid`.

- [ ] **Step 4: Run focused config tests**

Run: `node --import tsx --test tests/ultra-config.test.ts`

Expected: PASS with all config cases green.

- [ ] **Step 5: Add concurrent-write and Automatic test cases**

Add tests that `await Promise.all` on two `saveUltraSettings` calls, assert the final JSON parses and normalizes, and assert:

```ts
assert.equal(effectiveUniformModel({ ...DEFAULT_ULTRA_SETTINGS, routingMode: "role-defaults" }), undefined);
assert.equal(effectiveUniformModel({ ...DEFAULT_ULTRA_SETTINGS, routingMode: "uniform" }), "automatic");
```

- [ ] **Step 6: Run acceptance and regression proofs**

Run: `node --import tsx --test tests/ultra-config.test.ts && npm test`

Expected: PASS; no other test file regresses.

- [ ] **Step 7: Commit**

```bash
git add extensions/ultra-config.ts tests/ultra-config.test.ts
git commit -m "feat: persist validated ultra settings"
```

### Task 3: Implement planner, preflight, and RPC protocol adapters

**Files:**
- Create: `extensions/ultra-protocol.ts`
- Create: `tests/ultra-protocol.test.ts`

**Acceptance Contract:**
- User-visible behavior: Ultra never launches a wave until a compatible pi-subagents runtime returns a structured valid plan and each lane passes policy/preflight validation.
- Wiring proof command: `node --import tsx --test tests/ultra-protocol.test.ts`
- Expected output / observable behavior: tests observe a `prompt-template:subagent:request` for `ultra-planner`, reject arbitrary roles/over-cap plans, and emit one async RPC `spawn` request only for a valid wave.
- Test-quality proof: the arbitrary-role test uses `{ role: "debugger" }` and expects validation failure; it fails if planner output can select unrestricted agent names.
- Regression proof command: `npm test && npm run typecheck`
- Failure this catches: advisory-only planning, missing pi-subagents readiness, unsafe agent selection, incorrect RPC payloads, and unverified uniform model binding.

- [ ] **Step 1: Write failing protocol tests around the public event contracts**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { createFakePi } from "./fixtures/fake-pi.ts";
import {
  requestPlan,
  validatePlan,
  buildWaveWorkflow,
  SUBAGENT_RPC_READY_EVENT,
} from "../extensions/ultra-protocol.ts";

test("rejects a lane that names a non-roster role", () => {
  assert.throws(() => validatePlan({
    outcome: "wave", rationale: "two seams", lanes: [
      { id: "a", title: "A", task: "A", role: "scout", writes: false, independence: "read-only" },
      { id: "b", title: "B", task: "B", role: "debugger", writes: true, independence: "separate files" },
    ],
  }, { minLanes: 2, maxLanes: 4 }), /unsupported role/i);
});

test("builds an async worktree workflow for a valid writing lane", () => {
  const script = buildWaveWorkflow([{ id: "impl", title: "Implement", task: "Change src/a.ts", role: "worker", writes: true, independence: "src/a.ts" }], "worker");
  assert.match(script, /runs\.run\("impl"/);
  assert.match(script, /worktree: true/);
  assert.match(script, /context: "fresh"/);
});
```

- [ ] **Step 2: Run protocol tests and verify failure**

Run: `node --import tsx --test tests/ultra-protocol.test.ts`

Expected: FAIL because `extensions/ultra-protocol.ts` and fake event harness do not exist.

- [ ] **Step 3: Implement exact public API adapters**

Use `pi-subagents/delegation` exports for structured delegation event names and use these stable RPC strings locally because pi-subagents does not export its RPC constants:

```ts
export const SUBAGENT_RPC_READY_EVENT = "subagents:rpc:v1:ready";
export const SUBAGENT_RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
export const subagentRpcReplyEvent = (id: string) => `subagents:rpc:v1:reply:${id}`;
```

Export and implement:

```ts
export async function waitForSubagentCapabilities(events: EventBus, timeoutMs = 1_500): Promise<SubagentCapabilities>;
export async function requestPlan(input: PlannerInput): Promise<UltraPlan>;
export function validatePlan(plan: UltraPlan, bounds: Pick<UltraSettings, "minLanes" | "maxLanes">): ValidatedPlan;
export async function preflightLane(input: PreflightInput): Promise<ResolvedLane>;
export function buildWaveWorkflow(lanes: ResolvedLane[], agent: string): string;
export async function spawnWave(events: EventBus, script: string, cwd: string): Promise<AsyncWaveReceipt>;
```

`requestPlan` emits a structured delegation request with a UUID `requestId`, matching `ownerRunId`, `nodeId: "ultra-plan"`, `agent: "ultra-planner"`, `context: "fresh"`, and a JSON-object result schema. It accepts only a terminal `completed` structured response with exactly `outcome`, `rationale`, and bounded lanes. It unsubscribes listeners and rejects on timeout/failure.

`validatePlan` validates identifiers against `/^[a-z][a-z0-9-]{0,47}$/`, title/task/rationale bounds, unique lane IDs, and roles strictly in `ULTRA_ROLE_NAMES`. A valid `wave` requires a lane count in range; `no-wave` must have zero lanes; `over-cap` must have more than `maxLanes` lanes and never launches.

`preflightLane` imports `resolveSubagentLaunchContract` from `pi-subagents/preflight`, passes `context: "fresh"`, `cwd`, the requested fixed role/uniform worker agent, and `availableModels: ctx.modelRegistry.getAvailable()`. It rejects `!ok`, mismatched uniform effective model, unavailable tools, or a mutation lane that cannot use a git worktree.

`buildWaveWorkflow` returns JSON-stringified literal values only; no planner text is interpolated as executable JavaScript. Each writing lane has `worktree: true`; each lane has `context: "fresh"`, an explicit read/write authority sentence in `task`, and `output: true`. `spawnWave` emits RPC `spawn` with `{ workflowScript: script, async: true, context: "fresh", cwd }`, waits for the correlated reply, and records the returned async run ID.

- [ ] **Step 4: Implement the fake event bus and focused tests**

Create `tests/fixtures/fake-pi.ts` with a synchronous `on`/`emit` event bus that returns unsubscribe functions, captures emitted payloads, and exposes `emitReady()`/`replyRpc()` helpers. Add tests for readiness timeout, a completed structured planner response, no-wave/over-cap rejection, arbitrary roles, unique IDs, safe JSON escaping in workflow generation, RPC failure, and model mismatch.

- [ ] **Step 5: Run focused protocol tests**

Run: `node --import tsx --test tests/ultra-protocol.test.ts`

Expected: PASS; a valid wave emits exactly one correlated RPC spawn request.

- [ ] **Step 6: Run acceptance and regression proofs**

Run: `node --import tsx --test tests/ultra-protocol.test.ts && npm test && npm run typecheck`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add extensions/ultra-protocol.ts tests/ultra-protocol.test.ts tests/fixtures/fake-pi.ts
git commit -m "feat: add validated ultra subagent protocol"
```

### Task 4: Build the Goal-style menu and settings picker

**Files:**
- Create: `extensions/ultra-menu.ts`
- Create: `tests/ultra-menu.test.ts`

**Acceptance Contract:**
- User-visible behavior: bare `/ultra` presents enable/disable, settings, help, and close; settings persist routing mode, selected model/Automatic, and lane bounds.
- Wiring proof command: `node --import tsx --test tests/ultra-menu.test.ts`
- Expected output / observable behavior: the menu header includes `Ultra`, state, routing, model, and `Lanes: min–max`; selecting a value calls the supplied validated save callback.
- Test-quality proof: a model-picker test selects `Automatic` and asserts `workerModel` is removed rather than changed to a bogus model ID.
- Regression proof command: `npm test`
- Failure this catches: a menu that only looks correct but does not mutate config, stale/unavailable models being silently selected, and invalid ranges saved from UI.

- [ ] **Step 1: Write failing pure menu-state tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { buildMainMenu, applySetting } from "../extensions/ultra-menu.ts";

const settings = { version: 1, enabled: true, routingMode: "uniform" as const, workerModel: "openai/model-a", minLanes: 2, maxLanes: 4 };

test("main menu reports the active routing policy", () => {
  const menu = buildMainMenu(settings);
  assert.match(menu.lines.join("\n"), /Ultra · Enabled/);
  assert.match(menu.lines.join("\n"), /One model for every lane/);
  assert.match(menu.lines.join("\n"), /Lanes: 2–4/);
});

test("Automatic clears the selected model", () => {
  assert.deepEqual(applySetting(settings, "workerModel", "Automatic"), { ...settings, workerModel: undefined });
});
```

- [ ] **Step 2: Run menu tests and verify failure**

Run: `node --import tsx --test tests/ultra-menu.test.ts`

Expected: FAIL because the menu module does not exist.

- [ ] **Step 3: Implement menu state and TUI screens**

Use `defineMenu`/`runMenu` from `@narumitw/pi-tui-kit`, following the installed pi-goal pattern. Export pure `buildMainMenu` and `applySetting` for tests. The menu must use these exact labels:

```ts
const MAIN_ACTIONS = ["Enable Ultra", "Disable Ultra", "Settings…", "Help", "Close"] as const;
const ROUTING_LABELS = {
  uniform: "One model for every lane",
  "role-defaults": "Role defaults",
} as const;
```

The Settings screen must show `Ultra`, `Routing mode`, `Worker model`, `Minimum subagents`, and `Maximum subagents`. The model picker derives its values from `ctx.scopedModels` when nonempty, otherwise `ctx.modelRegistry.getAvailable()`, displays `Automatic` first, and adds an unavailable saved model as a disabled/read-only detail rather than selecting a substitute. Lane selectors expose integers 1–8 and call the supplied `save(nextSettings)` only after `normalizeUltraSettings(nextSettings)` succeeds.

- [ ] **Step 4: Add UI adapter tests**

Test disabled headers/actions, role-default label, unavailable model detail, min/max rejection, and that a successful action invokes `save` exactly once with the complete next settings object.

- [ ] **Step 5: Run focused menu tests**

Run: `node --import tsx --test tests/ultra-menu.test.ts`

Expected: PASS.

- [ ] **Step 6: Run acceptance and regression proofs**

Run: `node --import tsx --test tests/ultra-menu.test.ts && npm test`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add extensions/ultra-menu.ts tests/ultra-menu.test.ts
git commit -m "feat: add ultra control menu"
```

### Task 5: Wire `/ultra`, passive request ownership, and wave completion into the extension

**Files:**
- Create: `extensions/ultra.ts`
- Create: `tests/ultra-input.test.ts`
- Modify: `tests/fixtures/fake-pi.ts`

**Acceptance Contract:**
- User-visible behavior: `/ultra on|off|toggle` changes global state; `/ultra <task>` is rejected while off; enabled eligible ordinary code tasks are planned once, launch only valid waves, and completion returns a bounded summary to the main session.
- Wiring proof command: `node --import tsx --test tests/ultra-input.test.ts`
- Expected output / observable behavior: a captured input event for `"scan the repository and implement the auth migration"` is handled by Ultra once; `"hello"`, `"/ultra"`, and `"thanks"` continue normally; disabled explicit tasks notify `Run /ultra on first.`
- Test-quality proof: the duplicate-origin test passes an Ultra-owned marker through a queued message and asserts no second planner request; it fails if the controller loops or double-launches.
- Regression proof command: `npm run check`
- Failure this catches: passive mode applied to every message, explicit command falling through while disabled, duplicate plans, callback leaks, and un-audited completion acceptance.

- [ ] **Step 1: Write failing input/controller tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { classifyUltraInput, ULTRA_OWNED_PREFIX } from "../extensions/ultra.ts";

test("only considers substantive coding work", () => {
  assert.equal(classifyUltraInput("hello"), "bypass");
  assert.equal(classifyUltraInput("thanks"), "bypass");
  assert.equal(classifyUltraInput("/ultra"), "bypass");
  assert.equal(classifyUltraInput("scan the codebase and implement the auth migration"), "consider");
});

test("does not re-plan an Ultra-owned handoff", () => {
  assert.equal(classifyUltraInput(`${ULTRA_OWNED_PREFIX}scan the codebase`), "owned");
});
```

- [ ] **Step 2: Run controller tests and verify failure**

Run: `node --import tsx --test tests/ultra-input.test.ts`

Expected: FAIL because the extension entry point does not exist.

- [ ] **Step 3: Implement command and passive controller flow**

Register exactly one command:

```ts
pi.registerCommand("ultra", {
  description: "Configure or run Ultra's validated subagent controller",
  handler: async (args, ctx) => {
    await handleUltraCommand(args.trim(), ctx);
  },
});
```

Parse only `""`, `"on"`, `"off"`, `"toggle"`, `"help"`, and nonempty task text. Bare command opens `showUltraMenu` only in `ctx.mode === "tui"`; non-TUI command invocations throw `new Error("/ultra menu requires TUI mode; use /ultra on, /ultra off, or /ultra toggle.")`. `on`, `off`, and `toggle` reload, update, lock-save, and refresh the `ultra` status value. Disabled explicit tasks notify/throw `Run /ultra on first.` and must not call planner/RPC adapters.

Implement:

```ts
export const ULTRA_OWNED_PREFIX = "<pi-ultra-owned>";
export function classifyUltraInput(text: string): "bypass" | "consider" | "owned";
```

The `input` handler returns `{ action: "continue" }` for bypass/owned events and `{ action: "handled" }` only after it has passed eligible original text to `runUltraController`. That controller calls `requestPlan`; for an in-range plan, calls preflight/spawn and emits a displayable `pi.sendMessage({ customType: "ultra-wave", ... })`. For passive below-minimum/over-cap outcomes it requeues the original text prefixed with `ULTRA_OWNED_PREFIX` via `pi.sendUserMessage`; for explicit below-minimum it requeues a main-manager packet naming `no qualified wave` and the original task. Strip the marker in a `before_agent_start` handler so the LLM never sees internal control text.

Store run receipts by async run ID. Subscribe to pi-subagents’ advertised async-complete event; when a matching receipt completes, send a bounded `ultra-wave` result message containing lane IDs, resolved agents/models, artifact paths, validation requirements, and the internal `ultra-manager.md` instructions. Do not send success/acceptance claims.

- [ ] **Step 4: Add command, deduplication, disabled, and completion tests**

Extend the fake Pi harness to capture registered commands, `input` handlers, `before_agent_start` handlers, `sendUserMessage`, `sendMessage`, status values, and notification/error text. Add tests for `on`, `off`, `toggle`, disabled tasks, explicit valid wave, passive valid wave, passive no-wave requeue, explicit no-wave requeue, an RPC completion event, and listener disposal at `session_shutdown`.

- [ ] **Step 5: Run focused controller tests**

Run: `node --import tsx --test tests/ultra-input.test.ts`

Expected: PASS.

- [ ] **Step 6: Run acceptance and regression proofs**

Run: `npm run check`

Expected: PASS across package, config, protocol, menu, and controller tests.

- [ ] **Step 7: Commit**

```bash
git add extensions/ultra.ts tests/ultra-input.test.ts tests/fixtures/fake-pi.ts
git commit -m "feat: run ultra controller passively"
```

### Task 6: Verify real Pi behavior and document the controller

**Files:**
- Modify: `README.md`
- Modify: `tests/package-layout.test.ts`
- Create: `tests/ultra-smoke.mjs`

**Acceptance Contract:**
- User-visible behavior: users can install prerequisites, understand passive eligibility and routing modes, operate `/ultra`, and diagnose unavailable pi-subagents/model/role errors.
- Wiring proof command: `npm run check && npm pack && node tests/ultra-smoke.mjs ./pi-ultra-*.tgz`
- Expected output / observable behavior: tarball installation smoke test finds one `/ultra` command; README documents global `pi-ultra.json`, direct commands, role roster, uniform mode, logical fleet semantics, and compatibility prerequisites.
- Test-quality proof: smoke script exits nonzero when extension/agent files are absent from the tarball or duplicate `/ultra` command discovery occurs.
- Regression proof command: `npm pack --dry-run && git diff --check`
- Failure this catches: a locally working extension omitted from release, stale prompt-template instructions, and undocumented dangerous/passive behavior.

- [ ] **Step 1: Write the failing tarball smoke test**

Create `tests/ultra-smoke.mjs` with this executable shape (the worker may add bounded JSONL parsing helpers but must retain these assertions):

```js
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tarball = process.argv[2];
assert.ok(tarball, "usage: node tests/ultra-smoke.mjs <tarball>");
const files = execFileSync("tar", ["-tf", tarball], { encoding: "utf8" }).split("\n");
for (const file of ["package/extensions/ultra.ts", "package/agents/ultra-planner.md", "package/prompts/ultra-planner.md", "package/prompts/ultra-manager.md"]) {
  assert.ok(files.includes(file), `tarball missing ${file}`);
}
assert.equal(files.includes("package/prompts/ultra.md"), false);

const root = mkdtempSync(join(tmpdir(), "pi-ultra-smoke-"));
const agentDir = join(root, "agent");
const project = join(root, "project");
execFileSync("mkdir", ["-p", project]);
const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
execFileSync("pi", ["install", "-l", tarball, "--approve"], { cwd: project, env, stdio: "inherit" });
const rpc = spawnSync("pi", ["--mode", "rpc", "--no-session", "--approve"], {
  cwd: project,
  env,
  input: '{"id":"commands","type":"get_commands"}\n',
  encoding: "utf8",
});
assert.equal(rpc.status, 0, rpc.stderr);
const messages = rpc.stdout.trim().split("\n").map((line) => JSON.parse(line));
const response = messages.find((message) => message.id === "commands" && message.command === "get_commands");
assert.ok(response?.success, "get_commands must succeed");
const ultra = response.data.commands.filter((command) => command.name === "ultra");
assert.equal(ultra.length, 1, "exactly one /ultra command must be discovered");
console.log("ultra smoke: PASS");
```

The script receives one tarball path, isolates `PI_CODING_AGENT_DIR`, installs it locally, then uses the RPC `get_commands` protocol to assert exactly one `ultra` command.

- [ ] **Step 2: Run smoke test and verify failure before documentation/wiring is complete**

Run: `npm pack && node tests/ultra-smoke.mjs ./pi-ultra-0.1.0.tgz`

Expected: FAIL until the package tarball and extension discovery are correctly wired.

- [ ] **Step 3: Document the released behavior**

Rewrite README sections to include:

```md
## Prerequisites

Install and enable `pi-subagents` separately. `/ultra` fails closed if its runtime
is absent or incompatible; run `/reload` after installing it.

## Commands

- `/ultra` — control menu
- `/ultra on|off|toggle` — global controller state
- `/ultra <task>` — explicit controller request

## Routing and lanes

`One model for every lane` uses the selected worker model. `Role defaults` maps
reconnaissance to `scout`, implementation/debugging to `worker`, and validation
to `reviewer`. `minLanes` is an eligibility threshold; Ultra never invents lanes.
```

Document the exact JSON schema/defaults, 1–8 inclusive range, Automatic semantics, passive classifier limitations, no idle worker process guarantee, failure messages, and model-result verification.

- [ ] **Step 4: Make package-layout test inspect packed contents**

Use `execFileSync("npm", ["pack", "--json"])` in a temporary fixture or parse `npm pack --dry-run --json`; assert packed file paths contain all extension/agent/internal assets and omit `prompts/ultra.md`.

- [ ] **Step 5: Run focused smoke/package tests**

Run: `node --import tsx --test tests/package-layout.test.ts && npm pack && node tests/ultra-smoke.mjs ./pi-ultra-0.1.0.tgz`

Expected: PASS and print `ultra smoke: PASS`.

- [ ] **Step 6: Run full release verification**

Run: `npm run check && npm pack --dry-run && git diff --check`

Expected: all tests/typecheck pass, the dry-run file list is complete, and there is no whitespace error.

- [ ] **Step 7: Commit**

```bash
git add README.md tests/package-layout.test.ts tests/ultra-smoke.mjs package-lock.json
git commit -m "docs: document ultra controller"
```

## Final quality gate

- [ ] Review `git log --oneline main..HEAD` and confirm commits correspond to Tasks 1–6.
- [ ] Run `npm run check` and record the full passing output.
- [ ] Run `npm pack --dry-run` and confirm extension, planner agent, and internal prompts are shipped.
- [ ] Install/test the generated tarball with `tests/ultra-smoke.mjs` in a temporary Pi config.
- [ ] Run `git status --short`; expected output is empty.
- [ ] Request a fresh read-only review of the implementation and resolve any blocker/major findings before merge.
