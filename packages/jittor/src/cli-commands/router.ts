import { CLI_AVAILABLE_ROUTES_MAX } from "../constants.ts";
import type { PolicyDecision, Route } from "../policy.ts";
import type { RouteOverride, RouterStatus, TelemetryPollResult } from "../ports/router-controller.ts";
import { parseRoute } from "./route-args.ts";
import { type CliDependencies, callAndPrint, humanField } from "./support.ts";

export const ROUTER_USAGE_LINES = [
	"  telemetry poll [--json]",
	"  compaction estimate [--json]",
	"  router <status|decide|pause|resume|clear-override> [--session-id <id>] [--session-secret <secret>] [--json]",
	"  router override --route <provider/model@thinking> [--expires-at <ms>] [--session-id <id>] [--session-secret <secret>] [--json]",
	"  router current-route --route <provider/model@thinking> [--session-id <id>] [--session-secret <secret>] [--json]",
	"  router available-routes [--route <provider/model@thinking> ...] [--session-id <id>] [--session-secret <secret>] [--json]",
];

interface SessionScope {
	session_id?: string;
	session_secret?: string;
}

function sessionScopeInput(sessionId: string | undefined, sessionSecret: string | undefined): SessionScope {
	return { ...(sessionId ? { session_id: sessionId } : {}), ...(sessionSecret ? { session_secret: sessionSecret } : {}) };
}

interface RouterOverrideArgs {
	input: RouteOverride & SessionScope;
	json: boolean;
}

function parseRouterOverrideArgs(args: string[]): RouterOverrideArgs | null {
	let json = false;
	let route: Route | null = null;
	let expiresAt: number | null = null;
	let sessionId: string | undefined;
	let sessionSecret: string | undefined;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--json") {
			json = true;
			continue;
		}
		if (!["--route", "--expires-at", "--session-id", "--session-secret"].includes(argument ?? "")) return null;
		const raw = args[++index];
		if (raw === undefined || raw.length === 0) return null;
		if (argument === "--session-id") sessionId = raw;
		else if (argument === "--session-secret") sessionSecret = raw;
		else if (argument === "--route") {
			route = parseRoute(raw);
			if (!route) return null;
		} else {
			const parsed = Number(raw);
			if (!Number.isSafeInteger(parsed) || parsed < 0) return null;
			expiresAt = parsed;
		}
	}
	if (!route) return null;
	return { input: { route, expiresAt, ...sessionScopeInput(sessionId, sessionSecret) }, json };
}

interface RouterRouteArgs {
	input: Route & SessionScope;
	json: boolean;
}

function parseRouterRouteArgs(args: string[]): RouterRouteArgs | null {
	let json = false;
	let route: Route | null = null;
	let sessionId: string | undefined;
	let sessionSecret: string | undefined;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--json") {
			json = true;
			continue;
		}
		if (!["--route", "--session-id", "--session-secret"].includes(argument ?? "")) return null;
		const raw = args[++index];
		if (raw === undefined || raw.length === 0) return null;
		if (argument === "--session-id") sessionId = raw;
		else if (argument === "--session-secret") sessionSecret = raw;
		else {
			route = parseRoute(raw);
			if (!route) return null;
		}
	}
	if (!route) return null;
	return { input: { ...route, ...sessionScopeInput(sessionId, sessionSecret) }, json };
}

interface RouterAvailableRoutesArgs {
	input: { routes: Route[] } & SessionScope;
	json: boolean;
}

function parseRouterAvailableRoutesArgs(args: string[]): RouterAvailableRoutesArgs | null {
	let json = false;
	let sessionId: string | undefined;
	let sessionSecret: string | undefined;
	const routes: Route[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--json") {
			json = true;
			continue;
		}
		if (!["--route", "--session-id", "--session-secret"].includes(argument ?? "")) return null;
		const raw = args[++index];
		if (raw === undefined || raw.length === 0) return null;
		if (argument === "--session-id") sessionId = raw;
		else if (argument === "--session-secret") sessionSecret = raw;
		else {
			const route = parseRoute(raw);
			if (!route) return null;
			if (routes.length >= CLI_AVAILABLE_ROUTES_MAX) return null;
			routes.push(route);
		}
	}
	return { input: { routes, ...sessionScopeInput(sessionId, sessionSecret) }, json };
}

function parseRouterScopeArgs(args: string[]): { input: SessionScope; json: boolean } | null {
	let json = false;
	let sessionId: string | undefined;
	let sessionSecret: string | undefined;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--json") {
			json = true;
			continue;
		}
		if (!["--session-id", "--session-secret"].includes(argument ?? "")) return null;
		const raw = args[++index];
		if (raw === undefined || raw.length === 0) return null;
		if (argument === "--session-id") sessionId = raw;
		else sessionSecret = raw;
	}
	return { input: sessionScopeInput(sessionId, sessionSecret), json };
}

