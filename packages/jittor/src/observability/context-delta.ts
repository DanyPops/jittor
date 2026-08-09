import { createHmac } from "node:crypto";
import { normalizeModelIdentity } from "./model-identity.ts";

export const CONTEXT_SEGMENT_SOURCES = [
	"base-prompt",
	"tool-definitions",
	"rules",
	"skills",
	"project-context",
	"conversation-message",
	"thinking",
	"tool-call",
	"tool-result",
] as const;
export type ContextSegmentSource = (typeof CONTEXT_SEGMENT_SOURCES)[number];

export const CONTEXT_SEGMENT_STATES = ["active", "compacted", "inactive"] as const;
export type ContextSegmentState = (typeof CONTEXT_SEGMENT_STATES)[number];

export const CONTEXT_SNAPSHOT_MAX_SEGMENTS = 512;
const OPAQUE_FINGERPRINT = /^[A-Za-z0-9_-]{32,64}$/;

export interface ContextSnapshotSegment {
	/** Keyed opaque logical identity. It must not contain an entry id, path, label, or content. */
	id: string;
	/** Keyed opaque fingerprint of the ephemeral segment value. */
	fingerprint: string;
	source: ContextSegmentSource;
	tokens: number;
	state: ContextSegmentState;
	/** Position in the final provider request's stable-prefix sequence, or null for historical-only segments. */
	requestPosition: number | null;
}

export interface ContextSnapshot {
	version: 1;
	snapshotId: string;
	sessionId: string;
	provider: string;
	model: string;
	capturedAt: number;
	truncated: boolean;
	segments: ContextSnapshotSegment[];
}

export type ContextSegmentLifecycle = "added" | "retained" | "changed" | "evicted" | "compacted" | "inactive";

export interface ContextSegmentChange {
	id: string;
	source: ContextSegmentSource;
	lifecycle: ContextSegmentLifecycle;
	previousTokens: number;
	currentTokens: number;
	deltaTokens: number;
	requestPosition: number | null;
}

export interface ContextSourceGrowth {
	source: ContextSegmentSource;
	deltaTokens: number;
}

export type ContextPrefixResetReason = "initial" | "session-changed" | "provider-changed" | "model-changed" | null;

export interface ContextDelta {
	previousSnapshotId: string | null;
	currentSnapshotId: string;
	capturedAt: number;
	truncated: boolean;
	stablePrefixTokens: number;
	firstChangedSegment: Pick<ContextSnapshotSegment, "id" | "source" | "requestPosition"> | null;
	resetReason: ContextPrefixResetReason;
	changes: ContextSegmentChange[];
	growthBySource: ContextSourceGrowth[];
}

const SNAPSHOT_FIELDS = new Set<keyof ContextSnapshot>([
	"version",
	"snapshotId",
	"sessionId",
	"provider",
	"model",
	"capturedAt",
	"truncated",
	"segments",
]);
const SEGMENT_FIELDS = new Set<keyof ContextSnapshotSegment>(["id", "fingerprint", "source", "tokens", "state", "requestPosition"]);

function opaqueFingerprint(value: unknown, name: string): string {
	if (typeof value !== "string" || !OPAQUE_FINGERPRINT.test(value)) throw new Error(`${name} fingerprint is invalid`);
	return value;
}

