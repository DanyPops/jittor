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
	status(): RouterStatus;
	decide(): PolicyDecision;
	pause(): RouterStatus;
	resume(): RouterStatus;
	setOverride(override?: RouteOverride): RouterStatus;
	clearOverride(): RouterStatus;
	setCurrentRoute(route: Route): RouterStatus;
	setAvailableRoutes(routes: Route[]): RouterStatus;
}
