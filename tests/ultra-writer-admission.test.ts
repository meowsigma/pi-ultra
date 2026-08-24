import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ULTRA_ADMISSION_LIMITS,
  admitUltraWave,
  isReadOnlyWave,
  type UltraWriterAdmissionProbes,
  type UltraWriterAdmissionReason,
} from '../extensions/ultra-writer-admission.js';

const CWD = '/repo';
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);

interface ProbeHarness {
  calls: string[];
  probes: UltraWriterAdmissionProbes;
}

/** Read-only probe stubs that record every query so tests can prove no mutation-capable call occurs. */
function harness(overrides: Partial<UltraWriterAdmissionProbes> = {}): ProbeHarness {
  const calls: string[] = [];
  const base: UltraWriterAdmissionProbes = {
    repositoryRoot: async (cwd) => (cwd === CWD ? CWD : null),
    headCommit: async () => HEAD,
    resolveRef: async () => BASE,
    mergeBase: async (_cwd, _one, two) => two,
    worktreeStatus: async () => '',
  };
  const merged: UltraWriterAdmissionProbes = { ...base, ...overrides };
  const short = (commit: string): string => commit.slice(0, 7);
  const probes: UltraWriterAdmissionProbes = {
    repositoryRoot: (cwd) => { calls.push(`repositoryRoot(${cwd})`); return merged.repositoryRoot(cwd); },
    headCommit: (cwd) => { calls.push(`headCommit(${cwd})`); return merged.headCommit(cwd); },
    resolveRef: (cwd, ref) => { calls.push(`resolveRef(${cwd}, ${ref})`); return merged.resolveRef(cwd, ref); },
    mergeBase: (cwd, one, two) => { calls.push(`mergeBase(${cwd}, ${short(one)}, ${short(two)})`); return merged.mergeBase(cwd, one, two); },
    worktreeStatus: (cwd) => { calls.push(`worktreeStatus(${cwd})`); return merged.worktreeStatus(cwd); },
  };
  return { calls, probes };
}

function worker(id = 'w1'): { id: string; role: 'worker' } {
  return { id, role: 'worker' };
}

function assertBounded(result: { diagnostics: readonly string[] }): void {
  assert.ok(result.diagnostics.length <= ULTRA_ADMISSION_LIMITS.maxDiagnostics, 'diagnostics must stay bounded');
  for (const diagnostic of result.diagnostics) {
    assert.ok(diagnostic.length > 0, 'diagnostics must be actionable');
    assert.ok(diagnostic.length <= ULTRA_ADMISSION_LIMITS.maxDiagnosticChars, 'each diagnostic must stay bounded');
  }
}

// ── MODULE SHAPE ───────────────────────────────────────────────────
test('exports the admission API and bounded limits', async () => {
  assert.equal(typeof admitUltraWave, 'function');
  assert.equal(typeof isReadOnlyWave, 'function');
  assert.deepEqual(ULTRA_ADMISSION_LIMITS, {
    maxDiagnostics: 8,
    maxDiagnosticChars: 256,
    maxEvidenceChars: 512,
    maxDirtySampleEntries: 8,
    maxDirtySampleEntryChars: 128,
  });
});

// ── READ-ONLY WAVES SKIP GIT ───────────────────────────────────────
test('read-only-only waves admit without invoking a single Git probe', async () => {
  const boom = async (): Promise<never> => { throw new Error('probe must never run'); };
  const h = harness({
    repositoryRoot: boom, headCommit: boom, resolveRef: boom, mergeBase: boom, worktreeStatus: boom,
  });
  const result = await admitUltraWave({
    lanes: [{ id: 's1', role: 'scout' }, { id: 'r1', role: 'reviewer' }],
    cwd: CWD,
    probes: h.probes,
  });
  assert.deepEqual(result, { admitted: true, checkedGit: false, reason: 'read-only-wave', diagnostics: [] });
  assert.deepEqual(h.calls, [], 'Git probes must not run for read-only-only waves');
});