export function parseJsonOnlyArgs(args: string[]): { json: boolean } | null {
	let json = false;
	for (const argument of args) {
		if (argument !== "--json") return null;
		json = true;
	}
	return { json };
}

function formatRoute(route: Route): string {
	return `${humanField(route.provider)}/${humanField(route.model)} · ${humanField(route.thinking)}`;
}

export function formatTelemetryPoll(result: TelemetryPollResult): string {
	if (result.sources.length === 0) return "Telemetry: no sources configured";
	return [
		"Telemetry:",
		...result.sources.map((source) => {
			const freshness = !source.ok ? `failed${source.error ? ` (${humanField(source.error)})` : ""}` : "ok";
			return `- ${humanField(source.id)} (${humanField(source.provider)}): ${freshness} · ${source.metrics} metric(s)`;
		}),
	].join("\n");
}

export function formatRouterStatus(status: RouterStatus): string {
	const lines = [
		`Router: ${status.ready ? "ready" : "not ready"}${status.paused ? " · paused" : ""}`,
		`Current route: ${status.currentRoute ? formatRoute(status.currentRoute) : "none"}`,
		`Available routes: ${status.availableRoutes.length.toLocaleString()}`,
		`Override: ${status.override ? `${formatRoute(status.override.route)}${status.override.expiresAt === null ? "" : ` (expires ${new Date(status.override.expiresAt).toISOString()})`}` : "none"}`,
	];
	if (status.lastDecision)
		lines.push(
			`Last decision: ${status.lastDecision.action} · pressure ${Number.isFinite(status.lastDecision.pressure) ? status.lastDecision.pressure.toFixed(3) : "∞"} · ${humanField(status.lastDecision.reason)}`,
		);
	lines.push(formatTelemetryPoll({ sources: status.sources, observedAt: Date.now() }));
	return lines.join("\n");
}

export function formatPolicyDecision(decision: PolicyDecision): string {
	const lines = [
		`Decision: ${decision.action} · pressure ${Number.isFinite(decision.pressure) ? decision.pressure.toFixed(3) : "∞"} · ${humanField(decision.reason)}`,
	];
	if (decision.route) lines.push(`Route: ${formatRoute(decision.route)}`);
	if (decision.delayMs !== undefined) lines.push(`Delay: ${decision.delayMs}ms`);
	return lines.join("\n");
}

export async function runTelemetryCommand(
	action: string | undefined,
	rest: string[],
	deps: CliDependencies,
	usage: () => number,
): Promise<number> {
	if (action !== "poll") return usage();
	const parsed = parseJsonOnlyArgs(rest);
	if (!parsed) return usage();
	return callAndPrint(deps, "telemetry.poll", {}, parsed.json, formatTelemetryPoll);
}

export async function runRouterCommand(
	action: string | undefined,
	rest: string[],
	deps: CliDependencies,
	usage: () => number,
): Promise<number> {
	switch (action) {
		case "status": {
			const parsed = parseRouterScopeArgs(rest);
			if (!parsed) return usage();
			return callAndPrint(deps, "router.status", parsed.input, parsed.json, formatRouterStatus);
		}
		case "decide": {
			const parsed = parseRouterScopeArgs(rest);
			if (!parsed) return usage();
			return callAndPrint(deps, "router.decide", parsed.input, parsed.json, formatPolicyDecision);
		}
		case "pause": {
			const parsed = parseRouterScopeArgs(rest);
			if (!parsed) return usage();
			return callAndPrint(deps, "router.pause", parsed.input, parsed.json, formatRouterStatus);
		}
		case "resume": {
			const parsed = parseRouterScopeArgs(rest);
			if (!parsed) return usage();
			return callAndPrint(deps, "router.resume", parsed.input, parsed.json, formatRouterStatus);
		}
		case "clear-override": {
			const parsed = parseRouterScopeArgs(rest);
			if (!parsed) return usage();
			return callAndPrint(deps, "router.clear_override", parsed.input, parsed.json, formatRouterStatus);
		}
		case "override": {
			const parsed = parseRouterOverrideArgs(rest);
			if (!parsed) return usage();
			return callAndPrint(deps, "router.override", parsed.input, parsed.json, formatRouterStatus);
		}
		case "current-route": {
			const parsed = parseRouterRouteArgs(rest);
			if (!parsed) return usage();
			return callAndPrint(deps, "router.current_route", parsed.input, parsed.json, formatRouterStatus);
		}
		case "available-routes": {
			const parsed = parseRouterAvailableRoutesArgs(rest);
			if (!parsed) return usage();
			return callAndPrint(deps, "router.available_routes", parsed.input, parsed.json, formatRouterStatus);
		}
		default:
			return usage();
	}
}
