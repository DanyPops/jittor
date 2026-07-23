import { describe, expect, it } from "bun:test";
import {
	googleVertexBudgetMetrics,
	googleVertexBudgetWindow,
	parseGoogleVertexBudgetNotification,
	type GoogleVertexBudgetNotification,
} from "../src/providers/google-vertex-budget-contracts.ts";
import { GoogleVertexBudgetTelemetryAdapter } from "../src/providers/google-vertex-budget.ts";
import { GoogleVertexBudgetTelemetrySource } from "../src/providers/telemetry-sources.ts";

/** Google's own worked test fixture from docs.cloud.google.com/billing/docs/how-to/listen-to-notifications. */
const GOOGLE_FIXTURE_DATA = {
	budgetDisplayName: "name-of-budget",
	alertThresholdExceeded: 1.0,
	costAmount: 100.01,
	costIntervalStart: "2019-01-01T00:00:00Z",
	budgetAmount: 100.00,
	budgetAmountType: "SPECIFIED_AMOUNT",
	currencyCode: "USD",
};
const GOOGLE_FIXTURE_ATTRIBUTES = { billingAccountId: "01D4EE-079462-DFD6EC", budgetId: "de72f49d-779b-4945-a127-4d6ce8def0bb", schemaVersion: "1.0" };

