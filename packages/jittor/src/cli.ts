#!/usr/bin/env bun
import { fileURLToPath } from "node:url";
import { BACKFILL_USAGE_LINES, formatUsageImportResult, formatUsageImportStatus, runBackfillCommand } from "./cli-commands/backfill.ts";
import { BENCHMARKS_USAGE_LINES, runBenchmarksCommand } from "./cli-commands/benchmarks.ts";
import { CATALOG_USAGE_LINES, formatCatalogQuery, formatCatalogStatus, runCatalogCommand } from "./cli-commands/catalog.ts";
import { runCompactionCommand } from "./cli-commands/compaction.ts";
import { CONTEXT_USAGE_LINES, formatContextAssessment, formatContextDelta, runContextCommand } from "./cli-commands/context.ts";
import { EXPORT_USAGE_LINES, formatExportStatus, runExportCommand } from "./cli-commands/export.ts";
import { formatCostByTask, formatMetricsQuery, METRICS_USAGE_LINES, runMetricsCommand } from "./cli-commands/metrics.ts";
import { OP_USAGE_LINES, runOpCommand } from "./cli-commands/op.ts";
import { formatRouterStatus, ROUTER_USAGE_LINES, runRouterCommand, runTelemetryCommand } from "./cli-commands/router.ts";
import { installService, renderSystemdUnit, runServiceCommand, SERVICE_USAGE_LINES, systemctl } from "./cli-commands/service-daemon.ts";
import { runSessionCommand, SESSION_USAGE_LINES } from "./cli-commands/session.ts";
import type { CliDependencies } from "./cli-commands/support.ts";
import { serveMain } from "./daemon.ts";
import { connectJittorClient } from "./vehicle/client.ts";

// Re-exported for external callers (tests, daemon.ts's systemd-unit test) that import these
// directly from cli.ts rather than reaching into src/cli-commands/*.
export type { CliDependencies };
export {
	formatCatalogQuery,
	formatCatalogStatus,
	formatContextAssessment,
	formatContextDelta,
	formatCostByTask,
	formatExportStatus,
	formatMetricsQuery,
	formatRouterStatus,
	formatUsageImportResult,
	formatUsageImportStatus,
	renderSystemdUnit,
};

const DEFAULT_DEPENDENCIES: CliDependencies = {
	get client() {
		return connectJittorClient();
	},
	stdout: console.log,
	stderr: console.error,
	systemctl,
	installService: () => installService(fileURLToPath(import.meta.url)),
	serve: serveMain,
};

function usage(stderr: (line: string) => void): number {
	stderr(
		[
			"Usage: jittor <command> [options]",
			"  serve",
			...SERVICE_USAGE_LINES,
			...BACKFILL_USAGE_LINES,
			...EXPORT_USAGE_LINES,
			...CONTEXT_USAGE_LINES,
			...BENCHMARKS_USAGE_LINES,
			...CATALOG_USAGE_LINES,
			...METRICS_USAGE_LINES,
			...ROUTER_USAGE_LINES,
			...SESSION_USAGE_LINES,
			...OP_USAGE_LINES,
		].join("\n"),
	);
	return 2;
}

/**
 * Composes one command dispatcher per capability module (metrics, router+telemetry+compaction,
 * session identity, benchmarks, context, service lifecycle, the raw op escape hatch). Each module
 * owns its own argument parsing, validation, presentation, and usage lines; this function's switch
 * only routes the top-level command word and forwards `usage` for the shared fallback.
 */
export async function runCli(args: string[], deps: CliDependencies = DEFAULT_DEPENDENCIES): Promise<number> {
	const [command, action, ...rest] = args;
	const fail = () => usage(deps.stderr);
	switch (command) {
		case "serve":
			await deps.serve();
			return 0;
		case "session":
			return runSessionCommand(action, rest, deps, fail);
		case "backfill":
			return runBackfillCommand(action, rest, deps, fail);
		case "export":
			return runExportCommand(action, rest, deps, fail);
		case "metrics":
			return runMetricsCommand(action, rest, deps, fail);
		case "telemetry":
			return runTelemetryCommand(action, rest, deps, fail);
		case "compaction":
			return runCompactionCommand(action, rest, deps, fail);
		case "router":
			return runRouterCommand(action, rest, deps, fail);
		case "op":
			return runOpCommand(action, rest, deps, fail);
		case "benchmarks":
			return runBenchmarksCommand(action, rest, deps, fail);
		case "catalog":
			return runCatalogCommand(action, rest, deps, fail);
		case "context":
			return runContextCommand(action, rest, deps, fail);
		case "service":
			return runServiceCommand(action, rest, deps, fail);
		default:
			return fail();
	}
}

export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
	process.exitCode = await runCli(args);
}

if (import.meta.main) await main();
