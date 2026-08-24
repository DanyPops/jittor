import { describe, expect, it } from "bun:test";
import type { ModelRankingResult } from "@danypops/jittor";
import { decideAutoMode, newAutoModeSessionState, recordAutoModeDismissal } from "../extension/src/optimization/auto-mode.ts";

const candidateA = { provider: "openai", model: "gpt-fast", thinking: "high" };
const candidateB = { provider: "anthropic", model: "claude-strong", thinking: "high" };

function ranking(recommendation: ModelRankingResult["recommendation"]): ModelRankingResult {
	return {
		scopeAuthority: "exact-session",
		scopeWarning: null,
		domain: "coding",
		type: "general",
		completeness: "complete",
		ranked: [],
		recommendation,
		automaticSelection: recommendation?.candidate ?? null,
	};
}

describe("decideAutoMode", () => {
	it("does nothing when Auto mode is off, regardless of a real recommendation", () => {
		const decision = decideAutoMode({
			mode: "off",
			effort: "high",
			ranking: ranking({ candidate: candidateB, utilityDelta: 0.3, confidence: 0.9 }),
			state: newAutoModeSessionState(),
		});
		expect(decision).toEqual({ kind: "none" });
	});

	it("does nothing when there is no recommendation to act on", () => {
		const decision = decideAutoMode({ mode: "suggest", effort: "medium", ranking: ranking(null), state: newAutoModeSessionState() });
		expect(decision).toEqual({ kind: "none" });
	});

	it("suggests in Suggest mode, carrying the recommendation's own evidence", () => {
		const decision = decideAutoMode({
			mode: "suggest",
			effort: "high",
			ranking: ranking({ candidate: candidateB, utilityDelta: 0.3, confidence: 0.9 }),
			state: newAutoModeSessionState(),
		});
		expect(decision).toEqual({ kind: "suggest", candidate: candidateB, utilityDelta: 0.3, confidence: 0.9 });
	});

	it("switches directly in Auto-switch mode, with no suggestion step", () => {
		const decision = decideAutoMode({
			mode: "auto-switch",
			effort: "high",
			ranking: ranking({ candidate: candidateB, utilityDelta: 0.3, confidence: 0.9 }),
			state: newAutoModeSessionState(),
		});
		expect(decision).toEqual({ kind: "switch", candidate: candidateB });
	});

	it("does not re-suggest an already-dismissed candidate while effort stays unchanged", () => {
		const state = newAutoModeSessionState();
		state.lastEffort = "high";
		recordAutoModeDismissal(state, candidateB);
		const decision = decideAutoMode({
			mode: "suggest",
			effort: "high",
			ranking: ranking({ candidate: candidateB, utilityDelta: 0.3, confidence: 0.9 }),
			state,
		});
		expect(decision).toEqual({ kind: "none" });
	});

	it("re-offers a dismissed candidate once the detected effort changes", () => {
		const state = newAutoModeSessionState();
		state.lastEffort = "high";
		recordAutoModeDismissal(state, candidateB);
		const decision = decideAutoMode({
			mode: "suggest",
			effort: "low",
			ranking: ranking({ candidate: candidateB, utilityDelta: 0.3, confidence: 0.9 }),
			state,
		});
		expect(decision).toEqual({ kind: "suggest", candidate: candidateB, utilityDelta: 0.3, confidence: 0.9 });
	});

	it("still offers a different, newly-recommended candidate even if another one was previously dismissed", () => {
		const state = newAutoModeSessionState();
		state.lastEffort = "high";
		recordAutoModeDismissal(state, candidateA);
		const decision = decideAutoMode({
			mode: "suggest",
			effort: "high",
			ranking: ranking({ candidate: candidateB, utilityDelta: 0.3, confidence: 0.9 }),
			state,
		});
		expect(decision).toEqual({ kind: "suggest", candidate: candidateB, utilityDelta: 0.3, confidence: 0.9 });
	});

	it("clears a stale dismissal once there is no longer any recommendation to dismiss", () => {
		const state = newAutoModeSessionState();
		recordAutoModeDismissal(state, candidateB);
		decideAutoMode({ mode: "suggest", effort: "high", ranking: ranking(null), state });
		expect(state.dismissedIdentity).toBeNull();
	});

	it("tracks the last-seen effort across calls regardless of mode", () => {
		const state = newAutoModeSessionState();
		decideAutoMode({ mode: "off", effort: "low", ranking: ranking(null), state });
		expect(state.lastEffort).toBe("low");
	});
});
