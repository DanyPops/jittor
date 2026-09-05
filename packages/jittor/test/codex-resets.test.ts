import { describe, expect, it } from "bun:test";
import { CodexSubscriptionTelemetryAdapter, parseCodexUsage } from "../src/codex/telemetry.ts";

const credentials = { accessToken: "synthetic-token", accountId: "synthetic-account" };
const credit = { id: "reset-1", status: "available", reset_type: "codex_rate_limits", expires_at: "2030-01-01T00:00:00Z" };
const key = "00000000-0000-4000-8000-000000000001";

describe("Codex banked resets", () => {
	it.each([0, 1, 5])("records %i available resets separately from paid credits", (count) => {
		const snapshot = parseCodexUsage({ plan_type: "plus", rate_limit_reset_credits: { available_count: count } }, 1000);
		expect(snapshot.availableResets).toBe(count);
		expect(snapshot.metrics).toContainEqual(expect.objectContaining({ scope: "codex:resets", metric: "available-resets", value: count }));
	});
	it.each([undefined, null])("keeps absent reset counts unknown", (value) => {
		const snapshot = parseCodexUsage({ plan_type: "plus", rate_limit_reset_credits: value });
		expect(snapshot.availableResets).toBeNull();
		expect(snapshot.metrics).toContainEqual(expect.objectContaining({ metric: "available-resets", value: null }));
	});
	it.each([-1, 1.5, "1", 10001])("rejects invalid reset counts", (count) => {
		expect(() => parseCodexUsage({ plan_type: "plus", rate_limit_reset_credits: { available_count: count } })).toThrow("reset");
	});
	it("reads bounded details using the authoritative count", async () => {
		const adapter = new CodexSubscriptionTelemetryAdapter(credentials, async (request) => {
			expect(request.url).toBe("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits");
			expect(request.method).toBe("GET");
			expect(request.redirect).toBe("error");
			expect(request.headers.get("authorization")).toBe("Bearer synthetic-token");
			expect(request.headers.get("chatgpt-account-id")).toBe("synthetic-account");
			return Response.json({ available_count: 3, credits: [credit], ignored: "private" });
		});
		const result = await adapter.readResets();
		expect(result.availableCount).toBe(3);
		expect(result.credits).toEqual([
			{ id: "reset-1", status: "available", resetType: "codex_rate_limits", expiresAt: "2030-01-01T00:00:00.000Z" },
		]);
		expect(JSON.stringify(result)).not.toContain("private");
	});
	it.each(["reset", "already_redeemed", "nothing_to_reset", "no_credit"])("preserves %s outcomes and request identity", async (code) => {
		const bodies: unknown[] = [];
		const adapter = new CodexSubscriptionTelemetryAdapter(credentials, async (request) => {
			expect(request.method).toBe("POST");
			expect(request.url.endsWith("/rate-limit-reset-credits/consume")).toBe(true);
			bodies.push(await request.json());
			return Response.json({ code, private: "omitted" });
		});
		for (let i = 0; i < 2; i++) expect(await adapter.redeemReset({ creditId: "reset-1", idempotencyKey: key })).toEqual({ code });
		expect(bodies).toEqual(Array(2).fill({ credit_id: "reset-1", redeem_request_id: key }));
	});
	it.each([401, 403, 500])("reports HTTP %i without response content", async (status) => {
		const adapter = new CodexSubscriptionTelemetryAdapter(credentials, async () => new Response("private payload", { status }));
		await expect(adapter.readResets()).rejects.toThrow(`HTTP ${status}`);
	});
	it("rejects unknown outcomes", async () => {
		const adapter = new CodexSubscriptionTelemetryAdapter(credentials, async () => Response.json({ code: "unexpected" }));
		await expect(adapter.redeemReset({ creditId: "reset-1", idempotencyKey: key })).rejects.toThrow("outcome");
	});
	it("bounds response bytes and cancels oversized streams", async () => {
		let canceled = false;
		const adapter = new CodexSubscriptionTelemetryAdapter(
			credentials,
			async () =>
				new Response(
					new ReadableStream({
						pull(controller) {
							controller.enqueue(new Uint8Array(70_000));
						},
						cancel() {
							canceled = true;
						},
					}),
				),
		);
		await expect(adapter.readResets()).rejects.toThrow("size");
		expect(canceled).toBe(true);
	});
	it("bounds credit details", async () => {
		const adapter = new CodexSubscriptionTelemetryAdapter(credentials, async () =>
			Response.json({ available_count: 101, credits: Array(101).fill(credit) }),
		);
		await expect(adapter.readResets()).rejects.toThrow("credits");
	});
	it("sanitizes streaming failures", async () => {
		const adapter = new CodexSubscriptionTelemetryAdapter(
			credentials,
			async () =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.error(new Error("private payload"));
						},
					}),
				),
		);
		await expect(adapter.readResets()).rejects.toThrow("Codex reset response interrupted");
	});
	it("rejects non-JSON responses", async () => {
		const adapter = new CodexSubscriptionTelemetryAdapter(credentials, async () => new Response("private HTML"));
		await expect(adapter.readResets()).rejects.toThrow("Codex reset response was not JSON");
	});
	it("sanitizes transport failures", async () => {
		const adapter = new CodexSubscriptionTelemetryAdapter(credentials, async () => {
			throw new Error("private payload");
		});
		await expect(adapter.readResets()).rejects.toThrow("Codex reset request failed");
	});
});
