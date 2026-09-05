import { afterEach, describe, expect, it } from "bun:test";
import type { JittorClient } from "@danypops/jittor";
import { MutationOutcomeUnknownError } from "@danypops/vehicle-client/daemon-client";
import {
	callJittor,
	operationRetryMode,
	resetJittorClientForTests,
	setJittorClientConnectorForTests,
} from "../extension/src/service-client.ts";

afterEach(() => {
	resetJittorClientForTests();
});

function fakeClient(call: JittorClient["call"]): JittorClient {
	return { call } as unknown as JittorClient;
}

// Loosely typed indirection: this suite exercises the retry/reconnect wiring itself, not any
// particular operation's real input/output shape, so a generic-inference-friendly signature
// (rather than fighting callJittor's own OperationName-keyed overload) keeps each test focused.
const call = callJittor as unknown as (operation: string, input: unknown) => Promise<unknown>;

function fakeConnectionRefused(): JittorClient {
	return fakeClient(() => {
		throw new TypeError("fetch failed");
	});
}

describe("Jittor vehicle-client retrying client wiring", () => {
	it("retries reset listing after a stale connection", async () => {
		let attempts = 0;
		setJittorClientConnectorForTests(async () => {
			attempts++;
			return attempts === 1 ? fakeConnectionRefused() : fakeClient(async () => ({ availableCount: 1, credits: [] }) as never);
		});
		expect(operationRetryMode("subscription.resets.list")).toBe("retry");
		expect(await call("subscription.resets.list", {})).toEqual({ availableCount: 1, credits: [] });
		expect(attempts).toBe(2);
	});

	it("attempts reset redemption once on connection failure", async () => {
		let attempts = 0;
		setJittorClientConnectorForTests(async () => {
			attempts++;
			return fakeConnectionRefused();
		});
		expect(operationRetryMode("subscription.resets.redeem")).toBe("once");
		await expect(
			call("subscription.resets.redeem", {
				confirm: true,
				creditId: "reset-1",
				idempotencyKey: "00000000-0000-4000-8000-000000000001",
			}),
		).rejects.toThrow(MutationOutcomeUnknownError);
		expect(attempts).toBe(1);
	});

	it("reconnects and retries once when the cached client's connection is stale, succeeding transparently", async () => {
		let connectorCalls = 0;
		setJittorClientConnectorForTests(async () => {
			connectorCalls++;
			return connectorCalls === 1 ? fakeConnectionRefused() : fakeClient(async () => ({ ready: true }) as never);
		});

		const result = await call("router.status", {});

		expect(result).toEqual({ ready: true });
		expect(connectorCalls).toBe(2);
	});

	it("never retries a mutating operation, but drops the stale client so the next call reconnects", async () => {
		let connectorCalls = 0;
		setJittorClientConnectorForTests(async () => {
			connectorCalls++;
			return connectorCalls === 1 ? fakeConnectionRefused() : fakeClient(async () => ({ ready: true }) as never);
		});

		expect(operationRetryMode("metrics.record")).toBe("once");
		expect(operationRetryMode("context.snapshot")).toBe("once");
		expect(operationRetryMode("context.delta")).toBe("retry");
		expect(operationRetryMode("router.pause")).toBe("once");
		// vehicle-client's own callOnce() wraps a mutating call's underlying failure in
		// MutationOutcomeUnknownError -- never silently retryable, since whether the mutation
		// actually landed is genuinely unknown, not a plain connection-refused TypeError anymore.
		await expect(call("metrics.record", {})).rejects.toThrow(MutationOutcomeUnknownError);
		expect(connectorCalls).toBe(1);

		expect(await call("router.status", {})).toEqual({ ready: true });
		expect(connectorCalls).toBe(2);
	});

	it("gives up after one retry if the connection stays stale, rather than retrying forever", async () => {
		let connectorCalls = 0;
		setJittorClientConnectorForTests(async () => {
			connectorCalls++;
			return fakeConnectionRefused();
		});

		await expect(call("router.status", {})).rejects.toThrow(TypeError);
		expect(connectorCalls).toBe(2);
	});

	it("does not retry a genuine domain-level error -- fails immediately rather than masking it", async () => {
		let connectorCalls = 0;
		setJittorClientConnectorForTests(async () => {
			connectorCalls++;
			return fakeClient(() => {
				throw new Error("UnknownOperationError: no such operation");
			});
		});

		await expect(call("router.status", {})).rejects.toThrow(/UnknownOperationError/);
		expect(connectorCalls).toBe(1);
	});

	it("switching connectors drops any previously cached client instead of silently reusing it", async () => {
		let firstConnectorCalls = 0;
		setJittorClientConnectorForTests(async () => {
			firstConnectorCalls++;
			return fakeClient(async () => ({ ready: true }) as never);
		});
		await call("router.status", {});
		expect(firstConnectorCalls).toBe(1);

		let secondConnectorCalls = 0;
		setJittorClientConnectorForTests(async () => {
			secondConnectorCalls++;
			return fakeClient(async () => ({ ready: false }) as never);
		});
		const result = await call("router.status", {});

		expect(result).toEqual({ ready: false });
		expect(secondConnectorCalls).toBe(1);
		expect(firstConnectorCalls).toBe(1);
	});
});
