import {
	OTLP_EXPORT_BATCH_SIZE,
	OTLP_EXPORT_INTERVAL_MS,
	OTLP_EXPORT_MAX_QUEUE_SIZE,
	OTLP_EXPORT_MAX_RETRIES,
	OTLP_EXPORT_TIMEOUT_MS,
} from "../constants.ts";
import type { MetricObservation } from "../observability/metric.ts";
import type { ObservationExporter, ObservationExportStatus } from "../telemetry-export/exporter.ts";

export const OTLP_GENAI_SEMANTIC_CONVENTIONS = "genai@46d43c8949afb53765a202e89f4534eeb75ca3fa+core-v1.44.0";

export interface OtlpMetricPoint {
	name: string;
	unit: string;
	value: number;
	observedAt: number;
	attributes: Record<string, string | number | boolean>;
}

function bounded(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length < 1 || value.length > 200 || /\p{Cc}/u.test(value)) return undefined;
	return value;
}

function boundedIdentity(value: unknown): string | undefined {
	const result = bounded(value);
	return result && /^[a-zA-Z0-9@~][a-zA-Z0-9@~._:+/-]*$/.test(result) && !result.includes("//") ? result : undefined;
}

function providerName(value: string): string {
	if (value === "openai-codex") return "openai";
	if (value === "google" || value === "google-gemini") return "gcp.gemini";
	if (value === "google-vertex" || value === "anthropic-vertex") return "gcp.vertex_ai";
	return value;
}

function identity(observation: MetricObservation): { provider?: string; model?: string } {
	const provider = boundedIdentity(observation.attributes?.provider);
	const model = boundedIdentity(observation.attributes?.model);
	if (provider || model) return { ...(provider ? { provider } : {}), ...(model ? { model } : {}) };
	const separator = observation.scope.includes(":") ? ":" : observation.scope.includes("/") ? "/" : null;
	if (!separator) return {};
	const [scopeProvider, ...modelParts] = observation.scope.split(separator);
	const scopeModel = modelParts.join(separator);
	return {
		...(boundedIdentity(scopeProvider) ? { provider: scopeProvider } : {}),
		...(boundedIdentity(scopeModel) ? { model: scopeModel } : {}),
	};
}

const CUSTOM_ATTRIBUTES: Record<string, string> = {
	mechanism: "jittor.compaction.mechanism",
	reason: "jittor.compaction.reason",
	willRetry: "jittor.compaction.will_retry",
	threshold: "jittor.compaction.regrowth_threshold",
	preContextTokens: "jittor.compaction.pre_context_tokens",
	postContextTokens: "jittor.compaction.post_context_tokens",
	summaryTokens: "jittor.compaction.summary_tokens",
	turnsSinceCompaction: "jittor.compaction.turns_since",
	elapsedSinceCompactionMs: "jittor.compaction.elapsed_since_ms",
	contextTokens: "jittor.context.tokens",
	pressure: "jittor.routing.pressure",
	action: "jittor.routing.action",
};

const CUSTOM_ATTRIBUTE_VALUES: Record<string, ReadonlySet<string>> = {
	mechanism: new Set(["pi-native", "provider-side", "extension"]),
	reason: new Set(["manual", "threshold", "overflow"]),
	action: new Set(["continue", "warn", "throttle", "downgrade-thinking", "handoff", "halt"]),
};

function safeCustomAttributes(input: Record<string, unknown> | undefined): Record<string, string | number | boolean> {
	const result: Record<string, string | number | boolean> = {};
	if (!input) return result;
	for (const [source, target] of Object.entries(CUSTOM_ATTRIBUTES)) {
		const value = input[source];
		if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) result[target] = value;
		else {
			const text = bounded(value);
			if (text && CUSTOM_ATTRIBUTE_VALUES[source]?.has(text)) result[target] = text;
		}
	}
	return result;
}

function safeName(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9_.]+/g, "_")
		.slice(0, 100);
}

