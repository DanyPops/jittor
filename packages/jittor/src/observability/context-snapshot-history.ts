import {
	CONTEXT_SEGMENT_SOURCES,
	CONTEXT_SNAPSHOT_MAX_SEGMENTS,
	type ContextDelta,
	type ContextPrefixResetReason,
	type ContextSegmentChange,
	type ContextSnapshot,
	type ContextSnapshotSegment,
	type ContextSourceGrowth,
	compareContextSnapshots,
	validateContextSnapshot,
} from "./context-delta.ts";
import type { MetricObservation, StoredMetricObservation } from "./metric.ts";
import type { MetricStore } from "./store.ts";

const CONTEXT_SNAPSHOT_METRIC_SOURCE = "pi-context-snapshot";
const CONTEXT_SNAPSHOT_HEADER_METRIC = "snapshot";
const CONTEXT_SNAPSHOT_SEGMENT_METRIC = "segment";
const CONTEXT_SNAPSHOT_CHANGE_METRIC = "change";
const CONTEXT_SNAPSHOT_MAX_CHANGES = CONTEXT_SNAPSHOT_MAX_SEGMENTS * 2;

interface SnapshotHeaderAttributes {
	snapshotId: string;
	previousSnapshotId: string | null;
	provider: string;
	model: string;
	segmentCount: number;
	changeCount: number;
	truncated: boolean;
	resetReason: ContextPrefixResetReason;
	firstChangedSegment: ContextDelta["firstChangedSegment"];
	growthBySource: ContextSourceGrowth[];
}

export interface ContextSnapshotHistory {
	record(snapshot: ContextSnapshot): ContextDelta;
	latestSnapshot(sessionId: string): ContextSnapshot | null;
	latestDelta(sessionId: string): ContextDelta | null;
}

