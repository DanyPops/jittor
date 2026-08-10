import type {
	CacheEconomicsAggregateTotals,
	CacheEconomicsModelSummary,
	CacheEconomicsSummary,
	CacheEconomicsTaskSummary,
} from "@danypops/jittor";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { BorderedSelectPanel, type TextMeasure } from "malevich-tui-components";

export interface CacheEconomicsPanelTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

export type CacheEconomicsPanelAction = "refresh" | "close";

const hostTextMeasure: TextMeasure = { visibleWidth, truncateToWidth };

export interface CacheEconomicsPanelClient {
	call(operation: string, input: unknown): Promise<any>;
}

function formatUsd(amount: number): string {
	return `$${amount.toFixed(Math.abs(amount) < 0.01 && amount !== 0 ? 4 : 2)}`;
}

function costField(amountUsd: number | null, basis: "provider-reported" | "catalog-estimate" | "unknown"): string {
	if (amountUsd === null) return "unknown";
	return basis === "catalog-estimate" ? `${formatUsd(amountUsd)} (est.)` : formatUsd(amountUsd);
}

function aggregateFields(totals: CacheEconomicsAggregateTotals): string {
	const payback = totals.paybackAchieved === null ? "n/a" : totals.paybackAchieved ? "yes" : "not yet";
	return [
		`read ${totals.cacheReadTokens.toLocaleString()} tok (${costField(totals.cacheReadCostUsd, totals.cacheReadCostBasis)})`,
		`write ${totals.cacheWriteTokens.toLocaleString()} tok (${costField(totals.cacheWriteCostUsd, totals.cacheWriteCostBasis)})`,
		`savings ${totals.savingsUsd === null ? "unknown" : formatUsd(totals.savingsUsd)}`,
		`payback ${payback}`,
	].join(" · ");
}

function freshnessSuffix(catalogFreshness: "fresh" | "stale" | null): string {
	return catalogFreshness === "stale" ? " -- stale catalog snapshot used for the estimate(s) above" : "";
}

function modelLine(model: CacheEconomicsModelSummary): string {
	return `${model.provider}/${model.model}: ${aggregateFields(model)}${freshnessSuffix(model.catalogFreshness)}`;
}

function taskLine(task: CacheEconomicsTaskSummary): string {
	return `${task.taskId}: ${aggregateFields(task)}${freshnessSuffix(task.catalogFreshness)}`;
}

/** Plain multi-line text, shared by TUI notify and non-TUI notify -- a full interactive panel is deferred; this already satisfies "bounded query plus Pi presentation" without a new widget. */
export function renderCacheEconomicsView(summary: CacheEconomicsSummary): string[] {
	const lines = [
		`Cache economics (${new Date(summary.since).toISOString().slice(0, 10)} .. ${new Date(summary.until).toISOString().slice(0, 10)})${summary.truncated ? " -- query limit reached, totals are a lower bound" : ""}`,
	];
	if (summary.models.length === 0) lines.push("No cache activity recorded in this window.");
	else lines.push(...summary.models.map((model) => `- ${modelLine(model)}`));
	if (summary.tasks.length > 0) {
		lines.push(`By task: ${summary.tasks.length}`);
		lines.push(...summary.tasks.map((task) => `- ${taskLine(task)}`));
	}
	const unattributed = summary.unattributedCacheActivity;
	if (unattributed.cacheReadTokens > 0 || unattributed.cacheWriteTokens > 0) {
		lines.push(
			`Unattributed (no task focused): read ${unattributed.cacheReadTokens.toLocaleString()} tok (${costField(unattributed.cacheReadCostUsd, unattributed.cacheReadCostBasis)}) · write ${unattributed.cacheWriteTokens.toLocaleString()} tok (${costField(unattributed.cacheWriteCostUsd, unattributed.cacheWriteCostBasis)})`,
		);
	}
	if (summary.stablePrefixChurn.length > 0) {
		lines.push(`Stable-prefix churn (${summary.stablePrefixChurn.length} snapshot(s), oldest first):`);
		for (const point of summary.stablePrefixChurn) {
			lines.push(
				`- ${new Date(point.observedAt).toISOString()} session ${point.sessionId}: ${point.stablePrefixTokens.toLocaleString()} tok${point.resetReason === null ? "" : ` (${point.resetReason} reset)`}`,
			);
		}
	}
	if (summary.missedOpportunities.length > 0) {
		lines.push(`Candidate missed-cache opportunities: ${summary.missedOpportunities.length}`);
		for (const candidate of summary.missedOpportunities.slice(0, 10)) {
			lines.push(
				`- session ${candidate.sessionId}: ${candidate.resetReason} reset, then ${candidate.cacheWriteTokens.toLocaleString()} cache-write tok${candidate.cacheWriteCostUsd === null ? "" : ` (${formatUsd(candidate.cacheWriteCostUsd)})`}`,
			);
		}
	}
	return lines;
}

