import assert from 'node:assert/strict';
import { cp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

const PUBLIC_MODULE = 'pi-subagents/launch-authority';

test('bundled Ultra API and a distinct active-extension copy share one authority registry', async () => {
  const root = join(import.meta.dirname, '..', '.test-tmp', randomUUID());
  const copy = join(root, 'copy');
  await mkdir(join(copy, 'src', 'runs', 'shared'), { recursive: true });
  try {
    const packageRoot = join(import.meta.dirname, '..', 'node_modules', 'pi-subagents');
    await cp(join(packageRoot, 'src', 'runs', 'shared', 'launch-authority.ts'), join(copy, 'src', 'runs', 'shared', 'launch-authority.ts'));
    const publicApi = await import(PUBLIC_MODULE) as any;
    const activeApi = await import(`${pathToFileURL(join(copy, 'src', 'runs', 'shared', 'launch-authority.ts')).href}?copy=${randomUUID()}`) as any;
    const sessionId = `cross-instance-${randomUUID()}`;
    const params = { workflowScript: 'return await runs.all([{key:"a",agent:"ultra-scout",task:"Inspect"}]);', cwd: '/repo', context: 'fresh', async: true, mission: false };
    const authority = publicApi.registerSubagentLaunchAuthority({ sessionId, source: 'pi-ultra', defaultNewSpawnDecision: 'deny' });
    try {
      const token = authority.issueOnce({
        configRevision: 'revision', expiresInMs: 1_000,
        requestDigest: publicApi.digestSubagentLaunchRequest(params, 'rpc.spawn'),
        minLanes: 1, maxLanes: 1,
        lanes: [{ key: 'a', agent: 'ultra-scout', modelCandidates: ['openai/test'], launchContractDigest: 'a'.repeat(64) }],
      });
      const admitted = await activeApi.authorizeSubagentLaunch({ sessionId, params, permits: [token], domain: 'rpc.spawn' });
      assert.equal(admitted.ok, true);
      assert.equal(admitted.authorities[0]?.source, 'pi-ultra');
      const committed = await admitted.commit([{ key: 'a', agent: 'ultra-scout', modelCandidates: ['openai/test'], launchContractDigest: 'a'.repeat(64) }]);
      assert.equal(committed.ok, true);
    } finally {
      authority.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
