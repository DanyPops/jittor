import { describe, expect, it } from "bun:test";
import { JittorClient } from "../src/client.ts";
import type { MetricObservation, MetricQuery, StoredMetricObservation } from "../src/domain/metric.ts";
import type { MetricStore } from "../src/ports/metric-store.ts";
import { EXPECTED_OPERATION_NAMES, JittorService, createApp } from "../src/service.ts";

class FakeMetricStore implements MetricStore {
	private sequence = 0;
	readonly rows: StoredMetricObservation[] = [];
	record(observation: MetricObservation): StoredMetricObservation {
		const stored = { ...structuredClone(observation), attributes: observation.attributes ?? {}, id: ++this.sequence };
		this.rows.push(stored);
		return structuredClone(stored);
	}
	query(filter: MetricQuery = {}): StoredMetricObservation[] {
		return this.rows.filter((row) => !filter.source || row.source === filter.source).map((row) => structuredClone(row));
	}
	pruneBefore(cutoff: number): number {
		const before = this.rows.length;
		for (let index = this.rows.length - 1; index >= 0; index--) if (this.rows[index]!.observedAt < cutoff) this.rows.splice(index, 1);
		return before - this.rows.length;
	}
	checkpoint(): void {}
	close(): void {}
}

function request(app: { fetch(request: Request): Promise<Response> }, body: unknown, token = "test-token") {
	return app.fetch(new Request("http://jittor.test/api/v1/ops", {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify(body),
	}));
}

describe("Jittor operation service", () => {
	it("depends only on the metric-store port and registers stable operations", async () => {
		const store = new FakeMetricStore();
		const service = new JittorService(store);
		expect(service.operationNames()).toEqual([...EXPECTED_OPERATION_NAMES]);
		const recorded = await service.execute("metrics.record", {
			source: "openrouter", scope: "key:default", metric: "cost", value: 0.01,
			unit: "usd", observedAt: 1000,
		}) as StoredMetricObservation;
		expect(recorded.id).toBe(1);
		expect(await service.execute("metrics.query", { source: "openrouter" })).toHaveLength(1);
		const assessment = await service.execute("context.assess", { since: 0, until: 2_000 });
		expect(assessment).toMatchObject({ completeness: "complete", injection: { runs: 0 }, compaction: { completed: 0 } });
		await expect(service.execute("metrics.record", {
			source: "openrouter", scope: "key:default", metric: "cost", value: 1,
			unit: "credits" as never, observedAt: 1000,
		})).rejects.toThrow("unit is not supported");
	});

	it("learns a compaction duration estimate from recorded pi-context compaction-duration metrics", async () => {
		const store = new FakeMetricStore();
		const service = new JittorService(store);
		expect(await service.execute("compaction.estimate", {})).toMatchObject({ ms: null, confidence: "cold-start", sampleSize: 0 });
		for (const [index, durationMs] of [4_000, 4_200, 3_900].entries()) {
			await service.execute("metrics.record", {
				source: "pi-context", scope: "compaction", metric: "compaction-duration", value: durationMs,
				unit: "milliseconds", observedAt: 1_000 + index,
			});
		}
		expect(await service.execute("compaction.estimate", {})).toMatchObject({ ms: 4_000, confidence: "learned", sampleSize: 3 });
	});

	it("authenticates the loopback operation endpoint", async () => {
		const service = new JittorService(new FakeMetricStore());
		const app = createApp({ service, token: "test-token" });
		expect((await request(app, { op: "metrics.query", input: {} }, "wrong")).status).toBe(401);
		const response = await request(app, { op: "metrics.record", input: {
			source: "codex-subscription", scope: "primary", metric: "used-fraction", value: 0.5,
			unit: "ratio", observedAt: 1000,
		} });
		expect(response.status).toBe(200);
		expect(((await response.json()) as { result: StoredMetricObservation }).result.id).toBe(1);
	});

	it("provides a typed client over the same transport", async () => {
		const service = new JittorService(new FakeMetricStore());
		const app = createApp({ service, token: "test-token" });
		const client = new JittorClient("http://jittor.test", "test-token", (request) => app.fetch(request));
		await client.call("metrics.record", {
			source: "openrouter", scope: "key:default", metric: "cost", value: 0.03,
			unit: "usd", observedAt: 2000,
		});
		expect(await client.call("metrics.query", { source: "openrouter" })).toHaveLength(1);
		expect(await client.call("context.assess", { since: 0, until: 3_000 })).toMatchObject({ injection: { runs: 0 } });
		expect(await client.operations()).toEqual([...EXPECTED_OPERATION_NAMES]);
	});
});
