import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const { parseAgentBindings, evaluateLaunch, summarizeMismatches, formatStatus } = await import(
	`file://${join(repoRoot, "extensions", "ultra-guards.ts")}`
);

function writeAgent(dir, name, frontmatter) {
	writeFileSync(join(dir, `${name}.md`), `---\nname: ${name}\n${frontmatter}---\n\nWorker body.\n`);
}

test("parses named-agent bindings from agent directories", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-ultra-agents-"));
	try {
		mkdirSync(dir, { recursive: true });
		writeAgent(dir, "luna", "model: openai-codex/gpt-5.6-luna\nthinking: low\n");
		writeAgent(
			dir,
			"debugger",
			"model: openrouter/stealth/ox-alpha\nfallbackModels:\n  - openrouter/deepseek/deepseek-v4-flash\n",
		);
		writeFileSync(join(dir, "no-frontmatter.md"), "# not an agent\n");

		const bindings = parseAgentBindings([dir]);
		assert.equal(bindings.get("luna")?.model, "openai-codex/gpt-5.6-luna");
		assert.deepEqual(bindings.get("debugger")?.fallbacks, ["openrouter/deepseek/deepseek-v4-flash"]);
		assert.equal(bindings.has("no-frontmatter"), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("evaluateLaunch enforces the worker cap", () => {
	const state = { enabled: true, maxWorkers: 4 };
	const allowed = evaluateLaunch({ state, input: { agent: "luna", task: "x" }, activeCount: 4 });
	const blocked = evaluateLaunch({ state, input: { agent: "luna", task: "x" }, activeCount: 5 });
	assert.equal(allowed.block, undefined);
	assert.match(blocked.block ?? "", /maxWorkers|worker cap/i);
});

test("evaluateLaunch enforces worktree isolation only for real launches in git repos", () => {
	const state = { enabled: true, requireWorktree: true };
	const bare = { agent: "luna", task: "x" };
	const isolated = { agent: "luna", task: "x", worktree: true };

	assert.match(evaluateLaunch({ state, input: bare, activeCount: 0, isGitRepo: true }).block ?? "", /worktree/i);
	assert.equal(evaluateLaunch({ state, input: isolated, activeCount: 0, isGitRepo: true }).block, undefined);
	assert.equal(evaluateLaunch({ state, input: bare, activeCount: 0, isGitRepo: false }).block, undefined);
	assert.equal(evaluateLaunch({ state, input: bare, activeCount: 0 }).block, undefined);
	assert.equal(
		evaluateLaunch({ state, input: { workflowScript: "export const x = 1" }, activeCount: 0, isGitRepo: true }).block,
		undefined,
	);
	assert.equal(
		evaluateLaunch({ state, input: { action: "list" }, activeCount: 0, isGitRepo: true }).block,
		undefined,
	);
});

test("summarizeMismatches reports only confident routing violations", () => {
	const bindings = new Map([
		["luna", { model: "openai-codex/gpt-5.6-luna", fallbacks: ["openrouter/stealth/ox-alpha"] }],
	]);
	const mismatches = summarizeMismatches(
		[
			{ agent: "luna", model: "openrouter/deepseek/deepseek-v4-flash" },
			{ agent: "luna", model: "openai-codex/gpt-5.6-luna" },
			{ agent: "luna", model: "openrouter/stealth/ox-alpha" },
			{ agent: "unknown-agent", model: "someone/else" },
			{ agent: "luna" },
		],
		bindings,
	);
	assert.equal(mismatches.length, 1);
	assert.match(mismatches[0], /luna/);
	assert.match(mismatches[0], /deepseek/);
});

test("formatStatus renders lanes telemetry only while enabled", () => {
	assert.equal(formatStatus({ enabled: false }, 0, 4), undefined);
	assert.equal(formatStatus({ enabled: true }, 0, 4), "⚡ultra");
	assert.equal(formatStatus({ enabled: true }, 2, 4), "⚡ultra 2/4");
});
