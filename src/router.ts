import type { MetricStore } from "./ports/metric-store.ts";
import type { RouteOverride, RouterController, RouterStatus, TelemetryPollResult, TelemetrySourceStatus } from "./ports/router-controller.ts";
import type { TelemetrySource } from "./ports/telemetry-source.ts";
import {
	evaluateRoutingPolicy,
	type BudgetWindow,
	type PolicyConfig,
	type PolicyDecision,
	type Route,
} from "./policy.ts";

export interface JittorRouterOptions {
	metrics: MetricStore;
	sources: TelemetrySource[];
	policy: PolicyConfig;
	routes: Route[];
	currentRoute: Route;
	clock?: () => number;
}

function sameRoute(left: Route, right: Route): boolean {
	return left.provider === right.provider && left.model === right.model && left.thinking === right.thinking;
}

export class JittorRouter implements RouterController {
	private readonly clock: () => number;
	private readonly windows = new Map<string, BudgetWindow[]>();
	private sourceStatuses: TelemetrySourceStatus[] = [];
	private lastDecision: PolicyDecision | null = null;
	private previousPolicyDecision: PolicyDecision | null = null;
	private paused = false;
	private override: RouteOverride | null = null;
	private inFlightPoll: Promise<TelemetryPollResult> | null = null;
	private currentRoute: Route;
	private availableRoutes: Route[];

	constructor(private readonly options: JittorRouterOptions) {
		this.clock = options.clock ?? Date.now;
		this.currentRoute = options.currentRoute;
		this.availableRoutes = structuredClone(options.routes);
	}

	poll(): Promise<TelemetryPollResult> {
		this.inFlightPoll ??= this.runPoll().finally(() => { this.inFlightPoll = null; });
		return this.inFlightPoll;
	}

	status(): RouterStatus {
		this.expireOverride();
		return {
			ready: this.isReady(),
			paused: this.paused,
			sources: structuredClone(this.sourceStatuses),
			lastDecision: this.lastDecision ? structuredClone(this.lastDecision) : null,
			override: this.override ? structuredClone(this.override) : null,
			currentRoute: structuredClone(this.currentRoute),
			availableRoutes: structuredClone(this.availableRoutes),
		};
	}

	decide(): PolicyDecision {
		const now = this.clock();
		this.expireOverride();
		if (this.paused) return this.remember({ action: "halt", pressure: Number.POSITIVE_INFINITY, reason: "Jittor is paused", decidedAt: now, trace: ["manual pause"] });
		if (this.override) {
			const route = this.override.route;
			const action = route.provider !== this.currentRoute.provider
				? "switch-provider"
				: route.model !== this.currentRoute.model
					? "switch-model"
					: route.thinking !== this.currentRoute.thinking ? "lower-thinking" : "continue";
			return this.remember({ action, route, pressure: 0, reason: "manual route override", decidedAt: now, trace: ["manual override"] });
		}
		if (!this.isReady()) return this.remember({ action: "halt", pressure: Number.POSITIVE_INFINITY, reason: "required telemetry is not ready", decidedAt: now, trace: ["fail closed"] });
		const activeSourceIds = new Set(this.options.sources.filter((source) => source.provider === this.currentRoute.provider).map((source) => source.id));
		return this.rememberPolicy(evaluateRoutingPolicy({
			now,
			windows: [...this.windows.entries()].filter(([sourceId]) => activeSourceIds.has(sourceId)).flatMap(([, windows]) => windows),
			currentRoute: this.currentRoute,
			routes: this.availableRoutes,
			config: this.options.policy,
			previousDecision: this.previousPolicyDecision ?? undefined,
		}));
	}

	pause(): RouterStatus {
		this.paused = true;
		return this.status();
	}

	resume(): RouterStatus {
		this.paused = false;
		return this.status();
	}

	setOverride(override?: RouteOverride): RouterStatus {
		if (!override || !this.availableRoutes.some((route) => sameRoute(route, override.route))) throw new Error("override route is not available in Pi");
		if (override.expiresAt !== null && override.expiresAt <= this.clock()) throw new Error("override expiry must be in the future");
		this.override = structuredClone(override);
		return this.status();
	}

	clearOverride(): RouterStatus {
		this.override = null;
		return this.status();
	}

	setCurrentRoute(route: Route): RouterStatus {
		if (!route.provider || !route.model || !route.thinking) throw new Error("current route is incomplete");
		this.currentRoute = structuredClone(route);
		return this.status();
	}

	setAvailableRoutes(routes: Route[]): RouterStatus {
		if (!Array.isArray(routes)) throw new Error("available routes must be an array");
		const valid = routes.filter((route) => typeof route?.provider === "string" && route.provider.length > 0
			&& typeof route.model === "string" && route.model.length > 0
			&& typeof route.thinking === "string" && route.thinking.length > 0);
		this.availableRoutes = valid.filter((route, index) => valid.findIndex((candidate) => sameRoute(candidate, route)) === index).map((route) => structuredClone(route));
		return this.status();
	}

	private async runPoll(): Promise<TelemetryPollResult> {
		const statuses = await Promise.all(this.options.sources.map(async (source): Promise<TelemetrySourceStatus> => {
			try {
				const batch = await source.poll();
				for (const observation of batch.metrics) this.options.metrics.record(observation);
				this.windows.set(source.id, batch.windows);
				return { id: source.id, provider: source.provider, ok: true, metrics: batch.metrics.length, observedAt: batch.observedAt };
			} catch {
				this.windows.delete(source.id);
				return { id: source.id, provider: source.provider, ok: false, metrics: 0, observedAt: this.clock(), error: "poll failed" };
			}
		}));
		this.sourceStatuses = statuses;
		return { sources: structuredClone(statuses), observedAt: this.clock() };
	}

	private isReady(): boolean {
		const active = this.options.sources.filter((source) => source.provider === this.currentRoute.provider);
		if (active.length === 0) return false;
		return active.every((source) => this.sourceStatuses.some((status) => status.id === source.id && status.ok));
	}

	private expireOverride(): void {
		if (this.override?.expiresAt !== null && this.override && this.override.expiresAt <= this.clock()) this.override = null;
	}

	private remember(decision: PolicyDecision): PolicyDecision {
		this.lastDecision = decision;
		return structuredClone(decision);
	}

	private rememberPolicy(decision: PolicyDecision): PolicyDecision {
		this.previousPolicyDecision = decision;
		return this.remember(decision);
	}
}
