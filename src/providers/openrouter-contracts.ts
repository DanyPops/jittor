import type { MetricObservation } from "../domain/metric.ts";

export interface OpenRouterUsage {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	reasoningTokens: number;
	cachedReadTokens: number;
	cachedWriteTokens: number;
	cost: number;
	upstreamCost: number;
}

export interface OpenRouterUsageContext {
	observedAt: number;
	generationId: string;
	model: string;
}

export interface OpenRouterKeySnapshot {
	label: string | null;
	limit: number | null;
	remaining: number | null;
	reset: string | null;
	usage: number;
	usageDaily: number | null;
	usageWeekly: number | null;
	usageMonthly: number | null;
	management: boolean;
	provisioning: boolean;
	rateLimit: Record<string, unknown> | null;
	observedAt: number;
	metrics: MetricObservation[];
}

export interface OpenRouterModel {
	id: string;
	canonicalSlug: string;
	name: string;
	contextLength: number;
	pricing: { prompt: number; completion: number; request: number };
	supportedParameters: string[];
	maxCompletionTokens: number | null;
	expiresAt: string | null;
}

export interface OpenRouterGeneration {
	id: string;
	totalCost: number;
	promptTokens: number;
	completionTokens: number;
	raw: Record<string, unknown>;
}

export interface OpenRouterAnalyticsResult {
	data: Array<Record<string, unknown>>;
	metadata: { truncated: boolean; [key: string]: unknown };
}

export function contractRecord(value: unknown, name: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`OpenRouter ${name} schema changed`);
	return value as Record<string, unknown>;
}

function finite(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`OpenRouter ${name} schema changed`);
	return value;
}

function optionalFinite(value: unknown, name: string): number | null {
	return value === null || value === undefined ? null : finite(value, name);
}

function text(value: unknown, name: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`OpenRouter ${name} schema changed`);
	return value;
}

function optionalText(value: unknown, name: string): string | null {
	return value === null || value === undefined ? null : text(value, name);
}

function price(value: unknown, name: string): number {
	const parsed = Number(text(value, name));
	if (!Number.isFinite(parsed)) throw new Error(`OpenRouter ${name} schema changed`);
	return parsed;
}

function metric(
	scope: string,
	metricName: string,
	value: number,
	unit: MetricObservation["unit"],
	observedAt: number,
	attributes: Record<string, unknown> = {},
): MetricObservation {
	return { source: "openrouter", scope, metric: metricName, value, unit, observedAt, attributes };
}

export function parseOpenRouterUsage(value: unknown): OpenRouterUsage {
	const usage = contractRecord(value, "usage");
	const promptDetails = usage["prompt_tokens_details"] === undefined
		? {}
		: contractRecord(usage["prompt_tokens_details"], "prompt token details");
	const costDetails = usage["cost_details"] === undefined
		? {}
		: contractRecord(usage["cost_details"], "cost details");
	return {
		promptTokens: finite(usage["prompt_tokens"], "prompt tokens"),
		completionTokens: finite(usage["completion_tokens"], "completion tokens"),
		totalTokens: finite(usage["total_tokens"], "total tokens"),
		reasoningTokens: optionalFinite(usage["reasoning_tokens"], "reasoning tokens") ?? 0,
		cachedReadTokens: optionalFinite(promptDetails["cached_tokens"], "cached tokens") ?? 0,
		cachedWriteTokens: optionalFinite(promptDetails["cache_write_tokens"], "cache write tokens") ?? 0,
		cost: finite(usage["cost"], "cost"),
		upstreamCost: optionalFinite(costDetails["upstream_inference_cost"], "upstream inference cost") ?? 0,
	};
}

export function openRouterUsageMetrics(usage: OpenRouterUsage, context: OpenRouterUsageContext): MetricObservation[] {
	const attributes = { generationId: context.generationId, model: context.model };
	const token = (name: string, value: number) => metric("response", name, value, "tokens", context.observedAt, attributes);
	return [
		token("prompt-tokens", usage.promptTokens),
		token("completion-tokens", usage.completionTokens),
		token("total-tokens", usage.totalTokens),
		token("reasoning-tokens", usage.reasoningTokens),
		token("cached-read-tokens", usage.cachedReadTokens),
		token("cached-write-tokens", usage.cachedWriteTokens),
		metric("response", "cost", usage.cost, "usd", context.observedAt, attributes),
		metric("response", "upstream-cost", usage.upstreamCost, "usd", context.observedAt, attributes),
	];
}

