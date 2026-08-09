import type { CacheEconomicsModelSummary, CacheEconomicsSummary } from "@danypops/jittor";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export interface CacheEconomicsPanelClient {
	call(operation: string, input: unknown): Promise<any>;
}

function formatUsd(amount: number): string {
	return `$${amount.toFixed(Math.abs(amount) < 0.01 && amount !== 0 ? 4 : 2)}`;
}

function costField(amountUsd: number | null, basis: "provider-reported" | "catalog-estimate" | "unknown"): string {
	if (amountUsd === null) return "unknown";
	return basis === "catalog-estimate" ? `${formatUsd(amountUsd)} (est.)` : formatUsd(amountUsd);
}

function modelLine(model: CacheEconomicsModelSummary): string {
	const payback = model.paybackAchieved === null ? "n/a" : model.paybackAchieved ? "yes" : "not yet";
	return [
		`${model.provider}/${model.model}:`,
		`read ${model.cacheReadTokens.toLocaleString()} tok (${costField(model.cacheReadCostUsd, model.cacheReadCostBasis)})`,
		`write ${model.cacheWriteTokens.toLocaleString()} tok (${costField(model.cacheWriteCostUsd, model.cacheWriteCostBasis)})`,
		`savings ${model.savingsUsd === null ? "unknown" : formatUsd(model.savingsUsd)}`,
		`payback ${payback}`,
	].join(" · ");
}

/** Plain multi-line text, shared by TUI notify and non-TUI notify -- a full interactive panel is deferred; this already satisfies "bounded query plus Pi presentation" without a new widget. */
export function renderCacheEconomicsView(summary: CacheEconomicsSummary): string[] {
	const lines = [
		`Cache economics (${new Date(summary.since).toISOString().slice(0, 10)} .. ${new Date(summary.until).toISOString().slice(0, 10)})${summary.truncated ? " -- query limit reached, totals are a lower bound" : ""}`,
	];
	if (summary.models.length === 0) lines.push("No cache activity recorded in this window.");
	else lines.push(...summary.models.map((model) => `- ${modelLine(model)}`));
	if (summary.missedOpportunities.length > 0) {
		lines.push(`Candidate missed-cache opportunities: ${summary.missedOpportunities.length}`);
		for (const candidate of summary.missedOpportunities.slice(0, 10)) {
			lines.push(
				`- session ${candidate.sessionId}: ${candidate.resetReason} reset, then ${candidate.cacheWriteTokens.toLocaleString()} cache-write tok${candidate.cacheWriteCostUsd === null ? "" : ` (${formatUsd(candidate.cacheWriteCostUsd)})`}`,
			);
		}
	}
	return lines;
}

export async function showCacheEconomicsView(
	ctx: ExtensionCommandContext,
	client: CacheEconomicsPanelClient,
	windowMs: number,
	now: () => number = Date.now,
): Promise<void> {
	const until = now();
	const since = Math.max(0, until - windowMs);
	const summary = (await client.call("cache.economics", { since, until })) as CacheEconomicsSummary;
	ctx.ui.notify(renderCacheEconomicsView(summary).join("\n"), "info");
}
