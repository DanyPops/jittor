import {
	HUMAN_STATUS_MAX_SOURCES,
	HUMAN_TEXT_FIELD_MAX_CHARACTERS,
	type MetricQuery,
	type PolicyAction,
	type Route,
	type RouterStatus,
	type StoredMetricObservation,
	TELEMETRY_STALE_AFTER_MS,
} from "@danypops/jittor";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { BorderedSelectPanel, type TextMeasure } from "malevich-tui-components";
import { sessionSecretField } from "../session-identity.ts";
import type { ProviderBudget } from "./footer.ts";

export interface JittorPanelClient {
	call(operation: string, input: unknown): Promise<any>;
}

export function providerBudgetMetricQuery(status: RouterStatus): MetricQuery | null {
	switch (status.currentRoute?.provider) {
		case "openai-codex":
			return { source: "codex-subscription", metric: "used-fraction", order: "desc", limit: 100 };
		case "openrouter":
			return { source: "openrouter", order: "desc", limit: 20 };
		case "anthropic":
			return { source: "anthropic", metric: "used-fraction", order: "desc", limit: 20 };
		case "anthropic-vertex":
			return { source: "anthropic-vertex", metric: "used-fraction", order: "desc", limit: 20 };
		default:
			return null;
	}
}

export type PanelAction = "pause" | "resume" | "refresh" | "override" | "clear-override" | "close";

export interface StatusPanelTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

const hostTextMeasure: TextMeasure = { visibleWidth, truncateToWidth };

function latest(
	rows: StoredMetricObservation[],
	predicate: (row: StoredMetricObservation) => boolean,
): StoredMetricObservation | undefined {
	return rows.filter(predicate).sort((left, right) => right.observedAt - left.observedAt || right.id - left.id)[0];
}

function sanitizedText(value: string): string {
	return value
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim()
		.slice(0, HUMAN_TEXT_FIELD_MAX_CHARACTERS);
}

function routeText(route: Route): string {
	return `${sanitizedText(route.provider)}/${sanitizedText(route.model)} · ${sanitizedText(route.thinking)}`;
}

function normalizedIdentity(value: unknown): string {
	return typeof value === "string" ? value.toLowerCase().replace(/[^a-z0-9]+/g, "") : "";
}

function longestWindow(rows: StoredMetricObservation[]): StoredMetricObservation | undefined {
	return [...rows].sort(
		(left, right) =>
			Number(right.attributes.windowSeconds ?? 0) - Number(left.attributes.windowSeconds ?? 0) ||
			right.observedAt - left.observedAt ||
			right.id - left.id,
	)[0];
}