function recordValue(value: unknown, name: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} is invalid`);
	return value as Record<string, unknown>;
}

function integer(value: unknown, name: string, maximum = Number.MAX_SAFE_INTEGER): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) throw new Error(`${name} is invalid`);
	return value;
}

function nullableFingerprint(value: unknown, name: string): string | null {
	if (value === null) return null;
	if (typeof value !== "string" || !/^[A-Za-z0-9_-]{32,64}$/.test(value)) throw new Error(`${name} is invalid`);
	return value;
}

function headerAttributes(row: StoredMetricObservation): SnapshotHeaderAttributes {
	const input = row.attributes;
	if (typeof input.provider !== "string" || typeof input.model !== "string") throw new Error("stored context snapshot identity is invalid");
	const resetReason = input.resetReason;
	if (resetReason !== null && !["initial", "session-changed", "provider-changed", "model-changed"].includes(resetReason as string))
		throw new Error("stored context snapshot reset reason is invalid");
	const growth = input.growthBySource;
	if (!Array.isArray(growth) || growth.length > CONTEXT_SEGMENT_SOURCES.length) throw new Error("stored context source growth is invalid");
	const growthBySource = growth.map((value) => {
		const item = recordValue(value, "stored context source growth");
		if (
			!CONTEXT_SEGMENT_SOURCES.includes(item.source as ContextSourceGrowth["source"]) ||
			typeof item.deltaTokens !== "number" ||
			!Number.isSafeInteger(item.deltaTokens)
		)
			throw new Error("stored context source growth is invalid");
		return { source: item.source as ContextSourceGrowth["source"], deltaTokens: item.deltaTokens };
	});
	let firstChangedSegment: ContextDelta["firstChangedSegment"] = null;
	if (input.firstChangedSegment !== null) {
		const first = recordValue(input.firstChangedSegment, "stored first changed context segment");
		if (
			typeof first.id !== "string" ||
			!CONTEXT_SEGMENT_SOURCES.includes(first.source as ContextSnapshotSegment["source"]) ||
			(first.requestPosition !== null && (typeof first.requestPosition !== "number" || !Number.isSafeInteger(first.requestPosition)))
		)
			throw new Error("stored first changed context segment is invalid");
		firstChangedSegment = {
			id: first.id,
			source: first.source as ContextSnapshotSegment["source"],
			requestPosition: first.requestPosition as number | null,
		};
	}
	return {
		snapshotId: nullableFingerprint(input.snapshotId, "stored snapshot id")!,
		previousSnapshotId: nullableFingerprint(input.previousSnapshotId, "stored previous snapshot id"),
		provider: input.provider,
		model: input.model,
		segmentCount: integer(input.segmentCount, "stored context segment count", CONTEXT_SNAPSHOT_MAX_SEGMENTS),
		changeCount: integer(input.changeCount, "stored context change count", CONTEXT_SNAPSHOT_MAX_CHANGES),
		truncated: input.truncated === true,
		resetReason: resetReason as ContextPrefixResetReason,
		firstChangedSegment,
		growthBySource,
	};
}

function segmentObservation(snapshot: ContextSnapshot, segment: ContextSnapshotSegment, index: number): MetricObservation {
	return {
		source: CONTEXT_SNAPSHOT_METRIC_SOURCE,
		scope: snapshot.sessionId,
		metric: CONTEXT_SNAPSHOT_SEGMENT_METRIC,
		value: segment.tokens,
		unit: "tokens",
		observedAt: snapshot.capturedAt,
		attributes: {
			snapshotId: snapshot.snapshotId,
			index,
			id: segment.id,
			fingerprint: segment.fingerprint,
			source: segment.source,
			state: segment.state,
			requestPosition: segment.requestPosition,
		},
	};
}

function changeObservation(snapshot: ContextSnapshot, change: ContextSegmentChange, index: number): MetricObservation {
	return {
		source: CONTEXT_SNAPSHOT_METRIC_SOURCE,
		scope: snapshot.sessionId,
		metric: CONTEXT_SNAPSHOT_CHANGE_METRIC,
		value: change.deltaTokens,
		unit: "tokens",
		observedAt: snapshot.capturedAt,
		attributes: { snapshotId: snapshot.snapshotId, index, ...change },
	};
}

function headerObservation(snapshot: ContextSnapshot, delta: ContextDelta): MetricObservation {
	return {
		source: CONTEXT_SNAPSHOT_METRIC_SOURCE,
		scope: snapshot.sessionId,
		metric: CONTEXT_SNAPSHOT_HEADER_METRIC,
		value: delta.stablePrefixTokens,
		unit: "tokens",
		observedAt: snapshot.capturedAt,
		attributes: {
			snapshotId: snapshot.snapshotId,
			previousSnapshotId: delta.previousSnapshotId,
			provider: snapshot.provider,
			model: snapshot.model,
			segmentCount: snapshot.segments.length,
			changeCount: delta.changes.length,
			truncated: snapshot.truncated,
			resetReason: delta.resetReason,
			firstChangedSegment: delta.firstChangedSegment,
			growthBySource: delta.growthBySource,
		},
	};
}

function segmentFromRow(row: StoredMetricObservation): { index: number; segment: ContextSnapshotSegment } {
	const input = row.attributes;
	const requestPosition = input.requestPosition;
	if (row.value === null) throw new Error("stored context segment token count is invalid");
	return {
		index: integer(input.index, "stored context segment index", CONTEXT_SNAPSHOT_MAX_SEGMENTS - 1),
		segment: {
			id: String(input.id),
			fingerprint: String(input.fingerprint),
			source: input.source as ContextSnapshotSegment["source"],
			tokens: integer(row.value, "stored context segment token count"),
			state: input.state as ContextSnapshotSegment["state"],
			requestPosition: requestPosition === null ? null : integer(requestPosition, "stored context request position"),
		},
	};
}

function changeFromRow(row: StoredMetricObservation): { index: number; change: ContextSegmentChange } {
	const input = row.attributes;
	if (!CONTEXT_SEGMENT_SOURCES.includes(input.source as ContextSegmentChange["source"]))
		throw new Error("stored context change source is invalid");
	if (!["added", "retained", "changed", "evicted", "compacted", "inactive"].includes(input.lifecycle as string))
		throw new Error("stored context change lifecycle is invalid");
	const deltaTokens = input.deltaTokens;
	if (typeof deltaTokens !== "number" || !Number.isSafeInteger(deltaTokens)) throw new Error("stored context change delta is invalid");
	return {
		index: integer(input.index, "stored context change index", CONTEXT_SNAPSHOT_MAX_CHANGES - 1),
		change: {
			id: String(input.id),
			source: input.source as ContextSegmentChange["source"],
			lifecycle: input.lifecycle as ContextSegmentChange["lifecycle"],
			previousTokens: integer(input.previousTokens, "stored previous context tokens"),
			currentTokens: integer(input.currentTokens, "stored current context tokens"),
			deltaTokens,
			requestPosition: input.requestPosition === null ? null : integer(input.requestPosition, "stored context change position"),
		},
	};
}

/** Persists snapshots using MetricStore's real atomic batch and reloads them without retaining source content. */
export class MetricContextSnapshotHistory implements ContextSnapshotHistory {
	constructor(private readonly metrics: MetricStore) {}

	record(value: ContextSnapshot): ContextDelta {
		const snapshot = validateContextSnapshot(value);
		const latest = this.latestSnapshot(snapshot.sessionId);
		if (latest?.snapshotId === snapshot.snapshotId) {
			const existing = this.latestDelta(snapshot.sessionId);
			if (!existing) throw new Error("context snapshot exists without its delta");
			return existing;
		}
		const delta = compareContextSnapshots(latest, snapshot);
		this.metrics.recordBatch([
			headerObservation(snapshot, delta),
			...snapshot.segments.map((segment, index) => segmentObservation(snapshot, segment, index)),
			...delta.changes.map((change, index) => changeObservation(snapshot, change, index)),
		]);
		return delta;
	}

	latestSnapshot(sessionId: string): ContextSnapshot | null {
		const header = this.latestHeader(sessionId);
		if (!header) return null;
		const attributes = headerAttributes(header);
		const segments = this.rowsForSnapshot(sessionId, CONTEXT_SNAPSHOT_SEGMENT_METRIC, attributes.snapshotId, attributes.segmentCount)
			.map(segmentFromRow)
			.sort((left, right) => left.index - right.index)
			.map(({ segment }) => segment);
		if (segments.length !== attributes.segmentCount) throw new Error("stored context snapshot is incomplete");
		return validateContextSnapshot({
			version: 1,
			snapshotId: attributes.snapshotId,
			sessionId,
			provider: attributes.provider,
			model: attributes.model,
			capturedAt: header.observedAt,
			truncated: attributes.truncated,
			segments,
		});
	}

	latestDelta(sessionId: string): ContextDelta | null {
		const header = this.latestHeader(sessionId);
		if (!header) return null;
		const attributes = headerAttributes(header);
		const changes = this.rowsForSnapshot(sessionId, CONTEXT_SNAPSHOT_CHANGE_METRIC, attributes.snapshotId, attributes.changeCount)
			.map(changeFromRow)
			.sort((left, right) => left.index - right.index)
			.map(({ change }) => change);
		if (changes.length !== attributes.changeCount) throw new Error("stored context delta is incomplete");
		if (header.value === null) throw new Error("stored stable prefix is invalid");
		return {
			previousSnapshotId: attributes.previousSnapshotId,
			currentSnapshotId: attributes.snapshotId,
			capturedAt: header.observedAt,
			truncated: attributes.truncated,
			stablePrefixTokens: integer(header.value, "stored stable prefix"),
			firstChangedSegment: attributes.firstChangedSegment,
			resetReason: attributes.resetReason,
			changes,
			growthBySource: attributes.growthBySource,
		};
	}

	private latestHeader(sessionId: string): StoredMetricObservation | null {
		return (
			this.metrics.query({
				source: CONTEXT_SNAPSHOT_METRIC_SOURCE,
				scope: sessionId,
				metric: CONTEXT_SNAPSHOT_HEADER_METRIC,
				order: "desc",
				limit: 1,
			})[0] ?? null
		);
	}

	private rowsForSnapshot(sessionId: string, metric: string, snapshotId: string, expected: number): StoredMetricObservation[] {
		if (expected === 0) return [];
		return this.metrics
			.query({ source: CONTEXT_SNAPSHOT_METRIC_SOURCE, scope: sessionId, metric, order: "desc", limit: expected })
			.filter((row) => row.attributes.snapshotId === snapshotId);
	}
}
