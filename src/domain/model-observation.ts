import {
	MODEL_AGGREGATE_MAX_GROUPS,
	MODEL_AGGREGATE_MAX_ROWS,
	MODEL_OBSERVATION_FRESH_MS,
	MODEL_OBSERVATION_IDENTITY_MAX_CHARACTERS,
} from "../constants.ts";
import { normalizeModelIdentity } from "./benchmark.ts";
import type { MetricObservation, MetricUnit, StoredMetricObservation } from "./metric.ts";

export const TASK_CLASSES = ["coding", "research", "planning", "general"] as const;
export type ModelTaskClass = typeof TASK_CLASSES[number];
export type ExplicitOutcome = "accepted" | "rejected" | "unknown";

export interface ModelRunObservation {
	runId: string;
	provider: string;
	model: string;
	thinking: string;
	taskClass: ModelTaskClass;
	startedAt: number;
	firstTokenAt: number | null;
	completedAt: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	costUsd: number;
	providerResponses: number;
	toolCalls: number;
	toolFailures: number;
	stopReason: "stop" | "length" | "toolUse" | "error" | "aborted" | "unknown";
	explicitOutcome: ExplicitOutcome;
}

export interface ModelMetricAggregate {
	provider: string;
	model: string;
	thinking: string;
	taskClass: ModelTaskClass;
	dimension: string;
	unit: MetricUnit;
	sampleSize: number;
	median: number;
	p90: number;
	medianAbsoluteDeviation: number;
	latestAt: number;
	freshness: "fresh" | "stale";
	confidence: number;
}

export interface ModelAggregateOptions {
	now?: number;
	freshForMs?: number;
}

const ALLOWED_FIELDS = new Set<keyof ModelRunObservation>([
	"runId", "provider", "model", "thinking", "taskClass", "startedAt", "firstTokenAt", "completedAt",
	"inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "costUsd", "providerResponses",
	"toolCalls", "toolFailures", "stopReason", "explicitOutcome",
]);
const STOP_REASONS = new Set<ModelRunObservation["stopReason"]>(["stop", "length", "toolUse", "error", "aborted", "unknown"]);
const OUTCOMES = new Set<ExplicitOutcome>(["accepted", "rejected", "unknown"]);

function text(value: unknown, name: string): string {
	if (typeof value !== "string" || value.length === 0 || value.length > MODEL_OBSERVATION_IDENTITY_MAX_CHARACTERS || /\p{Cc}/u.test(value)) throw new Error(`${name} is invalid`);
	return value;
}

function nonNegative(value: unknown, name: string, integer = false): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (integer && !Number.isSafeInteger(value))) throw new Error(`${name} is invalid`);
	return value;
}

export function validateModelRunObservation(value: unknown): ModelRunObservation {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("model run observation must be an object");
	const input = value as Record<string, unknown>;
	for (const key of Object.keys(input)) if (!ALLOWED_FIELDS.has(key as keyof ModelRunObservation)) throw new Error(`unsupported field: ${key}`);
	const identity = normalizeModelIdentity(text(input["provider"], "provider"), text(input["model"], "model"));
	const startedAt = nonNegative(input["startedAt"], "start time", true);
	const completedAt = nonNegative(input["completedAt"], "completion time", true);
	const firstTokenAt = input["firstTokenAt"] === null ? null : nonNegative(input["firstTokenAt"], "first-token time", true);
	if (completedAt < startedAt || (firstTokenAt !== null && (firstTokenAt < startedAt || firstTokenAt > completedAt))) throw new Error("model run timestamps are not ordered");
	if (!TASK_CLASSES.includes(input["taskClass"] as ModelTaskClass)) throw new Error("task class is invalid");
	if (!STOP_REASONS.has(input["stopReason"] as ModelRunObservation["stopReason"])) throw new Error("stop reason is invalid");
	if (!OUTCOMES.has(input["explicitOutcome"] as ExplicitOutcome)) throw new Error("explicit outcome is invalid");
	const providerResponses = nonNegative(input["providerResponses"], "provider response count", true);
	const toolCalls = nonNegative(input["toolCalls"], "tool call count", true);
	const toolFailures = nonNegative(input["toolFailures"], "tool failure count", true);
	if (providerResponses < 1 || toolFailures > toolCalls) throw new Error("model run counters are inconsistent");
	return {
		runId: text(input["runId"], "run id"), provider: identity.provider, model: identity.model,
		thinking: text(input["thinking"], "thinking level"), taskClass: input["taskClass"] as ModelTaskClass,
		startedAt, firstTokenAt, completedAt,
		inputTokens: nonNegative(input["inputTokens"], "input tokens"),
		outputTokens: nonNegative(input["outputTokens"], "output tokens"),
		cacheReadTokens: nonNegative(input["cacheReadTokens"], "cache read tokens"),
		cacheWriteTokens: nonNegative(input["cacheWriteTokens"], "cache write tokens"),
		costUsd: nonNegative(input["costUsd"], "cost"), providerResponses, toolCalls, toolFailures,
		stopReason: input["stopReason"] as ModelRunObservation["stopReason"], explicitOutcome: input["explicitOutcome"] as ExplicitOutcome,
	};
}