/** Shared by both notify/panel entry points below and the unified /jittor shell, so all three fetch identically. */
export async function fetchCacheEconomicsSummary(
	client: CacheEconomicsPanelClient,
	windowMs: number,
	now: () => number = Date.now,
): Promise<CacheEconomicsSummary> {
	const until = now();
	const since = Math.max(0, until - windowMs);
	return (await client.call("cache.economics", { since, until })) as CacheEconomicsSummary;
}

export async function showCacheEconomicsView(
	ctx: ExtensionCommandContext,
	client: CacheEconomicsPanelClient,
	windowMs: number,
	now: () => number = Date.now,
): Promise<void> {
	const summary = await fetchCacheEconomicsSummary(client, windowMs, now);
	ctx.ui.notify(renderCacheEconomicsView(summary).join("\n"), "info");
}

/**
 * The Cache panel's real chrome plus its own r/Esc key handling, wired to `onAction` rather than a
 * `done` callback directly -- reusable by renderCacheEconomicsPanel/showCacheEconomicsPanel below
 * and the unified /jittor shell. Defaults to a full-chrome standalone panel (`framed: true`); pass
 * `framed: false` when nesting this as one tab's content inside another framed container.
 */
export function createCacheEconomicsPanel(
	summary: CacheEconomicsSummary,
	theme: CacheEconomicsPanelTheme,
	onAction: (action: CacheEconomicsPanelAction) => void,
	framed = true,
): BorderedSelectPanel {
	const lines = renderCacheEconomicsView(summary);
	const content = {
		invalidate: () => {},
		render: (availableWidth: number): string[] => lines.map((line) => truncateToWidth(line, availableWidth, "…")),
		handleInput(data: string): void {
			if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) onAction("close");
			else if (data === "r") onAction("refresh");
		},
	};
	return new BorderedSelectPanel({
		title: "Jittor Cache Economics",
		list: content,
		helpText: "r refresh · Esc close",
		theme: {
			border: (text) => theme.fg("borderMuted", text),
			title: theme.bold,
			help: (text) => theme.fg("dim", text),
		},
		measure: hostTextMeasure,
		framed,
	});
}

/** The same content as renderCacheEconomicsView, wrapped in a titled, bordered, scrollable frame -- mirrors optimization/model-selection-panel.ts's renderBenchmarkView/BorderedSelectPanel pattern. */
export function renderCacheEconomicsPanel(summary: CacheEconomicsSummary, width: number, theme: CacheEconomicsPanelTheme): string[] {
	return createCacheEconomicsPanel(summary, theme, () => undefined).render(Math.max(1, width));
}

/**
 * Interactive scrollable panel for /jittor cache, mirroring showBenchmarkPanel: a plain notify
 * outside TUI mode (unchanged from showCacheEconomicsView's own behavior), an interactive
 * BorderedSelectPanel with an 'r' refresh keybinding inside it.
 */
export async function showCacheEconomicsPanel(
	ctx: ExtensionCommandContext,
	client: CacheEconomicsPanelClient,
	windowMs: number,
	now: () => number = Date.now,
): Promise<void> {
	for (;;) {
		const summary = await fetchCacheEconomicsSummary(client, windowMs, now);
		if (ctx.mode !== "tui") {
			ctx.ui.notify(renderCacheEconomicsView(summary).join("\n"), "info");
			return;
		}
		const action = await ctx.ui.custom<CacheEconomicsPanelAction>((_tui, theme, _keybindings, done) => {
			const panel = createCacheEconomicsPanel(summary, theme, done);
			return {
				invalidate: () => panel.invalidate(),
				render: (width: number) => panel.render(width),
				handleInput: (data: string) => panel.handleInput(data),
			};
		});
		if (!action || action === "close") return;
	}
}
