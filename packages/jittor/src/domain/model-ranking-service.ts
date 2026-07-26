import { MODEL_AGGREGATE_MAX_ROWS, MODEL_OBSERVATION_FRESH_MS, MODEL_RANKING_MAX_SOURCES } from "../constants.ts";
import type { BenchmarkStore } from "../ports/benchmark-store.ts";
import type { MetricStore } from "../ports/metric-store.ts";
import { aggregateModelMetrics } from "./model-observation.ts";
import { rankModelCandidates, type ModelCandidate, type ModelRankingResult, type ScopeAuthority, type UtilityWeights } from "./model-ranking.ts";
import type { ModelTaskDomain, ModelTaskType } from "./model-observation.ts";

export interface ModelRecommendationInput {
	candidates: ModelCandidate[];
	scopeAuthority: ScopeAuthority;
	domain: ModelTaskDomain;
	type: ModelTaskType;
	budgetPressure: number;
	weights: UtilityWeights;
	sourceIds: string[];
}

export interface ModelRanker {
	rank(input: ModelRecommendationInput): ModelRankingResult;
}

export class EvidenceModelRanker implements ModelRanker {
	constructor(
		private readonly benchmarks: BenchmarkStore,
		private readonly metrics: MetricStore,
		private readonly clock: () => number = Date.now,
	) {}

	rank(input: ModelRecommendationInput): ModelRankingResult {
		if (!Array.isArray(input.sourceIds) || input.sourceIds.length > MODEL_RANKING_MAX_SOURCES || !input.sourceIds.every((sourceId) => typeof sourceId === "string" && sourceId.length > 0 && sourceId.length <= 160)) {
			throw new Error("benchmark source selection is invalid");
		}
		const sourceIds = [...new Set(input.sourceIds)];
		const { sourceIds: _sourceIds, ...rankingInput } = input;
		const externalEvidence = sourceIds.flatMap((sourceId) => this.benchmarks.latest(sourceId)?.observations ?? []);
		const localRows = this.metrics.query({ source: "local-model", order: "desc", limit: MODEL_AGGREGATE_MAX_ROWS });
		const now = this.clock();
		const localEvidence = aggregateModelMetrics(localRows, { now, freshForMs: MODEL_OBSERVATION_FRESH_MS });
		return rankModelCandidates({ ...rankingInput, externalEvidence, localEvidence, now });
	}
}
