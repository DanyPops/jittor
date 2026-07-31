import type { ContextSegment, ContextSegmentItem } from "@danypops/jittor";

export interface ContextReportUsage {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

/** Bounds how many items render per segment -- a report is a scan-at-a-glance summary, not a full dump. */
const MAX_ITEMS_PER_SEGMENT_LINE = 5;

function formatTokens(tokens: number): string {
	return tokens >= 1_000 ? `${(tokens / 1_000).toFixed(1)}k` : String(tokens);
}

function topItems(items: ContextSegmentItem[] | undefined): ContextSegmentItem[] {
	return [...(items ?? [])].sort((left, right) => right.estimatedTokens - left.estimatedTokens).slice(0, MAX_ITEMS_PER_SEGMENT_LINE);
}

/**
 * Plain-text Context Hub report: real provider-reported usage first (never a character-based
 * estimate when real usage is available, matching Papyrus's own real-vs-estimate honesty
 * accounting), then every segment heaviest-first with an explicit confidence tag
 * (exact-tool/exact-cooperative/correlated/audited) so a reader never mistakes one attribution
 * tier's certainty for another's.
 */
export function buildContextReport(segments: readonly ContextSegment[], usage: ContextReportUsage | undefined): string {
	const lines: string[] = [];
	if (usage?.tokens !== null && usage?.tokens !== undefined) {
		const percent = usage.percent !== null && usage.percent !== undefined ? ` (${usage.percent.toFixed(1)}%)` : "";
		lines.push(`Real usage: ${formatTokens(usage.tokens)} / ${formatTokens(usage.contextWindow)} tokens${percent}`);
	} else {
		lines.push("Real usage: not yet reported -- sizes below are estimates only");
	}
	const sorted = [...segments].sort((left, right) => right.estimatedTokens - left.estimatedTokens);
	if (sorted.length === 0) {
		lines.push("", "(no segments observed yet)");
		return lines.join("\n");
	}
	lines.push("");
	for (const segment of sorted) {
		lines.push(`${segment.label} — ${formatTokens(segment.estimatedTokens)} tok [${segment.confidence}]`);
		for (const item of topItems(segment.items)) lines.push(`  ${formatTokens(item.estimatedTokens)} tok  ${item.label}`);
	}
	return lines.join("\n");
}
