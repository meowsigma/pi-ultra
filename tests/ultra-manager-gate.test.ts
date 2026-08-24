import assert from 'node:assert/strict';
import test from 'node:test';
import { createUltraExtension, type UltraExtensionDependencies, type UltraPolicyRegistration } from '../extensions/ultra.js';
import type { UltraSettings } from '../extensions/ultra-config.js';
import { FakePi } from './fixtures/fake-pi.js';

const settings: UltraSettings = {
  version: 1, enabled: true, routingMode: 'uniform', orchestrationMode: 'manager',
  workerModel: 'openai/test-model', minLanes: 2, maxLanes: 4,
};

function harness() {
  const pi = new FakePi('tui', '/repo');
  pi.context.model = { provider: 'openai', id: 'manager' };
  pi.availableModels.push({ provider: 'openai', id: 'test-model' });
  const registration: UltraPolicyRegistration = {
    mode: 'enabled', operational: true,
    authority: { issueOnce: () => 'permit', revokeUnused() {}, dispose() {} } as any,
    capabilityCeiling: { version: 1, allowedAgents: ['ultra-scout', 'ultra-worker', 'ultra-reviewer'], allowedTools: [], denyExtensions: true, sources: ['ultra'] },
    dispose() {},
  };
  const deps: UltraExtensionDependencies = {
    loadSettings: async () => ({ kind: 'loaded', settings, revision: 'r1', path: '/tmp/pi-ultra.json' }),
    updateSettings: async () => ({ kind: 'loaded', settings, revision: 'r1', path: '/tmp/pi-ultra.json' }),
    backupAndReset: async () => { throw new Error('unused'); },
    showMenu: async () => ({}), checkCapabilities: async () => true,
    installPolicy: async ({ mode }) => mode === 'enabled' ? registration : { mode, operational: false, dispose() {} },
    watchSettings: () => () => {}, prepareWave: async () => { throw new Error('unused'); },
    launchWave: async () => { throw new Error('unused'); }, queryStatus: async () => undefined,
    randomId: () => 'id-1',
  };
  createUltraExtension(deps)(pi as any);
  return pi;
}

test('manager mode denies parent mutation until an urgent scoped takeover is durable', async () => {
  const pi = harness();
  await pi.emit('session_start', { type: 'session_start' });
  const [before] = await pi.emit('tool_call', { toolName: 'write', input: { path: 'a', content: 'b' } });
  assert.equal((before as any).block, true);
  assert.match((before as any).reason, /takeover/i);

  assert.deepEqual([...pi.tools.keys()].sort(), ['ultra_begin_scope', 'ultra_delegate', 'ultra_takeover']);
  const scope = await pi.tool('ultra_begin_scope', { scopeId: 'scope-1' });
  assert.equal((scope as any).isError, undefined);
  const takeover = await pi.tool('ultra_takeover', { scopeId: 'scope-1', reason: 'urgent-user-directed', explanation: 'The user requires a direct urgent fix.' });
  assert.equal((takeover as any).isError, undefined);

  const [after] = await pi.emit('tool_call', { toolName: 'write', input: { path: 'a', content: 'b' } });
  assert.equal(after, undefined);
});

test('manager mode requires a durable scope before dispatching an Ultra wave', async () => {
  const pi = harness();
  await pi.emit('session_start', { type: 'session_start' });
  const result = await pi.tool('ultra_delegate', {
    objective: 'Independent review.',
    lanes: [
      { id: 'scout', role: 'scout', task: 'Inspect.', deliverable: 'Evidence.' },
      { id: 'worker', role: 'worker', task: 'Patch.', deliverable: 'Patch.', ownedPaths: ['src'] },
    ],
    acceptance: ['Report results.'],
  }) as any;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /scope/i);
});

test('manager mode dispatch never authorizes bash or unknown custom tools', async () => {
  const pi = harness();
  await pi.emit('session_start', { type: 'session_start' });
  const [bash] = await pi.emit('tool_call', { toolName: 'bash', input: { command: 'echo hi' } });
  const [custom] = await pi.emit('tool_call', { toolName: 'third_party_mutator', input: {} });
  assert.equal((bash as any).block, true);
  assert.equal((custom as any).block, true);
});
