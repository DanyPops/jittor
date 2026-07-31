import type { ExtensionCommandContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import { buildContextRows, renderContextRowLines, renderContextUsageBar, type ContextBarTheme, type ContextRow, type ContextRowsTheme, type ContextSegment as MalevichContextSegment } from "malevich-tui-components";
import type { ContextSegment } from "@danypops/jittor";
import type { ContextBreakdown } from "./context-breakdown.ts";
import { buildContextReport } from "./context-report.ts";

const VISIBLE_ROWS = 24;

/**
 * A dynamically-contributed segment set (any string key from any extension, not a fixed enum)
 * can't use a hardcoded per-key color map the way Papyrus's own ContextViewport did for its
 * fixed seven segments -- this cycles a small categorical palette keyed by a stable hash of the
 * segment key, so the same key always renders the same color within one process without needing
 * every possible contributor's key to be known in advance.
 */
const PALETTE: ThemeColor[] = ["accent", "success", "syntaxFunction", "warning", "syntaxKeyword", "syntaxType", "muted"];

function paletteColor(key: string): ThemeColor {
	let hash = 0;
	for (let index = 0; index < key.length; index += 1) hash = (hash * 31 + key.charCodeAt(index)) >>> 0;
	return PALETTE[hash % PALETTE.length]!;
}

function formatTokenCount(tokens: number): string {
	return tokens >= 1_000 ? `${(tokens / 1_000).toFixed(1)}k` : String(tokens);
}

function percentOf(part: number, whole: number): string {
	return whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : "—";
}

/** Folds each segment's confidence tier into its label so it survives Malevich's confidence-unaware row builder. */
function withConfidenceLabel(segment: ContextSegment): MalevichContextSegment {
	return { key: segment.key, label: `${segment.label} [${segment.confidence}]`, estimatedTokens: segment.estimatedTokens, items: segment.items, unknown: segment.unknown };
}

class ContextViewport {
	private offsetY = 0;
	private readonly rows: ContextRow[];
	private readonly segments: readonly MalevichContextSegment[];

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly breakdown: ContextBreakdown,
		private readonly close: () => void,
	) {
		// Heaviest-first: Malevich renders segments in the order given, so sorting by weight for a
		// merged multi-producer view is this viewport's own policy, matching context-report.ts.
		this.segments = [...breakdown.segments].sort((left, right) => right.estimatedTokens - left.estimatedTokens).map(withConfidenceLabel);
		this.rows = buildContextRows(this.segments, breakdown.totalTokens ?? undefined);
	}

	invalidate(): void {}

	render(width: number): string[] {
		const theme = this.theme;
		const contentWidth = Math.max(1, width);
		const border = theme.fg("borderMuted", "─".repeat(contentWidth));
		const lines: string[] = [border, truncateToWidth(theme.fg("accent", theme.bold("Context")), contentWidth, "")];

		const { totalTokens, effectiveBudget } = this.breakdown;
		if (totalTokens !== null && effectiveBudget !== null) {
			lines.push(truncateToWidth(`${formatTokenCount(totalTokens)} / ${formatTokenCount(effectiveBudget)} tokens (${percentOf(totalTokens, effectiveBudget)} of usable budget)`, contentWidth, ""));
		} else if (totalTokens !== null) {
			lines.push(truncateToWidth(`${formatTokenCount(totalTokens)} tokens (model context window unknown)`, contentWidth, ""));
		} else {
			lines.push(theme.fg("dim", "No real usage reported yet — sizes below are estimates only"));
		}

		const colorFor = (key: string) => (s: string) => theme.fg(paletteColor(key), s);
		const barTheme: ContextBarTheme = { colorFor, empty: (s) => theme.fg("dim", s) };
		lines.push(renderContextUsageBar(barTheme, this.segments, contentWidth, effectiveBudget ?? undefined, totalTokens ?? undefined));
		if (this.breakdown.overshootTokens > 0) {
			lines.push(truncateToWidth(theme.fg("warning", `Estimates exceed real total by ~${this.breakdown.overshootTokens} tok — sizes below are approximate, not exact`), contentWidth, ""));
		}
		lines.push("");

		const rowsTheme: ContextRowsTheme = { colorFor, header: (s) => theme.bold(s) };
		const visible = this.rows.slice(this.offsetY, this.offsetY + VISIBLE_ROWS);
		lines.push(...renderContextRowLines(visible, contentWidth, rowsTheme));
		if (this.rows.length === 0) lines.push(theme.fg("dim", "  (nothing observed yet)"));
		else lines.push(theme.fg("muted", `  ${Math.min(this.offsetY + VISIBLE_ROWS, this.rows.length)}/${this.rows.length}`));

		lines.push("");
		lines.push(theme.fg("dim", "↑↓ scroll · esc close"));
		lines.push(border);
		return lines;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) { this.close(); return; }
		if (matchesKey(data, "up")) this.offsetY = Math.max(0, this.offsetY - 1);
		else if (matchesKey(data, "down")) this.offsetY = Math.min(Math.max(0, this.rows.length - VISIBLE_ROWS), this.offsetY + 1);
		else return;
		this.tui.requestRender();
	}
}

/** Interactive scrollable Context Hub view in TUI mode; the same plain-text report as /context's non-interactive path otherwise. */
export async function showContextView(ctx: ExtensionCommandContext, breakdown: ContextBreakdown): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(buildContextReport(breakdown), "info");
		return;
	}
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new ContextViewport(tui, theme, breakdown, done));
}