function base64(value: unknown): string {
	return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function pullResponse(messages: Array<{ ackId: string; data: unknown; publishTime: string; attributes?: Record<string, unknown> }>): Response {
	return Response.json({
		receivedMessages: messages.map((entry) => ({
			ackId: entry.ackId,
			message: { data: base64(entry.data), publishTime: entry.publishTime, attributes: entry.attributes ?? GOOGLE_FIXTURE_ATTRIBUTES },
		})),
	});
}

describe("Google Vertex budget notification parsing", () => {
	it("parses Google's own documented fixture", () => {
		const notification = parseGoogleVertexBudgetNotification(GOOGLE_FIXTURE_DATA, GOOGLE_FIXTURE_ATTRIBUTES, Date.parse("2019-01-01T06:00:00Z"));
		expect(notification).toEqual({
			billingAccountId: "01D4EE-079462-DFD6EC",
			budgetId: "de72f49d-779b-4945-a127-4d6ce8def0bb",
			schemaVersion: "1.0",
			budgetDisplayName: "name-of-budget",
			costAmount: 100.01,
			costIntervalStart: Date.parse("2019-01-01T00:00:00Z"),
			budgetAmount: 100.00,
			budgetAmountType: "SPECIFIED_AMOUNT",
			currencyCode: "USD",
			alertThresholdExceeded: 1.0,
			forecastThresholdExceeded: undefined,
			publishedAt: Date.parse("2019-01-01T06:00:00Z"),
		});
	});

	it("fails closed when budgetAmountType drifts to an unrecognized value", () => {
		expect(() => parseGoogleVertexBudgetNotification({ ...GOOGLE_FIXTURE_DATA, budgetAmountType: "SOMETHING_NEW" }, GOOGLE_FIXTURE_ATTRIBUTES, 1_000))
			.toThrow(/schema changed: budgetAmountType/);
	});

	it("fails closed when a required field is missing", () => {
		const { costAmount, ...withoutCostAmount } = GOOGLE_FIXTURE_DATA;
		expect(() => parseGoogleVertexBudgetNotification(withoutCostAmount, GOOGLE_FIXTURE_ATTRIBUTES, 1_000)).toThrow(/schema changed: costAmount/);
	});

	it("fails closed when costIntervalStart is not RFC 3339", () => {
		expect(() => parseGoogleVertexBudgetNotification({ ...GOOGLE_FIXTURE_DATA, costIntervalStart: "not-a-date" }, GOOGLE_FIXTURE_ATTRIBUTES, 1_000))
			.toThrow(/costIntervalStart is not RFC 3339/);
	});

	it("fails closed when Pub/Sub attributes are missing", () => {
		expect(() => parseGoogleVertexBudgetNotification(GOOGLE_FIXTURE_DATA, {}, 1_000)).toThrow(/schema changed: billingAccountId/);
	});
});

describe("Google Vertex budget metrics and window", () => {
	const notification = parseGoogleVertexBudgetNotification(GOOGLE_FIXTURE_DATA, GOOGLE_FIXTURE_ATTRIBUTES, 1_700_000_000_000);

	it("emits real spend/cap dollar figures and their honest, unclamped ratio", () => {
		const metrics = googleVertexBudgetMetrics(notification, 2_000);
		expect(metrics.map((metric) => [metric.source, metric.scope, metric.metric, metric.value, metric.unit])).toEqual([
			["google-vertex", "budget", "spend", 100.01, "usd"],
			["google-vertex", "budget", "cap", 100.00, "usd"],
			["google-vertex", "budget", "spend-fraction", 100.01 / 100.00, "ratio"],
		]);
		expect(metrics[0]?.attributes).toMatchObject({ budgetId: "de72f49d-779b-4945-a127-4d6ce8def0bb", currencyCode: "USD", alertThresholdExceeded: 1.0 });
	});

	it("tags the anthropic-vertex source distinctly from the native google-vertex source", () => {
		const metrics = googleVertexBudgetMetrics(notification, 2_000, "anthropic-vertex");
		expect(metrics.every((metric) => metric.source === "anthropic-vertex")).toBe(true);
	});

	it("omits spend-fraction when the budget cap is not a usable positive amount", () => {
		const zeroCap: GoogleVertexBudgetNotification = { ...notification, budgetAmount: 0 };
		const metrics = googleVertexBudgetMetrics(zeroCap, 2_000);
		expect(metrics.map((metric) => metric.metric)).toEqual(["spend", "cap"]);
	});

	it("builds a BudgetWindow clamped to 1.0 even when real spend exceeds a soft-quota cap", () => {
		const overCap: GoogleVertexBudgetNotification = { ...notification, costAmount: 150 };
		const window = googleVertexBudgetWindow(overCap, 3_000);
		expect(window?.usedFraction).toBe(1);
		expect(window?.freshness).toBe("fresh");
		expect(window?.observedAt).toBe(3_000);
	});

	it("resets at the next Pacific-time calendar month boundary from costIntervalStart", () => {
		const window = googleVertexBudgetWindow(notification, 3_000);
		// 2019-01-01T00:00:00Z is 2018-12-31T16:00:00 Pacific (UTC-8); next month start is 2019-01-01T08:00:00Z Pacific midnight.
		expect(window?.resetsAt).toBe(Date.parse("2019-01-01T08:00:00Z"));
		expect(window?.windowSeconds).toBe((Date.parse("2019-01-01T08:00:00Z") - Date.parse("2019-01-01T00:00:00Z")) / 1_000);
	});

	it("returns no window for a non-positive cap instead of fabricating one", () => {
		expect(googleVertexBudgetWindow({ ...notification, budgetAmount: -5 }, 3_000)).toBeNull();
	});
});

describe("GoogleVertexBudgetTelemetryAdapter", () => {
	it("rejects a subscription name that isn't projects/*/subscriptions/*", () => {
		expect(() => new GoogleVertexBudgetTelemetryAdapter("bad-name", async () => "token")).toThrow(/projects\/\{project\}\/subscriptions/);
	});

	it("pulls with a bearer token, decodes the freshest message by publishTime, and acknowledges every ackId", async () => {
		const requests: Request[] = [];
		const older = { ackId: "ack-older", data: { ...GOOGLE_FIXTURE_DATA, costAmount: 10 }, publishTime: "2026-07-01T00:00:00Z" };
		const newer = { ackId: "ack-newer", data: { ...GOOGLE_FIXTURE_DATA, costAmount: 42 }, publishTime: "2026-07-02T00:00:00Z" };
		const adapter = new GoogleVertexBudgetTelemetryAdapter(
			"projects/my-proj/subscriptions/my-sub",
			async () => "adc-token",
			async (request) => {
				requests.push(request);
				if (request.url.endsWith(":pull")) return pullResponse([older, newer]);
				return Response.json({});
			},
		);

		const snapshot = await adapter.pull(5_000);

		expect(requests[0]?.url).toBe("https://pubsub.googleapis.com/v1/projects/my-proj/subscriptions/my-sub:pull");
		expect(requests[0]?.headers.get("authorization")).toBe("Bearer adc-token");
		expect(await requests[0]?.json()).toEqual({ maxMessages: 20 });
		expect(snapshot?.notification.costAmount).toBe(42);
		expect(requests[1]?.url).toBe("https://pubsub.googleapis.com/v1/projects/my-proj/subscriptions/my-sub:acknowledge");
		expect(await requests[1]?.json()).toEqual({ ackIds: ["ack-older", "ack-newer"] });
	});

	it("returns null when the subscription has no pending messages", async () => {
		const adapter = new GoogleVertexBudgetTelemetryAdapter("projects/p/subscriptions/s", async () => "token", async () => Response.json({}));
		expect(await adapter.pull(1_000)).toBeNull();
	});

	it("fails closed on a malformed message but still acknowledges it so it cannot wedge future polls", async () => {
		const requests: Request[] = [];
		const adapter = new GoogleVertexBudgetTelemetryAdapter(
			"projects/p/subscriptions/s",
			async () => "token",
			async (request) => {
				requests.push(request);
				if (request.url.endsWith(":pull")) return pullResponse([{ ackId: "ack-bad", data: { not: "a budget notification" }, publishTime: "2026-07-01T00:00:00Z" }]);
				return Response.json({});
			},
		);

		await expect(adapter.pull(1_000)).rejects.toThrow(/schema changed/);
		expect(await requests[1]?.json()).toEqual({ ackIds: ["ack-bad"] });
	});

	it("throws when Pub/Sub responds with a non-2xx status", async () => {
		const adapter = new GoogleVertexBudgetTelemetryAdapter("projects/p/subscriptions/s", async () => "token", async () => new Response("nope", { status: 403 }));
		await expect(adapter.pull(1_000)).rejects.toThrow(/HTTP 403/);
	});
});

describe("GoogleVertexBudgetTelemetrySource", () => {
	it("wraps a pulled snapshot into a TelemetryBatch with its BudgetWindow", async () => {
		const source = new GoogleVertexBudgetTelemetrySource(
			"projects/p/subscriptions/s",
			async () => "token",
			() => 9_000,
			async (request) => (request.url.endsWith(":pull") ? pullResponse([{ ackId: "a", data: GOOGLE_FIXTURE_DATA, publishTime: "2026-07-01T00:00:00Z" }]) : Response.json({})),
		);

		const batch = await source.poll();

		expect(batch.observedAt).toBe(9_000);
		expect(batch.metrics.map((metric) => metric.metric)).toEqual(["spend", "cap", "spend-fraction"]);
		expect(batch.windows).toHaveLength(1);
		expect(source.id).toBe("google-vertex-budget:google-vertex");
		expect(source.required).toBe(false);
	});

	it("returns an empty batch, not an error, when nothing is pending", async () => {
		const source = new GoogleVertexBudgetTelemetrySource("projects/p/subscriptions/s", async () => "token", () => 1_000, async () => Response.json({}));
		const batch = await source.poll();
		expect(batch).toEqual({ observedAt: 1_000, metrics: [], windows: [] });
	});
});
