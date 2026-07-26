/** One capability module's contribution to the operation dispatch table: a bounded set of operation names, each backed by a handler that only needs the collaborators its own factory was given. */
export type OperationHandler = (input: Record<string, unknown>) => unknown | Promise<unknown>;
export type OperationHandlerMap = Partial<Record<string, OperationHandler>>;
