import type { Database } from "bun:sqlite";
import { SESSION_IDENTITY_MAX_ROWS } from "../constants.ts";
import type { SessionIdentityRecord, SessionIdentityStore } from "../ports/session-identity-store.ts";

export class SQLiteSessionIdentityStore implements SessionIdentityStore {
	constructor(private readonly db: Database) {}

	find(sessionId: string): SessionIdentityRecord | undefined {
		const row = this.db.query("SELECT session_id, secret_hash, registered_at, last_seen_at FROM session_identities WHERE session_id = ?").get(sessionId) as
			| { session_id: string; secret_hash: string; registered_at: string; last_seen_at: string }
			| null;
		return row ? { sessionId: row.session_id, secretHash: row.secret_hash, registeredAt: row.registered_at, lastSeenAt: row.last_seen_at } : undefined;
	}

	upsert(record: SessionIdentityRecord): void {
		this.db.transaction(() => {
			this.evictOldestBeyondCap(record.sessionId);
			this.db.query(`
				INSERT INTO session_identities (session_id, secret_hash, registered_at, last_seen_at)
				VALUES (?, ?, ?, ?)
				ON CONFLICT(session_id) DO UPDATE SET secret_hash = excluded.secret_hash, registered_at = excluded.registered_at, last_seen_at = excluded.last_seen_at
			`).run(record.sessionId, record.secretHash, record.registeredAt, record.lastSeenAt);
		})();
	}

	remove(sessionId: string): void {
		this.db.query("DELETE FROM session_identities WHERE session_id = ?").run(sessionId);
	}

	touch(sessionId: string, lastSeenAt: string): void {
		this.db.query("UPDATE session_identities SET last_seen_at = ? WHERE session_id = ?").run(lastSeenAt, sessionId);
	}

	count(): number {
		return (this.db.query("SELECT COUNT(*) AS count FROM session_identities").get() as { count: number }).count;
	}

	/** Bounds distinct registered session identities; evicts the least-recently-seen beyond the cap. */
	private evictOldestBeyondCap(sessionId: string): void {
		const exists = this.db.query("SELECT 1 FROM session_identities WHERE session_id = ?").get(sessionId);
		if (exists) return;
		if (this.count() < SESSION_IDENTITY_MAX_ROWS) return;
		this.db.exec("DELETE FROM session_identities WHERE session_id = (SELECT session_id FROM session_identities ORDER BY last_seen_at ASC LIMIT 1)");
	}
}
