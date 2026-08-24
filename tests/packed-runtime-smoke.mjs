#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const temp = mkdtempSync(join(tmpdir(), 'pi-ultra-packed-'));
const packDir = join(temp, 'pack');
const installDir = join(temp, 'install');
const agentDir = join(temp, 'agent');
const projectDir = join(temp, 'project');
const probePath = join(temp, 'probe.ts');
const resultPath = join(temp, 'probe-result.json');
const piBin = process.env.PI_BIN || 'pi';

function waitForFile(path, timeoutMs) {
  const started = Date.now();
  return new Promise((resolvePromise, reject) => {
    const poll = () => {
      if (existsSync(path)) return resolvePromise();
      if (Date.now() - started > timeoutMs) return reject(new Error(`Timed out waiting for ${path}`));
      setTimeout(poll, 25);
    };
    poll();
  });
}

async function main() {
  mkdirSync(packDir, { recursive: true });
  mkdirSync(installDir, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  execFileSync('git', ['init', '-q', projectDir]);
  execFileSync('git', ['-C', projectDir, 'config', 'user.email', 'smoke@example.invalid']);
  execFileSync('git', ['-C', projectDir, 'config', 'user.name', 'Ultra Smoke']);
  writeFileSync(join(projectDir, 'README.md'), 'smoke\n');
  execFileSync('git', ['-C', projectDir, 'add', 'README.md']);
  execFileSync('git', ['-C', projectDir, 'commit', '-qm', 'initial']);

  const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', packDir], { cwd: root, encoding: 'utf8' }));
  assert.equal(packed.length, 1);
  const tarball = join(packDir, packed[0].filename);
  execFileSync('npm', ['install', '--prefix', installDir, '--offline', '--ignore-scripts', '--legacy-peer-deps', tarball], {
    cwd: temp,
    encoding: 'utf8',
    env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false' },
  });
  const ultraRoot = join(installDir, 'node_modules', 'pi-ultra');
  const bundledSubagentsRoot = join(ultraRoot, 'node_modules', 'pi-subagents');
  const subagentsRoot = join(temp, 'active-pi-subagents');
  assert.equal(existsSync(join(ultraRoot, 'extensions', 'index.ts')), true);
  assert.equal(existsSync(join(bundledSubagentsRoot, 'src', 'api', 'launch-authority.ts')), true);
  cpSync(bundledSubagentsRoot, subagentsRoot, { recursive: true });
  mkdirSync(join(subagentsRoot, 'node_modules'), { recursive: true });
  for (const dependency of ['acorn', 'jiti', 'yaml']) {
    cpSync(join(ultraRoot, 'node_modules', dependency), join(subagentsRoot, 'node_modules', dependency), { recursive: true });
  }
  assert.notEqual(subagentsRoot, bundledSubagentsRoot);

  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({
    packages: [subagentsRoot, ultraRoot],
    enableSkillCommands: false,
  }, null, 2));
  writeFileSync(join(agentDir, 'pi-ultra.json'), JSON.stringify({
    version: 1,
    enabled: true,
    routingMode: 'uniform',
    orchestrationMode: 'manager',
    workerModel: 'openai-codex/gpt-5.6-sol',
    minLanes: 4,
    maxLanes: 8,
  }, null, 2));

  writeFileSync(probePath, `
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
export default function probe(pi) {
  pi.on('session_start', (_event, ctx) => {
    setTimeout(async () => {
    const requestId = 'smoke-denied';
    const replyEvent = 'subagents:rpc:v1:reply:' + requestId;
    const reply = new Promise((resolve) => {
      const dispose = pi.events.on(replyEvent, (payload) => { if (payload?.requestId === requestId) { dispose?.(); resolve(payload); } });
      setTimeout(() => { dispose?.(); resolve({ timeout: true }); }, 3000).unref?.();
    });
    pi.events.emit('subagents:rpc:v1:request', {
      version: 1,
      requestId,
      method: 'spawn',
      params: { workflowScript: "return await runs.all([{key:'only',agent:'worker',task:'must be denied'}]);", cwd: ctx.cwd, context: 'fresh', async: true },
      source: { extension: 'packed-smoke-probe' }
    });
    const spawnReply = await reply;
    const preflight = await import(pathToFileURL(process.env.ULTRA_SMOKE_PREFLIGHT).href);
    const contracts = {};
    for (const role of ['scout','worker','reviewer']) {
      contracts[role] = await preflight.resolveSubagentLaunchContract({ agent: 'ultra-' + role, cwd: ctx.cwd, task: 'Smoke ' + role, context: 'fresh' });
    }
    writeFileSync(process.env.ULTRA_SMOKE_RESULT, JSON.stringify({
      tools: pi.getAllTools().map((tool) => ({ name: tool.name, source: tool.source, path: tool.path })),
      commands: pi.getCommands().map((command) => ({ name: command.name, source: command.source, path: command.path })),
      spawnReply,
      contracts,
    }, null, 2));
    }, 50);
  });
}
`);

  const child = spawn(piBin, ['--mode', 'rpc', '-e', probePath], {
    cwd: projectDir,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: '1',
      ULTRA_SMOKE_RESULT: resultPath,
      ULTRA_SMOKE_PREFLIGHT: join(subagentsRoot, 'src', 'api', 'preflight.ts'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  try {
    await waitForFile(resultPath, 15_000);
  } catch (error) {
    throw new Error(`${error.message}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolveExit) => {
        const hard = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 2_000);
        child.once('exit', () => { clearTimeout(hard); resolveExit(); });
      });
    }
  }

  const result = JSON.parse(readFileSync(resultPath, 'utf8'));
  assert.equal(result.tools.filter((tool) => tool.name === 'ultra_delegate').length, 1);
  for (const toolName of ['ultra_begin_scope', 'ultra_takeover', 'ultra_materialize_handoff', 'ultra_review_candidate', 'ultra_record_review_findings', 'ultra_dispose_handoff']) {
    assert.equal(result.tools.filter((tool) => tool.name === toolName).length, 1, `missing Manager-mode tool ${toolName}`);
  }
  assert.equal(result.tools.filter((tool) => tool.name === 'subagent').length, 1);
  assert.equal(result.commands.filter((command) => command.name === 'ultra').length, 1);
  assert.equal(result.spawnReply.success, false, JSON.stringify(result.spawnReply));
  assert.match(result.spawnReply.error?.message ?? '', /launch authority|permit|required/i);
  assert.equal(JSON.stringify(result.spawnReply).includes('runId'), false);
  for (const role of ['scout', 'worker', 'reviewer']) {
    assert.equal(result.contracts[role]?.ok, true, `${role}: ${JSON.stringify(result.contracts[role])}`);
  }
  const scoutTools = result.contracts.scout.contract.tools.effectiveAllowlist;
  const reviewerTools = result.contracts.reviewer.contract.tools.effectiveAllowlist;
  const workerTools = result.contracts.worker.contract.tools.effectiveAllowlist;
  assert.equal(scoutTools.some((tool) => ['bash', 'edit', 'write', 'subagent'].includes(tool)), false);
  assert.equal(reviewerTools.some((tool) => ['bash', 'edit', 'write', 'subagent'].includes(tool)), false);
  for (const tool of ['read', 'bash', 'edit', 'write']) assert.equal(workerTools.includes(tool), true);
  assert.equal(workerTools.includes('subagent'), false);

  console.log(JSON.stringify({
    ok: true,
    tarball,
    packageIntegrity: packed[0].integrity,
    ultraRoot,
    activeSubagentsRoot: subagentsRoot,
    bundledSubagentsRoot,
    toolCount: result.tools.length,
    commandCount: result.commands.length,
    directLaunchBlocked: true,
    managerModeToolsRegistered: true,
  }));
}

try {
  await main();
} finally {
  if (process.env.KEEP_ULTRA_SMOKE !== '1') rmSync(temp, { recursive: true, force: true });
}
