import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CONTEXT_SNAPSHOT_MAX_SEGMENTS,
	type ContextSnapshot,
	compareContextSnapshots,
	HmacContextFingerprinter,
	MetricContextSnapshotHistory,
	validateContextSnapshot,
} from "../src/index.ts";
import { openJittorDb } from "../src/sqlite/database.ts";
import { SQLiteMetricStore } from "../src/sqlite/metric-store.ts";
import { JittorService } from "../src/vehicle/service.ts";

function fingerprint(character: string): string {
	return character.repeat(32);
}

function snapshot(segments: ContextSnapshot["segments"], overrides: Partial<Omit<ContextSnapshot, "segments">> = {}): ContextSnapshot {
	return {
		version: 1,
		snapshotId: fingerprint("s"),
		sessionId: fingerprint("q"),
		provider: "openai",
		model: "gpt-5",
		capturedAt: 1_000,
		truncated: false,
		segments,
		...overrides,
	};
}

function segment(
	id: string,
	tokens: number,
	requestPosition: number | null,
	overrides: Partial<ContextSnapshot["segments"][number]> = {},
): ContextSnapshot["segments"][number] {
	return {
		id: fingerprint(id),
		fingerprint: fingerprint(id.toUpperCase()),
		source: "conversation-message",
		tokens,
		state: "active",
		requestPosition,
		...overrides,
	};
}

describe("content-free context snapshots", () => {
	it("validates a bounded shape and rejects content, duplicate identities, and invalid fingerprints", () => {
		const value = validateContextSnapshot(snapshot([segment("a", 10, 0)]));
		expect(value.segments[0]).toEqual(segment("a", 10, 0));
		expect(() => validateContextSnapshot({ ...value, prompt: "private" })).toThrow("unsupported field");
		expect(() => validateContextSnapshot({ ...value, segments: [segment("a", 1, 0), segment("a", 2, 1)] })).toThrow("duplicate segment id");
		expect(() => validateContextSnapshot({ ...value, segments: [{ ...segment("a", 1, 0), fingerprint: "reversible-content" }] })).toThrow(
			"fingerprint",
		);
	});

	it("bounds segment cardinality before persistence or comparison", () => {
		const segments = Array.from({ length: CONTEXT_SNAPSHOT_MAX_SEGMENTS + 1 }, (_, index) =>
			segment(String.fromCharCode(65 + (index % 26)), index, null, {
				id: `${index.toString(36).padStart(6, "0")}${fingerprint("x")}`,
			}),
		);
		expect(() => validateContextSnapshot(snapshot(segments))).toThrow("segment limit");
	});
});

describe("context deltas and stable-prefix churn", () => {
	it("classifies lifecycle changes, finds the first changed request segment, and aggregates source growth", () => {
		const previous = snapshot([
			segment("a", 100, 0, { source: "base-prompt" }),
			segment("b", 50, 1, { source: "tool-definitions" }),
			segment("c", 20, 2, { source: "conversation-message" }),
			segment("d", 10, null, { source: "tool-result" }),
		]);
		const current = snapshot(
			[
				segment("a", 100, 0, { source: "base-prompt" }),
				segment("b", 60, 1, { source: "tool-definitions", fingerprint: fingerprint("Z") }),
				segment("c", 20, null, { source: "conversation-message", state: "compacted" }),
				segment("e", 30, 2, { source: "thinking" }),
				segment("f", 5, null, { source: "tool-call", state: "inactive" }),
			],
			{ snapshotId: fingerprint("t"), capturedAt: 2_000 },
		);

		const delta = compareContextSnapshots(previous, current);
		expect(delta.stablePrefixTokens).toBe(100);
		expect(delta.firstChangedSegment).toMatchObject({ id: fingerprint("b"), source: "tool-definitions", requestPosition: 1 });
		expect(delta.changes.map((change) => [change.id, change.lifecycle])).toEqual([
			[fingerprint("a"), "retained"],
			[fingerprint("b"), "changed"],
			[fingerprint("c"), "compacted"],
			[fingerprint("e"), "added"],
			[fingerprint("f"), "inactive"],
			[fingerprint("d"), "evicted"],
		]);
		expect(delta.growthBySource).toEqual([
			{ source: "base-prompt", deltaTokens: 0 },
			{ source: "tool-definitions", deltaTokens: 10 },
			{ source: "conversation-message", deltaTokens: 0 },
			{ source: "thinking", deltaTokens: 30 },
			{ source: "tool-call", deltaTokens: 5 },
			{ source: "tool-result", deltaTokens: -10 },
		]);
	});

	it("resets stable-prefix correlation on provider or model changes", () => {
		const previous = snapshot([segment("a", 100, 0)]);
		expect(compareContextSnapshots(previous, snapshot([segment("a", 100, 0)], { model: "gpt-5-mini" }))).toMatchObject({
			stablePrefixTokens: 0,
			resetReason: "model-changed",
		});
		expect(compareContextSnapshots(previous, snapshot([segment("a", 100, 0)], { provider: "openrouter" }))).toMatchObject({
			stablePrefixTokens: 0,
			resetReason: "provider-changed",
		});
	});

	it("does not conflate distinct segment identities when keyed fingerprints collide", () => {
		const shared = fingerprint("C");
		const previous = snapshot([segment("a", 10, 0, { fingerprint: shared })]);
		const current = snapshot([segment("b", 10, 0, { fingerprint: shared })], {
			snapshotId: fingerprint("t"),
			capturedAt: 2_000,
		});
		const delta = compareContextSnapshots(previous, current);
		expect(delta.stablePrefixTokens).toBe(0);
		expect(delta.changes.map((change) => change.lifecycle)).toEqual(["added", "evicted"]);
	});
});

