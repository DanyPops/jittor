import {
	isSessionRegistered,
	registerSessionIdentity,
	releaseSessionIdentity,
	verifySessionSecret,
} from "@danypops/vehicle-server/session-identity";
import type { SessionIdentityStore } from "./store.ts";

export interface RegisterSessionIdentityResult {
	sessionId: string;
	secret: string;
}

/** Thrown when a session_id has a registered identity but the caller did not present a matching session_secret. Mapped to HTTP 403 in service.ts, separate from generic validation's 400. */
export class InvalidSessionSecretError extends Error {}

function assertValidSessionId(sessionId: string): void {
	if (typeof sessionId !== "string" || sessionId.length === 0) throw new Error("session_id is required");
}

/**
 * Wraps daemon-kit's storage-agnostic session-identity primitive against Jittor's own
 * SQLite-backed store, and enforces it at the one place a caller-supplied session_id is
 * behavior-affecting: mutating router.* operations (see optimization/routing/controller.ts).
 *
 * Opt-in armor, not a breaking migration: a session_id that was never registered mutates
 * exactly as before (undefined sessionId included, since that maps to the router's legacy
 * "global" scope). Only once a sessionId is registered does a matching session_secret become
 * mandatory. Every real Pi session becomes armored automatically once its extension fires
 * session_start and registers.
 */
export class SessionIdentity {
	constructor(private readonly store: SessionIdentityStore) {}

	register(sessionId: string): RegisterSessionIdentityResult {
		assertValidSessionId(sessionId);
		return registerSessionIdentity(this.store, sessionId);
	}

	release(sessionId: string, secret: string | undefined): { released: boolean } {
		assertValidSessionId(sessionId);
		const wasRegistered = isSessionRegistered(this.store, sessionId);
		releaseSessionIdentity(this.store, sessionId, secret);
		return { released: wasRegistered && !isSessionRegistered(this.store, sessionId) };
	}

	isRegistered(sessionId: string): boolean {
		return isSessionRegistered(this.store, sessionId);
	}

	verify(sessionId: string, secret: string | undefined): boolean {
		return verifySessionSecret(this.store, sessionId, secret);
	}

	assertAuthorized(sessionId: string | undefined, secret: string | undefined): void {
		if (sessionId === undefined) return;
		if (!this.isRegistered(sessionId)) return;
		if (!this.verify(sessionId, secret))
			throw new InvalidSessionSecretError(
				`session "${sessionId}" is registered; a valid session_secret is required to mutate its router state`,
			);
	}
}
