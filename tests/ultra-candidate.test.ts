import assert from 'node:assert/strict';
import test from 'node:test';
import { materializeUltraCandidate } from '../extensions/ultra-candidate.js';

const handoff = {
  runId: 'run-1', repositoryRoot: '/repo', baseCommit: 'a'.repeat(40),
  patches: [
    { childIndex: 0, taskIndex: 0, agent: 'ultra-worker', path: '/artifacts/a.patch' },
    { childIndex: 1, taskIndex: 1, agent: 'ultra-worker', path: '/artifacts/b.patch' },
  ],
};

test('materializes verified patches only in a distinct candidate checkout and applies each after a check', async () => {
  const calls: string[] = [];
  const result = await materializeUltraCandidate({
    handoff,
    createCheckout: async ({ repositoryRoot, baseCommit }) => {
      calls.push(`checkout:${repositoryRoot}:${baseCommit}`);
      return '/candidate/run-1';
    },
    applyPatch: async ({ candidatePath, patchPath, checkOnly }) => {
      calls.push(`${checkOnly ? 'check' : 'apply'}:${candidatePath}:${patchPath}`);
    },
  });
  assert.deepEqual(result, { candidatePath: '/candidate/run-1', appliedPatches: ['/artifacts/a.patch', '/artifacts/b.patch'] });
  assert.deepEqual(calls, [
    `checkout:/repo:${'a'.repeat(40)}`,
    'check:/candidate/run-1:/artifacts/a.patch', 'apply:/candidate/run-1:/artifacts/a.patch',
    'check:/candidate/run-1:/artifacts/b.patch', 'apply:/candidate/run-1:/artifacts/b.patch',
  ]);
});

test('fails closed before applying any patch when candidate checkout aliases the source repository', async () => {
  let applied = false;
  await assert.rejects(() => materializeUltraCandidate({
    handoff,
    createCheckout: async () => '/repo',
    applyPatch: async () => { applied = true; },
  }), /distinct/i);
  assert.equal(applied, false);
});

test('stops on a patch check failure and never applies that or later patches', async () => {
  const calls: string[] = [];
  await assert.rejects(() => materializeUltraCandidate({
    handoff,
    createCheckout: async () => '/candidate/run-1',
    applyPatch: async ({ patchPath, checkOnly }) => {
      calls.push(`${checkOnly ? 'check' : 'apply'}:${patchPath}`);
      if (patchPath.endsWith('b.patch') && checkOnly) throw new Error('does not apply');
    },
  }), /does not apply/i);
  assert.deepEqual(calls, ['check:/artifacts/a.patch', 'apply:/artifacts/a.patch', 'check:/artifacts/b.patch']);
});
