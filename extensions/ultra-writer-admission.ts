/**
 * Fail-closed Git admission gate for Ultra waves.
 *
 * Before a wave containing worker lanes may launch, the repository must be in
 * a state that is safe for writers: an existing Git repository, a resolvable
 * HEAD, a resolvable base ref that is an ancestor of HEAD (when one is
 * configured), and a clean worktree. Read-only-only waves (no `worker` lanes)
 * skip every Git check.
 *
 * This is a PURE module: all filesystem/Git access is injected through
 * read-only probes supplied by the caller. The probes must only run read-only
 * queries (for example `git rev-parse`, `git status --porcelain`,
 * `git merge-base`); this module itself never initializes, stashes, stages,
 * commits, or otherwise changes a repository, and it never throws — it always
 * returns a typed admission result and fails closed on any uncertainty.
 */

export const ULTRA_ADMISSION_LIMITS = Object.freeze({
  maxDiagnostics: 8,
  maxDiagnosticChars: 256,
  maxEvidenceChars: 512,
  maxDirtySampleEntries: 8,
  maxDirtySampleEntryChars: 128,
} as const);

export type UltraLaneRole = 'scout' | 'worker' | 'reviewer';

export interface UltraWaveLaneSpec {
  readonly id: string;
  readonly role: UltraLaneRole;
}

/**
 * Read-only Git queries. Implementations must never mutate the repository:
 * they answer questions about it and nothing more. Every probe may return a
 * promise or plain value; throwing or rejecting fails admission closed.
 */
export interface UltraWriterAdmissionProbes {
  /** Absolute repository root for cwd, or null when cwd is not inside a Git repository. */
  repositoryRoot(cwd: string): Promise<string | null> | string | null;
  /** Resolved commit id for HEAD, or null when HEAD is unborn or cannot be resolved. */
  headCommit(cwd: string): Promise<string | null> | string | null;
  /** Resolved commit id for an arbitrary ref, or null when the ref does not exist. */
  resolveRef(cwd: string, ref: string): Promise<string | null> | string | null;
  /** Common ancestor of two commits, or null when none exists (unrelated histories). */
  mergeBase(cwd: string, one: string, two: string): Promise<string | null> | string | null;
  /** Porcelain worktree status output; an empty/whitespace-only result means clean. */
  worktreeStatus(cwd: string): Promise<string> | string;
}

/** Typed evidence reason recorded on every admission verdict. */
export type UltraWriterAdmissionReason =
  | 'admitted'
  | 'read-only-wave'
  | 'not-a-git-repository'
  | 'missing-head'
  | 'missing-base-ref'
  | 'unsafe-base'
  | 'dirty-worktree'
  | 'probe-unavailable'
  | 'invalid-admission-input';

export interface UltraWriterAdmissionEvidence {
  readonly repositoryRoot?: string;
  readonly headCommit?: string;
  readonly baseRef?: string;
  readonly baseCommit?: string;
  readonly mergeBaseCommit?: string;
  readonly dirtyEntries?: number;
  readonly dirtySample?: readonly string[];
}

export interface UltraWriterAdmissionResult {
  readonly admitted: boolean;
  /** False only when no Git check ran at all (read-only-only waves, malformed input). */
  readonly checkedGit: boolean;
  readonly reason: UltraWriterAdmissionReason;
  /** Bounded, actionable diagnostics explaining a rejection. Empty when admitted. */
  readonly diagnostics: readonly string[];
  /** Bounded facts gathered before the verdict, present once Git checks ran. */
  readonly evidence?: UltraWriterAdmissionEvidence;
}

const ROLES: readonly UltraLaneRole[] = ['scout', 'worker', 'reviewer'];
const PROBE_NAMES = ['repositoryRoot', 'headCommit', 'resolveRef', 'mergeBase', 'worktreeStatus'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Strips control characters and bounds length so diagnostics stay single-line and bounded. */
function boundedText(value: unknown, limit: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim().slice(0, limit);
}

/** Like boundedText but preserves leading porcelain status columns (e.g. " M file"). */
function boundedLine(value: unknown, limit: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]+/gu, ' ').slice(0, limit).trimEnd();
}

function boundedMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return boundedText(message, ULTRA_ADMISSION_LIMITS.maxDiagnosticChars) || 'unknown probe failure';
}

