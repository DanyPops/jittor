import { describe, expect, it } from "bun:test";
import { evaluateRoutingPolicy, type BudgetWindow, type PolicyInput, type Route } from "../src/policy.ts";
import { DEFAULT_POLICY } from "../src/config.ts";

const now = 1_700_000_000_000;
const current: Route = { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" };
const routes: Route[] = [
	current,
	{ provider: "openai-codex", model: "gpt-5.6-sol", thinking: "medium" },
	{ provider: "openai-codex", model: "gpt-5.3-codex", thinking: "medium" },
	{ provider: "openrouter", model: "openai/gpt-4.1-mini", thinking: "medium" },
];

function atPressure(pressure: number, overrides: Partial<BudgetWindow> = {}): PolicyInput {
	const remainingFraction = 0.8;
	const remainingSeconds = 14_400;
	return {
		now,
		windows: [{
			id: "codex:primary@calibration", source: "codex-subscription", scope: "codex:primary",
			usedFraction: 0.2, observedBurnPerSecond: pressure * (remainingFraction / remainingSeconds),
			windowSeconds: 18_000, resetsAt: now + remainingSeconds * 1_000,
			observedAt: now, freshness: "fresh", confidence: 0.8, ...overrides,
		}],
		currentRoute: current,
		routes,
		config: DEFAULT_POLICY,
	};
}

describe("calibrated routing scenarios", () => {
	it("covers warning, throttle, thinking downgrade, and handoffs", () => {
		expect(evaluateRoutingPolicy(atPressure(0.9)).action).toBe("continue");
		expect(evaluateRoutingPolicy(atPressure(1.1))).toMatchObject({ action: "throttle" });
		expect(evaluateRoutingPolicy(atPressure(1.3))).toMatchObject({ action: "lower-thinking", route: routes[1] });
		expect(evaluateRoutingPolicy(atPressure(1.7))).toMatchObject({ action: "switch-model", route: routes[2] });
		expect(evaluateRoutingPolicy(atPressure(2.2))).toMatchObject({ action: "switch-provider", route: routes[3] });
	});

	it("fails closed for stale telemetry and hard-halt pressure", () => {
		expect(evaluateRoutingPolicy(atPressure(0.5, { observedAt: now - DEFAULT_POLICY.maxTelemetryAgeMs - 1 })).action).toBe("halt");
		expect(evaluateRoutingPolicy(atPressure(3.1)).action).toBe("halt");
		expect(evaluateRoutingPolicy(atPressure(0, { usedFraction: DEFAULT_POLICY.hardStopUsedFraction })).action).toBe("halt");
	});

	it("holds a degraded route during cooldown to prevent oscillation", () => {
		const input = atPressure(0.9);
		input.previousDecision = {
			action: "lower-thinking", pressure: 1.3, decidedAt: now - 60_000, route: routes[1],
		};
		expect(evaluateRoutingPolicy(input)).toMatchObject({ action: "lower-thinking", route: routes[1] });
	});
});