test('isReadOnlyWave classifies waves by their lane roles', () => {
  assert.equal(isReadOnlyWave([{ id: 's', role: 'scout' }, { id: 'r', role: 'reviewer' }]), true);
  assert.equal(isReadOnlyWave([{ id: 'w', role: 'worker' }]), false);
  assert.equal(isReadOnlyWave([{ id: 's', role: 'scout' }, { id: 'w', role: 'worker' }]), false);
  assert.equal(isReadOnlyWave([]), false);
});

// ── WRITER REJECTIONS ──────────────────────────────────────────────
test('writer waves reject a non-Git working directory fail-closed', async () => {
  const h = harness({ repositoryRoot: async () => null });
  const result = await admitUltraWave({ lanes: [worker()], cwd: CWD, probes: h.probes });
  assert.equal(result.admitted, false);
  assert.equal(result.checkedGit, true);
  assert.equal(result.reason satisfies UltraWriterAdmissionReason, 'not-a-git-repository');
  assert.deepEqual(h.calls, [`repositoryRoot(${CWD})`], 'later probes must not run');
  assert.match(result.diagnostics.join('\n'), /git repository/i);
  assert.match(result.diagnostics.join('\n'), /never initializes/i);
  assertBounded(result);
});

test('writer waves reject an unborn or missing HEAD', async () => {
  const h = harness({ headCommit: async () => null });
  const result = await admitUltraWave({ lanes: [worker()], cwd: CWD, probes: h.probes });
  assert.equal(result.admitted, false);
  assert.equal(result.reason, 'missing-head');
  assert.deepEqual(h.calls, [`repositoryRoot(${CWD})`, `headCommit(${CWD})`]);
  assert.equal(result.evidence?.repositoryRoot, CWD);
  assertBounded(result);
});

test('writer waves reject an unresolvable base ref', async () => {
  const h = harness({ resolveRef: async () => null });
  const result = await admitUltraWave({ lanes: [worker()], cwd: CWD, probes: h.probes, baseRef: 'origin/main' });
  assert.equal(result.admitted, false);
  assert.equal(result.reason, 'missing-base-ref');
  assert.deepEqual(h.calls, [`repositoryRoot(${CWD})`, `headCommit(${CWD})`, 'resolveRef(/repo, origin/main)']);
  assert.equal(result.evidence?.baseRef, 'origin/main');
  assert.match(result.diagnostics.join('\n'), /origin\/main/);
  assertBounded(result);
});

test('writer waves reject unsafe bases: unrelated history and non-ancestor base', async () => {
  const unrelated = harness({ mergeBase: async (_cwd, _one, _two) => null });
  const unrelatedResult = await admitUltraWave({ lanes: [worker()], cwd: CWD, probes: unrelated.probes, baseRef: 'origin/main' });
  assert.equal(unrelatedResult.admitted, false);
  assert.equal(unrelatedResult.reason, 'unsafe-base');
  assert.match(unrelatedResult.diagnostics.join('\n'), /no common ancestor|unrelated/i);

  const diverged = harness({ mergeBase: async (_cwd, one, _two) => one });
  const divergedResult = await admitUltraWave({ lanes: [worker()], cwd: CWD, probes: diverged.probes, baseRef: 'origin/main' });
  assert.equal(divergedResult.admitted, false);
  assert.equal(divergedResult.reason, 'unsafe-base');
  assert.match(divergedResult.diagnostics.join('\n'), /not an ancestor of HEAD/i);
  assert.equal(divergedResult.evidence?.baseCommit, BASE);
  assert.equal(divergedResult.evidence?.headCommit, HEAD);
  assertBounded(divergedResult);
});

test('writer waves reject a malformed worktree-status probe result fail-closed', async () => {
  const h = harness({ worktreeStatus: async () => null as unknown as string });
  const result = await admitUltraWave({ lanes: [worker()], cwd: CWD, probes: h.probes });
  assert.equal(result.admitted, false);
  assert.equal(result.checkedGit, true);
  assert.equal(result.reason, 'probe-unavailable');
  assert.match(result.diagnostics.join('\n'), /worktreeStatus/i);
  assertBounded(result);
});

