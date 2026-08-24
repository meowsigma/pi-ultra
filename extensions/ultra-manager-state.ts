export const ULTRA_MANAGER_ENTRY = 'ultra.manager.v1' as const;

export type UltraTakeoverReason =
  | 'inseparable-work'
  | 'dirty-worktree'
  | 'repair-exhausted'
  | 'worker-capability-failure'
  | 'urgent-user-directed';
export type UltraManagerEvidence = Exclude<UltraTakeoverReason, 'inseparable-work' | 'urgent-user-directed'>;
export type UltraManagerEventKind = 'scope-opened' | 'scope-closed' | 'evidence' | 'takeover';

export interface UltraManagerEvent {
  version: 1;
  id: string;
  scopeId: string;
  rootId: string;
  kind: UltraManagerEventKind;
  policyRevision: string;
  createdAt: number;
  reason?: UltraTakeoverReason;
  evidence?: UltraManagerEvidence;
}

export interface UltraManagerBinding {
  scopeId: string;
  rootId: string;
  policyRevision: string;
}

export interface UltraManagerState {
  restore(branch: unknown[]): void;
  openScope(input: UltraManagerBinding & { createdAt: number }): void;
  closeScope(input: UltraManagerBinding & { createdAt: number }): void;
  recordEvidence(input: UltraManagerBinding & { evidence: UltraManagerEvidence; createdAt: number }): void;
  recordTakeover(input: UltraManagerBinding & { reason: UltraTakeoverReason; createdAt: number }): void;
  allowsMutation(binding: UltraManagerBinding): boolean;
  hasActiveScope(binding: UltraManagerBinding): boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512;
}

function isReason(value: unknown): value is UltraTakeoverReason {
  return value === 'inseparable-work' || value === 'dirty-worktree' || value === 'repair-exhausted'
    || value === 'worker-capability-failure' || value === 'urgent-user-directed';
}

function isEvidence(value: unknown): value is UltraManagerEvidence {
  return value === 'dirty-worktree' || value === 'repair-exhausted' || value === 'worker-capability-failure';
}

function parseEvent(value: unknown): UltraManagerEvent | undefined {
  if (!isRecord(value) || value.version !== 1 || !validText(value.id) || !validText(value.scopeId)
    || !validText(value.rootId) || !validText(value.policyRevision) || typeof value.createdAt !== 'number'
    || !Number.isSafeInteger(value.createdAt)) return undefined;
  if (value.kind !== 'scope-opened' && value.kind !== 'scope-closed' && value.kind !== 'evidence' && value.kind !== 'takeover') return undefined;
  if (value.kind === 'evidence' && !isEvidence(value.evidence)) return undefined;
  if (value.kind === 'takeover' && !isReason(value.reason)) return undefined;
  return {
    version: 1, id: value.id, scopeId: value.scopeId, rootId: value.rootId, kind: value.kind,
    policyRevision: value.policyRevision, createdAt: value.createdAt,
    ...(isReason(value.reason) ? { reason: value.reason } : {}),
    ...(isEvidence(value.evidence) ? { evidence: value.evidence } : {}),
  };
}

function sameBinding(event: UltraManagerEvent, binding: UltraManagerBinding): boolean {
  return event.scopeId === binding.scopeId && event.rootId === binding.rootId && event.policyRevision === binding.policyRevision;
}

export function createUltraManagerState(input: { append(event: UltraManagerEvent): void; randomId?: () => string }): UltraManagerState {
  const events: UltraManagerEvent[] = [];
  const id = input.randomId ?? (() => `${Date.now()}-${events.length}`);
  const append = (event: Omit<UltraManagerEvent, 'version' | 'id'>): void => {
    const durable: UltraManagerEvent = { version: 1, id: id(), ...event };
    events.push(durable);
    input.append(durable);
  };
  const active = (binding: UltraManagerBinding): boolean => {
    const matching = events.filter((event) => sameBinding(event, binding));
    const opened = matching.some((event) => event.kind === 'scope-opened');
    const closed = matching.some((event) => event.kind === 'scope-closed');
    return opened && !closed;
  };
  const evidenceFor = (binding: UltraManagerBinding, evidence: UltraManagerEvidence): boolean =>
    events.some((event) => sameBinding(event, binding) && event.kind === 'evidence' && event.evidence === evidence);

  return {
    restore(branch) {
      events.splice(0, events.length);
      for (const entry of branch) {
        if (!isRecord(entry) || entry.type !== 'custom' || entry.customType !== ULTRA_MANAGER_ENTRY) continue;
        const parsed = parseEvent(entry.data);
        if (parsed) events.push(parsed);
      }
    },
    openScope(inputValue) {
      append({ ...inputValue, kind: 'scope-opened' });
    },
    closeScope(inputValue) {
      append({ ...inputValue, kind: 'scope-closed' });
    },
    recordEvidence(inputValue) {
      if (!active(inputValue)) throw new Error('Manager evidence requires an active matching scope.');
      append({ ...inputValue, kind: 'evidence' });
    },
    recordTakeover(inputValue) {
      if (!active(inputValue)) throw new Error('Manager takeover requires an active matching scope.');
      const requiredEvidence: UltraManagerEvidence | undefined = inputValue.reason === 'dirty-worktree' || inputValue.reason === 'repair-exhausted' || inputValue.reason === 'worker-capability-failure'
        ? inputValue.reason
        : undefined;
      if (requiredEvidence && !evidenceFor(inputValue, requiredEvidence)) throw new Error(`Manager takeover '${inputValue.reason}' requires persisted state evidence.`);
      append({ ...inputValue, kind: 'takeover' });
    },
    allowsMutation(binding) {
      return active(binding) && events.some((event) => sameBinding(event, binding) && event.kind === 'takeover');
    },
    hasActiveScope: active,
  };
}
