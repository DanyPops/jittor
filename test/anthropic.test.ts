import { describe, expect, it } from "bun:test";
import { hasAnthropicRateLimitHeaders, parseAnthropicRateLimitHeaders } from "../src/providers/anthropic-contracts.ts";

describe("Anthropic official rate-limit response headers", () => {
	it("parses request, token, and priority-tier buckets into used/remaining-fraction metrics", () => {
		const headers = new Headers({
			"anthropic-ratelimit-requests-limit": "1000",
			"anthropic-ratelimit-requests-remaining": "750",
			"anthropic-ratelimit-requests-reset": "2026-07-21T12:00:00Z",
			"anthropic-ratelimit-tokens-limit": "2000000",
			"anthropic-ratelimit-tokens-remaining": "1500000",
			"anthropic-ratelimit-tokens-reset": "2026-07-21T12:00:00Z",
			"anthropic-ratelimit-input-tokens-limit": "2000000",
			"anthropic-ratelimit-input-tokens-remaining": "1900000",
			"anthropic-ratelimit-input-tokens-reset": "2026-07-21T12:00:00Z",
			"anthropic-ratelimit-output-tokens-limit": "400000",
			"anthropic-ratelimit-output-tokens-remaining": "100000",
			"anthropic-ratelimit-output-tokens-reset": "2026-07-21T12:00:00Z",
			"retry-after": "30",
		});

		const snapshot = parseAnthropicRateLimitHeaders(headers, 1_700_000_000_000);

		expect(snapshot.requests).toEqual({ limit: 1000, remaining: 750, resetsAt: Date.parse("2026-07-21T12:00:00Z") });
		expect(snapshot.outputTokens).toEqual({ limit: 400_000, remaining: 100_000, resetsAt: Date.parse("2026-07-21T12:00:00Z") });
		expect(snapshot.priorityInputTokens).toBeNull();
		expect(snapshot.retryAfterMs).toBe(30_000);
		expect(snapshot.metrics).toContainEqual(expect.objectContaining({
			source: "anthropic", scope: "requests", metric: "used-fraction", value: 0.25, unit: "ratio",
		}));
		expect(snapshot.metrics).toContainEqual(expect.objectContaining({
			source: "anthropic", scope: "output-tokens", metric: "used-fraction", value: 0.75, unit: "ratio",
		}));
		expect(snapshot.metrics).toHaveLength(8);
	});

	it("treats a response with no recognized headers as no signal rather than a schema error", () => {
		const headers = new Headers({ "content-type": "application/json" });
		expect(hasAnthropicRateLimitHeaders(headers)).toBe(false);
		const snapshot = parseAnthropicRateLimitHeaders(headers, 1_000);
		expect(snapshot).toMatchObject({ requests: null, tokens: null, inputTokens: null, outputTokens: null, retryAfterMs: null, metrics: [] });
	});

	it("detects optional Priority Tier headers only when present", () => {
		const headers = new Headers({
			"anthropic-priority-input-tokens-limit": "500000",
			"anthropic-priority-input-tokens-remaining": "250000",
			"anthropic-priority-input-tokens-reset": "2026-07-21T12:00:00Z",
		});
		expect(hasAnthropicRateLimitHeaders(headers)).toBe(true);
		const snapshot = parseAnthropicRateLimitHeaders(headers, 1_000);
		expect(snapshot.priorityInputTokens).toEqual({ limit: 500_000, remaining: 250_000, resetsAt: Date.parse("2026-07-21T12:00:00Z") });
		expect(snapshot.metrics).toEqual([
			expect.objectContaining({ scope: "priority-input-tokens", metric: "remaining-fraction", value: 0.5 }),
			expect.objectContaining({ scope: "priority-input-tokens", metric: "used-fraction", value: 0.5 }),
		]);
	});

	it("fails closed on schema drift instead of guessing", () => {
		expect(() => parseAnthropicRateLimitHeaders(new Headers({ "anthropic-ratelimit-requests-limit": "not-a-number" }), 1_000))
			.toThrow("header schema changed");
		expect(() => parseAnthropicRateLimitHeaders(new Headers({ "anthropic-ratelimit-requests-reset": "not-a-date" }), 1_000))
			.toThrow("not RFC 3339");
		expect(() => parseAnthropicRateLimitHeaders(new Headers({
			"anthropic-ratelimit-requests-limit": "10", "anthropic-ratelimit-requests-remaining": "11",
		}), 1_000)).toThrow("remaining exceeds its configured limit");
		expect(() => parseAnthropicRateLimitHeaders(new Headers({ "retry-after": "-1" }), 1_000)).toThrow("header schema changed");
	});
});
