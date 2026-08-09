import type { TelemetryBatch, TelemetrySource } from "../observability/telemetry-source.ts";
import type { GoogleAdcTokenProvider } from "./auth.ts";
import { GoogleVertexBudgetTelemetryAdapter, type GoogleVertexBudgetTransport } from "./budget-telemetry.ts";
import type { GoogleVertexMetricSource } from "./failures.ts";

/**
 * Optional because project budget notification setup happens outside Jittor; its absence cannot
 * block unrelated routes.
 */
export class GoogleVertexBudgetTelemetrySource implements TelemetrySource {
	readonly id: string;
	readonly provider: GoogleVertexMetricSource;
	readonly required = false;

	private readonly adapter: GoogleVertexBudgetTelemetryAdapter;

	constructor(
		subscription: string,
		tokenProvider: GoogleAdcTokenProvider,
		private readonly clock: () => number = Date.now,
		transport: GoogleVertexBudgetTransport = fetch,
		source: GoogleVertexMetricSource = "google-vertex",
	) {
		this.id = `google-vertex-budget:${source}`;
		this.provider = source;
		this.adapter = new GoogleVertexBudgetTelemetryAdapter(subscription, tokenProvider, transport, source);
	}

	async poll(): Promise<TelemetryBatch> {
		const observedAt = this.clock();
		const snapshot = await this.adapter.pull(observedAt);
		if (!snapshot) return { observedAt, metrics: [], windows: [] };
		return { observedAt, metrics: snapshot.metrics, windows: snapshot.window ? [snapshot.window] : [] };
	}
}
