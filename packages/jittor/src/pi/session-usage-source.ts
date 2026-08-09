import { readdir, readFile, stat } from "node:fs/promises";
import {
	PI_USAGE_IMPORT_MAX_DURATION_MS,
	PI_USAGE_IMPORT_MAX_ENTRIES,
	PI_USAGE_IMPORT_MAX_FILE_BYTES,
	PI_USAGE_IMPORT_MAX_FILES,
	PI_USAGE_IMPORT_MAX_RECORDS,
	PI_USAGE_IMPORT_MAX_TOTAL_BYTES,
} from "../constants.ts";
import type { HistoricalUsageRecord, HistoricalUsageScan, HistoricalUsageSource } from "../observability/usage-import.ts";

interface SessionState {
	provider: string | null;
	model: string | null;
	thinking: string | null;
}

async function opaqueIdentity(...parts: string[]): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts.join("\0")));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function object(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function nonnegativeInteger(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function nonnegativeNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function safeIdentity(value: unknown): string | null {
	if (typeof value !== "string" || value.length < 1 || value.length > 200 || /\p{Cc}/u.test(value)) return null;
	return value;
}

function timestamp(entry: Record<string, unknown>, message?: Record<string, unknown>): number | null {
	const messageTime = message?.timestamp;
	if (typeof messageTime === "number" && Number.isSafeInteger(messageTime) && messageTime >= 0) return messageTime;
	if (typeof entry.timestamp !== "string") return null;
	const value = Date.parse(entry.timestamp);
	return Number.isFinite(value) && value >= 0 ? value : null;
}

function usageRecord(
	usageValue: unknown,
	entry: Record<string, unknown>,
	state: SessionState,
	sessionId: string,
	entryId: string,
	message?: Record<string, unknown>,
): Promise<HistoricalUsageRecord | null> | null {
	const usage = object(usageValue);
	const provider = safeIdentity(message?.provider) ?? state.provider;
	const model = safeIdentity(message?.model) ?? state.model;
	const observedAt = timestamp(entry, message);
	if (!usage || !provider || !model || observedAt === null) return null;
	const inputTokens = nonnegativeInteger(usage.input);
	const outputTokens = nonnegativeInteger(usage.output);
	const cacheReadTokens = nonnegativeInteger(usage.cacheRead);
	const cacheWriteTokens = nonnegativeInteger(usage.cacheWrite);
	const cost = object(usage.cost);
	const costUsd = nonnegativeNumber(cost?.total);
	if (inputTokens === null || outputTokens === null || cacheReadTokens === null || cacheWriteTokens === null || costUsd === null)
		return null;
	return opaqueIdentity(sessionId, entryId).then((identity) => ({
		identity,
		observedAt,
		provider,
		model,
		thinking: state.thinking,
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		costUsd,
	}));
}

export interface PiSessionUsageSourceOptions {
	maxFiles?: number;
	maxFileBytes?: number;
	maxTotalBytes?: number;
	maxEntries?: number;
	maxRecords?: number;
	maxDurationMs?: number;
	clock?: () => number;
}

/** Reads Pi's documented v1-v3 JSONL session format and immediately discards all content fields. */
export class PiSessionUsageSource implements HistoricalUsageSource {
	private readonly options: Required<PiSessionUsageSourceOptions>;

	constructor(
		private readonly sessionsRoot: string,
		options: PiSessionUsageSourceOptions = {},
	) {
		this.options = {
			maxFiles: options.maxFiles ?? PI_USAGE_IMPORT_MAX_FILES,
			maxFileBytes: options.maxFileBytes ?? PI_USAGE_IMPORT_MAX_FILE_BYTES,
			maxTotalBytes: options.maxTotalBytes ?? PI_USAGE_IMPORT_MAX_TOTAL_BYTES,
			maxEntries: options.maxEntries ?? PI_USAGE_IMPORT_MAX_ENTRIES,
			maxRecords: options.maxRecords ?? PI_USAGE_IMPORT_MAX_RECORDS,
			maxDurationMs: options.maxDurationMs ?? PI_USAGE_IMPORT_MAX_DURATION_MS,
			clock: options.clock ?? Date.now,
		};
	}

	async scan(canceled: () => boolean): Promise<HistoricalUsageScan> {
		const startedAt = this.options.clock();
		let names: string[];
		try {
			names = (await readdir(this.sessionsRoot, { recursive: true, encoding: "utf8" })).filter((name) => name.endsWith(".jsonl")).sort();
		} catch {
			names = [];
		}
		const records: HistoricalUsageRecord[] = [];
		let filesScanned = 0;
		let entriesScanned = 0;
		let bytesScanned = 0;
		let malformedEntries = 0;
		let truncated = names.length > this.options.maxFiles;
		let cursor: string | null = null;
		for (const name of names.slice(0, this.options.maxFiles)) {
			if (canceled() || this.options.clock() - startedAt > this.options.maxDurationMs) {
				truncated = true;
				break;
			}
			const path = `${this.sessionsRoot}/${name}`;
			const size = (await stat(path)).size;
			if (size > this.options.maxFileBytes || bytesScanned + size > this.options.maxTotalBytes) {
				truncated = true;
				continue;
			}
			const lines = (await readFile(path, "utf8")).split("\n");
			bytesScanned += size;
			filesScanned += 1;
			let sessionId: string | null = null;
			const stateById = new Map<string | null, SessionState>([[null, { provider: null, model: null, thinking: null }]]);
			for (const line of lines) {
				if (line.trim().length === 0) continue;
				if (entriesScanned >= this.options.maxEntries || records.length >= this.options.maxRecords || canceled()) {
					truncated = true;
					break;
				}
				entriesScanned += 1;
				let entry: Record<string, unknown> | null;
				try {
					entry = object(JSON.parse(line));
				} catch {
					entry = null;
				}
				if (!entry) {
					malformedEntries += 1;
					continue;
				}
				if (entry.type === "session") {
					sessionId = safeIdentity(entry.id);
					if (sessionId) cursor = await opaqueIdentity(sessionId);
					continue;
				}
				const entryId = safeIdentity(entry.id);
				const parentId = entry.parentId === null ? null : safeIdentity(entry.parentId);
				if (!sessionId || !entryId || (entry.parentId !== null && parentId === null)) {
					malformedEntries += 1;
					continue;
				}
				const inherited = stateById.get(parentId) ?? { provider: null, model: null, thinking: null };
				const state = { ...inherited };
				if (entry.type === "model_change") {
					state.provider = safeIdentity(entry.provider);
					state.model = safeIdentity(entry.modelId);
				} else if (entry.type === "thinking_level_change") state.thinking = safeIdentity(entry.thinkingLevel);
				stateById.set(entryId, state);
				const message = entry.type === "message" ? object(entry.message) : undefined;
				const candidate =
					message?.role === "assistant"
						? usageRecord(message.usage, entry, state, sessionId, entryId, message)
						: entry.type === "compaction" || entry.type === "branch_summary"
							? usageRecord(entry.usage, entry, state, sessionId, entryId)
							: null;
				if (candidate) {
					const resolved = await candidate;
					if (resolved) records.push(resolved);
				}
			}
			if (truncated) break;
		}
		return {
			records,
			filesScanned,
			entriesScanned,
			bytesScanned,
			malformedEntries,
			truncated,
			canceled: canceled(),
			cursor,
		};
	}
}
