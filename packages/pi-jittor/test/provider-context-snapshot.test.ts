import { describe, expect, it } from "bun:test";
import {
	CONTEXT_SNAPSHOT_MAX_SEGMENTS,
	compareContextSnapshots,
	HmacContextFingerprinter,
	StructuralTextTokenCounter,
} from "@danypops/jittor";
import { captureProviderContextSnapshot } from "../extension/src/observability/provider-context-snapshot.ts";

const fingerprinter = new HmacContextFingerprinter(new Uint8Array(32).fill(7));

function capture(payload: unknown, captureId: string, capturedAt: number) {
	return captureProviderContextSnapshot({
		payload,
		captureId,
		sessionId: "real-pi-session-id",
		provider: "openai",
		model: "gpt-5",
		capturedAt,
		fingerprinter,
		counters: [new StructuralTextTokenCounter()],
	});
}

describe("final provider context snapshot capture", () => {
	it("classifies common final-payload structures without retaining content or paths", () => {
		const privatePayload = {
			instructions: "private system /home/person/project",
			tools: [{ name: "read", description: "private tool description" }],
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "private user prompt" },
						{ type: "image", data: "base64-private" },
					],
				},
				{
					role: "assistant",
					content: [
						{ type: "reasoning", text: "private thought" },
						{ type: "function_call", arguments: "private args" },
					],
				},
				{ role: "tool", content: "private tool result" },
			],
		};
		const snapshot = capture(privatePayload, "request-1", 1_000);
		expect(snapshot.segments.map((segment) => segment.source)).toEqual([
			"base-prompt",
			"tool-definitions",
			"conversation-message",
			"conversation-message",
			"thinking",
			"tool-call",
			"tool-result",
		]);
		expect(snapshot.segments.map((segment) => segment.requestPosition)).toEqual([0, 1, 2, 3, 4, 5, 6]);
		expect(snapshot.segments.every((segment) => segment.state === "active")).toBe(true);
		expect(snapshot.segments[3]?.tokens).toBe(0);
		expect(snapshot.segments.filter((_, index) => index !== 3).every((segment) => segment.tokens > 0)).toBe(true);
		const serialized = JSON.stringify(snapshot);
		for (const prohibited of ["private", "/home/person/project", "read", "base64"]) expect(serialized).not.toContain(prohibited);
	});

	it("produces stable logical identities, detects the first changed prefix segment, and changes only content fingerprints", () => {
		const first = capture(
			{ instructions: "stable", tools: [{ name: "read", description: "v1" }], messages: [{ role: "user", content: "hello" }] },
			"request-1",
			1_000,
		);
		const second = capture(
			{ instructions: "stable", tools: [{ name: "read", description: "v2" }], messages: [{ role: "user", content: "hello" }] },
			"request-2",
			2_000,
		);
		expect(second.segments[0]?.id).toBe(first.segments[0]?.id);
		expect(second.segments[0]?.fingerprint).toBe(first.segments[0]?.fingerprint);
		expect(second.segments[1]?.id).toBe(first.segments[1]?.id);
		expect(second.segments[1]?.fingerprint).not.toBe(first.segments[1]?.fingerprint);
		expect(compareContextSnapshots(first, second)).toMatchObject({
			stablePrefixTokens: first.segments[0]?.tokens,
			firstChangedSegment: { source: "tool-definitions", requestPosition: 1 },
		});
	});

	it("keeps repeated equal structures as distinct logical segments with shared content evidence", () => {
		const repeated = { name: "same", description: "same structure" };
		const snapshot = capture({ tools: [repeated, repeated] }, "request-repeated", 1_000);
		expect(snapshot.segments).toHaveLength(2);
		expect(snapshot.segments[0]?.id).not.toBe(snapshot.segments[1]?.id);
		expect(snapshot.segments[0]?.fingerprint).toBe(snapshot.segments[1]?.fingerprint);
	});

	it("captures compacted current-branch and inactive branch history as historical evidence", () => {
		const snapshot = captureProviderContextSnapshot({
			payload: { messages: [{ role: "user", content: "active request" }] },
			captureId: "request-branch",
			sessionId: "real-pi-session-id",
			provider: "openai",
			model: "gpt-5",
			capturedAt: 1_000,
			fingerprinter,
			counters: [new StructuralTextTokenCounter()],
			history: {
				roots: [
					{
						entry: { id: "root", type: "message", message: { role: "user", content: "compacted private root" } },
						children: [
							{ entry: { id: "active", type: "message", message: { role: "user", content: "active request" } }, children: [] },
							{
								entry: { id: "abandoned", type: "message", message: { role: "assistant", content: "inactive private branch" } },
								children: [],
							},
						],
					},
				],
				activeEntryIds: new Set(["active"]),
				branchEntryIds: new Set(["root", "active"]),
			},
		});
		const historical = snapshot.segments.filter((segment) => segment.requestPosition === null);
		expect(historical.map((segment) => segment.state)).toEqual(["compacted", "inactive"]);
		expect(historical.every((segment) => segment.source === "conversation-message")).toBe(true);
		expect(JSON.stringify(snapshot)).not.toContain("private");
	});

	it("caps segment cardinality and reports truncation honestly", () => {
		const messages = Array.from({ length: CONTEXT_SNAPSHOT_MAX_SEGMENTS + 100 }, (_, index) => ({
			role: "user",
			content: `message-${index}`,
		}));
		const snapshot = capture({ messages }, "request-large", 1_000);
		expect(snapshot.segments).toHaveLength(CONTEXT_SNAPSHOT_MAX_SEGMENTS);
		expect(snapshot.truncated).toBe(true);
	});
});
