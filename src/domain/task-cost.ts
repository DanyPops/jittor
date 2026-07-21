import type { StoredMetricObservation } from "./metric.ts";

export interface TaskCostEntry {
	taskId: string;
	costUsd: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
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

function entryFor(byTask: Map<string, TaskCostEntry>, taskId: string): TaskCostEntry {
	const existing = byTask.get(taskId);
	if (existing) return existing;
	const created: TaskCostEntry = { taskId, costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
	byTask.set(taskId, created);
	return created;
}

/**
 * Groups already-recorded "pi" source cost/token metrics by the Papyrus task focused when each was
 * recorded (see the papyrus.task-focus.v1 real-time tagging in the extension), rather than by
 * provider/model identity. Rows recorded with nothing focused have no attributes.taskId and are
 * reported separately as unattributedCostUsd -- they are real spend, just not attributable to any
 * task, and must never be silently dropped or folded into an invented "unknown" task bucket.
 *
 * This queries a single bounded time window without per-task fairness partitioning (unlike
 * buildUsageGraph/buildCostGraph's per-scope fetch): a task's own working period is typically a far
 * narrower, more targeted window than "the whole usage dashboard, any period", so one task's volume
 * crowding another out of the same query is a much smaller risk here. If this does become a problem
 * in practice, the same per-distinct-value fetch strategy applies, keyed by attributes.taskId.
 */
export function buildTaskCostSummary(rows: StoredMetricObservation[], options: TaskCostSummaryOptions): TaskCostSummary {
	const byTask = new Map<string, TaskCostEntry>();
	let unattributedCostUsd = 0;
	for (const row of rows) {
		if (row.source !== "pi" || typeof row.value !== "number" || !Number.isFinite(row.value) || row.value < 0) continue;
		if (row.observedAt < options.since || row.observedAt > options.until) continue;
		const taskId = typeof row.attributes["taskId"] === "string" ? row.attributes["taskId"] : undefined;
		if (row.metric === "cost" && row.unit === "usd") {
			if (taskId === undefined) { unattributedCostUsd += row.value; continue; }
			entryFor(byTask, taskId).costUsd += row.value;
			continue;
		}
		if (taskId === undefined || row.unit !== "tokens" || !TOKEN_METRICS.has(row.metric)) continue;
		const entry = entryFor(byTask, taskId);
		if (row.metric === "input-tokens") entry.inputTokens += row.value;
		else if (row.metric === "output-tokens") entry.outputTokens += row.value;
		else if (row.metric === "cache-read-tokens") entry.cacheReadTokens += row.value;
		else entry.cacheWriteTokens += row.value;
	}
	const entries = [...byTask.values()].sort((left, right) => right.costUsd - left.costUsd || left.taskId.localeCompare(right.taskId));
	return { since: options.since, until: options.until, entries, unattributedCostUsd, truncated: options.truncated === true };
}
