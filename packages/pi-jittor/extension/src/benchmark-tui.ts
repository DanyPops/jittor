import {
	BENCHMARK_TUI_MAX_CANDIDATES,
	BENCHMARK_TUI_MAX_PROVENANCE_PER_CANDIDATE,
	MODEL_RANKING_DEFAULT_CONTEXT_WEIGHT,
	MODEL_RANKING_DEFAULT_COST_WEIGHT,
	MODEL_RANKING_DEFAULT_LATENCY_WEIGHT,
	MODEL_RANKING_DEFAULT_QUALITY_WEIGHT,
	MODEL_RANKING_DEFAULT_RELIABILITY_WEIGHT,
	type ModelCandidate,
	type ModelRankingResult,
	type ModelTaskDomain,
	type ModelTaskType,
	type RankedModel,
	type UtilityComponentName,
} from "@danypops/jittor";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { BorderedSelectPanel, Table, type TextMeasure } from "malevich-tui-components";
import { sessionSecretField } from "./session-identity.ts";

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
	return item.components
		.map((component) => `${COMPONENT_LABELS[component.name]} ${component.score === null ? "?" : component.score.toFixed(3)}`)
		.join(" · ");
}

const hostTextMeasure: TextMeasure = { visibleWidth, truncateToWidth };

function benchmarkRows(shown: RankedModel[], currentIdentity: string): Record<string, string>[] {
	return shown.flatMap((item, index) => {
		const current = item.identity.startsWith(`${currentIdentity}:`);
		const localSamples = item.components.find((component) => component.name === "reliability")?.evidenceCount ?? 0;
		const provenance = item.provenance
			.slice(0, BENCHMARK_TUI_MAX_PROVENANCE_PER_CANDIDATE)
			.map((source) => `${source.sourceId}@${source.revision} ${source.freshness}`)
			.join(" · ");
		return [
			{ rank: `${index + 1}.`, detail: `${item.identity}${index === 0 ? "  recommended" : ""}${current ? "  current" : ""}` },
			{
				rank: "",
				detail: `utility ${item.utility === null ? "?" : item.utility.toFixed(3)} · confidence ${(item.confidence * 100).toFixed(0)}% · ${componentText(item)}`,
			},
			{ rank: "", detail: `local n=${localSamples}${provenance ? ` · ${provenance}` : " · no external provenance"}` },
		];
	});
}

export function renderBenchmarkView(result: ModelRankingResult, currentIdentity: string, width: number, theme: BenchmarkTheme): string[] {
	const safeWidth = Math.max(1, width);
	const shown = result.ranked.slice(0, BENCHMARK_TUI_MAX_CANDIDATES);
	const currentIndex = result.ranked.findIndex((item) => item.identity.startsWith(`${currentIdentity}:`));
	const recommended = result.ranked[0];
	const reason =
		recommended && currentIndex > 0
			? `Recommendation differs from current: ${recommended.identity} ranks #1; current ranks #${currentIndex + 1}.`
			: recommended && currentIndex === 0
				? "Current model is the top recommendation."
				: "Current model is outside the ranked candidates.";
	const table = new Table({
		columns: [
			{ header: "#", key: "rank", width: 4 },
			{ header: "Candidate / evidence", key: "detail" },
		],
		rows: benchmarkRows(shown, currentIdentity),
		headerStyle: theme.bold,
		measure: hostTextMeasure,
	});
	const content = {
		invalidate: () => table.invalidate(),
		render: (availableWidth: number): string[] => [
			truncateToWidth(
				result.scopeAuthority === "exact-session"
					? "Scope: exact session"
					: "Scope: available models · ADVISORY (exact session scope unavailable)",
				availableWidth,
				"…",
			),
			truncateToWidth(`Domain: ${result.domain} · Type: ${result.type} · evidence ${result.completeness}`, availableWidth, "…"),
			truncateToWidth(reason, availableWidth, "…"),
			...table.render(availableWidth),
			...(result.ranked.length > shown.length
				? [truncateToWidth(`… ${result.ranked.length - shown.length} more candidates omitted`, availableWidth, "…")]
				: []),
			...(result.scopeWarning ? [truncateToWidth(result.scopeWarning, availableWidth, "…")] : []),
		],
	};
	return new BorderedSelectPanel({
		title: "Jittor Benchmark Recommendations",
		list: content,
		helpText: "r refresh · Esc close",
		theme: {
			border: (text) => theme.fg("borderMuted", text),
			title: theme.bold,
			help: (text) => theme.fg("dim", text),
		},
		measure: hostTextMeasure,
	}).render(safeWidth);
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
		const session_id = ctx.sessionManager.getSessionId();
		const result = (await client.call("models.rank", {
			candidates,
			session_id,
			...sessionSecretField(session_id),
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
			sourceIds: ["openrouter-models", "lmarena-hf", "artificial-analysis-direct", "openrouter-design-arena"],
		})) as ModelRankingResult;
		if (ctx.mode !== "tui") {
			ctx.ui.notify(
				renderBenchmarkView(result, currentIdentity, 100, { fg: (_color, text) => text, bold: (text) => text }).join("\n"),
				"info",
			);
			return;
		}
		const action = await ctx.ui.custom<BenchmarkPanelAction>((_tui, theme, _keybindings, done) => ({
			invalidate() {},
			render(width: number): string[] {
				return renderBenchmarkView(result, currentIdentity, width, theme);
			},
			handleInput(data: string): void {
				if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) done("close");
				else if (data === "r") done("refresh");
			},
		}));
		if (!action || action === "close") return;
		await client.call("benchmark.refresh", { force: true });
	}
}
