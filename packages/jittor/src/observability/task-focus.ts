import { PAPYRUS_TASK_FOCUS_SCHEMA, TASK_FOCUS_EVENT_MAX_AGE_MS, TASK_FOCUS_ID_MAX_LENGTH } from "../constants.ts";
import { type ModelTaskEffort, TASK_EFFORTS } from "./model-observation.ts";

export type TaskFocusStatus = "focused" | "paused" | "unpaused" | "cleared";

export interface TaskFocusEvent {
	schema: typeof PAPYRUS_TASK_FOCUS_SCHEMA;
	taskId: string | null;
	sessionId?: string;
	status: TaskFocusStatus;
	observedAt: number;
	/**
	 * Additive to the papyrus.task-focus/v1 schema: an older Jittor build predates this field, but
	 * since it's optional here (never required) and this validator only rejects a field it has
	 * never heard of, a coordinated same-session rollout across both packages is what keeps that
	 * safe -- see the recorded compatibility decision in the effort-aware Auto mode design Doc.
	 */
	effort?: ModelTaskEffort;
}

const TOP_LEVEL_FIELDS = new Set(["schema", "taskId", "sessionId", "status", "observedAt", "effort"]);
const STATUSES = new Set<string>(["focused", "paused", "unpaused", "cleared"]);

function record(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("task-focus event must be an object");
	const result = value as Record<string, unknown>;
	for (const key of Object.keys(result))
		if (!TOP_LEVEL_FIELDS.has(key)) throw new Error(`task-focus event contains unexpected field: ${key}`);
	return result;
}

function boundedId(value: unknown, name: string): string {
	if (typeof value !== "string" || value.length === 0 || value.length > TASK_FOCUS_ID_MAX_LENGTH)
		throw new Error(`${name} must be a non-empty bounded string`);
	return value;
}

/**
 * Validates the papyrus.task-focus.v1 shared-bus payload independently of whatever Papyrus itself
 * guarantees -- this is a cross-extension trust boundary, so Jittor never trusts an unvalidated
 * shape. Fails closed (throws) on schema drift, an unrecognized status, or a stale observation,
 * mirroring validatePapyrusContextInjection's pattern for the same reason: a malformed or
 * out-of-order cross-extension event must never silently corrupt Jittor's own state.
 */
export function validateTaskFocusEvent(value: unknown, now = Date.now()): TaskFocusEvent {
	const input = record(value);
	if (input.schema !== PAPYRUS_TASK_FOCUS_SCHEMA) throw new Error("task-focus event schema is not supported");
	const status = input.status;
	if (typeof status !== "string" || !STATUSES.has(status)) throw new Error("task-focus event status is not supported");
	const observedAt = input.observedAt;
	if (typeof observedAt !== "number" || !Number.isSafeInteger(observedAt) || observedAt < 0)
		throw new Error("task-focus event observedAt must be a non-negative integer");
	if (Math.abs(now - observedAt) > TASK_FOCUS_EVENT_MAX_AGE_MS) throw new Error("task-focus event is stale");
	const rawTaskId = input.taskId;
	const taskId = rawTaskId === null ? null : boundedId(rawTaskId, "taskId");
	if (taskId === null && status !== "cleared") throw new Error(`task-focus event of status "${status}" requires a taskId`);
	const rawSessionId = input.sessionId;
	const sessionId = rawSessionId === undefined ? undefined : boundedId(rawSessionId, "sessionId");
	const rawEffort = input.effort;
	if (rawEffort !== undefined && !TASK_EFFORTS.includes(rawEffort as ModelTaskEffort))
		throw new Error("task-focus event effort is invalid");
	return {
		schema: PAPYRUS_TASK_FOCUS_SCHEMA,
		taskId,
		status: status as TaskFocusStatus,
		observedAt,
		...(sessionId === undefined ? {} : { sessionId }),
		...(rawEffort === undefined ? {} : { effort: rawEffort as ModelTaskEffort }),
	};
}

/**
 * Applies a validated event to the currently tracked focused task id. "paused" and "cleared" both
 * mean "no task is actively being worked on right now" for cost-attribution purposes, even though
 * Papyrus itself keeps a paused task's focus state around for later resumption -- Jittor only
 * cares about whether to keep tagging new metrics, not about Papyrus's own pause bookkeeping.
 */
export function applyTaskFocusEvent(event: TaskFocusEvent): string | null {
	return event.status === "focused" || event.status === "unpaused" ? event.taskId : null;
}

/**
 * The task-effort analogue of applyTaskFocusEvent: a declared effort is a live "bind-beforehand"
 * routing prior only while its task is actually focused, using the identical focused/unpaused
 * vs. paused/cleared semantics -- a task that declared "high" while paused must not keep pinning
 * routing to "high" once it's no longer the thing being worked on.
 */
export function declaredEffortFromTaskFocusEvent(event: TaskFocusEvent): ModelTaskEffort | null {
	return (event.status === "focused" || event.status === "unpaused") && event.effort !== undefined ? event.effort : null;
}
