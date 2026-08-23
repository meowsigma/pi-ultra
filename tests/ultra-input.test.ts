import assert from 'node:assert/strict';
import test from 'node:test';
import type { UltraSettings } from '../extensions/ultra-config.js';
import type { UltraLane, UltraPlan } from '../extensions/ultra-protocol.js';
import {
  ULTRA_OWNED_PREFIX,
  classifyUltraInput,
  createUltraExtension,
  type UltraExtensionDependencies,
} from '../extensions/ultra.js';
import { FakePi } from './fixtures/fake-pi.js';

const ENABLED: UltraSettings = {
  version: 1,
  enabled: true,
  routingMode: 'role-defaults',
  minLanes: 1,
  maxLanes: 4,
};
const DISABLED: UltraSettings = { ...ENABLED, enabled: false };

function wave(lanes: UltraLane[] = [
  { id: 'worker-a', role: 'worker', task: 'Implement A.', write: true },
]): UltraPlan {
  return {
    objective: 'Implement the requested change.',
    evidence: ['The task has bounded implementation work.'],
    mode: 'wave',
    lanes,
    acceptance: ['Review diffs and run focused tests.'],
  };
}

function noWave(mode: 'no-wave' | 'over-cap' = 'no-wave'): UltraPlan {
  return {
    objective: 'Keep the manager in control.',
    evidence: ['No qualified bounded wave exists.'],
    mode,
    lanes: mode === 'over-cap'
      ? Array.from({ length: 5 }, (_, index) => ({
          id: `worker-${index}`,
          role: 'worker' as const,
          task: `Implement ${index}.`,
          write: true,
        }))
      : [],
    acceptance: ['Manager decides next steps.'],
  };
}

interface HarnessOptions {
  settings?: UltraSettings;
  plan?: UltraPlan;
  mode?: ConstructorParameters<typeof FakePi>[0];
  preflight?: UltraExtensionDependencies['preflightLane'];
  spawnReceipts?: unknown[];
}

function harness(options: HarnessOptions = {}) {
  let stored = { ...(options.settings ?? ENABLED) };
  const saved: UltraSettings[] = [];
  const plannerTasks: string[] = [];
  const preflights: Array<Record<string, unknown>> = [];
  const spawns: Array<Record<string, unknown>> = [];
  let menuCalls = 0;
  const receipts = [...(options.spawnReceipts ?? [{ details: { runId: 'run-1', asyncDir: '/tmp/run-1' } }])];

  const deps: UltraExtensionDependencies = {
    loadSettings: async () => ({ kind: 'loaded', settings: { ...stored } }),
    saveSettings: async (settings) => {
      stored = { ...settings };
      saved.push({ ...settings });
    },
    showMenu: async ({ save }) => {
      menuCalls += 1;
      await save({ ...stored, enabled: !stored.enabled });
      return { kind: 'closed', reason: 'close' };
    },
    requestPlan: async ({ task }) => {
      plannerTasks.push(task);
      return options.plan ?? wave();
    },
    validatePlan: (plan) => plan as UltraPlan,
    preflightLane: options.preflight ?? (async (input) => {
      preflights.push(input as unknown as Record<string, unknown>);
      return {
        context: 'fresh',
        model: input.uniformModel === 'automatic' ? 'provider/automatic-worker' : input.uniformModel ?? `provider/${input.agent}`,
        agent: { name: input.agent },
        roots: { outputPath: `/artifacts/${input.agent}.md` },
      };
    }),
    buildWaveWorkflow: (lanes, agent) => JSON.stringify({ agent, laneIds: lanes.map((lane) => lane.id) }),
    spawnGroup: async (input) => {
      spawns.push(input as unknown as Record<string, unknown>);
      const receipt = receipts.shift();
      if (receipt === undefined) throw new Error('No fake receipt configured.');
      return receipt;
    },
  };

  const pi = new FakePi(options.mode ?? 'tui');
  createUltraExtension(deps)(pi as any);
  pi.events.emit('subagents:rpc:v1:ready', {
    version: 1,
    events: { asyncComplete: 'advertised:async-complete' },
  });

  return {
    pi,
    deps,
    saved,
    plannerTasks,
    preflights,
    spawns,
    get stored() { return stored; },
    get menuCalls() { return menuCalls; },
  };
}

function countPrefix(text: string): number {
  return text.split(ULTRA_OWNED_PREFIX).length - 1;
}

test('classifyUltraInput bypasses social/commands, considers coding work, and owns prefixed text', () => {
  assert.equal(ULTRA_OWNED_PREFIX, '<pi-ultra-owned>');
  for (const text of ['hi', 'Hello!', 'thanks', 'thank you', '/model gpt']) {
    assert.equal(classifyUltraInput(text), 'bypass', text);
  }
  for (const text of ['Implement the parser and add tests.', 'Fix the failing TypeScript build.', 'Refactor src/index.ts.']) {
    assert.equal(classifyUltraInput(text), 'consider', text);
  }
  assert.equal(classifyUltraInput(`${ULTRA_OWNED_PREFIX}Implement it.`), 'owned');
  assert.equal(classifyUltraInput(`  ${ULTRA_OWNED_PREFIX}Implement it.`), 'owned');
  assert.equal(classifyUltraInput(`${ULTRA_OWNED_PREFIX}${ULTRA_OWNED_PREFIX}Implement it.`), 'owned');
});

