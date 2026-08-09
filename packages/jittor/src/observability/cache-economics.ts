import {
	CACHE_ECONOMICS_LOSS_CORRELATION_WINDOW_MS,
	CACHE_ECONOMICS_MAX_MISSED_OPPORTUNITIES,
	CACHE_ECONOMICS_MAX_MODEL_GROUPS,
	CATALOG_PRICE_TOKEN_UNIT,
} from "../constants.ts";
import type { ContextPrefixResetReason } from "./context-delta.ts";
import type { StoredMetricObservation } from "./metric.ts";

/**
 * How much authority a cache-cost figure carries. `provider-reported` comes straight from the
 * provider's own per-turn `usage.cost.*` breakdown (or is trivially true, e.g. zero tokens cost
 * zero dollars); `catalog-estimate` is derived from models.dev catalog pricing when the provider
 * never itemizes cache cost; `unknown` means neither exists and the figure must stay null rather
 * than being fabricated.
 */
export type CacheCostBasis = "provider-reported" | "catalog-estimate" | "unknown";

/** Flat (non-tiered, non-context-length-aware) per-token-million catalog prices for one provider/model. */
export interface CacheEconomicsPricing {
	input?: number;
	cacheRead?: number;
	cacheWrite?: number;
}

/** Best-effort catalog pricing lookup; returns null when the catalog has no snapshot or no matching model, never throws. */
export interface CacheEconomicsPricingLookup {
	priceFor(provider: string, model: string): CacheEconomicsPricing | null;
}

export interface CacheEconomicsModelSummary {
	provider: string;
	model: string;
	inputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	/** Real dollars actually paid for cache reads in-window, or a catalog estimate, or null when neither is known. */
	cacheReadCostUsd: number | null;
	cacheReadCostBasis: CacheCostBasis;
	/** Real dollars actually paid for cache writes in-window, or a catalog estimate, or null when neither is known. */
	cacheWriteCostUsd: number | null;
	cacheWriteCostBasis: CacheCostBasis;
	/** sum(provider-reported input cost) / sum(input tokens) within the window -- a real per-token rate derived only from provider-reported dollar/token figures, not a catalog guess. Null when the provider never reported itemized input cost in-window. */
	effectiveInputRateUsdPerToken: number | null;
	/** What the cache-read tokens would have cost had they been billed as ordinary input, at the best available rate. */
	counterfactualNoCacheCostUsd: number | null;
	counterfactualBasis: CacheCostBasis;
	/** counterfactualNoCacheCostUsd minus the actual cache-read cost -- the real economic benefit of caching, when derivable. */
	savingsUsd: number | null;
	/** The premium actually paid for cache-write tokens over what plain input billing would have cost. */
	cacheWritePremiumUsd: number | null;
	/** How many cache-read tokens, at the observed/estimated read rate, would be needed to offset the write premium. Zero when no premium was paid; null when undeterminable. */
	breakEvenReadTokens: number | null;
	/** Whether observed savings already met or exceeded the write premium. Null when there was no cache write to evaluate, or the comparison is undeterminable. */
	paybackAchieved: boolean | null;
}

/** A context-prefix reset (session/provider/model change) followed shortly by a same-session cache-write is *evidence*, not proof, that the reset forced a cache rewrite -- correlation, never asserted causality. */
export interface CacheEconomicsMissedOpportunity {
	sessionId: string;
	occurredAt: number;
	resetReason: Exclude<ContextPrefixResetReason, null>;
	cacheWriteTokens: number;
	cacheWriteCostUsd: number | null;
	note: string;
}

export interface CacheEconomicsSummary {
	since: number;
	until: number;
	models: CacheEconomicsModelSummary[];
	missedOpportunities: CacheEconomicsMissedOpportunity[];
	/** True when either the model-group list or the missed-opportunity list was cut off at its bound. */
	truncated: boolean;
}

export interface CacheEconomicsSummaryOptions {
	since: number;
	until: number;
}

const RESET_REASONS = new Set<Exclude<ContextPrefixResetReason, null>>(["initial", "session-changed", "provider-changed", "model-changed"]);

