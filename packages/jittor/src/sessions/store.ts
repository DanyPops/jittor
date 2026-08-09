import type { SessionIdentityRecord, SessionIdentityStore as VehicleSessionIdentityStore } from "@danypops/vehicle-server/session-identity";

/** Jittor's persistence port for daemon-kit's storage-agnostic session-identity primitive. */
export type SessionIdentityStore = VehicleSessionIdentityStore;
export type { SessionIdentityRecord };
