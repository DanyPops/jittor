import {
	classifyGoogleVertexFailure,
	type GoogleVertexFailureMetadata,
	googleVertexFailureMetrics,
	hasAnthropicRateLimitHeaders,
	type MetricObservation,
	parseAnthropicRateLimitHeaders,
	parseCodexRateLimitHeaders,
} from "@danypops/jittor";
import { headerValue } from "./http-headers.ts";

export interface ProviderTelemetryClient {
	call(operation: string, input: unknown): Promise<any>;
}

async function recordMetrics(client: ProviderTelemetryClient, metrics: MetricObservation[]): Promise<void> {
	if (metrics.length === 0) return;
	await client.call("metrics.record_batch", { observations: metrics });
}

/**
 * Bounded telemetry derived directly from provider HTTP responses and finalized messages, for
 * every provider except Codex (whose response tracking is settled-turn-recovery's own concern --
 * see codex-recovery.ts). Anthropic and anthropic-vertex official rate-limit headers become
 * budget metrics; Google Vertex and anthropic-vertex failures become bounded, content-free
 * failure-count metrics classified from GCP's own `google.rpc.Status` shape. anthropic-vertex is
 * tracked distinctly from both google-vertex (different code path, different quota pool) and
 * direct anthropic (different transport), never conflated with either.
 */
export class ProviderResponseTelemetry {
	private lastGoogleVertexResponse: GoogleVertexFailureMetadata = {};
	private lastAnthropicVertexResponse: GoogleVertexFailureMetadata = {};

	resetTurn(): void {
		this.lastGoogleVertexResponse = {};
		this.lastAnthropicVertexResponse = {};
	}

	async handleProviderResponse(
		client: ProviderTelemetryClient,
		provider: string | undefined,
		status: number,
		headers: Record<string, string>,
		notifySchemaDrift: (message: string) => void,
	): Promise<void> {
		if (provider === "anthropic") {
			const parsedHeaders = new Headers(headers);
			if (hasAnthropicRateLimitHeaders(parsedHeaders)) {
				try {
					await recordMetrics(client, parseAnthropicRateLimitHeaders(parsedHeaders, Date.now()).metrics);
				} catch {
					notifySchemaDrift("Anthropic telemetry schema drift");
				}
			}
		}
		if (provider === "anthropic-vertex") {
			// Best-effort only: unverified whether this passthrough ever forwards Anthropic's own
			// rate-limit headers. If it doesn't, hasAnthropicRateLimitHeaders is false and nothing is
			// recorded -- the same honest default as every other unconfirmed signal in this module.
			const parsedHeaders = new Headers(headers);
			if (hasAnthropicRateLimitHeaders(parsedHeaders)) {
				try {
					await recordMetrics(client, parseAnthropicRateLimitHeaders(parsedHeaders, Date.now(), "anthropic-vertex").metrics);
				} catch {
					notifySchemaDrift("Anthropic-on-Vertex telemetry schema drift");
				}
			}
			// Well-evidenced regardless of headers: GCP's own quota system fronts this transport, so the
			// same failure classification as google-vertex applies below.
			this.lastAnthropicVertexResponse = {
				status,
				...(headerValue(headers, "retry-after") ? { retryAfter: headerValue(headers, "retry-after") } : {}),
			};
		}
		if (provider === "google-vertex") {
			this.lastGoogleVertexResponse = {
				status,
				...(headerValue(headers, "retry-after") ? { retryAfter: headerValue(headers, "retry-after") } : {}),
			};
		}
		if (Object.keys(headers).some((name) => name.toLowerCase().startsWith("x-codex-"))) {
			try {
				const updates = parseCodexRateLimitHeaders(new Headers(headers), Date.now());
				await recordMetrics(
					client,
					updates.flatMap((update) => update.metrics),
				);
			} catch {
				notifySchemaDrift("Codex telemetry schema drift");
			}
		}
	}

	async handleMessageEnd(
		client: ProviderTelemetryClient,
		provider: string | undefined,
		stopReason: string | undefined,
		errorMessage: string | undefined,
	): Promise<void> {
		if (provider === "google-vertex") {
			if (stopReason === "error") {
				const failure = classifyGoogleVertexFailure(errorMessage, this.lastGoogleVertexResponse);
				await recordMetrics(client, googleVertexFailureMetrics(failure, Date.now())).catch(() => undefined);
			}
			this.lastGoogleVertexResponse = {};
		}
		if (provider === "anthropic-vertex") {
			if (stopReason === "error") {
				const failure = classifyGoogleVertexFailure(errorMessage, this.lastAnthropicVertexResponse);
				await recordMetrics(client, googleVertexFailureMetrics(failure, Date.now(), "anthropic-vertex")).catch(() => undefined);
			}
			this.lastAnthropicVertexResponse = {};
		}
	}
}
