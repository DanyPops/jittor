import type { UsageImportController } from "../observability/usage-import.ts";
import type { OperationHandlerMap } from "./operation-types.ts";

export function usageImportOperations(importer: UsageImportController): OperationHandlerMap {
	return {
		"usage.import": (input) => importer.run({ dryRun: input.dryRun === true }),
		"usage.import_status": () => importer.status(),
		"usage.import_cancel": () => importer.cancel(),
	};
}
