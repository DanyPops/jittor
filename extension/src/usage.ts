import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { HUMAN_TEXT_FIELD_MAX_CHARACTERS, USAGE_CHART_HEIGHT, USAGE_RENDER_MAX_SERIES, USAGE_TOKEN_QUERY_LIMIT, USAGE_Y_AXIS_WIDTH } from "../../src/constants.ts";
import type { StoredMetricObservation } from "../../src/domain/metric.ts";
import {
	buildCostGraph,
	buildUsageGraph,
	USAGE_PERIODS,
	usagePeriod,
	usagePeriodStart,
	type CostGraph,
	type UsageGraph,
	type UsagePeriod,
} from "../../src/domain/usage.ts";
import type { UsageBudgetControl } from "./settings.ts";
import type { JittorPanelClient } from "./tui.ts";

type UsageAction = "period-prev" | "period-next" | "view-next" | "refresh" | "close";
type UsageColor =
	| "accent" | "success" | "warning" | "error" | "thinkingText" | "muted" | "dim" | "borderMuted"
	| "syntaxKeyword" | "syntaxFunction" | "syntaxVariable" | "syntaxString" | "syntaxNumber" | "syntaxType" | "syntaxOperator";

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
 * distinguishable (most qualitative-palette guidance caps around 8–12). Once the hue palette is
 * exhausted, seriesStyle adds bold as a second, independent visual channel before any exact
 * color+weight combination repeats — a standard visualization technique (encode extra categories
 * on an additional channel rather than silently reusing an indistinguishable color).
 */
const SERIES_HUES: UsageColor[] = [
	"accent", "syntaxFunction", "syntaxString", "syntaxNumber",
	"syntaxKeyword", "syntaxType", "thinkingText", "syntaxVariable", "syntaxOperator",
];

/** Returns a style function for the Nth series: cycles hue, then adds bold once the palette wraps. */
function seriesStyle(index: number, theme: UsageTheme): (text: string) => string {
	const hue = SERIES_HUES[index % SERIES_HUES.length]!;
	const useBold = Math.floor(index / SERIES_HUES.length) % 2 === 1;
	return (text: string) => useBold ? theme.bold(theme.fg(hue, text)) : theme.fg(hue, text);
}

const PARTIAL_BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

function compact(value: number): string {
	if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(value >= 10_000_000_000 ? 0 : 1)}B`;
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 || value % 1_000 === 0 ? 0 : 1)}k`;
	return String(Math.round(value));
}

interface RenderableSeries { key: string; provider: string; model: string; total: number }
interface RenderableBucket { start: number; end: number; total: number; series: Record<string, number> }
interface RenderableChart { period: UsagePeriod; start: number; end: number; buckets: RenderableBucket[]; series: RenderableSeries[]; total: number; truncated: boolean }

function mergeBuckets(buckets: RenderableBucket[], maximum: number): RenderableBucket[] {
	if (buckets.length <= maximum) return buckets;
	const result: RenderableBucket[] = [];
	for (let index = 0; index < maximum; index += 1) {
		const from = Math.floor(index * buckets.length / maximum);
		const to = Math.max(from + 1, Math.floor((index + 1) * buckets.length / maximum));
		const selected = buckets.slice(from, to);
		const series: Record<string, number> = {};
		for (const bucket of selected) {
			for (const [key, value] of Object.entries(bucket.series)) series[key] = (series[key] ?? 0) + value;
		}
		result.push({
			start: selected[0]!.start,
			end: selected[selected.length - 1]!.end,
			total: selected.reduce((sum, bucket) => sum + bucket.total, 0),
			series,
		});
	}
	return result;
}

