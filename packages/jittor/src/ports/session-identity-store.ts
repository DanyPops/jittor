import type { SessionIdentityRecord, SessionIdentityStore as DaemonKitSessionIdentityStore } from "@danypops/daemon-kit/session-identity";

/** Jittor's persistence port for daemon-kit's storage-agnostic session-identity primitive. */
export type SessionIdentityStore = DaemonKitSessionIdentityStore;
export type { SessionIdentityRecord };
