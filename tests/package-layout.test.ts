import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

test('package exposes Pi extension and subagent layout', () => {
  assert.deepEqual(packageJson.pi.extensions, ['./extensions']);
  assert.ok(existsSync(resolve(root, 'extensions/index.ts')));
  assert.equal(packageJson.keywords.includes('prompt-template'), false);
  assert.deepEqual(packageJson.pi.subagents.agents, ['./agents']);
  assert.equal(packageJson.pi.prompts, undefined);
  assert.deepEqual(packageJson.files, [
    'extensions', 'agents', 'prompts', 'examples', 'README.md', 'LICENSE',
  ]);
  assert.ok(existsSync(resolve(root, 'agents/ultra-planner.md')));
  assert.ok(existsSync(resolve(root, 'prompts/ultra-planner.md')));
  assert.ok(existsSync(resolve(root, 'prompts/ultra-manager.md')));
  assert.equal(existsSync(resolve(root, 'prompts/ultra.md')), false);
});
