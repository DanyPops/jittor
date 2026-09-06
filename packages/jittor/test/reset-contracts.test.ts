import { expect, it } from "bun:test";
import { runCli } from "../src/cli.ts";
import type { CliDependencies } from "../src/cli-commands/support.ts";
import { SubscriptionResets } from "../src/observability/subscription-resets.ts";
import { openJittorDb } from "../src/sqlite/database.ts";
import { SQLiteMetricStore } from "../src/sqlite/metric-store.ts";
import { JittorClient } from "../src/vehicle/client.ts";
import { resetContracts } from "../src/vehicle/reset-contracts.ts";
import { createApp, JittorService } from "../src/vehicle/service.ts";

function fixture(result: unknown = { availableCount: 1, credits: [] }) {
	let calls = 0;
	const resets = new SubscriptionResets(
		{
			readResets: async () => {
				calls++;
				return result as never;
			},
			redeemReset: async () => {
				calls++;
				return { code: "reset" };
			},
		},
		async () => {},
	);
	const service = new JittorService(
		new SQLiteMetricStore(openJittorDb(":memory:")),
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		resets,
	);
	const app = createApp({ service, token: "synthetic-token" });
	return { service, app, calls: () => calls };
}

it("rejects extra keys before provider access", async () => {
	const f = fixture();
	try {
		await expect(f.service.execute("subscription.resets.list", { extra: true })).rejects.toThrow();
		expect(f.calls()).toBe(0);
	} finally {
		f.service.close();
	}
});

it.each([null, [], "invalid"])("rejects non-object RPC input", async (input) => {
	const f = fixture();
	try {
		const response = await f.app.fetch(
			new Request("http://localhost/api/v1/ops", {
				method: "POST",
				headers: { authorization: "Bearer synthetic-token" },
				body: JSON.stringify({ op: "subscription.resets.list", input }),
			}),
		);
		expect(response.status).toBe(400);
		expect(f.calls()).toBe(0);
	} finally {
		f.service.close();
	}
});

it.each([
	{ availableCount: 10001, credits: [] },
	{ availableCount: 0, credits: [], extra: true },
	{
		availableCount: 0,
		credits: Array.from({ length: 101 }, () => ({ id: "a", status: "available", resetType: "codex", expiresAt: null })),
	},
	{ availableCount: 0, credits: [{ id: "a", status: "x".repeat(201), resetType: "codex", expiresAt: null }] },
])("rejects malformed provider outputs", async (result) => {
	const f = fixture(result);
	try {
		await expect(f.service.execute("subscription.resets.list", {})).rejects.toThrow();
	} finally {
		f.service.close();
	}
});

it("validates typed client results", async () => {
	const client = new JittorClient("http://localhost", "synthetic-token", async () =>
		Response.json({ result: { availableCount: 0, credits: [], extra: true } }),
	);
	await expect(client.call("subscription.resets.list", {})).rejects.toThrow();
});

it("matches Vehicle and RPC list contracts", async () => {
	const f = fixture();
	try {
		const descriptors = f.service.vehicleRegistry.manifest().operations;
		for (const operation of Object.values(resetContracts)) {
			const { available, approvalRequired, ...descriptor } = descriptors.find((d) => d.name === operation.descriptor.name)!;
			expect(available).toBe(true);
			expect(approvalRequired).toBe(false);
			expect(descriptor).toEqual(operation.descriptor);
		}
		for (const input of [{}, { extra: true }]) {
			const response = await f.app.fetch(
				new Request("http://localhost/vehicle/invoke", {
					method: "POST",
					headers: { authorization: "Bearer synthetic-token" },
					body: JSON.stringify({ name: "subscription.resets.list", version: 1, input }),
				}),
			);
			expect(response.status).toBe(Object.keys(input).length ? 400 : 200);
		}
		expect(f.calls()).toBe(1);
	} finally {
		f.service.close();
	}
});

