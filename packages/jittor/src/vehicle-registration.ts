/**
 * jittor's 25-operation surface projected onto the real Vehicle protocol.
 * Every operation delegates to the exact same handler function service.ts's
 * hand-rolled dispatch already calls (one implementation, two projections --
 * the same shape every other Vehicle-migrated daemon in this ecosystem
 * uses) -- no behavior change, only a second real transport served
 * alongside (not replacing) the existing /api/v1/ops route.
 *
 * Every jittor operation already validates its own loosely-typed
 * Record<string, unknown> input internally (see operations/*.ts) -- there
 * is no separate Vehicle-side schema to duplicate that logic, so both input
 * and output use passthroughVehicleSchema and let the real handler's own
 * validation (already covered by service.test.ts) be the single source of
 * truth for what's accepted.
 *
 * jittor's operations are never exposed as Pi tools (confirmed: pi-jittor
 * has zero pi.registerTool() call sites -- its whole surface is consumed
 * internally by the extension's own footer/context-hub/router capabilities),
 * so effect/permission classification here is about standardized taxonomy
 * and future eligibility (Vehicle Jobs, Approval Gate, Safety), not gating
 * an agent-facing tool call the way it does for a Vehicle whose operations
 * ARE projected as tools.
 */

import type { VehicleEffect, VehicleIdempotency } from "@danypops/vehicle-core";
import { bindVehicleOperation, defineVehicleOperation, passthroughVehicleSchema, VehicleError } from "@danypops/vehicle-core";
import type { VehicleRegistry } from "@danypops/vehicle-server";
import type { OperationHandlerMap } from "./operations/types.ts";
import type { OperationName } from "./service.ts";
import { InvalidSessionSecretError } from "./session-identity-service.ts";

/**
 * Preserves /api/v1/ops's own error-to-status behavior (see createApp() in
 * service.ts): InvalidSessionSecretError -> 403, everything else a handler
 * throws -> 400. Without this, VehicleRegistry's own invoke() wraps any
 * handler-thrown error that isn't already a VehicleError into
 * category:"internal" (HTTP 500), losing both the specific status and the
 * error's own message (a VehicleFailure never serializes an error's cause
 * over the wire) -- the same regression class found and fixed in
 * web-spider's own migration (see its vehicle-error-parity.ts).
 */
async function withJittorErrorParity<T>(run: () => T | Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (error) {
		if (error instanceof VehicleError) throw error;
		if (error instanceof InvalidSessionSecretError) {
			throw new VehicleError("invalid-session-secret", error.message, { category: "authorization", cause: error });
		}
		const message = error instanceof Error ? error.message : String(error);
		throw new VehicleError("operation-rejected", message, { category: "validation", cause: error });
	}
}

const OWNER = "jittor";
const LIMITS = { defaultTimeoutMs: 10_000, maxTimeoutMs: 30_000, maxRequestBytes: 65_536, maxResponseBytes: 1_048_576 };

interface OperationMeta {
	readonly description: string;
	readonly effect: VehicleEffect;
}

const READ: VehicleIdempotency = { mode: "safe" };
const WRITE: VehicleIdempotency = { mode: "unsafe" };

/**
 * One entry per EXPECTED_OPERATION_NAMES member -- effect classification
 * rationale:
 * - metrics.record/record_batch: local-write (jittor's own metric store).
 * - metrics.query/distinct_scopes/usage_series/cost_by_task: read (pure
 *   projections of already-recorded local data).
 * - metrics.prune: destructive (irreversible deletion; the handler itself
 *   already refuses a too-recent cutoff without force:true).
 * - benchmark.refresh: external-write (refreshes from external model
 *   benchmark/leaderboard sources) -- a genuine future Vehicle Jobs
 *   candidate given its existing status/query split, deferred here (see
 *   this task's closing note) same as web-spider's fetch/crawl.
 * - benchmark.status/query: read (local cache of the last refresh).
 * - session.register/release: local-write (jittor's own session-identity
 *   registry).
 * - models.rank: local-write -- primarily a read/scoring operation, but an
 *   automatic selection applies it as a real router mutation as a side
 *   effect (see model-ranking-operations.ts), so classified by its most
 *   consequential possible outcome, not its common case.
 * - context.assess/compaction.estimate: read.
 * - service.checkpoint: local-write (flushes the metric store's WAL).
 * - telemetry.poll: read (reads external telemetry provider status; does
 *   not itself expose a way to write anything back to those providers).
 * - router.status/decide: read (a decision query, not a mutation).
 * - router.pause/resume/override/clear_override/current_route/
 *   available_routes: local-write (every one is a real router.set (or
 *   pause/resume) call, despite router.current_route's read-sounding name
 *   -- confirmed directly against router-operations.ts).
 */
