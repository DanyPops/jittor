#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SYSTEMD_UNIT_NAME } from "./constants.ts";
import { connectJittorClient } from "./client.ts";
import { serveMain } from "./daemon.ts";
import type { ContextAssessment } from "./domain/context-telemetry.ts";
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

interface ContextClient {
	call(operation: "context.assess", input: { since?: number; until?: number }): Promise<ContextAssessment>;
}

export interface CliDependencies {
	client: ContextClient;
	stdout(line: string): void;
	stderr(line: string): void;
	systemctl(...args: string[]): void;
	installService(): void;
	serve(): void;
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

const DEFAULT_DEPENDENCIES: CliDependencies = {
	get client() { return connectJittorClient(); },
	stdout: console.log,
	stderr: console.error,
	systemctl,
	installService,
	serve: serveMain,
};

function usage(stderr: (line: string) => void): number {
	stderr("Usage: jittor serve | service <install|start|stop|restart|status> | context [--since <ms>] [--until <ms>] [--json]");
	return 2;
}

function parseContextArgs(args: string[]): { input: { since?: number; until?: number }; json: boolean } | null {
	const input: { since?: number; until?: number } = {};
	let json = false;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--json") { json = true; continue; }
		if (argument !== "--since" && argument !== "--until") return null;
		const raw = args[++index];
		const value = raw === undefined ? Number.NaN : Number(raw);
		if (!Number.isSafeInteger(value) || value < 0) return null;
		if (argument === "--since") input.since = value;
		else input.until = value;
	}
	if (input.since !== undefined && input.until !== undefined && input.until < input.since) return null;
	return { input, json };
}

function value(value: number | null, suffix = ""): string {
	return value === null ? "unknown" : `${Math.round(value).toLocaleString()}${suffix}`;
}

export function formatContextAssessment(summary: ContextAssessment): string {
	return [
		`Context assessment: ${summary.completeness}`,
		`Papyrus injection: ${summary.injection.runs} runs · avg ${value(summary.injection.averageCharacters, " chars")} · p95 ${value(summary.injection.p95Characters, " chars")} · max ${value(summary.injection.maxCharacters, " chars")}`,
		`Injection mix: rules ${summary.injection.ruleCharacters.toLocaleString()} chars · tasks ${summary.injection.taskCharacters.toLocaleString()} chars · estimated ${summary.injection.estimatedTokens.toLocaleString()} tokens · unchanged ${summary.injection.unchangedRate === null ? "unknown" : `${(summary.injection.unchangedRate * 100).toFixed(1)}%`}`,
		`Compactions: ${summary.compaction.completed} completed · ${summary.compaction.aborted} aborted · avg ${value(summary.compaction.averageDurationMs, "ms")} · ${summary.compaction.perRun === null ? "unknown" : summary.compaction.perRun.toFixed(3)} per agent run · ${summary.compaction.perTurn === null ? "unknown" : summary.compaction.perTurn.toFixed(3)} per turn`,
		`Between compactions: ${value(summary.compaction.averageTurnsBetween, " turns")} · ${value(summary.compaction.averageProviderTokensBetween, " provider tokens")} · ${value(summary.compaction.averageCacheReadTokensBetween, " cache-read tokens")}`,
		`Reasons: threshold ${summary.compaction.reasons.threshold} · overflow ${summary.compaction.reasons.overflow} · manual ${summary.compaction.reasons.manual}`,
	].join("\n");
}

export async function runCli(args: string[], deps: CliDependencies = DEFAULT_DEPENDENCIES): Promise<number> {
	const [command, action, ...rest] = args;
	if (command === "serve") { deps.serve(); return 0; }
	if (command === "context") {
		const parsed = parseContextArgs([...(action === undefined ? [] : [action]), ...rest]);
		if (!parsed) return usage(deps.stderr);
		try {
			const summary = await deps.client.call("context.assess", parsed.input);
			deps.stdout(parsed.json ? JSON.stringify(summary) : formatContextAssessment(summary));
			return 0;
		} catch (error) {
			deps.stderr(error instanceof Error ? error.message : String(error));
			return 1;
		}
	}
	if (command !== "service") return usage(deps.stderr);
	switch (action) {
		case "install": deps.installService(); return 0;
		case "start": deps.systemctl("start", SYSTEMD_UNIT_NAME); return 0;
		case "stop": deps.systemctl("stop", SYSTEMD_UNIT_NAME); return 0;
		case "restart": deps.systemctl("restart", SYSTEMD_UNIT_NAME); return 0;
		case "status": deps.systemctl("status", SYSTEMD_UNIT_NAME); return 0;
		default: return usage(deps.stderr);
	}
}

export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
	process.exitCode = await runCli(args);
}

if (import.meta.main) await main();