function attributeText(attributes: Record<string, unknown>, key: string): string {
	return typeof attributes[key] === "string" && attributes[key].length > 0 ? (attributes[key] as string) : "unknown";
}

interface ModelAccumulator {
	provider: string;
	model: string;
	inputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	inputCostUsd: number;
	sawInputCost: boolean;
	cacheReadCostUsd: number;
	sawCacheReadCost: boolean;
	cacheWriteCostUsd: number;
	sawCacheWriteCost: boolean;
}

function accumulatorFor(byKey: Map<string, ModelAccumulator>, provider: string, model: string): ModelAccumulator {
	const key = `${provider}\u0000${model}`;
	const existing = byKey.get(key);
	if (existing) return existing;
	const created: ModelAccumulator = {
		provider,
		model,
		inputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		inputCostUsd: 0,
		sawInputCost: false,
		cacheReadCostUsd: 0,
		sawCacheReadCost: false,
		cacheWriteCostUsd: 0,
		sawCacheWriteCost: false,
	};
	byKey.set(key, created);
	return created;
}

function combineBasis(left: CacheCostBasis, right: CacheCostBasis): CacheCostBasis {
	if (left === "unknown" || right === "unknown") return "unknown";
	if (left === "catalog-estimate" || right === "catalog-estimate") return "catalog-estimate";
	return "provider-reported";
}

/** provider-reported-in-window rate when available, else a catalog estimate, else null -- with the basis that produced it. */
function inputRate(accumulator: ModelAccumulator, pricing: CacheEconomicsPricingLookup): { rate: number | null; basis: CacheCostBasis } {
	if (accumulator.sawInputCost && accumulator.inputTokens > 0) {
		return { rate: accumulator.inputCostUsd / accumulator.inputTokens, basis: "provider-reported" };
	}
	const price = pricing.priceFor(accumulator.provider, accumulator.model)?.input;
	if (price !== undefined) return { rate: price / CATALOG_PRICE_TOKEN_UNIT, basis: "catalog-estimate" };
	return { rate: null, basis: "unknown" };
}

function actualCost(
	tokens: number,
	sawCost: boolean,
	costUsd: number,
	catalogPricePerMillion: number | undefined,
): { costUsd: number | null; basis: CacheCostBasis } {
	if (tokens === 0) return { costUsd: 0, basis: "provider-reported" };
	if (sawCost) return { costUsd, basis: "provider-reported" };
	if (catalogPricePerMillion !== undefined)
		return { costUsd: (tokens * catalogPricePerMillion) / CATALOG_PRICE_TOKEN_UNIT, basis: "catalog-estimate" };
	return { costUsd: null, basis: "unknown" };
}

