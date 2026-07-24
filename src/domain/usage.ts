import { MAX_USAGE_BUCKETS, MILLISECONDS_PER_DAY, MILLISECONDS_PER_HOUR } from "../constants.ts";

export const USAGE_PERIODS = [
	{ id: "hourly", label: "Hourly", windowMs: MILLISECONDS_PER_HOUR, bucketCount: 12 },
	{ id: "daily", label: "Daily", windowMs: MILLISECONDS_PER_DAY, bucketCount: 24 },
	{ id: "weekly", label: "Weekly", windowMs: 7 * MILLISECONDS_PER_DAY, bucketCount: 28 },
	{ id: "monthly", label: "Monthly", windowMs: 30 * MILLISECONDS_PER_DAY, bucketCount: 30 },
	{ id: "quarterly", label: "Quarterly", windowMs: 90 * MILLISECONDS_PER_DAY, bucketCount: 90 },
] as const;
export type UsagePeriod = typeof USAGE_PERIODS[number]["id"];

export function usagePeriod(period: UsagePeriod): typeof USAGE_PERIODS[number] {
	return USAGE_PERIODS.find((candidate) => candidate.id === period)!;
}

export function usagePeriodStart(period: UsagePeriod, now: number): number {
	return Math.max(0, now - usagePeriod(period).windowMs);
}

/**
 * The bucket boundaries a chart period actually renders. Shared, byte-identical, by both sides of
 * the wire: the daemon computes the SAME window from the same (period, now[, bucketCount]) before
 * running its SQL-side GROUP BY, so a pre-aggregated bucket sum always lands in exactly the bucket
 * the chart expects -- there is no second, independent bucketing pass left to disagree with it.
 */
export interface UsageBucketWindow {
	start: number;
	end: number;
	bucketCount: number;
	bucketSizeMs: number;
}

export function resolveUsageWindow(period: UsagePeriod, now: number, bucketCount?: number): UsageBucketWindow {
	const end = now;
	const start = usagePeriodStart(period, end);
	const requested = bucketCount ?? usagePeriod(period).bucketCount;
	const count = Math.max(1, Math.min(MAX_USAGE_BUCKETS, Math.floor(requested)));
	const bucketSizeMs = Math.max(1, (end - start) / count);
	return { start, end, bucketCount: count, bucketSizeMs };
}

/** Mirrors the SQL-side `MIN(CAST((observed_at - start) / bucketSizeMs AS INTEGER), bucketCount - 1)` grouping exactly. */
export function usageBucketIndex(observedAt: number, window: UsageBucketWindow): number {
	return Math.min(window.bucketCount - 1, Math.max(0, Math.floor((observedAt - window.start) / window.bucketSizeMs)));
}

/**
 * One already-summed (scope, metric, bucket) cell -- what the daemon's SQL-side GROUP BY returns,
 * replacing a bounded-but-still-truncatable fetch of raw per-observation rows. Result size scales
 * with (distinct scopes x distinct metrics x bucket count), never with raw event count, so a
 * heavy scope's full history is represented exactly regardless of how many observations it made
 * (a real incident: a scope with 49,270 rows in a week had its "weekly" chart built from the 250
 * most recent rows alone -- 3.3 minutes of real activity mislabeled as a full week).
 */
export interface UsageAggregateRow {
	scope: string;
	metric: string;
	bucketIndex: number;
	sum: number;
}

export interface UsageSeries {
	key: string;
	provider: string;
	model: string;
	total: number;
}

export interface UsageBucket {
	start: number;
	end: number;
	total: number;
	series: Record<string, number>;
}