function codexWindowForModel(rows: StoredMetricObservation[], model: string): StoredMetricObservation | undefined {
	const codexRows = rows.filter(
		(row) => row.source === "codex-subscription" && row.metric === "used-fraction" && typeof row.value === "number",
	);
	const modelIdentity = normalizedIdentity(model);
	const matchingAdditional = codexRows.filter((row) => {
		const limitId = normalizedIdentity(row.attributes.limitId);
		const limitName = normalizedIdentity(row.attributes.limitName);
		return limitId !== "codex" && limitName.length > 0 && limitName === modelIdentity;
	});
	if (matchingAdditional.length > 0) return longestWindow(matchingAdditional);
	return longestWindow(
		codexRows.filter((row) => {
			const limitId = normalizedIdentity(row.attributes.limitId);
			return limitId === "codex" || (limitId.length === 0 && row.scope.startsWith("codex:"));
		}),
	);
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

/**
 * `null` means "not known yet, but this provider can report a budget once data arrives" -- router
 * not ready, or a supported provider whose telemetry hasn't been observed yet; the footer shows a
 * placeholder that may resolve. `undefined` means "no budget signal is possible for this provider
 * at all" (e.g. google-vertex, which has no documented rate-limit or quota header/endpoint Jittor
 * could ever read -- see google-vertex-contracts.ts); the footer omits the segment entirely rather
 * than showing a `?` that can never resolve.
 */
type CodexTelemetryState = "available" | "missing" | "failed" | "stale";

function codexTelemetryState(status: RouterStatus, now: number): CodexTelemetryState {
	const source = status.sources.find((candidate) => candidate.id === "codex-subscription");
	if (!source) return "missing";
	if (!source.ok) return "failed";
	if (source.observedAt !== undefined && now - source.observedAt > TELEMETRY_STALE_AFTER_MS) return "stale";
	return "available";
}

function unavailableCodexBudget(
	label: string,
	reason: "reset pending" | "telemetry unavailable" | "telemetry failed" | "telemetry stale",
): ProviderBudget {
	return { kind: "unavailable", label, valueText: reason };
}

export function buildFooterBudget(
	status: RouterStatus,
	metrics: StoredMetricObservation[],
	now = Date.now(),
): ProviderBudget | null | undefined {
	if (!status.currentRoute) return null;
	if (status.currentRoute.provider === "openai-codex") {
		const codex = codexWindowForModel(metrics, status.currentRoute.model);
		const sourceState = codexTelemetryState(status, now);
		if (!codex || typeof codex.value !== "number") {
			if (sourceState === "missing") return unavailableCodexBudget("Codex", "telemetry unavailable");
			if (sourceState === "failed") return unavailableCodexBudget("Codex", "telemetry failed");
			if (sourceState === "stale") return unavailableCodexBudget("Codex", "telemetry stale");
			return null;
		}
		const label = compactWindowName(Number(codex.attributes.windowSeconds ?? 0));
		const resetsAtSeconds = Number(codex.attributes.resetsAt);
		const resetsAt = Number.isFinite(resetsAtSeconds) && resetsAtSeconds > 0 ? resetsAtSeconds * 1_000 : undefined;
		if (resetsAt !== undefined && resetsAt <= now) return unavailableCodexBudget(label, "reset pending");
		if (now - codex.observedAt > TELEMETRY_STALE_AFTER_MS) {
			if (sourceState === "missing") return unavailableCodexBudget(label, "telemetry unavailable");
			if (sourceState === "failed") return unavailableCodexBudget(label, "telemetry failed");
			return unavailableCodexBudget(label, "telemetry stale");
		}
		return {
			kind: "bounded",
			label,
			remainingFraction: 1 - codex.value,
			observedAt: codex.observedAt,
			...(resetsAt !== undefined ? { resetsAt } : {}),
		};
	}
	if (!status.ready) return null;
	if (status.currentRoute.provider === "anthropic") {
		const anthropic =
			latest(
				metrics,
				(row) => row.source === "anthropic" && row.metric === "used-fraction" && row.scope === "tokens" && typeof row.value === "number",
			) ??
			latest(
				metrics,
				(row) => row.source === "anthropic" && row.metric === "used-fraction" && row.scope === "requests" && typeof row.value === "number",
			);
		if (!anthropic || typeof anthropic.value !== "number") return null;
		const resetsAt = Number(anthropic.attributes.resetsAt);
		return {
			kind: "bounded",
			label: anthropic.scope === "tokens" ? "tok" : "req",
			remainingFraction: 1 - anthropic.value,
			observedAt: anthropic.observedAt,
			...(Number.isFinite(resetsAt) && resetsAt > 0 ? { resetsAt } : {}),
		};
	}
	if (status.currentRoute.provider === "anthropic-vertex") {
		// Best-effort only (see index.ts): these metrics only exist if Anthropic-style rate-limit
		// headers were actually observed on this passthrough, which is unverified. Labeled distinctly
		// ("vtok"/"vreq") from direct Anthropic's "tok"/"req" since they are a different account/quota
		// pool even if the header shape is identical. If nothing was ever observed, this stays null
		// (may still resolve later), not undefined (never possible) -- unlike google-vertex, this
		// provider's transport has not been shown to structurally lack the signal.
		const anthropicVertex =
			latest(
				metrics,
				(row) =>
					row.source === "anthropic-vertex" && row.metric === "used-fraction" && row.scope === "tokens" && typeof row.value === "number",
			) ??
			latest(
				metrics,
				(row) =>
					row.source === "anthropic-vertex" && row.metric === "used-fraction" && row.scope === "requests" && typeof row.value === "number",
			);
		if (!anthropicVertex || typeof anthropicVertex.value !== "number") return null;
		const resetsAt = Number(anthropicVertex.attributes.resetsAt);
		return {
			kind: "bounded",
			label: anthropicVertex.scope === "tokens" ? "vtok" : "vreq",
			remainingFraction: 1 - anthropicVertex.value,
			observedAt: anthropicVertex.observedAt,
			...(Number.isFinite(resetsAt) && resetsAt > 0 ? { resetsAt } : {}),
		};
	}
	if (status.currentRoute.provider === "openrouter") {
		const openRouter = latest(metrics, (row) => row.source === "openrouter" && row.metric === "usage" && typeof row.value === "number");
		const remaining = latest(
			metrics,
			(row) => row.source === "openrouter" && row.metric === "remaining-fraction" && typeof row.value === "number",
		);
		if (remaining && typeof remaining.value === "number" && (!openRouter || remaining.observedAt >= openRouter.observedAt)) {
			const reset = typeof remaining.attributes.reset === "string" ? sanitizedText(remaining.attributes.reset) : undefined;
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
	return undefined;
}

export function formatFooterStatus(status: RouterStatus, metrics: StoredMetricObservation[], now = Date.now()): string {
	const budget = buildFooterBudget(status, metrics, now);
	if (!budget) return "";
	if (budget.kind === "unbounded") return budget.valueText;
	if (budget.kind === "unavailable") return `${budget.label} ${budget.valueText}`;
	return `${budget.label} ${(budget.remainingFraction * 100).toFixed(1)}% left`;
}

function nextAction(action: PolicyAction | undefined): string {
	switch (action) {
		case "continue":
			return "throttle";
		case "throttle":
			return "lower thinking";
		case "lower-thinking":
			return "switch model";
		case "switch-model":
			return "switch provider";
		case "switch-provider":
			return "halt";
		case "halt":
			return "halted";
		default:
			return "waiting for decision";
	}
}

function burnLine(rows: StoredMetricObservation[], current: StoredMetricObservation, now: number): string {
	const previous = rows
		.filter(
			(row) =>
				row.source === current.source &&
				row.scope === current.scope &&
				row.metric === current.metric &&
				row.id !== current.id &&
				row.observedAt < current.observedAt,
		)
		.sort((left, right) => right.observedAt - left.observedAt)[0];
	const resetsAt = Number(current.attributes.resetsAt ?? 0) * 1_000;
	const remainingSeconds = (resetsAt - now) / 1_000;
	const sustainable = typeof current.value === "number" && remainingSeconds > 0 ? (1 - current.value) / remainingSeconds : null;
	const observed =
		previous && typeof previous.value === "number" && typeof current.value === "number" && current.observedAt > previous.observedAt
			? (current.value - previous.value) / ((current.observedAt - previous.observedAt) / 1_000)
			: null;
	const perHour = (rate: number | null) => (rate === null ? "n/a" : `${(rate * 3_600 * 100).toFixed(2)}%/h`);
	return `Burn: observed ${perHour(observed)} · sustainable ${perHour(sustainable)}`;
}

export function buildStatusView(status: RouterStatus, metrics: StoredMetricObservation[], now = Date.now()): string[] {
	const lines = [status.ready ? "Ready" : "Not ready"];
	const codex = status.currentRoute?.provider === "openai-codex" ? codexWindowForModel(metrics, status.currentRoute.model) : undefined;
	const budget = buildFooterBudget(status, metrics, now);
	if (codex && typeof codex.value === "number" && budget?.kind === "bounded") {
		const seconds = Number(codex.attributes.windowSeconds ?? 0);
		lines.push(`Codex ${windowName(seconds)}: ${((1 - codex.value) * 100).toFixed(1)}% left`);
		lines.push(burnLine(metrics, codex, now));
	} else if (status.currentRoute?.provider === "openai-codex" && budget?.kind === "unavailable") {
		const seconds = Number(codex?.attributes.windowSeconds ?? 0);
		lines.push(`Codex ${codex ? windowName(seconds) : "subscription"}: ${budget.valueText}`);
	}
	const openRouter =
		status.currentRoute?.provider === "openrouter"
			? latest(metrics, (row) => row.source === "openrouter" && row.metric === "usage" && typeof row.value === "number")
			: undefined;
	if (openRouter && typeof openRouter.value === "number") lines.push(`OpenRouter spend: $${openRouter.value.toFixed(3)}`);
	const anthropic =
		status.currentRoute?.provider === "anthropic"
			? (latest(
					metrics,
					(row) => row.source === "anthropic" && row.metric === "used-fraction" && row.scope === "tokens" && typeof row.value === "number",
				) ??
				latest(
					metrics,
					(row) =>
						row.source === "anthropic" && row.metric === "used-fraction" && row.scope === "requests" && typeof row.value === "number",
				))
			: undefined;
	if (anthropic && typeof anthropic.value === "number")
		lines.push(`Anthropic ${anthropic.scope}: ${((1 - anthropic.value) * 100).toFixed(1)}% left`);
	if (status.currentRoute) lines.push(`Route: ${routeText(status.currentRoute)}`);
	if (status.lastDecision)
		lines.push(
			`Pressure: ${Number.isFinite(status.lastDecision.pressure) ? status.lastDecision.pressure.toFixed(3) : "∞"} · ${status.lastDecision.action}`,
		);
	lines.push(`Next: ${nextAction(status.lastDecision?.action)}`);
	lines.push("Telemetry:");
	const providerSources = status.sources.filter((source) => source.provider === status.currentRoute?.provider);
	if (status.currentRoute?.provider === "openai-codex" && providerSources.length === 0)
		lines.push("  codex-subscription: unavailable · not configured by active daemon");
	for (const source of providerSources.slice(0, HUMAN_STATUS_MAX_SOURCES)) {
		const freshness = !source.ok ? "failed" : source.observedAt !== undefined && now - source.observedAt > 120_000 ? "stale" : "fresh";
		lines.push(`  ${sanitizedText(source.id)}: ${freshness} · ${source.metrics} metrics`);
	}
	if (providerSources.length > HUMAN_STATUS_MAX_SOURCES)
		lines.push(`  … ${providerSources.length - HUMAN_STATUS_MAX_SOURCES} more telemetry sources omitted`);
	if (status.override) lines.push(`Override: ${routeText(status.override.route)}`);
	if (status.paused) lines.push("Emergency halt is active");
	return lines;
}

export interface StatusPanelSnapshot {
	status: RouterStatus;
	metrics: StoredMetricObservation[];
}

/** Shared by the standalone status panel below and the unified /jittor shell, so both fetch identically. */
export async function fetchStatusSnapshot(client: JittorPanelClient, sessionId: string): Promise<StatusPanelSnapshot> {
	const status = (await client.call("router.status", { session_id: sessionId })) as RouterStatus;
	const query = providerBudgetMetricQuery(status);
	const metrics = query ? ((await client.call("metrics.query", query)) as StoredMetricObservation[]) : [];
	return { status, metrics };
}

async function chooseOverride(ctx: ExtensionCommandContext, routes: Route[]): Promise<Route | undefined> {
	if (routes.length === 0) {
		ctx.ui.notify("Pi reports no authenticated routes for the current provider.", "warning");
		return undefined;
	}
	const labels = routes.map(routeText);
	const selected = await ctx.ui.select("Override route", labels);
	const index = selected ? labels.indexOf(selected) : -1;
	return index >= 0 ? routes[index] : undefined;
}

/**
 * The Status panel's real chrome (a BorderedSelectPanel, replacing the hand-rolled border lines
 * this used to draw directly) plus its own r/p/o/c/Esc key handling, wired to `onAction` rather
 * than a `done` callback directly -- reusable by the standalone panel below and the unified
 * /jittor shell. Defaults to a full-chrome standalone panel (`framed: true`); pass `framed: false`
 * when nesting this as one tab's content inside another framed container.
 */
export function createStatusPanel(
	current: StatusPanelSnapshot,
	theme: StatusPanelTheme,
	onAction: (action: PanelAction) => void,
	framed = true,
): BorderedSelectPanel {
	const controls = current.status.paused
		? "r refresh · p release emergency halt · o override · c clear override · Esc close"
		: "r refresh · p emergency halt · o override · c clear override · Esc close";
	const content = {
		invalidate: () => {},
		render: (width: number): string[] =>
			buildStatusView(current.status, current.metrics).map((line) => truncateToWidth(` ${line}`, width, "…")),
		handleInput(data: string): void {
			if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) onAction("close");
			else if (data === "r") onAction("refresh");
			else if (data === "p") onAction(current.status.paused ? "resume" : "pause");
			else if (data === "o") onAction("override");
			else if (data === "c") onAction("clear-override");
		},
	};
	return new BorderedSelectPanel({
		title: "Jittor",
		list: content,
		helpText: controls,
		theme: {
			border: (text) => theme.fg("borderMuted", text),
			title: theme.bold,
			help: (text) => theme.fg("dim", text),
		},
		measure: hostTextMeasure,
		framed,
	});
}

/**
 * Performs the real side effect for one resolved status action -- confirmations and daemon calls.
 * A no-op for "close" and "refresh" is handled by the caller (refresh is a plain re-poll with no
 * confirmation). Shared by the standalone status panel below and the unified /jittor shell.
 */
export async function runStatusAction(
	ctx: ExtensionCommandContext,
	client: JittorPanelClient,
	action: PanelAction,
	current: StatusPanelSnapshot,
	sessionId: string,
): Promise<void> {
	if (action === "close") return;
	if (action === "refresh") {
		await client.call("telemetry.poll", {});
		return;
	}
	if (action === "pause" || action === "resume") {
		if (
			await ctx.ui.confirm(
				action === "pause" ? "Emergency-halt provider requests?" : "Release emergency halt?",
				"This changes provider-request enforcement. Use /jittor off to disable blocking entirely.",
			)
		) {
			await client.call(action === "pause" ? "router.pause" : "router.resume", { session_id: sessionId, ...sessionSecretField(sessionId) });
		}
		return;
	}
	if (action === "clear-override") {
		if (await ctx.ui.confirm("Clear route override?", "Policy-controlled routing will resume."))
			await client.call("router.clear_override", { session_id: sessionId, ...sessionSecretField(sessionId) });
		return;
	}
	const route = await chooseOverride(ctx, current.status.availableRoutes);
	if (route && (await ctx.ui.confirm("Apply route override?", `${routeText(route)} for one hour`))) {
		await client.call("router.override", {
			route,
			expiresAt: Date.now() + 60 * 60 * 1_000,
			session_id: sessionId,
			...sessionSecretField(sessionId),
		});
	}
}

export async function showJittorPanel(ctx: ExtensionCommandContext, client: JittorPanelClient): Promise<void> {
	const session_id = ctx.sessionManager.getSessionId();
	for (;;) {
		const current = await fetchStatusSnapshot(client, session_id);
		if (ctx.mode !== "tui") {
			ctx.ui.notify(buildStatusView(current.status, current.metrics).join("\n"), "info");
			return;
		}
		const action = await ctx.ui.custom<PanelAction>((_tui, theme, _keybindings, done) => {
			const panel = createStatusPanel(current, theme, done);
			return {
				invalidate: () => panel.invalidate(),
				render: (width: number) => panel.render(width),
				handleInput: (data: string) => panel.handleInput(data),
			};
		});
		if (!action || action === "close") return;
		await runStatusAction(ctx, client, action, current, session_id);
	}
}
