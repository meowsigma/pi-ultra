import type { UltraValidatedParallelHandoff } from './ultra-handoff.js';

export interface UltraCandidateMaterializer {
  /** Creates a fresh, independent checkout at exactly the validated base. */
  createCheckout(input: { repositoryRoot: string; baseCommit: string; runId: string }): Promise<string>;
  /** Must perform `git apply --check` when checkOnly and `git apply` otherwise. */
  applyPatch(input: { candidatePath: string; patchPath: string; checkOnly: boolean }): Promise<void>;
}

export interface UltraMaterializedCandidate {
  candidatePath: string;
  appliedPatches: string[];
}

function cleanAbsolutePath(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\\') || value.split('/').some((part) => part === '..')) {
    throw new Error(`Candidate ${label} is unsafe.`);
  }
  return value.replace(/\/+$/u, '') || '/';
}

/**
 * Apply a previously validated handoff only in a dedicated candidate checkout.
 * The source repository is never written, staged, stashed, initialized, or
 * committed. Checks are deliberately interleaved with application so a later
 * malformed patch cannot reach the candidate; callers discard a partial
 * candidate after any thrown error rather than treating it as reviewable.
 */
export async function materializeUltraCandidate(
  input: { handoff: UltraValidatedParallelHandoff } & UltraCandidateMaterializer,
): Promise<UltraMaterializedCandidate> {
  const repositoryRoot = cleanAbsolutePath(input.handoff.repositoryRoot, 'repository root');
  const candidatePath = cleanAbsolutePath(await input.createCheckout({
    repositoryRoot,
    baseCommit: input.handoff.baseCommit,
    runId: input.handoff.runId,
  }), 'checkout path');
  if (candidatePath === repositoryRoot) throw new Error('Candidate checkout must be distinct from the source repository.');

  const appliedPatches: string[] = [];
  for (const patch of input.handoff.patches) {
    const patchPath = cleanAbsolutePath(patch.path, 'patch path');
    await input.applyPatch({ candidatePath, patchPath, checkOnly: true });
    await input.applyPatch({ candidatePath, patchPath, checkOnly: false });
    appliedPatches.push(patchPath);
  }
  return { candidatePath, appliedPatches };
}