export function mapObservationToOtlp(observation: MetricObservation): OtlpMetricPoint | null {
	if (typeof observation.value !== "number" || !Number.isFinite(observation.value) || observation.value < 0) return null;
	const ids = identity(observation);
	const requestedOperation = bounded(observation.attributes?.operation);
	const operation =
		requestedOperation &&
		new Set(["chat", "generate_content", "text_completion", "embeddings", "invoke_agent", "invoke_workflow", "execute_tool"]).has(
			requestedOperation,
		)
			? requestedOperation
			: "chat";
	const attributes: Record<string, string | number | boolean> = {
		"gen_ai.operation.name": operation,
		...safeCustomAttributes(observation.attributes),
	};
	if (ids.provider) attributes["gen_ai.provider.name"] = providerName(ids.provider);
	if (ids.model) attributes["gen_ai.request.model"] = ids.model;
	const thinking = bounded(observation.attributes?.thinking);
	if (thinking && new Set(["off", "none", "minimal", "low", "medium", "high", "xhigh", "max"]).has(thinking))
		attributes["gen_ai.request.reasoning.level"] = thinking;
	const runId = bounded(observation.attributes?.runId) ?? bounded(observation.attributes?.importIdentity);
	if (runId && /^[a-zA-Z0-9_-]+$/.test(runId)) attributes["jittor.run.id"] = runId;
	const conversationId = bounded(observation.attributes?.sessionId) ?? bounded(observation.attributes?.session_id);
	if (conversationId && conversationId.length >= 32 && /^[a-zA-Z0-9_-]+$/.test(conversationId))
		attributes["gen_ai.conversation.id"] = conversationId;

	let name: string;
	let unit: string;
	let value = observation.value;
	if (observation.metric === "input-tokens" || observation.metric === "output-tokens") {
		name = "gen_ai.client.token.usage";
		unit = "{token}";
		attributes["gen_ai.token.type"] = observation.metric === "input-tokens" ? "input" : "output";
	} else if (observation.metric === "cache-read-tokens" || observation.metric === "cache-write-tokens") {
		name = "jittor.gen_ai.cache.token.usage";
		unit = "{token}";
		attributes["jittor.token.type"] = observation.metric === "cache-read-tokens" ? "cache_read" : "cache_write";
	} else if (observation.metric === "reasoning-tokens") {
		name = "jittor.gen_ai.reasoning.token.usage";
		unit = "{token}";
	} else if (observation.metric === "wall-latency") {
		name = "gen_ai.client.operation.duration";
		unit = "s";
		value /= 1_000;
	} else if (observation.metric === "ttft") {
		name = "gen_ai.client.operation.time_to_first_chunk";
		unit = "s";
		value /= 1_000;
	} else if (observation.metric === "output-throughput") {
		name = "jittor.gen_ai.output.throughput";
		unit = "{token}/s";
	} else {
		name = `jittor.${safeName(observation.source)}.${safeName(observation.metric)}`;
		unit = observation.unit;
	}
	if (observation.metric === "failure" && observation.value > 0) attributes["error.type"] = "_OTHER";
	return { name, unit, value, observedAt: observation.observedAt, attributes };
}

function otlpAttribute(key: string, value: string | number | boolean): object {
	return {
		key,
		value:
			typeof value === "string"
				? { stringValue: value }
				: typeof value === "boolean"
					? { boolValue: value }
					: Number.isSafeInteger(value)
						? { intValue: String(value) }
						: { doubleValue: value },
	};
}

export function buildOtlpMetricsRequest(points: OtlpMetricPoint[]): object {
	const grouped = new Map<string, OtlpMetricPoint[]>();
	for (const point of points) {
		const key = `${point.name}\0${point.unit}`;
		grouped.set(key, [...(grouped.get(key) ?? []), point]);
	}
	return {
		resourceMetrics: [
			{
				resource: {
					attributes: [otlpAttribute("service.name", "jittor"), otlpAttribute("jittor.semconv.version", OTLP_GENAI_SEMANTIC_CONVENTIONS)],
				},
				scopeMetrics: [
					{
						scope: { name: "@danypops/jittor", version: OTLP_GENAI_SEMANTIC_CONVENTIONS },
						metrics: [...grouped.values()].map((values) => ({
							name: values[0]!.name,
							unit: values[0]!.unit,
							histogram: {
								aggregationTemporality: 1,
								dataPoints: values.map((point) => ({
									timeUnixNano: String(point.observedAt * 1_000_000),
									count: "1",
									sum: point.value,
									min: point.value,
									max: point.value,
									explicitBounds: [],
									bucketCounts: ["1"],
									attributes: Object.entries(point.attributes).map(([key, value]) => otlpAttribute(key, value)),
								})),
							},
						})),
					},
				],
			},
		],
	};
}

export type OtlpTransport = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface OtlpObservationExporterOptions {
	endpoint: string;
	headers?: Record<string, string>;
	transport?: OtlpTransport;
	clock?: () => number;
	maxQueueSize?: number;
	batchSize?: number;
	intervalMs?: number;
	timeoutMs?: number;
	maxRetries?: number;
}