test('registers exactly one command and on/off/toggle reload, lock-save, and update status', async () => {
  const h = harness({ settings: DISABLED });
  assert.deepEqual([...h.pi.commands.keys()], ['ultra']);
  assert.equal(h.pi.commands.get('ultra')?.description, "Configure or run Ultra's validated subagent controller");

  await h.pi.command('ultra', 'on');
  await h.pi.command('ultra', 'off');
  await h.pi.command('ultra', 'toggle');

  assert.deepEqual(h.saved.map((settings) => settings.enabled), [true, false, true]);
  assert.deepEqual(h.pi.statuses.slice(-3).map(({ value }) => value), ['Ultra: on', 'Ultra: off', 'Ultra: on']);
  assert.equal(h.plannerTasks.length, 0);
});

test('bare command opens the menu only in TUI and reports the exact non-TUI error', async () => {
  const tui = harness({ settings: DISABLED });
  await tui.pi.command('ultra');
  assert.equal(tui.menuCalls, 1);
  assert.equal(tui.saved.at(-1)?.enabled, true);
  assert.equal(tui.pi.statuses.at(-1)?.value, 'Ultra: on');

  const rpc = harness({ settings: ENABLED, mode: 'rpc' });
  await rpc.pi.command('ultra');
  assert.equal(rpc.menuCalls, 0);
  assert.equal(
    rpc.pi.notifications.at(-1)?.message,
    '/ultra menu requires TUI mode; use /ultra on, /ultra off, or /ultra toggle.',
  );
});

test('disabled explicit task notifies and never invokes planner or spawn', async () => {
  const h = harness({ settings: DISABLED });
  await h.pi.command('ultra', 'Implement the controller.');
  assert.equal(h.pi.notifications.at(-1)?.message, 'Run /ultra on first.');
  assert.equal(h.plannerTasks.length, 0);
  assert.equal(h.spawns.length, 0);
});

test('direct task validates, preflights, spawns, and emits only a received receipt', async () => {
  const receipt = { text: 'Async workflow [run-direct]', details: { runId: 'run-direct', asyncDir: '/tmp/run-direct' } };
  const h = harness({ spawnReceipts: [receipt] });
  await h.pi.command('ultra', 'Implement the controller.');

  assert.deepEqual(h.plannerTasks, ['Implement the controller.']);
  assert.equal(h.preflights.length, 1);
  assert.equal(h.spawns.length, 1);
  assert.equal(h.pi.messages.length, 1);
  assert.equal(h.pi.messages[0]?.message.customType, 'ultra-wave');
  assert.deepEqual((h.pi.messages[0]?.message.details as any).receipt, receipt);
  assert.match(h.pi.messages[0]?.message.content ?? '', /receipt received/i);
  assert.doesNotMatch(h.pi.messages[0]?.message.content ?? '', /accepted|successful/i);
});

test('passive coding input runs the controller once and is handled after a wave receipt', async () => {
  const h = harness();
  const [result] = await h.pi.emit('input', {
    type: 'input',
    text: 'Implement a bounded TypeScript parser and tests.',
    source: 'interactive',
  });
  assert.deepEqual(result, { action: 'handled' });
  assert.deepEqual(h.plannerTasks, ['Implement a bounded TypeScript parser and tests.']);
  assert.equal(h.spawns.length, 1);
});

test('passive no-wave consumes once and requeues the original with one owned prefix', async () => {
  const original = 'Implement a tiny parser but keep it local.';
  const h = harness({ plan: noWave() });
  const [result] = await h.pi.emit('input', { type: 'input', text: original, source: 'interactive' });

  assert.deepEqual(result, { action: 'handled' });
  assert.equal(h.plannerTasks.length, 1);
  assert.equal(h.spawns.length, 0);
  assert.equal(h.pi.userMessages.length, 1);
  assert.equal(h.pi.userMessages[0]?.content, `${ULTRA_OWNED_PREFIX}${original}`);
});

test('explicit no-wave or over-cap requeues a manager packet naming no qualified wave and original task', async () => {
  for (const mode of ['no-wave', 'over-cap'] as const) {
    const original = 'Implement the broad migration.';
    const h = harness({ plan: noWave(mode) });
    await h.pi.command('ultra', original);
    const packet = String(h.pi.userMessages[0]?.content);
    assert.ok(packet.startsWith(ULTRA_OWNED_PREFIX));
    assert.match(packet, /no qualified wave/i);
    assert.match(packet, /Implement the broad migration\./);
    assert.equal(h.spawns.length, 0);
  }
});

