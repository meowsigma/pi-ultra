import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
// @ts-expect-error The executable smoke script intentionally has no .d.ts file.
const { inspectUltraPackage } = await import('./ultra-smoke.mjs');

const requiredPackedFiles = [
  'package/extensions/index.ts',
  'package/extensions/ultra.ts',
  'package/agents/ultra-planner.md',
  'package/prompts/ultra-planner.md',
  'package/prompts/ultra-manager.md',
];

test('package exposes exactly one Pi extension and the Ultra subagent layout', () => {
  assert.deepEqual(packageJson.pi.extensions, ['./extensions']);
  assert.equal(packageJson.pi.extensions.length, 1);
  assert.ok(existsSync(resolve(root, 'extensions/index.ts')));
  assert.ok(existsSync(resolve(root, 'extensions/ultra.ts')));
  assert.deepEqual(packageJson.pi.subagents.agents, ['./agents']);
  assert.equal(packageJson.pi.prompts, undefined);
  assert.equal(packageJson.keywords.includes('prompt-template'), false);
  for (const required of ['extensions', 'agents', 'prompts', 'README.md', 'LICENSE']) {
    assert.ok(packageJson.files.includes(required), `${required} is included in package files`);
  }
  assert.ok(existsSync(resolve(root, 'agents/ultra-planner.md')));
  assert.ok(existsSync(resolve(root, 'prompts/ultra-planner.md')));
  assert.ok(existsSync(resolve(root, 'prompts/ultra-manager.md')));
  assert.equal(existsSync(resolve(root, 'prompts/ultra.md')), false);

  const ultraSource = readFileSync(resolve(root, 'extensions/ultra.ts'), 'utf8');
  assert.equal([...ultraSource.matchAll(/\bregisterCommand\s*\(\s*(['"`])ultra\1/g)].length, 1);
});

test('npm pack dry-run includes the required Ultra release files', () => {
  const output = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: root,
    encoding: 'utf8',
  });
  const packed = JSON.parse(output) as Array<{ files: Array<{ path: string }> }>;
  assert.equal(packed.length, 1);
  const paths = new Set(packed[0].files.map(file => `package/${file.path}`));
  inspectUltraPackage([...paths]);
  for (const required of requiredPackedFiles) assert.ok(paths.has(required), `${required} is packed`);
});

test('release smoke inspector rejects missing files and duplicate command discovery', () => {
  assert.throws(
    () => inspectUltraPackage(['package/extensions/index.ts']),
    /missing required package file: package\/extensions\/ultra\.ts/,
  );
  assert.throws(
    () => inspectUltraPackage(requiredPackedFiles.map(path => `${path}/`)),
    /missing required package file: package\/extensions\/index\.ts/,
  );

  const duplicateEntries = [
    ...requiredPackedFiles,
    'package/extensions/duplicate.ts',
  ];
  const duplicateSources = new Map([
    ['package/extensions/ultra.ts', "pi.registerCommand('ultra', {});"],
    ['package/extensions/duplicate.ts', "pi.registerCommand('ultra', {});"],
  ]);
  assert.throws(
    () => inspectUltraPackage(duplicateEntries, duplicateSources),
    /expected exactly one \/ultra command registration, found 2/,
  );
});
