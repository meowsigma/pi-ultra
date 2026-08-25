export type UltraRepairFailureClass = 'provider' | 'timeout' | 'workspace' | 'reviewer';
export type UltraRepairRoute =
  | { kind: 'resume-retained' }
  | { kind: 'fallback-same-role'; label: 'fallback-after-retained-worker-failure' }
  | { kind: 'manager-takeover'; reason: 'repair-exhausted' | 'workspace-failure' | 'reviewer-rejection' };

/** Pure, fail-closed policy for the one permitted repair slot. */
export function selectUltraRepairRoute(input: {
  failure: UltraRepairFailureClass;
  repairAlreadyUsed: boolean;
  retainedPermitUsable: boolean;
}): UltraRepairRoute {
  if (input.repairAlreadyUsed) return { kind: 'manager-takeover', reason: 'repair-exhausted' };
  if (input.failure === 'workspace') return { kind: 'manager-takeover', reason: 'workspace-failure' };
  if (input.failure === 'reviewer') return { kind: 'manager-takeover', reason: 'reviewer-rejection' };
  if (input.retainedPermitUsable) return { kind: 'resume-retained' };
  return { kind: 'fallback-same-role', label: 'fallback-after-retained-worker-failure' };
}