export function parseOpenRouterKey(rootValue: unknown, observedAt: number): OpenRouterKeySnapshot {
	const root = contractRecord(rootValue, "key response");
	const data = contractRecord(root["data"], "key data");
	const label = optionalText(data["label"], "key label");
	const limit = optionalFinite(data["limit"], "key limit");
	const remaining = optionalFinite(data["limit_remaining"], "key limit remaining");
	const usage = finite(data["usage"], "key usage");
	const snapshot: OpenRouterKeySnapshot = {
		label,
		limit,
		remaining,
		reset: optionalText(data["limit_reset"], "key limit reset"),
		usage,
		usageDaily: optionalFinite(data["usage_daily"], "daily usage"),
		usageWeekly: optionalFinite(data["usage_weekly"], "weekly usage"),
		usageMonthly: optionalFinite(data["usage_monthly"], "monthly usage"),
		management: data["is_management_key"] === true,
		provisioning: data["is_provisioning_key"] === true,
		rateLimit: data["rate_limit"] === undefined || data["rate_limit"] === null ? null : contractRecord(data["rate_limit"], "rate limit"),
		observedAt,
		metrics: [],
	};
	const scope = `key:${label ?? "default"}`;
	const add = (name: string, value: number | null): void => {
		if (value !== null) snapshot.metrics.push(metric(scope, name, value, "usd", observedAt));
	};
	add("usage", usage);
	add("usage-daily", snapshot.usageDaily);
	add("usage-weekly", snapshot.usageWeekly);
	add("usage-monthly", snapshot.usageMonthly);
	add("limit", limit);
	add("limit-remaining", remaining);
	if (limit !== null && limit > 0 && remaining !== null) {
		const remainingFraction = remaining / limit;
		if (remainingFraction < 0 || remainingFraction > 1) throw new Error("OpenRouter key remaining fraction is outside its configured limit");
		const attributes = { limit, remaining, reset: snapshot.reset };
		snapshot.metrics.push(metric(scope, "remaining-fraction", remainingFraction, "ratio", observedAt, attributes));
		snapshot.metrics.push(metric(scope, "used-fraction", 1 - remainingFraction, "ratio", observedAt, attributes));
	}
	return snapshot;
}

export function parseOpenRouterModels(rootValue: unknown): OpenRouterModel[] {
	const root = contractRecord(rootValue, "models response");
	if (!Array.isArray(root["data"])) throw new Error("OpenRouter models schema changed");
	return root["data"].map((value) => {
		const model = contractRecord(value, "model");
		const pricing = contractRecord(model["pricing"], "model pricing");
		const provider = contractRecord(model["top_provider"], "top provider");
		if (!Array.isArray(model["supported_parameters"]) || !model["supported_parameters"].every((parameter) => typeof parameter === "string")) {
			throw new Error("OpenRouter supported parameters schema changed");
		}
		return {
			id: text(model["id"], "model id"),
			canonicalSlug: text(model["canonical_slug"], "canonical slug"),
			name: text(model["name"], "model name"),
			contextLength: finite(model["context_length"], "context length"),
			pricing: {
				prompt: price(pricing["prompt"], "prompt pricing"),
				completion: price(pricing["completion"], "completion pricing"),
				request: price(pricing["request"], "request pricing"),
			},
			supportedParameters: model["supported_parameters"] as string[],
			maxCompletionTokens: optionalFinite(provider["max_completion_tokens"], "max completion tokens"),
			expiresAt: optionalText(model["expiration_date"], "expiration date"),
		};
	});
}

export function parseOpenRouterGeneration(rootValue: unknown): OpenRouterGeneration {
	const root = contractRecord(rootValue, "generation response");
	const data = contractRecord(root["data"], "generation data");
	return {
		id: text(data["id"], "generation id"),
		totalCost: finite(data["total_cost"], "generation cost"),
		promptTokens: finite(data["tokens_prompt"], "generation prompt tokens"),
		completionTokens: finite(data["tokens_completion"], "generation completion tokens"),
		raw: data,
	};
}

export function parseOpenRouterAnalytics(rootValue: unknown): OpenRouterAnalyticsResult {
	const root = contractRecord(rootValue, "analytics response");
	if (!Array.isArray(root["data"]) || !root["data"].every((row) => typeof row === "object" && row !== null && !Array.isArray(row))) {
		throw new Error("OpenRouter analytics data schema changed");
	}
	const metadata = contractRecord(root["metadata"], "analytics metadata");
	if (typeof metadata["truncated"] !== "boolean") throw new Error("OpenRouter analytics metadata schema changed");
	return { data: root["data"] as Array<Record<string, unknown>>, metadata: metadata as OpenRouterAnalyticsResult["metadata"] };
}