export class OtlpObservationExporter implements ObservationExporter {
	private readonly endpoint: string;
	private readonly headers: Record<string, string>;
	private readonly transport: OtlpTransport;
	private readonly clock: () => number;
	private readonly maxQueueSize: number;
	private readonly batchSize: number;
	private readonly timeoutMs: number;
	private readonly maxRetries: number;
	private readonly queue: OtlpMetricPoint[] = [];
	private timer: ReturnType<typeof setInterval> | undefined;
	private flushing: Promise<void> | undefined;
	private closed = false;
	private exported = 0;
	private dropped = 0;
	private failures = 0;
	private lastSuccessAt: number | null = null;
	private lastFailureAt: number | null = null;

	constructor(options: OtlpObservationExporterOptions) {
		const url = new URL(options.endpoint);
		if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
			throw new Error("OTLP endpoint must use HTTPS or loopback HTTP");
		this.endpoint = url.toString();
		this.headers = { ...(options.headers ?? {}) };
		this.transport = options.transport ?? fetch;
		this.clock = options.clock ?? Date.now;
		this.maxQueueSize = Math.max(1, options.maxQueueSize ?? OTLP_EXPORT_MAX_QUEUE_SIZE);
		this.batchSize = Math.max(1, options.batchSize ?? OTLP_EXPORT_BATCH_SIZE);
		this.timeoutMs = Math.max(1, options.timeoutMs ?? OTLP_EXPORT_TIMEOUT_MS);
		this.maxRetries = Math.max(0, options.maxRetries ?? OTLP_EXPORT_MAX_RETRIES);
		this.timer = setInterval(() => void this.flush(), Math.max(10, options.intervalMs ?? OTLP_EXPORT_INTERVAL_MS));
		this.timer.unref?.();
	}

	enqueue(observation: MetricObservation): void {
		const point = mapObservationToOtlp(observation);
		if (!point) return;
		if (this.closed) {
			this.dropped += 1;
			return;
		}
		if (this.queue.length >= this.maxQueueSize) {
			this.queue.shift();
			this.dropped += 1;
		}
		this.queue.push(point);
		if (this.queue.length >= this.batchSize) queueMicrotask(() => void this.flush());
	}

	async flush(): Promise<void> {
		if (this.flushing) return this.flushing;
		if (this.queue.length === 0) return;
		this.flushing = (async () => {
			while (this.queue.length > 0) await this.send(this.queue.splice(0, this.batchSize));
		})().finally(() => {
			this.flushing = undefined;
		});
		return this.flushing;
	}

	private async send(points: OtlpMetricPoint[]): Promise<void> {
		const body = JSON.stringify(buildOtlpMetricsRequest(points));
		for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
			try {
				const response = await this.transport(this.endpoint, {
					method: "POST",
					headers: { "content-type": "application/json", ...this.headers },
					body,
					signal: controller.signal,
				});
				if (!response.ok) throw new Error("OTLP collector rejected export");
				this.exported += points.length;
				this.lastSuccessAt = this.clock();
				return;
			} catch {
				if (attempt < this.maxRetries) continue;
				this.failures += 1;
				this.dropped += points.length;
				this.lastFailureAt = this.clock();
			} finally {
				clearTimeout(timeout);
			}
		}
	}

	status(): ObservationExportStatus {
		return {
			enabled: true,
			semanticConventions: OTLP_GENAI_SEMANTIC_CONVENTIONS,
			queued: this.queue.length,
			dropped: this.dropped,
			exported: this.exported,
			failures: this.failures,
			lastSuccessAt: this.lastSuccessAt,
			lastFailureAt: this.lastFailureAt,
		};
	}

	async shutdown(): Promise<void> {
		this.closed = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		while (this.queue.length > 0) await this.flush();
		if (this.flushing) await this.flushing;
	}
}

function parseHeaders(raw: string | undefined): Record<string, string> {
	if (!raw) return {};
	const result: Record<string, string> = {};
	for (const pair of raw.split(",")) {
		const separator = pair.indexOf("=");
		if (separator < 1) continue;
		const key = pair.slice(0, separator).trim().toLowerCase();
		if (!/^[a-z0-9-]+$/.test(key)) continue;
		try {
			result[key] = decodeURIComponent(pair.slice(separator + 1).trim());
		} catch {}
	}
	return result;
}

export function otlpExporterFromEnvironment(env: Record<string, string | undefined> = process.env): ObservationExporter | null {
	let endpoint = env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
	if (!endpoint && env.OTEL_EXPORTER_OTLP_ENDPOINT)
		endpoint = new URL(
			"v1/metrics",
			env.OTEL_EXPORTER_OTLP_ENDPOINT.endsWith("/") ? env.OTEL_EXPORTER_OTLP_ENDPOINT : `${env.OTEL_EXPORTER_OTLP_ENDPOINT}/`,
		).toString();
	if (!endpoint) return null;
	return new OtlpObservationExporter({ endpoint, headers: parseHeaders(env.OTEL_EXPORTER_OTLP_HEADERS) });
}
