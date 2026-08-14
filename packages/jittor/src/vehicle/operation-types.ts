/** One capability module's contribution to the operation dispatch table: a bounded set of operation names, each backed by a handler that only needs the collaborators its own factory was given. */
export type OperationHandler = (input: Record<string, unknown>) => unknown | Promise<unknown>;
export type OperationHandlerMap = Partial<Record<string, OperationHandler>>;

/**
 * The full, exhaustive operation surface -- shared by service.ts (dispatch/typed execute) and
 * registration.ts (Vehicle projection) so neither module needs to import the other for this type.
 * Living here (not in either module) is what breaks the service.ts<->registration.ts circular
 * dependency: previously registration.ts `import type`-ed OperationName back from service.ts,
 * while service.ts value-imported registerJittorVehicleOperations from registration.ts.
 */
export const EXPECTED_OPERATION_NAMES = [
	"metrics.record",
	"metrics.record_batch",
	"metrics.query",
	"metrics.distinct_scopes",
	"metrics.usage_series",
	"metrics.cost_by_task",
	"metrics.prune",
	"benchmark.refresh",
	"benchmark.status",
	"benchmark.query",
	"catalog.refresh",
	"catalog.status",
	"catalog.query",
	"usage.import",
	"usage.import_status",
	"usage.import_cancel",
	"export.status",
	"export.flush",
	"session.register",
	"session.release",
	"models.rank",
	"context.assess",
	"context.delta",
	"context.snapshot",
	"compaction.estimate",
	"service.checkpoint",
	"telemetry.poll",
	"router.status",
	"router.decide",
	"router.pause",
	"router.resume",
	"router.override",
	"router.clear_override",
	"router.current_route",
	"router.available_routes",
	"cache.economics",
] as const;

export type OperationName = (typeof EXPECTED_OPERATION_NAMES)[number];
