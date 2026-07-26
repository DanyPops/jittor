import type { MetricObservation } from "../domain/metric.ts";

/**
 * Official Anthropic Messages API rate-limit response headers, verified against
 * https://platform.claude.com/docs/en/api/rate-limits (fetched 2026-07-21). These headers are
 * returned on every Messages API response (per-request, not from a standalone polling endpoint —
 * Anthropic's Admin/Rate Limits API is documented as "unavailable for individual accounts"), so
 * Jittor observes them from Pi's own `after_provider_response` event rather than daemon-side
 * polling. Priority Tier buckets are optional and only present for organizations enrolled in it.
 */
export interface AnthropicRateLimitWindow {
	limit: number | null;
	remaining: number | null;
	resetsAt: number | null;
}

export interface AnthropicRateLimitSnapshot {
	requests: AnthropicRateLimitWindow | null;
	tokens: AnthropicRateLimitWindow | null;
	inputTokens: AnthropicRateLimitWindow | null;
	outputTokens: AnthropicRateLimitWindow | null;
	priorityInputTokens: AnthropicRateLimitWindow | null;
	priorityOutputTokens: AnthropicRateLimitWindow | null;
	retryAfterMs: number | null;
	observedAt: number;
	metrics: MetricObservation[];
}

function metric(
	source: AnthropicMetricSource,
	scope: string,
	name: string,
	value: number,
	unit: MetricObservation["unit"],
	observedAt: number,
	attributes: Record<string, unknown> = {},
): MetricObservation {
	return { source, scope, metric: name, value, unit, observedAt, attributes };
}

function headerInteger(headers: Headers, name: string): number | null {
	const raw = headers.get(name);
	if (raw === null) return null;
	const value = Number(raw);
	if (!Number.isFinite(value) || !Number.isSafeInteger(value) || value < 0) throw new Error(`Anthropic rate-limit header schema changed: ${name}`);
	return value;
}

function headerResetTime(headers: Headers, name: string): number | null {
	const raw = headers.get(name);
	if (raw === null) return null;
	const parsed = Date.parse(raw);
	if (!Number.isFinite(parsed)) throw new Error(`Anthropic rate-limit header schema changed: ${name} is not RFC 3339`);
	return parsed;
}

function parseWindow(headers: Headers, prefix: string): AnthropicRateLimitWindow | null {
	const limit = headerInteger(headers, `${prefix}-limit`);
	const remaining = headerInteger(headers, `${prefix}-remaining`);
	const resetsAt = headerResetTime(headers, `${prefix}-reset`);
	if (limit === null && remaining === null && resetsAt === null) return null;
	return { limit, remaining, resetsAt };
}

function windowMetrics(source: AnthropicMetricSource, scope: string, window: AnthropicRateLimitWindow | null, observedAt: number): MetricObservation[] {
	if (!window) return [];
	const metrics: MetricObservation[] = [];
	const attributes = { limit: window.limit, remaining: window.remaining, resetsAt: window.resetsAt };
	if (window.limit !== null && window.limit > 0 && window.remaining !== null) {
		const remainingFraction = window.remaining / window.limit;
		if (remainingFraction < 0 || remainingFraction > 1) throw new Error(`Anthropic ${scope} remaining exceeds its configured limit`);
		metrics.push(metric(source, scope, "remaining-fraction", remainingFraction, "ratio", observedAt, attributes));
		metrics.push(metric(source, scope, "used-fraction", 1 - remainingFraction, "ratio", observedAt, attributes));
	}
	return metrics;
}

/**
 * Direct Anthropic API calls and Anthropic-on-Vertex passthroughs (e.g. the third-party
 * `@twogiants/pi-anthropic-vertex` extension, which reuses Pi's built-in Anthropic Messages stream
 * with Anthropic's own `@anthropic-ai/vertex-sdk` client) may both emit this same header shape, but
 * they are different accounts against different quota pools -- Anthropic's own org-scoped buckets
 * vs whatever a Vertex project's passthrough exposes, if anything. Tagging the metric source keeps
 * them from ever being blended into one budget reading.
 */
export type AnthropicMetricSource = "anthropic" | "anthropic-vertex";

export function parseAnthropicRateLimitHeaders(headers: Headers, observedAt = Date.now(), source: AnthropicMetricSource = "anthropic"): AnthropicRateLimitSnapshot {
	const requests = parseWindow(headers, "anthropic-ratelimit-requests");
	const tokens = parseWindow(headers, "anthropic-ratelimit-tokens");
	const inputTokens = parseWindow(headers, "anthropic-ratelimit-input-tokens");
	const outputTokens = parseWindow(headers, "anthropic-ratelimit-output-tokens");
	const priorityInputTokens = parseWindow(headers, "anthropic-priority-input-tokens");
	const priorityOutputTokens = parseWindow(headers, "anthropic-priority-output-tokens");
	const retryAfterRaw = headers.get("retry-after");
	const retryAfterSeconds = retryAfterRaw === null ? null : Number(retryAfterRaw);
	if (retryAfterRaw !== null && (!Number.isFinite(retryAfterSeconds) || (retryAfterSeconds as number) < 0)) {
		throw new Error("Anthropic rate-limit header schema changed: retry-after");
	}
	return {
		requests,
		tokens,
		inputTokens,
		outputTokens,
		priorityInputTokens,
		priorityOutputTokens,
		retryAfterMs: retryAfterSeconds === null ? null : Math.round(retryAfterSeconds * 1_000),
		observedAt,
		metrics: [
			...windowMetrics(source, "requests", requests, observedAt),
			...windowMetrics(source, "tokens", tokens, observedAt),
			...windowMetrics(source, "input-tokens", inputTokens, observedAt),
			...windowMetrics(source, "output-tokens", outputTokens, observedAt),
			...windowMetrics(source, "priority-input-tokens", priorityInputTokens, observedAt),
			...windowMetrics(source, "priority-output-tokens", priorityOutputTokens, observedAt),
		],
	};
}

/** True when the response carries at least one recognized Anthropic rate-limit header. */
export function hasAnthropicRateLimitHeaders(headers: Headers): boolean {
	for (const name of headers.keys()) {
		const lower = name.toLowerCase();
		if (lower.startsWith("anthropic-ratelimit-") || lower.startsWith("anthropic-priority-")) return true;
	}
	return false;
}
