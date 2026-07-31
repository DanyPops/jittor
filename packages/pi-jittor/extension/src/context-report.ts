import { buildContextRows, type ContextSegment as MalevichContextSegment } from "malevich-tui-components";
import type { ContextSegment } from "@danypops/jittor";

export interface ContextReportUsage {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

/** Bounds how many items render per segment in the plain-text fallback -- a notify-mode report is a scan-at-a-glance summary, not a full dump (the interactive TUI view has no such cap, since it scrolls). */
const MAX_ITEMS_PER_SEGMENT_LINE = 5;

function formatTokens(tokens: number): string {
	return tokens >= 1_000 ? `${(tokens / 1_000).toFixed(1)}k` : String(tokens);
}

/** Malevich's row builder is confidence-unaware (it's a generic segment/item shape); folding the tier into the label is how it survives into the rendered row text, e.g. "Active Rules [exact-cooperative]". */
function withConfidenceLabel(segment: ContextSegment): MalevichContextSegment {
	const items = [...(segment.items ?? [])].sort((left, right) => right.estimatedTokens - left.estimatedTokens).slice(0, MAX_ITEMS_PER_SEGMENT_LINE);
	return { key: segment.key, label: `${segment.label} [${segment.confidence}]`, estimatedTokens: segment.estimatedTokens, items };
}

/**
 * Plain-text Context Hub report (non-TUI fallback): real provider-reported usage first (never a
 * character-based estimate when real usage is available, matching Papyrus's own real-vs-estimate
 * honesty accounting), then every segment heaviest-first -- Malevich's buildContextRows renders
 * segments in the order given, so sorting by weight is this function's own policy, not Malevich's.
 */
export function buildContextReport(segments: readonly ContextSegment[], usage: ContextReportUsage | undefined): string {
	const lines: string[] = [];
	if (usage?.tokens !== null && usage?.tokens !== undefined) {
		const percent = usage.percent !== null && usage.percent !== undefined ? ` (${usage.percent.toFixed(1)}%)` : "";
		lines.push(`Real usage: ${formatTokens(usage.tokens)} / ${formatTokens(usage.contextWindow)} tokens${percent}`);
	} else {
		lines.push("Real usage: not yet reported -- sizes below are estimates only");
	}
	const sorted = [...segments].sort((left, right) => right.estimatedTokens - left.estimatedTokens).map(withConfidenceLabel);
	const rows = buildContextRows(sorted, usage?.tokens ?? undefined);
	if (rows.length === 0) {
		lines.push("", "(no segments observed yet)");
		return lines.join("\n");
	}
	lines.push("");
	for (const row of rows) lines.push(row.isHeader ? row.text : `${"  ".repeat(row.depth)}${row.text}`);
	return lines.join("\n");
}
