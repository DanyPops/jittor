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

/** Flat (already tier-resolved, if applicable) per-token-million catalog prices for one provider/model at one particular request size. */
export interface CacheEconomicsPricing {
	input?: number;
	cacheRead?: number;
	cacheWrite?: number;
}

/**
 * Best-effort catalog pricing lookup; returns null when the catalog has no snapshot or no
 * matching model, never throws. `contextSizeTokens` is the specific request/run's own real size
 * (input + cache-read + cache-write tokens) -- the lookup is free to resolve a tiered or
 * long-context ("contextOver200k") price against it instead of a single flat rate; the domain
 * layer here never assumes which it did.
 */
export interface CacheEconomicsPricingLookup {
	priceFor(provider: string, model: string, contextSizeTokens: number): CacheEconomicsPricing | null;
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
	/** How many cache-read tokens, at the observed/estimated read rate, would be needed to offset the write premium. Zero when no premium was paid; null when undeterminable. An aggregate approximation over the whole window/model, not resolved per run. */
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

/** A turn's own runId when present, else its shared observedAt timestamp -- rows recorded before runId tagging existed still group correctly as long as they were sent (and therefore timestamped) together. */
function runKeyFor(row: StoredMetricObservation): string {
	const runId = row.attributes.runId;
	if (typeof runId === "string" && runId.length > 0) return runId;
	return `observedAt:${row.observedAt}`;
}

/** One turn's own token/cost totals -- the unit pricing (including any tiered/long-context catalog rate) is resolved against. */
interface RunAccumulator {
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

function newRunAccumulator(provider: string, model: string): RunAccumulator {
	return {
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
}

function combineBasis(left: CacheCostBasis, right: CacheCostBasis): CacheCostBasis {
	if (left === "unknown" || right === "unknown") return "unknown";
	if (left === "catalog-estimate" || right === "catalog-estimate") return "catalog-estimate";
	return "provider-reported";
}

/** Sums basis-tagged dollar amounts; a single unknown amount makes the whole sum unknown rather than silently partial. */
function combineDollarField(entries: Array<{ amount: number | null; basis: CacheCostBasis }>): {
	amount: number | null;
	basis: CacheCostBasis;
} {
	let total = 0;
	let basis: CacheCostBasis = "provider-reported";
	for (const entry of entries) {
		if (entry.amount === null) return { amount: null, basis: "unknown" };
		total += entry.amount;
		basis = combineBasis(basis, entry.basis);
	}
	return { amount: total, basis };
}

function combineNullableSum(values: Array<number | null>): number | null {
	let total = 0;
	for (const value of values) {
		if (value === null) return null;
		total += value;
	}
	return total;
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

interface RunPricingResult {
	inputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	inputCostUsd: number;
	sawInputCost: boolean;
	cacheReadCostUsd: number | null;
	cacheReadCostBasis: CacheCostBasis;
	cacheWriteCostUsd: number | null;
	cacheWriteCostBasis: CacheCostBasis;
	counterfactualNoCacheCostUsd: number | null;
	counterfactualBasis: CacheCostBasis;
	cacheWritePremiumUsd: number | null;
}

/**
 * Prices exactly one turn, against that turn's own real context size (input + cache-read +
 * cache-write tokens) -- the only level at which a tiered/long-context catalog price can honestly
 * be resolved. Never sums across turns; that happens once, afterward, in aggregateRuns.
 */
function priceRun(run: RunAccumulator, pricing: CacheEconomicsPricingLookup): RunPricingResult {
	const contextSizeTokens = run.inputTokens + run.cacheReadTokens + run.cacheWriteTokens;
	const catalogPrices = pricing.priceFor(run.provider, run.model, contextSizeTokens);
	const read = actualCost(run.cacheReadTokens, run.sawCacheReadCost, run.cacheReadCostUsd, catalogPrices?.cacheRead);
	const write = actualCost(run.cacheWriteTokens, run.sawCacheWriteCost, run.cacheWriteCostUsd, catalogPrices?.cacheWrite);

	let baselineRate: number | null = null;
	let baselineBasis: CacheCostBasis = "unknown";
	if (run.sawInputCost && run.inputTokens > 0) {
		baselineRate = run.inputCostUsd / run.inputTokens;
		baselineBasis = "provider-reported";
	} else if (catalogPrices?.input !== undefined) {
		baselineRate = catalogPrices.input / CATALOG_PRICE_TOKEN_UNIT;
		baselineBasis = "catalog-estimate";
	}

	let counterfactualNoCacheCostUsd: number | null = null;
	let counterfactualBasis: CacheCostBasis = "unknown";
	if (run.cacheReadTokens === 0) {
		counterfactualNoCacheCostUsd = 0;
		counterfactualBasis = "provider-reported";
	} else if (baselineRate !== null) {
		counterfactualNoCacheCostUsd = run.cacheReadTokens * baselineRate;
		counterfactualBasis = baselineBasis;
	}

	let cacheWritePremiumUsd: number | null = null;
	if (run.cacheWriteTokens === 0) cacheWritePremiumUsd = 0;
	else if (baselineRate !== null && write.costUsd !== null) cacheWritePremiumUsd = write.costUsd - run.cacheWriteTokens * baselineRate;

	return {
		inputTokens: run.inputTokens,
		cacheReadTokens: run.cacheReadTokens,
		cacheWriteTokens: run.cacheWriteTokens,
		inputCostUsd: run.inputCostUsd,
		sawInputCost: run.sawInputCost,
		cacheReadCostUsd: read.costUsd,
		cacheReadCostBasis: read.basis,
		cacheWriteCostUsd: write.costUsd,
		cacheWriteCostBasis: write.basis,
		counterfactualNoCacheCostUsd,
		counterfactualBasis: run.cacheReadTokens === 0 ? "provider-reported" : combineBasis(baselineBasis, counterfactualBasis),
		cacheWritePremiumUsd,
	};
}

/**
 * Sums already-run-priced dollar figures into one model's window totals, then derives
 * break-even/payback from those totals plus one whole-window catalog lookup -- an intentional,
 * documented approximation: unlike the dollar totals above (correctly tiered per run), a single
 * "how many more read tokens would it take" projection over a blended window has no one real
 * request size to resolve a tier against either.
 */
function aggregateRuns(
	provider: string,
	model: string,
	runs: RunPricingResult[],
	pricing: CacheEconomicsPricingLookup,
): CacheEconomicsModelSummary {
	const inputTokens = runs.reduce((sum, run) => sum + run.inputTokens, 0);
	const cacheReadTokens = runs.reduce((sum, run) => sum + run.cacheReadTokens, 0);
	const cacheWriteTokens = runs.reduce((sum, run) => sum + run.cacheWriteTokens, 0);
	const read = combineDollarField(runs.map((run) => ({ amount: run.cacheReadCostUsd, basis: run.cacheReadCostBasis })));
	const write = combineDollarField(runs.map((run) => ({ amount: run.cacheWriteCostUsd, basis: run.cacheWriteCostBasis })));
	const counterfactual = combineDollarField(
		runs.map((run) => ({ amount: run.counterfactualNoCacheCostUsd, basis: run.counterfactualBasis })),
	);
	const savingsUsd = counterfactual.amount !== null && read.amount !== null ? counterfactual.amount - read.amount : null;
	const cacheWritePremiumUsd = combineNullableSum(runs.map((run) => run.cacheWritePremiumUsd));

	const reportingRuns = runs.filter((run) => run.sawInputCost && run.inputTokens > 0);
	const effectiveInputRateUsdPerToken =
		reportingRuns.length > 0
			? reportingRuns.reduce((sum, run) => sum + run.inputCostUsd, 0) / reportingRuns.reduce((sum, run) => sum + run.inputTokens, 0)
			: null;

	let breakEvenReadTokens: number | null = null;
	if (cacheWriteTokens === 0) breakEvenReadTokens = 0;
	else if (cacheWritePremiumUsd !== null) {
		const catalogPrices = pricing.priceFor(provider, model, inputTokens + cacheReadTokens + cacheWriteTokens);
		const baselineRate =
			effectiveInputRateUsdPerToken ?? (catalogPrices?.input !== undefined ? catalogPrices.input / CATALOG_PRICE_TOKEN_UNIT : null);
		const readRate =
			cacheReadTokens > 0 && read.amount !== null
				? read.amount / cacheReadTokens
				: (catalogPrices?.cacheRead ?? undefined) !== undefined
					? catalogPrices!.cacheRead! / CATALOG_PRICE_TOKEN_UNIT
					: null;
		const perTokenSavings = baselineRate !== null && readRate !== null ? baselineRate - readRate : null;
		if (cacheWritePremiumUsd <= 0) breakEvenReadTokens = 0;
		else if (perTokenSavings !== null && perTokenSavings > 0) breakEvenReadTokens = Math.ceil(cacheWritePremiumUsd / perTokenSavings);
	}

	const paybackAchieved =
		cacheWriteTokens === 0 ? null : savingsUsd !== null && cacheWritePremiumUsd !== null ? savingsUsd >= cacheWritePremiumUsd : null;

	return {
		provider,
		model,
		inputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		cacheReadCostUsd: read.amount,
		cacheReadCostBasis: read.basis,
		cacheWriteCostUsd: write.amount,
		cacheWriteCostBasis: write.basis,
		effectiveInputRateUsdPerToken,
		counterfactualNoCacheCostUsd: counterfactual.amount,
		counterfactualBasis: counterfactual.basis,
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
 * MetricStore and the model catalog; this function only ever combines what it is given. Rows are
 * first grouped into per-turn runs (see runKeyFor) and priced against each run's own real context
 * size, so a tiered/long-context catalog price is resolved honestly instead of guessed against a
 * blended window-wide sum; run-level dollar figures are only summed together afterward. Every
 * derived (non-trivial) dollar figure is explicitly basis-tagged; nothing is fabricated when
 * evidence is absent.
 */
export function buildCacheEconomicsSummary(
	usageRows: StoredMetricObservation[],
	snapshotRows: StoredMetricObservation[],
	pricing: CacheEconomicsPricingLookup,
	options: CacheEconomicsSummaryOptions,
): CacheEconomicsSummary {
	const byRun = new Map<string, RunAccumulator>();
	const admittedModels = new Set<string>();
	let modelGroupsTruncated = false;
	for (const row of usageRows) {
		if (row.source !== "pi" || typeof row.value !== "number" || !Number.isFinite(row.value) || row.value < 0) continue;
		if (row.observedAt < options.since || row.observedAt > options.until) continue;
		const provider = attributeText(row.attributes, "provider");
		const model = attributeText(row.attributes, "model");
		const modelKey = `${provider}\u0000${model}`;
		if (!admittedModels.has(modelKey)) {
			if (admittedModels.size >= CACHE_ECONOMICS_MAX_MODEL_GROUPS) {
				modelGroupsTruncated = true;
				continue;
			}
			admittedModels.add(modelKey);
		}
		const runKey = `${modelKey}\u0000${runKeyFor(row)}`;
		const run = byRun.get(runKey) ?? newRunAccumulator(provider, model);
		byRun.set(runKey, run);
		if (row.metric === "input-tokens" && row.unit === "tokens") run.inputTokens += row.value;
		else if (row.metric === "cache-read-tokens" && row.unit === "tokens") run.cacheReadTokens += row.value;
		else if (row.metric === "cache-write-tokens" && row.unit === "tokens") run.cacheWriteTokens += row.value;
		else if (row.metric === "input-cost" && row.unit === "usd") {
			run.inputCostUsd += row.value;
			run.sawInputCost = true;
		} else if (row.metric === "cache-read-cost" && row.unit === "usd") {
			run.cacheReadCostUsd += row.value;
			run.sawCacheReadCost = true;
		} else if (row.metric === "cache-write-cost" && row.unit === "usd") {
			run.cacheWriteCostUsd += row.value;
			run.sawCacheWriteCost = true;
		}
	}

	const runsByModel = new Map<string, { provider: string; model: string; runs: RunPricingResult[] }>();
	for (const run of byRun.values()) {
		const modelKey = `${run.provider}\u0000${run.model}`;
		const priced = priceRun(run, pricing);
		const existing = runsByModel.get(modelKey);
		if (existing) existing.runs.push(priced);
		else runsByModel.set(modelKey, { provider: run.provider, model: run.model, runs: [priced] });
	}
	const models = [...runsByModel.values()]
		.map(({ provider, model, runs }) => aggregateRuns(provider, model, runs, pricing))
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