export function classifyTaskFromTools(toolNames: string[]): ModelTaskClass {
	const names = new Set(toolNames.slice(0, 100).map((name) => name.toLowerCase()));
	if (["edit", "write", "read", "bash", "grep", "find", "ls"].some((name) => names.has(name))) return "coding";
	if (["web_fetch", "web_search"].some((name) => names.has(name))) return "research";
	if (["tasks", "papyrus_create", "papyrus_graph"].some((name) => names.has(name))) return "planning";
	return "general";
}

export function modelRunMetrics(value: ModelRunObservation): MetricObservation[] {
	const run = validateModelRunObservation(value);
	const scope = `${run.provider}/${run.model}`;
	const attributes = { provider: run.provider, model: run.model, thinking: run.thinking, taskClass: run.taskClass, runId: run.runId };
	const metric = (name: string, amount: number, unit: MetricUnit): MetricObservation => ({ source: "local-model", scope, metric: name, value: amount, unit, observedAt: run.completedAt, attributes });
	const wallMs = run.completedAt - run.startedAt;
	const totalInput = run.inputTokens + run.cacheReadTokens;
	const metrics: MetricObservation[] = [];
	if (run.firstTokenAt !== null) metrics.push(metric("ttft", run.firstTokenAt - run.startedAt, "milliseconds"));
	metrics.push(
		metric("wall-latency", wallMs, "milliseconds"),
		metric("output-throughput", wallMs === 0 ? 0 : run.outputTokens / (wallMs / 1_000), "tokens-per-second"),
		metric("input-tokens", run.inputTokens, "tokens"),
		metric("output-tokens", run.outputTokens, "tokens"),
		metric("cache-read-tokens", run.cacheReadTokens, "tokens"),
		metric("cache-write-tokens", run.cacheWriteTokens, "tokens"),
		metric("cache-read-ratio", totalInput === 0 ? 0 : run.cacheReadTokens / totalInput, "ratio"),
		metric("cost", run.costUsd, "usd"),
		metric("provider-responses", run.providerResponses, "count"),
		metric("retry-count", Math.max(0, run.providerResponses - 1), "count"),
		metric("tool-calls", run.toolCalls, "count"),
		metric("tool-failures", run.toolFailures, "count"),
		metric("failure", run.stopReason === "error" ? 1 : 0, "ratio"),
	);
	if (run.explicitOutcome !== "unknown") metrics.push(metric("outcome-accepted", run.explicitOutcome === "accepted" ? 1 : 0, "ratio"));
	return metrics;
}

function percentile(sorted: number[], fraction: number): number {
	return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!;
}

function median(sorted: number[]): number {
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

export function aggregateModelMetrics(input: StoredMetricObservation[], options: ModelAggregateOptions = {}): ModelMetricAggregate[] {
	const now = options.now ?? Date.now();
	const freshForMs = options.freshForMs ?? MODEL_OBSERVATION_FRESH_MS;
	if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(freshForMs) || freshForMs <= 0) throw new Error("aggregate time bounds are invalid");
	const groups = new Map<string, StoredMetricObservation[]>();
	for (const row of input.slice(0, MODEL_AGGREGATE_MAX_ROWS)) {
		if (row.source !== "local-model" || typeof row.value !== "number" || !Number.isFinite(row.value)) continue;
		const provider = row.attributes["provider"];
		const model = row.attributes["model"];
		const thinking = row.attributes["thinking"];
		const taskClass = row.attributes["taskClass"];
		if (typeof provider !== "string" || typeof model !== "string" || typeof thinking !== "string" || !TASK_CLASSES.includes(taskClass as ModelTaskClass)) continue;
		const key = JSON.stringify([provider, model, thinking, taskClass, row.metric, row.unit]);
		if (!groups.has(key) && groups.size >= MODEL_AGGREGATE_MAX_GROUPS) continue;
		const rows = groups.get(key) ?? [];
		rows.push(row);
		groups.set(key, rows);
	}
	return [...groups.entries()].map(([key, rows]) => {
		const [provider, model, thinking, taskClass, dimension, unit] = JSON.parse(key) as [string, string, string, ModelTaskClass, string, MetricUnit];
		const values = rows.map((row) => row.value as number).sort((left, right) => left - right);
		const center = median(values);
		const deviations = values.map((value) => Math.abs(value - center)).sort((left, right) => left - right);
		const latestAt = Math.max(...rows.map((row) => row.observedAt));
		const age = Math.max(0, now - latestAt);
		const recency = Math.max(0, 1 - (age / freshForMs));
		return {
			provider, model, thinking, taskClass, dimension, unit,
			sampleSize: values.length, median: center, p90: percentile(values, 0.9), medianAbsoluteDeviation: median(deviations), latestAt,
			freshness: age <= freshForMs ? "fresh" as const : "stale" as const,
			confidence: Math.min(1, Math.sqrt(values.length / 20)) * recency,
		};
	}).sort((left, right) => left.provider.localeCompare(right.provider) || left.model.localeCompare(right.model) || left.dimension.localeCompare(right.dimension));
}
