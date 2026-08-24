export const ULTRA_POOL_ENTRY = 'ultra.pool.v1' as const;

export type UltraPoolJobKind = 'read-only' | 'writer';
export type UltraPoolJobState = 'queued' | 'leased' | 'cancelled' | 'completed';
export interface UltraPoolJob {
  version: 1;
  kind: 'job';
  id: string;
  jobKind: UltraPoolJobKind;
  state: UltraPoolJobState;
  objective: string;
  ownedPaths: string[];
  repairOf?: string;
  createdAt: number;
  updatedAt: number;
}
export interface UltraPoolLease {
  version: 1;
  kind: 'lease';
  leaseId: string;
  jobId: string;
  expiresAt: number;
  state: 'active' | 'expired';
  createdAt: number;
  updatedAt: number;
}
export interface UltraPoolResumePermit {
  version: 1;
  kind: 'resume-permit';
  id: string;
  jobId: string;
  leaseId: string;
  targetRunId: string;
  requestDigest: string;
  expiresAt: number;
  state: 'issued' | 'consumed' | 'expired';
  createdAt: number;
  updatedAt: number;
}
export type UltraPoolEntry = UltraPoolJob | UltraPoolLease | UltraPoolResumePermit;

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function overlap(left: string, right: string): boolean { return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`); }
function validJob(value: unknown): value is UltraPoolJob {
  return isRecord(value) && value.version === 1 && value.kind === 'job' && typeof value.id === 'string' && (value.jobKind === 'read-only' || value.jobKind === 'writer') && ['queued', 'leased', 'cancelled', 'completed'].includes(String(value.state)) && typeof value.objective === 'string' && Array.isArray(value.ownedPaths) && value.ownedPaths.every((path) => typeof path === 'string') && Number.isSafeInteger(value.createdAt) && Number.isSafeInteger(value.updatedAt);
}
function validLease(value: unknown): value is UltraPoolLease {
  return isRecord(value) && value.version === 1 && value.kind === 'lease' && typeof value.leaseId === 'string' && typeof value.jobId === 'string' && Number.isSafeInteger(value.expiresAt) && (value.state === 'active' || value.state === 'expired') && Number.isSafeInteger(value.createdAt) && Number.isSafeInteger(value.updatedAt);
}
function validResumePermit(value: unknown): value is UltraPoolResumePermit {
  return isRecord(value) && value.version === 1 && value.kind === 'resume-permit' && typeof value.id === 'string' && typeof value.jobId === 'string' && typeof value.leaseId === 'string' && typeof value.targetRunId === 'string' && typeof value.requestDigest === 'string' && Number.isSafeInteger(value.expiresAt) && ['issued', 'consumed', 'expired'].includes(String(value.state)) && Number.isSafeInteger(value.createdAt) && Number.isSafeInteger(value.updatedAt);
}

/** Append-only logical job/lease scheduler. It never creates workers itself. */
export function createUltraPool(input: { append(data: UltraPoolEntry): void; now?: () => number }) {
  const jobs = new Map<string, UltraPoolJob>();
  const leases = new Map<string, UltraPoolLease>();
  const resumePermits = new Map<string, UltraPoolResumePermit>();
  const now = input.now ?? Date.now;
  const persistJob = (job: UltraPoolJob) => { const copy = clone(job); jobs.set(copy.id, copy); input.append(clone(copy)); return clone(copy); };
  const persistLease = (lease: UltraPoolLease) => { const copy = clone(lease); leases.set(copy.leaseId, copy); input.append(clone(copy)); return clone(copy); };
  const persistResumePermit = (permit: UltraPoolResumePermit) => { const copy = clone(permit); resumePermits.set(copy.id, copy); input.append(clone(copy)); return clone(copy); };
  const writerConflicts = (candidate: UltraPoolJob): boolean => candidate.jobKind === 'writer' && [...leases.values()].some((lease) => {
    if (lease.state !== 'active') return false;
    const active = jobs.get(lease.jobId);
    return active?.jobKind === 'writer' && candidate.ownedPaths.some((path) => active.ownedPaths.some((other) => overlap(path, other)));
  });
  const api = {
    restore(entries: readonly unknown[]) {
      jobs.clear(); leases.clear(); resumePermits.clear();
      for (const entry of entries.slice(-10_000)) {
        if (!isRecord(entry) || entry.type !== 'custom' || entry.customType !== ULTRA_POOL_ENTRY) continue;
        if (validJob(entry.data)) jobs.set(entry.data.id, clone(entry.data));
        else if (validLease(entry.data)) leases.set(entry.data.leaseId, clone(entry.data));
        else if (validResumePermit(entry.data)) resumePermits.set(entry.data.id, clone(entry.data));
      }
    },
    enqueue(inputJob: { id: string; kind: UltraPoolJobKind; objective: string; ownedPaths: string[]; repairOf?: string }) {
      if (!inputJob.id || jobs.has(inputJob.id)) throw new Error('Pool job ID is missing or already exists.');
      if (inputJob.kind === 'writer' && inputJob.ownedPaths.length < 1) throw new Error('Writer pool jobs require owned paths.');
      const timestamp = now();
      return persistJob({ version: 1, kind: 'job', id: inputJob.id, jobKind: inputJob.kind, state: 'queued', objective: inputJob.objective.slice(0, 4096), ownedPaths: [...new Set(inputJob.ownedPaths)].slice(0, 32), ...(inputJob.repairOf ? { repairOf: inputJob.repairOf } : {}), createdAt: timestamp, updatedAt: timestamp });
    },
    admitNext(inputLease: { leaseId: string; expiresAt: number; maxActive?: number }) {
      if (leases.has(inputLease.leaseId)) throw new Error(`Duplicate pool lease '${inputLease.leaseId}'.`);
      if (inputLease.maxActive !== undefined && (!Number.isSafeInteger(inputLease.maxActive) || inputLease.maxActive < 1)) throw new Error('Pool maxActive must be a positive integer.');
      if (inputLease.maxActive !== undefined && [...leases.values()].filter((lease) => lease.state === 'active').length >= inputLease.maxActive) return undefined;
      const candidates = [...jobs.values()].filter((job) => job.state === 'queued').sort((a, b) => Number(Boolean(b.repairOf)) - Number(Boolean(a.repairOf)) || a.createdAt - b.createdAt);
      const job = candidates.find((candidate) => !writerConflicts(candidate));
      if (!job) return undefined;
      const timestamp = now();
      job.state = 'leased'; job.updatedAt = timestamp; persistJob(job);
      const lease = persistLease({ version: 1, kind: 'lease', leaseId: inputLease.leaseId, jobId: job.id, expiresAt: inputLease.expiresAt, state: 'active', createdAt: timestamp, updatedAt: timestamp });
      return { job: clone(job), lease };
    },
    cancel(jobId: string) { const job = jobs.get(jobId); if (!job || job.state !== 'queued') throw new Error('Only queued pool jobs may be cancelled.'); job.state = 'cancelled'; job.updatedAt = now(); return persistJob(job); },
    expireLeases() { const expired: UltraPoolLease[] = []; for (const lease of leases.values()) if (lease.state === 'active' && lease.expiresAt <= now()) { lease.state = 'expired'; lease.updatedAt = now(); persistLease(lease); const job = jobs.get(lease.jobId); if (job?.state === 'leased') { job.state = 'queued'; job.updatedAt = now(); persistJob(job); } expired.push(clone(lease)); } return expired; },
    issueResumePermit(inputPermit: { id: string; jobId: string; leaseId: string; targetRunId: string; requestDigest: string; expiresAt: number }) {
      const existing = resumePermits.get(inputPermit.id);
      if (existing) {
        if (existing.jobId !== inputPermit.jobId || existing.leaseId !== inputPermit.leaseId || existing.targetRunId !== inputPermit.targetRunId || existing.requestDigest !== inputPermit.requestDigest) throw new Error('Resume permit ID conflicts with durable prior intent.');
        return clone(existing);
      }
      const lease = leases.get(inputPermit.leaseId);
      if (!lease || lease.state !== 'active' || lease.jobId !== inputPermit.jobId) throw new Error('Resume permit requires an active exact job lease.');
      if (!inputPermit.id || !inputPermit.targetRunId || !/^[a-f0-9]{64}$/u.test(inputPermit.requestDigest) || !Number.isSafeInteger(inputPermit.expiresAt) || inputPermit.expiresAt <= now()) throw new Error('Resume permit is invalid or already expired.');
      const timestamp = now();
      return persistResumePermit({ version: 1, kind: 'resume-permit', ...inputPermit, state: 'issued', createdAt: timestamp, updatedAt: timestamp });
    },
    consumeResumePermit(inputPermit: { id: string; jobId: string; leaseId: string; targetRunId: string; requestDigest: string }) {
      const permit = resumePermits.get(inputPermit.id);
      if (!permit || permit.state !== 'issued') throw new Error('Resume permit is absent or already consumed.');
      if (permit.expiresAt <= now()) { permit.state = 'expired'; permit.updatedAt = now(); persistResumePermit(permit); throw new Error('Resume permit expired.'); }
      if (permit.jobId !== inputPermit.jobId || permit.leaseId !== inputPermit.leaseId || permit.targetRunId !== inputPermit.targetRunId || permit.requestDigest !== inputPermit.requestDigest) throw new Error('Resume permit does not match the exact durable lease intent.');
      permit.state = 'consumed'; permit.updatedAt = now(); return persistResumePermit(permit);
    },
    get(id: string) { const job = jobs.get(id); return job ? clone(job) : undefined; }, 
    dashboard() { const values = [...jobs.values()]; return { queued: values.filter((job) => job.state === 'queued').length, active: values.filter((job) => job.state === 'leased').length, cancelled: values.filter((job) => job.state === 'cancelled').length, repairsQueued: values.filter((job) => job.state === 'queued' && job.repairOf).length }; },
  };
  return api;
}
