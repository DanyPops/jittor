import {
	CONTEXT_SNAPSHOT_MAX_SEGMENTS,
	type ContextFingerprinter,
	type ContextSegmentSource,
	type ContextSnapshot,
	countTextWithFallback,
	StructuralTextTokenCounter,
	type TextTokenCounter,
	validateContextSnapshot,
} from "@danypops/jittor";

const CANONICAL_MAX_DEPTH = 16;
const CANONICAL_MAX_NODES = 10_000;
const CANONICAL_MAX_STRING_CHARACTERS = 65_536;
const CANONICAL_MAX_COLLECTION_ITEMS = 256;

export interface ProviderContextHistoryEntry {
	id: string;
	type: string;
	message?: unknown;
	summary?: string;
}

export interface ProviderContextHistoryNode {
	entry: ProviderContextHistoryEntry;
	children: ProviderContextHistoryNode[];
}

export interface ProviderContextHistory {
	roots: readonly ProviderContextHistoryNode[];
	/** Pi buildContextEntries(): compaction-aware entries that contribute to the request now. */
	activeEntryIds: ReadonlySet<string>;
	/** Pi getBranch(): raw current branch, including entries summarized away by compaction. */
	branchEntryIds: ReadonlySet<string>;
}

export interface ProviderContextSnapshotInput {
	/** Final provider payload. Ephemeral: this function returns only keyed fingerprints and sizes. */
	payload: unknown;
	captureId: string;
	sessionId: string;
	provider: string;
	model: string;
	capturedAt: number;
	fingerprinter: ContextFingerprinter;
	counters?: readonly TextTokenCounter[];
	history?: ProviderContextHistory;
}

interface CanonicalValue {
	text: string;
	truncated: boolean;
}

interface CanonicalState {
	nodes: number;
	truncated: boolean;
	seen: WeakSet<object>;
}

function boundedString(value: string, state: CanonicalState): string {
	if (value.length <= CANONICAL_MAX_STRING_CHARACTERS) return JSON.stringify(value);
	state.truncated = true;
	const half = Math.floor(CANONICAL_MAX_STRING_CHARACTERS / 2);
	return JSON.stringify(`${value.slice(0, half)}…[${value.length} chars]…${value.slice(-half)}`);
}

function canonical(value: unknown, depth: number, state: CanonicalState): string {
	state.nodes += 1;
	if (state.nodes > CANONICAL_MAX_NODES || depth > CANONICAL_MAX_DEPTH) {
		state.truncated = true;
		return '"[bounded]"';
	}
	if (value === null) return "null";
	if (typeof value === "string") return boundedString(value, state);
	if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : '"[non-finite]"';
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "bigint") return JSON.stringify(`${value.toString()}n`);
	if (typeof value !== "object") return JSON.stringify(`[${typeof value}]`);
	if (state.seen.has(value)) {
		state.truncated = true;
		return '"[cycle]"';
	}
	state.seen.add(value);
	try {
		if (Array.isArray(value)) {
			if (value.length > CANONICAL_MAX_COLLECTION_ITEMS) state.truncated = true;
			const shown = value.slice(0, CANONICAL_MAX_COLLECTION_ITEMS).map((item) => canonical(item, depth + 1, state));
			if (value.length > shown.length) shown.push(JSON.stringify(`[${value.length - shown.length} omitted]`));
			return `[${shown.join(",")}]`;
		}
		const record = value as Record<string, unknown>;
		const keys = Object.keys(record).sort();
		if (keys.length > CANONICAL_MAX_COLLECTION_ITEMS) state.truncated = true;
		const shown = keys
			.slice(0, CANONICAL_MAX_COLLECTION_ITEMS)
			.map((key) => `${JSON.stringify(key)}:${canonical(record[key], depth + 1, state)}`);
		if (keys.length > shown.length) shown.push(`${JSON.stringify("[omitted]")}:${keys.length - shown.length}`);
		return `{${shown.join(",")}}`;
	} finally {
		state.seen.delete(value);
	}
}

function boundedCanonical(value: unknown): CanonicalValue {
	const state: CanonicalState = { nodes: 0, truncated: false, seen: new WeakSet() };
	return { text: canonical(value, 0, state), truncated: state.truncated };
}

function objectRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function blockSource(block: unknown, role: unknown): ContextSegmentSource {
	if (role === "tool" || role === "function") return "tool-result";
	const record = objectRecord(block);
	const type = typeof record?.type === "string" ? record.type.toLowerCase() : "";
	if (type.includes("thinking") || type.includes("reasoning")) return "thinking";
	if (type.includes("tool_result") || type.includes("tool-result") || type.includes("function_call_output")) return "tool-result";
	if (type.includes("tool_use") || type.includes("tool-use") || type.includes("function_call")) return "tool-call";
	if (role === "system" || role === "developer") return "base-prompt";
	return "conversation-message";
}

