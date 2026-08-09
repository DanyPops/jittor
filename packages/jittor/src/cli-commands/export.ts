import type { ObservationExportStatus } from "../telemetry-export/exporter.ts";
import type { CliDependencies } from "./support.ts";

export const EXPORT_USAGE_LINES = ["  export <status|flush> [--json]"];

export function formatExportStatus(status: ObservationExportStatus): string {
	if (!status.enabled) return "OTLP export: disabled";
	return [
		`OTLP export: enabled · semantic conventions ${status.semanticConventions}`,
		`Queue: ${status.queued.toLocaleString()} queued · ${status.exported.toLocaleString()} exported · ${status.dropped.toLocaleString()} dropped · ${status.failures.toLocaleString()} failed batches`,
	].join("\n");
}

export async function runExportCommand(
	action: string | undefined,
	rest: string[],
	deps: CliDependencies,
	usage: () => number,
): Promise<number> {
	if ((action !== "status" && action !== "flush") || rest.some((argument) => argument !== "--json")) return usage();
	const json = rest.includes("--json");
	try {
		const status = await deps.client.call(action === "flush" ? "export.flush" : "export.status", {});
		deps.stdout(json ? JSON.stringify(status) : formatExportStatus(status));
		return 0;
	} catch (error) {
		deps.stderr(error instanceof Error ? error.message : String(error));
		return 1;
	}
}
