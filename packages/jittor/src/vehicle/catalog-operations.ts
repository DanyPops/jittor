import type { ModelCatalogController, ModelCatalogQuery } from "../optimization/model-selection/catalog.ts";
import type { OperationHandlerMap } from "./operation-types.ts";

export function catalogOperations(catalog: ModelCatalogController): OperationHandlerMap {
	return {
		"catalog.refresh": (input) => catalog.refresh(input.force === true),
		"catalog.status": () => catalog.status(),
		"catalog.query": (input) => catalog.query(input as unknown as ModelCatalogQuery),
	};
}
