import { VehicleRegistry } from "@danypops/vehicle-server";
import { createVehicleHttpApp } from "@danypops/vehicle-server/http";
import { errorResponse, healthResponse, readyResponse, requireBearerToken } from "@danypops/vehicle-server/rpc-http";
import { SERVICE_MAX_BODY_BYTES, SERVICE_MAX_RESPONSE_BYTES } from "./constants.ts";
import type { BenchmarkQuery, BenchmarkQueryResult, BenchmarkRefreshResult } from "./domain/benchmark.ts";
import type { CompactionDurationEstimate, ContextAssessment } from "./domain/context-telemetry.ts";
import type { MetricObservation, MetricQuery, StoredMetricObservation } from "./domain/metric.ts";
import type { ModelRankingResult } from "./domain/model-ranking.ts";
import type { ModelRanker, ModelRecommendationInput } from "./domain/model-ranking-service.ts";
import type { TaskCostSummary } from "./domain/task-cost.ts";
import type { UsageAggregateRow } from "./domain/usage.ts";
import { benchmarkOperations } from "./operations/benchmark-operations.ts";
import { contextOperations } from "./operations/context-operations.ts";
import { metricsOperations } from "./operations/metrics-operations.ts";
import { modelRankingOperations } from "./operations/model-ranking-operations.ts";
import { routerOperations } from "./operations/router-operations.ts";
import { sessionIdentityOperations } from "./operations/session-identity-operations.ts";
import { routerMutationAuthorizer } from "./operations/session-scope.ts";
import type { OperationHandlerMap } from "./operations/types.ts";
import type { PolicyDecision, Route } from "./policy.ts";
import type { BenchmarkController } from "./ports/benchmark-controller.ts";
import type { MetricStore } from "./ports/metric-store.ts";
import type { RouteOverride, RouterController, RouterStatus, TelemetryPollResult } from "./ports/router-controller.ts";
import { InvalidSessionSecretError, type RegisterSessionIdentityResult, type SessionIdentity } from "./session-identity-service.ts";
import { registerJittorVehicleOperations } from "./vehicle-registration.ts";
import { VERSION } from "./version.ts";

