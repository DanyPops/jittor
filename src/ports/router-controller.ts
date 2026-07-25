import type { PolicyDecision, Route } from "../policy.ts";

export interface TelemetrySourceStatus {
	id: string;
	provider: string;
	ok: boolean;
	metrics: number;
	observedAt?: number;
	error?: string;
}

export interface TelemetryPollResult {
	sources: TelemetrySourceStatus[];
	observedAt: number;
}

export interface RouteOverride {
	route: Route;
	expiresAt: number | null;
}

export interface RouterStatus {
	ready: boolean;
	paused: boolean;
	sources: TelemetrySourceStatus[];
	lastDecision: PolicyDecision | null;
	override: RouteOverride | null;
	currentRoute: Route | null;
	availableRoutes: Route[];
}

export interface RouterController {
	poll(): Promise<TelemetryPollResult>;
	status(sessionId?: string): RouterStatus;
	decide(sessionId?: string): PolicyDecision;
	pause(sessionId?: string): RouterStatus;
	resume(sessionId?: string): RouterStatus;
	setOverride(override: RouteOverride | undefined, sessionId?: string): RouterStatus;
	clearOverride(sessionId?: string): RouterStatus;
	setCurrentRoute(route: Route, sessionId?: string): RouterStatus;
	setAvailableRoutes(routes: Route[], sessionId?: string): RouterStatus;
	applyModelRanking?(candidates: Route[], sessionId?: string): RouterStatus;
}
