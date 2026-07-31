import { buildContextRows, type ContextSegment as MalevichContextSegment } from "malevich-tui-components";
import type { ContextBreakdown } from "./context-breakdown.ts";
import type { ContextSegment } from "@danypops/jittor";

/** Bounds how many items render per segment in the plain-text fallback -- a notify-mode report is a scan-at-a-glance summary, not a full dump (the interactive TUI view has no such cap, since it scrolls). */
const MAX_ITEMS_PER_SEGMENT_LINE = 5;

function formatTokens(tokens: number): string {
	return tokens >= 1_000 ? `${(tokens / 1_000).toFixed(1)}k` : String(tokens);
}

function percentOf(part: number, whole: number): string {
	return whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : "—";
}

/** Malevich's row builder is confidence-unaware (it's a generic segment/item shape); folding the tier into the label is how it survives into the rendered row text, e.g. "Active Rules [exact-cooperative]". */
function withConfidenceLabel(segment: ContextSegment): MalevichContextSegment {
	const items = [...(segment.items ?? [])].sort((left, right) => right.estimatedTokens - left.estimatedTokens).slice(0, MAX_ITEMS_PER_SEGMENT_LINE);
	return { key: segment.key, label: `${segment.label} [${segment.confidence}]`, estimatedTokens: segment.estimatedTokens, items, unknown: segment.unknown };
}

/**
 * Plain-text Context Hub report (non-TUI fallback): real usage against the model's effective
 * (reserve-adjusted) budget first -- matching Papyrus's own real-vs-estimate honesty accounting
 * -- an explicit overshoot warning when the known segments' estimates exceed the real total, then
 * every segment heaviest-first. Malevich's buildContextRows renders segments in the order given,
 * so sorting by weight is this function's own policy, not Malevich's.
 */
export function buildContextReport(breakdown: ContextBreakdown): string {
	const lines: string[] = [];
	if (breakdown.totalTokens !== null && breakdown.effectiveBudget !== null) {
		lines.push(`Real usage: ${formatTokens(breakdown.totalTokens)} / ${formatTokens(breakdown.effectiveBudget)} tokens (${percentOf(breakdown.totalTokens, breakdown.effectiveBudget)} of usable budget)`);
	} else if (breakdown.totalTokens !== null) {
		lines.push(`Real usage: ${formatTokens(breakdown.totalTokens)} tokens (model context window unknown)`);
	} else {
		lines.push("Real usage: not yet reported -- sizes below are estimates only");
	}
	if (breakdown.overshootTokens > 0) lines.push(`Estimates exceed real total by ~${breakdown.overshootTokens} tok -- sizes below are approximate, not exact`);

	const sorted = [...breakdown.segments].sort((left, right) => right.estimatedTokens - left.estimatedTokens).map(withConfidenceLabel);
	const rows = buildContextRows(sorted, breakdown.totalTokens ?? undefined);
	if (rows.length === 0) {
		lines.push("", "(no segments observed yet)");
		return lines.join("\n");
	}
	lines.push("");
	for (const row of rows) lines.push(row.isHeader ? row.text : `${"  ".repeat(row.depth)}${row.text}`);
	return lines.join("\n");
}