export const EXPECTED_OPERATION_NAMES = [
	"metrics.record",
	"metrics.record_batch",
	"metrics.query",
	"metrics.distinct_scopes",
	"metrics.usage_series",
	"metrics.cost_by_task",
	"metrics.prune",
	"benchmark.refresh",
	"benchmark.status",
	"benchmark.query",
	"session.register",
	"session.release",
	"models.rank",
	"context.assess",
	"compaction.estimate",
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

export type OperationName = (typeof EXPECTED_OPERATION_NAMES)[number];
interface RouterScopeInput {
	session_id?: string;
	session_secret?: string;
}
export interface OperationInputs {
	"session.register": { session_id: string };
	"session.release": { session_id: string; session_secret?: string };
	"metrics.record": MetricObservation;
	"metrics.record_batch": { observations: MetricObservation[] };
	"metrics.query": MetricQuery;
	"metrics.distinct_scopes": { source: string; since: number; until: number; limit?: number };
	"metrics.usage_series": { source: string; since: number; until: number; bucketSizeMs: number; bucketCount: number; scopeLimit?: number };
	"metrics.cost_by_task": { since: number; until: number };
	"metrics.prune": { before: number; force?: boolean };
	"benchmark.refresh": { force?: boolean };
	"benchmark.status": Record<string, never>;
	"benchmark.query": BenchmarkQuery;
	"models.rank": ModelRecommendationInput & RouterScopeInput;
	"context.assess": { since?: number; until?: number };
	"compaction.estimate": Record<string, never>;
	"service.checkpoint": Record<string, never>;
	"telemetry.poll": Record<string, never>;
	"router.status": RouterScopeInput;
	"router.decide": RouterScopeInput;
	"router.pause": RouterScopeInput;
	"router.resume": RouterScopeInput;
	"router.override": RouteOverride & RouterScopeInput;
	"router.clear_override": RouterScopeInput;
	"router.current_route": Route & RouterScopeInput;
	"router.available_routes": { routes: Route[] } & RouterScopeInput;
}
export interface OperationOutputs {
	"session.register": RegisterSessionIdentityResult;
	"session.release": { released: boolean };
	"metrics.record": StoredMetricObservation;
	"metrics.record_batch": StoredMetricObservation[];
	"metrics.query": StoredMetricObservation[];
	"metrics.distinct_scopes": string[];
	"metrics.usage_series": { rows: UsageAggregateRow[]; truncated: boolean };
	"metrics.cost_by_task": TaskCostSummary;
	"metrics.prune": { deleted: number };
	"benchmark.refresh": BenchmarkRefreshResult;
	"benchmark.status": BenchmarkRefreshResult;
	"benchmark.query": BenchmarkQueryResult;
	"models.rank": ModelRankingResult;
	"context.assess": ContextAssessment;
	"compaction.estimate": CompactionDurationEstimate;
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
export { InvalidSessionSecretError };

class UnavailableModelRanker implements ModelRanker {
	rank(): ModelRankingResult {
		throw new Error("model ranking is not configured");
	}
}

class UnavailableBenchmarkController implements BenchmarkController {
	async refresh(): Promise<BenchmarkRefreshResult> {
		return this.status();
	}
	status(): BenchmarkRefreshResult {
		return { observedAt: Date.now(), sources: [] };
	}
	query(): BenchmarkQueryResult {
		throw new Error("benchmark evidence is not configured");
	}
}

class UnavailableRouter implements RouterController {
	private readonly unavailable: RouterStatus = {
		ready: false,
		paused: false,
		sources: [],
		lastDecision: null,
		override: null,
		currentRoute: null,
		availableRoutes: [],
	};
	async poll(): Promise<TelemetryPollResult> {
		return { sources: [], observedAt: Date.now() };
	}
	status(): RouterStatus {
		return structuredClone(this.unavailable);
	}
	decide(): PolicyDecision {
		return {
			action: "halt",
			pressure: Number.POSITIVE_INFINITY,
			reason: "router is not configured",
			decidedAt: Date.now(),
			trace: ["fail closed"],
		};
	}
	pause(): RouterStatus {
		return this.status();
	}
	resume(): RouterStatus {
		return this.status();
	}
	setOverride(): RouterStatus {
		return this.status();
	}
	clearOverride(): RouterStatus {
		return this.status();
	}
	setCurrentRoute(): RouterStatus {
		return this.status();
	}
	setAvailableRoutes(): RouterStatus {
		return this.status();
	}
}

export class JittorService {
	private readonly router: RouterController;
	private readonly operations: OperationHandlerMap;
	/** Every jittor operation, also projected onto the real Vehicle protocol -- see vehicle-registration.ts. Served alongside (not replacing) the /api/v1/ops route below. */
	readonly vehicleRegistry: VehicleRegistry;

	constructor(
		private readonly metrics: MetricStore,
		router: RouterController = new UnavailableRouter(),
		benchmarks: BenchmarkController = new UnavailableBenchmarkController(),
		modelRanker: ModelRanker = new UnavailableModelRanker(),
		sessionIdentity?: SessionIdentity,
	) {
		this.router = router;
		const authorize = routerMutationAuthorizer(sessionIdentity);
		// Each capability module owns a disjoint, bounded slice of EXPECTED_OPERATION_NAMES and only
		// the collaborators it needs -- adding a new operation domain means adding a new module here,
		// not another switch case in a single responsibility magnet.
		this.operations = {
			...metricsOperations(metrics),
			...benchmarkOperations(benchmarks),
			...contextOperations(metrics),
			...routerOperations(router, authorize),
			...modelRankingOperations(modelRanker, router, authorize),
			...sessionIdentityOperations(sessionIdentity),
		};
		this.vehicleRegistry = new VehicleRegistry({
			name: "jittor",
			version: "1.0.0",
			description: "Just-in-Time Token Optimizing Router for Pi -- metrics, benchmark evidence, model ranking, and router policy.",
		});
		registerJittorVehicleOperations(this.vehicleRegistry, this.operations);
	}

	operationNames(): OperationName[] {
		return [...EXPECTED_OPERATION_NAMES];
	}

	async execute<Name extends OperationName>(operation: Name, input: OperationInputs[Name]): Promise<OperationOutputs[Name]>;
	async execute(operation: string, input: Record<string, unknown>): Promise<unknown>;
	async execute(operation: string, input: Record<string, unknown> = {}): Promise<unknown> {
		const handler = this.operations[operation];
		if (!handler) throw new UnknownOperationError(`unknown operation: ${operation}`);
		return handler(input);
	}

	ready(): boolean {
		return this.router.status(undefined).ready;
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

/**
 * Bearer-check and the trivial health/ready/not-found responses now delegate to
 * `@danypops/vehicle-server/rpc-http` (the same handful of lines every daemon's service.ts hand-rolled).
 * The response-size guard below stays jittor-specific: daemon-kit's `jsonResponse` is intentionally
 * unbounded (it has no operation dispatch of its own to guard), while jittor's `/api/v1/ops` can
 * return arbitrarily large query results that must be capped (see SERVICE_MAX_RESPONSE_BYTES).
 */
function json(value: unknown, status = 200): Response {
	const body = JSON.stringify(value);
	if (new TextEncoder().encode(body).byteLength > SERVICE_MAX_RESPONSE_BYTES) return errorResponse("response too large", 413);
	return new Response(body, {
		status,
		headers: { "content-type": "application/json", "content-length": String(new TextEncoder().encode(body).byteLength) },
	});
}

export function createApp(options: JittorAppOptions): { fetch(request: Request): Promise<Response> } {
	const maxBodyBytes = options.maxBodyBytes ?? SERVICE_MAX_BODY_BYTES;
	// A real second transport for every jittor operation (see vehicle-registration.ts) --
	// composed here rather than replacing /api/v1/ops, matching every other Vehicle-migrated
	// daemon in this ecosystem ("served alongside", not "instead of"). Routed before the
	// top-level bearer check below since createVehicleHttpApp performs its own.
	const vehicleApp = createVehicleHttpApp({ registry: options.service.vehicleRegistry, token: options.token });
	return {
		async fetch(request: Request): Promise<Response> {
			const url = new URL(request.url);
			if (url.pathname.startsWith("/vehicle/")) return vehicleApp.fetch(request);
			if (!requireBearerToken(request, options.token)) return errorResponse("unauthorized", 401);
			if (request.method === "GET" && url.pathname === "/health") return healthResponse(VERSION);
			if (request.method === "GET" && url.pathname === "/ready") return readyResponse(options.service.ready());
			if (request.method === "GET" && url.pathname === "/api/v1/ops") return json({ operations: options.service.operationNames() });
			if (request.method !== "POST" || url.pathname !== "/api/v1/ops") return errorResponse("not found", 404);
			const contentLength = Number(request.headers.get("content-length") ?? 0);
			if (contentLength > maxBodyBytes) return errorResponse("payload too large", 413);
			const text = await request.text();
			if (new TextEncoder().encode(text).byteLength > maxBodyBytes) return errorResponse("payload too large", 413);
			try {
				const body = JSON.parse(text) as { op?: unknown; input?: unknown };
				if (typeof body.op !== "string") throw new Error("op is required");
				const input =
					typeof body.input === "object" && body.input !== null && !Array.isArray(body.input)
						? (body.input as Record<string, unknown>)
						: {};
				return json({ result: await options.service.execute(body.op, input) });
			} catch (error) {
				if (error instanceof UnknownOperationError) return json({ error: error.message }, 404);
				if (error instanceof InvalidSessionSecretError) return json({ error: error.message }, 403);
				return json({ error: error instanceof Error ? error.message : String(error) }, 400);
			}
		},
	};
}
