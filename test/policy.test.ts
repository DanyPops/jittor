import { describe, expect, it } from "bun:test";
import {
	evaluateRoutingPolicy,
	type BudgetWindow,
	type PolicyInput,
	type Route,
} from "../src/policy.ts";

const now = 1_700_000_000_000;
const current: Route = { provider: "openai-codex", model: "gpt-5.3-codex", thinking: "high" };
const routes: Route[] = [
	current,
	{ provider: "openai-codex", model: "gpt-5.3-codex", thinking: "medium" },
	{ provider: "openai-codex", model: "gpt-5.1-codex-mini", thinking: "medium" },
	{ provider: "openrouter", model: "openai/gpt-4.1-mini", thinking: "medium" },
];

function window(overrides: Partial<BudgetWindow> = {}): BudgetWindow {
	return {
		id: "codex:primary@1",
		source: "codex-subscription",
		scope: "codex:primary",
		usedFraction: 0.2,
		windowSeconds: 18_000,
		resetsAt: now + 14_400_000,
		observedAt: now,
		freshness: "fresh",
		confidence: 1,
		...overrides,
	};
}

function input(overrides: Partial<PolicyInput> = {}): PolicyInput {
	return {
		now,
		windows: [window()],
		currentRoute: current,
		routes,
		config: {
			maxTelemetryAgeMs: 120_000,
			cooldownMs: 300_000,
			hysteresisFraction: 0.1,
			thresholds: { throttle: 1, lowerThinking: 1.25, switchModel: 1.5, switchProvider: 2, halt: 3 },
			maxThrottleMs: 30_000,
			hardStopUsedFraction: 0.99,
		},
		...overrides,
	};
}

describe("budget pressure routing policy", () => {
	it("continues when observed consumption is sustainable", () => {
		const decision = evaluateRoutingPolicy(input());
		expect(decision.action).toBe("continue");
		expect(decision.pressure).toBeCloseTo(1, 5);
		expect(decision.trace.some((entry) => entry.includes("sustainable"))).toBe(true);
	});

	it("walks the deterministic degradation ladder", () => {
		const atPressure = (pressure: number) => input({
			windows: [window({ observedBurnPerSecond: pressure * (0.8 / 14_400) })],
		});
		expect(evaluateRoutingPolicy(atPressure(1.1)).action).toBe("throttle");
		expect(evaluateRoutingPolicy(atPressure(1.3))).toMatchObject({ action: "lower-thinking", route: routes[1] });
		expect(evaluateRoutingPolicy(atPressure(1.7))).toMatchObject({ action: "switch-model", route: routes[2] });
		expect(evaluateRoutingPolicy(atPressure(2.2))).toMatchObject({ action: "switch-provider", route: routes[3] });
		expect(evaluateRoutingPolicy(atPressure(3.2)).action).toBe("halt");
	});

	it("fails closed on missing, failed, or stale telemetry", () => {
		expect(evaluateRoutingPolicy(input({ windows: [] })).action).toBe("halt");
		expect(evaluateRoutingPolicy(input({ windows: [window({ freshness: "failed" })] })).action).toBe("halt");
		const stale = evaluateRoutingPolicy(input({ windows: [window({ observedAt: now - 120_001 })] }));
		expect(stale.action).toBe("halt");
		expect(stale.reason).toContain("stale");
	});

	it("halts at a hard consumption ceiling regardless of burn velocity", () => {
		const decision = evaluateRoutingPolicy(input({ windows: [window({ usedFraction: 0.995, observedBurnPerSecond: 0 })] }));
		expect(decision.action).toBe("halt");
		expect(decision.reason).toContain("hard stop");
	});

	it("uses hysteresis and cooldown before recovering", () => {
		const pressured = window({ observedBurnPerSecond: 1.6 * (0.8 / 14_400) });
		const previous = { action: "switch-model" as const, decidedAt: now - 60_000, pressure: 1.6, route: routes[2] };
		const held = evaluateRoutingPolicy(input({ windows: [window()], previousDecision: previous }));
		expect(held).toMatchObject({ action: "switch-model", route: routes[2], decidedAt: previous.decidedAt });
		expect(held.trace.some((entry) => entry.includes("cooldown"))).toBe(true);

		const afterCooldown = evaluateRoutingPolicy(input({
			now: now + 400_000,
			windows: [{ ...pressured, observedAt: now + 400_000, observedBurnPerSecond: 0.9 * (0.8 / 14_400), resetsAt: now + 14_800_000 }],
			previousDecision: previous,
		}));
		expect(afterCooldown.action).toBe("continue");
	});

	it("escalates when the requested route is unavailable", () => {
		const pressure = 1.7;
		const noSameProviderAlternative = routes.filter((route) => route === current || route.provider === "openrouter");
		const decision = evaluateRoutingPolicy(input({
			windows: [window({ observedBurnPerSecond: pressure * (0.8 / 14_400) })],
			routes: noSameProviderAlternative,
		}));
		expect(decision).toMatchObject({ action: "switch-provider", route: routes[3] });
		expect(decision.trace.some((entry) => entry.includes("unavailable"))).toBe(true);
	});
});