test('writer waves reject a dirty worktree with bounded, count-bearing evidence', async () => {
  const dirtyLines = [
    ' M src/a.ts',
    'M  src/b.ts',
    '?? notes.txt',
    'UU conflicted.ts',
    ...Array.from({ length: 8 }, (_, i) => ` D old/file-${i}.ts`),
  ];
  const h = harness({ worktreeStatus: async () => `${dirtyLines.join('\n')}\n` });
  const result = await admitUltraWave({ lanes: [worker()], cwd: CWD, probes: h.probes });
  assert.equal(result.admitted, false);
  assert.equal(result.reason, 'dirty-worktree');
  assert.equal(result.evidence?.dirtyEntries, 12);
  assert.ok((result.evidence?.dirtySample?.length ?? 0) <= ULTRA_ADMISSION_LIMITS.maxDirtySampleEntries);
  assert.ok(result.evidence?.dirtySample?.every((line) => line.length <= ULTRA_ADMISSION_LIMITS.maxDirtySampleEntryChars));
  const joined = result.diagnostics.join('\n');
  assert.match(joined, /\b12\b/);
  assert.match(joined, /uncommitted/i);
  assert.match(joined, /never stash/i);
  assertBounded(result);
});

// ── ADMISSION PATHS ────────────────────────────────────────────────
test('clean writer waves admit against HEAD without probing extra refs', async () => {
  const h = harness();
  const result = await admitUltraWave({ lanes: [worker()], cwd: CWD, probes: h.probes });
  assert.equal(result.admitted, true);
  assert.equal(result.checkedGit, true);
  assert.equal(result.reason satisfies UltraWriterAdmissionReason, 'admitted');
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.evidence?.repositoryRoot, CWD);
  assert.equal(result.evidence?.headCommit, HEAD);
  assert.equal(result.evidence?.baseRef, 'HEAD');
  assert.equal(result.evidence?.baseCommit, HEAD);
  assert.equal(result.evidence?.mergeBaseCommit, HEAD);
  assert.deepEqual(h.calls, [`repositoryRoot(${CWD})`, `headCommit(${CWD})`, `worktreeStatus(${CWD})`],
    'default admission must not resolve or merge-base extra refs');
});

test('clean writer waves admit against a resolvable ancestor base ref', async () => {
  const h = harness();
  const result = await admitUltraWave({ lanes: [worker()], cwd: CWD, probes: h.probes, baseRef: 'origin/main' });
  assert.equal(result.admitted, true);
  assert.equal(result.checkedGit, true);
  assert.equal(result.reason, 'admitted');
  assert.equal(result.evidence?.baseRef, 'origin/main');
  assert.equal(result.evidence?.baseCommit, BASE);
  assert.equal(result.evidence?.mergeBaseCommit, BASE);
});

// ── FAIL-CLOSED PROBE AND INPUT HANDLING ───────────────────────────
test('probe failures fail closed as probe-unavailable with sanitized, bounded diagnostics', async () => {
  const hostile = `x${'\u0007'.repeat(2_048)}boom`;
  const h = harness({ worktreeStatus: async () => { throw new Error(hostile); } });
  const result = await admitUltraWave({ lanes: [worker()], cwd: CWD, probes: h.probes });
  assert.equal(result.admitted, false);
  assert.equal(result.checkedGit, true);
  assert.equal(result.reason satisfies UltraWriterAdmissionReason, 'probe-unavailable');
  assert.match(result.diagnostics[0]!, /worktreeStatus/);
  assert.match(result.diagnostics[0]!, /boom/);
  assert.ok(!result.diagnostics[0]!.includes('\u0007'), 'control characters must be stripped');
  assertBounded(result);

  const syncThrow = harness({ headCommit: () => { throw new Error('sync failure'); } });
  const syncResult = await admitUltraWave({ lanes: [worker()], cwd: CWD, probes: syncThrow.probes });
  assert.equal(syncResult.admitted, false);
  assert.equal(syncResult.reason, 'probe-unavailable');
  assert.match(syncResult.diagnostics[0]!, /sync failure/);
});

