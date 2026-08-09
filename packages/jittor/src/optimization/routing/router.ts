import { ROUTER_MAX_SESSION_SCOPES, ROUTER_SESSION_ID_MAX_CHARACTERS } from "../../constants.ts";
import type { MetricStore } from "../../observability/store.ts";
import type { TelemetrySource } from "../../observability/telemetry-source.ts";
import type { RouteOverride, RouterController, RouterStatus, TelemetryPollResult, TelemetrySourceStatus } from "./controller.ts";
import { type BudgetWindow, evaluateRoutingPolicy, type PolicyConfig, type PolicyDecision, type Route } from "./policy.ts";

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

const GLOBAL_ROUTER_SCOPE = "global";

interface RouterSessionState {
	currentRoute: Route;
	availableRoutes: Route[];
	lastDecision: PolicyDecision | null;
	previousPolicyDecision: PolicyDecision | null;
	paused: boolean;
	override: RouteOverride | null;
	lastAccess: number;
}

function routerScope(sessionId: string | undefined): string {
	if (sessionId === undefined) return GLOBAL_ROUTER_SCOPE;
	if (sessionId.length === 0 || sessionId.length > ROUTER_SESSION_ID_MAX_CHARACTERS) {
		throw new Error(`session_id must contain 1-${ROUTER_SESSION_ID_MAX_CHARACTERS} characters`);
	}
	return sessionId;
}

export class JittorRouter implements RouterController {
	private readonly clock: () => number;
	private readonly windows = new Map<string, BudgetWindow[]>();
	private readonly sessions = new Map<string, RouterSessionState>();
	private sourceStatuses: TelemetrySourceStatus[] = [];
	private inFlightPoll: Promise<TelemetryPollResult> | null = null;
	private accessSequence = 0;

	constructor(private readonly options: JittorRouterOptions) {
		this.clock = options.clock ?? Date.now;
		this.sessions.set(GLOBAL_ROUTER_SCOPE, this.newSessionState());
	}

	poll(): Promise<TelemetryPollResult> {
		this.inFlightPoll ??= this.runPoll().finally(() => {
			this.inFlightPoll = null;
		});
		return this.inFlightPoll;
	}

	status(sessionId?: string): RouterStatus {
		const state = this.sessionState(sessionId);
		this.expireOverride(state);
		return {
			ready: this.isReady(state),
			paused: state.paused,
			sources: structuredClone(this.sourceStatuses),
			lastDecision: state.lastDecision ? structuredClone(state.lastDecision) : null,
			override: state.override ? structuredClone(state.override) : null,
			currentRoute: structuredClone(state.currentRoute),
			availableRoutes: structuredClone(state.availableRoutes),
		};
	}

	decide(sessionId?: string): PolicyDecision {
		const now = this.clock();
		const state = this.sessionState(sessionId);
		this.expireOverride(state);
		if (state.paused)
			return this.remember(state, {
				action: "halt",
				pressure: Number.POSITIVE_INFINITY,
				reason: "Jittor is paused",
				decidedAt: now,
				trace: ["manual pause"],
			});
		if (state.override) {
			const route = state.override.route;
			const action =
				route.provider !== state.currentRoute.provider
					? "switch-provider"
					: route.model !== state.currentRoute.model
						? "switch-model"
						: route.thinking !== state.currentRoute.thinking
							? "lower-thinking"
							: "continue";
			return this.remember(state, {
				action,
				route,
				pressure: 0,
				reason: "manual route override",
				decidedAt: now,
				trace: ["manual override"],
			});
		}
		if (!this.isReady(state))
			return this.remember(state, {
				action: "halt",
				pressure: Number.POSITIVE_INFINITY,
				reason: "required telemetry is not ready",
				decidedAt: now,
				trace: ["fail closed"],
			});
		const activeSources = this.options.sources.filter((source) => source.provider === state.currentRoute.provider);
		const activeSourceIds = new Set(activeSources.map((source) => source.id));
		const requiredSourceIds = new Set(activeSources.filter((source) => source.required).map((source) => source.id));
		const activeWindows = [...this.windows.entries()].filter(([sourceId]) => activeSourceIds.has(sourceId));
		const requiredWindows = activeWindows.filter(([sourceId]) => requiredSourceIds.has(sourceId)).flatMap(([, windows]) => windows);
		if (requiredSourceIds.size === 0 && activeWindows.every(([, windows]) => windows.length === 0)) {
			return this.rememberPolicy(state, {
				action: "continue",
				pressure: 0,
				reason: "provider has no enforceable budget window; monitor-only",
				decidedAt: now,
				trace: ["monitor-only"],
			});
		}
		return this.rememberPolicy(
			state,
			evaluateRoutingPolicy({
				now,
				windows: requiredSourceIds.size > 0 && requiredWindows.length === 0 ? [] : activeWindows.flatMap(([, windows]) => windows),
				currentRoute: state.currentRoute,
				routes: state.availableRoutes,
				config: this.options.policy,
				previousDecision: state.previousPolicyDecision ?? undefined,
			}),
		);
	}

	pause(sessionId?: string): RouterStatus {
		this.sessionState(sessionId).paused = true;
		return this.status(sessionId);
	}

