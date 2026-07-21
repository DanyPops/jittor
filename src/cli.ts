#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	BENCHMARK_MAX_QUERY_LIMIT,
	CLI_AVAILABLE_ROUTES_MAX,
	CLI_METRICS_HUMAN_MAX_ROWS,
	HUMAN_TEXT_FIELD_MAX_CHARACTERS,
	MAX_QUERY_LIMIT,
	MODEL_RANKING_DEFAULT_CONTEXT_WEIGHT,
	MODEL_RANKING_DEFAULT_COST_WEIGHT,
	MODEL_RANKING_DEFAULT_LATENCY_WEIGHT,
	MODEL_RANKING_DEFAULT_QUALITY_WEIGHT,
	MODEL_RANKING_DEFAULT_RELIABILITY_WEIGHT,
	MODEL_RANKING_MAX_SOURCES,
	SYSTEMD_UNIT_NAME,
} from "./constants.ts";
import { connectJittorClient, type JittorClient } from "./client.ts";
import { serveMain } from "./daemon.ts";
import type { BenchmarkQuery, BenchmarkQueryResult, BenchmarkRefreshResult } from "./domain/benchmark.ts";
import type { ModelRecommendationInput } from "./domain/model-ranking-service.ts";
import type { ModelCandidate, ModelRankingResult, ScopeAuthority, UtilityWeights } from "./domain/model-ranking.ts";
import { TASK_CLASSES, type ModelTaskClass } from "./domain/model-observation.ts";
import type { ContextAssessment } from "./domain/context-telemetry.ts";
import { METRIC_UNITS, type MetricObservation, type MetricQuery, type MetricUnit, type StoredMetricObservation } from "./domain/metric.ts";
import type { PolicyDecision, Route } from "./policy.ts";
import type { RouteOverride, RouterStatus, TelemetryPollResult } from "./ports/router-controller.ts";
import { EXPECTED_OPERATION_NAMES, type OperationInputs, type OperationName, type OperationOutputs } from "./service.ts";
import { resolveJittorPaths } from "./state.ts";

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

export interface CliDependencies {
	client: Pick<JittorClient, "call">;
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
		openRouterBenchmarks: process.env["JITTOR_OPENROUTER_BENCHMARKS"] === "1",
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
	stderr([
		"Usage: jittor <command> [options]",
		"  serve",
		"  service <install|start|stop|restart|status|checkpoint>",
		"  context [--since <ms>] [--until <ms>] [--json]",
		"  benchmarks <status|refresh|list|rank> [options] [--json]",
		"  metrics record --source <s> --scope <s> --metric <s> --value <number|null> --unit <unit> [--observed-at <ms>] [--attributes <json>] [--json]",
		"  metrics query [--source <s>] [--scope <s>] [--metric <s>] [--since <ms>] [--until <ms>] [--limit <n>] [--order asc|desc] [--json]",
		"  metrics prune --before <ms> [--json]",
		"  telemetry poll [--json]",
		"  router <status|decide|pause|resume|clear-override> [--json]",
		"  router override --route <provider/model@thinking> [--expires-at <ms>] [--json]",
		"  router current-route --route <provider/model@thinking> [--json]",
		"  router available-routes [--route <provider/model@thinking> ...] [--json]",
		"  op <operation> [--input <json>]",
	].join("\n"));
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

function parseRoute(raw: string | undefined): Route | null {
	if (raw === undefined) return null;
	return parseCandidate(raw);
}

interface MetricsRecordArgs { input: MetricObservation; json: boolean }

function parseMetricsRecordArgs(args: string[]): MetricsRecordArgs | null {
	let json = false;
	let source: string | undefined;
	let scope: string | undefined;
	let metric: string | undefined;
	let value: number | null | undefined;
	let unit: MetricUnit | undefined;
	let observedAt: number | undefined;
	let attributes: Record<string, unknown> | undefined;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--json") { json = true; continue; }
		if (!["--source", "--scope", "--metric", "--value", "--unit", "--observed-at", "--attributes"].includes(argument ?? "")) return null;
		const raw = args[++index];
		if (raw === undefined || raw.length === 0) return null;
		if (argument === "--source") source = raw;
		else if (argument === "--scope") scope = raw;
		else if (argument === "--metric") metric = raw;
		else if (argument === "--value") {
			if (raw.toLowerCase() === "null") value = null;
			else {
				const parsed = Number(raw);
				if (!Number.isFinite(parsed)) return null;
				value = parsed;
			}
		} else if (argument === "--unit") {
			if (!METRIC_UNITS.includes(raw as MetricUnit)) return null;
			unit = raw as MetricUnit;
		} else if (argument === "--observed-at") {
			const parsed = Number(raw);
			if (!Number.isSafeInteger(parsed) || parsed < 0) return null;
			observedAt = parsed;
		} else {
			try {
				const parsed = JSON.parse(raw);
				if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
				attributes = parsed as Record<string, unknown>;
			} catch {
				return null;
			}
		}
	}
	if (source === undefined || scope === undefined || metric === undefined || value === undefined || unit === undefined) return null;
	return {
		json,
		input: {
			source, scope, metric, value, unit,
			observedAt: observedAt ?? Date.now(),
			...(attributes ? { attributes } : {}),
		},
	};
}