test('malformed input fails closed as invalid-admission-input before any probe runs', async () => {
  const cases: Array<{ lanes: ReadonlyArray<unknown>; cwd?: string; baseRef?: string }> = [
    { lanes: [] },
    { lanes: [{ id: 'x', role: 'manager' }] },
    { lanes: [{ id: '', role: 'worker' }] },
    { lanes: [{ id: 'w', role: 'WORKER' }] },
    { lanes: [{ role: 'worker' }] },
    { lanes: [worker()], cwd: '' },
    { lanes: [worker()], cwd: '   ' },
    { lanes: [worker()], baseRef: '  ' },
  ];
  for (const bad of cases) {
    const h = harness();
    const result = await admitUltraWave({
      lanes: bad.lanes as Parameters<typeof admitUltraWave>[0]['lanes'],
      cwd: bad.cwd ?? CWD,
      probes: h.probes,
      ...(bad.baseRef !== undefined ? { baseRef: bad.baseRef } : {}),
    });
    assert.equal(result.admitted, false);
    assert.equal(result.checkedGit, false);
    assert.equal(result.reason satisfies UltraWriterAdmissionReason, 'invalid-admission-input');
    assert.deepEqual(h.calls, [], 'no probe may run for malformed input');
    assertBounded(result);
  }

  // Malformed probe objects must be rejected during input validation itself.
  const wellFormedLanes = [worker()] as Parameters<typeof admitUltraWave>[0]['lanes'];
  const missingProbe = await admitUltraWave({
    lanes: wellFormedLanes,
    cwd: CWD,
    probes: { ...harness().probes, repositoryRoot: undefined } as unknown as UltraWriterAdmissionProbes,
  });
  assert.equal(missingProbe.admitted, false);
  assert.equal(missingProbe.reason, 'invalid-admission-input');
  const nonFunctionProbe = await admitUltraWave({
    lanes: wellFormedLanes,
    cwd: CWD,
    probes: { ...harness().probes, mergeBase: 'not-a-function' } as unknown as UltraWriterAdmissionProbes,
  });
  assert.equal(nonFunctionProbe.admitted, false);
  assert.equal(nonFunctionProbe.reason, 'invalid-admission-input');
});

test('checks resolve deterministically: earlier failures win over later ones', async () => {
  const h = harness({
    headCommit: async () => null,
    resolveRef: async () => null,
    worktreeStatus: async () => ' M dirty.ts\n',
  });
  const result = await admitUltraWave({ lanes: [worker()], cwd: CWD, probes: h.probes, baseRef: 'origin/main' });
  assert.equal(result.reason, 'missing-head', 'repository → HEAD → base → cleanliness order must hold');
});

test('probes receive exactly read-only query arguments and evidence stays bounded', async () => {
  const h = harness();
  const result = await admitUltraWave({ lanes: [worker()], cwd: CWD, probes: h.probes, baseRef: 'origin/main' });
  assert.deepEqual(h.calls, [
    `repositoryRoot(${CWD})`,
    `headCommit(${CWD})`,
    'resolveRef(/repo, origin/main)',
    `mergeBase(${CWD}, ${HEAD.slice(0, 7)}, ${BASE.slice(0, 7)})`,
    `worktreeStatus(${CWD})`,
  ]);
  const huge = 'y'.repeat(4_096);
  const wide = harness({ repositoryRoot: async () => `${CWD}/${huge}` });
  const wideResult = await admitUltraWave({ lanes: [worker()], cwd: CWD, probes: wide.probes, baseRef: 'origin/main' });
  assert.ok((wideResult.evidence?.repositoryRoot?.length ?? 0) <= ULTRA_ADMISSION_LIMITS.maxEvidenceChars);
});
