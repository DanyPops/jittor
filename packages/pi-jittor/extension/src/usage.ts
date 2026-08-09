import {
	buildCostGraph,
	buildUsageGraph,
	type CostGraph,
	HUMAN_TEXT_FIELD_MAX_CHARACTERS,
	resolveUsageWindow,
	USAGE_CHART_HEIGHT,
	USAGE_MAX_DISTINCT_SCOPES,
	USAGE_PERIODS,
	USAGE_RENDER_MAX_SERIES,
	USAGE_Y_AXIS_WIDTH,
	type UsageAggregateRow,
	type UsageGraph,
	type UsagePeriod,
	usagePeriod,
} from "@danypops/jittor";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { HistoryChart, type HistoryChartTheme, ProgressBar, type TextMeasure } from "malevich-tui-components";
import type { UsageBudgetControl } from "./settings.ts";
import type { JittorPanelClient } from "./tui.ts";

type UsageAction = "period-prev" | "period-next" | "view-next" | "refresh" | "close";
type UsageColor =
	| "accent"
	| "success"
	| "warning"
	| "error"
	| "thinkingText"
	| "muted"
	| "dim"
	| "borderMuted"
	| "syntaxKeyword"
	| "syntaxFunction"
	| "syntaxVariable"
	| "syntaxString"
	| "syntaxNumber"
	| "syntaxType"
	| "syntaxOperator";

export interface UsageTheme {
	fg(color: UsageColor, text: string): string;
	bold(text: string): string;
}

/**
 * Categorical palette for per-provider/model series. Deliberately excludes "success"/"warning"/
 * "error": those already carry a fixed status meaning elsewhere in this same panel (the budget
 * threshold line, freshness state), so reusing them for arbitrary model identity would make a
 * model's bar segment look like a warning or a failure to a pre-attentive reader — a real
 * categorical-color-design pitfall (see e.g. ColorBrewer/Okabe-Ito guidance on qualitative
 * palettes: colors for nominal categories should not imply an order, magnitude, or judgment).
 *
 * Instead this reuses the syntax-highlighting color roles, because theme authors already tune
 * those specifically to be simultaneously distinguishable on screen — that is the same design
 * problem as a categorical data palette (many hues coexisting in one view that all need to read
 * as different from each other). The order below interleaves the hue families syntax themes
 * conventionally assign to keyword/function/string/number/type/variable/operator (violet, blue,
 * green, orange, teal, cyan, neutral) so the first colors used are spread around the hue wheel
 * rather than clustered, which is the standard categorical-palette heuristic for maximizing
 * perceptual separation between adjacent categories.
 *
 * Terminal foreground color is a single channel with a hard ceiling on how many hues stay mutually
 * distinguishable (most qualitative-palette guidance caps around 8–12). seriesStyle derives both a
 * hue and optional bold weight from stable identity bits, using a second visual channel to reduce
 * collisions without allowing ranking or render order to change a model's appearance.
 */
const SERIES_HUES: UsageColor[] = [
	"accent",
	"syntaxFunction",
	"syntaxString",
	"syntaxNumber",
	"syntaxKeyword",
	"syntaxType",
	"thinkingText",
	"syntaxVariable",
	"syntaxOperator",
];

/**
 * Stable FNV-1a identity hash. Series ordering changes with totals and selected period, so assigning
 * colors by array index makes a model change color whenever another model overtakes it. Deriving
 * both visual channels from its provider/model key keeps that identity fixed across token and cost
 * graphics, period switches, refreshes, and extension restarts.
 */
function seriesStyle(identity: string, theme: UsageTheme): (text: string) => string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < identity.length; index += 1) {
		hash ^= identity.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	const hue = SERIES_HUES[hash % SERIES_HUES.length]!;
	const useBold = Math.floor(hash / SERIES_HUES.length) % 2 === 1;
	return (text: string) => (useBold ? theme.bold(theme.fg(hue, text)) : theme.fg(hue, text));
}

function compact(value: number): string {
	if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(value >= 10_000_000_000 ? 0 : 1)}B`;
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 || value % 1_000 === 0 ? 0 : 1)}k`;
	return String(Math.round(value));
}

