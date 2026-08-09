import type { UsageImportResult, UsageImportStatus } from "../observability/usage-import.ts";
import type { CliDependencies } from "./support.ts";

export const BACKFILL_USAGE_LINES = ["  backfill <status|dry-run|run|cancel> [--json]"];

export function formatUsageImportResult(result: UsageImportResult): string {
	return [
		`Pi usage backfill: ${result.dryRun ? "dry run" : result.canceled ? "canceled" : "complete"}${result.truncated ? " · bounded/truncated" : ""}`,
		`Records: ${result.discovered.toLocaleString()} discovered · ${result.imported.toLocaleString()} imported · ${result.duplicates.toLocaleString()} duplicates`,
		`Scanned: ${result.filesScanned.toLocaleString()} files · ${result.entriesScanned.toLocaleString()} entries · ${result.bytesScanned.toLocaleString()} bytes · ${result.malformedEntries.toLocaleString()} malformed`,
	].join("\n");
}

export function formatUsageImportStatus(status: UsageImportStatus): string {
	if (!status.lastResult)
		return `Pi usage backfill: ${status.running ? "running" : "not run"}${status.cancelRequested ? " · cancellation requested" : ""}`;
	return `${status.running ? "Running" : "Last run"}${status.cancelRequested ? " · cancellation requested" : ""}\n${formatUsageImportResult(status.lastResult)}`;
}

export async function runBackfillCommand(
	action: string | undefined,
	rest: string[],
	deps: CliDependencies,
	usage: () => number,
): Promise<number> {
	if (!action || !["status", "dry-run", "run", "cancel"].includes(action)) return usage();
	let json = false;
	for (const argument of rest) {
		if (argument !== "--json") return usage();
		json = true;
	}
	try {
		const result =
			action === "status"
				? await deps.client.call("usage.import_status", {})
				: action === "cancel"
					? await deps.client.call("usage.import_cancel", {})
					: await deps.client.call("usage.import", { dryRun: action === "dry-run" });
		deps.stdout(
			json
				? JSON.stringify(result)
				: action === "run" || action === "dry-run"
					? formatUsageImportResult(result as UsageImportResult)
					: formatUsageImportStatus(result as UsageImportStatus),
		);
		return 0;
	} catch (error) {
		deps.stderr(error instanceof Error ? error.message : String(error));
		return 1;
	}
}
