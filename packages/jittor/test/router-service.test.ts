import { describe, expect, it } from "bun:test";
import type { MetricObservation, MetricQuery, StoredMetricObservation } from "../src/observability/metric.ts";
import type { MetricStore } from "../src/observability/store.ts";
import type { RouteOverride, RouterController, RouterStatus, TelemetryPollResult } from "../src/optimization/routing/controller.ts";
import type { PolicyDecision, Route } from "../src/optimization/routing/policy.ts";
import { SessionIdentity } from "../src/sessions/identity.ts";
import type { SessionIdentityRecord, SessionIdentityStore } from "../src/sessions/store.ts";
import { createApp, InvalidSessionSecretError, JittorService } from "../src/vehicle/service.ts";

class EmptyMetricStore implements MetricStore {
	record(observation: MetricObservation): StoredMetricObservation {
		return { ...observation, attributes: observation.attributes ?? {}, id: 1 };
	}
	recordBatch(observations: MetricObservation[]): StoredMetricObservation[] {
		return observations.map((observation) => this.record(observation));
	}
	query(_filter: MetricQuery = {}): StoredMetricObservation[] {
		return [];
	}
	distinctScopes(): string[] {
		return [];
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

class InMemorySessionIdentityStore implements SessionIdentityStore {
	private readonly rows = new Map<string, SessionIdentityRecord>();
	find(sessionId: string): SessionIdentityRecord | undefined {
		return this.rows.get(sessionId);
	}
	upsert(record: SessionIdentityRecord): void {
		this.rows.set(record.sessionId, record);
	}
	remove(sessionId: string): void {
		this.rows.delete(sessionId);
	}
	touch(sessionId: string, lastSeenAt: string): void {
		const row = this.rows.get(sessionId);
		if (row) row.lastSeenAt = lastSeenAt;
	}
	count(): number {
		return this.rows.size;
	}
}

class FakeRouter implements RouterController {
	ready = false;
	paused = false;
	readonly sessionCalls: Array<{ method: string; sessionId?: string }> = [];
	async poll(): Promise<TelemetryPollResult> {
		this.ready = true;
		return { sources: [{ id: "codex", provider: "openai-codex", ok: true, metrics: 2 }], observedAt: 1000 };
	}
	status(sessionId?: string): RouterStatus {
		this.sessionCalls.push({ method: "status", sessionId });
		return {
			ready: this.ready,
			paused: this.paused,
			sources: [],
			lastDecision: null,
			override: null,
			currentRoute: null,
			availableRoutes: [],
		};
	}
	decide(sessionId?: string): PolicyDecision {
		this.sessionCalls.push({ method: "decide", sessionId });
		return { action: "continue", pressure: 0.5, reason: "sustainable", decidedAt: 1000, trace: ["ok"] };
	}
	pause(sessionId?: string): RouterStatus {
		this.sessionCalls.push({ method: "pause", sessionId });
		this.paused = true;
		return this.status(sessionId);
	}
	resume(sessionId?: string): RouterStatus {
		this.sessionCalls.push({ method: "resume", sessionId });
		this.paused = false;
		return this.status(sessionId);
	}
	setOverride(_override: RouteOverride | undefined, sessionId?: string): RouterStatus {
		this.sessionCalls.push({ method: "setOverride", sessionId });
		return this.status(sessionId);
	}
	clearOverride(sessionId?: string): RouterStatus {
		this.sessionCalls.push({ method: "clearOverride", sessionId });
		return this.status(sessionId);
	}
	setCurrentRoute(_route: Route, sessionId?: string): RouterStatus {
		this.sessionCalls.push({ method: "setCurrentRoute", sessionId });
		return this.status(sessionId);
	}
	setAvailableRoutes(_routes: Route[], sessionId?: string): RouterStatus {
		this.sessionCalls.push({ method: "setAvailableRoutes", sessionId });
		return this.status(sessionId);
	}
}

function get(app: { fetch(request: Request): Promise<Response> }, path: string) {
	return app.fetch(new Request(`http://jittor.test${path}`, { headers: { authorization: "Bearer test-token" } }));
}

function post(app: { fetch(request: Request): Promise<Response> }, op: string, input: Record<string, unknown> = {}) {
	return app.fetch(
		new Request("http://jittor.test/api/v1/ops", {
			method: "POST",
			headers: { authorization: "Bearer test-token", "content-type": "application/json" },
			body: JSON.stringify({ op, input }),
		}),
	);
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

	it("exposes decision, halt, and session-identity controls through the operation registry", async () => {
		const router = new FakeRouter();
		const service = new JittorService(new EmptyMetricStore(), router);
		expect(service.operationNames()).toEqual(
			expect.arrayContaining([
				"session.register",
				"session.release",
				"telemetry.poll",
				"router.status",
				"router.decide",
				"router.pause",
				"router.resume",
				"router.override",
				"router.clear_override",
				"router.available_routes",
			]),
		);
		expect(await service.execute("router.decide", {})).toMatchObject({ action: "continue" });
		expect(await service.execute("router.pause", {})).toMatchObject({ paused: true });
		expect(await service.execute("router.resume", {})).toMatchObject({ paused: false });
	});

	it("forwards explicit session scope to every mutable router operation", async () => {
		const router = new FakeRouter();
		const service = new JittorService(new EmptyMetricStore(), router);
		await service.execute("router.current_route", { provider: "openai", model: "gpt-5.4", thinking: "high", session_id: "session-a" });
		await service.execute("router.available_routes", { routes: [], session_id: "session-b" });
		await service.execute("router.status", { session_id: "session-a" });
		await service.execute("router.decide", { session_id: "session-b" });
		expect(router.sessionCalls).toEqual(
			expect.arrayContaining([
				{ method: "setCurrentRoute", sessionId: "session-a" },
				{ method: "setAvailableRoutes", sessionId: "session-b" },
				{ method: "status", sessionId: "session-a" },
				{ method: "decide", sessionId: "session-b" },
			]),
		);
	});

	it("mutates an unregistered session_id exactly as before -- opt-in armor, not a breaking migration", async () => {
		const router = new FakeRouter();
		const sessionIdentity = new SessionIdentity(new InMemorySessionIdentityStore());
		const service = new JittorService(new EmptyMetricStore(), router, undefined, undefined, sessionIdentity);
		await expect(service.execute("router.pause", { session_id: "never-registered" })).resolves.toMatchObject({ paused: true });
	});

	it("requires a matching session_secret once a session_id is registered, and rejects a wrong or missing one", async () => {
		const router = new FakeRouter();
		const sessionIdentity = new SessionIdentity(new InMemorySessionIdentityStore());
		const service = new JittorService(new EmptyMetricStore(), router, undefined, undefined, sessionIdentity);
		const { secret } = await service.execute("session.register", { session_id: "session-a" });
		await expect(service.execute("router.pause", { session_id: "session-a" })).rejects.toThrow(InvalidSessionSecretError);
		await expect(service.execute("router.pause", { session_id: "session-a", session_secret: "wrong" })).rejects.toThrow(
			InvalidSessionSecretError,
		);
		await expect(service.execute("router.pause", { session_id: "session-a", session_secret: secret })).resolves.toMatchObject({
			paused: true,
		});
	});

	it("releases a registered session's identity only with the correct secret, idempotently", async () => {
		const sessionIdentity = new SessionIdentity(new InMemorySessionIdentityStore());
		const service = new JittorService(new EmptyMetricStore(), new FakeRouter(), undefined, undefined, sessionIdentity);
		const { secret } = await service.execute("session.register", { session_id: "session-a" });
		expect(await service.execute("session.release", { session_id: "session-a", session_secret: "wrong" })).toEqual({ released: false });
		expect(await service.execute("session.release", { session_id: "session-a", session_secret: secret })).toEqual({ released: true });
		expect(await service.execute("session.release", { session_id: "session-a", session_secret: secret })).toEqual({ released: false });
	});

	it("maps an invalid session_secret to HTTP 403, distinct from generic 400 validation", async () => {
		const sessionIdentity = new SessionIdentity(new InMemorySessionIdentityStore());
		const service = new JittorService(new EmptyMetricStore(), new FakeRouter(), undefined, undefined, sessionIdentity);
		const app = createApp({ service, token: "test-token" });
		await post(app, "session.register", { session_id: "session-a" });
		const response = await post(app, "router.pause", { session_id: "session-a", session_secret: "wrong" });
		expect(response.status).toBe(403);
	});

	it("rejects oversized requests before JSON parsing", async () => {
		const service = new JittorService(new EmptyMetricStore(), new FakeRouter());
		const app = createApp({ service, token: "test-token", maxBodyBytes: 8 });
		const response = await app.fetch(
			new Request("http://jittor.test/api/v1/ops", {
				method: "POST",
				headers: { authorization: "Bearer test-token", "content-type": "application/json", "content-length": "100" },
				body: "not-json-but-too-large",
			}),
		);
		expect(response.status).toBe(413);
	});
});
