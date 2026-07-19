import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { StoredMetricObservation } from "../../src/domain/metric.ts";
import type { PolicyAction, Route } from "../../src/policy.ts";
import type { RouterStatus } from "../../src/ports/router-controller.ts";

export interface JittorPanelClient {
	call(operation: string, input: unknown): Promise<any>;
}

type PanelAction = "pause" | "resume" | "refresh" | "override" | "clear-override" | "close";

function latest(rows: StoredMetricObservation[], predicate: (row: StoredMetricObservation) => boolean): StoredMetricObservation | undefined {
	return rows.filter(predicate).sort((left, right) => right.observedAt - left.observedAt || right.id - left.id)[0];
}

function longestCodexWindow(rows: StoredMetricObservation[]): StoredMetricObservation | undefined {
	return rows
		.filter((row) => row.source === "codex-subscription" && row.metric === "used-fraction" && typeof row.value === "number")
		.sort((left, right) => Number(right.attributes["windowSeconds"] ?? 0) - Number(left.attributes["windowSeconds"] ?? 0) || right.observedAt - left.observedAt)[0];
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

export function formatFooterStatus(status: RouterStatus, metrics: StoredMetricObservation[]): string {
	if (!status.ready || !status.currentRoute) return "";
	if (status.currentRoute.provider === "openai-codex") {
		const codex = longestCodexWindow(metrics);
		return codex && typeof codex.value === "number"
			? `${compactWindowName(Number(codex.attributes["windowSeconds"] ?? 0))} ${(codex.value * 100).toFixed(1)}%`
			: "";
	}
	if (status.currentRoute.provider === "openrouter") {
		const openRouter = latest(metrics, (row) => row.source === "openrouter" && row.metric === "usage" && typeof row.value === "number");
		return openRouter && typeof openRouter.value === "number" ? `$${openRouter.value.toFixed(3)}` : "";
	}
	return "";
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
	const codex = status.currentRoute?.provider === "openai-codex" ? longestCodexWindow(metrics) : undefined;
	if (codex && typeof codex.value === "number") {
		const seconds = Number(codex.attributes["windowSeconds"] ?? 0);
		lines.push(`Codex ${windowName(seconds)}: ${(codex.value * 100).toFixed(1)}%`);
		lines.push(burnLine(metrics, codex, now));
	}
	const openRouter = status.currentRoute?.provider === "openrouter"
		? latest(metrics, (row) => row.source === "openrouter" && row.metric === "usage" && typeof row.value === "number")
		: undefined;
	if (openRouter && typeof openRouter.value === "number") lines.push(`OpenRouter spend: $${openRouter.value.toFixed(3)}`);
	if (status.currentRoute) lines.push(`Route: ${status.currentRoute.provider}/${status.currentRoute.model} · ${status.currentRoute.thinking}`);
	if (status.lastDecision) lines.push(`Pressure: ${Number.isFinite(status.lastDecision.pressure) ? status.lastDecision.pressure.toFixed(3) : "∞"} · ${status.lastDecision.action}`);
	lines.push(`Next: ${nextAction(status.lastDecision?.action)}`);
	lines.push("Telemetry:");
	for (const source of status.sources.filter((source) => source.provider === status.currentRoute?.provider)) {
		const freshness = !source.ok ? "failed" : source.observedAt !== undefined && now - source.observedAt > 120_000 ? "stale" : "fresh";
		lines.push(`  ${source.id}: ${freshness} · ${source.metrics} metrics`);
	}
	if (status.override) lines.push(`Override: ${status.override.route.provider}/${status.override.route.model} · ${status.override.route.thinking}`);
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
	const labels = routes.map((route) => `${route.provider}/${route.model} · ${route.thinking}`);
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
		if (route && await ctx.ui.confirm("Apply route override?", `${route.provider}/${route.model} · ${route.thinking} for one hour`)) {
			await client.call("router.override", { route, expiresAt: Date.now() + 60 * 60 * 1_000 });
		}
	}
}
