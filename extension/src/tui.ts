import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { HUMAN_STATUS_MAX_SOURCES, HUMAN_TEXT_FIELD_MAX_CHARACTERS } from "../../src/constants.ts";
import type { StoredMetricObservation } from "../../src/domain/metric.ts";
import type { PolicyAction, Route } from "../../src/policy.ts";
import type { RouterStatus } from "../../src/ports/router-controller.ts";
import type { ProviderBudget } from "./footer.ts";

export interface JittorPanelClient {
	call(operation: string, input: unknown): Promise<any>;
}

type PanelAction = "pause" | "resume" | "refresh" | "override" | "clear-override" | "close";

function latest(rows: StoredMetricObservation[], predicate: (row: StoredMetricObservation) => boolean): StoredMetricObservation | undefined {
	return rows.filter(predicate).sort((left, right) => right.observedAt - left.observedAt || right.id - left.id)[0];
}

function sanitizedText(value: string): string {
	return value.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim().slice(0, HUMAN_TEXT_FIELD_MAX_CHARACTERS);
}

function routeText(route: Route): string {
	return `${sanitizedText(route.provider)}/${sanitizedText(route.model)} · ${sanitizedText(route.thinking)}`;
}

function normalizedIdentity(value: unknown): string {
	return typeof value === "string" ? value.toLowerCase().replace(/[^a-z0-9]+/g, "") : "";
}

function longestWindow(rows: StoredMetricObservation[]): StoredMetricObservation | undefined {
	return [...rows].sort((left, right) =>
		Number(right.attributes["windowSeconds"] ?? 0) - Number(left.attributes["windowSeconds"] ?? 0)
		|| right.observedAt - left.observedAt
		|| right.id - left.id,
	)[0];
}

function codexWindowForModel(rows: StoredMetricObservation[], model: string): StoredMetricObservation | undefined {
	const codexRows = rows.filter((row) => row.source === "codex-subscription" && row.metric === "used-fraction" && typeof row.value === "number");
	const modelIdentity = normalizedIdentity(model);
	const matchingAdditional = codexRows.filter((row) => {
		const limitId = normalizedIdentity(row.attributes["limitId"]);
		const limitName = normalizedIdentity(row.attributes["limitName"]);
		return limitId !== "codex" && limitName.length > 0 && limitName === modelIdentity;
	});
	if (matchingAdditional.length > 0) return longestWindow(matchingAdditional);
	return longestWindow(codexRows.filter((row) => {
		const limitId = normalizedIdentity(row.attributes["limitId"]);
		return limitId === "codex" || (limitId.length === 0 && row.scope.startsWith("codex:"));
	}));
}

function compactWindowName(seconds: number): string {
	if (seconds >= 6 * 24 * 60 * 60) return "W";
	if (seconds >= 60 * 60) return `${Math.round(seconds / 3_600)}h`;
	return `${Math.round(seconds / 60)}m`;
}

function windowName(seconds: number): string {
	if (seconds >= 6 * 24 * 60 * 60) return "weekly";
	if (seconds >= 60 * 60) return `${Math.round(seconds / 3_600)}h`;
	return `${Math.round(seconds / 60)}m`;
}

export function buildFooterBudget(status: RouterStatus, metrics: StoredMetricObservation[]): ProviderBudget | null {
	if (!status.ready || !status.currentRoute) return null;
	if (status.currentRoute.provider === "openai-codex") {
		const codex = codexWindowForModel(metrics, status.currentRoute.model);
		if (!codex || typeof codex.value !== "number") return null;
		const resetsAtSeconds = Number(codex.attributes["resetsAt"]);
		return {
			kind: "bounded",
			label: compactWindowName(Number(codex.attributes["windowSeconds"] ?? 0)),
			remainingFraction: 1 - codex.value,
			observedAt: codex.observedAt,
			...(Number.isFinite(resetsAtSeconds) && resetsAtSeconds > 0 ? { resetsAt: resetsAtSeconds * 1_000 } : {}),
		};
	}
	if (status.currentRoute.provider === "anthropic") {
		const anthropic = latest(metrics, (row) => row.source === "anthropic" && row.metric === "used-fraction" && row.scope === "tokens" && typeof row.value === "number")
			?? latest(metrics, (row) => row.source === "anthropic" && row.metric === "used-fraction" && row.scope === "requests" && typeof row.value === "number");
		if (!anthropic || typeof anthropic.value !== "number") return null;
		const resetsAt = Number(anthropic.attributes["resetsAt"]);
		return {
			kind: "bounded",
			label: anthropic.scope === "tokens" ? "tok" : "req",
			remainingFraction: 1 - anthropic.value,
			observedAt: anthropic.observedAt,
			...(Number.isFinite(resetsAt) && resetsAt > 0 ? { resetsAt } : {}),
		};
	}
	if (status.currentRoute.provider === "openrouter") {
		const openRouter = latest(metrics, (row) => row.source === "openrouter" && row.metric === "usage" && typeof row.value === "number");
		const remaining = latest(metrics, (row) => row.source === "openrouter" && row.metric === "remaining-fraction" && typeof row.value === "number");
		if (remaining && typeof remaining.value === "number" && (!openRouter || remaining.observedAt >= openRouter.observedAt)) {
			const reset = typeof remaining.attributes["reset"] === "string" ? sanitizedText(remaining.attributes["reset"]) : undefined;
			return {
				kind: "bounded",
				label: "OR",
				remainingFraction: remaining.value,
				observedAt: remaining.observedAt,
				...(reset ? { resetText: `${reset} reset` } : {}),
			};
		}
		if (!openRouter || typeof openRouter.value !== "number") return null;
		return { kind: "unbounded", label: "spend", valueText: `$${openRouter.value.toFixed(3)}`, observedAt: openRouter.observedAt };
	}
	return null;
}

