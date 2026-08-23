import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));

test("ships the persistent /ultra extension and not the legacy prompt template", () => {
	assert.deepEqual(packageJson.pi?.extensions, ["./extensions/ultra.ts"]);
	assert.equal(packageJson.pi?.prompts, undefined);
	assert.ok(packageJson.files.includes("extensions"));
	assert.ok(existsSync(join(repoRoot, "extensions", "ultra.ts")));
	assert.equal(existsSync(join(repoRoot, "prompts", "ultra.md")), false);
});
