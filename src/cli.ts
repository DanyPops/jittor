#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SYSTEMD_UNIT_NAME } from "./constants.ts";
import { serveMain } from "./daemon.ts";
import { resolveJittorPaths } from "./state.ts";

export interface SystemdUnitOptions {
	bunBin: string;
	cliPath: string;
	codexAuthFile?: string;
}

export function renderSystemdUnit(options: SystemdUnitOptions): string {
	return `[Unit]
Description=Jittor token optimizing router
After=default.target network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${options.bunBin} ${options.cliPath} serve
${options.codexAuthFile ? `Environment="JITTOR_CODEX_AUTH_FILE=${options.codexAuthFile.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"\n` : ""}Restart=always
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
`;
}

function systemctl(...args: string[]): void {
	execFileSync("systemctl", ["--user", ...args], { stdio: "inherit" });
}

function installService(): void {
	const unitPath = resolveJittorPaths().systemdUnit;
	mkdirSync(dirname(unitPath), { recursive: true });
	const codexAuthFile = join(process.env["CODEX_HOME"] ?? join(homedir(), ".codex"), "auth.json");
	writeFileSync(unitPath, renderSystemdUnit({
		bunBin: process.execPath,
		cliPath: fileURLToPath(import.meta.url),
		...(existsSync(codexAuthFile) ? { codexAuthFile } : {}),
	}));
	systemctl("daemon-reload");
	systemctl("enable", SYSTEMD_UNIT_NAME);
	systemctl("restart", SYSTEMD_UNIT_NAME);
}

function usage(): never {
	console.error("Usage: jittor serve | service <install|start|stop|restart|status>");
	process.exit(2);
}

export function main(args: string[] = process.argv.slice(2)): void {
	const [command, action] = args;
	if (command === "serve") { serveMain(); return; }
	if (command !== "service") usage();
	switch (action) {
		case "install": installService(); break;
		case "start": systemctl("start", SYSTEMD_UNIT_NAME); break;
		case "stop": systemctl("stop", SYSTEMD_UNIT_NAME); break;
		case "restart": systemctl("restart", SYSTEMD_UNIT_NAME); break;
		case "status": systemctl("status", SYSTEMD_UNIT_NAME); break;
		default: usage();
	}
}

if (import.meta.main) main();
