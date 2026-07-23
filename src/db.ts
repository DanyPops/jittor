import type { Database } from "bun:sqlite";
import { openSqliteWithPragmas } from "@danypops/daemon-kit/storage";
import { SQLITE_BUSY_TIMEOUT_MS } from "./constants.ts";

const INITIAL_SCHEMA = `
CREATE TABLE metric_observations (
	id          INTEGER PRIMARY KEY AUTOINCREMENT,
	source      TEXT NOT NULL,
	scope       TEXT NOT NULL,
	metric      TEXT NOT NULL,
	value       REAL,
	unit        TEXT NOT NULL,
	observed_at INTEGER NOT NULL CHECK(observed_at >= 0),
	attributes  TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(attributes))
);
CREATE INDEX metric_observations_series_time_idx
	ON metric_observations(source, scope, metric, observed_at);
CREATE INDEX metric_observations_time_idx
	ON metric_observations(observed_at);
`;

/**
 * Delegates bootstrap (pragmas, migration engine) to `@danypops/daemon-kit/storage`, which
 * generalizes the byte-identical pragma/PRAGMA-user_version skeleton jittor's own db.ts used to
 * hand-roll (see daemon-kit's README). Jittor's only remaining responsibility is its own schema.
 */
export function openJittorDb(path: string): Database {
	return openSqliteWithPragmas(path, {
		databaseOptions: { create: true, strict: true },
		busyTimeoutMs: SQLITE_BUSY_TIMEOUT_MS,
		migrations: [{ version: 1, up: (db) => db.exec(INITIAL_SCHEMA) }],
	});
}
