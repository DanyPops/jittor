export type PolicyAction = "continue" | "throttle" | "lower-thinking" | "switch-model" | "switch-provider" | "halt";
export type TelemetryFreshness = "fresh" | "stale" | "failed";

export interface BudgetWindow {
	id: string;
	source: string;
	scope: string;
	usedFraction: number;
	windowSeconds: number;
	resetsAt: number;
	observedAt: number;
	freshness: TelemetryFreshness;
	confidence: number;
	observedBurnPerSecond?: number;
}

export interface Route {
	provider: string;
	model: string;
	thinking: string;
}

export interface PolicyThresholds {
	throttle: number;
	lowerThinking: number;
	switchModel: number;
	switchProvider: number;
	halt: number;
}

export interface PolicyConfig {
	maxTelemetryAgeMs: number;
	cooldownMs: number;
	hysteresisFraction: number;
	thresholds: PolicyThresholds;
	maxThrottleMs: number;
	hardStopUsedFraction: number;
	minimumConfidence?: number;
}

export interface PreviousDecision {
	action: PolicyAction;
	decidedAt: number;
	pressure: number;
	route?: Route;
}

export interface PolicyInput {
	now: number;
	windows: BudgetWindow[];
	currentRoute: Route;
	routes: Route[];
	config: PolicyConfig;
	previousDecision?: PreviousDecision;
}

export interface PolicyDecision {
	action: PolicyAction;
	pressure: number;
	reason: string;
	route?: Route;
	delayMs?: number;
	windowId?: string;
	decidedAt: number;
	trace: string[];
}

const ACTION_SEVERITY: Record<PolicyAction, number> = {
	continue: 0,
	throttle: 1,
	"lower-thinking": 2,
	"switch-model": 3,
	"switch-provider": 4,
	halt: 5,
};

function actionThreshold(action: PolicyAction, thresholds: PolicyThresholds): number {
	switch (action) {
		case "continue": return 0;
		case "throttle": return thresholds.throttle;
		case "lower-thinking": return thresholds.lowerThinking;
		case "switch-model": return thresholds.switchModel;
		case "switch-provider": return thresholds.switchProvider;
		case "halt": return thresholds.halt;
	}
}

function desiredAction(pressure: number, thresholds: PolicyThresholds): PolicyAction {
	if (pressure > thresholds.halt) return "halt";
	if (pressure > thresholds.switchProvider) return "switch-provider";
	if (pressure > thresholds.switchModel) return "switch-model";
	if (pressure > thresholds.lowerThinking) return "lower-thinking";
	if (pressure > thresholds.throttle) return "throttle";
	return "continue";
}

function sameRoute(left: Route, right: Route): boolean {
	return left.provider === right.provider && left.model === right.model && left.thinking === right.thinking;
}

function alternativesAfter(input: PolicyInput): Route[] {
	const currentIndex = input.routes.findIndex((route) => sameRoute(route, input.currentRoute));
	return input.routes.slice(currentIndex >= 0 ? currentIndex + 1 : 0);
}

function routeFor(action: PolicyAction, input: PolicyInput): Route | undefined {
	const alternatives = alternativesAfter(input);
	if (action === "lower-thinking") {
		return alternatives.find((route) => route.provider === input.currentRoute.provider && route.model === input.currentRoute.model);
	}
	if (action === "switch-model") {
		return alternatives.find((route) => route.provider === input.currentRoute.provider && route.model !== input.currentRoute.model);
	}
	if (action === "switch-provider") return alternatives.find((route) => route.provider !== input.currentRoute.provider);
	return undefined;
}

function pressureFor(window: BudgetWindow, now: number): number {
	const remainingSeconds = (window.resetsAt - now) / 1_000;
	if (remainingSeconds <= 0) return Number.POSITIVE_INFINITY;
	const remainingFraction = Math.max(0, 1 - window.usedFraction);
	if (remainingFraction === 0) return Number.POSITIVE_INFINITY;
	const elapsedSeconds = Math.max(0, window.windowSeconds - remainingSeconds);
	const observedBurn = window.observedBurnPerSecond ?? (elapsedSeconds > 0 ? window.usedFraction / elapsedSeconds : 0);
	const sustainableBurn = remainingFraction / remainingSeconds;
	return observedBurn / sustainableBurn;
}