	resume(sessionId?: string): RouterStatus {
		this.sessionState(sessionId).paused = false;
		return this.status(sessionId);
	}

	setOverride(override: RouteOverride | undefined, sessionId?: string): RouterStatus {
		const state = this.sessionState(sessionId);
		if (!override || !state.availableRoutes.some((route) => sameRoute(route, override.route)))
			throw new Error("override route is not available in Pi");
		if (override.expiresAt !== null && override.expiresAt <= this.clock()) throw new Error("override expiry must be in the future");
		state.override = structuredClone(override);
		return this.status(sessionId);
	}

	clearOverride(sessionId?: string): RouterStatus {
		this.sessionState(sessionId).override = null;
		return this.status(sessionId);
	}

	setCurrentRoute(route: Route, sessionId?: string): RouterStatus {
		if (!route.provider || !route.model || !route.thinking) throw new Error("current route is incomplete");
		this.sessionState(sessionId).currentRoute = structuredClone(route);
		return this.status(sessionId);
	}

	setAvailableRoutes(routes: Route[], sessionId?: string): RouterStatus {
		if (!Array.isArray(routes)) throw new Error("available routes must be an array");
		const valid = routes.filter(
			(route) =>
				typeof route?.provider === "string" &&
				route.provider.length > 0 &&
				typeof route.model === "string" &&
				route.model.length > 0 &&
				typeof route.thinking === "string" &&
				route.thinking.length > 0,
		);
		this.sessionState(sessionId).availableRoutes = valid
			.filter((route, index) => valid.findIndex((candidate) => sameRoute(candidate, route)) === index)
			.map((route) => structuredClone(route));
		return this.status(sessionId);
	}

	applyModelRanking(candidates: Route[], sessionId?: string): RouterStatus {
		if (!Array.isArray(candidates) || candidates.length === 0) throw new Error("model ranking must contain candidates");
		const state = this.sessionState(sessionId);
		const ranked = candidates
			.filter((candidate, index) => candidates.findIndex((other) => sameRoute(other, candidate)) === index)
			.map((candidate) => state.availableRoutes.find((route) => sameRoute(route, candidate)))
			.filter((route): route is Route => route !== undefined);
		const current = ranked.find((route) => sameRoute(route, state.currentRoute));
		if (!current) throw new Error("model ranking does not contain the current available route");
		state.availableRoutes = [
			structuredClone(current),
			...ranked.filter((route) => !sameRoute(route, current)).map((route) => structuredClone(route)),
		];
		return this.status(sessionId);
	}

	private async runPoll(): Promise<TelemetryPollResult> {
		const statuses = await Promise.all(
			this.options.sources.map(async (source): Promise<TelemetrySourceStatus> => {
				try {
					const batch = await source.poll();
					for (const observation of batch.metrics) this.options.metrics.record(observation);
					this.windows.set(source.id, batch.windows);
					return { id: source.id, provider: source.provider, ok: true, metrics: batch.metrics.length, observedAt: batch.observedAt };
				} catch {
					this.windows.delete(source.id);
					return { id: source.id, provider: source.provider, ok: false, metrics: 0, observedAt: this.clock(), error: "poll failed" };
				}
			}),
		);
		this.sourceStatuses = statuses;
		return { sources: structuredClone(statuses), observedAt: this.clock() };
	}

	private newSessionState(): RouterSessionState {
		return {
			currentRoute: structuredClone(this.options.currentRoute),
			availableRoutes: structuredClone(this.options.routes),
			lastDecision: null,
			previousPolicyDecision: null,
			paused: false,
			override: null,
			lastAccess: ++this.accessSequence,
		};
	}

	private sessionState(sessionId?: string): RouterSessionState {
		const scope = routerScope(sessionId);
		const existing = this.sessions.get(scope);
		if (existing) {
			existing.lastAccess = ++this.accessSequence;
			return existing;
		}
		if (this.sessions.size >= ROUTER_MAX_SESSION_SCOPES) {
			const oldest = [...this.sessions.entries()]
				.filter(([key]) => key !== GLOBAL_ROUTER_SCOPE)
				.sort((left, right) => left[1].lastAccess - right[1].lastAccess)[0];
			if (oldest) this.sessions.delete(oldest[0]);
		}
		const created = this.newSessionState();
		this.sessions.set(scope, created);
		return created;
	}

	private isReady(state: RouterSessionState): boolean {
		if (state.availableRoutes.length === 0) return false;
		const required = this.options.sources.filter((source) => source.provider === state.currentRoute.provider && source.required);
		return required.every((source) => this.sourceStatuses.some((status) => status.id === source.id && status.ok));
	}

	private expireOverride(state: RouterSessionState): void {
		if (state.override?.expiresAt !== null && state.override && state.override.expiresAt <= this.clock()) state.override = null;
	}

	private remember(state: RouterSessionState, decision: PolicyDecision): PolicyDecision {
		state.lastDecision = decision;
		return structuredClone(decision);
	}

	private rememberPolicy(state: RouterSessionState, decision: PolicyDecision): PolicyDecision {
		state.previousPolicyDecision = decision;
		return this.remember(state, decision);
	}
}