function summarizeModel(accumulator: ModelAccumulator, pricing: CacheEconomicsPricingLookup): CacheEconomicsModelSummary {
	const catalogPrices = pricing.priceFor(accumulator.provider, accumulator.model);
	const { rate: baselineRate, basis: baselineBasis } = inputRate(accumulator, pricing);
	const read = actualCost(
		accumulator.cacheReadTokens,
		accumulator.sawCacheReadCost,
		accumulator.cacheReadCostUsd,
		catalogPrices?.cacheRead,
	);
	const write = actualCost(
		accumulator.cacheWriteTokens,
		accumulator.sawCacheWriteCost,
		accumulator.cacheWriteCostUsd,
		catalogPrices?.cacheWrite,
	);

	let counterfactualNoCacheCostUsd: number | null = null;
	let counterfactualBasis: CacheCostBasis = "unknown";
	if (accumulator.cacheReadTokens === 0) {
		counterfactualNoCacheCostUsd = 0;
		counterfactualBasis = "provider-reported";
	} else if (baselineRate !== null) {
		counterfactualNoCacheCostUsd = accumulator.cacheReadTokens * baselineRate;
		counterfactualBasis = baselineBasis;
	}

	const savingsUsd = counterfactualNoCacheCostUsd !== null && read.costUsd !== null ? counterfactualNoCacheCostUsd - read.costUsd : null;

	let cacheWritePremiumUsd: number | null = null;
	if (accumulator.cacheWriteTokens === 0) {
		cacheWritePremiumUsd = 0;
	} else if (baselineRate !== null && write.costUsd !== null) {
		cacheWritePremiumUsd = write.costUsd - accumulator.cacheWriteTokens * baselineRate;
	}

	let breakEvenReadTokens: number | null = null;
	if (accumulator.cacheWriteTokens === 0) {
		breakEvenReadTokens = 0;
	} else if (cacheWritePremiumUsd !== null && baselineRate !== null) {
		const readRate =
			accumulator.cacheReadTokens > 0 && read.costUsd !== null
				? read.costUsd / accumulator.cacheReadTokens
				: (catalogPrices?.cacheRead ?? undefined) !== undefined
					? catalogPrices!.cacheRead! / CATALOG_PRICE_TOKEN_UNIT
					: null;
		const perTokenSavings = readRate !== null ? baselineRate - readRate : null;
		if (cacheWritePremiumUsd <= 0) breakEvenReadTokens = 0;
		else if (perTokenSavings !== null && perTokenSavings > 0) breakEvenReadTokens = Math.ceil(cacheWritePremiumUsd / perTokenSavings);
	}

	const paybackAchieved =
		accumulator.cacheWriteTokens === 0
			? null
			: savingsUsd !== null && cacheWritePremiumUsd !== null
				? savingsUsd >= cacheWritePremiumUsd
				: null;

	return {
		provider: accumulator.provider,
		model: accumulator.model,
		inputTokens: accumulator.inputTokens,
		cacheReadTokens: accumulator.cacheReadTokens,
		cacheWriteTokens: accumulator.cacheWriteTokens,
		cacheReadCostUsd: read.costUsd,
		cacheReadCostBasis: read.basis,
		cacheWriteCostUsd: write.costUsd,
		cacheWriteCostBasis: write.basis,
		effectiveInputRateUsdPerToken: accumulator.sawInputCost && accumulator.inputTokens > 0 ? baselineRate : null,
		counterfactualNoCacheCostUsd,
		counterfactualBasis: accumulator.cacheReadTokens === 0 ? "provider-reported" : combineBasis(baselineBasis, counterfactualBasis),
		savingsUsd,
		cacheWritePremiumUsd,
		breakEvenReadTokens,
		paybackAchieved,
	};
}

interface ResetEvent {
	sessionId: string;
	occurredAt: number;
	resetReason: Exclude<ContextPrefixResetReason, null>;
}

function resetEventFromRow(row: StoredMetricObservation): ResetEvent | null {
	const resetReason = row.attributes.resetReason;
	if (resetReason === null || resetReason === undefined || !RESET_REASONS.has(resetReason as Exclude<ContextPrefixResetReason, null>))
		return null;
	if (typeof row.scope !== "string" || row.scope.length === 0) return null;
	return { sessionId: row.scope, occurredAt: row.observedAt, resetReason: resetReason as Exclude<ContextPrefixResetReason, null> };
}

function findMissedOpportunities(
	usageRows: StoredMetricObservation[],
	snapshotRows: StoredMetricObservation[],
): CacheEconomicsMissedOpportunity[] {
	const resets = snapshotRows
		.filter((row) => row.source === "pi-context-snapshot" && row.metric === "snapshot")
		.map(resetEventFromRow)
		.filter((event): event is ResetEvent => event !== null);
	if (resets.length === 0) return [];
	const writes = usageRows.filter(
		(row) => row.source === "pi" && row.metric === "cache-write-tokens" && typeof row.value === "number" && row.value > 0,
	);
	const found: CacheEconomicsMissedOpportunity[] = [];
	for (const reset of resets) {
		const match = writes
			.filter((row) => attributeText(row.attributes, "sessionId") === reset.sessionId)
			.filter(
				(row) => row.observedAt >= reset.occurredAt && row.observedAt - reset.occurredAt <= CACHE_ECONOMICS_LOSS_CORRELATION_WINDOW_MS,
			)
			.sort((left, right) => left.observedAt - right.observedAt)[0];
		if (!match) continue;
		const costRow = usageRows.find(
			(row) =>
				row.source === "pi" &&
				row.metric === "cache-write-cost" &&
				attributeText(row.attributes, "sessionId") === reset.sessionId &&
				row.observedAt === match.observedAt,
		);
		found.push({
			sessionId: reset.sessionId,
			occurredAt: match.observedAt,
			resetReason: reset.resetReason,
			cacheWriteTokens: match.value as number,
			cacheWriteCostUsd: typeof costRow?.value === "number" ? costRow.value : null,
			note: `Candidate missed-cache opportunity: a ${reset.resetReason} context-prefix reset was followed by a cache write in the same session within the correlation window. This is a correlated pattern, not a proven cause.`,
		});
	}
	return found;
}

