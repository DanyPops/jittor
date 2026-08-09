import {
	CLI_METRICS_HUMAN_MAX_ROWS,
	MAX_QUERY_LIMIT,
	MAX_USAGE_BUCKETS,
	METRIC_BATCH_MAX_OBSERVATIONS,
	USAGE_MAX_DISTINCT_SCOPES,
} from "../constants.ts";
import {
	METRIC_UNITS,
	type MetricObservation,
	type MetricQuery,
	type MetricUnit,
	type StoredMetricObservation,
} from "../observability/metric.ts";
import type { TaskCostSummary } from "../observability/task-cost.ts";
import { type CliDependencies, callAndPrint, humanField } from "./support.ts";

export const METRICS_USAGE_LINES = [
	"  metrics record --source <s> --scope <s> --metric <s> --value <number|null> --unit <unit> [--observed-at <ms>] [--attributes <json>] [--json]",
	`  metrics record-batch --observations <json-array, max ${METRIC_BATCH_MAX_OBSERVATIONS}> [--json]`,
	"  metrics query [--source <s>] [--scope <s>] [--metric <s>] [--since <ms>] [--until <ms>] [--limit <n>] [--order asc|desc] [--json]",
	"  metrics prune --before <ms> [--force] [--json] (force required if before is newer than 24h ago)",
	`  metrics distinct-scopes --source <s> --since <ms> --until <ms> [--limit 1..${USAGE_MAX_DISTINCT_SCOPES}] [--json]`,
	`  metrics usage-series --source <s> --since <ms> --until <ms> --bucket-size-ms <ms> --bucket-count 1..${MAX_USAGE_BUCKETS} [--scope-limit 1..${USAGE_MAX_DISTINCT_SCOPES}] [--json]`,
	"  metrics cost-by-task --since <ms> --until <ms> [--json]",
];

interface MetricsRecordArgs {
	input: MetricObservation;
	json: boolean;
}

function parseMetricsRecordArgs(args: string[]): MetricsRecordArgs | null {
	let json = false;
	let source: string | undefined;
	let scope: string | undefined;
	let metric: string | undefined;
	let value: number | null | undefined;
	let unit: MetricUnit | undefined;
	let observedAt: number | undefined;
	let attributes: Record<string, unknown> | undefined;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--json") {
			json = true;
			continue;
		}
		if (!["--source", "--scope", "--metric", "--value", "--unit", "--observed-at", "--attributes"].includes(argument ?? "")) return null;
		const raw = args[++index];
		if (raw === undefined || raw.length === 0) return null;
		if (argument === "--source") source = raw;
		else if (argument === "--scope") scope = raw;
		else if (argument === "--metric") metric = raw;
		else if (argument === "--value") {
			if (raw.toLowerCase() === "null") value = null;
			else {
				const parsed = Number(raw);
				if (!Number.isFinite(parsed)) return null;
				value = parsed;
			}
		} else if (argument === "--unit") {
			if (!METRIC_UNITS.includes(raw as MetricUnit)) return null;
			unit = raw as MetricUnit;
		} else if (argument === "--observed-at") {
			const parsed = Number(raw);
			if (!Number.isSafeInteger(parsed) || parsed < 0) return null;
			observedAt = parsed;
		} else {
			try {
				const parsed = JSON.parse(raw);
				if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
				attributes = parsed as Record<string, unknown>;
			} catch {
				return null;
			}
		}
	}
	if (source === undefined || scope === undefined || metric === undefined || value === undefined || unit === undefined) return null;
	return {
		json,
		input: {
			source,
			scope,
			metric,
			value,
			unit,
			observedAt: observedAt ?? Date.now(),
			...(attributes ? { attributes } : {}),
		},
	};
}

interface MetricsRecordBatchArgs {
	input: { observations: MetricObservation[] };
	json: boolean;
}

function parseMetricsRecordBatchArgs(args: string[]): MetricsRecordBatchArgs | null {
	let json = false;
	let observations: unknown;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--json") {
			json = true;
			continue;
		}
		if (argument !== "--observations") return null;
		const raw = args[++index];
		if (raw === undefined || raw.length === 0) return null;
		try {
			observations = JSON.parse(raw);
		} catch {
			return null;
		}
	}
	if (!Array.isArray(observations) || observations.length === 0 || observations.length > METRIC_BATCH_MAX_OBSERVATIONS) return null;
	return { input: { observations: observations as MetricObservation[] }, json };
}

interface MetricsQueryArgs {
	input: MetricQuery;
	json: boolean;
}

