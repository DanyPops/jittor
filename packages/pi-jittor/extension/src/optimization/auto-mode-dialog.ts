/**
 * Suggest-mode's real interactive surface: a compact one-line Dialog (Switch / Details / Not
 * now) with Details expanding into the existing benchmark panel's full component/confidence/
 * provenance breakdown before the user decides -- both verbosity levels are supported, never
 * just one. Reuses `createBenchmarkPanel` rather than building a second detail renderer.
 */

import type { ModelCandidate, ModelRankingResult, ModelTaskEffort } from "@danypops/jittor";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Dialog, type TextMeasure } from "malevich-tui-components";
import { candidateIdentityOf } from "./auto-mode.ts";
import { createBenchmarkPanel } from "./model-selection-panel.ts";

export type AutoModeSuggestionChoice = "switch" | "dismiss";

interface SuggestionTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

const hostTextMeasure: TextMeasure = { visibleWidth, truncateToWidth };

function summaryLine(candidate: ModelCandidate, effort: ModelTaskEffort, utilityDelta: number, confidence: number): string {
	return `Jittor suggests ${candidateIdentityOf(candidate)} for this turn -- effort: ${effort}, +${utilityDelta.toFixed(2)} utility, ${(confidence * 100).toFixed(0)}% confidence.`;
}

/** Shows the existing benchmark breakdown as a read-only detail view; any dismissal (Esc, "r", Ctrl+C) returns control to the caller, which re-shows the compact decision dialog. */
async function showSuggestionDetails(ctx: ExtensionContext, ranking: ModelRankingResult, currentIdentity: string): Promise<void> {
	await ctx.ui.custom<"close">((_tui, theme: SuggestionTheme, _keybindings, done) => {
		const panel = createBenchmarkPanel(ranking, currentIdentity, theme, () => done("close"), true);
		return {
			invalidate: () => panel.invalidate(),
			render: (width: number) => panel.render(width),
			handleInput(data: string): void {
				if (matchesKey(data, "ctrl+c")) {
					done("close");
					return;
				}
				panel.handleInput(data);
			},
		};
	});
}

/**
 * Non-TUI (`ctx.mode !== "tui"`) mode has no interactive dialog to show, matching every other
 * jittor confirmation's own non-TUI fallback -- it stays a plain notify and the suggestion is
 * treated as dismissed (advisory-only; the user reads it, no automatic action follows).
 */
export async function showAutoModeSuggestion(
	ctx: ExtensionContext,
	candidate: ModelCandidate,
	effort: ModelTaskEffort,
	utilityDelta: number,
	confidence: number,
	ranking: ModelRankingResult,
	currentIdentity: string,
	verboseByDefault: boolean,
): Promise<AutoModeSuggestionChoice> {
	const summary = summaryLine(candidate, effort, utilityDelta, confidence);
	if (ctx.mode !== "tui") {
		ctx.ui.notify(`${summary} Run /jittor benchmarks for details.`, "info");
		return "dismiss";
	}
	let showDetails = verboseByDefault;
	for (;;) {
		if (showDetails) {
			await showSuggestionDetails(ctx, ranking, currentIdentity);
			showDetails = false;
			continue;
		}
		const choice = await ctx.ui.custom<AutoModeSuggestionChoice | "details">((_tui, theme: SuggestionTheme, _keybindings, done) => {
			const dialog = new Dialog({
				title: "Jittor suggestion",
				body: summary,
				actions: [
					{ label: "Switch", key: "s", action: () => done("switch") },
					{ label: "Details", key: "d", action: () => done("details") },
					{ label: "Not now", key: "n", action: () => done("dismiss") },
				],
				theme: {
					border: (text) => theme.fg("borderMuted", text),
					title: theme.bold,
					body: (text) => text,
					dim: (text) => theme.fg("dim", text),
				},
				measure: hostTextMeasure,
			});
			return {
				invalidate: () => dialog.invalidate(),
				render: (width: number) => dialog.render(width),
				handleInput(data: string): void {
					if (matchesKey(data, "ctrl+c")) {
						done("dismiss");
						return;
					}
					dialog.handleInput(data);
				},
			};
		});
		if (choice === "details") {
			showDetails = true;
			continue;
		}
		return choice ?? "dismiss";
	}
}
