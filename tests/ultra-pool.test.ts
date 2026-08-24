import assert from 'node:assert/strict';
import test from 'node:test';
import { ULTRA_POOL_ENTRY, createUltraPool } from '../extensions/ultra-pool.js';

function job(id: string, kind: 'read-only' | 'writer' = 'read-only', repairOf?: string) {
  return { id, kind, ...(repairOf ? { repairOf } : {}), objective: `Job ${id}`, ownedPaths: kind === 'writer' ? [`src/${id}`] : [] };
}

test('admission is durable, FIFO within priority, and repairs outrank ordinary queued jobs', () => {
  const entries: any[] = [];
  const pool = createUltraPool({ append: (data) => entries.push({ type: 'custom', customType: ULTRA_POOL_ENTRY, data }), now: () => 100 });
  pool.enqueue(job('ordinary-a'));
  pool.enqueue(job('ordinary-b'));
  pool.enqueue(job('repair', 'read-only', 'ordinary-a'));
  assert.deepEqual(pool.admitNext({ leaseId: 'lease-1', expiresAt: 200, maxActive: 1 })?.job.id, 'repair');
  assert.equal(pool.admitNext({ leaseId: 'blocked-by-capacity', expiresAt: 200, maxActive: 1 }), undefined);
  assert.deepEqual(pool.admitNext({ leaseId: 'lease-2', expiresAt: 200, maxActive: 2 })?.job.id, 'ordinary-a');
  assert.deepEqual(entries.map((entry) => entry.data.kind), ['job', 'job', 'job', 'job', 'lease', 'job', 'lease']);
});

test('writer ownership conflicts wait, cancellation is terminal, and expired leases requeue safely', () => {
  let now = 100;
  const pool = createUltraPool({ append: () => undefined, now: () => now });
  pool.enqueue(job('writer-a', 'writer'));
  pool.enqueue({ ...job('writer-b', 'writer'), ownedPaths: ['src/writer-a/file.ts'] });
  const first = pool.admitNext({ leaseId: 'lease-a', expiresAt: 150 });
  assert.equal(first?.job.id, 'writer-a');
  assert.equal(pool.admitNext({ leaseId: 'lease-b', expiresAt: 150 }), undefined);
  pool.cancel('writer-b');
  assert.equal(pool.get('writer-b')?.state, 'cancelled');
  now = 151;
  assert.deepEqual(pool.expireLeases().map((lease) => lease.leaseId), ['lease-a']);
  assert.equal(pool.get('writer-a')?.state, 'queued');
});

test('restore fails closed for malformed entries and exposes dashboard state', () => {
  const entries: any[] = [];
  const pool = createUltraPool({ append: (data) => entries.push({ type: 'custom', customType: ULTRA_POOL_ENTRY, data }), now: () => 1 });
  pool.enqueue(job('one'));
  pool.admitNext({ leaseId: 'lease-1', expiresAt: 20 });
  const restored = createUltraPool({ append: () => assert.fail('restore must not append'), now: () => 2 });
  restored.restore([...entries, { type: 'custom', customType: ULTRA_POOL_ENTRY, data: { nope: true } }]);
  assert.deepEqual(restored.dashboard(), { queued: 0, active: 1, cancelled: 0, repairsQueued: 0 });
});
