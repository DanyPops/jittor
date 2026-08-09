import { MODEL_CATALOG_MAX_ENTRIES, MODEL_CATALOG_STORE_QUERY_LIMIT } from "../../constants.ts";
import type { MetricObservation } from "../../observability/metric.ts";
import type { MetricStore } from "../../observability/store.ts";
import type { ModelCatalogEntry, ModelCatalogSnapshot, ModelCatalogStore } from "./catalog.ts";

const SOURCE = "catalog:models.dev";
const SNAPSHOT_SCOPE = "snapshot";
const COMPLETE_METRIC = "snapshot-complete";
const ENTRY_METRIC = "model";
const BATCH_SIZE = 100;

function validEntry(value: unknown): value is ModelCatalogEntry {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const entry = value as Partial<ModelCatalogEntry>;
	return (
		typeof entry.provider === "string" &&
		typeof entry.model === "string" &&
		typeof entry.canonical === "string" &&
		Array.isArray(entry.aliases) &&
		typeof entry.name === "string" &&
		typeof entry.limits?.context === "number" &&
		typeof entry.limits?.output === "number" &&
		typeof entry.fieldAuthority === "object" &&
		entry.fieldAuthority !== null
	);
}

function entryObservation(snapshot: ModelCatalogSnapshot, entry: ModelCatalogEntry): MetricObservation {
	return {
		source: SOURCE,
		scope: entry.canonical,
		metric: ENTRY_METRIC,
		value: 1,
		unit: "count",
		observedAt: snapshot.provenance.retrievedAt,
		attributes: { snapshotId: snapshot.snapshotId, entry },
	};
}

/** Complete-marker snapshot store: failed/partial writes remain invisible because the marker lands last. */
export class MetricModelCatalogStore implements ModelCatalogStore {
	constructor(private readonly metrics: MetricStore) {}

	publish(snapshot: ModelCatalogSnapshot): ModelCatalogSnapshot {
		if (snapshot.entries.length === 0 || snapshot.entries.length > MODEL_CATALOG_MAX_ENTRIES)
			throw new Error("model catalog snapshot exceeds the entry limit");
		const existing = this.latest();
		if (existing?.snapshotId === snapshot.snapshotId) return existing;
		const rows = snapshot.entries.map((entry) => entryObservation(snapshot, entry));
		for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) this.metrics.recordBatch(rows.slice(offset, offset + BATCH_SIZE));
		this.metrics.record({
			source: SOURCE,
			scope: SNAPSHOT_SCOPE,
			metric: COMPLETE_METRIC,
			value: rows.length,
			unit: "count",
			observedAt: snapshot.provenance.retrievedAt,
			attributes: {
				snapshotId: snapshot.snapshotId,
				provenance: snapshot.provenance,
			},
		});
		return structuredClone(snapshot);
	}

	latest(): ModelCatalogSnapshot | null {
		const marker = this.metrics.query({ source: SOURCE, scope: SNAPSHOT_SCOPE, metric: COMPLETE_METRIC, order: "desc", limit: 1 })[0];
		if (!marker || typeof marker.value !== "number" || !Number.isSafeInteger(marker.value) || marker.value < 1) return null;
		const snapshotId = marker.attributes.snapshotId;
		const provenance = marker.attributes.provenance;
		if (typeof snapshotId !== "string" || typeof provenance !== "object" || provenance === null || Array.isArray(provenance)) return null;
		const rows = this.metrics.query({ source: SOURCE, until: marker.observedAt, order: "desc", limit: MODEL_CATALOG_STORE_QUERY_LIMIT });
		const markerIndex = rows.findIndex((row) => row.id === marker.id);
		if (markerIndex < 0) return null;
		const entries = rows
			.slice(markerIndex + 1)
			.filter((row) => row.metric === ENTRY_METRIC && row.attributes.snapshotId === snapshotId)
			.slice(0, marker.value)
			.map((row) => row.attributes.entry);
		if (entries.length !== marker.value || !entries.every(validEntry)) return null;
		const p = provenance as Record<string, unknown>;
		if (
			p.sourceId !== "models.dev" ||
			typeof p.sourceUrl !== "string" ||
			typeof p.revision !== "string" ||
			typeof p.retrievedAt !== "number" ||
			typeof p.freshUntil !== "number" ||
			p.license !== "MIT"
		)
			return null;
		return {
			snapshotId,
			provenance: p as unknown as ModelCatalogSnapshot["provenance"],
			entries: (entries as ModelCatalogEntry[]).reverse().map((entry) => structuredClone(entry)),
		};
	}
}
