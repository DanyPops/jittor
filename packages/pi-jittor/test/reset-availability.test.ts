import { expect, it } from "bun:test";
import type { RouterStatus, StoredMetricObservation } from "@danypops/jittor";
import { buildFooterBudget, buildStatusView, fetchStatusSnapshot, formatFooterStatus } from "../extension/src/observability/status.ts";

const now = 1_800_000_000_000;
const status: RouterStatus = {
	ready: true,
	paused: false,
	lastDecision: null,
	override: null,
	availableRoutes: [],
	currentRoute: { provider: "openai-codex", model: "synthetic-model", thinking: "medium" },
	sources: [{ id: "codex-subscription", provider: "openai-codex", ok: true, metrics: 2, observedAt: now }],
};
const window: StoredMetricObservation = {
	id: 1,
	source: "codex-subscription",
	scope: "codex:primary",
	metric: "used-fraction",
	value: 1,
	unit: "ratio",
	observedAt: now,
	attributes: { limitId: "codex", windowSeconds: 604800, resetsAt: now / 1000 + 5000 },
};
const resets: StoredMetricObservation = {
	id: 2,
	source: "codex-subscription",
	scope: "codex:resets",
	metric: "available-resets",
	value: 1,
	unit: "count",
	observedAt: now,
	attributes: {},
};

it("shows banked resets even when the budget is exhausted", () => {
	expect(buildFooterBudget(status, [window, resets], now)).toMatchObject({ availableResets: { count: 1, observedAt: now } });
	expect(formatFooterStatus(status, [window, resets], now)).toContain("1 reset available");
	expect(buildStatusView(status, [window, resets], now).join("\n")).toContain("1 reset available");
});
it("does not resurrect older reset counts", () => {
	for (const value of [0, null]) {
		const latest = { ...resets, id: 3, observedAt: now + 1, value };
		expect(formatFooterStatus(status, [window, resets, latest], now + 1)).not.toContain("reset available");
	}
});
it("omits stale and failed reset observations", () => {
	expect(formatFooterStatus(status, [window, { ...resets, observedAt: now - 600000 }], now)).not.toContain("reset available");
	const failed = { ...status, sources: status.sources.map((s) => ({ ...s, ok: false })) };
	expect(formatFooterStatus(failed, [window, resets], now)).not.toContain("reset available");
});
it("keeps reset grants visible while quota reset is pending", () => {
	expect(
		formatFooterStatus(status, [{ ...window, attributes: { ...window.attributes, resetsAt: now / 1000 - 1 } }, resets], now),
	).toContain("1 reset available");
});
it("queries the latest reset count independently of window history", async () => {
	const inputs: unknown[] = [];
	const snapshot = await fetchStatusSnapshot(
		{
			call: async (op, input) => {
				if (op === "router.status") return status;
				inputs.push(input);
				return (input as { metric: string }).metric === "available-resets" ? [resets] : [window];
			},
		},
		"synthetic-session",
	);
	expect(snapshot.metrics).toContainEqual(resets);
	expect(inputs).toContainEqual({
		source: "codex-subscription",
		scope: "codex:resets",
		metric: "available-resets",
		order: "desc",
		limit: 1,
	});
});
