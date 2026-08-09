import type { ObservationExporter } from "../telemetry-export/exporter.ts";
import type { OperationHandlerMap } from "./operation-types.ts";

export function exportOperations(exporter: ObservationExporter): OperationHandlerMap {
	return {
		"export.status": () => exporter.status(),
		"export.flush": async () => {
			await exporter.flush();
			return exporter.status();
		},
	};
}
