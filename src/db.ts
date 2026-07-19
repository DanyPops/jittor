import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { SQLITE_BUSY_TIMEOUT_MS, SQLITE_SCHEMA_VERSION } from "./constants.ts";

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

function migrate(db: Database): void {
	const row = db.query("PRAGMA user_version").get() as { user_version: number };
	if (row.user_version > SQLITE_SCHEMA_VERSION) {
		throw new Error(`database schema ${row.user_version} is newer than supported ${SQLITE_SCHEMA_VERSION}`);
	}
	if (row.user_version < 1) {
		const migration = db.transaction(() => {
			db.exec(INITIAL_SCHEMA);
			db.exec("PRAGMA user_version = 1");
		});
		migration.immediate();
	}
	const migrated = db.query("PRAGMA user_version").get() as { user_version: number };
	if (migrated.user_version !== SQLITE_SCHEMA_VERSION) {
		throw new Error(`missing migration from schema ${migrated.user_version} to ${SQLITE_SCHEMA_VERSION}`);
	}
}

export function openJittorDb(path: string): Database {
	if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
	const db = new Database(path, { create: true, strict: true });
	db.exec("PRAGMA foreign_keys = ON");
	db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
	if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
	migrate(db);
	db.exec("PRAGMA optimize=0x10002");
	return db;
}
