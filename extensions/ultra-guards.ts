import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface AgentBinding {
	model?: string;
	fallbacks: string[];
}

export interface LaunchInput {
	action?: string;
	agent?: string;
	task?: string;
	workflowScript?: string;
	resume?: unknown;
	worktree?: boolean;
	isolation?: string;
	[key: string]: unknown;
}

export interface GuardState {
	maxWorkers?: number;
	requireWorktree?: boolean;
}

export type LaunchVerdict = { block?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Parses minimal frontmatter bindings (name/model/fallbackModels) from agent
 * markdown directories. Files without a frontmatter block are ignored.
 */
export function parseAgentBindings(dirs: string[]): Map<string, AgentBinding> {
	const bindings = new Map<string, AgentBinding>();
	for (const dir of dirs) {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.endsWith(".md")) continue;
			const nameFromFile = entry.slice(0, -3);
			let text: string;
			try {
				text = readFileSync(join(dir, entry), "utf8");
			} catch {
				continue;
			}
			const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
			if (!match) continue;

			let name: string | undefined;
			let model: string | undefined;
			const fallbacks: string[] = [];
			let inFallbacks = false;
			for (const line of match[1].split(/\r?\n/)) {
				if (/^\s+-\s+\S/.test(line)) {
					if (inFallbacks) fallbacks.push(line.trim().slice(2).trim());
					continue;
				}
				inFallbacks = false;
				const kv = /^(\w[\w-]*):\s*(.*)$/.exec(line);
				if (!kv) continue;
				const [, key, rawValue] = kv;
				const value = rawValue.trim();
				if (key === "name" && value) name = value;
				else if (key === "model" && value) model = value;
				else if (key === "fallbackModels") {
					inFallbacks = true;
					if (value) fallbacks.push(value);
				}
			}
			if (name && model) bindings.set(name, { model, fallbacks });
			else if (nameFromFile && model && !name) bindings.set(nameFromFile, { model, fallbacks });
		}
	}
	return bindings;
}

export function isLaunchCall(input: unknown): input is LaunchInput {
	return isRecord(input) && typeof input.action !== "string";
}

export function wantsWorktree(input: LaunchInput): boolean {
	return input.worktree === true || input.isolation === "worktree";
}

/**
 * Mechanical pre-launch guard, ultracode-style: admission cap first, then an
 * optional fail-closed worktree rule for real launches inside git repositories.
 * Management actions, resumes, and workflow scripts pass through untouched.
 */
export function evaluateLaunch({
	state,
	input,
	activeCount,
	isGitRepo = false,
}: {
	state: GuardState;
	input: unknown;
	activeCount: number;
	isGitRepo?: boolean;
}): LaunchVerdict {
	if (!isLaunchCall(input)) return {};
	const maxWorkers = state.maxWorkers;
	if (Number.isFinite(maxWorkers) && activeCount > (maxWorkers as number)) {
		return {
			block: `Ultra worker cap exceeded: ${activeCount} subagent lanes are already in flight (maxWorkers=${maxWorkers}). Integrate or wait for a lane to finish before launching another.`,
		};
	}
	if (state.requireWorktree && isGitRepo && !input.workflowScript && !input.resume && !wantsWorktree(input)) {
		return {
			block: "Ultra requires isolated lanes (requireWorktree=true): relaunch this delegation with worktree:true, or disable requireWorktree in ~/.pi/agent/pi-ultra.json.",
		};
	}
	return {};
}

/** Flags children that provably ran off their named-agent binding. */
export function summarizeMismatches(
	results: unknown,
	bindings: Map<string, AgentBinding>,
): string[] {
	if (!Array.isArray(results)) return [];
	const mismatches: string[] = [];
	for (const result of results) {
		if (!isRecord(result)) continue;
		const agent = typeof result.agent === "string" ? result.agent : undefined;
		const model = typeof result.model === "string" ? result.model : undefined;
		if (!agent || !model) continue;
		const binding = bindings.get(agent);
		if (!binding?.model) continue;
		if (model === binding.model || binding.fallbacks.includes(model)) continue;
		mismatches.push(
			`Ultra routing mismatch: agent "${agent}" is bound to ${binding.model} but reported ${model}. Treat this lane as a failed launch per policy: report it and relaunch.`,
		);
	}
	return mismatches;
}

export function formatStatus(state: { enabled?: boolean }, activeCount: number, maxWorkers?: number): string | undefined {
	if (!state.enabled) return undefined;
	if (activeCount > 0 && Number.isFinite(maxWorkers)) {
		return `⚡ultra ${activeCount}/${maxWorkers}`;
	}
	if (activeCount > 0) return `⚡ultra ${activeCount}`;
	return "⚡ultra";
}
