import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createNodeServiceInstallDeps, generateSystemdUnit, installUserService, type ServiceSpec } from "@danypops/vehicle-server/service";
import { SYSTEMD_UNIT_NAME } from "../constants.ts";
import { resolveJittorPaths } from "../state.ts";
import { callAndPrint, type CliDependencies } from "./support.ts";
import { parseJsonOnlyArgs } from "./router.ts";

export const SERVICE_USAGE_LINES = ["  service <install|start|stop|restart|status|checkpoint>"];

export interface SystemdUnitOptions {
	bunBin: string;
	cliPath: string;
	codexAuthFile?: string;
	openRouterBenchmarks?: boolean;
}

function jittorServiceSpec(options: SystemdUnitOptions): ServiceSpec {
	const env: Record<string, string> = {};
	if (options.codexAuthFile) env["JITTOR_CODEX_AUTH_FILE"] = options.codexAuthFile;
	if (options.openRouterBenchmarks) env["JITTOR_OPENROUTER_BENCHMARKS"] = "1";
	return {
		name: "jittor",
		displayName: "Jittor token optimizing router",
		binPath: options.bunBin,
		args: [options.cliPath, "serve"],
		env,
		descriptorPath: resolveJittorPaths().serviceDescriptor,
		// Jittor's own client (connectJittorClient) never auto-spawns -- systemd's own
		// supervision is this daemon's only recovery path, same as Lector's.
		restartOnFailure: true,
		restartSec: 2,
		noNewPrivileges: true,
		privateTmp: true,
		waitForNetwork: true,
	};
}

/** Pure text generator, delegating to vehicle-server's shared generateSystemdUnit -- kept as its own named export since jittor's own tests (and any external caller) call it directly with the same options shape as before. */
export function renderSystemdUnit(options: SystemdUnitOptions): string {
	return generateSystemdUnit(jittorServiceSpec(options));
}

export function systemctl(...args: string[]): void {
	execFileSync("systemctl", ["--user", ...args], { stdio: "inherit" });
}

/** cliPath is the caller's own entrypoint file -- resolved from the real CLI script's `import.meta.url`, never this module's own, so the installed unit's ExecStart always points at the actual runnable CLI. */
export function installService(cliPath: string): void {
	const codexAuthFile = join(process.env["CODEX_HOME"] ?? join(homedir(), ".codex"), "auth.json");
	const spec = jittorServiceSpec({
		bunBin: process.execPath,
		cliPath,
		...(existsSync(codexAuthFile) ? { codexAuthFile } : {}),
		openRouterBenchmarks: process.env["JITTOR_OPENROUTER_BENCHMARKS"] === "1",
	});
	const result = installUserService(spec, createNodeServiceInstallDeps());
	if (!result.installed) throw new Error(`failed to install the Jittor service: ${result.reason}`);
	// installUserService's Linux path is `enable --now` (starts if not already running) --
	// an explicit restart on top ensures a re-install after a Jittor upgrade actually picks
	// up the freshly-generated unit's new ExecStart path, not just re-enables the old one.
	systemctl("restart", SYSTEMD_UNIT_NAME);
}

export async function runServiceCommand(action: string | undefined, rest: string[], deps: CliDependencies, usage: () => number): Promise<number> {
	switch (action) {
		case "install": deps.installService(); return 0;
		case "start": deps.systemctl("start", SYSTEMD_UNIT_NAME); return 0;
		case "stop": deps.systemctl("stop", SYSTEMD_UNIT_NAME); return 0;
		case "restart": deps.systemctl("restart", SYSTEMD_UNIT_NAME); return 0;
		case "status": deps.systemctl("status", SYSTEMD_UNIT_NAME); return 0;
		case "checkpoint": {
			const parsed = parseJsonOnlyArgs(rest);
			if (!parsed) return usage();
			return callAndPrint(deps, "service.checkpoint", {}, parsed.json, () => "Checkpoint complete");
		}
		default: return usage();
	}
}
