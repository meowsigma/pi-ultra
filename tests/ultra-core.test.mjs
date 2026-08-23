import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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
			ui: {
				setStatus(key, value) { statuses.set(key, value); },
				notify(message, level) { notices.push({ message, level }); },
			},
		};

		createUltraToggle({ statePath: ${JSON.stringify(statePath)} })(pi);
		await handlers.get("session_start")({}, ctx);
		assert.equal(statuses.get("ultra"), undefined);

		await commands.get("ultra").handler("on", ctx);
		assert.deepEqual(JSON.parse(readFileSync(${JSON.stringify(statePath)}, "utf8")), { enabled: true });
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
		const resumedCtx = { ui: { setStatus(key, value) { resumedStatuses.set(key, value); }, notify() {} } };
		createUltraToggle({ statePath: ${JSON.stringify(statePath)} })(resumedPi);
		await resumedHandlers.get("session_start")({}, resumedCtx);
		assert.equal(resumedStatuses.get("ultra"), "⚡ultra");
		const resumedPrompt = await resumedHandlers.get("before_agent_start")({ systemPrompt: "base" }, resumedCtx);
		assert.match(resumedPrompt.systemPrompt, /ULTRA MODE/);
		assert.equal(resumedCommands.get("ultra").description.includes("/ultra [on|off]"), true);

		await commands.get("ultra").handler("off", ctx);
		assert.deepEqual(JSON.parse(readFileSync(${JSON.stringify(statePath)}, "utf8")), { enabled: false });
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