test('owned prefix is deduplicated and stripped by input transform before agent start without replanning', async () => {
  const h = harness({ plan: noWave() });
  await h.pi.command('ultra', `${ULTRA_OWNED_PREFIX}${ULTRA_OWNED_PREFIX}Implement it.`);
  const requeued = String(h.pi.userMessages[0]?.content);
  assert.equal(countPrefix(requeued), 1);

  const before = await h.pi.inputToAgentStart(`${ULTRA_OWNED_PREFIX}${ULTRA_OWNED_PREFIX}Implement it.`);
  assert.deepEqual(before.inputResult, { action: 'transform', text: 'Implement it.' });
  assert.equal(before.prompt, 'Implement it.');

  const spaced = await h.pi.inputToAgentStart(`${ULTRA_OWNED_PREFIX} ${ULTRA_OWNED_PREFIX}Implement it.`);
  assert.deepEqual(spaced.inputResult, { action: 'transform', text: 'Implement it.' });
  assert.equal(spaced.prompt, 'Implement it.');
  assert.equal(h.plannerTasks.length, 1, 'owned requeue must not plan again');
});

test('role defaults preserve trusted role routes and group only equal resolved agent/model bindings', async () => {
  const lanes: UltraLane[] = [
    { id: 'scout-a', role: 'scout', task: 'Inspect A.', write: false },
    { id: 'worker-a', role: 'worker', task: 'Implement A.', write: true },
    { id: 'worker-b', role: 'worker', task: 'Implement B.', write: true },
    { id: 'review-a', role: 'reviewer', task: 'Review A.', write: false },
  ];
  const h = harness({
    plan: wave(lanes),
    spawnReceipts: [
      { details: { runId: 'run-scout' } },
      { details: { runId: 'run-worker' } },
      { details: { runId: 'run-reviewer' } },
    ],
  });
  await h.pi.command('ultra', 'Implement and review A and B.');

  assert.deepEqual(h.preflights.map((entry) => entry.agent), ['scout', 'worker', 'worker', 'reviewer']);
  assert.equal(h.spawns.length, 3);
  const parsed = h.spawns.map((spawn) => JSON.parse(String(spawn.script)));
  assert.deepEqual(parsed, [
    { agent: 'scout', laneIds: ['scout-a'] },
    { agent: 'worker', laneIds: ['worker-a', 'worker-b'] },
    { agent: 'reviewer', laneIds: ['review-a'] },
  ]);
  assert.deepEqual(h.spawns.map((spawn) => spawn.model), [
    'provider/scout', 'provider/worker', 'provider/reviewer',
  ]);
});

test('uniform routing uses worker plus the effective selected model and preflights every lane', async () => {
  const lanes: UltraLane[] = [
    { id: 'scout-a', role: 'scout', task: 'Inspect A.', write: false },
    { id: 'review-a', role: 'reviewer', task: 'Review A.', write: false },
  ];
  const h = harness({
    settings: { ...ENABLED, routingMode: 'uniform', workerModel: 'provider/selected-worker' },
    plan: wave(lanes),
  });
  await h.pi.command('ultra', 'Inspect and review A.');

  assert.equal(h.preflights.length, 2);
  assert.deepEqual(h.preflights.map((entry) => entry.agent), ['worker', 'worker']);
  assert.deepEqual(h.preflights.map((entry) => entry.uniformModel), [
    'provider/selected-worker', 'provider/selected-worker',
  ]);
  assert.equal(h.spawns.length, 1);
  assert.equal(h.spawns[0]?.model, 'provider/selected-worker');
});

test('matching advertised completion emits bounded evidence packet and shutdown disposes listener', async () => {
  const h = harness({ spawnReceipts: [{ details: { runId: 'run-complete' } }] });
  assert.equal(h.pi.events.listenerCount('advertised:async-complete'), 1);
  await h.pi.command('ultra', 'Implement A.');
  h.pi.events.emit('advertised:async-complete', {
    runId: 'other-run',
    results: [{ artifactPath: '/ignore.md' }],
  });
  assert.equal(h.pi.messages.length, 1, 'unmatched completion is ignored');

  h.pi.events.emit('advertised:async-complete', {
    runId: 'run-complete',
    state: 'complete',
    results: [
      { index: 0, agent: 'worker', model: 'provider/worker', artifactPath: '/artifacts/a.md' },
      { index: 1, artifactPath: '/artifacts/b.md' },
    ],
  });
  assert.equal(h.pi.messages.length, 2);
  const result = h.pi.messages[1]?.message;
  assert.equal(result?.customType, 'ultra-wave');
  assert.doesNotMatch(result?.content ?? '', /accepted|successful/i);
  const details = result?.details as any;
  assert.deepEqual(details.laneIds, ['worker-a']);
  assert.deepEqual(details.resolvedAgents, ['worker']);
  assert.deepEqual(details.resolvedModels, ['provider/worker']);
  assert.deepEqual(details.artifactPaths, ['/artifacts/a.md', '/artifacts/b.md']);
  assert.deepEqual(details.validationRequirements, ['Review diffs and run focused tests.']);
  assert.match(details.managerInstructions, /verify|inspect/i);
  assert.equal(details.acceptance, undefined);

  await h.pi.emit('session_shutdown', { reason: 'quit' });
  assert.equal(h.pi.events.listenerCount('advertised:async-complete'), 0);
  assert.equal(h.pi.events.listenerCount('subagents:rpc:v1:ready'), 0);
});
