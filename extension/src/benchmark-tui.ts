import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import {
	BENCHMARK_TUI_MAX_CANDIDATES,
	BENCHMARK_TUI_MAX_PROVENANCE_PER_CANDIDATE,
	MODEL_RANKING_DEFAULT_CONTEXT_WEIGHT,
	MODEL_RANKING_DEFAULT_COST_WEIGHT,
	MODEL_RANKING_DEFAULT_LATENCY_WEIGHT,
	MODEL_RANKING_DEFAULT_QUALITY_WEIGHT,
	MODEL_RANKING_DEFAULT_RELIABILITY_WEIGHT,
} from "../../src/constants.ts";
import type { ModelTaskDomain, ModelTaskType } from "../../src/domain/model-observation.ts";
import type { ModelCandidate, ModelRankingResult, RankedModel, UtilityComponentName } from "../../src/domain/model-ranking.ts";

export interface BenchmarkPanelClient {
	call(operation: string, input: unknown): Promise<any>;
}

interface BenchmarkTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

type BenchmarkPanelAction = "refresh" | "close";

const COMPONENT_LABELS: Record<UtilityComponentName, string> = { quality: "Q", cost: "$", latency: "L", context: "C", reliability: "R" };

function componentText(item: RankedModel): string {
	return item.components.map((component) => `${COMPONENT_LABELS[component.name]} ${component.score === null ? "?" : component.score.toFixed(3)}`).join(" · ");
}

function candidateLines(item: RankedModel, index: number, currentIdentity: string): string[] {
	const current = item.identity.startsWith(`${currentIdentity}:`);
	const localSamples = item.components.find((component) => component.name === "reliability")?.evidenceCount ?? 0;
	const provenance = item.provenance.slice(0, BENCHMARK_TUI_MAX_PROVENANCE_PER_CANDIDATE).map((source) => `${source.sourceId}@${source.revision} ${source.freshness}`).join(" · ");
	return [
		` ${index + 1}. ${item.identity}${index === 0 ? "  recommended" : ""}${current ? "  current" : ""}`,
		`    utility ${item.utility === null ? "?" : item.utility.toFixed(3)} · confidence ${(item.confidence * 100).toFixed(0)}% · ${componentText(item)}`,
		`    local n=${localSamples}${provenance ? ` · ${provenance}` : " · no external provenance"}`,
	];
}

export function renderBenchmarkView(result: ModelRankingResult, currentIdentity: string, width: number, theme: BenchmarkTheme): string[] {
	const safeWidth = Math.max(1, width);
	const shown = result.ranked.slice(0, BENCHMARK_TUI_MAX_CANDIDATES);
	const currentIndex = result.ranked.findIndex((item) => item.identity.startsWith(`${currentIdentity}:`));
	const recommended = result.ranked[0];
	const reason = recommended && currentIndex > 0
		? `Recommendation differs from current: ${recommended.identity} ranks #1; current ranks #${currentIndex + 1}.`
		: recommended && currentIndex === 0 ? "Current model is the top recommendation." : "Current model is outside the ranked candidates.";
	const lines = [
		theme.fg("borderMuted", "─".repeat(safeWidth)),
		theme.bold("Jittor Benchmark Recommendations"),
		result.scopeAuthority === "exact-session" ? "Scope: exact session" : "Scope: available models · ADVISORY (exact session scope unavailable)",
		`Domain: ${result.domain} · Type: ${result.type} · evidence ${result.completeness}`,
		reason,
		...shown.flatMap((item, index) => candidateLines(item, index, currentIdentity)),
		...(result.ranked.length > shown.length ? [` … ${result.ranked.length - shown.length} more candidates omitted`] : []),
		...(result.scopeWarning ? [result.scopeWarning] : []),
		theme.fg("dim", "r refresh · Esc close"),
		theme.fg("borderMuted", "─".repeat(safeWidth)),
	];
	return lines.map((line) => truncateToWidth(line, safeWidth, "…"));
}

export async function showBenchmarkPanel(
	ctx: ExtensionCommandContext,
	client: BenchmarkPanelClient,
	candidates: ModelCandidate[],
	currentIdentity: string,
	domain: ModelTaskDomain,
	type: ModelTaskType,
): Promise<void> {
	for (;;) {
		const result = await client.call("models.rank", {
			candidates,
			scopeAuthority: "available-models",
			domain,
			type,
			budgetPressure: 0,
			weights: {
				quality: MODEL_RANKING_DEFAULT_QUALITY_WEIGHT,
				cost: MODEL_RANKING_DEFAULT_COST_WEIGHT,
				latency: MODEL_RANKING_DEFAULT_LATENCY_WEIGHT,
				context: MODEL_RANKING_DEFAULT_CONTEXT_WEIGHT,
				reliability: MODEL_RANKING_DEFAULT_RELIABILITY_WEIGHT,
			},
			sourceIds: ["openrouter-models", "openrouter-artificial-analysis"],
		}) as ModelRankingResult;
		if (ctx.mode !== "tui") {
			ctx.ui.notify(renderBenchmarkView(result, currentIdentity, 100, { fg: (_color, text) => text, bold: (text) => text }).join("\n"), "info");
			return;
		}
		const action = await ctx.ui.custom<BenchmarkPanelAction>((_tui, theme, _keybindings, done) => ({
			invalidate() {},
			render(width: number): string[] { return renderBenchmarkView(result, currentIdentity, width, theme); },
			handleInput(data: string): void {
				if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) done("close");
				else if (data === "r") done("refresh");
			},
		}));
		if (!action || action === "close") return;
		await client.call("benchmark.refresh", { force: true });
	}
}
