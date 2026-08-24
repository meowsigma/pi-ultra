import type { UltraPoolResumePermit } from './ultra-pool.js';

export interface ControlledResumeRequest {
  params: { id: string; message: string };
  authorityLane: { key: string; agent: string; modelCandidates: string[]; launchContractDigest: string };
}

/**
 * Convert durable lease state into the only request shape accepted by the fork.
 * No caller fields can replace the retained worker identity or target run.
 */
export function buildControlledResumeRequest(
  permit: UltraPoolResumePermit,
  message: string,
  digest: (params: Record<string, unknown>, domain: string) => string,
): ControlledResumeRequest {
  if (permit.state !== 'issued') throw new Error('Controlled resume requires an issued durable permit.');
  const text = typeof message === 'string' ? message.trim() : '';
  if (!text || text.length > 16_384 || /[\u0000-\u001f\u007f]/u.test(text)) throw new Error('Controlled resume message is invalid.');
  const params = { id: permit.targetRunId, message: text };
  if (digest(params, 'rpc.resume') !== permit.requestDigest) throw new Error('Controlled resume request digest does not match the durable permit.');
  return {
    params,
    authorityLane: {
      key: permit.worker.key,
      agent: permit.worker.agent,
      modelCandidates: [...permit.worker.modelCandidates],
      launchContractDigest: permit.worker.launchContractDigest,
    },
  };
}
