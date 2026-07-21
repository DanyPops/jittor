import { MAX_USAGE_BUCKETS, MILLISECONDS_PER_DAY, MILLISECONDS_PER_HOUR } from "../constants.ts";
import type { StoredMetricObservation } from "./metric.ts";

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
	now: number;
	bucketCount?: number;
	truncated?: boolean;
}

const BREAKDOWN_KEYS = {
	"input-tokens": "input",
	"output-tokens": "output",
	"cache-read-tokens": "cacheRead",
	"cache-write-tokens": "cacheWrite",
} as const satisfies Record<string, keyof UsageBreakdown>;

export function usagePeriodStart(period: UsagePeriod, now: number): number {
	return Math.max(0, now - usagePeriod(period).windowMs);
}

export function identity(row: StoredMetricObservation): { key: string; provider: string; model: string } {
	const separator = row.scope.indexOf(":");
	const fallbackProvider = separator >= 0 ? row.scope.slice(0, separator) : row.scope;
	const fallbackModel = separator >= 0 ? row.scope.slice(separator + 1) : "unknown";
	const provider = typeof row.attributes["provider"] === "string" ? row.attributes["provider"] : fallbackProvider;
	const model = typeof row.attributes["model"] === "string" ? row.attributes["model"] : fallbackModel;
	return { key: `${provider}/${model}`, provider, model };
}

interface BucketWindow { start: number; end: number; bucketCount: number; bucketSize: number }

function bucketWindow(options: UsageGraphOptions): BucketWindow {
	const end = options.now;
	const start = usagePeriodStart(options.period, end);
	const requestedBuckets = options.bucketCount ?? usagePeriod(options.period).bucketCount;
	const bucketCount = Math.max(1, Math.min(MAX_USAGE_BUCKETS, Math.floor(requestedBuckets)));
	const bucketSize = Math.max(1, (end - start) / bucketCount);
	return { start, end, bucketCount, bucketSize };
}

function emptyBuckets(window: BucketWindow): { start: number; end: number; total: number; series: Record<string, number> }[] {
	return Array.from({ length: window.bucketCount }, (_, index) => ({
		start: window.start + index * window.bucketSize,
		end: index === window.bucketCount - 1 ? window.end : window.start + (index + 1) * window.bucketSize,
		total: 0,
		series: {},
	}));
}

function bucketIndexFor(observedAt: number, window: BucketWindow): number {
	return Math.min(window.bucketCount - 1, Math.floor((observedAt - window.start) / window.bucketSize));
}

export function buildUsageGraph(rows: StoredMetricObservation[], options: UsageGraphOptions): UsageGraph {
	const window = bucketWindow(options);
	const { start, end } = window;
	const buckets: UsageBucket[] = emptyBuckets(window);
	const breakdown: UsageBreakdown = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	const identities = new Map<string, UsageSeries>();

	for (const row of rows) {
		const breakdownKey = BREAKDOWN_KEYS[row.metric as keyof typeof BREAKDOWN_KEYS];
		if (row.source !== "pi" || row.unit !== "tokens" || !breakdownKey || typeof row.value !== "number" || row.value < 0) continue;
		if (row.observedAt < start || row.observedAt > end) continue;
		const bucket = buckets[bucketIndexFor(row.observedAt, window)]!;
		const series = identity(row);
		bucket.total += row.value;
		bucket.series[series.key] = (bucket.series[series.key] ?? 0) + row.value;
		breakdown[breakdownKey] += row.value;
		const current = identities.get(series.key) ?? { ...series, total: 0 };
		current.total += row.value;
		identities.set(series.key, current);
	}

	const series = [...identities.values()].sort((left, right) => right.total - left.total || left.key.localeCompare(right.key));
	return {
		period: options.period,
		start,
		end,
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
export function buildCostGraph(rows: StoredMetricObservation[], options: UsageGraphOptions): CostGraph {
	const window = bucketWindow(options);
	const { start, end } = window;
	const buckets: CostBucket[] = emptyBuckets(window);
	const identities = new Map<string, CostSeries>();

	for (const row of rows) {
		if (row.source !== "pi" || row.unit !== "usd" || row.metric !== "cost" || typeof row.value !== "number" || row.value < 0) continue;
		if (row.observedAt < start || row.observedAt > end) continue;
		const bucket = buckets[bucketIndexFor(row.observedAt, window)]!;
		const series = identity(row);
		bucket.total += row.value;
		bucket.series[series.key] = (bucket.series[series.key] ?? 0) + row.value;
		const current = identities.get(series.key) ?? { ...series, total: 0 };
		current.total += row.value;
		identities.set(series.key, current);
	}

	const series = [...identities.values()].sort((left, right) => right.total - left.total || left.key.localeCompare(right.key));
	return {
		period: options.period,
		start,
		end,
		buckets,
		series,
		totalUsd: buckets.reduce((sum, bucket) => sum + bucket.total, 0),
		truncated: options.truncated === true,
	};
}
