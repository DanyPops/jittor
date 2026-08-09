import type { TelemetryBatch, TelemetrySource } from "../observability/telemetry-source.ts";
import { OpenRouterTelemetryAdapter, type OpenRouterTransport } from "./telemetry.ts";

export class OpenRouterTelemetrySource implements TelemetrySource {
	readonly id = "openrouter";
	readonly provider = "openrouter";
	readonly required = false;

	constructor(
		private readonly apiKey: string,
		private readonly transport: OpenRouterTransport = fetch,
		private readonly clock: () => number = Date.now,
	) {}

	async poll(): Promise<TelemetryBatch> {
		const observedAt = this.clock();
		const snapshot = await new OpenRouterTelemetryAdapter(this.apiKey, this.transport).readKey(observedAt);
		return { observedAt, metrics: snapshot.metrics, windows: [] };
	}
}
