# Ultra 100-Lane Custom Range and Pi Goal-X Compatibility Implementation Plan

> **For implementers:** Work from this plan test-first. Do not weaken preflight, one-use permits, or atomic-wave semantics to make high-count launches pass.

**Goal:** Permit a custom Ultra range up to 100 concurrent, exact lanes and document/test safe Pi Goal-X coexistence without a private cross-extension dependency.

**Architecture:** Make `ULTRA_MAX_LANES` the single source of truth for configuration, session patches, delegate schema/validation, workflow construction, and menu parsing. Keep presets at 1–8. Add high-boundary tests and a peer lifecycle fixture that proves policy hooks compose but does not import Goal-X internals.

**Tech stack:** TypeScript, TypeBox, Node test runner with `tsx`, Pi extension API, `@narumitw/pi-tui-kit`.

## Task 1 — Raise the core upper bound and prove atomic 100-lane protocol behavior

**Files:**
- Modify: `extensions/ultra-config.ts`
- Modify: `extensions/ultra-protocol.ts`
- Modify: `tests/ultra-config.test.ts`
- Modify: `tests/ultra-protocol.test.ts`
- Modify as necessary: `tests/ultra-session-settings.test.ts`

**Acceptance contract:**
- Settings and session patches accept `maxLanes: 100` and reject 101.
- `validateUltraDelegateInput` accepts 100 valid lanes when the effective bound is 1–100 and rejects 101.
- `buildUltraWorkflow` produces one `runs.all` script with all 100 items; it never batches/truncates the list.
- Existing lower-bound, ownership, preflight, and permit tests remain green.

- [ ] Add failing boundary tests for global settings, session patches, delegate validation, and workflow construction.

```ts
test('accepts lane ceiling 100 and rejects 101', () => {
  assert.equal(normalizeUltraSettings({ minLanes: 100, maxLanes: 100 })?.maxLanes, 100);
  assert.equal(normalizeUltraSettings({ maxLanes: 101 }), undefined);
});

test('builds one exact static 100-lane wave', () => {
  const lanes = Array.from({ length: 100 }, (_, index) => prepared(index % 2 ? 'scout' : 'worker', `lane-${index}`));
  const items = workflowItems(buildUltraWorkflow(lanes));
  assert.equal(items.length, 100);
  assert.deepEqual(items.map((item) => item.key), lanes.map((lane) => lane.lane.id));
});
```

- [ ] Run the focused tests and observe failure against the old ceiling.

```bash
node --import tsx --test tests/ultra-config.test.ts tests/ultra-session-settings.test.ts tests/ultra-protocol.test.ts
```

- [ ] Change only `ULTRA_MAX_LANES` from 8 to 100. All existing consumers must derive their guard/schema limit from that exported constant; remove no protocol validation.
- [ ] Run the focused tests, typecheck, and then the complete test suite.

```bash
npm run check
```

## Task 2 — Update menu range wording, parsing, and user-facing guidance

**Files:**
- Modify: `extensions/ultra-menu.ts`
- Modify: `tests/ultra-menu.test.ts`
- Modify: `README.md`

**Acceptance contract:**
- Custom input accepts `1-100`, Unicode en-dash form, and boundary singleton `100-100`.
- It rejects 101, reversed, fractional, malformed, and zero ranges.
- Preset labels remain unchanged.
- The custom chooser and correction prompt consistently say `1–100`.
- UI help and README say a 100-lane range is 100 concurrent calls and can be constrained by budget/provider limits.

- [ ] Add failing menu parser/chooser assertions at the 100/101 boundary.
- [ ] Run `node --import tsx --test tests/ultra-menu.test.ts` and verify the old `1–8` expectation fails.
- [ ] Replace hard-coded `8` in custom lane range UI/parser copy with `ULTRA_MAX_LANES` or a shared derived label. Do not modify preset definitions.
- [ ] Update README lane-range documentation and Goal-X coexistence guidance from the approved design.
- [ ] Run focused menu tests and `npm run typecheck`.

## Task 3 — Add peer lifecycle compatibility coverage and documentation

**Files:**
- Modify: `tests/fixtures/fake-pi.ts` only if necessary to support composed handlers
- Modify: `tests/ultra-input.test.ts`
- Modify: `README.md`

**Acceptance contract:**
- A separate peer extension registering `before_agent_start` and `tool_call` sees ordinary extension lifecycle events alongside Ultra.
- With Ultra enabled, a direct `subagent` tool call is still denied and an `ultra_delegate` launch remains manager-governed.
- The test does not import `pi-goal-x`, use `_goalCore`, or require Goal-X as a production dependency.
- README gives the verified manager → evidence → explicit Goal-X update workflow and explicitly rejects automatic task completion from worker output.

- [ ] Add a fixture-level peer hook emulating only Goal-X’s public event shape: append an identifiable prompt fragment in `before_agent_start` and record tool calls.
- [ ] Add a lifecycle test which installs both peer and Ultra, emits a manager start event, asserts both prompt policies appear, then proves direct spawn denial and `ultra_delegate` handling remain intact.
- [ ] Run `node --import tsx --test tests/ultra-input.test.ts`.
- [ ] Verify README contains the compatibility boundary and 100-concurrency warning.

## Task 4 — Complete verification and release-readiness audit

**Files:**
- Modify: `package.json` only if release versioning is requested separately.
- Modify: `tests/package-layout.test.ts` only if documentation/packaging coverage needs it.

**Acceptance contract:**
- `npm run check`, `npm run smoke:packed`, `npm pack --dry-run`, and `git diff --check` all succeed.
- The package includes every changed runtime extension module and does not add Pi Goal-X as a runtime dependency.
- No untracked artifacts are staged.

- [ ] Run complete validation:

```bash
npm run check
npm run smoke:packed
npm pack --dry-run
git diff --check
git status --short
```

- [ ] Review the diff against the approved design: atomic 100-lane waves, unchanged presets, no Goal-X private/runtime coupling, preserved fail-closed authority.
- [ ] Report exact commands and results; do not claim successful compatibility or completion without their evidence.