/**
 * Pure aggregation over already-fetched, already-bounded rows -- the operation layer owns querying
 * MetricStore and the model catalog; this function only ever combines what it is given. Every
 * derived (non-trivial) dollar figure is explicitly basis-tagged; nothing is fabricated when
 * evidence is absent.
 */
export function buildCacheEconomicsSummary(
	usageRows: StoredMetricObservation[],
	snapshotRows: StoredMetricObservation[],
	pricing: CacheEconomicsPricingLookup,
	options: CacheEconomicsSummaryOptions,
): CacheEconomicsSummary {
	const byModel = new Map<string, ModelAccumulator>();
	let modelGroupsTruncated = false;
	for (const row of usageRows) {
		if (row.source !== "pi" || typeof row.value !== "number" || !Number.isFinite(row.value) || row.value < 0) continue;
		if (row.observedAt < options.since || row.observedAt > options.until) continue;
		const provider = attributeText(row.attributes, "provider");
		const model = attributeText(row.attributes, "model");
		const key = `${provider}\u0000${model}`;
		if (!byModel.has(key) && byModel.size >= CACHE_ECONOMICS_MAX_MODEL_GROUPS) {
			modelGroupsTruncated = true;
			continue;
		}
		const accumulator = accumulatorFor(byModel, provider, model);
		if (row.metric === "input-tokens" && row.unit === "tokens") accumulator.inputTokens += row.value;
		else if (row.metric === "cache-read-tokens" && row.unit === "tokens") accumulator.cacheReadTokens += row.value;
		else if (row.metric === "cache-write-tokens" && row.unit === "tokens") accumulator.cacheWriteTokens += row.value;
		else if (row.metric === "input-cost" && row.unit === "usd") {
			accumulator.inputCostUsd += row.value;
			accumulator.sawInputCost = true;
		} else if (row.metric === "cache-read-cost" && row.unit === "usd") {
			accumulator.cacheReadCostUsd += row.value;
			accumulator.sawCacheReadCost = true;
		} else if (row.metric === "cache-write-cost" && row.unit === "usd") {
			accumulator.cacheWriteCostUsd += row.value;
			accumulator.sawCacheWriteCost = true;
		}
	}
	const models = [...byModel.values()]
		.map((accumulator) => summarizeModel(accumulator, pricing))
		.sort(
			(left, right) =>
				right.cacheReadTokens + right.cacheWriteTokens - (left.cacheReadTokens + left.cacheWriteTokens) ||
				left.model.localeCompare(right.model),
		);

	const allMissed = findMissedOpportunities(
		usageRows.filter((row) => row.observedAt >= options.since && row.observedAt <= options.until),
		snapshotRows.filter((row) => row.observedAt >= options.since && row.observedAt <= options.until),
	);
	const missedTruncated = allMissed.length > CACHE_ECONOMICS_MAX_MISSED_OPPORTUNITIES;
	const missedOpportunities = allMissed.slice(0, CACHE_ECONOMICS_MAX_MISSED_OPPORTUNITIES);

	return {
		since: options.since,
		until: options.until,
		models,
		missedOpportunities,
		truncated: modelGroupsTruncated || missedTruncated,
	};
}