interface MetricsQueryArgs { input: MetricQuery; json: boolean }

function parseMetricsQueryArgs(args: string[]): MetricsQueryArgs | null {
	let json = false;
	const input: MetricQuery = {};
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--json") { json = true; continue; }
		if (!["--source", "--scope", "--metric", "--since", "--until", "--limit", "--order"].includes(argument ?? "")) return null;
		const raw = args[++index];
		if (raw === undefined || raw.length === 0) return null;
		if (argument === "--source") input.source = raw;
		else if (argument === "--scope") input.scope = raw;
		else if (argument === "--metric") input.metric = raw;
		else if (argument === "--order") {
			if (raw !== "asc" && raw !== "desc") return null;
			input.order = raw;
		} else {
			const parsed = Number(raw);
			if (!Number.isSafeInteger(parsed) || parsed < 0) return null;
			if (argument === "--since") input.since = parsed;
			else if (argument === "--until") input.until = parsed;
			else {
				if (parsed < 1 || parsed > MAX_QUERY_LIMIT) return null;
				input.limit = parsed;
			}
		}
	}
	if (input.since !== undefined && input.until !== undefined && input.until < input.since) return null;
	return { input, json };
}

interface MetricsPruneArgs { input: { before: number }; json: boolean }

function parseMetricsPruneArgs(args: string[]): MetricsPruneArgs | null {
	let json = false;
	let before: number | undefined;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--json") { json = true; continue; }
		if (argument !== "--before") return null;
		const raw = args[++index];
		const parsed = Number(raw);
		if (!Number.isSafeInteger(parsed) || parsed < 0) return null;
		before = parsed;
	}
	if (before === undefined) return null;
	return { input: { before }, json };
}

interface RouterOverrideArgs { input: RouteOverride; json: boolean }

function parseRouterOverrideArgs(args: string[]): RouterOverrideArgs | null {
	let json = false;
	let route: Route | null = null;
	let expiresAt: number | null = null;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--json") { json = true; continue; }
		if (!["--route", "--expires-at"].includes(argument ?? "")) return null;
		const raw = args[++index];
		if (raw === undefined || raw.length === 0) return null;
		if (argument === "--route") {
			route = parseRoute(raw);
			if (!route) return null;
		} else {
			const parsed = Number(raw);
			if (!Number.isSafeInteger(parsed) || parsed < 0) return null;
			expiresAt = parsed;
		}
	}
	if (!route) return null;
	return { input: { route, expiresAt }, json };
}

interface RouterRouteArgs { input: Route; json: boolean }

function parseRouterRouteArgs(args: string[]): RouterRouteArgs | null {
	let json = false;
	let route: Route | null = null;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--json") { json = true; continue; }
		if (argument !== "--route") return null;
		const raw = args[++index];
		if (raw === undefined) return null;
		route = parseRoute(raw);
		if (!route) return null;
	}
	if (!route) return null;
	return { input: route, json };
}

