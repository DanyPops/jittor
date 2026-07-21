import type { Database } from "bun:sqlite";
import { DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT } from "../constants.ts";
import type { MetricObservation, MetricQuery, StoredMetricObservation } from "../domain/metric.ts";
import { validateMetricObservation } from "../domain/metric.ts";
import type { DistinctScopesFilter, MetricStore } from "../ports/metric-store.ts";

interface MetricRow {
	id: number;
	source: string;
	scope: string;
	metric: string;
	value: number | null;
	unit: StoredMetricObservation["unit"];
	observed_at: number;
	attributes: string;
}

function fromRow(row: MetricRow): StoredMetricObservation {
	return {
		id: row.id,
		source: row.source,
		scope: row.scope,
		metric: row.metric,
		value: row.value,
		unit: row.unit,
		observedAt: row.observed_at,
		attributes: JSON.parse(row.attributes) as Record<string, unknown>,
	};
}

export class SQLiteMetricStore implements MetricStore {
	constructor(private readonly db: Database) {}

	record(input: MetricObservation): StoredMetricObservation {
		const observation = validateMetricObservation(input);
		const result = this.db.query(`
			INSERT INTO metric_observations (source, scope, metric, value, unit, observed_at, attributes)
			VALUES (?, ?, ?, ?, ?, ?, ?)
		`).run(
			observation.source,
			observation.scope,
			observation.metric,
			observation.value,
			observation.unit,
			observation.observedAt,
			JSON.stringify(observation.attributes ?? {}),
		);
		return this.get(Number(result.lastInsertRowid));
	}

	query(filter: MetricQuery = {}): StoredMetricObservation[] {
		const conditions: string[] = [];
		const parameters: Array<string | number> = [];
		const addEquals = (column: string, value: string | undefined): void => {
			if (value === undefined) return;
			conditions.push(`${column} = ?`);
			parameters.push(value);
		};
		addEquals("source", filter.source);
		addEquals("scope", filter.scope);
		addEquals("metric", filter.metric);
		if (filter.since !== undefined) { conditions.push("observed_at >= ?"); parameters.push(filter.since); }
		if (filter.until !== undefined) { conditions.push("observed_at <= ?"); parameters.push(filter.until); }
		const requestedLimit = Number.isFinite(filter.limit) ? Math.floor(filter.limit!) : DEFAULT_QUERY_LIMIT;
		const limit = Math.max(1, Math.min(MAX_QUERY_LIMIT, requestedLimit));
		const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		const order = filter.order === "desc" ? "DESC" : "ASC";
		const rows = this.db.query(`
			SELECT id, source, scope, metric, value, unit, observed_at, attributes
			FROM metric_observations
			${where}
			ORDER BY observed_at ${order}, id ${order}
			LIMIT ${limit}
		`).all(...parameters) as MetricRow[];
		return rows.map(fromRow);
	}

	distinctScopes(filter: DistinctScopesFilter): string[] {
		const limit = Math.max(1, Math.min(MAX_QUERY_LIMIT, Math.floor(filter.limit)));
		const rows = this.db.query(`
			SELECT DISTINCT scope FROM metric_observations
			WHERE source = ? AND observed_at >= ? AND observed_at <= ?
			ORDER BY scope ASC
			LIMIT ?
		`).all(filter.source, filter.since, filter.until, limit) as Array<{ scope: string }>;
		return rows.map((row) => row.scope);
	}

	pruneBefore(cutoff: number): number {
		if (!Number.isSafeInteger(cutoff) || cutoff < 0) throw new Error("cutoff must be a non-negative integer timestamp");
		return this.db.query("DELETE FROM metric_observations WHERE observed_at < ?").run(cutoff).changes;
	}

	checkpoint(): void {
		this.db.exec("PRAGMA wal_checkpoint(PASSIVE)");
	}

	close(): void {
		this.db.close();
	}

	private get(id: number): StoredMetricObservation {
		const row = this.db.query(`
			SELECT id, source, scope, metric, value, unit, observed_at, attributes
			FROM metric_observations WHERE id = ?
		`).get(id) as MetricRow | null;
		if (!row) throw new Error(`metric observation ${id} was not persisted`);
		return fromRow(row);
	}
}
