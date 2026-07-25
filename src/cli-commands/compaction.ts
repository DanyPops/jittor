import type { CompactionDurationEstimate } from "../domain/context-telemetry.ts";
import { callAndPrint, type CliDependencies } from "./support.ts";
import { parseJsonOnlyArgs } from "./router.ts";

export function formatCompactionEstimate(estimate: CompactionDurationEstimate): string {
	if (estimate.confidence === "cold-start" || estimate.ms === null) {
		return `Compaction duration: cold-start (${estimate.sampleSize.toLocaleString()} sample(s), not enough evidence yet)`;
	}
	return `Compaction duration: ~${estimate.ms.toLocaleString()}ms learned from ${estimate.sampleSize.toLocaleString()} sample(s)`;
}

export async function runCompactionCommand(action: string | undefined, rest: string[], deps: CliDependencies, usage: () => number): Promise<number> {
	if (action !== "estimate") return usage();
	const parsed = parseJsonOnlyArgs(rest);
	if (!parsed) return usage();
	return callAndPrint(deps, "compaction.estimate", {}, parsed.json, formatCompactionEstimate);
}