interface RouterAvailableRoutesArgs { input: { routes: Route[] }; json: boolean }

function parseRouterAvailableRoutesArgs(args: string[]): RouterAvailableRoutesArgs | null {
	let json = false;
	const routes: Route[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--json") { json = true; continue; }
		if (argument !== "--route") return null;
		const raw = args[++index];
		if (raw === undefined) return null;
		const route = parseRoute(raw);
		if (!route) return null;
		if (routes.length >= CLI_AVAILABLE_ROUTES_MAX) return null;
		routes.push(route);
	}
	return { input: { routes }, json };
}

function parseJsonOnlyArgs(args: string[]): { json: boolean } | null {
	let json = false;
	for (const argument of args) {
		if (argument !== "--json") return null;
		json = true;
	}
	return { json };
}

function parseOpArgs(args: string[]): { operation: OperationName; input: Record<string, unknown> } | null {
	const [operation, ...rest] = args;
	if (operation === undefined || !EXPECTED_OPERATION_NAMES.includes(operation as OperationName)) return null;
	let input: Record<string, unknown> = {};
	for (let index = 0; index < rest.length; index += 1) {
		if (rest[index] !== "--input") return null;
		const raw = rest[++index];
		if (raw === undefined) return null;
		try {
			const parsed = JSON.parse(raw);
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
			input = parsed as Record<string, unknown>;
		} catch {
			return null;
		}
	}
	return { operation: operation as OperationName, input };
}

interface BenchmarkArgs {
	action: "status" | "refresh" | "list" | "rank";
	json: boolean;
	force: boolean;
	query?: BenchmarkQuery;
	recommendation?: ModelRecommendationInput;
}

function parseCandidate(raw: string): ModelCandidate | null {
	const separator = raw.indexOf("/");
	const thinkingSeparator = raw.lastIndexOf("@");
	if (separator <= 0 || thinkingSeparator <= separator + 1 || thinkingSeparator === raw.length - 1) return null;
	return { provider: raw.slice(0, separator), model: raw.slice(separator + 1, thinkingSeparator), thinking: raw.slice(thinkingSeparator + 1) };
}

function parseBenchmarkArgs(action: string | undefined, args: string[]): BenchmarkArgs | null {
	if (action !== "status" && action !== "refresh" && action !== "list" && action !== "rank") return null;
	let json = false;
	let force = false;
	const query: Partial<BenchmarkQuery> = {};
	const candidates: ModelCandidate[] = [];
	const sourceIds: string[] = [];
	let scopeAuthority: ScopeAuthority = "available-models";
	let taskClass: ModelTaskClass = "general";
	let budgetPressure = 0;
	const weights: UtilityWeights = {
		quality: MODEL_RANKING_DEFAULT_QUALITY_WEIGHT, cost: MODEL_RANKING_DEFAULT_COST_WEIGHT,
		latency: MODEL_RANKING_DEFAULT_LATENCY_WEIGHT, context: MODEL_RANKING_DEFAULT_CONTEXT_WEIGHT,
		reliability: MODEL_RANKING_DEFAULT_RELIABILITY_WEIGHT,
	};
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--json") { json = true; continue; }
		if (argument === "--force" && action === "refresh") { force = true; continue; }
		const allowed = action === "list" ? ["--source", "--model", "--dimension", "--limit"]
			: action === "rank" ? ["--candidate", "--source", "--task", "--scope", "--budget", "--weight-quality", "--weight-cost", "--weight-latency", "--weight-context", "--weight-reliability"] : [];
		if (!allowed.includes(argument ?? "")) return null;
		const raw = args[++index];
		if (raw === undefined || raw.length === 0) return null;
		if (action === "list") {
			if (argument === "--limit") {
				const limit = Number(raw);
				if (!Number.isSafeInteger(limit) || limit < 1 || limit > BENCHMARK_MAX_QUERY_LIMIT) return null;
				query.limit = limit;
			} else if (argument === "--source") query.sourceId = raw;
			else if (argument === "--model") query.model = raw;
			else query.dimension = raw;
			continue;
		}
		if (argument === "--candidate") {
			const candidate = parseCandidate(raw);
			if (!candidate) return null;
			candidates.push(candidate);
		} else if (argument === "--source") sourceIds.push(raw);
		else if (argument === "--task") {
			if (!TASK_CLASSES.includes(raw as ModelTaskClass)) return null;
			taskClass = raw as ModelTaskClass;
		} else if (argument === "--scope") {
			if (raw !== "exact-session" && raw !== "available-models") return null;
			scopeAuthority = raw;
		} else if (argument === "--budget") budgetPressure = Number(raw);
		else {
			const weight = Number(raw);
			if (!Number.isFinite(weight) || weight < 0 || weight > 10) return null;
			weights[argument!.slice("--weight-".length) as keyof UtilityWeights] = weight;
		}
	}
	if (action === "list" && query.sourceId === undefined) return null;
	if (action === "rank" && (candidates.length === 0 || sourceIds.length > MODEL_RANKING_MAX_SOURCES || !Number.isFinite(budgetPressure) || budgetPressure < 0 || budgetPressure > 2)) return null;
	return {
		action, json, force,
		...(action === "list" ? { query: query as BenchmarkQuery } : {}),
		...(action === "rank" ? { recommendation: { candidates, sourceIds: [...new Set(sourceIds)], scopeAuthority, taskClass, budgetPressure, weights } } : {}),
	};
}

