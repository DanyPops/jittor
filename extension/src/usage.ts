import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { USAGE_CHART_HEIGHT, USAGE_TOKEN_QUERY_LIMIT, USAGE_Y_AXIS_WIDTH } from "../../src/constants.ts";
import type { StoredMetricObservation } from "../../src/domain/metric.ts";
import {
	buildUsageGraph,
	USAGE_PERIODS,
	usagePeriod,
	usagePeriodStart,
	type UsageBucket,
	type UsageGraph,
	type UsagePeriod,
} from "../../src/domain/usage.ts";
import type { UsageBudgetControl } from "./settings.ts";
import type { JittorPanelClient } from "./tui.ts";

type UsageAction = "period-prev" | "period-next" | "refresh" | "close";
type UsageColor = "accent" | "success" | "warning" | "error" | "thinkingText" | "muted" | "dim" | "borderMuted";

export interface UsageTheme {
	fg(color: UsageColor, text: string): string;
	bold(text: string): string;
}

const SERIES_COLORS: UsageColor[] = ["accent", "success", "warning", "thinkingText", "error"];
const PARTIAL_BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

function compact(value: number): string {
	if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(value >= 10_000_000_000 ? 0 : 1)}B`;
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 || value % 1_000 === 0 ? 0 : 1)}k`;
	return String(Math.round(value));
}

