import { describe, expect, it } from "bun:test";
import type { MetricObservation, MetricQuery, StoredMetricObservation } from "../src/domain/metric.ts";
import type { PolicyConfig, Route } from "../src/policy.ts";
import type { MetricStore } from "../src/ports/metric-store.ts";
import type { TelemetryBatch, TelemetrySource } from "../src/ports/telemetry-source.ts";
import { JittorRouter } from "../src/router.ts";

class MemoryMetrics implements MetricStore {
	rows: StoredMetricObservation[] = [];
	record(observation: MetricObservation): StoredMetricObservation {
		const row = { ...observation, attributes: observation.attributes ?? {}, id: this.rows.length + 1 };
		this.rows.push(row);
		return row;
	}
	recordBatch(observations: MetricObservation[]): StoredMetricObservation[] {
		return observations.map((observation) => this.record(observation));
	}
	query(_filter: MetricQuery = {}): StoredMetricObservation[] {
		return [...this.rows];
	}
	distinctScopes(filter: { source: string; since: number; until: number; limit: number }): string[] {
		return [
			...new Set(
				this.rows
					.filter((row) => row.source === filter.source && row.observedAt >= filter.since && row.observedAt <= filter.until)
					.map((row) => row.scope),
			),
		]
			.sort()
			.slice(0, filter.limit);
	}
	aggregateUsage(): never[] {
		return [];
	}
	pruneBefore(): number {
		return 0;
	}
	checkpoint(): void {}
	close(): void {}
}

const now = 1_700_000_000_000;
const routes: Route[] = [
	{ provider: "openai-codex", model: "gpt-5.3-codex", thinking: "high" },
	{ provider: "openai-codex", model: "gpt-5.3-codex", thinking: "medium" },
	{ provider: "openrouter", model: "openai/gpt-4.1-mini", thinking: "medium" },
];
const config: PolicyConfig = {
	maxTelemetryAgeMs: 120_000,
	cooldownMs: 300_000,
	hysteresisFraction: 0.1,
	thresholds: { throttle: 1, lowerThinking: 1.25, switchModel: 1.5, switchProvider: 2, halt: 3 },
	maxThrottleMs: 30_000,
	hardStopUsedFraction: 0.99,
};

function source(batch: TelemetryBatch | Error, required = true, provider = "openai-codex"): TelemetrySource {
	return {
		id: provider === "openai-codex" ? "codex" : `${provider}-telemetry`,
		provider,
		required,
		async poll() {
			if (batch instanceof Error) throw batch;
			return batch;
		},
	};
}