export interface UsageBreakdown {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface UsageGraph {
	period: UsagePeriod;
	start: number;
	end: number;
	buckets: UsageBucket[];
	series: UsageSeries[];
	totalTokens: number;
	breakdown: UsageBreakdown;
	truncated: boolean;
}

export interface UsageGraphOptions {
	period: UsagePeriod;
	truncated?: boolean;
}

const BREAKDOWN_KEYS = {
	"input-tokens": "input",
	"output-tokens": "output",
	"cache-read-tokens": "cacheRead",
	"cache-write-tokens": "cacheWrite",
} as const satisfies Record<string, keyof UsageBreakdown>;

/**
 * Derives provider/model from `scope` alone (`"${provider}:${model}"`, see assistantUsageMetrics),
 * rather than needing a row's `attributes.provider`/`attributes.model` -- source "pi" always
 * constructs `scope` from those exact same two values, so the two are equivalent for this source,
 * and an aggregated bucket sum has no per-row attributes left to read anyway.
 */
export function identity(scope: string): { key: string; provider: string; model: string } {
	const separator = scope.indexOf(":");
	const provider = separator >= 0 ? scope.slice(0, separator) : scope;
	const model = separator >= 0 ? scope.slice(separator + 1) : "unknown";
	return { key: `${provider}/${model}`, provider, model };
}

function emptyBuckets(window: UsageBucketWindow): { start: number; end: number; total: number; series: Record<string, number> }[] {
	return Array.from({ length: window.bucketCount }, (_, index) => ({
		start: window.start + index * window.bucketSizeMs,
		end: index === window.bucketCount - 1 ? window.end : window.start + (index + 1) * window.bucketSizeMs,
		total: 0,
		series: {},
	}));
}

export function buildUsageGraph(rows: UsageAggregateRow[], window: UsageBucketWindow, options: UsageGraphOptions): UsageGraph {
	const buckets: UsageBucket[] = emptyBuckets(window);
	const breakdown: UsageBreakdown = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	const identities = new Map<string, UsageSeries>();

	for (const row of rows) {
		const breakdownKey = BREAKDOWN_KEYS[row.metric as keyof typeof BREAKDOWN_KEYS];
		if (!breakdownKey || !Number.isFinite(row.sum) || row.sum < 0) continue;
		if (!Number.isInteger(row.bucketIndex) || row.bucketIndex < 0 || row.bucketIndex >= buckets.length) continue;
		const bucket = buckets[row.bucketIndex]!;
		const series = identity(row.scope);
		bucket.total += row.sum;
		bucket.series[series.key] = (bucket.series[series.key] ?? 0) + row.sum;
		breakdown[breakdownKey] += row.sum;
		const current = identities.get(series.key) ?? { ...series, total: 0 };
		current.total += row.sum;
		identities.set(series.key, current);
	}

	const series = [...identities.values()].sort((left, right) => right.total - left.total || left.key.localeCompare(right.key));
	return {
		period: options.period,
		start: window.start,
		end: window.end,
		buckets,
		series,
		totalTokens: buckets.reduce((sum, bucket) => sum + bucket.total, 0),
		breakdown,
		truncated: options.truncated === true,
	};
}

export interface CostSeries {
	key: string;
	provider: string;
	model: string;
	total: number;
}

export interface CostBucket {
	start: number;
	end: number;
	total: number;
	series: Record<string, number>;
}

export interface CostGraph {
	period: UsagePeriod;
	start: number;
	end: number;
	buckets: CostBucket[];
	series: CostSeries[];
	totalUsd: number;
	truncated: boolean;
}

/**
 * Mirrors buildUsageGraph but for the "cost" (unit "usd") metric already recorded content-free on
 * every finalized Pi assistant message (see assistantUsageMetrics), so this needs no new
 * instrumentation. Aggregated spend by model/time is one of the metrics LLM usage dashboards
 * surface from day one (alongside raw token counts), since token counts alone do not reflect that
 * output tokens and premium models cost disproportionately more per token.
 */
export function buildCostGraph(rows: UsageAggregateRow[], window: UsageBucketWindow, options: UsageGraphOptions): CostGraph {
	const buckets: CostBucket[] = emptyBuckets(window);
	const identities = new Map<string, CostSeries>();

	for (const row of rows) {
		if (row.metric !== "cost" || !Number.isFinite(row.sum) || row.sum < 0) continue;
		if (!Number.isInteger(row.bucketIndex) || row.bucketIndex < 0 || row.bucketIndex >= buckets.length) continue;
		const bucket = buckets[row.bucketIndex]!;
		const series = identity(row.scope);
		bucket.total += row.sum;
		bucket.series[series.key] = (bucket.series[series.key] ?? 0) + row.sum;
		const current = identities.get(series.key) ?? { ...series, total: 0 };
		current.total += row.sum;
		identities.set(series.key, current);
	}

	const series = [...identities.values()].sort((left, right) => right.total - left.total || left.key.localeCompare(right.key));
	return {
		period: options.period,
		start: window.start,
		end: window.end,
		buckets,
		series,
		totalUsd: buckets.reduce((sum, bucket) => sum + bucket.total, 0),
		truncated: options.truncated === true,
	};
}
