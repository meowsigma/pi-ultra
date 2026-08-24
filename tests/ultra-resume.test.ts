import assert from 'node:assert/strict';
import test from 'node:test';
import { buildControlledResumeRequest } from '../extensions/ultra-resume.js';

const permit = {
  version: 1 as const, kind: 'resume-permit' as const, id: 'permit', jobId: 'job', leaseId: 'lease', targetRunId: 'run', requestDigest: 'a'.repeat(64),
  worker: { key: 'worker', agent: 'ultra-worker', modelCandidates: ['openai/model'], launchContractDigest: 'b'.repeat(64), workspaceBase: 'c'.repeat(40), promptDigest: 'd'.repeat(64) },
  expiresAt: 100, state: 'issued' as const, createdAt: 1, updatedAt: 1,
};

test('builds an exact rpc.resume request and authority lane from a durable permit', () => {
  const output = buildControlledResumeRequest(permit, ' Continue focused repair. ', (params, domain) => {
    assert.equal(domain, 'rpc.resume');
    assert.deepEqual(params, { id: 'run', message: 'Continue focused repair.' });
    return 'a'.repeat(64);
  });
  assert.deepEqual(output, {
    params: { id: 'run', message: 'Continue focused repair.' },
    authorityLane: { key: 'worker', agent: 'ultra-worker', modelCandidates: ['openai/model'], launchContractDigest: 'b'.repeat(64) },
  });
});

test('fails closed for a mismatched digest, malformed message, or non-issued permit', () => {
  assert.throws(() => buildControlledResumeRequest(permit, 'go', () => 'b'.repeat(64)), /digest/i);
  assert.throws(() => buildControlledResumeRequest(permit, '   ', () => 'a'.repeat(64)), /message/i);
  assert.throws(() => buildControlledResumeRequest({ ...permit, state: 'consumed' }, 'go', () => 'a'.repeat(64)), /issued/i);
});