/** Compact USD formatter: full cents below $1k, then the same k/M suffix convention as compact(). */
function formatUsd(value: number): string {
	const magnitude = Math.abs(value);
	if (magnitude === 0) return "$0";
	if (magnitude < 1_000) return `$${value.toFixed(magnitude < 0.01 ? 4 : 2)}`;
	if (magnitude < 1_000_000) return `$${(value / 1_000).toFixed(1)}k`;
	return `$${(value / 1_000_000).toFixed(1)}M`;
}

function formatPeriodPoint(value: number, period: UsagePeriod): string {
	const date = new Date(value);
	if (period === "hourly" || period === "daily") return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
	return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function displayIdentity(value: string): string {
	return value
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim()
		.slice(0, HUMAN_TEXT_FIELD_MAX_CHARACTERS);
}

function plainTheme(): UsageTheme {
	return { fg: (_color, text) => text, bold: (text) => text };
}

const hostTextMeasure: TextMeasure = { visibleWidth, truncateToWidth };

function chartTheme(theme: UsageTheme, seriesIdentities: string[]): HistoryChartTheme {
	return {
		title: theme.bold,
		subtitle: (text) => text,
		axis: (text) => theme.fg("borderMuted", text),
		warningLine: (text) => theme.fg("warning", text),
		errorLine: (text) => theme.fg("error", text),
		muted: (text) => theme.fg("muted", text),
		series: (index) => seriesStyle(seriesIdentities[index] ?? `series:${index}`, theme),
	};
}

interface ChartRenderOptions {
	title: string;
	formatValue: (value: number) => string;
	unitSuffix: string;
	subtitle?: string;
	budget?: number;
	noDataText: string;
}

/** Adapts Jittor's domain graph to Malevich's reusable cumulative HistoryChart and budget ProgressBar. */
function renderChart(
	chart: { period: UsagePeriod; buckets: UsageGraph["buckets"]; series: UsageGraph["series"]; total: number; truncated: boolean },
	width: number,
	theme: UsageTheme,
	options: ChartRenderOptions,
): string[] {
	const component = new HistoryChart({
		title: options.title,
		buckets: chart.buckets,
		series: chart.series.map((series) => ({
			key: series.key,
			label: `${displayIdentity(series.provider)}/${displayIdentity(series.model)}`,
		})),
		formatValue: options.formatValue,
		unitSuffix: options.unitSuffix,
		...(options.subtitle ? { subtitle: options.subtitle } : {}),
		...(options.budget !== undefined ? { budget: options.budget } : {}),
		noDataText: options.noDataText,
		truncated: chart.truncated,
		formatAxisLabel: (value) => formatPeriodPoint(value, chart.period),
		theme: chartTheme(
			theme,
			chart.series.map((series) => series.key),
		),
		measure: hostTextMeasure,
		height: USAGE_CHART_HEIGHT,
		yAxisWidth: USAGE_Y_AXIS_WIDTH,
		maxSeriesShown: USAGE_RENDER_MAX_SERIES,
	});
	const lines = component.render(width);
	if (options.budget === undefined || !Number.isFinite(options.budget) || options.budget <= 0 || chart.total === 0) return lines;
	const meter = new ProgressBar({
		value: chart.total,
		max: options.budget,
		label: "Budget",
		style: chart.total > options.budget ? (text) => theme.fg("error", text) : (text) => theme.fg("accent", text),
		measure: hostTextMeasure,
	});
	lines.splice(options.subtitle ? 3 : 2, 0, ...meter.render(Math.max(20, width)));
	return lines;
}

export function renderUsageGraph(chart: UsageGraph, width: number, theme: UsageTheme, tokenBudget?: number): string[] {
	return renderChart(
		{
			period: chart.period,
			buckets: chart.buckets,
			series: chart.series,
			total: chart.totalTokens,
			truncated: chart.truncated,
		},
		width,
		theme,
		{
			title: `${usagePeriod(chart.period).label} token usage`,
			formatValue: compact,
			unitSuffix: " tokens",
			subtitle: `input ${compact(chart.breakdown.input)} · output ${compact(chart.breakdown.output)} · cache ${compact(chart.breakdown.cacheRead + chart.breakdown.cacheWrite)}`,
			budget: tokenBudget,
			noDataText: "No recorded Pi token usage in this period.",
		},
	);
}

export function renderCostGraph(chart: CostGraph, width: number, theme: UsageTheme, costBudget?: number): string[] {
	return renderChart(
		{
			period: chart.period,
			buckets: chart.buckets,
			series: chart.series,
			total: chart.totalUsd,
			truncated: chart.truncated,
		},
		width,
		theme,
		{
			title: `${usagePeriod(chart.period).label} cost`,
			formatValue: formatUsd,
			unitSuffix: "",
			budget: costBudget,
			noDataText: "No recorded Pi cost in this period.",
		},
	);
}

export type UsageViewKind = "tokens" | "cost";
const USAGE_VIEWS: UsageViewKind[] = ["tokens", "cost"];

/**
 * One bounded round trip: the daemon discovers distinct scopes (still capped at
 * USAGE_MAX_DISTINCT_SCOPES -- more scopes than that is still a real, honestly-reported
 * truncation) and SQL-side aggregates every matching observation into (scope, metric, bucket)
 * sums for the exact window this panel renders. Replaces a per-scope fetch of up to
 * USAGE_PER_SCOPE_QUERY_LIMIT raw rows each, which fixed a *different* problem (one heavy scope
 * starving *other* scopes out of a shared row budget) but could still silently truncate a single
 * heavy scope's *own* older history within the same window -- a real incident: a scope logging
 * tens of thousands of rows a week had its "weekly" chart built from a few minutes of its most
 * recent rows alone. Aggregation has no such failure mode: result size scales with (scopes x
 * metrics x buckets), never with raw event count.
 */
async function loadPiMetrics(
	client: JittorPanelClient,
	window: ReturnType<typeof resolveUsageWindow>,
): Promise<{ rows: UsageAggregateRow[]; truncated: boolean }> {
	const result = (await client.call("metrics.usage_series", {
		source: "pi",
		since: window.start,
		until: window.end,
		bucketSizeMs: window.bucketSizeMs,
		bucketCount: window.bucketCount,
		scopeLimit: USAGE_MAX_DISTINCT_SCOPES,
	})) as { rows: UsageAggregateRow[]; truncated: boolean };
	return result;
}

export async function showUsagePanel(
	ctx: ExtensionCommandContext,
	client: JittorPanelClient,
	budgets: Pick<UsageBudgetControl, "getUsageTokenBudget">,
	now = Date.now(),
	initialView: UsageViewKind = "tokens",
): Promise<void> {
	let periodIndex = 0;
	let viewIndex = Math.max(0, USAGE_VIEWS.indexOf(initialView));
	for (;;) {
		const period = USAGE_PERIODS[periodIndex]!.id;
		const window = resolveUsageWindow(period, now);
		// One bounded query serves both views: token and cost metrics share the same "pi" source rows.
		const { rows, truncated } = await loadPiMetrics(client, window);
		const view = USAGE_VIEWS[viewIndex]!;
		const tokenChart = buildUsageGraph(rows, window, { period, truncated });
		const costChart = buildCostGraph(rows, window, { period, truncated });
		const tokenBudget = budgets.getUsageTokenBudget(period);
		const renderActive = (width: number, theme: UsageTheme): string[] =>
			view === "tokens" ? renderUsageGraph(tokenChart, width, theme, tokenBudget) : renderCostGraph(costChart, width, theme);
		if (ctx.mode !== "tui") {
			ctx.ui.notify(renderActive(80, plainTheme()).join("\n"), "info");
			return;
		}
		const action = await ctx.ui.custom<UsageAction>((_tui, theme, _keybindings, done) => ({
			invalidate() {},
			render(width: number): string[] {
				const lines = renderActive(width, theme);
				const controls = theme.fg("dim", "←/→/Tab period · v view · r refresh · Esc close");
				return [...lines, "", truncateToWidth(controls, width, "…")];
			},
			handleInput(data: string): void {
				if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q") done("close");
				else if (matchesKey(data, "left") || matchesKey(data, "shift+tab")) done("period-prev");
				else if (matchesKey(data, "right") || matchesKey(data, "tab")) done("period-next");
				else if (data === "v") done("view-next");
				else if (data === "r") done("refresh");
			},
		}));
		if (!action || action === "close") return;
		if (action === "period-prev") periodIndex = (periodIndex - 1 + USAGE_PERIODS.length) % USAGE_PERIODS.length;
		if (action === "period-next") periodIndex = (periodIndex + 1) % USAGE_PERIODS.length;
		if (action === "view-next") viewIndex = (viewIndex + 1) % USAGE_VIEWS.length;
	}
}
