import { CONTEXT_ASSESSMENT_DEFAULT_WINDOW_MS, CONTEXT_ASSESSMENT_QUERY_LIMIT, SERVICE_MAX_BODY_BYTES, SERVICE_MAX_RESPONSE_BYTES } from "./constants.ts";
import { VERSION } from "./version.ts";
import { validateMetricObservation, type MetricObservation, type MetricQuery, type StoredMetricObservation } from "./domain/metric.ts";
import { assessContextTelemetry, type ContextAssessment } from "./domain/context-telemetry.ts";
import type { BenchmarkQuery, BenchmarkQueryResult, BenchmarkRefreshResult } from "./domain/benchmark.ts";
import type { ModelRanker, ModelRecommendationInput } from "./domain/model-ranking-service.ts";
import type { ModelRankingResult } from "./domain/model-ranking.ts";
import type { BenchmarkController } from "./ports/benchmark-controller.ts";
import type { MetricStore } from "./ports/metric-store.ts";
import type { RouteOverride, RouterController, RouterStatus, TelemetryPollResult } from "./ports/router-controller.ts";
import type { PolicyDecision, Route } from "./policy.ts";

export const EXPECTED_OPERATION_NAMES = [
	"metrics.record",
	"metrics.query",
	"metrics.prune",
	"benchmark.refresh",
	"benchmark.status",
	"benchmark.query",
	"models.rank",
	"context.assess",
	"service.checkpoint",
	"telemetry.poll",
	"router.status",
	"router.decide",
	"router.pause",
	"router.resume",
	"router.override",
	"router.clear_override",
	"router.current_route",
	"router.available_routes",
] as const;

export type OperationName = typeof EXPECTED_OPERATION_NAMES[number];
export interface OperationInputs {
	"metrics.record": MetricObservation;
	"metrics.query": MetricQuery;
	"metrics.prune": { before: number };
	"benchmark.refresh": { force?: boolean };
	"benchmark.status": Record<string, never>;
	"benchmark.query": BenchmarkQuery;
	"models.rank": ModelRecommendationInput;
	"context.assess": { since?: number; until?: number };
	"service.checkpoint": Record<string, never>;
	"telemetry.poll": Record<string, never>;
	"router.status": Record<string, never>;
	"router.decide": Record<string, never>;
	"router.pause": Record<string, never>;
	"router.resume": Record<string, never>;
	"router.override": RouteOverride;
	"router.clear_override": Record<string, never>;
	"router.current_route": Route;
	"router.available_routes": { routes: Route[] };
}
export interface OperationOutputs {
	"metrics.record": StoredMetricObservation;
	"metrics.query": StoredMetricObservation[];
	"metrics.prune": { deleted: number };
	"benchmark.refresh": BenchmarkRefreshResult;
	"benchmark.status": BenchmarkRefreshResult;
	"benchmark.query": BenchmarkQueryResult;
	"models.rank": ModelRankingResult;
	"context.assess": ContextAssessment;
	"service.checkpoint": { ok: true };
	"telemetry.poll": TelemetryPollResult;
	"router.status": RouterStatus;
	"router.decide": PolicyDecision;
	"router.pause": RouterStatus;
	"router.resume": RouterStatus;
	"router.override": RouterStatus;
	"router.clear_override": RouterStatus;
	"router.current_route": RouterStatus;
	"router.available_routes": RouterStatus;
}

export class UnknownOperationError extends Error {}

class UnavailableModelRanker implements ModelRanker {
	rank(): ModelRankingResult { throw new Error("model ranking is not configured"); }
}

class UnavailableBenchmarkController implements BenchmarkController {
	async refresh(): Promise<BenchmarkRefreshResult> { return this.status(); }
	status(): BenchmarkRefreshResult { return { observedAt: Date.now(), sources: [] }; }
	query(): BenchmarkQueryResult { throw new Error("benchmark evidence is not configured"); }
}

class UnavailableRouter implements RouterController {
	private readonly unavailable: RouterStatus = { ready: false, paused: false, sources: [], lastDecision: null, override: null, currentRoute: null, availableRoutes: [] };
	async poll(): Promise<TelemetryPollResult> { return { sources: [], observedAt: Date.now() }; }
	status(): RouterStatus { return structuredClone(this.unavailable); }
	decide(): PolicyDecision { return { action: "halt", pressure: Number.POSITIVE_INFINITY, reason: "router is not configured", decidedAt: Date.now(), trace: ["fail closed"] }; }
	pause(): RouterStatus { return this.status(); }
	resume(): RouterStatus { return this.status(); }
	setOverride(): RouterStatus { return this.status(); }
	clearOverride(): RouterStatus { return this.status(); }
	setCurrentRoute(): RouterStatus { return this.status(); }
	setAvailableRoutes(): RouterStatus { return this.status(); }
}

export class JittorService {
	constructor(
		private readonly metrics: MetricStore,
		private readonly router: RouterController = new UnavailableRouter(),
		private readonly benchmarks: BenchmarkController = new UnavailableBenchmarkController(),
		private readonly modelRanker: ModelRanker = new UnavailableModelRanker(),
	) {}

	operationNames(): OperationName[] {
		return [...EXPECTED_OPERATION_NAMES];
	}

