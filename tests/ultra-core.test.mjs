import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const repoRoot = join(resolve(fileURLToPath(import.meta.url), ".."), "..");
const coreUrl = pathToFileURL(join(repoRoot, "extensions", "ultra-core.ts")).href;

function runExercise(statePath) {
	const program = `
		import assert from "node:assert/strict";
		import { existsSync, readFileSync } from "node:fs";
		import { createUltraToggle } from ${JSON.stringify(coreUrl)};

		const commands = new Map();
		const handlers = new Map();
		const pi = {
			registerCommand(name, command) { commands.set(name, command); },
			on(name, handler) { handlers.set(name, handler); },
		};
		const statuses = new Map([["ultra", "⚡ultra"]]);
		const notices = [];
		const ctx = {
			cwd: process.cwd(),
			ui: {
				setStatus(key, value) { statuses.set(key, value); },
				notify(message, level) { notices.push({ message, level }); },
			},
		};

		createUltraToggle({ statePath: ${JSON.stringify(statePath)} })(pi);
		await handlers.get("session_start")({}, ctx);
		assert.equal(statuses.get("ultra"), undefined);

		await commands.get("ultra").handler("on", ctx);
		assert.deepEqual(JSON.parse(readFileSync(${JSON.stringify(statePath)}, "utf8")), { enabled: true, maxWorkers: 4, requireWorktree: false });
		assert.equal(statuses.get("ultra"), "⚡ultra");
		const enabledPrompt = await handlers.get("before_agent_start")({ systemPrompt: "base" }, ctx);
		assert.match(enabledPrompt.systemPrompt, /ULTRA MODE/);

		const resumedCommands = new Map();
		const resumedHandlers = new Map();
		const resumedPi = {
			registerCommand(name, command) { resumedCommands.set(name, command); },
			on(name, handler) { resumedHandlers.set(name, handler); },
		};
		const resumedStatuses = new Map();
		const resumedCtx = { cwd: process.cwd(), ui: { setStatus(key, value) { resumedStatuses.set(key, value); }, notify() {} } };
		createUltraToggle({ statePath: ${JSON.stringify(statePath)} })(resumedPi);
		await resumedHandlers.get("session_start")({}, resumedCtx);
		assert.equal(resumedStatuses.get("ultra"), "⚡ultra");
		const resumedPrompt = await resumedHandlers.get("before_agent_start")({ systemPrompt: "base" }, resumedCtx);
		assert.match(resumedPrompt.systemPrompt, /ULTRA MODE/);
		assert.equal(resumedCommands.get("ultra").description.includes("/ultra [on|off]"), true);

		await commands.get("ultra").handler("off", ctx);
		assert.deepEqual(JSON.parse(readFileSync(${JSON.stringify(statePath)}, "utf8")), { enabled: false, maxWorkers: 4, requireWorktree: false });
		assert.equal(statuses.get("ultra"), undefined);
		assert.equal(await handlers.get("before_agent_start")({ systemPrompt: "base" }, ctx), undefined);

		await commands.get("ultra").handler("not-a-mode", ctx);
		assert.equal(notices.at(-1).message, "Usage: /ultra [on|off]");
		assert.ok(existsSync(${JSON.stringify(statePath)}));
	`;
	return spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", program], {
		encoding: "utf8",
	});
}


test("persists /ultra state, injects manager mode, and clears it on disable", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-ultra-test-"));
	try {
		const result = runExercise(join(dir, "pi-ultra.json"));
		assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

function runGuardsExercise(repoRootDir, statePath, agentsDir) {
	const program = `
		import assert from "node:assert/strict";
		import { createUltraToggle } from ${JSON.stringify(coreUrl)};

		const commands = new Map();
		const handlers = new Map();
		const pi = {
			registerCommand(name, command) { commands.set(name, command); },
			on(name, handler) { handlers.set(name, handler); },
		};
		const statuses = new Map();
		const ctx = { cwd: ${JSON.stringify(repoRootDir)}, ui: { setStatus(k, v) { statuses.set(k, v); }, notify() {} } };

		createUltraToggle({
			statePath: ${JSON.stringify(statePath)},
			agentsDirs: [${JSON.stringify(agentsDir)}],
		})(pi);
		await handlers.get("session_start")({}, ctx);
		assert.equal(statuses.get("ultra"), "⚡ultra");

		await handlers.get("tool_execution_start")(
			{ toolName: "subagent", args: { agent: "luna", task: "t" } }, ctx,
		);
		assert.equal(statuses.get("ultra"), "⚡ultra 1/1");

		const worktreeBlock = await handlers.get("tool_call")(
			{ toolName: "subagent", input: { agent: "luna", task: "x" } }, ctx,
		);
		assert.match(worktreeBlock.reason ?? "", /worktree/i);

		// Real Pi fires execution_start during preflight, before each tool_call
		// gate, so the launching lane counts itself toward the cap.
		await handlers.get("tool_execution_start")(
			{ toolName: "subagent", args: { agent: "luna", task: "x", worktree: true } }, ctx,
		);
		assert.equal(statuses.get("ultra"), "⚡ultra 2/1");

		const capBlock = await handlers.get("tool_call")(
			{ toolName: "subagent", input: { agent: "luna", task: "x", worktree: true } }, ctx,
		);
		assert.match(capBlock.reason ?? "", /maxWorkers/i);

		await handlers.get("tool_execution_end")({ toolName: "subagent" }, ctx);
		await handlers.get("tool_execution_end")({ toolName: "subagent" }, ctx);
		const allowed = await handlers.get("tool_call")(
			{ toolName: "subagent", input: { agent: "luna", task: "x", worktree: true } }, ctx,
		);
		assert.equal(allowed?.block, undefined);

		const patched = await handlers.get("tool_result")(
			{
				toolName: "subagent",
				details: { results: [{ agent: "luna", model: "openrouter/deepseek/deepseek-v4-flash" }] },
				content: [{ type: "text", text: "lane done" }],
			},
			ctx,
		);
		assert.match(patched.content[0].text, /routing mismatch/);
		assert.equal(patched.content[1].text, "lane done");
	`;
	return spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", program], {
		encoding: "utf8",
	});
}

test("guards enforce cap, worktree rule, telemetry, and routing warnings end-to-end", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-ultra-guards-"));
	try {
		mkdirSync(join(dir, "agents"), { recursive: true });
		writeFileSync(join(dir, "agents", "luna.md"), "---\nname: luna\nmodel: openai-codex/gpt-5.6-luna\nfallbackModels:\n  - openrouter/stealth/ox-alpha\n---\n\nbody\n");
		writeFileSync(join(dir, "pi-ultra.json"), JSON.stringify({ enabled: true, maxWorkers: 1, requireWorktree: true }));
		execFileSync("git", ["init", "-q", join(dir, "repo")]);

		const result = runGuardsExercise(join(dir, "repo"), join(dir, "pi-ultra.json"), join(dir, "agents"));
		assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