export function formatFooterStatus(status: RouterStatus, metrics: StoredMetricObservation[]): string {
	const budget = buildFooterBudget(status, metrics);
	if (!budget) return "";
	return budget.kind === "unbounded" ? budget.valueText : `${budget.label} ${(budget.remainingFraction * 100).toFixed(1)}% left`;
}

function nextAction(action: PolicyAction | undefined): string {
	switch (action) {
		case "continue": return "throttle";
		case "throttle": return "lower thinking";
		case "lower-thinking": return "switch model";
		case "switch-model": return "switch provider";
		case "switch-provider": return "halt";
		case "halt": return "halted";
		default: return "waiting for decision";
	}
}

function burnLine(rows: StoredMetricObservation[], current: StoredMetricObservation, now: number): string {
	const previous = rows
		.filter((row) => row.source === current.source && row.scope === current.scope && row.metric === current.metric && row.id !== current.id && row.observedAt < current.observedAt)
		.sort((left, right) => right.observedAt - left.observedAt)[0];
	const resetsAt = Number(current.attributes["resetsAt"] ?? 0) * 1_000;
	const remainingSeconds = (resetsAt - now) / 1_000;
	const sustainable = typeof current.value === "number" && remainingSeconds > 0 ? (1 - current.value) / remainingSeconds : null;
	const observed = previous && typeof previous.value === "number" && typeof current.value === "number" && current.observedAt > previous.observedAt
		? (current.value - previous.value) / ((current.observedAt - previous.observedAt) / 1_000)
		: null;
	const perHour = (rate: number | null) => rate === null ? "n/a" : `${(rate * 3_600 * 100).toFixed(2)}%/h`;
	return `Burn: observed ${perHour(observed)} · sustainable ${perHour(sustainable)}`;
}

export function buildStatusView(status: RouterStatus, metrics: StoredMetricObservation[], now = Date.now()): string[] {
	const lines = [status.ready ? "Ready" : "Not ready"];
	const codex = status.currentRoute?.provider === "openai-codex" ? codexWindowForModel(metrics, status.currentRoute.model) : undefined;
	if (codex && typeof codex.value === "number") {
		const seconds = Number(codex.attributes["windowSeconds"] ?? 0);
		lines.push(`Codex ${windowName(seconds)}: ${((1 - codex.value) * 100).toFixed(1)}% left`);
		lines.push(burnLine(metrics, codex, now));
	}
	const openRouter = status.currentRoute?.provider === "openrouter"
		? latest(metrics, (row) => row.source === "openrouter" && row.metric === "usage" && typeof row.value === "number")
		: undefined;
	if (openRouter && typeof openRouter.value === "number") lines.push(`OpenRouter spend: $${openRouter.value.toFixed(3)}`);
	const anthropic = status.currentRoute?.provider === "anthropic"
		? latest(metrics, (row) => row.source === "anthropic" && row.metric === "used-fraction" && row.scope === "tokens" && typeof row.value === "number")
			?? latest(metrics, (row) => row.source === "anthropic" && row.metric === "used-fraction" && row.scope === "requests" && typeof row.value === "number")
		: undefined;
	if (anthropic && typeof anthropic.value === "number") lines.push(`Anthropic ${anthropic.scope}: ${((1 - anthropic.value) * 100).toFixed(1)}% left`);
	if (status.currentRoute) lines.push(`Route: ${routeText(status.currentRoute)}`);
	if (status.lastDecision) lines.push(`Pressure: ${Number.isFinite(status.lastDecision.pressure) ? status.lastDecision.pressure.toFixed(3) : "∞"} · ${status.lastDecision.action}`);
	lines.push(`Next: ${nextAction(status.lastDecision?.action)}`);
	lines.push("Telemetry:");
	const providerSources = status.sources.filter((source) => source.provider === status.currentRoute?.provider);
	for (const source of providerSources.slice(0, HUMAN_STATUS_MAX_SOURCES)) {
		const freshness = !source.ok ? "failed" : source.observedAt !== undefined && now - source.observedAt > 120_000 ? "stale" : "fresh";
		lines.push(`  ${sanitizedText(source.id)}: ${freshness} · ${source.metrics} metrics`);
	}
	if (providerSources.length > HUMAN_STATUS_MAX_SOURCES) lines.push(`  … ${providerSources.length - HUMAN_STATUS_MAX_SOURCES} more telemetry sources omitted`);
	if (status.override) lines.push(`Override: ${routeText(status.override.route)}`);
	if (status.paused) lines.push("Emergency halt is active");
	return lines;
}

