import { describe, expect, it } from "bun:test";
import {
	OpenRouterTelemetryAdapter,
	openRouterUsageMetrics,
	parseOpenRouterUsage,
} from "../src/providers/openrouter.ts";

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return Response.json(data, { status, headers });
}

describe("OpenRouter telemetry adapter", () => {
	it("reads official key limits and projects normalized budget metrics", async () => {
		const requests: Request[] = [];
		const adapter = new OpenRouterTelemetryAdapter("secret-key", async (request) => {
			requests.push(request);
			return json({ data: {
				label: "jittor", limit: 100, limit_remaining: 40, limit_reset: "monthly",
				usage: 60, usage_daily: 3, usage_weekly: 12, usage_monthly: 60,
				is_management_key: false, is_provisioning_key: false,
				rate_limit: { requests: 200, interval: "10s" },
			} });
		});

		const snapshot = await adapter.readKey(1000);

		expect(requests[0]?.url).toBe("https://openrouter.ai/api/v1/key");
		expect(requests[0]?.headers.get("authorization")).toBe("Bearer secret-key");
		expect(snapshot).toMatchObject({ limit: 100, remaining: 40, usage: 60, reset: "monthly", management: false });
		expect(snapshot.metrics.map((metric) => [metric.metric, metric.value, metric.unit])).toContainEqual(["limit-remaining", 40, "usd"]);
		expect(snapshot.metrics.map((metric) => [metric.metric, metric.value, metric.unit])).toContainEqual(["remaining-fraction", 0.4, "ratio"]);
		expect(snapshot.metrics.find((metric) => metric.metric === "remaining-fraction")?.attributes).toEqual({ limit: 100, remaining: 40, reset: "monthly" });
		expect(snapshot.metrics.map((metric) => metric.metric)).toContain("usage-monthly");
	});

	it("normalizes per-response token, reasoning, cache, and cost accounting", () => {
		const usage = parseOpenRouterUsage({
			prompt_tokens: 100,
			completion_tokens: 25,
			total_tokens: 125,
			reasoning_tokens: 10,
			cost: 0.004,
			prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: 5 },
			cost_details: { upstream_inference_cost: 0.003 },
		});
		const metrics = openRouterUsageMetrics(usage, {
			observedAt: 2000, generationId: "gen-1", model: "openai/gpt-4.1-mini",
		});

		expect(metrics.map((metric) => [metric.metric, metric.value])).toEqual([
			["prompt-tokens", 100], ["completion-tokens", 25], ["total-tokens", 125],
			["reasoning-tokens", 10], ["cached-read-tokens", 40], ["cached-write-tokens", 5],
			["cost", 0.004], ["upstream-cost", 0.003],
		]);
		expect(metrics[0]?.attributes).toEqual({ generationId: "gen-1", model: "openai/gpt-4.1-mini" });
	});

	it("loads canonical model capabilities and pricing", async () => {
		const adapter = new OpenRouterTelemetryAdapter("secret-key", async () => json({ data: [{
			id: "openai/gpt-4.1-mini", canonical_slug: "openai/gpt-4.1-mini-2025-04-14",
			name: "GPT-4.1 Mini", context_length: 1_000_000,
			pricing: { prompt: "0.0000004", completion: "0.0000016", request: "0" },
			supported_parameters: ["tools", "reasoning"],
			top_provider: { max_completion_tokens: 32_768 }, expiration_date: null,
		}] }));

		expect(await adapter.listModels()).toEqual([{
			id: "openai/gpt-4.1-mini", canonicalSlug: "openai/gpt-4.1-mini-2025-04-14",
			name: "GPT-4.1 Mini", contextLength: 1_000_000,
			pricing: { prompt: 0.0000004, completion: 0.0000016, request: 0 },
			supportedParameters: ["tools", "reasoning"], maxCompletionTokens: 32_768, expiresAt: null,
		}]);
	});

	it("looks up generations and gates beta analytics on management capability", async () => {
		const urls: string[] = [];
		const adapter = new OpenRouterTelemetryAdapter("secret-key", async (request) => {
			urls.push(request.url);
			if (request.url.endsWith("/key")) return json({ data: { limit: null, limit_remaining: null, usage: 0, is_management_key: true } });
			if (request.url.includes("/generation")) return json({ data: { id: "gen-1", total_cost: 0.02, tokens_prompt: 200, tokens_completion: 50 } });
			return json({ data: [{ model: "openai/gpt-4.1-mini", total_usage: 1.25 }], metadata: { truncated: false } });
		});

		await adapter.readKey(1000);
		expect(await adapter.getGeneration("gen-1")).toMatchObject({ id: "gen-1", totalCost: 0.02 });
		expect(await adapter.queryAnalytics({ metrics: ["total_usage"] })).toEqual({
			data: [{ model: "openai/gpt-4.1-mini", total_usage: 1.25 }], metadata: { truncated: false },
		});
		expect(urls).toContain("https://openrouter.ai/api/v1/generation?id=gen-1");
	});

	it("fails without exposing API credentials", async () => {
		const adapter = new OpenRouterTelemetryAdapter("super-secret", async () => json({ error: { message: "denied" } }, 401));
		let message = "";
		try { await adapter.readKey(1000); } catch (error) { message = error instanceof Error ? error.message : String(error); }
		expect(message).toContain("HTTP 401");
		expect(message).not.toContain("super-secret");
	});
});
