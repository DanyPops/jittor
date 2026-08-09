import type { CacheEconomicsModelSummary, CacheEconomicsSummary } from "../observability/cache-economics.ts";
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

function formatModelLine(model: CacheEconomicsModelSummary): string {
	const payback = model.paybackAchieved === null ? "n/a" : model.paybackAchieved ? "yes" : "not yet";
	return [
		`- ${humanField(model.provider)}/${humanField(model.model)}:`,
		`read ${model.cacheReadTokens.toLocaleString()} tok (${formatCostField(model.cacheReadCostUsd, model.cacheReadCostBasis)})`,
		`write ${model.cacheWriteTokens.toLocaleString()} tok (${formatCostField(model.cacheWriteCostUsd, model.cacheWriteCostBasis)})`,
		`savings ${model.savingsUsd === null ? "unknown" : formatUsdAmount(model.savingsUsd)}`,
		`premium ${model.cacheWritePremiumUsd === null ? "unknown" : formatUsdAmount(model.cacheWritePremiumUsd)}`,
		`break-even ${model.breakEvenReadTokens === null ? "unknown" : `${model.breakEvenReadTokens.toLocaleString()} tok`}`,
		`payback ${payback}`,
	].join(" · ");
}

export function formatCacheEconomics(summary: CacheEconomicsSummary): string {
	const lines = [
		`Cache economics: ${summary.models.length.toLocaleString()} model(s)${summary.truncated ? " (query limit reached; totals are a lower bound)" : ""}`,
		...summary.models.map(formatModelLine),
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