function nonNegativeInteger(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${name} is invalid`);
	return value;
}

function validateSegment(value: unknown): ContextSnapshotSegment {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("context snapshot segment must be an object");
	const input = value as Record<string, unknown>;
	for (const key of Object.keys(input)) {
		if (!SEGMENT_FIELDS.has(key as keyof ContextSnapshotSegment))
			throw new Error(`context snapshot segment contains unsupported field: ${key}`);
	}
	if (!CONTEXT_SEGMENT_SOURCES.includes(input.source as ContextSegmentSource))
		throw new Error("context snapshot segment source is invalid");
	if (!CONTEXT_SEGMENT_STATES.includes(input.state as ContextSegmentState)) throw new Error("context snapshot segment state is invalid");
	const requestPosition = input.requestPosition;
	if (requestPosition !== null && (typeof requestPosition !== "number" || !Number.isSafeInteger(requestPosition) || requestPosition < 0))
		throw new Error("context snapshot segment request position is invalid");
	return {
		id: opaqueFingerprint(input.id, "segment id"),
		fingerprint: opaqueFingerprint(input.fingerprint, "segment"),
		source: input.source as ContextSegmentSource,
		tokens: nonNegativeInteger(input.tokens, "context snapshot segment tokens"),
		state: input.state as ContextSegmentState,
		requestPosition: requestPosition as number | null,
	};
}

/** Strict, content-free ingress validation before a snapshot can be compared or persisted. */
export function validateContextSnapshot(value: unknown): ContextSnapshot {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("context snapshot must be an object");
	const input = value as Record<string, unknown>;
	for (const key of Object.keys(input)) {
		if (!SNAPSHOT_FIELDS.has(key as keyof ContextSnapshot)) throw new Error(`context snapshot contains unsupported field: ${key}`);
	}
	if (input.version !== 1) throw new Error("context snapshot version is unsupported");
	if (!Array.isArray(input.segments)) throw new Error("context snapshot segments must be an array");
	if (input.segments.length > CONTEXT_SNAPSHOT_MAX_SEGMENTS) throw new Error("context snapshot exceeds the segment limit");
	const segments = input.segments.map(validateSegment);
	const ids = new Set<string>();
	const requestPositions = new Set<number>();
	for (const segment of segments) {
		if (ids.has(segment.id)) throw new Error("context snapshot contains a duplicate segment id");
		ids.add(segment.id);
		if (segment.requestPosition !== null) {
			if (requestPositions.has(segment.requestPosition)) throw new Error("context snapshot contains a duplicate request position");
			requestPositions.add(segment.requestPosition);
			if (segment.state !== "active") throw new Error("historical context segment cannot have a request position");
		}
	}
	if (typeof input.provider !== "string" || typeof input.model !== "string") throw new Error("context snapshot model identity is invalid");
	const identity = normalizeModelIdentity(input.provider, input.model);
	return {
		version: 1,
		snapshotId: opaqueFingerprint(input.snapshotId, "snapshot id"),
		sessionId: opaqueFingerprint(input.sessionId, "session id"),
		provider: identity.provider,
		model: identity.model,
		capturedAt: nonNegativeInteger(input.capturedAt, "context snapshot capture time"),
		truncated:
			input.truncated === false
				? false
				: input.truncated === true
					? true
					: (() => {
							throw new Error("context snapshot truncated flag is invalid");
						})(),
		segments,
	};
}

function resetReason(previous: ContextSnapshot | null, current: ContextSnapshot): ContextPrefixResetReason {
	if (!previous) return "initial";
	if (previous.sessionId !== current.sessionId) return "session-changed";
	if (previous.provider !== current.provider) return "provider-changed";
	if (previous.model !== current.model) return "model-changed";
	return null;
}

function requestSegments(snapshot: ContextSnapshot): ContextSnapshotSegment[] {
	return snapshot.segments
		.filter((segment): segment is ContextSnapshotSegment & { requestPosition: number } => segment.requestPosition !== null)
		.sort((left, right) => left.requestPosition - right.requestPosition);
}

function sameRequestSegment(left: ContextSnapshotSegment, right: ContextSnapshotSegment): boolean {
	return (
		left.id === right.id &&
		left.fingerprint === right.fingerprint &&
		left.source === right.source &&
		left.tokens === right.tokens &&
		left.state === right.state &&
		left.requestPosition === right.requestPosition
	);
}

function prefixEvidence(
	previous: ContextSnapshot | null,
	current: ContextSnapshot,
	reset: ContextPrefixResetReason,
): Pick<ContextDelta, "stablePrefixTokens" | "firstChangedSegment"> {
	const previousRequest = previous ? requestSegments(previous) : [];
	const currentRequest = requestSegments(current);
	if (reset !== null) {
		const first = currentRequest[0] ?? previousRequest[0];
		return {
			stablePrefixTokens: 0,
			firstChangedSegment: first ? { id: first.id, source: first.source, requestPosition: first.requestPosition } : null,
		};
	}
	let stablePrefixTokens = 0;
	const limit = Math.max(previousRequest.length, currentRequest.length);
	for (let index = 0; index < limit; index++) {
		const before = previousRequest[index];
		const after = currentRequest[index];
		if (before && after && sameRequestSegment(before, after)) {
			stablePrefixTokens += after.tokens;
			continue;
		}
		const first = after ?? before;
		return {
			stablePrefixTokens,
			firstChangedSegment: first ? { id: first.id, source: first.source, requestPosition: first.requestPosition } : null,
		};
	}
	return { stablePrefixTokens, firstChangedSegment: null };
}

function lifecycle(previous: ContextSnapshotSegment | undefined, current: ContextSnapshotSegment): ContextSegmentLifecycle {
	if (current.state === "compacted") return "compacted";
	if (current.state === "inactive") return "inactive";
	if (!previous) return "added";
	return sameRequestSegment(previous, current) ||
		(previous.id === current.id &&
			previous.fingerprint === current.fingerprint &&
			previous.source === current.source &&
			previous.tokens === current.tokens &&
			previous.state === current.state)
		? "retained"
		: "changed";
}

function sourceGrowth(previous: ContextSnapshot | null, current: ContextSnapshot): ContextSourceGrowth[] {
	const before = new Map<ContextSegmentSource, number>();
	const after = new Map<ContextSegmentSource, number>();
	for (const segment of previous?.segments ?? []) before.set(segment.source, (before.get(segment.source) ?? 0) + segment.tokens);
	for (const segment of current.segments) after.set(segment.source, (after.get(segment.source) ?? 0) + segment.tokens);
	return CONTEXT_SEGMENT_SOURCES.filter((source) => before.has(source) || after.has(source)).map((source) => ({
		source,
		deltaTokens: (after.get(source) ?? 0) - (before.get(source) ?? 0),
	}));
}

/**
 * Correlates bounded keyed identities. Stable-prefix correlation is evidence of structural churn,
 * not proof of a provider cache hit or miss.
 */
export function compareContextSnapshots(previousValue: ContextSnapshot | null, currentValue: ContextSnapshot): ContextDelta {
	const previous = previousValue === null ? null : validateContextSnapshot(previousValue);
	const current = validateContextSnapshot(currentValue);
	const priorById = new Map((previous?.segments ?? []).map((segment) => [segment.id, segment]));
	const changes: ContextSegmentChange[] = current.segments.map((segment) => {
		const prior = priorById.get(segment.id);
		priorById.delete(segment.id);
		return {
			id: segment.id,
			source: segment.source,
			lifecycle: lifecycle(prior, segment),
			previousTokens: prior?.tokens ?? 0,
			currentTokens: segment.tokens,
			deltaTokens: segment.tokens - (prior?.tokens ?? 0),
			requestPosition: segment.requestPosition,
		};
	});
	for (const segment of previous?.segments ?? []) {
		if (!priorById.has(segment.id)) continue;
		changes.push({
			id: segment.id,
			source: segment.source,
			lifecycle: "evicted",
			previousTokens: segment.tokens,
			currentTokens: 0,
			deltaTokens: -segment.tokens,
			requestPosition: null,
		});
	}
	const reset = resetReason(previous, current);
	return {
		previousSnapshotId: previous?.snapshotId ?? null,
		currentSnapshotId: current.snapshotId,
		capturedAt: current.capturedAt,
		truncated: current.truncated,
		...prefixEvidence(previous, current, reset),
		resetReason: reset,
		changes,
		growthBySource: sourceGrowth(previous, current),
	};
}

export interface ContextFingerprinter {
	fingerprint(value: string | Uint8Array): string;
}

/** HMAC keeps low-entropy/context labels resistant to offline reversal if snapshot rows are copied. */
export class HmacContextFingerprinter implements ContextFingerprinter {
	private readonly key: Uint8Array;

	constructor(key: Uint8Array) {
		if (key.byteLength < 32) throw new Error("context fingerprint key must contain at least 32 bytes");
		this.key = key.slice();
	}

	fingerprint(value: string | Uint8Array): string {
		return createHmac("sha256", this.key).update(value).digest().subarray(0, 24).toString("base64url");
	}
}
