import { MODEL_CATALOG_MAX_QUERY_LIMIT } from "../constants.ts";
import type { ModelCatalogQuery, ModelCatalogQueryResult, ModelCatalogStatus } from "../optimization/model-selection/catalog.ts";
import { type CliDependencies, humanField } from "./support.ts";

export const CATALOG_USAGE_LINES = [
	"  catalog <status|refresh|list> [--provider <id>] [--model <id>] [--limit <n>] [--context-tokens <n>] [--input-tokens <n>] [--output-tokens <n>] [--input-price <usd-per-million>] [--output-price <usd-per-million>] [--force] [--json]",
];

interface CatalogArgs {
	action: "status" | "refresh" | "list";
	json: boolean;
	force: boolean;
	query: ModelCatalogQuery;
}

function parsePositive(raw: string, integer: boolean): number | null {
	const value = Number(raw);
	if (!Number.isFinite(value) || value < 0 || (integer && !Number.isSafeInteger(value))) return null;
	return value;
}

function parseCatalogArgs(action: string | undefined, args: string[]): CatalogArgs | null {
	if (action !== "status" && action !== "refresh" && action !== "list") return null;
	let json = false;
	let force = false;
	const query: ModelCatalogQuery = {};
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--json") {
			json = true;
			continue;
		}
		if (argument === "--force" && action === "refresh") {
			force = true;
			continue;
		}
		if (action !== "list") return null;
		if (
			!argument ||
			![
				"--provider",
				"--model",
				"--limit",
				"--context-tokens",
				"--input-tokens",
				"--output-tokens",
				"--input-price",
				"--output-price",
			].includes(argument)
		)
			return null;
		const raw = args[++index];
		if (!raw) return null;
		if (argument === "--provider") query.provider = raw;
		else if (argument === "--model") query.model = raw;
		else if (argument === "--limit") {
			const value = parsePositive(raw, true);
			if (value === null || value < 1 || value > MODEL_CATALOG_MAX_QUERY_LIMIT) return null;
			query.limit = value;
		} else {
			const integer = argument.endsWith("-tokens");
			const value = parsePositive(raw, integer);
			if (value === null) return null;
			const key = {
				"--context-tokens": "contextTokens",
				"--input-tokens": "inputTokens",
				"--output-tokens": "outputTokens",
				"--input-price": "inputPrice",
				"--output-price": "outputPrice",
			}[argument] as "contextTokens" | "inputTokens" | "outputTokens" | "inputPrice" | "outputPrice";
			if (!query.overrides) query.overrides = {};
			query.overrides[key] = value;
		}
	}
	return { action, json, force, query };
}

export function formatCatalogStatus(status: ModelCatalogStatus): string {
	if (!status.configured && !status.hasSnapshot) return "Model catalog: not configured (set JITTOR_MODELS_DEV_CATALOG=1)";
	const state = status.ok === null ? "not refreshed" : status.ok ? "ready" : "refresh failed; last-good snapshot retained";
	return `Model catalog: ${state} · ${status.entries.toLocaleString()} entries · revision ${status.revision ?? "unknown"}`;
}

export function formatCatalogQuery(result: ModelCatalogQueryResult): string {
	return [
		`Model catalog: ${result.completeness} · ${result.freshness} · ${result.entries.length.toLocaleString()} entries · ${humanField(result.provenance.revision)}`,
		...result.entries.map((entry) => {
			const cost = entry.pricing
				? ` · $${entry.pricing.input ?? "unknown"}/$${entry.pricing.output ?? "unknown"} input/output per 1M`
				: " · pricing unknown";
			return `- ${humanField(entry.canonical)} · context ${entry.limits.context.toLocaleString()} · output ${entry.limits.output.toLocaleString()}${cost} · ${entry.status}`;
		}),
	].join("\n");
}

export async function runCatalogCommand(
	action: string | undefined,
	rest: string[],
	deps: CliDependencies,
	usage: () => number,
): Promise<number> {
	const parsed = parseCatalogArgs(action, rest);
	if (!parsed) return usage();
	try {
		const result =
			parsed.action === "list"
				? await deps.client.call("catalog.query", parsed.query)
				: parsed.action === "refresh"
					? await deps.client.call("catalog.refresh", { force: parsed.force })
					: await deps.client.call("catalog.status", {});
		deps.stdout(
			parsed.json
				? JSON.stringify(result)
				: parsed.action === "list"
					? formatCatalogQuery(result as ModelCatalogQueryResult)
					: formatCatalogStatus(result as ModelCatalogStatus),
		);
		return 0;
	} catch (error) {
		deps.stderr(error instanceof Error ? error.message : String(error));
		return 1;
	}
}