function holdPrevious(input: PolicyInput, pressure: number, trace: string[]): PolicyDecision | undefined {
	const previous = input.previousDecision;
	if (!previous) return undefined;
	const candidate = desiredAction(pressure, input.config.thresholds);
	if (ACTION_SEVERITY[candidate] >= ACTION_SEVERITY[previous.action]) return undefined;
	const elapsed = input.now - previous.decidedAt;
	if (elapsed < input.config.cooldownMs) {
		trace.push(`cooldown holds ${previous.action} for ${input.config.cooldownMs - elapsed}ms`);
		return decisionFromPrevious(previous, pressure, trace, "cooldown prevents recovery");
	}
	const recoveryThreshold = actionThreshold(previous.action, input.config.thresholds) * (1 - input.config.hysteresisFraction);
	if (pressure > recoveryThreshold) {
		trace.push(`hysteresis holds ${previous.action}: ${pressure.toFixed(3)} > ${recoveryThreshold.toFixed(3)}`);
		return decisionFromPrevious(previous, pressure, trace, "hysteresis prevents recovery");
	}
	trace.push(`recovery allowed below ${recoveryThreshold.toFixed(3)} after cooldown`);
	return undefined;
}

function decisionFromPrevious(
	previous: PreviousDecision,
	pressure: number,
	trace: string[],
	reason: string,
): PolicyDecision {
	return {
		action: previous.action,
		pressure,
		reason,
		...(previous.route ? { route: previous.route } : {}),
		decidedAt: previous.decidedAt,
		trace,
	};
}

function failClosed(input: PolicyInput, reason: string, trace: string[], windowId?: string): PolicyDecision {
	trace.push(`fail closed: ${reason}`);
	return { action: "halt", pressure: Number.POSITIVE_INFINITY, reason, windowId, decidedAt: input.now, trace };
}

export function evaluateRoutingPolicy(input: PolicyInput): PolicyDecision {
	const trace: string[] = [];
	if (input.windows.length === 0) return failClosed(input, "required budget telemetry is missing", trace);
	for (const window of input.windows) {
		if (window.freshness !== "fresh") return failClosed(input, `telemetry ${window.id} is ${window.freshness}`, trace, window.id);
		if (input.now - window.observedAt > input.config.maxTelemetryAgeMs) return failClosed(input, `telemetry ${window.id} is stale`, trace, window.id);
		if (window.confidence < (input.config.minimumConfidence ?? 0)) return failClosed(input, `telemetry ${window.id} confidence is too low`, trace, window.id);
		if (window.usedFraction < 0 || window.usedFraction > 1) return failClosed(input, `telemetry ${window.id} has invalid utilization`, trace, window.id);
		if (window.usedFraction >= input.config.hardStopUsedFraction) return failClosed(input, `hard stop reached for ${window.id}`, trace, window.id);
	}

	const pressures = input.windows.map((window) => ({ window, pressure: pressureFor(window, input.now) }));
	for (const { window, pressure } of pressures) trace.push(`${window.id}: pressure=${pressure.toFixed(3)} sustainable=${pressure <= 1}`);
	const binding = pressures.reduce((worst, candidate) => candidate.pressure > worst.pressure ? candidate : worst);
	const held = holdPrevious(input, binding.pressure, trace);
	if (held) return { ...held, windowId: binding.window.id };

	let action = desiredAction(binding.pressure, input.config.thresholds);
	let route = routeFor(action, input);
	if (action === "lower-thinking" && !route) {
		trace.push("lower-thinking route unavailable; escalating");
		action = "switch-model";
		route = routeFor(action, input);
	}
	if (action === "switch-model" && !route) {
		trace.push("switch-model route unavailable; escalating");
		action = "switch-provider";
		route = routeFor(action, input);
	}
	if (action === "switch-provider" && !route) {
		trace.push("switch-provider route unavailable; escalating");
		action = "halt";
	}

	const reason = `${binding.window.id} pressure ${binding.pressure.toFixed(3)} selected ${action}`;
	trace.push(reason);
	const decision: PolicyDecision = {
		action,
		pressure: binding.pressure,
		reason,
		windowId: binding.window.id,
		decidedAt: input.now,
		trace,
	};
	if (route) decision.route = route;
	if (action === "throttle") {
		const span = input.config.thresholds.lowerThinking - input.config.thresholds.throttle;
		const fraction = span > 0 ? (binding.pressure - input.config.thresholds.throttle) / span : 1;
		decision.delayMs = Math.max(0, Math.min(input.config.maxThrottleMs, Math.round(fraction * input.config.maxThrottleMs)));
	}
	return decision;
}