/** True iff every lane is read-only (scout/reviewer). Malformed or empty lane lists are never classified as read-only waves. */
export function isReadOnlyWave(lanes: ReadonlyArray<UltraWaveLaneSpec> | unknown): boolean {
  if (!Array.isArray(lanes) || lanes.length < 1) return false;
  return lanes.every((lane) => isRecord(lane)
    && typeof lane.id === 'string'
    && lane.id.trim().length > 0
    && (lane.role === 'scout' || lane.role === 'reviewer'));
}

interface MutableEvidence {
  repositoryRoot?: string;
  headCommit?: string;
  baseRef?: string;
  baseCommit?: string;
  mergeBaseCommit?: string;
  dirtyEntries?: number;
  dirtySample?: string[];
}

class ProbeFailure extends Error {
  constructor(public readonly probe: string, cause: unknown) {
    super(`${probe}: ${boundedMessage(cause)}`);
  }
}

async function probe<T>(label: string, run: () => T | Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new ProbeFailure(label, error);
  }
}

function rejection(
  reason: Exclude<UltraWriterAdmissionReason, 'admitted'>,
  diagnostics: string[],
  options: { checkedGit: boolean; evidence?: MutableEvidence },
): UltraWriterAdmissionResult {
  const bounded = diagnostics.map((diagnostic) => boundedText(diagnostic, ULTRA_ADMISSION_LIMITS.maxDiagnosticChars))
    .filter((diagnostic) => diagnostic.length > 0)
    .slice(0, ULTRA_ADMISSION_LIMITS.maxDiagnostics);
  return {
    admitted: false,
    checkedGit: options.checkedGit,
    reason,
    diagnostics: bounded,
    ...(options.evidence ? { evidence: { ...options.evidence } } : {}),
  };
}

function invalidInput(diagnostics: string[]): UltraWriterAdmissionResult {
  return rejection('invalid-admission-input', [
    ...diagnostics,
    `Fix the admitUltraWave input; no Git check ran. Roles must be ${ROLES.join(' | ')}.`,
  ], { checkedGit: false });
}

function validateInput(input: unknown): input is {
  lanes: ReadonlyArray<UltraWaveLaneSpec>;
  cwd: string;
  probes: UltraWriterAdmissionProbes;
  baseRef?: string;
} {
  if (!isRecord(input)) return false;
  if (!Array.isArray(input.lanes) || input.lanes.length < 1) return false;
  for (const lane of input.lanes) {
    if (!isRecord(lane)) return false;
    if (typeof lane.id !== 'string' || lane.id.trim().length === 0) return false;
    if (!ROLES.includes(lane.role as UltraLaneRole)) return false;
  }
  if (typeof input.cwd !== 'string' || input.cwd.trim().length === 0) return false;
  if (input.baseRef !== undefined && (typeof input.baseRef !== 'string' || input.baseRef.trim().length === 0)) return false;
  if (!isRecord(input.probes)) return false;
  for (const name of PROBE_NAMES) if (typeof input.probes[name] !== 'function') return false;
  return true;
}

/**
 * Decide whether a wave may be admitted.
 *
 * Check order is deterministic: input validation → repository → HEAD → base
 * → worktree cleanliness; the first failing check wins. Any probe failure
 * rejects with 'probe-unavailable'. The function is total: it never throws.
 */
