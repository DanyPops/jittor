import type { PolicyConfig, Route } from "./policy.ts";

export const DEFAULT_ROUTES: Route[] = [
	{ provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" },
	{ provider: "openai-codex", model: "gpt-5.6-sol", thinking: "medium" },
	{ provider: "openai-codex", model: "gpt-5.3-codex", thinking: "high" },
	{ provider: "openai-codex", model: "gpt-5.3-codex", thinking: "medium" },
	{ provider: "openai-codex", model: "gpt-5.1-codex-mini", thinking: "medium" },
	{ provider: "openrouter", model: "openai/gpt-4.1-mini", thinking: "medium" },
];

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