function imageLike(value: unknown): boolean {
	const record = objectRecord(value);
	if (!record || typeof record.type !== "string") return false;
	return record.type.toLowerCase().includes("image");
}

/**
 * Extracts an ordered, provider-neutral structural view from common chat/responses payload shapes.
 * Unknown shapes remain one conversation segment; the payload is never returned or retained.
 */
export function captureProviderContextSnapshot(input: ProviderContextSnapshotInput): ContextSnapshot {
	const segments: ContextSnapshot["segments"] = [];
	let truncated = false;
	const fallback = new StructuralTextTokenCounter();
	const push = (
		value: unknown,
		source: ContextSegmentSource,
		logicalPath: string,
		state: ContextSnapshot["segments"][number]["state"] = "active",
	): void => {
		if (segments.length >= CONTEXT_SNAPSHOT_MAX_SEGMENTS) {
			truncated = true;
			return;
		}
		const encoded = boundedCanonical(value);
		truncated ||= encoded.truncated;
		const measurement = imageLike(value)
			? null
			: countTextWithFallback(
					{ text: encoded.text, scope: "context-item", provider: input.provider, model: input.model },
					input.counters ?? [],
					fallback,
				);
		segments.push({
			id: input.fingerprinter.fingerprint(`segment:${source}:${logicalPath}`),
			fingerprint: input.fingerprinter.fingerprint(`value:${encoded.text}`),
			source,
			tokens: measurement?.tokens ?? 0,
			state,
			requestPosition: state === "active" ? segments.filter((segment) => segment.requestPosition !== null).length : null,
		});
	};

	const payload = objectRecord(input.payload);
	if (!payload) {
		push(input.payload, "conversation-message", "payload");
	} else {
		for (const key of ["instructions", "system", "system_instruction"] as const) {
			if (payload[key] !== undefined) push(payload[key], "base-prompt", key);
		}
		const tools = Array.isArray(payload.tools) ? payload.tools : Array.isArray(payload.functions) ? payload.functions : [];
		for (let index = 0; index < tools.length; index++) push(tools[index], "tool-definitions", `tools/${index}`);

		const conversation = Array.isArray(payload.messages)
			? payload.messages
			: Array.isArray(payload.input)
				? payload.input
				: Array.isArray(payload.contents)
					? payload.contents
					: payload.input === undefined
						? []
						: [payload.input];
		for (let messageIndex = 0; messageIndex < conversation.length; messageIndex++) {
			const message = conversation[messageIndex];
			const record = objectRecord(message);
			const role = record?.role;
			const content = record?.content ?? record?.parts;
			if (Array.isArray(content)) {
				for (let blockIndex = 0; blockIndex < content.length; blockIndex++) {
					push(content[blockIndex], blockSource(content[blockIndex], role), `messages/${messageIndex}/content/${blockIndex}`);
				}
			} else if (content !== undefined) {
				push(content, blockSource(message, role), `messages/${messageIndex}/content`);
			} else {
				push(message, blockSource(message, role), `messages/${messageIndex}`);
			}
		}
	}

	if (input.history) {
		const visited = new Set<string>();
		const stack = [...input.history.roots].reverse();
		while (stack.length > 0) {
			if (segments.length >= CONTEXT_SNAPSHOT_MAX_SEGMENTS) {
				truncated = true;
				break;
			}
			const node = stack.pop()!;
			if (visited.has(node.entry.id)) {
				truncated = true;
				continue;
			}
			visited.add(node.entry.id);
			stack.push(...[...node.children].reverse());
			if (input.history.activeEntryIds.has(node.entry.id)) continue;
			const state = input.history.branchEntryIds.has(node.entry.id) ? "compacted" : "inactive";
			const message = objectRecord(node.entry.message);
			const role = message?.role;
			const content = message?.content ?? message?.parts;
			if (Array.isArray(content)) {
				for (let index = 0; index < content.length; index++)
					push(content[index], blockSource(content[index], role), `history/${node.entry.id}/${index}`, state);
			} else if (content !== undefined) {
				push(content, blockSource(node.entry.message, role), `history/${node.entry.id}`, state);
			} else if (node.entry.summary !== undefined) {
				push(node.entry.summary, "conversation-message", `history/${node.entry.id}/summary`, state);
			}
		}
		if (stack.length > 0) truncated = true;
	}

	return validateContextSnapshot({
		version: 1,
		snapshotId: input.fingerprinter.fingerprint(`snapshot:${input.sessionId}:${input.captureId}`),
		sessionId: input.fingerprinter.fingerprint(`session:${input.sessionId}`),
		provider: input.provider,
		model: input.model,
		capturedAt: input.capturedAt,
		truncated,
		segments,
	});
}