function mergeBuckets(buckets: UsageBucket[], maximum: number): UsageBucket[] {
	if (buckets.length <= maximum) return buckets;
	const result: UsageBucket[] = [];
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

function seriesAt(bucket: UsageBucket, chart: UsageGraph, tokenHeight: number): number {
	let cumulative = 0;
	for (let index = 0; index < chart.series.length; index += 1) {
		cumulative += bucket.series[chart.series[index]!.key] ?? 0;
		if (tokenHeight <= cumulative) return index;
	}
	return Math.max(0, chart.series.length - 1);
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

function plainTheme(): UsageTheme {
	return { fg: (_color, text) => text, bold: (text) => text };
}

export function renderUsageGraph(chart: UsageGraph, width: number, theme: UsageTheme, tokenBudget?: number): string[] {
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
	const budget = typeof tokenBudget === "number" && Number.isFinite(tokenBudget) && tokenBudget > 0 ? tokenBudget : undefined;
	const maximum = Math.max(chart.totalTokens, budget ?? 0);
	const observed = chart.truncated ? `at least ${compact(chart.totalTokens)}` : compact(chart.totalTokens);
	const budgetState = budget === undefined
		? `${observed} tokens · budget not configured${chart.truncated ? " · query limit reached" : ""}`
		: chart.totalTokens > budget
			? `${observed} / ${compact(budget)} budget · OVER BUDGET by ${chart.truncated ? "at least " : ""}${compact(chart.totalTokens - budget)}`
			: chart.truncated
				? `${observed} / ${compact(budget)} budget · state unknown · query limit reached`
				: `${observed} / ${compact(budget)} budget · ${compact(budget - chart.totalTokens)} remaining`;
	const lines = [
		truncateToWidth(theme.bold(`${usagePeriod(chart.period).label} token usage`), safeWidth, ""),
		truncateToWidth(budgetState, safeWidth, "…"),
		truncateToWidth(`input ${compact(chart.breakdown.input)} · output ${compact(chart.breakdown.output)} · cache ${compact(chart.breakdown.cacheRead + chart.breakdown.cacheWrite)}`, safeWidth, "…"),
		"",
	];
	if (maximum === 0) {
		lines.push(theme.fg("dim", "No recorded Pi token usage in this period."));
		return lines.map((line) => truncateToWidth(line, safeWidth, "…"));
	}

	for (let row = 0; row < USAGE_CHART_HEIGHT; row += 1) {
		const fromBottom = USAGE_CHART_HEIGHT - row - 1;
		const lower = maximum * fromBottom / USAGE_CHART_HEIGHT;
		const upper = maximum * (fromBottom + 1) / USAGE_CHART_HEIGHT;
		const thresholdRow = budget !== undefined && budget > lower && budget <= upper;
		const label = thresholdRow ? compact(budget) : row === 0 ? compact(maximum) : row === Math.floor(USAGE_CHART_HEIGHT / 2) ? compact(maximum / 2) : "";
		if (thresholdRow) {
			const color = chart.totalTokens > budget ? "error" : "warning";
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
			const tokenHeight = Math.min(bucket.total, maximum * (fromBottom + Math.min(occupancy, 0.5)) / USAGE_CHART_HEIGHT);
			const color = SERIES_COLORS[seriesAt(bucket, chart, tokenHeight) % SERIES_COLORS.length]!;
			plot += theme.fg(color, block) + (barStep === 2 ? " " : "");
		}
		lines.push(`${label.padStart(USAGE_Y_AXIS_WIDTH - 2)} ${theme.fg("borderMuted", "│")}${plot}`);
	}
	lines.push(`${"0".padStart(USAGE_Y_AXIS_WIDTH - 2)} ${theme.fg("borderMuted", `└${"─".repeat(plotWidth)}`)}`);
	lines.push(`${" ".repeat(USAGE_Y_AXIS_WIDTH)}${axisLabels(chart.start, chart.end, chart.period, plotWidth)}`);
	lines.push("");
	for (let index = 0; index < chart.series.length; index += 1) {
		const series = chart.series[index]!;
		const bullet = theme.fg(SERIES_COLORS[index % SERIES_COLORS.length]!, "■");
		lines.push(truncateToWidth(`${bullet} ${series.provider}/${series.model}  ${compact(series.total)}`, safeWidth, "…"));
	}
	return lines.map((line) => visibleWidth(line) <= safeWidth ? line : truncateToWidth(line, safeWidth, "…"));
}

async function loadUsage(client: JittorPanelClient, period: UsagePeriod, now: number): Promise<UsageGraph> {
	const rows = await client.call("metrics.query", {
		source: "pi",
		since: usagePeriodStart(period, now),
		until: now,
		order: "desc",
		limit: USAGE_TOKEN_QUERY_LIMIT,
	}) as StoredMetricObservation[];
	return buildUsageGraph(rows, { period, now, truncated: rows.length >= USAGE_TOKEN_QUERY_LIMIT });
}

export async function showUsagePanel(
	ctx: ExtensionCommandContext,
	client: JittorPanelClient,
	budgets: Pick<UsageBudgetControl, "getUsageTokenBudget">,
	now = Date.now(),
): Promise<void> {
	let periodIndex = 0;
	for (;;) {
		const period = USAGE_PERIODS[periodIndex]!.id;
		const chart = await loadUsage(client, period, now);
		const tokenBudget = budgets.getUsageTokenBudget(period);
		if (ctx.mode !== "tui") {
			ctx.ui.notify(renderUsageGraph(chart, 80, plainTheme(), tokenBudget).join("\n"), "info");
			return;
		}
		const action = await ctx.ui.custom<UsageAction>((_tui, theme, _keybindings, done) => ({
			invalidate() {},
			render(width: number): string[] {
				const lines = renderUsageGraph(chart, width, theme, tokenBudget);
				const controls = theme.fg("dim", "←/→ period · r refresh · Esc close");
				return [...lines, "", truncateToWidth(controls, width, "…")];
			},
			handleInput(data: string): void {
				if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q") done("close");
				else if (matchesKey(data, "left")) done("period-prev");
				else if (matchesKey(data, "right")) done("period-next");
				else if (data === "r") done("refresh");
			},
		}));
		if (!action || action === "close") return;
		if (action === "period-prev") periodIndex = (periodIndex - 1 + USAGE_PERIODS.length) % USAGE_PERIODS.length;
		if (action === "period-next") periodIndex = (periodIndex + 1) % USAGE_PERIODS.length;
	}
}
