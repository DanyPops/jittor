import type { ExtensionCommandContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import { buildContextRows, renderContextRowLines, renderContextUsageBar, type ContextBarTheme, type ContextRow, type ContextRowsTheme, type ContextSegment as MalevichContextSegment } from "malevich-tui-components";
import type { ContextSegment } from "@danypops/jittor";
import { buildContextReport, type ContextReportUsage } from "./context-report.ts";

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

/** Folds each segment's confidence tier into its label so it survives Malevich's confidence-unaware row builder. */
function withConfidenceLabel(segment: ContextSegment): MalevichContextSegment {
	return { key: segment.key, label: `${segment.label} [${segment.confidence}]`, estimatedTokens: segment.estimatedTokens, items: segment.items };
}

class ContextViewport {
	private offsetY = 0;
	private readonly rows: ContextRow[];
	private readonly segments: readonly MalevichContextSegment[];

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		segments: readonly ContextSegment[],
		private readonly usage: ContextReportUsage | undefined,
		private readonly close: () => void,
	) {
		// Heaviest-first: Malevich renders segments in the order given, so sorting by weight for a
		// merged multi-producer view is this viewport's own policy, matching context-report.ts.
		this.segments = [...segments].sort((left, right) => right.estimatedTokens - left.estimatedTokens).map(withConfidenceLabel);
		this.rows = buildContextRows(this.segments, usage?.tokens ?? undefined);
	}

	invalidate(): void {}

	render(width: number): string[] {
		const theme = this.theme;
		const contentWidth = Math.max(1, width);
		const border = theme.fg("borderMuted", "─".repeat(contentWidth));
		const lines: string[] = [border, truncateToWidth(theme.fg("accent", theme.bold("Context")), contentWidth, "")];

		if (this.usage?.tokens !== null && this.usage?.tokens !== undefined) {
			const percent = this.usage.percent !== null && this.usage.percent !== undefined ? ` (${this.usage.percent.toFixed(1)}% of ${formatTokenCount(this.usage.contextWindow)} window)` : "";
			lines.push(truncateToWidth(`${formatTokenCount(this.usage.tokens)} tokens${percent}`, contentWidth, ""));
		} else {
			lines.push(theme.fg("dim", "No real usage reported yet — sizes below are estimates only"));
		}

		const colorFor = (key: string) => (s: string) => theme.fg(paletteColor(key), s);
		const barTheme: ContextBarTheme = { colorFor, empty: (s) => theme.fg("dim", s) };
		lines.push(renderContextUsageBar(barTheme, this.segments, contentWidth, this.usage?.contextWindow, this.usage?.tokens ?? undefined));
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
export async function showContextView(ctx: ExtensionCommandContext, segments: readonly ContextSegment[], usage: ContextReportUsage | undefined): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(buildContextReport(segments, usage), "info");
		return;
	}
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new ContextViewport(tui, theme, segments, usage, done));
}
