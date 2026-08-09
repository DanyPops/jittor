import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon } from "../src/daemon.ts";
import { mapObservationToOtlp, OtlpObservationExporter } from "../src/otlp/exporter.ts";
import { resolveJittorPaths } from "../src/state.ts";
import { connectJittorClient } from "../src/vehicle/client.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("content-free OTLP mapping", () => {
	it("maps GenAI usage and latency with pinned conventions through a strict allowlist", () => {
		const point = mapObservationToOtlp({
			source: "local-model",
			scope: "openai/gpt-5",
			metric: "input-tokens",
			value: 123,
			unit: "tokens",
			observedAt: 1_000,
			attributes: {
				provider: "openai",
				model: "gpt-5",
				thinking: "high",
				runId: "local-1000-1",
				sessionId: "q".repeat(32),
				prompt: "private prompt",
				response: "private response",
				toolArguments: { path: "/private/file" },
				errorMessage: "Bearer secret-token",
			},
		});
		expect(point).toMatchObject({
			name: "gen_ai.client.token.usage",
			unit: "{token}",
			value: 123,
			attributes: {
				"gen_ai.operation.name": "chat",
				"gen_ai.provider.name": "openai",
				"gen_ai.request.model": "gpt-5",
				"gen_ai.token.type": "input",
				"gen_ai.request.reasoning.level": "high",
				"jittor.run.id": "local-1000-1",
				"gen_ai.conversation.id": "q".repeat(32),
			},
		});
		const serialized = JSON.stringify(point);
		expect(serialized).not.toContain("private");
		expect(serialized).not.toContain("secret-token");
		expect(serialized).not.toContain("toolArguments");
	});

	it("maps cache, TTFT, throughput, failure, compaction, context, budget, and routing facts under safe namespaces", () => {
		const metric = (name: string, value: number, unit = "count", attributes: Record<string, unknown> = {}) =>
			mapObservationToOtlp({
				source: "pi-context",
				scope: "compaction",
				metric: name,
				value,
				unit: unit as never,
				observedAt: 1_000,
				attributes,
			});
		expect(metric("cache-read-tokens", 50, "tokens")).toMatchObject({ name: "jittor.gen_ai.cache.token.usage" });
		expect(metric("ttft", 500, "milliseconds")).toMatchObject({ name: "gen_ai.client.operation.time_to_first_chunk", value: 0.5 });
		expect(metric("output-throughput", 20, "tokens-per-second")).toMatchObject({ name: "jittor.gen_ai.output.throughput" });
		expect(metric("failure", 1, "ratio")).toMatchObject({ attributes: { "error.type": "_OTHER" } });
		expect(metric("compaction-effectiveness", 0.6, "ratio", { mechanism: "pi-native", preContextTokens: 1000 })).toMatchObject({
			attributes: { "jittor.compaction.mechanism": "pi-native", "jittor.compaction.pre_context_tokens": 1000 },
		});
	});
});

