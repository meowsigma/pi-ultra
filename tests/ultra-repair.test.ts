import assert from 'node:assert/strict';
import test from 'node:test';
import { selectUltraRepairRoute } from '../extensions/ultra-repair.js';

test('retained repair resumes only an exact usable permit and otherwise labels a same-role fallback', () => {
  assert.deepEqual(selectUltraRepairRoute({ failure: 'timeout', repairAlreadyUsed: false, retainedPermitUsable: true }), { kind: 'resume-retained' });
  assert.deepEqual(selectUltraRepairRoute({ failure: 'provider', repairAlreadyUsed: false, retainedPermitUsable: false }), { kind: 'fallback-same-role', label: 'fallback-after-retained-worker-failure' });
});

test('workspace, reviewer, and exhausted repairs require manager takeover', () => {
  assert.deepEqual(selectUltraRepairRoute({ failure: 'workspace', repairAlreadyUsed: false, retainedPermitUsable: true }), { kind: 'manager-takeover', reason: 'workspace-failure' });
  assert.deepEqual(selectUltraRepairRoute({ failure: 'reviewer', repairAlreadyUsed: false, retainedPermitUsable: true }), { kind: 'manager-takeover', reason: 'reviewer-rejection' });
  assert.deepEqual(selectUltraRepairRoute({ failure: 'timeout', repairAlreadyUsed: true, retainedPermitUsable: true }), { kind: 'manager-takeover', reason: 'repair-exhausted' });
});