export async function admitUltraWave(input: {
  lanes: ReadonlyArray<UltraWaveLaneSpec>;
  cwd: string;
  probes: UltraWriterAdmissionProbes;
  /** Optional fork-point ref for writer worktrees; defaults to HEAD itself. */
  baseRef?: string;
}): Promise<UltraWriterAdmissionResult> {
  const raw: unknown = input;
  try {
    if (!validateInput(raw)) {
      return invalidInput([
        !isRecord(raw) ? 'input must be an object.'
          : !Array.isArray(raw.lanes) || raw.lanes.length < 1 ? 'lanes must contain at least one lane.'
          : 'lanes contain malformed entries.',
      ]);
    }
    // Read-only-only waves skip every Git check by design.
    if (isReadOnlyWave(input.lanes)) {
      return { admitted: true, checkedGit: false, reason: 'read-only-wave', diagnostics: [] };
    }

    const cwd = input.cwd;
    const probes = input.probes;
    const evidence: MutableEvidence = {};

    const root = await probe('repositoryRoot', () => probes.repositoryRoot(cwd));
    if (!root || typeof root !== 'string' || !root.trim()) {
      return rejection('not-a-git-repository', [
        `No git repository was found at '${boundedText(cwd, ULTRA_ADMISSION_LIMITS.maxEvidenceChars)}'. Run writer waves from inside an existing repository; Ultra never initializes one.`,
      ], { checkedGit: true });
    }
    evidence.repositoryRoot = boundedText(root, ULTRA_ADMISSION_LIMITS.maxEvidenceChars);

    const head = await probe('headCommit', () => probes.headCommit(cwd));
    if (!head || typeof head !== 'string' || !head.trim()) {
      return rejection('missing-head', [
        `Repository '${evidence.repositoryRoot}' has no resolvable HEAD (unborn or corrupted). Commit or restore HEAD before launching writer waves.`,
      ], { checkedGit: true, evidence });
    }
    evidence.headCommit = boundedText(head, ULTRA_ADMISSION_LIMITS.maxEvidenceChars);

    if (input.baseRef !== undefined) {
      const baseRef = input.baseRef.trim();
      evidence.baseRef = boundedText(baseRef, ULTRA_ADMISSION_LIMITS.maxEvidenceChars);
      const baseCommit = await probe('resolveRef', () => probes.resolveRef(cwd, baseRef));
      if (!baseCommit || typeof baseCommit !== 'string' || !baseCommit.trim()) {
        return rejection('missing-base-ref', [
          `Base ref '${baseRef}' does not resolve to a commit. Create or fetch it, or omit baseRef to admit against HEAD.`,
        ], { checkedGit: true, evidence });
      }
      evidence.baseCommit = boundedText(baseCommit, ULTRA_ADMISSION_LIMITS.maxEvidenceChars);
      const common = await probe('mergeBase', () => probes.mergeBase(cwd, head, baseCommit));
      if (!common || typeof common !== 'string' || !common.trim()) {
        return rejection('unsafe-base', [
          `Base ref '${baseRef}' (${evidence.baseCommit}) shares no common ancestor with HEAD (${evidence.headCommit}); refusing unrelated histories.`,
        ], { checkedGit: true, evidence });
      }
      if (common.trim() !== baseCommit.trim()) {
        return rejection('unsafe-base', [
          `Base ref '${baseRef}' (${evidence.baseCommit}) is not an ancestor of HEAD (${evidence.headCommit}); writer worktrees must fork from an ancestor of HEAD.`,
        ], { checkedGit: true, evidence });
      }
      evidence.mergeBaseCommit = boundedText(common, ULTRA_ADMISSION_LIMITS.maxEvidenceChars);
    } else {
      // Default base is HEAD itself: already verified above, no extra probes needed.
      evidence.baseRef = 'HEAD';
      evidence.baseCommit = evidence.headCommit;
      evidence.mergeBaseCommit = evidence.headCommit;
    }

    const status = await probe('worktreeStatus', () => probes.worktreeStatus(cwd));
    if (typeof status !== 'string') {
      return rejection('probe-unavailable', [
        'Git worktreeStatus returned an invalid result; refusing writer admission until repository state can be verified.',
      ], { checkedGit: true, evidence });
    }
    const dirtyLines = status.split('\n').filter((line) => line.trim().length > 0);
    if (dirtyLines.length > 0) {
      evidence.dirtyEntries = dirtyLines.length;
      evidence.dirtySample = dirtyLines.slice(0, ULTRA_ADMISSION_LIMITS.maxDirtySampleEntries)
        .map((line) => boundedLine(line, ULTRA_ADMISSION_LIMITS.maxDirtySampleEntryChars));
      const entries = `${dirtyLines.length} uncommitted ${dirtyLines.length === 1 ? 'entry' : 'entries'}`;
      return rejection('dirty-worktree', [
        `${entries} in '${evidence.repositoryRoot}'. Commit or clean them before launching writers; Ultra never stashes.`,
        ...dirtyLines.slice(0, ULTRA_ADMISSION_LIMITS.maxDiagnostics - 1)
          .map((line) => boundedLine(line, ULTRA_ADMISSION_LIMITS.maxDiagnosticChars)),
      ], { checkedGit: true, evidence });
    }

    return { admitted: true, checkedGit: true, reason: 'admitted', diagnostics: [], evidence: { ...evidence } };
  } catch (error) {
    const failure = error instanceof ProbeFailure ? error : new ProbeFailure('admission', error);
    const where = isRecord(raw) && typeof raw.cwd === 'string'
      ? boundedText(raw.cwd, ULTRA_ADMISSION_LIMITS.maxEvidenceChars)
      : '(unknown cwd)';
    return rejection('probe-unavailable', [
      `'${failure.probe}' probe failed for '${where}': ${failure.message}. Resolve the environment before launching writer waves; nothing was modified.`,
    ], { checkedGit: true });
  }
}