describe("context snapshot history through real SQLite", () => {
	it("atomically records and reloads the latest snapshot and delta across a real SQLite restart without content", () => {
		const root = mkdtempSync(join(tmpdir(), "jittor-context-restart-"));
		const databasePath = join(root, "metrics.db");
		let metrics = new SQLiteMetricStore(openJittorDb(databasePath));
		const history = new MetricContextSnapshotHistory(metrics);
		const first = snapshot([segment("a", 10, 0, { source: "base-prompt" })]);
		const second = snapshot([segment("a", 10, 0, { source: "base-prompt" }), segment("b", 20, 1, { source: "tool-definitions" })], {
			snapshotId: fingerprint("t"),
			capturedAt: 2_000,
		});
		expect(history.record(first).resetReason).toBe("initial");
		expect(history.record(second)).toMatchObject({ stablePrefixTokens: 10, previousSnapshotId: first.snapshotId });

		metrics.close();
		metrics = new SQLiteMetricStore(openJittorDb(databasePath));
		const reloaded = new MetricContextSnapshotHistory(metrics);
		expect(reloaded.latestSnapshot(first.sessionId)).toEqual(second);
		expect(reloaded.latestDelta(first.sessionId)).toMatchObject({
			currentSnapshotId: second.snapshotId,
			stablePrefixTokens: 10,
			growthBySource: [
				{ source: "base-prompt", deltaTokens: 0 },
				{ source: "tool-definitions", deltaTokens: 20 },
			],
		});
		const persisted = JSON.stringify(metrics.query({ source: "pi-context-snapshot", limit: 100 }));
		expect(persisted).not.toContain("private prompt /home/person/project");
		expect(persisted).not.toContain("tool arguments");
		metrics.close();
		rmSync(root, { recursive: true, force: true });
	});

	it("keeps a newer snapshot authoritative when a stale capture arrives late", () => {
		const metrics = new SQLiteMetricStore(openJittorDb(":memory:"));
		const history = new MetricContextSnapshotHistory(metrics);
		const newer = snapshot([segment("a", 20, 0)], { snapshotId: fingerprint("n"), capturedAt: 2_000 });
		const stale = snapshot([segment("a", 10, 0)], { snapshotId: fingerprint("o"), capturedAt: 1_500 });
		history.record(newer);
		history.record(stale);
		expect(history.latestSnapshot(newer.sessionId)).toEqual(newer);
		expect(history.latestDelta(newer.sessionId)?.currentSnapshotId).toBe(newer.snapshotId);
		metrics.close();
	});

	it("exposes bounded snapshot recording and latest-delta query through the real operation service", async () => {
		const metrics = new SQLiteMetricStore(openJittorDb(":memory:"));
		const service = new JittorService(metrics);
		const current = snapshot([segment("a", 10, 0)]);
		await expect(service.execute("context.snapshot", current)).resolves.toMatchObject({ currentSnapshotId: current.snapshotId });
		await expect(service.execute("context.delta", { session_id: current.sessionId })).resolves.toMatchObject({
			currentSnapshotId: current.snapshotId,
			resetReason: "initial",
		});
		metrics.close();
	});

	it("rejects a malformed snapshot before any partial rows are written", () => {
		const metrics = new SQLiteMetricStore(openJittorDb(":memory:"));
		const history = new MetricContextSnapshotHistory(metrics);
		expect(() => history.record({ ...snapshot([segment("a", 10, 0)]), content: "private" } as ContextSnapshot)).toThrow(
			"unsupported field",
		);
		expect(metrics.query({ source: "pi-context-snapshot" })).toEqual([]);
		metrics.close();
	});
});

describe("keyed context fingerprinting", () => {
	it("is deterministic for one key, separated across keys, and never returns source content", () => {
		const first = new HmacContextFingerprinter(new Uint8Array(32).fill(1));
		const second = new HmacContextFingerprinter(new Uint8Array(32).fill(2));
		const privateValue = "private prompt /home/person/project";
		expect(first.fingerprint(privateValue)).toBe(first.fingerprint(privateValue));
		expect(first.fingerprint(privateValue)).not.toBe(second.fingerprint(privateValue));
		expect(first.fingerprint(privateValue)).not.toContain("private");
		expect(first.fingerprint(privateValue)).toMatch(/^[A-Za-z0-9_-]{32}$/);
	});
});