const OPERATION_META: Record<OperationName, OperationMeta> = {
	"metrics.record": { description: "Records one metric observation.", effect: "local-write" },
	"metrics.record_batch": { description: "Records a bounded batch of metric observations as one atomic unit.", effect: "local-write" },
	"metrics.query": { description: "Queries recorded metric observations.", effect: "read" },
	"metrics.distinct_scopes": { description: "Lists distinct scopes recorded for a source within a bounded time window.", effect: "read" },
	"metrics.usage_series": { description: "Server-side bucketed usage aggregation for a source's distinct scopes.", effect: "read" },
	"metrics.cost_by_task": { description: "Sums cost/token metrics by focused task within a bounded time window.", effect: "read" },
	"metrics.prune": { description: "Deletes metric observations older than a cutoff. Irreversible.", effect: "destructive" },
	"benchmark.refresh": { description: "Refreshes model benchmark evidence from external sources.", effect: "external-write" },
	"benchmark.status": { description: "Reports the last benchmark refresh's own status.", effect: "read" },
	"benchmark.query": { description: "Queries cached benchmark evidence.", effect: "read" },
	"session.register": { description: "Registers a Pi session identity, issuing a session secret.", effect: "local-write" },
	"session.release": { description: "Releases a registered Pi session identity.", effect: "local-write" },
	"models.rank": {
		description: "Scores model candidates; an automatic selection also applies it as a router mutation.",
		effect: "local-write",
	},
	"context.assess": { description: "Assesses context-injection/compaction health within a bounded time window.", effect: "read" },
	"compaction.estimate": { description: "Estimates compaction duration from recorded samples.", effect: "read" },
	"service.checkpoint": { description: "Flushes the metric store's write-ahead log.", effect: "local-write" },
	"telemetry.poll": { description: "Polls external telemetry provider status.", effect: "read" },
	"router.status": { description: "Reports the router's current status.", effect: "read" },
	"router.decide": { description: "Computes the router's current policy decision without applying it.", effect: "read" },
	"router.pause": { description: "Pauses automatic routing.", effect: "local-write" },
	"router.resume": { description: "Resumes automatic routing.", effect: "local-write" },
	"router.override": { description: "Sets a time-bounded manual route override.", effect: "local-write" },
	"router.clear_override": { description: "Clears a manual route override.", effect: "local-write" },
	"router.current_route": { description: "Sets the router's currently-active route.", effect: "local-write" },
	"router.available_routes": { description: "Sets the router's currently-available routes.", effect: "local-write" },
};

/** Read effects need only jittor:read; every other effect needs both (writes commonly also read first). */
function permissionsFor(effect: VehicleEffect): readonly string[] {
	return effect === "read" ? ["jittor:read"] : ["jittor:read", "jittor:write"];
}

export function registerJittorVehicleOperations(registry: VehicleRegistry, operations: OperationHandlerMap): void {
	for (const [name, meta] of Object.entries(OPERATION_META) as Array<[OperationName, OperationMeta]>) {
		const handler = operations[name];
		if (!handler) throw new Error(`jittor Vehicle registration: no handler configured for operation "${name}"`);
		const operation = defineVehicleOperation({
			name,
			version: 1,
			description: meta.description,
			input: passthroughVehicleSchema,
			output: passthroughVehicleSchema,
			permissions: permissionsFor(meta.effect),
			effect: meta.effect,
			idempotency: meta.effect === "read" ? READ : WRITE,
			limits: LIMITS,
		});
		registry.register(
			OWNER,
			bindVehicleOperation(
				operation,
				() => async (context) => withJittorErrorParity(() => handler(context.input as Record<string, unknown>)),
			),
		);
	}
}