describe("bounded OTLP exporter", () => {
	it("bounds queue backpressure, retries once, and isolates collector failure", async () => {
		let attempts = 0;
		const exporter = new OtlpObservationExporter({
			endpoint: "http://127.0.0.1:1/v1/metrics",
			maxQueueSize: 2,
			batchSize: 10,
			transport: async () => {
				attempts += 1;
				throw new Error("collector offline with credential");
			},
		});
		for (let index = 0; index < 3; index += 1)
			expect(() =>
				exporter.enqueue({ source: "pi", scope: "openai:gpt-5", metric: "output-tokens", value: index, unit: "tokens", observedAt: 1_000 }),
			).not.toThrow();
		expect(exporter.status()).toMatchObject({ enabled: true, queued: 2, dropped: 1, semanticConventions: expect.any(String) });
		await expect(exporter.flush()).resolves.toBeUndefined();
		expect(attempts).toBe(2);
		expect(exporter.status()).toMatchObject({ queued: 0, failures: 1, dropped: 3 });
		expect(JSON.stringify(exporter.status())).not.toContain("credential");
		await exporter.shutdown();
	});

	it("times out a stalled collector and flushes remaining data during shutdown", async () => {
		const stalled = new OtlpObservationExporter({
			endpoint: "http://127.0.0.1:1/v1/metrics",
			timeoutMs: 5,
			maxRetries: 0,
			transport: (_url, init) =>
				new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })),
		});
		stalled.enqueue({ source: "pi", scope: "openai:gpt-5", metric: "input-tokens", value: 1, unit: "tokens", observedAt: 1_000 });
		await stalled.flush();
		expect(stalled.status()).toMatchObject({ failures: 1, dropped: 1 });
		await stalled.shutdown();

		let sent = 0;
		const shutdownFlush = new OtlpObservationExporter({
			endpoint: "http://127.0.0.1:1/v1/metrics",
			transport: async () => {
				sent += 1;
				return new Response("{}", { status: 200 });
			},
		});
		shutdownFlush.enqueue({ source: "pi", scope: "openai:gpt-5", metric: "output-tokens", value: 1, unit: "tokens", observedAt: 1_000 });
		await shutdownFlush.shutdown();
		expect(sent).toBe(1);
		expect(shutdownFlush.status()).toMatchObject({ queued: 0, exported: 1 });
	});

	it("keeps local SQLite authoritative when the configured collector is unavailable", async () => {
		const root = mkdtempSync(join(tmpdir(), "jittor-otlp-failure-"));
		roots.push(root);
		const paths = resolveJittorPaths({
			home: root,
			uid: 1000,
			env: {
				XDG_DATA_HOME: join(root, "data"),
				XDG_STATE_HOME: join(root, "state"),
				XDG_RUNTIME_DIR: join(root, "run"),
				XDG_CONFIG_HOME: join(root, "config"),
			},
		});
		const daemon = await startDaemon(paths, { HOME: root, OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://127.0.0.1:1/v1/metrics" });
		try {
			const client = connectJittorClient(paths);
			await client.call("metrics.record", {
				source: "pi",
				scope: "openai:gpt-5",
				metric: "output-tokens",
				value: 7,
				unit: "tokens",
				observedAt: 1_000,
			});
			await client.call("export.flush", {});
			expect(await client.call("metrics.query", { source: "pi" })).toHaveLength(1);
			expect(await client.call("export.status", {})).toMatchObject({ failures: 1, dropped: 1 });
		} finally {
			await daemon.stop();
		}
	});

	it("exports valid OTLP/HTTP JSON through a real collector while local SQLite remains authoritative", async () => {
		const requests: Array<{ headers: Headers; body: unknown }> = [];
		const collector = Bun.serve({
			port: 0,
			async fetch(request) {
				requests.push({ headers: request.headers, body: await request.json() });
				return Response.json({});
			},
		});
		const root = mkdtempSync(join(tmpdir(), "jittor-otlp-"));
		roots.push(root);
		const paths = resolveJittorPaths({
			home: root,
			uid: 1000,
			env: {
				XDG_DATA_HOME: join(root, "data"),
				XDG_STATE_HOME: join(root, "state"),
				XDG_RUNTIME_DIR: join(root, "run"),
				XDG_CONFIG_HOME: join(root, "config"),
			},
		});
		const daemon = await startDaemon(paths, {
			HOME: root,
			OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: new URL("/v1/metrics", collector.url).toString(),
			OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer%20collector-secret",
		});
		try {
			const client = connectJittorClient(paths);
			await client.call("metrics.record", {
				source: "pi",
				scope: "openai:gpt-5",
				metric: "input-tokens",
				value: 10,
				unit: "tokens",
				observedAt: 1_000,
				attributes: { provider: "openai", model: "gpt-5", prompt: "must-not-export" },
			});
			await client.call("export.flush", {});
			expect(await client.call("metrics.query", { source: "pi" })).toHaveLength(1);
			expect(await client.call("export.status", {})).toMatchObject({ enabled: true, exported: 1, failures: 0 });
			expect(requests).toHaveLength(1);
			expect(requests[0]!.headers.get("authorization")).toBe("Bearer collector-secret");
			const body = JSON.stringify(requests[0]!.body);
			expect(body).toContain("gen_ai.client.token.usage");
			expect(body).not.toContain("must-not-export");
			expect(body).not.toContain("collector-secret");
		} finally {
			await daemon.stop();
			collector.stop(true);
		}
	});
});
