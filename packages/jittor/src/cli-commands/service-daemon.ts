import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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

export function renderSystemdUnit(options: SystemdUnitOptions): string {
	return `[Unit]
Description=Jittor token optimizing router
After=default.target network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${options.bunBin} ${options.cliPath} serve
${options.codexAuthFile ? `Environment="JITTOR_CODEX_AUTH_FILE=${options.codexAuthFile.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"\n` : ""}${options.openRouterBenchmarks ? "Environment=JITTOR_OPENROUTER_BENCHMARKS=1\n" : ""}Restart=always
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
`;
}

export function systemctl(...args: string[]): void {
	execFileSync("systemctl", ["--user", ...args], { stdio: "inherit" });
}

/** cliPath is the caller's own entrypoint file -- resolved from the real CLI script's `import.meta.url`, never this module's own, so the installed unit's ExecStart always points at the actual runnable CLI. */
export function installService(cliPath: string): void {
	const unitPath = resolveJittorPaths().serviceDescriptor;
	mkdirSync(dirname(unitPath), { recursive: true });
	const codexAuthFile = join(process.env["CODEX_HOME"] ?? join(homedir(), ".codex"), "auth.json");
	writeFileSync(unitPath, renderSystemdUnit({
		bunBin: process.execPath,
		cliPath,
		...(existsSync(codexAuthFile) ? { codexAuthFile } : {}),
		openRouterBenchmarks: process.env["JITTOR_OPENROUTER_BENCHMARKS"] === "1",
	}));
	systemctl("daemon-reload");
	systemctl("enable", SYSTEMD_UNIT_NAME);
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
