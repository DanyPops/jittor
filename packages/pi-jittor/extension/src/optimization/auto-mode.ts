/**
 * Pure effort-based Auto mode decision logic -- deliberately separate from the existing
 * budget-pressure `JittorRouter`/`applyDecision` path (optimization/routing), which reacts to
 * provider quota pressure, not task complexity. The two compose at the call site (index.ts's
 * `turn_start` handler): budget/enforcement always takes precedence on conflict, matching the
 * design recorded in Doc "Auto mode: effort-aware model routing -- prior art and design".
 *
 * This module owns only the decision (what should happen this turn, given a fresh ranking
 * result and the anti-nag session state) -- never the side effect itself (showing a dialog,
 * calling `pi.setModel`, persisting a setting). That stays in index.ts, so this logic is fully
 * unit-testable without mocking any Pi/TUI surface.
 */
import type { ModelCandidate, ModelRankingResult, ModelTaskEffort } from "@danypops/jittor";

export const AUTO_MODE_SETTINGS = ["off", "suggest", "auto-switch"] as const;
export type AutoModeSetting = (typeof AUTO_MODE_SETTINGS)[number];

export interface AutoModeSessionState {
	lastEffort: ModelTaskEffort | null;
	dismissedIdentity: string | null;
}

export function newAutoModeSessionState(): AutoModeSessionState {
	return { lastEffort: null, dismissedIdentity: null };
}

export function candidateIdentityOf(candidate: ModelCandidate): string {
	return `${candidate.provider}/${candidate.model}:${candidate.thinking}`;
}

export interface AutoModeDecisionInput {
	mode: AutoModeSetting;
	/** The effort level this turn was classified/declared as -- only used to decide whether to re-evaluate a previously dismissed suggestion, never re-derived here. */
	effort: ModelTaskEffort;
	/** A ranking result already computed with this turn's effort and current model as its own uplift-gate baseline (see rankModelCandidates). */
	ranking: ModelRankingResult;
	state: AutoModeSessionState;
}

export type AutoModeDecision =
	| { kind: "none" }
	| { kind: "suggest"; candidate: ModelCandidate; utilityDelta: number; confidence: number }
	| { kind: "switch"; candidate: ModelCandidate };

/**
 * Anti-nag bound: a Suggest-mode dismissal for one specific candidate identity is remembered and
 * not re-offered again until either the detected/declared effort changes, or the recommended
 * candidate itself changes (a stronger, different upgrade is always worth surfacing). The uplift
 * gate inside `rankModelCandidates` itself is the primary anti-spam mechanism -- this only
 * prevents re-nagging about the exact same already-declined suggestion every single turn.
 */
export function decideAutoMode(input: AutoModeDecisionInput): AutoModeDecision {
	const { mode, effort, ranking, state } = input;
	const effortChanged = state.lastEffort !== effort;
	state.lastEffort = effort;
	if (mode === "off") return { kind: "none" };
	const recommendation = ranking.recommendation;
	if (!recommendation) {
		state.dismissedIdentity = null;
		return { kind: "none" };
	}
	const identity = candidateIdentityOf(recommendation.candidate);
	if (!effortChanged && state.dismissedIdentity === identity) return { kind: "none" };
	if (mode === "auto-switch") return { kind: "switch", candidate: recommendation.candidate };
	return {
		kind: "suggest",
		candidate: recommendation.candidate,
		utilityDelta: recommendation.utilityDelta,
		confidence: recommendation.confidence,
	};
}

export function recordAutoModeDismissal(state: AutoModeSessionState, candidate: ModelCandidate): void {
	state.dismissedIdentity = candidateIdentityOf(candidate);
}
