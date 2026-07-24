import type { StoredMetricObservation } from "./metric.ts";

export interface TaskCostBreakdown {
	provider: string;
	model: string;
	thinking: string;
	costUsd: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
}

export interface TaskCostEntry {
	taskId: string;
	costUsd: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	byModel: TaskCostBreakdown[];
}

export interface TaskCostSummary {
	since: number;
	until: number;
	entries: TaskCostEntry[];
	unattributedCostUsd: number;
	truncated: boolean;
}

export interface TaskCostSummaryOptions {
	since: number;
	until: number;
	truncated?: boolean;
}

const TOKEN_METRICS = new Set(["input-tokens", "output-tokens", "cache-read-tokens", "cache-write-tokens"]);

function attributeText(attributes: Record<string, unknown>, key: string): string {
	return typeof attributes[key] === "string" && attributes[key].length > 0 ? attributes[key] : "unknown";
}

function entryFor(byTask: Map<string, TaskCostEntry>, taskId: string): TaskCostEntry {
	const existing = byTask.get(taskId);
	if (existing) return existing;
	const created: TaskCostEntry = { taskId, costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, byModel: [] };
	byTask.set(taskId, created);
	return created;
}

function breakdownFor(byModel: Map<string, TaskCostBreakdown>, provider: string, model: string, thinking: string): TaskCostBreakdown {
	const key = `${provider}\u0000${model}\u0000${thinking}`;
	const existing = byModel.get(key);
	if (existing) return existing;
	const created: TaskCostBreakdown = { provider, model, thinking, costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
	byModel.set(key, created);
	return created;
}

/**
 * Groups already-recorded "pi" source cost/token metrics by the Papyrus task focused when each was
 * recorded (see the papyrus.task-focus.v1 real-time tagging in the extension), with a secondary
 * breakdown per provider/model/thinking within each task. Rows recorded with nothing focused have
 * no attributes.taskId and are reported separately as unattributedCostUsd -- they are real spend,
 * just not attributable to any task, and must never be silently dropped or folded into an invented
 * "unknown" task bucket. A row missing provider/model/thinking (recorded before that attribution
 * existed) falls into an "unknown" breakdown bucket instead, since the task-level total is real.
 *
 * This queries a single bounded time window without per-task fairness partitioning (unlike
 * buildUsageGraph/buildCostGraph's per-scope fetch): a task's own working period is typically a far
 * narrower, more targeted window than "the whole usage dashboard, any period", so one task's volume
 * crowding another out of the same query is a much smaller risk here. If this does become a problem
 * in practice, the same per-distinct-value fetch strategy applies, keyed by attributes.taskId.
 */
export function buildTaskCostSummary(rows: StoredMetricObservation[], options: TaskCostSummaryOptions): TaskCostSummary {
	const byTask = new Map<string, TaskCostEntry>();
	const byTaskModel = new Map<string, Map<string, TaskCostBreakdown>>();
	let unattributedCostUsd = 0;
	for (const row of rows) {
		if (row.source !== "pi" || typeof row.value !== "number" || !Number.isFinite(row.value) || row.value < 0) continue;
		if (row.observedAt < options.since || row.observedAt > options.until) continue;
		const taskId = typeof row.attributes["taskId"] === "string" ? row.attributes["taskId"] : undefined;
		if (row.metric === "cost" && row.unit === "usd") {
			if (taskId === undefined) { unattributedCostUsd += row.value; continue; }
			entryFor(byTask, taskId).costUsd += row.value;
			if (!byTaskModel.has(taskId)) byTaskModel.set(taskId, new Map());
			breakdownFor(byTaskModel.get(taskId)!, attributeText(row.attributes, "provider"), attributeText(row.attributes, "model"), attributeText(row.attributes, "thinking")).costUsd += row.value;
			continue;
		}
		if (taskId === undefined || row.unit !== "tokens" || !TOKEN_METRICS.has(row.metric)) continue;
		const entry = entryFor(byTask, taskId);
		if (!byTaskModel.has(taskId)) byTaskModel.set(taskId, new Map());
		const breakdown = breakdownFor(byTaskModel.get(taskId)!, attributeText(row.attributes, "provider"), attributeText(row.attributes, "model"), attributeText(row.attributes, "thinking"));
		if (row.metric === "input-tokens") { entry.inputTokens += row.value; breakdown.inputTokens += row.value; }
		else if (row.metric === "output-tokens") { entry.outputTokens += row.value; breakdown.outputTokens += row.value; }
		else if (row.metric === "cache-read-tokens") { entry.cacheReadTokens += row.value; breakdown.cacheReadTokens += row.value; }
		else { entry.cacheWriteTokens += row.value; breakdown.cacheWriteTokens += row.value; }
	}
	for (const [taskId, entry] of byTask) {
		entry.byModel = [...(byTaskModel.get(taskId)?.values() ?? [])].sort((left, right) => right.costUsd - left.costUsd || left.model.localeCompare(right.model));
	}
	const entries = [...byTask.values()].sort((left, right) => right.costUsd - left.costUsd || left.taskId.localeCompare(right.taskId));
	return { since: options.since, until: options.until, entries, unattributedCostUsd, truncated: options.truncated === true };
}
