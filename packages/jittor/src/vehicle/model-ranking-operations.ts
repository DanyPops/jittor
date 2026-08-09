import type { ModelRanker, ModelRecommendationInput } from "../optimization/model-selection/ranker.ts";
import type { RouterController } from "../optimization/routing/controller.ts";
import type { OperationHandlerMap } from "./operation-types.ts";

/** models.rank -- scores candidates via the model ranker, then, only for an automatic selection, applies it as a router mutation (so it shares the same session-identity authorization as every other router mutation). */
export function modelRankingOperations(
	modelRanker: ModelRanker,
	router: RouterController,
	authorize: (input: Record<string, unknown>) => string | undefined,
): OperationHandlerMap {
	return {
		"models.rank": (input) => {
			const result = modelRanker.rank(input as unknown as ModelRecommendationInput);
			if (result.automaticSelection && router.applyModelRanking) {
				router.applyModelRanking(
					result.ranked.map((item) => item.candidate),
					authorize(input),
				);
			}
			return result;
		},
	};
}