function value(value: number | null, suffix = ""): string {
	return value === null ? "unknown" : `${Math.round(value).toLocaleString()}${suffix}`;
}

export function formatBenchmarkStatus(result: BenchmarkRefreshResult): string {
	if (result.sources.length === 0) return "Benchmark sources: none configured";
	return ["Benchmark sources:", ...result.sources.map((source) => {
		const state = source.ok === null ? "not refreshed" : source.ok ? "ready" : "refresh failed";
		return `- ${source.id}: ${state} · ${source.observations.toLocaleString()} observations · ${source.hasEvidence ? "evidence retained" : "no evidence"}`;
	})].join("\n");
}

function humanField(value: string): string {
	return value.length <= HUMAN_TEXT_FIELD_MAX_CHARACTERS ? value : `${value.slice(0, HUMAN_TEXT_FIELD_MAX_CHARACTERS - 1)}…`;
}

export function formatBenchmarkQuery(result: BenchmarkQueryResult): string {
	return [
		`Benchmark evidence: ${humanField(result.sourceId)} · ${result.completeness} · ${result.freshness} · ${result.observations.length.toLocaleString()} observations`,
		...result.observations.map((observation) => `- ${humanField(observation.model.canonical)} · ${humanField(observation.dimension)} ${observation.value.toLocaleString()} ${observation.unit} · ${humanField(observation.provenance.publisher)} · confidence ${(observation.provenance.confidence * 100).toFixed(0)}%`),
	].join("\n");
}

