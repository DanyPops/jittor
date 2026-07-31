import {
	CONTEXT_HUB_CONTRIBUTION_DEDUP_LIMIT,
	validateContextContribution,
	type ContextSegment,
} from "@danypops/jittor";

/**
 * Merges Jittor's own directly-computed segments (tool ledger, real usage) with whatever
 * segments other extensions contributed on CONTEXT_HUB_CONTRIBUTION_CHANNEL for the current
 * session. Keeps only the latest contribution per producer -- a producer re-emits every turn
 * (mirroring Papyrus's own context-injection.v1 cadence), so an older segment from the same
 * producer is stale, not a second real contributor.
 */
export class ContextHubCapability {
	private readonly latestByProducer = new Map<string, ContextSegment>();
	private readonly seen = new Set<string>();

	/** Validates and records one contribution; silently drops a malformed, stale, or duplicate one without retaining its payload or crashing the caller. */
	observe(payload: unknown, now = Date.now()): void {
		try {
			const contribution = validateContextContribution(payload, now);
			const key = `${contribution.producerName}:${contribution.sequence}`;
			if (this.seen.has(key)) return;
			this.seen.add(key);
			if (this.seen.size > CONTEXT_HUB_CONTRIBUTION_DEDUP_LIMIT) this.seen.delete(this.seen.values().next().value!);
			this.latestByProducer.set(contribution.producerName, contribution.segment);
		} catch {
			// Reject malformed or stale cross-extension contributions without retaining payloads.
		}
	}

	contributedSegments(): ContextSegment[] {
		return [...this.latestByProducer.values()];
	}

	reset(): void {
		this.latestByProducer.clear();
		this.seen.clear();
	}
}