function parseMetricsQueryArgs(args: string[]): MetricsQueryArgs | null {
	let json = false;
	const input: MetricQuery = {};
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--json") {
			json = true;
			continue;
		}
		if (!["--source", "--scope", "--metric", "--since", "--until", "--limit", "--order"].includes(argument ?? "")) return null;
		const raw = args[++index];
		if (raw === undefined || raw.length === 0) return null;
		if (argument === "--source") input.source = raw;
		else if (argument === "--scope") input.scope = raw;
		else if (argument === "--metric") input.metric = raw;
		else if (argument === "--order") {
			if (raw !== "asc" && raw !== "desc") return null;
			input.order = raw;
		} else {
			const parsed = Number(raw);
			if (!Number.isSafeInteger(parsed) || parsed < 0) return null;
			if (argument === "--since") input.since = parsed;
			else if (argument === "--until") input.until = parsed;
			else {
				if (parsed < 1 || parsed > MAX_QUERY_LIMIT) return null;
				input.limit = parsed;
			}
		}
	}
	if (input.since !== undefined && input.until !== undefined && input.until < input.since) return null;
	return { input, json };
}

interface MetricsDistinctScopesArgs {
	input: { source: string; since: number; until: number; limit?: number };
	json: boolean;
}

function parseMetricsDistinctScopesArgs(args: string[]): MetricsDistinctScopesArgs | null {
	let json = false;
	let source: string | undefined;
	let since: number | undefined;
	let until: number | undefined;
	let limit: number | undefined;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--json") {
			json = true;
			continue;
		}
		if (!["--source", "--since", "--until", "--limit"].includes(argument ?? "")) return null;
		const raw = args[++index];
		if (raw === undefined || raw.length === 0) return null;
		if (argument === "--source") {
			source = raw;
			continue;
		}
		const parsed = Number(raw);
		if (!Number.isSafeInteger(parsed) || parsed < 0) return null;
		if (argument === "--since") since = parsed;
		else if (argument === "--until") until = parsed;
		else {
			if (parsed < 1 || parsed > USAGE_MAX_DISTINCT_SCOPES) return null;
			limit = parsed;
		}
	}
	if (source === undefined || since === undefined || until === undefined || until < since) return null;
	return { input: { source, since, until, ...(limit === undefined ? {} : { limit }) }, json };
}

interface MetricsUsageSeriesArgs {
	input: { source: string; since: number; until: number; bucketSizeMs: number; bucketCount: number; scopeLimit?: number };
	json: boolean;
}

function parseMetricsUsageSeriesArgs(args: string[]): MetricsUsageSeriesArgs | null {
	let json = false;
	let source: string | undefined;
	let since: number | undefined;
	let until: number | undefined;
	let bucketSizeMs: number | undefined;
	let bucketCount: number | undefined;
	let scopeLimit: number | undefined;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--json") {
			json = true;
			continue;
		}
		if (!["--source", "--since", "--until", "--bucket-size-ms", "--bucket-count", "--scope-limit"].includes(argument ?? "")) return null;
		const raw = args[++index];
		if (raw === undefined || raw.length === 0) return null;
		if (argument === "--source") {
			source = raw;
			continue;
		}
		const parsed = Number(raw);
		if (!Number.isSafeInteger(parsed) || parsed < 0) return null;
		if (argument === "--since") since = parsed;
		else if (argument === "--until") until = parsed;
		else if (argument === "--bucket-size-ms") {
			if (parsed < 1) return null;
			bucketSizeMs = parsed;
		} else if (argument === "--bucket-count") {
			if (parsed < 1 || parsed > MAX_USAGE_BUCKETS) return null;
			bucketCount = parsed;
		} else {
			if (parsed < 1 || parsed > USAGE_MAX_DISTINCT_SCOPES) return null;
			scopeLimit = parsed;
		}
	}
	if (
		source === undefined ||
		since === undefined ||
		until === undefined ||
		until < since ||
		bucketSizeMs === undefined ||
		bucketCount === undefined
	)
		return null;
	return { input: { source, since, until, bucketSizeMs, bucketCount, ...(scopeLimit === undefined ? {} : { scopeLimit }) }, json };
}

interface CostByTaskArgs {
	input: { since: number; until: number };
	json: boolean;
}

function parseCostByTaskArgs(args: string[]): CostByTaskArgs | null {
	let json = false;
	let since: number | undefined;
	let until: number | undefined;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--json") {
			json = true;
			continue;
		}
		if (!["--since", "--until"].includes(argument ?? "")) return null;
		const raw = args[++index];
		const parsed = Number(raw);
		if (!Number.isSafeInteger(parsed) || parsed < 0) return null;
		if (argument === "--since") since = parsed;
		else until = parsed;
	}
	if (since === undefined || until === undefined || until < since) return null;
	return { input: { since, until }, json };
}

interface MetricsPruneArgs {
	input: { before: number; force?: boolean };
	json: boolean;
}

function parseMetricsPruneArgs(args: string[]): MetricsPruneArgs | null {
	let json = false;
	let force = false;
	let before: number | undefined;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--json") {
			json = true;
			continue;
		}
		if (argument === "--force") {
			force = true;
			continue;
		}
		if (argument !== "--before") return null;
		const raw = args[++index];
		const parsed = Number(raw);
		if (!Number.isSafeInteger(parsed) || parsed < 0) return null;
		before = parsed;
	}
	if (before === undefined) return null;
	return { input: { before, ...(force ? { force } : {}) }, json };
}

