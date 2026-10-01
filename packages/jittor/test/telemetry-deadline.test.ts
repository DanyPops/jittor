import { describe, expect, it } from "bun:test";
import { CodexSubscriptionTelemetryAdapter } from "../src/codex/telemetry.ts";
import { GoogleVertexBudgetTelemetryAdapter } from "../src/google-vertex/budget-telemetry.ts";
import { OpenRouterTelemetryAdapter } from "../src/openrouter/telemetry.ts";
import { withDeadline } from "../src/transport/deadline.ts";
import { JittorClient } from "../src/vehicle/client.ts";

describe("abortable deadlines", () => {
	it("bounds an operation that ignores cancellation and consumes its late rejection", async () => {
		const gate = Promise.withResolvers<never>();
		let signal: AbortSignal | undefined;
		await expect(
			withDeadline(
				async (value) => {
					signal = value;
					return gate.promise;
				},
				{ timeoutMs: 20 },
			),
		).rejects.toMatchObject({ name: "TimeoutError" });
		expect(signal?.aborted).toBe(true);
		gate.reject(new Error("late failure"));
		await Bun.sleep(1);
	});

	it("skips pre-aborted work and clears the deadline after success", async () => {
		let called = false;
		await expect(
			withDeadline(
				async () => {
					called = true;
				},
				{ signal: AbortSignal.abort() },
			),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(called).toBe(false);
		const signal = await withDeadline(async (value) => value, { timeoutMs: 10 });
		await Bun.sleep(25);
		expect(signal.aborted).toBe(false);
	});

	it.each(["codex", "openrouter", "vertex", "rpc"])("cancels %s HTTP requests and stalled response bodies", async (provider) => {
		for (const stall of ["headers", "body"]) {
			let requestSignal: AbortSignal | undefined;
			let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
			const transport = async (request: Request) => {
				requestSignal = request.signal;
				if (stall === "headers") return new Promise<Response>(() => {});
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							stream = controller;
						},
					}),
				);
			};
			const run = (signal: AbortSignal) => {
				switch (provider) {
					case "codex":
						return new CodexSubscriptionTelemetryAdapter({ accessToken: "test", accountId: "test" }, transport).readUsage(1, signal);
					case "openrouter":
						return new OpenRouterTelemetryAdapter("test", transport).readKey(1, signal);
					case "vertex":
						return new GoogleVertexBudgetTelemetryAdapter("projects/test/subscriptions/test", async () => "test", transport).pull(
							1,
							signal,
						);
					default:
						return new JittorClient("http://127.0.0.1", "test", transport).call("telemetry.poll", {}, signal);
				}
			};
			await expect(withDeadline<unknown>(run, { timeoutMs: 20 })).rejects.toMatchObject({ name: "TimeoutError" });
			expect(requestSignal?.aborted).toBe(true);
			stream?.close();
		}
	});

	it("bounds ADC lookup and skips HTTP work if credentials arrive after cancellation", async () => {
		const credentials = Promise.withResolvers<string>();
		let calls = 0;
		const adapter = new GoogleVertexBudgetTelemetryAdapter(
			"projects/test/subscriptions/test",
			() => credentials.promise,
			async () => {
				calls++;
				return Response.json({});
			},
		);
		await expect(withDeadline((signal) => adapter.pull(1, signal), { timeoutMs: 20 })).rejects.toMatchObject({ name: "TimeoutError" });
		credentials.resolve("test");
		await Bun.sleep(1);
		expect(calls).toBe(0);
	});
});
