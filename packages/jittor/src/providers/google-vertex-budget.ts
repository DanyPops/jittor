import type { BudgetWindow } from "../policy.ts";
import type { MetricObservation } from "../domain/metric.ts";
import {
	googleVertexBudgetMetrics,
	googleVertexBudgetWindow,
	parseGoogleVertexBudgetNotification,
	type GoogleVertexBudgetNotification,
} from "./google-vertex-budget-contracts.ts";
import type { GoogleVertexMetricSource } from "./google-vertex-contracts.ts";
import type { GoogleAdcTokenProvider } from "./google-adc-auth.ts";
import { GOOGLE_VERTEX_BUDGET_MAX_MESSAGES_PER_PULL } from "../constants.ts";

export {
	googleVertexBudgetMetrics,
	googleVertexBudgetWindow,
	parseGoogleVertexBudgetNotification,
	type GoogleVertexBudgetAmountType,
	type GoogleVertexBudgetNotification,
} from "./google-vertex-budget-contracts.ts";

const PUBSUB_BASE_URL = "https://pubsub.googleapis.com/v1";
export const GOOGLE_PUBSUB_READONLY_SCOPE = "https://www.googleapis.com/auth/pubsub";

export type GoogleVertexBudgetTransport = (request: Request) => Promise<Response>;

export interface GoogleVertexBudgetSnapshot {
	notification: GoogleVertexBudgetNotification;
	metrics: MetricObservation[];
	window: BudgetWindow | null;
}

interface RawPubSubMessage {
	ackId?: unknown;
	message?: { data?: unknown; publishTime?: unknown; attributes?: Record<string, unknown> };
}

const SUBSCRIPTION_NAME_PATTERN = /^projects\/[^/]+\/subscriptions\/[^/]+$/;

/**
 * Pulls (never pushes -- Jittor is a local loopback-only daemon with no public inbound endpoint)
 * the individual GCP project's budget-notification Pub/Sub subscription, and turns Cloud
 * Billing's own documented notification payload into Jittor's normalized metrics/BudgetWindow
 * shape. One-time setup outside Jittor (create the topic, connect it to the budget, create a pull
 * subscription) is required first -- see docs/PROVIDER_RESEARCH.md.
 */
export class GoogleVertexBudgetTelemetryAdapter {
	constructor(
		private readonly subscription: string,
		private readonly tokenProvider: GoogleAdcTokenProvider,
		private readonly transport: GoogleVertexBudgetTransport = fetch,
		private readonly source: GoogleVertexMetricSource = "google-vertex",
	) {
		if (!SUBSCRIPTION_NAME_PATTERN.test(subscription)) {
			throw new Error("Google Vertex budget subscription must be of the form projects/{project}/subscriptions/{subscription}");
		}
	}

	/**
	 * Pulls the pending notifications, acknowledges every message it received (Pub/Sub pull
	 * subscriptions redeliver un-acked messages forever, and Cloud Billing publishes multiple
	 * times per day regardless of whether Jittor is running -- an un-drained subscription would
	 * grow without bound), and returns the freshest successfully-parsed notification by the
	 * message's own `publishTime`. Throws (fail closed, matching every other Jittor provider's
	 * schema-drift contract) if any pulled message fails to parse, after acknowledging it so a
	 * single malformed message cannot wedge every future poll.
	 */
	async pull(observedAt = Date.now()): Promise<GoogleVertexBudgetSnapshot | null> {
		const token = await this.tokenProvider();
		const pullResponse = await this.request(":pull", token, { maxMessages: GOOGLE_VERTEX_BUDGET_MAX_MESSAGES_PER_PULL });
		const body = await pullResponse.json() as { receivedMessages?: RawPubSubMessage[] };
		const received = Array.isArray(body.receivedMessages) ? body.receivedMessages : [];
		if (received.length === 0) return null;

		const ackIds = received.map((entry) => entry.ackId).filter((id): id is string => typeof id === "string" && id.length > 0);
		let parseFailure: unknown;
		const parsed: GoogleVertexBudgetNotification[] = [];
		for (const entry of received) {
			try {
				parsed.push(this.parseMessage(entry));
			} catch (error) {
				parseFailure = error;
			}
		}
		if (ackIds.length > 0) await this.acknowledge(token, ackIds);
		if (parseFailure) throw parseFailure;
		if (parsed.length === 0) return null;

		const freshest = parsed.reduce((latest, candidate) => candidate.publishedAt > latest.publishedAt ? candidate : latest);
		return {
			notification: freshest,
			metrics: googleVertexBudgetMetrics(freshest, observedAt, this.source),
			window: googleVertexBudgetWindow(freshest, observedAt, this.source),
		};
	}

	private parseMessage(entry: RawPubSubMessage): GoogleVertexBudgetNotification {
		const data = entry.message?.data;
		if (typeof data !== "string" || data.length === 0) throw new Error("Google Vertex budget notification schema changed: message.data");
		const publishTime = entry.message?.publishTime;
		if (typeof publishTime !== "string") throw new Error("Google Vertex budget notification schema changed: message.publishTime");
		const publishedAt = Date.parse(publishTime);
		if (Number.isNaN(publishedAt)) throw new Error("Google Vertex budget notification schema changed: message.publishTime is not RFC 3339");
		let decoded: unknown;
		try {
			decoded = JSON.parse(Buffer.from(data, "base64").toString("utf8"));
		} catch {
			throw new Error("Google Vertex budget notification schema changed: message.data is not valid base64 JSON");
		}
		return parseGoogleVertexBudgetNotification(decoded, entry.message?.attributes ?? {}, publishedAt);
	}

	private async acknowledge(token: string, ackIds: string[]): Promise<void> {
		// Best-effort: a failed ack only causes redelivery after the ack deadline, which the next
		// poll will drain again; it must never fail the poll that already extracted real metrics.
		await this.request(":acknowledge", token, { ackIds }).catch(() => undefined);
	}

	private async request(action: ":pull" | ":acknowledge", token: string, body: Record<string, unknown>): Promise<Response> {
		const response = await this.transport(new Request(`${PUBSUB_BASE_URL}/${this.subscription}${action}`, {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify(body),
		}));
		if (!response.ok) throw new Error(`Google Cloud Pub/Sub ${action.slice(1)} failed with HTTP ${response.status}`);
		return response;
	}
}
