import { describe, expect, it } from "bun:test";
import { buildTaskCostSummary } from "../src/domain/task-cost.ts";
import type { StoredMetricObservation } from "../src/domain/metric.ts";

let nextId = 1;

function row(overrides: Partial<StoredMetricObservation> & { observedAt: number }): StoredMetricObservation {
	return {
		id: nextId++, source: "pi", scope: "anthropic:claude-sonnet-5", metric: "cost", value: 0, unit: "usd", attributes: {},
		...overrides,
	};
}

describe("Task cost summary", () => {
	it("groups cost and token metrics by the taskId tagged at record time, ignoring provider/model identity", () => {
		const rows = [
			row({ observedAt: 1_000, metric: "cost", value: 0.05, unit: "usd", attributes: { taskId: "ship-feature-x" } }),
			row({ observedAt: 1_100, metric: "input-tokens", value: 1_000, unit: "tokens", attributes: { taskId: "ship-feature-x" } }),
			row({ observedAt: 1_200, metric: "output-tokens", value: 200, unit: "tokens", attributes: { taskId: "ship-feature-x" } }),
			row({ observedAt: 1_300, metric: "cache-read-tokens", value: 5_000, unit: "tokens", attributes: { taskId: "ship-feature-x" } }),
			row({ observedAt: 1_400, metric: "cache-write-tokens", value: 500, unit: "tokens", attributes: { taskId: "ship-feature-x" } }),
			row({ observedAt: 1_500, metric: "cost", value: 0.02, unit: "usd", attributes: { taskId: "fix-bug-y" } }),
		];
		const summary = buildTaskCostSummary(rows, { since: 0, until: 2_000 });
		expect(summary.entries).toEqual([
			{ taskId: "ship-feature-x", costUsd: 0.05, inputTokens: 1_000, outputTokens: 200, cacheReadTokens: 5_000, cacheWriteTokens: 500 },
			{ taskId: "fix-bug-y", costUsd: 0.02, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
		]);
		expect(summary.unattributedCostUsd).toBe(0);
	});

	it("reports spend recorded with nothing focused as unattributed, never dropped or folded into a task", () => {
		const rows = [
			row({ observedAt: 1_000, metric: "cost", value: 0.03, unit: "usd", attributes: {} }),
			row({ observedAt: 1_100, metric: "cost", value: 0.01, unit: "usd", attributes: { taskId: "ship-feature-x" } }),
		];
		const summary = buildTaskCostSummary(rows, { since: 0, until: 2_000 });
		expect(summary.unattributedCostUsd).toBeCloseTo(0.03);
		expect(summary.entries).toEqual([{ taskId: "ship-feature-x", costUsd: 0.01, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }]);
	});

	it("ignores token metrics that have no taskId (nothing to attribute them to), negative values, and rows outside the window", () => {
		const rows = [
			row({ observedAt: 1_000, metric: "input-tokens", value: 1_000, unit: "tokens", attributes: {} }),
			row({ observedAt: 1_100, metric: "cost", value: -5, unit: "usd", attributes: { taskId: "ship-feature-x" } }),
			row({ observedAt: 50, metric: "cost", value: 0.09, unit: "usd", attributes: { taskId: "ship-feature-x" } }),
			row({ observedAt: 9_000, metric: "cost", value: 0.09, unit: "usd", attributes: { taskId: "ship-feature-x" } }),
		];
		const summary = buildTaskCostSummary(rows, { since: 100, until: 2_000 });
		expect(summary.entries).toEqual([]);
		expect(summary.unattributedCostUsd).toBe(0);
	});

	it("ignores metrics from other sources even if they happen to carry a taskId attribute", () => {
		const rows = [row({ observedAt: 1_000, source: "openrouter", metric: "cost", value: 5, unit: "usd", attributes: { taskId: "ship-feature-x" } })];
		expect(buildTaskCostSummary(rows, { since: 0, until: 2_000 }).entries).toEqual([]);
	});

	it("sorts entries by cost descending, breaking ties by taskId, and carries the truncated flag through", () => {
		const rows = [
			row({ observedAt: 1_000, metric: "cost", value: 0.01, unit: "usd", attributes: { taskId: "b-task" } }),
			row({ observedAt: 1_000, metric: "cost", value: 0.01, unit: "usd", attributes: { taskId: "a-task" } }),
			row({ observedAt: 1_000, metric: "cost", value: 0.05, unit: "usd", attributes: { taskId: "c-task" } }),
		];
		const summary = buildTaskCostSummary(rows, { since: 0, until: 2_000, truncated: true });
		expect(summary.entries.map((entry) => entry.taskId)).toEqual(["c-task", "a-task", "b-task"]);
		expect(summary.truncated).toBe(true);
	});
});