	async execute<Name extends OperationName>(operation: Name, input: OperationInputs[Name]): Promise<OperationOutputs[Name]>;
	async execute(operation: string, input: Record<string, unknown>): Promise<unknown>;
	async execute(operation: string, input: Record<string, unknown> = {}): Promise<unknown> {
		switch (operation) {
			case "metrics.record": return this.metrics.record(validateMetricObservation(input));
			case "metrics.query": return this.metrics.query(input as MetricQuery);
			case "metrics.prune": {
				const before = input["before"];
				if (typeof before !== "number") throw new Error("before is required");
				return { deleted: this.metrics.pruneBefore(before) };
			}
			case "benchmark.refresh": return this.benchmarks.refresh(input["force"] === true);
			case "benchmark.status": return this.benchmarks.status();
			case "benchmark.query": return this.benchmarks.query(input as unknown as BenchmarkQuery);
			case "models.rank": {
				const result = this.modelRanker.rank(input as unknown as ModelRecommendationInput);
				if (result.automaticSelection && this.router.applyModelRanking) this.router.applyModelRanking(result.ranked.map((item) => item.candidate));
				return result;
			}
			case "context.assess": {
				const until = input["until"] === undefined ? Date.now() : input["until"];
				const since = input["since"] === undefined && typeof until === "number" ? Math.max(0, until - CONTEXT_ASSESSMENT_DEFAULT_WINDOW_MS) : input["since"];
				if (!Number.isSafeInteger(since) || !Number.isSafeInteger(until) || (since as number) < 0 || (until as number) < (since as number)) throw new Error("context assessment requires non-negative ordered integer bounds");
				const query = { since: since as number, until: until as number, order: "asc" as const, limit: CONTEXT_ASSESSMENT_QUERY_LIMIT };
				const injections = this.metrics.query({ ...query, source: "papyrus-context", metric: "injected-characters" });
				const compactions = this.metrics.query({ ...query, source: "pi-context" });
				return assessContextTelemetry(injections, compactions, {
					since: since as number,
					until: until as number,
					truncated: injections.length >= CONTEXT_ASSESSMENT_QUERY_LIMIT || compactions.length >= CONTEXT_ASSESSMENT_QUERY_LIMIT,
				});
			}
			case "service.checkpoint": this.metrics.checkpoint(); return { ok: true };
			case "telemetry.poll": return this.router.poll();
			case "router.status": return this.router.status();
			case "router.decide": return this.router.decide();
			case "router.pause": return this.router.pause();
			case "router.resume": return this.router.resume();
			case "router.override": return this.router.setOverride(input as unknown as RouteOverride);
			case "router.clear_override": return this.router.clearOverride();
			case "router.current_route": return this.router.setCurrentRoute(input as unknown as Route);
			case "router.available_routes": return this.router.setAvailableRoutes(Array.isArray(input["routes"]) ? input["routes"] as Route[] : []);
			default: throw new UnknownOperationError(`unknown operation: ${operation}`);
		}
	}

	ready(): boolean {
		return this.router.status().ready;
	}

	close(): void {
		this.metrics.close();
	}
}

export interface JittorAppOptions {
	service: JittorService;
	token: string;
	maxBodyBytes?: number;
}

function authorized(request: Request, token: string): boolean {
	return request.headers.get("authorization") === `Bearer ${token}`;
}

function json(value: unknown, status = 200): Response {
	const body = JSON.stringify(value);
	if (new TextEncoder().encode(body).byteLength > SERVICE_MAX_RESPONSE_BYTES) {
		const error = JSON.stringify({ error: "response too large" });
		return new Response(error, {
			status: 413,
			headers: { "content-type": "application/json", "content-length": String(new TextEncoder().encode(error).byteLength) },
		});
	}
	return new Response(body, {
		status,
		headers: { "content-type": "application/json", "content-length": String(new TextEncoder().encode(body).byteLength) },
	});
}

export function createApp(options: JittorAppOptions): { fetch(request: Request): Promise<Response> } {
	const maxBodyBytes = options.maxBodyBytes ?? SERVICE_MAX_BODY_BYTES;
	return {
		async fetch(request: Request): Promise<Response> {
			if (!authorized(request, options.token)) return json({ error: "unauthorized" }, 401);
			const url = new URL(request.url);
			if (request.method === "GET" && url.pathname === "/health") return json({ ok: true, version: VERSION });
			if (request.method === "GET" && url.pathname === "/ready") {
				const ready = options.service.ready();
				return json({ ready }, ready ? 200 : 503);
			}
			if (request.method === "GET" && url.pathname === "/api/v1/ops") return json({ operations: options.service.operationNames() });
			if (request.method !== "POST" || url.pathname !== "/api/v1/ops") return json({ error: "not found" }, 404);
			const contentLength = Number(request.headers.get("content-length") ?? 0);
			if (contentLength > maxBodyBytes) return json({ error: "payload too large" }, 413);
			const text = await request.text();
			if (new TextEncoder().encode(text).byteLength > maxBodyBytes) return json({ error: "payload too large" }, 413);
			try {
				const body = JSON.parse(text) as { op?: unknown; input?: unknown };
				if (typeof body.op !== "string") throw new Error("op is required");
				const input = typeof body.input === "object" && body.input !== null && !Array.isArray(body.input)
					? body.input as Record<string, unknown>
					: {};
				return json({ result: await options.service.execute(body.op, input) });
			} catch (error) {
				if (error instanceof UnknownOperationError) return json({ error: error.message }, 404);
				return json({ error: error instanceof Error ? error.message : String(error) }, 400);
			}
		},
	};
}
