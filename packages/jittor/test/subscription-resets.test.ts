import { expect, it } from "bun:test";
import { runCli } from "../src/cli.ts";
import { type SubscriptionResetProvider, SubscriptionResets } from "../src/observability/subscription-resets.ts";
import { openJittorDb } from "../src/sqlite/database.ts";
import { SQLiteMetricStore } from "../src/sqlite/metric-store.ts";
import { createApp, JittorService } from "../src/vehicle/service.ts";

const input = { confirm: true, creditId: "reset-1", idempotencyKey: "00000000-0000-4000-8000-000000000001" };
function fixture() {
	const calls: unknown[] = [];
	const provider: SubscriptionResetProvider = {
		readResets: async () => ({ availableCount: 1, credits: [] }),
		redeemReset: async (value) => {
			calls.push(value);
			return { code: "reset" };
		},
	};
	let refreshed = 0;
	const resets = new SubscriptionResets(provider, async () => {
		refreshed++;
	});
	return { provider, resets, calls, refreshed: () => refreshed };
}

it("requires explicit confirmation and a stable key", async () => {
	const { resets, calls } = fixture();
	await expect(resets.redeem({ ...input, confirm: false })).rejects.toThrow("confirm");
	await expect(resets.redeem({ ...input, idempotencyKey: "" })).rejects.toThrow("UUID");
	await expect(resets.redeem({ ...input, creditId: "../other" })).rejects.toThrow("creditId");
	expect(calls).toHaveLength(0);
});
it("refreshes telemetry after redemption", async () => {
	const f = fixture();
	expect(await f.resets.redeem(input)).toEqual({ code: "reset", telemetryRefreshed: true });
	expect(f.refreshed()).toBe(1);
});
it("retains successful outcomes when refresh fails", async () => {
	const { provider } = fixture();
	const resets = new SubscriptionResets(provider, async () => {
		throw new Error("offline");
	});
	expect(await resets.redeem(input)).toEqual({ code: "reset", telemetryRefreshed: false });
});
it("bounds post-redemption refresh waiting", async () => {
	const { provider } = fixture();
	const resets = new SubscriptionResets(provider, () => new Promise(() => {}), 5);
	expect(await resets.redeem(input)).toEqual({ code: "reset", telemetryRefreshed: false });
});
it("bounds concurrent provider requests", async () => {
	const { provider } = fixture();
	let release!: () => void;
	provider.readResets = async () => {
		await new Promise<void>((resolve) => {
			release = resolve;
		});
		return { availableCount: 0, credits: [] };
	};
	const resets = new SubscriptionResets(provider, async () => {});
	const pending = resets.list();
	await expect(resets.redeem(input)).rejects.toThrow("in progress");
	release();
	await pending;
	expect((await resets.redeem(input)).code).toBe("reset");
});
it("exposes reset commands over authenticated operations", async () => {
	const f = fixture();
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
		f.resets,
	);
	try {
		const app = createApp({ service, token: "synthetic-token" });
		const invoke = (token: string, operation: string, value: unknown) =>
			app.fetch(
				new Request("http://localhost/api/v1/ops", {
					method: "POST",
					headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
					body: JSON.stringify({ op: operation, input: value }),
				}),
			);
		expect((await invoke("wrong", "subscription.resets.redeem", input)).status).toBe(401);
		expect(f.calls).toHaveLength(0);
		const listed = await invoke("synthetic-token", "subscription.resets.list", {});
		expect(listed.status).toBe(200);
		expect(await listed.json()).toEqual({ result: { availableCount: 1, credits: [] } });
		const manifestResponse = await app.fetch(
			new Request("http://localhost/vehicle/manifest", { headers: { authorization: "Bearer synthetic-token" } }),
		);
		const manifest = (await manifestResponse.json()) as { operations: Array<{ name: string; effect: string; permissions: string[] }> };
		expect(manifest.operations.find((o) => o.name === "subscription.resets.redeem")).toMatchObject({
			effect: "external-write",
			permissions: ["jittor:read", "jittor:write"],
		});
		expect(manifest.operations.find((o) => o.name === "subscription.resets.list")).toMatchObject({
			effect: "read",
			permissions: ["jittor:read"],
		});
		await expect(service.execute("subscription.resets.redeem", { ...input, confirm: false })).rejects.toThrow("confirm");
		const redeemed = await invoke("synthetic-token", "subscription.resets.redeem", input);
		expect(redeemed.status).toBe(200);
		expect(await redeemed.json()).toEqual({ result: { code: "reset", telemetryRefreshed: true } });
		expect(service.operationNames()).toContain("subscription.resets.redeem");
	} finally {
		service.close();
	}
});
it("keeps CLI redemption explicit and forwards retry identity", async () => {
	const calls: unknown[] = [],
		output: string[] = [];
	const deps = {
		client: {
			call: async (operation: string, value: unknown) => {
				calls.push({ operation, input: value });
				return { code: "reset", telemetryRefreshed: true };
			},
		} as never,
		stdout: (s: string) => output.push(s),
		stderr: () => {},
		systemctl: () => {},
		installService: () => {},
		serve: async () => {},
	};
	expect(await runCli(["resets", "redeem", "--credit-id", input.creditId, "--idempotency-key", input.idempotencyKey], deps)).toBe(2);
	expect(calls).toHaveLength(0);
	expect(
		await runCli(
			["resets", "redeem", "--credit-id", input.creditId, "--idempotency-key", input.idempotencyKey, "--confirm", "--json"],
			deps,
		),
	).toBe(0);
	expect(calls).toEqual([{ operation: "subscription.resets.redeem", input }]);
	expect(JSON.parse(output[0]!)).toEqual({ code: "reset", telemetryRefreshed: true });
});