it.each(["/vehicle/invoke", "/api/v1/ops"])("requires authentication on each transport", async (path) => {
	const f = fixture();
	try {
		const response = await f.app.fetch(
			new Request(`http://localhost${path}`, {
				method: "POST",
				body: JSON.stringify({ name: "subscription.resets.list", op: "subscription.resets.list", version: 1, input: {} }),
			}),
		);
		expect(response.status).toBe(401);
		expect(f.calls()).toBe(0);
	} finally {
		f.service.close();
	}
});

it("honors configured Vehicle approval", async () => {
	const f = fixture();
	try {
		f.service.vehicleRegistry.configureApprovals({ requireApprovalForEffects: ["external-write"] });
		const response = await f.app.fetch(
			new Request("http://localhost/vehicle/invoke", {
				method: "POST",
				headers: { authorization: "Bearer synthetic-token" },
				body: JSON.stringify({
					name: "subscription.resets.redeem",
					version: 1,
					input: { confirm: true, creditId: "reset-1", idempotencyKey: "00000000-0000-4000-8000-000000000001" },
				}),
			}),
		);
		expect(response.status).toBe(403);
		expect(f.calls()).toBe(0);
	} finally {
		f.service.close();
	}
});

it.each([
	{ confirm: false, creditId: "reset-1", idempotencyKey: "00000000-0000-4000-8000-000000000001" },
	{ confirm: true, creditId: "reset-1", idempotencyKey: "00000000-0000-4000-8000-000000000001", extra: true },
	{ confirm: true, creditId: "x".repeat(201), idempotencyKey: "00000000-0000-4000-8000-000000000001" },
])("rejects invalid redemption before transport", async (input) => {
	let calls = 0;
	const client = new JittorClient("http://localhost", "synthetic-token", async () => {
		calls++;
		return Response.json({ result: {} });
	});
	await expect(client.call("subscription.resets.redeem", input as never)).rejects.toThrow();
	expect(calls).toBe(0);
});

it("round-trips CLI redemption through authenticated RPC", async () => {
	const f = fixture();
	const output: string[] = [];
	try {
		const client = new JittorClient("http://localhost", "synthetic-token", (request) => f.app.fetch(request));
		const deps = { client, stdout: (text: string) => output.push(text), stderr: () => {} } as unknown as CliDependencies;
		expect(
			await runCli(
				["resets", "redeem", "--credit-id", "reset-1", "--idempotency-key", "00000000-0000-4000-8000-000000000001", "--confirm", "--json"],
				deps,
			),
		).toBe(0);
		expect(JSON.parse(output[0]!)).toEqual({ code: "reset", telemetryRefreshed: true });
		expect(f.calls()).toBe(1);
	} finally {
		f.service.close();
	}
});

it("reports invalid Vehicle outputs as internal failures", async () => {
	const f = fixture({ availableCount: -1, credits: [] });
	try {
		const response = await f.app.fetch(
			new Request("http://localhost/vehicle/invoke", {
				method: "POST",
				headers: { authorization: "Bearer synthetic-token" },
				body: JSON.stringify({ name: "subscription.resets.list", version: 1, input: {} }),
			}),
		);
		expect(response.status).toBe(500);
		expect(await response.json()).toMatchObject({ error: { code: "invalid-output", category: "internal", retryable: false } });
	} finally {
		f.service.close();
	}
});

it("keeps unknown redemption outcomes single-attempt", async () => {
	let calls = 0;
	const client = new JittorClient("http://localhost", "synthetic-token", async () => {
		calls++;
		return Response.json({ result: { code: "unknown", telemetryRefreshed: false } });
	});
	await expect(
		client.call("subscription.resets.redeem", {
			confirm: true,
			creditId: "reset-1",
			idempotencyKey: "00000000-0000-4000-8000-000000000001",
		}),
	).rejects.toThrow("same credit and key");
	expect(calls).toBe(1);
});
