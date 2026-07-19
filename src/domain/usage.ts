import type { StoredMetricObservation } from "./metric.ts";

export const USAGE_RANGES = ["24h", "7d", "30d", "90d"] as const;
export type UsageRange = typeof USAGE_RANGES[number];

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

export interface UsageHistogram {
	range: UsageRange;
	start: number;
	end: number;
	buckets: UsageBucket[];
	series: UsageSeries[];
	totalTokens: number;
	breakdown: UsageBreakdown;
}

export interface UsageHistogramOptions {
	range: UsageRange;
	now: number;
	bucketCount?: number;
}

const RANGE_MILLISECONDS: Record<UsageRange, number> = {
	"24h": 24 * 60 * 60 * 1_000,
	"7d": 7 * 24 * 60 * 60 * 1_000,
	"30d": 30 * 24 * 60 * 60 * 1_000,
	"90d": 90 * 24 * 60 * 60 * 1_000,
};

const DEFAULT_BUCKETS: Record<UsageRange, number> = { "24h": 24, "7d": 28, "30d": 30, "90d": 30 };

const BREAKDOWN_KEYS = {
	"input-tokens": "input",
	"output-tokens": "output",
	"cache-read-tokens": "cacheRead",
	"cache-write-tokens": "cacheWrite",
} as const satisfies Record<string, keyof UsageBreakdown>;

export function usageRangeStart(range: UsageRange, now: number): number {
	return Math.max(0, now - RANGE_MILLISECONDS[range]);
}

function identity(row: StoredMetricObservation): { key: string; provider: string; model: string } {
	const separator = row.scope.indexOf(":");
	const fallbackProvider = separator >= 0 ? row.scope.slice(0, separator) : row.scope;
	const fallbackModel = separator >= 0 ? row.scope.slice(separator + 1) : "unknown";
	const provider = typeof row.attributes["provider"] === "string" ? row.attributes["provider"] : fallbackProvider;
	const model = typeof row.attributes["model"] === "string" ? row.attributes["model"] : fallbackModel;
	return { key: `${provider}/${model}`, provider, model };
}

export function buildUsageHistogram(rows: StoredMetricObservation[], options: UsageHistogramOptions): UsageHistogram {
	const end = options.now;
	const start = usageRangeStart(options.range, end);
	const requestedBuckets = options.bucketCount ?? DEFAULT_BUCKETS[options.range];
	const bucketCount = Math.max(1, Math.min(120, Math.floor(requestedBuckets)));
	const bucketSize = Math.max(1, (end - start) / bucketCount);
	const buckets: UsageBucket[] = Array.from({ length: bucketCount }, (_, index) => ({
		start: start + index * bucketSize,
		end: index === bucketCount - 1 ? end : start + (index + 1) * bucketSize,
		total: 0,
		series: {},
	}));
	const breakdown: UsageBreakdown = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	const identities = new Map<string, UsageSeries>();

	for (const row of rows) {
		const breakdownKey = BREAKDOWN_KEYS[row.metric as keyof typeof BREAKDOWN_KEYS];
		if (row.source !== "pi" || row.unit !== "tokens" || !breakdownKey || typeof row.value !== "number" || row.value < 0) continue;
		if (row.observedAt < start || row.observedAt > end) continue;
		const bucketIndex = Math.min(bucketCount - 1, Math.floor((row.observedAt - start) / bucketSize));
		const bucket = buckets[bucketIndex]!;
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
		range: options.range,
		start,
		end,
		buckets,
		series,
		totalTokens: buckets.reduce((sum, bucket) => sum + bucket.total, 0),
		breakdown,
	};
}
