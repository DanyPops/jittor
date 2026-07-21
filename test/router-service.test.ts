import { describe, expect, it } from "bun:test";
import type { PolicyDecision } from "../src/policy.ts";
import type { RouterController, RouterStatus, TelemetryPollResult } from "../src/ports/router-controller.ts";
import { createApp, JittorService } from "../src/service.ts";
import type { MetricStore } from "../src/ports/metric-store.ts";
import type { MetricObservation, MetricQuery, StoredMetricObservation } from "../src/domain/metric.ts";

class EmptyMetricStore implements MetricStore {
	record(observation: MetricObservation): StoredMetricObservation { return { ...observation, attributes: observation.attributes ?? {}, id: 1 }; }
	query(_filter: MetricQuery = {}): StoredMetricObservation[] { return []; }
	distinctScopes(): string[] { return []; }
	pruneBefore(): number { return 0; }
	checkpoint(): void {}
	close(): void {}
}

class FakeRouter implements RouterController {
	ready = false;
	paused = false;
	async poll(): Promise<TelemetryPollResult> { this.ready = true; return { sources: [{ id: "codex", provider: "openai-codex", ok: true, metrics: 2 }], observedAt: 1000 }; }
	status(): RouterStatus { return { ready: this.ready, paused: this.paused, sources: [], lastDecision: null, override: null, currentRoute: null, availableRoutes: [] }; }
	decide(): PolicyDecision {
		return { action: "continue", pressure: 0.5, reason: "sustainable", decidedAt: 1000, trace: ["ok"] };
	}
	pause(): RouterStatus { this.paused = true; return this.status(); }
	resume(): RouterStatus { this.paused = false; return this.status(); }
	setOverride(): RouterStatus { return this.status(); }
	clearOverride(): RouterStatus { return this.status(); }
	setCurrentRoute(): RouterStatus { return this.status(); }
	setAvailableRoutes(): RouterStatus { return this.status(); }
}

function get(app: { fetch(request: Request): Promise<Response> }, path: string) {
	return app.fetch(new Request(`http://jittor.test${path}`, { headers: { authorization: "Bearer test-token" } }));
}

function post(app: { fetch(request: Request): Promise<Response> }, op: string, input: Record<string, unknown> = {}) {
	return app.fetch(new Request("http://jittor.test/api/v1/ops", {
		method: "POST",
		headers: { authorization: "Bearer test-token", "content-type": "application/json" },
		body: JSON.stringify({ op, input }),
	}));
}

describe("production router service", () => {
	it("reports readiness only after an asynchronous telemetry poll", async () => {
		const router = new FakeRouter();
		const service = new JittorService(new EmptyMetricStore(), router);
		const app = createApp({ service, token: "test-token" });
		expect((await get(app, "/ready")).status).toBe(503);
		expect((await post(app, "telemetry.poll")).status).toBe(200);
		expect((await get(app, "/ready")).status).toBe(200);
	});

	it("exposes decision and halt controls through the operation registry", async () => {
		const router = new FakeRouter();
		const service = new JittorService(new EmptyMetricStore(), router);
		expect(service.operationNames()).toEqual(expect.arrayContaining([
			"telemetry.poll", "router.status", "router.decide", "router.pause", "router.resume", "router.override", "router.clear_override", "router.available_routes",
		]));
		expect(await service.execute("router.decide", {})).toMatchObject({ action: "continue" });
		expect(await service.execute("router.pause", {})).toMatchObject({ paused: true });
		expect(await service.execute("router.resume", {})).toMatchObject({ paused: false });
	});

	it("rejects oversized requests before JSON parsing", async () => {
		const service = new JittorService(new EmptyMetricStore(), new FakeRouter());
		const app = createApp({ service, token: "test-token", maxBodyBytes: 8 });
		const response = await app.fetch(new Request("http://jittor.test/api/v1/ops", {
			method: "POST",
			headers: { authorization: "Bearer test-token", "content-type": "application/json", "content-length": "100" },
			body: "not-json-but-too-large",
		}));
		expect(response.status).toBe(413);
	});
});
