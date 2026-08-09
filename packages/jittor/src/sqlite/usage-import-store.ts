import type { Database } from "bun:sqlite";
import type { MetricObservation } from "../observability/metric.ts";
import { validateMetricObservation } from "../observability/metric.ts";
import type { HistoricalUsageRecord, UsageImportResult, UsageImportStatus, UsageImportStore } from "../observability/usage-import.ts";

function validateRecord(record: HistoricalUsageRecord): HistoricalUsageRecord {
	if (!/^[a-f0-9]{64}$/.test(record.identity)) throw new Error("usage import identity is invalid");
	if (!Number.isSafeInteger(record.observedAt) || record.observedAt < 0) throw new Error("usage import timestamp is invalid");
	return record;
}

function observations(record: HistoricalUsageRecord): MetricObservation[] {
	const attributes = {
		provider: record.provider,
		model: record.model,
		...(record.thinking ? { thinking: record.thinking } : {}),
		imported: true,
		importIdentity: record.identity,
	};
	const token = (metric: string, value: number, scope: "request-input" | "response-output" | "cache-read" | "cache-write") => ({
		source: "pi",
		scope: `${record.provider}:${record.model}`,
		metric,
		value,
		unit: "tokens" as const,
		observedAt: record.observedAt,
		attributes: {
			...attributes,
			tokenMeasurement: {
				tokens: value,
				scope,
				provenance: "provider-reported",
				method: "pi-assistant-usage",
				provider: record.provider,
				model: record.model,
			},
		},
	});
	return [
		token("input-tokens", record.inputTokens, "request-input"),
		token("output-tokens", record.outputTokens, "response-output"),
		token("cache-read-tokens", record.cacheReadTokens, "cache-read"),
		token("cache-write-tokens", record.cacheWriteTokens, "cache-write"),
		{
			source: "pi",
			scope: `${record.provider}:${record.model}`,
			metric: "cost",
			value: record.costUsd,
			unit: "usd",
			observedAt: record.observedAt,
			attributes,
		},
	].map(validateMetricObservation);
}

export class SQLiteUsageImportStore implements UsageImportStore {
	constructor(private readonly db: Database) {}

	import(input: HistoricalUsageRecord[]): { imported: number; duplicates: number } {
		const records = input.map(validateRecord);
		const claim = this.db.prepare("INSERT OR IGNORE INTO usage_import_identities(identity, imported_at) VALUES (?, ?)");
		const matchingLive = this.db.prepare(
			"SELECT COUNT(DISTINCT metric) AS matched FROM metric_observations WHERE source = 'pi' AND scope = ? AND observed_at = ? AND ((metric = 'input-tokens' AND value = ?) OR (metric = 'output-tokens' AND value = ?) OR (metric = 'cache-read-tokens' AND value = ?) OR (metric = 'cache-write-tokens' AND value = ?) OR (metric = 'cost' AND value = ?))",
		);
		const insert = this.db.prepare(
			"INSERT INTO metric_observations(source, scope, metric, value, unit, observed_at, attributes) VALUES (?, ?, ?, ?, ?, ?, ?)",
		);
		let imported = 0;
		let duplicates = 0;
		this.db.transaction(() => {
			for (const record of records) {
				const scope = `${record.provider}:${record.model}`;
				const live = matchingLive.get(
					scope,
					record.observedAt,
					record.inputTokens,
					record.outputTokens,
					record.cacheReadTokens,
					record.cacheWriteTokens,
					record.costUsd,
				) as { matched: number };
				const result = claim.run(record.identity, Date.now());
				if (result.changes === 0 || live.matched === 5) {
					duplicates += 1;
					continue;
				}
				for (const observation of observations(record)) {
					insert.run(
						observation.source,
						observation.scope,
						observation.metric,
						observation.value,
						observation.unit,
						observation.observedAt,
						JSON.stringify(observation.attributes ?? {}),
					);
				}
				imported += 1;
			}
		})();
		return { imported, duplicates };
	}

	preview(records: HistoricalUsageRecord[]): { duplicates: number } {
		const exists = this.db.prepare("SELECT 1 AS found FROM usage_import_identities WHERE identity = ? LIMIT 1");
		return { duplicates: records.map(validateRecord).filter((record) => exists.get(record.identity) !== null).length };
	}

	status(): UsageImportStatus {
		const row = this.db.query<{ status: string }, []>("SELECT status FROM usage_import_state WHERE id = 1").get();
		if (!row) return { running: false, cancelRequested: false, lastResult: null };
		try {
			const parsed = JSON.parse(row.status) as { lastResult?: unknown };
			const lastResult = parsed.lastResult;
			return {
				running: false,
				cancelRequested: false,
				lastResult:
					typeof lastResult === "object" && lastResult !== null && !Array.isArray(lastResult) ? (lastResult as UsageImportResult) : null,
			};
		} catch {
			return { running: false, cancelRequested: false, lastResult: null };
		}
	}

	saveStatus(status: UsageImportStatus): void {
		this.db
			.prepare(
				"INSERT INTO usage_import_state(id, status, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at",
			)
			.run(JSON.stringify(status), Date.now());
	}
}
