import type { PolicyConfig, Route } from "./policy.ts";

/** Replaced by Pi's active model and authenticated ModelRegistry routes before enforcement. */
export const UNCONFIGURED_ROUTE: Route = { provider: "unconfigured", model: "unconfigured", thinking: "off" };

export const DEFAULT_POLICY: PolicyConfig = {
	maxTelemetryAgeMs: 120_000,
	cooldownMs: 300_000,
	hysteresisFraction: 0.1,
	thresholds: {
		throttle: 1,
		lowerThinking: 1.25,
		switchModel: 1.5,
		switchProvider: 2,
		halt: 3,
	},
	maxThrottleMs: 30_000,
	hardStopUsedFraction: 0.99,
	minimumConfidence: 0.5,
};