async function snapshot(client: JittorPanelClient): Promise<{ status: RouterStatus; metrics: StoredMetricObservation[] }> {
	const status = await client.call("router.status", {}) as RouterStatus;
	const provider = status.currentRoute?.provider;
	const query = provider === "openai-codex"
		? { source: "codex-subscription", metric: "used-fraction", order: "desc", limit: 100 }
		: provider === "openrouter" ? { source: "openrouter", order: "desc", limit: 20 } : null;
	const metrics = query ? await client.call("metrics.query", query) as StoredMetricObservation[] : [];
	return { status, metrics };
}

async function chooseOverride(ctx: ExtensionCommandContext, routes: Route[]): Promise<Route | undefined> {
	if (routes.length === 0) { ctx.ui.notify("Pi reports no authenticated routes for the current provider.", "warning"); return undefined; }
	const labels = routes.map(routeText);
	const selected = await ctx.ui.select("Override route", labels);
	const index = selected ? labels.indexOf(selected) : -1;
	return index >= 0 ? routes[index] : undefined;
}

export async function showJittorPanel(ctx: ExtensionCommandContext, client: JittorPanelClient): Promise<void> {
	for (;;) {
		const current = await snapshot(client);
		if (ctx.mode !== "tui") {
			ctx.ui.notify(buildStatusView(current.status, current.metrics).join("\n"), "info");
			return;
		}
		const action = await ctx.ui.custom<PanelAction>((_tui, theme, _keybindings, done) => ({
			invalidate() {},
			render(width: number): string[] {
				const border = theme.fg("borderMuted", "─".repeat(Math.max(1, width)));
				const controls = current.status.paused
					? "r refresh · p release emergency halt · o override · c clear override · Esc close"
					: "r refresh · p emergency halt · o override · c clear override · Esc close";
				return [
					border,
					truncateToWidth(theme.bold("Jittor"), width, ""),
					border,
					...buildStatusView(current.status, current.metrics).map((line) => truncateToWidth(` ${line}`, width, "…")),
					border,
					truncateToWidth(theme.fg("dim", controls), width, "…"),
					border,
				];
			},
			handleInput(data: string): void {
				if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) done("close");
				else if (data === "r") done("refresh");
				else if (data === "p") done(current.status.paused ? "resume" : "pause");
				else if (data === "o") done("override");
				else if (data === "c") done("clear-override");
			},
		}));
		if (!action || action === "close") return;
		if (action === "refresh") { await client.call("telemetry.poll", {}); continue; }
		if (action === "pause" || action === "resume") {
			if (await ctx.ui.confirm(action === "pause" ? "Emergency-halt provider requests?" : "Release emergency halt?", "This changes provider-request enforcement. Use /jittor off to disable blocking entirely.")) {
				await client.call(action === "pause" ? "router.pause" : "router.resume", {});
			}
			continue;
		}
		if (action === "clear-override") {
			if (await ctx.ui.confirm("Clear route override?", "Policy-controlled routing will resume.")) await client.call("router.clear_override", {});
			continue;
		}
		const route = await chooseOverride(ctx, current.status.availableRoutes);
		if (route && await ctx.ui.confirm("Apply route override?", `${routeText(route)} for one hour`)) {
			await client.call("router.override", { route, expiresAt: Date.now() + 60 * 60 * 1_000 });
		}
	}
}
