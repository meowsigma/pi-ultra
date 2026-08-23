import {
	chmodSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const VERSION = "0.2.0";
const STATUS_KEY = "ultra";

interface UltraState {
	enabled: boolean;
	note?: string;
}

interface UltraUi {
	setStatus(key: string, value: string | undefined): void;
	notify(message: string, level: "info" | "warning" | "error"): void;
}

interface UltraContext {
	ui: UltraUi;
}

type UltraPi = Pick<ExtensionAPI, "registerCommand" | "on">;

export interface UltraToggleOptions {
	statePath: string;
}

function normalizeState(raw: unknown): UltraState {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error("Ultra state must be a JSON object");
	}
	const obj = raw as Record<string, unknown>;
	return {
		enabled: obj.enabled === true,
		note: typeof obj.note === "string" && obj.note.trim() ? obj.note.trim() : undefined,
	};
}

function readState(statePath: string): { state: UltraState; error?: string } {
	try {
		return { state: normalizeState(JSON.parse(readFileSync(statePath, "utf8"))) };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { state: { enabled: false } };
		}
		return {
			state: { enabled: false },
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

function writeState(statePath: string, state: UltraState): string | undefined {
	let targetPath = statePath;
	let mode: number | undefined;
	try {
		const stats = lstatSync(statePath);
		mode = stats.mode;
		if (stats.isSymbolicLink()) targetPath = realpathSync(statePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			return error instanceof Error ? error.message : String(error);
		}
	}

	const directory = dirname(targetPath);
	const temporaryPath = join(directory, `.pi-ultra.json.tmp.${process.pid}.${randomUUID()}`);
	try {
		mkdirSync(directory, { recursive: true });
		writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
		if (mode !== undefined) chmodSync(temporaryPath, mode);
		renameSync(temporaryPath, targetPath);
		return undefined;
	} catch (error) {
		try {
			unlinkSync(temporaryPath);
		} catch {
			// Preserve the write error; cleanup is best effort.
		}
		return error instanceof Error ? error.message : String(error);
	}
}

function managerBlock(note?: string): string {
	return `

## ULTRA MODE — ACTIVE (manager-worker delegation)

You are the primary manager for this session. Own context, decisions, decomposition, integration, final validation, and final accountability. You have worker agents available through the \`subagent\` tool — delegate bounded work instead of doing everything in the main thread.

Workers: run \`subagent { action: "list" }\` for the live roster. Known named agents may include luna (fast recon, lookups, mechanical edits), debugger (bounded defect repair), test-worker (tests), reviewer-cheap (adversarial second opinion), hard-manager (genuinely-hard escalation), and wave-* (bulk-volume lanes). Pick the cheapest capable worker; escalate by classification only.

Rules:
- Delegate bounded implementation, exploration, research, and test packages when delegation cost < main-thread cost. Never delegate decisions requiring your full parent context.
- Parallel lanes require disjoint file/module ownership; worktree isolation in git repos; fresh context; resumable children so repairs return to the SAME child. Fewer real lanes beat fake parallelism (2–4 typical).
- Before launch, record a lane board: lane | agent | owned files/seam | isolation | validation gate. Each lane gets an explicit contract: exact objective, owned files, constraints, what NOT to change, validation steps (run the tests), expected evidence.
- Routing binds through the agent NAME, never per-launch model/thinking overrides. Verify each child's returned model metadata matches its agent binding; treat a mismatch as a failed launch: report it and relaunch.
- Audit everything yourself: read every diff against its contract, verify success criteria with real commands (tests, builds) not worker claims, send bounded defects back as precise repair requests to the same resumable child, re-audit. Never reimplement accepted worker output; never accept unaudited edits.
- Task too small to delegate? Work directly. Never ceremonial delegation.${note ? `\n\nSession notes: ${note}` : ""}`;
}

/**
 * Registers the durable Ultra manager-mode behavior against a supplied state
 * path. Exported for testability; the package entrypoint supplies Pi's agent
 * directory automatically.
 */
export function createUltraToggle({ statePath }: UltraToggleOptions) {
	return (pi: UltraPi): void => {
		let restored = readState(statePath);
		let state = restored.state;
		let stateReadError = restored.error;

		const syncStatus = (ctx: UltraContext): void => {
			ctx.ui.setStatus(STATUS_KEY, state.enabled ? "⚡ultra" : undefined);
		};

		pi.registerCommand("ultra", {
			description: "Toggle ultra mode: persistent manager-worker delegation policy (/ultra [on|off])",
			handler: async (args, ctx) => {
				const arg = (args ?? "").trim().toLowerCase();
				if (arg !== "" && arg !== "on" && arg !== "off") {
					ctx.ui.notify("Usage: /ultra [on|off]", "warning");
					return;
				}

				const nextEnabled = arg === "" ? !state.enabled : arg === "on";
				if (nextEnabled === state.enabled) {
					syncStatus(ctx);
					ctx.ui.notify(`Ultra already ${state.enabled ? "ON" : "OFF"}`, "info");
					return;
				}

				const nextState = { ...state, enabled: nextEnabled };
				const writeError = writeState(statePath, nextState);
				if (writeError) {
					ctx.ui.notify(`Failed to turn Ultra ${nextEnabled ? "ON" : "OFF"}: ${writeError}`, "error");
					return;
				}

				state = nextState;
				stateReadError = undefined;
				syncStatus(ctx);
				ctx.ui.notify(
					nextEnabled
						? `⚡ Ultra ON — manager-worker policy active for every turn (v${VERSION})`
						: "Ultra OFF — standard solo operation",
					"info",
				);
			},
		});

		pi.on("session_start", async (_event, ctx) => {
			restored = readState(statePath);
			state = restored.state;
			stateReadError = restored.error;
			syncStatus(ctx);
			if (stateReadError) {
				ctx.ui.notify(`Ultra is OFF: unable to read ${statePath}: ${stateReadError}`, "warning");
			}
		});

		pi.on("before_agent_start", async (event, _ctx) => {
			if (!state.enabled) return undefined;
			const systemPrompt = (event as { systemPrompt: string }).systemPrompt;
			return { systemPrompt: systemPrompt + managerBlock(state.note) };
		});
	};
}
