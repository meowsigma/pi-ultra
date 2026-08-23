#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';

const REQUIRED_PACKAGE_FILES = [
  'package/extensions/index.ts',
  'package/extensions/ultra.ts',
  'package/agents/ultra-planner.md',
  'package/prompts/ultra-planner.md',
  'package/prompts/ultra-manager.md',
];
const STALE_PROMPT = 'package/prompts/ultra.md';
const ULTRA_COMMAND = /\bregisterCommand\s*\(\s*(['"`])ultra\1/g;

function normalizeEntry(entry) {
  // Preserve a trailing slash: tar uses it to identify directory entries, and
  // a directory must never satisfy a required regular-file check.
  return entry.replace(/^\.\//u, '');
}

/**
 * Validate the package layout and command discovery inputs. Exported so the
 * normal test suite can exercise an intentional failure fixture without
 * creating or installing a tarball.
 */
export function inspectUltraPackage(entries, contents = new Map()) {
  const files = new Set(entries.map(normalizeEntry));
  for (const required of REQUIRED_PACKAGE_FILES) {
    if (!files.has(required)) {
      throw new Error(`missing required package file: ${required}`);
    }
  }
  if (files.has(STALE_PROMPT)) {
    throw new Error(`stale prompt template must not be packaged: ${STALE_PROMPT}`);
  }

  let commandCount = 0;
  for (const entry of files) {
    if (!/^package\/extensions\/.*\.(?:[cm]?js|ts)$/u.test(entry)) continue;
    const source = contents.get(entry);
    if (typeof source !== 'string') continue;
    commandCount += [...source.matchAll(ULTRA_COMMAND)].length;
  }
  if (contents.size > 0 && commandCount !== 1) {
    throw new Error(`expected exactly one /ultra command registration, found ${commandCount}`);
  }
}

function tarEntries(tarball) {
  return execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
    .split(/\r?\n/u)
    .filter(Boolean)
    .map(normalizeEntry);
}

function extensionSources(tarball, entries) {
  const contents = new Map();
  for (const entry of entries) {
    if (!/^package\/extensions\/.*\.(?:[cm]?js|ts)$/u.test(entry)) continue;
    contents.set(entry, execFileSync('tar', ['-xOzf', tarball, entry], { encoding: 'utf8' }));
  }
  return contents;
}

function main(argv) {
  if (argv.length !== 1) {
    throw new Error('usage: node tests/ultra-smoke.mjs <pi-ultra-package.tgz>');
  }
  const [tarball] = argv;
  if (!statSync(tarball).isFile()) throw new Error(`not a package tarball: ${tarball}`);
  const entries = tarEntries(tarball);
  inspectUltraPackage(entries, extensionSources(tarball, entries));
  console.log(`pi-ultra smoke check passed: ${tarball}`);
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`pi-ultra smoke check failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
