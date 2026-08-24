import { describe, expect, it } from "bun:test";
import { applyTaskFocusEvent, declaredEffortFromTaskFocusEvent, validateTaskFocusEvent } from "../src/observability/task-focus.ts";

function payload(overrides: Record<string, unknown> = {}) {
	return {
		schema: "papyrus.task-focus/v1",
		taskId: "ship-feature-x",
		sessionId: "session-1",
		status: "focused",
		observedAt: 1_000,
		...overrides,
	};
}

describe("Papyrus task-focus event validation", () => {
	it("accepts a well-formed focused/paused/unpaused event", () => {
		const event = validateTaskFocusEvent(payload(), 1_500);
		expect(event).toEqual({
			schema: "papyrus.task-focus/v1",
			taskId: "ship-feature-x",
			sessionId: "session-1",
			status: "focused",
			observedAt: 1_000,
		});
	});

	it("accepts a cleared event with a null taskId and no sessionId", () => {
		const event = validateTaskFocusEvent({ schema: "papyrus.task-focus/v1", taskId: null, status: "cleared", observedAt: 1_000 }, 1_500);
		expect(event).toEqual({ schema: "papyrus.task-focus/v1", taskId: null, status: "cleared", observedAt: 1_000 });
	});

	it("fails closed on schema drift, unknown status, staleness, oversized fields, and unexpected fields", () => {
		expect(() => validateTaskFocusEvent(payload({ schema: "v2" }), 1_500)).toThrow("schema");
		expect(() => validateTaskFocusEvent(payload({ status: "archived" }), 1_500)).toThrow("status");
		expect(() => validateTaskFocusEvent(payload(), 1_000 + 10 * 60_000)).toThrow("stale");
		expect(() => validateTaskFocusEvent(payload({ taskId: "x".repeat(500) }), 1_500)).toThrow("bounded");
		expect(() => validateTaskFocusEvent(payload({ extra: "unexpected" }), 1_500)).toThrow("unexpected field");
		expect(() => validateTaskFocusEvent(payload({ observedAt: -1 }), 1_500)).toThrow("non-negative integer");
	});

	it("accepts an optional effort declared by the focused task, one of low/medium/high", () => {
		expect(validateTaskFocusEvent(payload({ effort: "high" }), 1_500)).toEqual({
			schema: "papyrus.task-focus/v1",
			taskId: "ship-feature-x",
			sessionId: "session-1",
			status: "focused",
			observedAt: 1_000,
			effort: "high",
		});
	});

	it("omits effort when the payload doesn't declare one, rather than defaulting it", () => {
		expect(validateTaskFocusEvent(payload(), 1_500)).not.toHaveProperty("effort");
	});

	it("fails closed on a malformed or out-of-range effort value, the same as any other unrecognized field value", () => {
		expect(() => validateTaskFocusEvent(payload({ effort: "extreme" }), 1_500)).toThrow("effort");
		expect(() => validateTaskFocusEvent(payload({ effort: 3 }), 1_500)).toThrow("effort");
	});

	it("requires a taskId for focused/paused/unpaused, but not for cleared", () => {
		expect(() => validateTaskFocusEvent(payload({ status: "focused", taskId: null }), 1_500)).toThrow("requires a taskId");
		expect(() => validateTaskFocusEvent(payload({ status: "paused", taskId: null }), 1_500)).toThrow("requires a taskId");
		expect(() => validateTaskFocusEvent(payload({ status: "unpaused", taskId: null }), 1_500)).toThrow("requires a taskId");
		expect(() =>
			validateTaskFocusEvent({ schema: "papyrus.task-focus/v1", taskId: null, status: "cleared", observedAt: 1_000 }, 1_500),
		).not.toThrow();
	});
});

describe("Task focus state application", () => {
	it("sets the tracked task id on focused and unpaused", () => {
		expect(applyTaskFocusEvent(validateTaskFocusEvent(payload({ status: "focused" }), 1_500))).toBe("ship-feature-x");
		expect(applyTaskFocusEvent(validateTaskFocusEvent(payload({ status: "unpaused" }), 1_500))).toBe("ship-feature-x");
	});

	it("clears the tracked task id on paused and cleared, even though Papyrus itself keeps the pause state", () => {
		expect(applyTaskFocusEvent(validateTaskFocusEvent(payload({ status: "paused" }), 1_500))).toBeNull();
		expect(
			applyTaskFocusEvent(
				validateTaskFocusEvent({ schema: "papyrus.task-focus/v1", taskId: null, status: "cleared", observedAt: 1_000 }, 1_500),
			),
		).toBeNull();
	});

	it("pins the declared effort on focused and unpaused", () => {
		expect(declaredEffortFromTaskFocusEvent(validateTaskFocusEvent(payload({ status: "focused", effort: "high" }), 1_500))).toBe("high");
		expect(declaredEffortFromTaskFocusEvent(validateTaskFocusEvent(payload({ status: "unpaused", effort: "low" }), 1_500))).toBe("low");
	});

	it("has no declared effort when the focused task declares none", () => {
		expect(declaredEffortFromTaskFocusEvent(validateTaskFocusEvent(payload({ status: "focused" }), 1_500))).toBeNull();
	});

	it("drops the declared effort on paused and cleared, mirroring the tracked task id's own semantics", () => {
		expect(declaredEffortFromTaskFocusEvent(validateTaskFocusEvent(payload({ status: "paused", effort: "high" }), 1_500))).toBeNull();
		expect(
			declaredEffortFromTaskFocusEvent(
				validateTaskFocusEvent({ schema: "papyrus.task-focus/v1", taskId: null, status: "cleared", observedAt: 1_000 }, 1_500),
			),
		).toBeNull();
	});
});