export function formatMetricsQuery(rows: StoredMetricObservation[]): string {
	if (rows.length === 0) return "Metrics: no observations matched";
	const shown = rows.slice(0, CLI_METRICS_HUMAN_MAX_ROWS);
	const lines = [
		`Metrics: ${rows.length.toLocaleString()} observation(s)${rows.length > shown.length ? ` (showing first ${shown.length})` : ""}`,
		...shown.map(
			(row) =>
				`- ${humanField(row.source)}/${humanField(row.scope)}/${humanField(row.metric)} = ${row.value === null ? "null" : row.value} ${row.unit} @ ${new Date(row.observedAt).toISOString()}`,
		),
	];
	return lines.join("\n");
}

export function formatMetricsDistinctScopes(scopes: string[]): string {
	if (scopes.length === 0) return "Scopes: none matched";
	return [`Scopes: ${scopes.length.toLocaleString()}`, ...scopes.map((scope) => `- ${humanField(scope)}`)].join("\n");
}

export function formatMetricsUsageSeries(result: {
	rows: Array<{ scope: string; metric: string; bucketIndex: number; sum: number }>;
	truncated: boolean;
}): string {
	if (result.rows.length === 0) return `Usage series: no data${result.truncated ? " (scope limit reached)" : ""}`;
	const lines = [`Usage series: ${result.rows.length.toLocaleString()} bucket(s)${result.truncated ? " (scope limit reached)" : ""}`];
	for (const row of result.rows)
		lines.push(`- ${humanField(row.scope)}/${humanField(row.metric)} bucket ${row.bucketIndex}: ${row.sum.toLocaleString()}`);
	return lines.join("\n");
}

function formatUsdAmount(amount: number): string {
	return `$${amount.toFixed(Math.abs(amount) < 0.01 && amount !== 0 ? 4 : 2)}`;
}

export function formatCostByTask(summary: TaskCostSummary): string {
	const lines = [
		`Cost by task: ${summary.entries.length.toLocaleString()} task(s)${summary.truncated ? " (query limit reached; totals are a lower bound)" : ""}`,
		...summary.entries.flatMap((entry) => [
			`- ${humanField(entry.taskId)}: ${formatUsdAmount(entry.costUsd)} · ↑${entry.inputTokens.toLocaleString()} ↓${entry.outputTokens.toLocaleString()} R${entry.cacheReadTokens.toLocaleString()} W${entry.cacheWriteTokens.toLocaleString()}`,
			...entry.byModel.map(
				(model) =>
					`    · ${humanField(model.provider)}/${humanField(model.model)} (${humanField(model.thinking)}): ${formatUsdAmount(model.costUsd)} · ↑${model.inputTokens.toLocaleString()} ↓${model.outputTokens.toLocaleString()} R${model.cacheReadTokens.toLocaleString()} W${model.cacheWriteTokens.toLocaleString()}`,
			),
		]),
		`Unattributed spend (no task was focused): ${formatUsdAmount(summary.unattributedCostUsd)}`,
	];
	return lines.join("\n");
}

export async function runMetricsCommand(
	action: string | undefined,
	rest: string[],
	deps: CliDependencies,
	usage: () => number,
): Promise<number> {
	if (action === "record") {
		const parsed = parseMetricsRecordArgs(rest);
		if (!parsed) return usage();
		return callAndPrint(deps, "metrics.record", parsed.input, parsed.json, (row) => formatMetricsQuery([row]));
	}
	if (action === "record-batch") {
		const parsed = parseMetricsRecordBatchArgs(rest);
		if (!parsed) return usage();
		return callAndPrint(deps, "metrics.record_batch", parsed.input, parsed.json, formatMetricsQuery);
	}
	if (action === "query") {
		const parsed = parseMetricsQueryArgs(rest);
		if (!parsed) return usage();
		return callAndPrint(deps, "metrics.query", parsed.input, parsed.json, formatMetricsQuery);
	}
	if (action === "prune") {
		const parsed = parseMetricsPruneArgs(rest);
		if (!parsed) return usage();
		return callAndPrint(
			deps,
			"metrics.prune",
			parsed.input,
			parsed.json,
			(result) => `Pruned ${result.deleted.toLocaleString()} observation(s)`,
		);
	}
	if (action === "distinct-scopes") {
		const parsed = parseMetricsDistinctScopesArgs(rest);
		if (!parsed) return usage();
		return callAndPrint(deps, "metrics.distinct_scopes", parsed.input, parsed.json, formatMetricsDistinctScopes);
	}
	if (action === "usage-series") {
		const parsed = parseMetricsUsageSeriesArgs(rest);
		if (!parsed) return usage();
		return callAndPrint(deps, "metrics.usage_series", parsed.input, parsed.json, formatMetricsUsageSeries);
	}
	if (action === "cost-by-task") {
		const parsed = parseCostByTaskArgs(rest);
		if (!parsed) return usage();
		return callAndPrint(deps, "metrics.cost_by_task", parsed.input, parsed.json, formatCostByTask);
	}
	return usage();
}
