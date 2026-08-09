import type {
	CacheEconomicsAggregateTotals,
	CacheEconomicsModelSummary,
	CacheEconomicsStablePrefixPoint,
	CacheEconomicsSummary,
	CacheEconomicsTaskSummary,
	CacheEconomicsUnattributedActivity,
} from "../observability/cache-economics.ts";
import { type CliDependencies, callAndPrint, humanField } from "./support.ts";

export const CACHE_USAGE_LINES = ["  cache economics --since <ms> --until <ms> [--json]"];

interface CacheEconomicsArgs {
	since: number;
	until: number;
	json: boolean;
}

function parseCacheArgs(action: string | undefined, args: string[]): CacheEconomicsArgs | null {
	if (action !== "economics") return null;
	let json = false;
	let since: number | undefined;
	let until: number | undefined;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--json") {
			json = true;
			continue;
		}
		if (argument !== "--since" && argument !== "--until") return null;
		const raw = args[++index];
		const value = raw === undefined ? Number.NaN : Number(raw);
		if (!Number.isSafeInteger(value) || value < 0) return null;
		if (argument === "--since") since = value;
		else until = value;
	}
	if (since === undefined || until === undefined || until < since) return null;
	return { since, until, json };
}

function formatUsdAmount(amount: number): string {
	return `$${amount.toFixed(Math.abs(amount) < 0.01 && amount !== 0 ? 4 : 2)}`;
}

function basisSuffix(basis: "provider-reported" | "catalog-estimate" | "unknown"): string {
	return basis === "provider-reported" ? "" : basis === "catalog-estimate" ? " (catalog estimate)" : "";
}

function formatCostField(amountUsd: number | null, basis: "provider-reported" | "catalog-estimate" | "unknown"): string {
	return amountUsd === null ? "unknown" : `${formatUsdAmount(amountUsd)}${basisSuffix(basis)}`;
}

function formatAggregateFields(totals: CacheEconomicsAggregateTotals): string {
	const payback = totals.paybackAchieved === null ? "n/a" : totals.paybackAchieved ? "yes" : "not yet";
	return [
		`read ${totals.cacheReadTokens.toLocaleString()} tok (${formatCostField(totals.cacheReadCostUsd, totals.cacheReadCostBasis)})`,
		`write ${totals.cacheWriteTokens.toLocaleString()} tok (${formatCostField(totals.cacheWriteCostUsd, totals.cacheWriteCostBasis)})`,
		`savings ${totals.savingsUsd === null ? "unknown" : formatUsdAmount(totals.savingsUsd)}`,
		`premium ${totals.cacheWritePremiumUsd === null ? "unknown" : formatUsdAmount(totals.cacheWritePremiumUsd)}`,
		`break-even ${totals.breakEvenReadTokens === null ? "unknown" : `${totals.breakEvenReadTokens.toLocaleString()} tok`}`,
		`payback ${payback}`,
	].join(" · ");
}

function formatFreshnessSuffix(catalogFreshness: "fresh" | "stale" | null): string {
	return catalogFreshness === "stale" ? " (stale catalog snapshot used for the estimate(s) above)" : "";
}

function formatModelLine(model: CacheEconomicsModelSummary): string {
	return `- ${humanField(model.provider)}/${humanField(model.model)}: ${formatAggregateFields(model)}${formatFreshnessSuffix(model.catalogFreshness)}`;
}

function formatTaskLine(task: CacheEconomicsTaskSummary): string {
	return `- ${humanField(task.taskId)}: ${formatAggregateFields(task)}${formatFreshnessSuffix(task.catalogFreshness)}`;
}

function formatUnattributedLine(activity: CacheEconomicsUnattributedActivity): string {
	return [
		`Unattributed cache activity (no Papyrus task focused):`,
		`read ${activity.cacheReadTokens.toLocaleString()} tok (${formatCostField(activity.cacheReadCostUsd, activity.cacheReadCostBasis)})`,
		`write ${activity.cacheWriteTokens.toLocaleString()} tok (${formatCostField(activity.cacheWriteCostUsd, activity.cacheWriteCostBasis)})`,
	].join(" · ");
}

function formatChurnPoint(point: CacheEconomicsStablePrefixPoint): string {
	return `- ${new Date(point.observedAt).toISOString()} session ${humanField(point.sessionId)}: ${point.stablePrefixTokens.toLocaleString()} tok${point.resetReason === null ? "" : ` (${point.resetReason} reset)`}`;
}

export function formatCacheEconomics(summary: CacheEconomicsSummary): string {
	const lines = [
		`Cache economics: ${summary.models.length.toLocaleString()} model(s)${summary.truncated ? " (query limit reached; totals are a lower bound)" : ""}`,
		...summary.models.map(formatModelLine),
		`By task: ${summary.tasks.length.toLocaleString()} task(s)`,
		...summary.tasks.map(formatTaskLine),
		formatUnattributedLine(summary.unattributedCacheActivity),
		...(summary.stablePrefixChurn.length > 0
			? [
					`Stable-prefix churn (${summary.stablePrefixChurn.length.toLocaleString()} snapshot(s), oldest first):`,
					...summary.stablePrefixChurn.map(formatChurnPoint),
				]
			: []),
		`Candidate missed-cache opportunities: ${summary.missedOpportunities.length.toLocaleString()}`,
		...summary.missedOpportunities.map(
			(candidate) =>
				`- session ${humanField(candidate.sessionId)}: ${candidate.resetReason} reset, then ${candidate.cacheWriteTokens.toLocaleString()} cache-write tok${candidate.cacheWriteCostUsd === null ? "" : ` (${formatUsdAmount(candidate.cacheWriteCostUsd)})`} -- ${candidate.note}`,
		),
	];
	return lines.join("\n");
}

export async function runCacheCommand(
	action: string | undefined,
	rest: string[],
	deps: CliDependencies,
	usage: () => number,
): Promise<number> {
	const parsed = parseCacheArgs(action, rest);
	if (!parsed) return usage();
	return callAndPrint(deps, "cache.economics", { since: parsed.since, until: parsed.until }, parsed.json, formatCacheEconomics);
}
