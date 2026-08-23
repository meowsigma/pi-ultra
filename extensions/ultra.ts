import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createUltraToggle } from "./ultra-core.js";

/** Pi package entrypoint for the persistent /ultra manager-mode toggle. */
export default function ultraExtension(pi: ExtensionAPI): void {
	createUltraToggle({ statePath: join(getAgentDir(), "pi-ultra.json") })(pi);
}
