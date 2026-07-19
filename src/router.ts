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

	constructor(private readonly options: JittorRouterOptions) {
		this.clock = options.clock ?? Date.now;
		this.currentRoute = options.currentRoute;
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
		return this.rememberPolicy(evaluateRoutingPolicy({
			now,
			windows: [...this.windows.values()].flat(),
			currentRoute: this.currentRoute,
			routes: this.options.routes,
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
		if (!override || !this.options.routes.some((route) => sameRoute(route, override.route))) throw new Error("override route is not configured");
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

	private async runPoll(): Promise<TelemetryPollResult> {
		const statuses = await Promise.all(this.options.sources.map(async (source): Promise<TelemetrySourceStatus> => {
			try {
				const batch = await source.poll();
				for (const observation of batch.metrics) this.options.metrics.record(observation);
				this.windows.set(source.id, batch.windows);
				return { id: source.id, ok: true, metrics: batch.metrics.length, observedAt: batch.observedAt };
			} catch {
				this.windows.delete(source.id);
				return { id: source.id, ok: false, metrics: 0, observedAt: this.clock(), error: "poll failed" };
			}
		}));
		this.sourceStatuses = statuses;
		return { sources: structuredClone(statuses), observedAt: this.clock() };
	}

	private isReady(): boolean {
		const required = this.options.sources.filter((source) => source.required);
		if (required.length === 0) return false;
		return required.every((source) => this.sourceStatuses.some((status) => status.id === source.id && status.ok));
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
