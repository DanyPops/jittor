import type { ContextSegment } from "@danypops/jittor";
import type { ExtensionCommandContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { matchesKey, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import {
	type ContextBarTheme,
	type ContextRow,
	type ContextRowsTheme,
	type ContextSegment as MalevichContextSegment,
	renderContextRowLines,
	renderContextUsageBar,
} from "malevich-tui-components";
import type { ContextBreakdown } from "./context-breakdown.ts";
import { buildContextReport, buildContextRowsIterative } from "./context-report.ts";

const VISIBLE_ROWS = 22;
const MIN_TOKEN_FILTERS = [0, 100, 1_000, 10_000] as const;

export type ContextRowScope = "all" | "active" | "historical";

function rowTokens(row: ContextRow): number {
	const match = row.isHeader ? row.text.match(/—\s+([\d,]+)\s+tok/) : row.text.match(/^\s*([\d,]+)\s+tok/);
	return match ? Number(match[1]!.replaceAll(",", "")) : 0;
}

/** Filters the flattened pre-order tree while retaining every ancestor needed to understand a match. */
export function filterContextRows(rows: readonly ContextRow[], query: string, scope: ContextRowScope, minimumTokens: number): ContextRow[] {
	const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
	const included = rows.map(() => false);
	const parentByIndex: Array<number | null> = [];
	const ancestors: number[] = [];
	const historicalByDepth: boolean[] = [];
	for (let index = 0; index < rows.length; index++) {
		const row = rows[index]!;
		while (ancestors.length > row.depth) ancestors.pop();
		parentByIndex[index] = row.depth > 0 ? (ancestors[row.depth - 1] ?? null) : null;
		const lower = row.text.toLocaleLowerCase();
		const inheritedHistorical = row.depth > 0 ? (historicalByDepth[row.depth - 1] ?? false) : false;
		const historical = inheritedHistorical || lower.includes("(inactive branch)") || lower.includes("(compacted)");
		const scopeMatches = scope === "all" || (scope === "historical" ? historical : !historical);
		const queryMatches = terms.every((term) => lower.includes(term));
		included[index] = scopeMatches && queryMatches && rowTokens(row) >= minimumTokens;
		ancestors[row.depth] = index;
		ancestors.length = row.depth + 1;
		historicalByDepth[row.depth] = historical;
		historicalByDepth.length = row.depth + 1;
	}
	// Children follow parents in this pre-order list, so one reverse pass propagates every
	// match to its ancestors in O(rows), even for a 50k-entry linear session tree.
	for (let index = rows.length - 1; index >= 0; index--) {
		if (!included[index]) continue;
		const parent = parentByIndex[index];
		if (parent !== null && parent !== undefined) included[parent] = true;
	}
	return rows.filter((_row, index) => included[index]);
}

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
	return {
		key: segment.key,
		label: `${segment.label} [${segment.confidence}]`,
		estimatedTokens: segment.estimatedTokens,
		items: segment.items,
		unknown: segment.unknown,
	};
}

class ContextViewport {
	private offsetY = 0;
	private readonly rows: ContextRow[];
	private readonly segments: readonly MalevichContextSegment[];
	private searchMode = false;
	private query = "";
	private scope: ContextRowScope = "all";
	private minimumFilterIndex = 0;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly breakdown: ContextBreakdown,
		private readonly close: () => void,
	) {
		// Heaviest-first: Malevich renders segments in the order given, so sorting by weight for a
		// merged multi-producer view is this viewport's own policy, matching context-report.ts.
		this.segments = [...breakdown.segments].sort((left, right) => right.estimatedTokens - left.estimatedTokens).map(withConfidenceLabel);
		this.rows = buildContextRowsIterative(this.segments, breakdown.totalTokens ?? undefined);
	}

	invalidate(): void {}

	private visibleRows(): ContextRow[] {
		return filterContextRows(this.rows, this.query, this.scope, MIN_TOKEN_FILTERS[this.minimumFilterIndex]!);
	}

	private clampOffset(rows: readonly ContextRow[]): void {
		this.offsetY = Math.min(this.offsetY, Math.max(0, rows.length - VISIBLE_ROWS));
	}

	render(width: number): string[] {
		const theme = this.theme;
		const contentWidth = Math.max(1, width);
		const border = theme.fg("borderMuted", "─".repeat(contentWidth));
		const lines: string[] = [border, truncateToWidth(theme.fg("accent", theme.bold("Context")), contentWidth, "")];

		const { totalTokens, effectiveBudget } = this.breakdown;
		if (totalTokens !== null && effectiveBudget !== null) {
			lines.push(
				truncateToWidth(
					`${formatTokenCount(totalTokens)} / ${formatTokenCount(effectiveBudget)} tokens (${percentOf(totalTokens, effectiveBudget)} of usable budget)`,
					contentWidth,
					"",
				),
			);
		} else if (totalTokens !== null) {
			lines.push(truncateToWidth(`${formatTokenCount(totalTokens)} tokens (model context window unknown)`, contentWidth, ""));
		} else {
			lines.push(theme.fg("dim", "No real usage reported yet — sizes below are estimates only"));
		}

		const colorFor = (key: string) => (s: string) => theme.fg(paletteColor(key), s);
		const barTheme: ContextBarTheme = { colorFor, empty: (s) => theme.fg("dim", s) };
		lines.push(renderContextUsageBar(barTheme, this.segments, contentWidth, effectiveBudget ?? undefined, totalTokens ?? undefined));
		if (this.breakdown.overshootTokens > 0) {
			lines.push(
				truncateToWidth(
					theme.fg(
						"warning",
						`Estimates exceed real total by ~${this.breakdown.overshootTokens} tok — sizes below are approximate, not exact`,
					),
					contentWidth,
					"",
				),
			);
		}
		lines.push(
			theme.fg("dim", "Item sizes marked ≈ use char/4; provider request totals are aggregate usage, not per-item tokenizer counts."),
		);
		lines.push("");

		const rowsTheme: ContextRowsTheme = { colorFor, header: (s) => theme.bold(s) };
		const filteredRows = this.visibleRows();
		this.clampOffset(filteredRows);
		const visible = filteredRows.slice(this.offsetY, this.offsetY + VISIBLE_ROWS);
		lines.push(...renderContextRowLines(visible, contentWidth, rowsTheme));
		if (filteredRows.length === 0) lines.push(theme.fg("dim", "  (no matching context items)"));
		else lines.push(theme.fg("muted", `  ${Math.min(this.offsetY + VISIBLE_ROWS, filteredRows.length)}/${filteredRows.length}`));

		lines.push("");
		const minimum = MIN_TOKEN_FILTERS[this.minimumFilterIndex]!;
		const filterState = `scope: ${this.scope} · min: ${minimum === 0 ? "any" : `${formatTokenCount(minimum)} tok`}`;
		lines.push(
			truncateToWidth(
				this.searchMode
					? theme.fg("accent", `Search: ${this.query}▌ · ${filterState}`)
					: theme.fg("muted", `${this.query ? `search: ${this.query} · ` : ""}${filterState}`),
				contentWidth,
				"",
			),
		);
		lines.push(
			theme.fg(
				"dim",
				this.searchMode
					? "type to search · backspace edit · enter apply · esc clear"
					: "/ search · f scope · m min tokens · g/G top/bottom · ↑↓ scroll · esc close",
			),
		);
		lines.push(border);
		return lines;
	}

	handleInput(data: string): void {
		if (this.searchMode) {
			if (matchesKey(data, "escape")) {
				if (this.query.length > 0) this.query = "";
				else this.searchMode = false;
			} else if (matchesKey(data, "enter")) this.searchMode = false;
			else if (matchesKey(data, "backspace")) this.query = this.query.slice(0, -1);
			else if (/^[\x20-\x7e]+$/.test(data)) this.query += data;
			else return;
			this.offsetY = 0;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.close();
			return;
		}
		const rows = this.visibleRows();
		if (data === "/") {
			this.searchMode = true;
			this.offsetY = 0;
		} else if (data === "f") {
			this.scope = this.scope === "all" ? "active" : this.scope === "active" ? "historical" : "all";
			this.offsetY = 0;
		} else if (data === "m") {
			this.minimumFilterIndex = (this.minimumFilterIndex + 1) % MIN_TOKEN_FILTERS.length;
			this.offsetY = 0;
		} else if (data === "g") this.offsetY = 0;
		else if (data === "G") this.offsetY = Math.max(0, rows.length - VISIBLE_ROWS);
		else if (matchesKey(data, "up")) this.offsetY = Math.max(0, this.offsetY - 1);
		else if (matchesKey(data, "down")) this.offsetY = Math.min(Math.max(0, rows.length - VISIBLE_ROWS), this.offsetY + 1);
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
