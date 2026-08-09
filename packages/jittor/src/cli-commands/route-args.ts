import type { ModelCandidate } from "../optimization/model-selection/ranking.ts";
import type { Route } from "../optimization/routing/policy.ts";

/** Shared `provider/model@thinking` parsing for router and benchmark CLI arguments -- a Route and a ModelCandidate are structurally identical at this boundary. */
export function parseCandidate(raw: string): ModelCandidate | null {
	const separator = raw.indexOf("/");
	const thinkingSeparator = raw.lastIndexOf("@");
	if (separator <= 0 || thinkingSeparator <= separator + 1 || thinkingSeparator === raw.length - 1) return null;
	return {
		provider: raw.slice(0, separator),
		model: raw.slice(separator + 1, thinkingSeparator),
		thinking: raw.slice(thinkingSeparator + 1),
	};
}

export function parseRoute(raw: string | undefined): Route | null {
	if (raw === undefined) return null;
	return parseCandidate(raw);
}
