/**
 * Strict parser for the durable parallel-worktree handoff produced by the
 * pinned pi-subagents fork. This parser deliberately trusts neither worker
 * summaries nor branches: only an immutable patch reference with an exact
 * run/base/repository binding may proceed to candidate materialization.
 */
export interface UltraHandoffPatch {
  childIndex: number;
  taskIndex: number;
  agent: string;
  path: string;
}

export interface UltraValidatedParallelHandoff {
  runId: string;
  repositoryRoot: string;
  baseCommit: string;
  patches: UltraHandoffPatch[];
}

export interface UltraHandoffExpectation {
  runId: string;
  repositoryRoot: string;
  baseCommit: string;
  /** Absolute manifest location; patch artifacts must live beside it. */
  manifestPath: string;
  workerAgents: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, label: string, max = 4_096): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`Parallel handoff ${label} is invalid.`);
  }
  return value.trim();
}

function absolutePath(value: unknown, label: string): string {
  const path = text(value, label);
  if (!path.startsWith('/') || path.includes('\\') || path.split('/').some((part) => part === '..')) {
    throw new Error(`Parallel handoff ${label} is unsafe.`);
  }
  return path;
}

function safeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`Parallel handoff ${label} is invalid.`);
  return value as number;
}

/**
 * Validate only the provenance data needed before a separate candidate
 * materializer reads a patch. It does no I/O and cannot mutate a repository.
 */
export function validateUltraParallelHandoff(raw: unknown, expected: UltraHandoffExpectation): UltraValidatedParallelHandoff {
  if (!isRecord(raw) || raw.version !== 1) throw new Error('Parallel handoff manifest version is invalid.');
  const runId = text(raw.runId, 'run id', 128);
  if (runId !== expected.runId) throw new Error(`Parallel handoff run '${runId}' does not match expected run '${expected.runId}'.`);
  const repositoryRoot = absolutePath(raw.cwd, 'root');
  if (repositoryRoot !== expected.repositoryRoot) throw new Error('Parallel handoff repository root does not match the admitted writer repository.');
  if (!Array.isArray(raw.groups) || raw.groups.length < 1 || raw.groups.length > 100) throw new Error('Parallel handoff groups are invalid.');

  const manifestPath = absolutePath(expected.manifestPath, 'expected manifest path');
  const artifactRoot = manifestPath.slice(0, manifestPath.lastIndexOf('/')) || '/';
  const patches: UltraHandoffPatch[] = [];
  const seenChildren = new Set<number>();
  const seenPatches = new Set<string>();
  for (const group of raw.groups) {
    if (!isRecord(group)) throw new Error('Parallel handoff group is invalid.');
    if (text(group.baseCommit, 'base commit', 128) !== expected.baseCommit) throw new Error('Parallel handoff base commit does not match the admitted writer base.');
    if (absolutePath(group.repoRoot, 'group root') !== expected.repositoryRoot) throw new Error('Parallel handoff group root does not match the admitted writer repository.');
    if (!isRecord(group.cleanup) || group.cleanup.state !== 'complete' || !Array.isArray(group.cleanup.tasks)) {
      throw new Error('Parallel handoff cleanup is incomplete; refuse disposable worktree claims.');
    }
    if (!Array.isArray(group.children) || group.children.length < 1) throw new Error('Parallel handoff children are invalid.');
    for (const child of group.children) {
      if (!isRecord(child)) throw new Error('Parallel handoff child is invalid.');
      const childIndex = safeInteger(child.index, 'child index');
      const taskIndex = safeInteger(child.taskIndex, 'task index');
      if (seenChildren.has(childIndex)) throw new Error(`Parallel handoff child index '${childIndex}' is duplicated.`);
      seenChildren.add(childIndex);
      const agent = text(child.agent, 'child agent', 256);
      if (!expected.workerAgents.includes(agent)) throw new Error(`Parallel handoff agent '${agent}' is not an expected writer.`);
      if (child.status !== 'completed') throw new Error(`Parallel handoff writer '${agent}' did not complete successfully.`);
      if (!isRecord(child.patch) || child.patch.changed !== true) throw new Error(`Parallel handoff writer '${agent}' has no immutable patch.`);
      const patch = absolutePath(child.patch.path, 'patch path');
      if (patch !== artifactRoot && !patch.startsWith(`${artifactRoot}/`)) throw new Error('Parallel handoff patch is outside the durable manifest artifact directory.');
      if (seenPatches.has(patch)) throw new Error(`Parallel handoff patch '${patch}' is duplicated.`);
      seenPatches.add(patch);
      patches.push({ childIndex, taskIndex, agent, path: patch });
    }
  }
  if (patches.length < 1) throw new Error('Parallel handoff contains no writer patches.');
  return { runId, repositoryRoot, baseCommit: expected.baseCommit, patches };
}