function seriesAt(bucket: RenderableBucket, chart: RenderableChart, valueHeight: number): number {
	let cumulative = 0;
	for (let index = 0; index < chart.series.length; index += 1) {
		cumulative += bucket.series[chart.series[index]!.key] ?? 0;
		if (valueHeight <= cumulative) return index;
	}
	return Math.max(0, chart.series.length - 1);
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

function axisLabels(start: number, end: number, period: UsagePeriod, width: number): string {
	const labels = [formatPeriodPoint(start, period), formatPeriodPoint(start + (end - start) / 2, period), formatPeriodPoint(end, period)];
	const positions = [0, Math.max(0, Math.floor((width - labels[1]!.length) / 2)), Math.max(0, width - labels[2]!.length)];
	const characters = Array.from({ length: width }, () => " ");
	for (let labelIndex = 0; labelIndex < labels.length; labelIndex += 1) {
		for (let index = 0; index < labels[labelIndex]!.length && positions[labelIndex]! + index < width; index += 1) {
			characters[positions[labelIndex]! + index] = labels[labelIndex]![index]!;
		}
	}
	return characters.join("");
}

function displayIdentity(value: string): string {
	return value.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim().slice(0, HUMAN_TEXT_FIELD_MAX_CHARACTERS);
}

function plainTheme(): UsageTheme {
	return { fg: (_color, text) => text, bold: (text) => text };
}

interface ChartRenderOptions {
	title: string;
	formatValue: (value: number) => string;
	/** Appended after the observed/budget amount, e.g. " tokens"; empty when formatValue already carries a unit prefix like "$". */
	unitSuffix: string;
	subtitle?: string;
	budget?: number;
	noDataText: string;
}

/** Shared cumulative bar-chart renderer behind renderUsageGraph and renderCostGraph. */
function renderChart(chart: RenderableChart, width: number, theme: UsageTheme, options: ChartRenderOptions): string[] {
	const { formatValue, unitSuffix } = options;
	const safeWidth = Math.max(20, width);
	const chartColumns = Math.max(1, Math.floor((safeWidth - USAGE_Y_AXIS_WIDTH - 1) / 2));
	const increments = mergeBuckets(chart.buckets, chartColumns);
	const runningSeries: Record<string, number> = {};
	let runningTotal = 0;
	const buckets = increments.map((bucket) => {
		runningTotal += bucket.total;
		for (const [key, value] of Object.entries(bucket.series)) runningSeries[key] = (runningSeries[key] ?? 0) + value;
		return { ...bucket, total: runningTotal, series: { ...runningSeries } };
	});
	const barStep = buckets.length * 2 <= safeWidth - USAGE_Y_AXIS_WIDTH ? 2 : 1;
	const plotWidth = buckets.length * barStep;
	const budget = typeof options.budget === "number" && Number.isFinite(options.budget) && options.budget > 0 ? options.budget : undefined;
	const maximum = Math.max(chart.total, budget ?? 0);
	const observed = chart.truncated ? `at least ${formatValue(chart.total)}` : formatValue(chart.total);
	const budgetState = budget === undefined
		? `${observed}${unitSuffix} · budget not configured${chart.truncated ? " · query limit reached" : ""}`
		: chart.total > budget
			? `${observed}${unitSuffix} / ${formatValue(budget)} budget · OVER BUDGET by ${chart.truncated ? "at least " : ""}${formatValue(chart.total - budget)}`
			: chart.truncated
				? `${observed}${unitSuffix} / ${formatValue(budget)} budget · state unknown · query limit reached`
				: `${observed}${unitSuffix} / ${formatValue(budget)} budget · ${formatValue(budget - chart.total)} remaining`;
	const lines = [
		truncateToWidth(theme.bold(options.title), safeWidth, ""),
		truncateToWidth(budgetState, safeWidth, "…"),
		...(options.subtitle ? [truncateToWidth(options.subtitle, safeWidth, "…")] : []),
		"",
	];
	if (maximum === 0) {
		lines.push(theme.fg("dim", options.noDataText));
		return lines.map((line) => truncateToWidth(line, safeWidth, "…"));
	}

	for (let row = 0; row < USAGE_CHART_HEIGHT; row += 1) {
		const fromBottom = USAGE_CHART_HEIGHT - row - 1;
		const lower = maximum * fromBottom / USAGE_CHART_HEIGHT;
		const upper = maximum * (fromBottom + 1) / USAGE_CHART_HEIGHT;
		const thresholdRow = budget !== undefined && budget > lower && budget <= upper;
		const label = thresholdRow ? formatValue(budget) : row === 0 ? formatValue(maximum) : row === Math.floor(USAGE_CHART_HEIGHT / 2) ? formatValue(maximum / 2) : "";
		if (thresholdRow) {
			const color = chart.total > budget ? "error" : "warning";
			lines.push(`${label.padStart(USAGE_Y_AXIS_WIDTH - 2)} ${theme.fg("borderMuted", "│")}${theme.fg(color, "┄".repeat(plotWidth))}`);
			continue;
		}
		let plot = "";
		for (const bucket of buckets) {
			const scaled = bucket.total / maximum * USAGE_CHART_HEIGHT;
			const occupancy = Math.max(0, Math.min(1, scaled - fromBottom));
			if (occupancy <= 0) {
				plot += " ".repeat(barStep);
				continue;
			}
			const block = PARTIAL_BLOCKS[Math.max(0, Math.ceil(occupancy * PARTIAL_BLOCKS.length) - 1)]!;
			const valueHeight = Math.min(bucket.total, maximum * (fromBottom + Math.min(occupancy, 0.5)) / USAGE_CHART_HEIGHT);
			plot += seriesStyle(seriesAt(bucket, chart, valueHeight), theme)(block) + (barStep === 2 ? " " : "");
		}
		lines.push(`${label.padStart(USAGE_Y_AXIS_WIDTH - 2)} ${theme.fg("borderMuted", "│")}${plot}`);
	}
	lines.push(`${"0".padStart(USAGE_Y_AXIS_WIDTH - 2)} ${theme.fg("borderMuted", `└${"─".repeat(plotWidth)}`)}`);
	lines.push(`${" ".repeat(USAGE_Y_AXIS_WIDTH)}${axisLabels(chart.start, chart.end, chart.period, plotWidth)}`);
	lines.push("");
	const displayedSeries = chart.series.slice(0, USAGE_RENDER_MAX_SERIES);
	for (let index = 0; index < displayedSeries.length; index += 1) {
		const series = displayedSeries[index]!;
		const bullet = seriesStyle(index, theme)("■");
		lines.push(truncateToWidth(`${bullet} ${displayIdentity(series.provider)}/${displayIdentity(series.model)}  ${formatValue(series.total)}`, safeWidth, "…"));
	}
	if (chart.series.length > displayedSeries.length) lines.push(truncateToWidth(theme.fg("muted", `… ${chart.series.length - displayedSeries.length} more series omitted`), safeWidth, "…"));
	return lines.map((line) => visibleWidth(line) <= safeWidth ? line : truncateToWidth(line, safeWidth, "…"));
}

export function renderUsageGraph(chart: UsageGraph, width: number, theme: UsageTheme, tokenBudget?: number): string[] {
	return renderChart(
		{ period: chart.period, start: chart.start, end: chart.end, buckets: chart.buckets, series: chart.series, total: chart.totalTokens, truncated: chart.truncated },
		width, theme,
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
		{ period: chart.period, start: chart.start, end: chart.end, buckets: chart.buckets, series: chart.series, total: chart.totalUsd, truncated: chart.truncated },
		width, theme,
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

async function loadPiMetrics(client: JittorPanelClient, period: UsagePeriod, now: number): Promise<{ rows: StoredMetricObservation[]; truncated: boolean }> {
	const rows = await client.call("metrics.query", {
		source: "pi",
		since: usagePeriodStart(period, now),
		until: now,
		order: "desc",
		limit: USAGE_TOKEN_QUERY_LIMIT,
	}) as StoredMetricObservation[];
	return { rows, truncated: rows.length >= USAGE_TOKEN_QUERY_LIMIT };
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
		// One bounded query serves both views: token and cost metrics share the same "pi" source rows.
		const { rows, truncated } = await loadPiMetrics(client, period, now);
		const view = USAGE_VIEWS[viewIndex]!;
		const tokenChart = buildUsageGraph(rows, { period, now, truncated });
		const costChart = buildCostGraph(rows, { period, now, truncated });
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