describe("Jittor router controller", () => {
	it("polls sources, persists metrics, and evaluates the pure policy", async () => {
		const metrics = new MemoryMetrics();
		const router = new JittorRouter({
			metrics,
			sources: [
				source({
					observedAt: now,
					metrics: [
						{ source: "codex-subscription", scope: "codex:primary", metric: "used-fraction", value: 0.2, unit: "ratio", observedAt: now },
					],
					windows: [
						{
							id: "codex:primary@1",
							source: "codex-subscription",
							scope: "codex:primary",
							usedFraction: 0.2,
							windowSeconds: 18_000,
							resetsAt: now + 14_400_000,
							observedAt: now,
							freshness: "fresh",
							confidence: 0.8,
						},
					],
				}),
			],
			policy: config,
			routes,
			currentRoute: routes[0]!,
			clock: () => now,
		});

		expect((await router.poll()).sources).toEqual([{ id: "codex", provider: "openai-codex", ok: true, metrics: 1, observedAt: now }]);
		expect(router.status().ready).toBe(true);
		expect(metrics.rows).toHaveLength(1);
		expect(router.decide().action).toBe("continue");
	});

	it("fails closed when a required source fails", async () => {
		const router = new JittorRouter({
			metrics: new MemoryMetrics(),
			sources: [source(new Error("oauth-super-secret"))],
			policy: config,
			routes,
			currentRoute: routes[0]!,
			clock: () => now,
		});
		const result = await router.poll();
		expect(result.sources[0]).toEqual({
			id: "codex",
			provider: "openai-codex",
			ok: false,
			metrics: 0,
			observedAt: now,
			error: "poll failed",
		});
		expect(JSON.stringify(result)).not.toContain("oauth-super-secret");
		expect(router.status().ready).toBe(false);
		expect(router.decide().action).toBe("halt");
	});

	it("continues explicitly monitor-only when a provider has no required budget source", async () => {
		const currentRoute = routes[2]!;
		for (const batch of [
			{ observedAt: now, metrics: [], windows: [] } satisfies TelemetryBatch,
			new Error("optional source unavailable"),
		]) {
			const router = new JittorRouter({
				metrics: new MemoryMetrics(),
				sources: [source(batch, false, currentRoute.provider)],
				policy: config,
				routes: [currentRoute],
				currentRoute,
				clock: () => now,
			});
			await router.poll();
			expect(router.status().ready).toBe(true);
			expect(router.decide()).toMatchObject({
				action: "continue",
				pressure: 0,
				reason: "provider has no enforceable budget window; monitor-only",
			});
		}
	});

	it("continues monitor-only when the provider has no telemetry source", () => {
		const currentRoute = { provider: "anthropic", model: "claude-sonnet-5", thinking: "high" };
		const router = new JittorRouter({
			metrics: new MemoryMetrics(),
			sources: [],
			policy: config,
			routes: [currentRoute],
			currentRoute,
			clock: () => now,
		});
		expect(router.status().ready).toBe(true);
		expect(router.decide()).toMatchObject({ action: "continue", reason: "provider has no enforceable budget window; monitor-only" });
	});

	it("still fails closed when a configured required source returns no window", async () => {
		const router = new JittorRouter({
			metrics: new MemoryMetrics(),
			sources: [source({ observedAt: now, metrics: [], windows: [] })],
			policy: config,
			routes,
			currentRoute: routes[0]!,
			clock: () => now,
		});
		await router.poll();
		expect(router.status().ready).toBe(true);
		expect(router.decide()).toMatchObject({ action: "halt", reason: "required budget telemetry is missing" });
	});

	it("never selects a configured model that Pi did not report available", async () => {
		const router = new JittorRouter({
			metrics: new MemoryMetrics(),
			sources: [
				source({
					observedAt: now,
					metrics: [],
					windows: [
						{
							id: "codex:primary@pressure",
							source: "codex-subscription",
							scope: "codex:primary",
							usedFraction: 0.2,
							observedBurnPerSecond: 0.000095,
							windowSeconds: 18_000,
							resetsAt: now + 14_400_000,
							observedAt: now,
							freshness: "fresh",
							confidence: 0.8,
						},
					],
				}),
			],
			policy: config,
			routes,
			currentRoute: routes[0]!,
			clock: () => now,
		});
		await router.poll();
		router.setAvailableRoutes([routes[0]!, routes[1]!]);
		const decision = router.decide();
		expect(decision.action).toBe("halt");
		expect(decision.route).toBeUndefined();
		expect(decision.trace.join("\n")).toContain("switch-model route unavailable");
	});

	it("keeps mutable route state isolated across interleaved Pi sessions", async () => {
		const router = new JittorRouter({
			metrics: new MemoryMetrics(),
			sources: [source({ observedAt: now, metrics: [], windows: [] })],
			policy: config,
			routes,
			currentRoute: routes[0]!,
			clock: () => now,
		});
		await router.poll();

		router.setCurrentRoute(routes[0]!, "session-a");
		router.setAvailableRoutes([routes[0]!, routes[1]!], "session-a");
		router.setCurrentRoute(routes[2]!, "session-b");
		router.setAvailableRoutes([routes[2]!], "session-b");
		router.pause("session-a");

		expect(router.status("session-a")).toMatchObject({ paused: true, currentRoute: routes[0], availableRoutes: [routes[0], routes[1]] });
		expect(router.status("session-b")).toMatchObject({ paused: false, currentRoute: routes[2], availableRoutes: [routes[2]] });
		expect(router.decide("session-a").reason).toContain("paused");
		expect(router.decide("session-b").reason).not.toContain("paused");
	});

	it("bounds retained session scopes and rejects oversized session identities", () => {
		const router = new JittorRouter({
			metrics: new MemoryMetrics(),
			sources: [],
			policy: config,
			routes,
			currentRoute: routes[0]!,
			clock: () => now,
		});
		router.setCurrentRoute(routes[2]!, "session-0");
		for (let index = 1; index < 500; index += 1) router.status(`session-${index}`);
		expect(router.status("session-0").currentRoute).toEqual(routes[0]!);
		expect(() => router.status("x".repeat(129))).toThrow("session_id must contain 1-128 characters");
	});

	it("applies exact-scope model ranking only by reordering and narrowing existing routes", () => {
		const router = new JittorRouter({
			metrics: new MemoryMetrics(),
			sources: [],
			policy: config,
			routes,
			currentRoute: routes[0]!,
			clock: () => now,
		});
		const unknown = { provider: "other", model: "outside", thinking: "high" };
		const status = router.applyModelRanking([routes[2]!, unknown, routes[0]!]);
		expect(status.availableRoutes).toEqual([routes[0]!, routes[2]!]);
		expect(status.availableRoutes).not.toContainEqual(unknown);
	});

	it("supports explicit pause and expiring route overrides", async () => {
		let currentTime = now;
		const router = new JittorRouter({
			metrics: new MemoryMetrics(),
			sources: [],
			policy: config,
			routes,
			currentRoute: routes[0]!,
			clock: () => currentTime,
		});
		expect(router.pause().paused).toBe(true);
		expect(router.decide().reason).toContain("paused");
		router.resume();
		router.setOverride({ route: routes[2]!, expiresAt: now + 1000 });
		expect(router.decide()).toMatchObject({ action: "switch-provider", route: routes[2] });
		currentTime += 1001;
		expect(router.status().override).toBeNull();
	});
});
