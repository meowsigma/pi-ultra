import assert from 'node:assert/strict';
import test from 'node:test';
import { validateUltraParallelHandoff } from '../extensions/ultra-handoff.js';

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    runId: 'run-1',
    mode: 'parallel',
    source: 'async',
    cwd: '/repo',
    createdAt: 1,
    updatedAt: 2,
    groups: [{
      stepIndex: 0,
      baseCommit: 'a'.repeat(40),
      repoRoot: '/repo',
      children: [{
        index: 0,
        taskIndex: 0,
        agent: 'ultra-worker',
        status: 'completed',
        summary: 'Implemented the change.',
        patch: { path: '/artifacts/worker.patch', branch: 'ephemeral', changed: true, diffStat: '1 file changed', filesChanged: 1, insertions: 1, deletions: 0 },
      }],
      cleanup: { state: 'complete', pruned: true, tasks: [{ index: 0, path: '/tmp/worktree', branch: 'ephemeral', worktreeRemoved: true, branchRemoved: true, preserved: false }] },
    }],
    ...overrides,
  };
}

const expected = { runId: 'run-1', repositoryRoot: '/repo', baseCommit: 'a'.repeat(40), workerAgents: ['ultra-worker'] };

test('validates a completed immutable patch handoff against its exact run, base, root, and worker contract', () => {
  const validated = validateUltraParallelHandoff(manifest(), expected);
  assert.deepEqual(validated, {
    runId: 'run-1', repositoryRoot: '/repo', baseCommit: 'a'.repeat(40),
    patches: [{ childIndex: 0, taskIndex: 0, agent: 'ultra-worker', path: '/artifacts/worker.patch' }],
  });
});

test('fails closed for a forged run/root/base, missing cleanup, untrusted agent, or non-patch artifact', () => {
  assert.throws(() => validateUltraParallelHandoff(manifest({ runId: 'other-run' }), expected), /run/i);
  assert.throws(() => validateUltraParallelHandoff(manifest({ cwd: '/other' }), expected), /root/i);
  assert.throws(() => validateUltraParallelHandoff(manifest({ groups: [{ ...(manifest().groups[0] as any), baseCommit: 'b'.repeat(40) }] }), expected), /base/i);
  assert.throws(() => validateUltraParallelHandoff(manifest({ groups: [{ ...(manifest().groups[0] as any), cleanup: { state: 'partial', tasks: [] } }] }), expected), /cleanup/i);
  assert.throws(() => validateUltraParallelHandoff(manifest({ groups: [{ ...(manifest().groups[0] as any), children: [{ ...(manifest().groups[0] as any).children[0], agent: 'other-worker' }] }] }), expected), /agent/i);
  assert.throws(() => validateUltraParallelHandoff(manifest({ groups: [{ ...(manifest().groups[0] as any), children: [{ ...(manifest().groups[0] as any).children[0], patch: { ...(manifest().groups[0] as any).children[0].patch, changed: false } }] }] }), expected), /patch/i);
});