export function formatModelRanking(result: ModelRankingResult): string {
	return [
		`Model ranking: ${result.completeness} · scope ${result.scopeAuthority}${result.scopeWarning ? " · advisory only" : ""}`,
		...result.ranked.map((item, index) => `${index + 1}. ${humanField(item.identity)} · utility ${item.utility === null ? "unknown" : item.utility.toFixed(3)} · confidence ${(item.confidence * 100).toFixed(0)}%`),
		...(result.scopeWarning ? [result.scopeWarning] : []),
	].join("\n");
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

function formatRoute(route: Route): string {
	return `${humanField(route.provider)}/${humanField(route.model)} · ${humanField(route.thinking)}`;
}

export function formatMetricsQuery(rows: StoredMetricObservation[]): string {
	if (rows.length === 0) return "Metrics: no observations matched";
	const shown = rows.slice(0, CLI_METRICS_HUMAN_MAX_ROWS);
	const lines = [
		`Metrics: ${rows.length.toLocaleString()} observation(s)${rows.length > shown.length ? ` (showing first ${shown.length})` : ""}`,
		...shown.map((row) => `- ${humanField(row.source)}/${humanField(row.scope)}/${humanField(row.metric)} = ${row.value === null ? "null" : row.value} ${row.unit} @ ${new Date(row.observedAt).toISOString()}`),
	];
	return lines.join("\n");
}

export function formatTelemetryPoll(result: TelemetryPollResult): string {
	if (result.sources.length === 0) return "Telemetry: no sources configured";
	return ["Telemetry:", ...result.sources.map((source) => {
		const freshness = !source.ok ? `failed${source.error ? ` (${humanField(source.error)})` : ""}` : "ok";
		return `- ${humanField(source.id)} (${humanField(source.provider)}): ${freshness} · ${source.metrics} metric(s)`;
	})].join("\n");
}

export function formatRouterStatus(status: RouterStatus): string {
	const lines = [
		`Router: ${status.ready ? "ready" : "not ready"}${status.paused ? " · paused" : ""}`,
		`Current route: ${status.currentRoute ? formatRoute(status.currentRoute) : "none"}`,
		`Available routes: ${status.availableRoutes.length.toLocaleString()}`,
		`Override: ${status.override ? `${formatRoute(status.override.route)}${status.override.expiresAt === null ? "" : ` (expires ${new Date(status.override.expiresAt).toISOString()})`}` : "none"}`,
	];
	if (status.lastDecision) lines.push(`Last decision: ${status.lastDecision.action} · pressure ${Number.isFinite(status.lastDecision.pressure) ? status.lastDecision.pressure.toFixed(3) : "∞"} · ${humanField(status.lastDecision.reason)}`);
	lines.push(formatTelemetryPoll({ sources: status.sources, observedAt: Date.now() }));
	return lines.join("\n");
}

export function formatPolicyDecision(decision: PolicyDecision): string {
	const lines = [`Decision: ${decision.action} · pressure ${Number.isFinite(decision.pressure) ? decision.pressure.toFixed(3) : "∞"} · ${humanField(decision.reason)}`];
	if (decision.route) lines.push(`Route: ${formatRoute(decision.route)}`);
	if (decision.delayMs !== undefined) lines.push(`Delay: ${decision.delayMs}ms`);
	return lines.join("\n");
}

async function callAndPrint<Name extends OperationName>(
	deps: CliDependencies,
	operation: Name,
	input: OperationInputs[Name],
	json: boolean,
	formatHuman: (result: OperationOutputs[Name]) => string,
): Promise<number> {
	try {
		const result = await deps.client.call(operation, input);
		deps.stdout(json ? JSON.stringify(result) : formatHuman(result));
		return 0;
	} catch (error) {
		deps.stderr(error instanceof Error ? error.message : String(error));
		return 1;
	}
}

export async function runCli(args: string[], deps: CliDependencies = DEFAULT_DEPENDENCIES): Promise<number> {
	const [command, action, ...rest] = args;
	if (command === "serve") { deps.serve(); return 0; }
	if (command === "metrics") {
		if (action === "record") {
			const parsed = parseMetricsRecordArgs(rest);
			if (!parsed) return usage(deps.stderr);
			return callAndPrint(deps, "metrics.record", parsed.input, parsed.json, (row) => formatMetricsQuery([row]));
		}
		if (action === "query") {
			const parsed = parseMetricsQueryArgs(rest);
			if (!parsed) return usage(deps.stderr);
			return callAndPrint(deps, "metrics.query", parsed.input, parsed.json, formatMetricsQuery);
		}
		if (action === "prune") {
			const parsed = parseMetricsPruneArgs(rest);
			if (!parsed) return usage(deps.stderr);
			return callAndPrint(deps, "metrics.prune", parsed.input, parsed.json, (result) => `Pruned ${result.deleted.toLocaleString()} observation(s)`);
		}
		return usage(deps.stderr);
	}
	if (command === "telemetry") {
		if (action !== "poll") return usage(deps.stderr);
		const parsed = parseJsonOnlyArgs(rest);
		if (!parsed) return usage(deps.stderr);
		return callAndPrint(deps, "telemetry.poll", {}, parsed.json, formatTelemetryPoll);
	}
	if (command === "router") {
		switch (action) {
			case "status": {
				const parsed = parseJsonOnlyArgs(rest);
				if (!parsed) return usage(deps.stderr);
				return callAndPrint(deps, "router.status", {}, parsed.json, formatRouterStatus);
			}
			case "decide": {
				const parsed = parseJsonOnlyArgs(rest);
				if (!parsed) return usage(deps.stderr);
				return callAndPrint(deps, "router.decide", {}, parsed.json, formatPolicyDecision);
			}
			case "pause": {
				const parsed = parseJsonOnlyArgs(rest);
				if (!parsed) return usage(deps.stderr);
				return callAndPrint(deps, "router.pause", {}, parsed.json, formatRouterStatus);
			}
			case "resume": {
				const parsed = parseJsonOnlyArgs(rest);
				if (!parsed) return usage(deps.stderr);
				return callAndPrint(deps, "router.resume", {}, parsed.json, formatRouterStatus);
			}
			case "clear-override": {
				const parsed = parseJsonOnlyArgs(rest);
				if (!parsed) return usage(deps.stderr);
				return callAndPrint(deps, "router.clear_override", {}, parsed.json, formatRouterStatus);
			}
			case "override": {
				const parsed = parseRouterOverrideArgs(rest);
				if (!parsed) return usage(deps.stderr);
				return callAndPrint(deps, "router.override", parsed.input, parsed.json, formatRouterStatus);
			}
			case "current-route": {
				const parsed = parseRouterRouteArgs(rest);
				if (!parsed) return usage(deps.stderr);
				return callAndPrint(deps, "router.current_route", parsed.input, parsed.json, formatRouterStatus);
			}
			case "available-routes": {
				const parsed = parseRouterAvailableRoutesArgs(rest);
				if (!parsed) return usage(deps.stderr);
				return callAndPrint(deps, "router.available_routes", parsed.input, parsed.json, formatRouterStatus);
			}
			default: return usage(deps.stderr);
		}
	}
	if (command === "op") {
		const parsed = parseOpArgs(action === undefined ? [] : [action, ...rest]);
		if (!parsed) return usage(deps.stderr);
		try {
			// The escape hatch dispatches a dynamically named operation; OperationInputs/OperationOutputs
			// are only known statically per literal operation name, so this one call site is intentionally
			// untyped at the boundary. parseOpArgs already restricts `operation` to EXPECTED_OPERATION_NAMES.
			const call = deps.client.call as (operation: OperationName, input: Record<string, unknown>) => Promise<unknown>;
			const result = await call(parsed.operation, parsed.input);
			deps.stdout(JSON.stringify(result));
			return 0;
		} catch (error) {
			deps.stderr(error instanceof Error ? error.message : String(error));
			return 1;
		}
	}
	if (command === "benchmarks") {
		const parsed = parseBenchmarkArgs(action, rest);
		if (!parsed) return usage(deps.stderr);
		try {
			if (parsed.action === "list") {
				const result = await deps.client.call("benchmark.query", parsed.query!);
				deps.stdout(parsed.json ? JSON.stringify(result) : formatBenchmarkQuery(result));
			} else if (parsed.action === "rank") {
				const result = await deps.client.call("models.rank", parsed.recommendation!);
				deps.stdout(parsed.json ? JSON.stringify(result) : formatModelRanking(result));
			} else {
				const result = parsed.action === "refresh"
					? await deps.client.call("benchmark.refresh", { force: parsed.force })
					: await deps.client.call("benchmark.status", {});
				deps.stdout(parsed.json ? JSON.stringify(result) : formatBenchmarkStatus(result));
			}
			return 0;
		} catch (error) {
			deps.stderr(error instanceof Error ? error.message : String(error));
			return 1;
		}
	}
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
		case "checkpoint": {
			const parsed = parseJsonOnlyArgs(rest);
			if (!parsed) return usage(deps.stderr);
			return callAndPrint(deps, "service.checkpoint", {}, parsed.json, () => "Checkpoint complete");
		}
		default: return usage(deps.stderr);
	}
}

export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
	process.exitCode = await runCli(args);
}

if (import.meta.main) await main();
