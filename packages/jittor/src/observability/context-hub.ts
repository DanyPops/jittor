/**
 * Context Hub: Jittor's cross-extension context-window attribution. Two independent pieces:
 *
 * - The tool-schema ledger (computeToolSchemaLedger/toolLedgerSegment): exact, zero-cooperation
 *   attribution of tool-schema cost (name + description + parameters + guidelines) per owning
 *   extension, using Pi's own `sourceInfo` on every registered tool -- no other package needs to
 *   change for this to work.
 * - The shared contribution channel (validateContextContribution/contextContributionMetric): any
 *   extension can opt in and contribute one segment of the breakdown (e.g. Papyrus's rules/tasks
 *   segment) over `CONTEXT_HUB_CONTRIBUTION_CHANNEL`, the same shared-bus pattern already proven
 *   by papyrus.context-injection.v1, generalized to a human-readable producer name and a nested
 *   segment/item shape instead of one flat character count.
 */
import {
	CONTEXT_ESTIMATE_CHARACTERS_PER_TOKEN,
	CONTEXT_HUB_CONFIDENCE_TIERS,
	CONTEXT_HUB_CONTRIBUTION_MAX_AGE_MS,
	CONTEXT_HUB_CONTRIBUTION_SCHEMA,
	CONTEXT_HUB_ITEM_LABEL_MAX_CHARACTERS,
	CONTEXT_HUB_MAX_ITEM_DEPTH,
	CONTEXT_HUB_MAX_ITEMS_PER_SEGMENT,
	CONTEXT_HUB_PRODUCER_NAME_MAX_CHARACTERS,
	CONTEXT_HUB_SEGMENT_KEY_MAX_CHARACTERS,
	CONTEXT_HUB_SEGMENT_LABEL_MAX_CHARACTERS,
} from "../constants.ts";
import type { MetricObservation } from "./metric.ts";
import {
	type RequestTokenReconciliation,
	type TokenMeasurement,
	validateRequestTokenReconciliation,
	validateTokenMeasurement,
} from "./token-measurement.ts";

export type ContextConfidenceTier = (typeof CONTEXT_HUB_CONFIDENCE_TIERS)[number];

export interface ContextSegmentItem {
	label: string;
	estimatedTokens: number;
	/** Explicit provenance for this item's own token count. Omitted only by legacy/cooperative producers that have not migrated yet. */
	measurement?: TokenMeasurement;
	/** Provider aggregate for the request associated with this entry, kept separate from this item's own cost. */
	requestTokenReconciliation?: RequestTokenReconciliation;
	children?: ContextSegmentItem[];
}

export interface ContextSegment {
	key: string;
	label: string;
	estimatedTokens: number;
	confidence: ContextConfidenceTier;
	items?: ContextSegmentItem[];
	/**
	 * True when this segment's size is genuinely unmeasured (not yet observed), as opposed to
	 * measured-and-actually-zero -- e.g. the base system prompt before the first observed turn.
	 * A display layer that hides zero-token rows to cut noise must NOT hide an unknown segment
	 * just because its placeholder value happens to be zero -- that would silently misrepresent
	 * "we don't know" as "there is nothing here".
	 */
	unknown?: boolean;
}

export interface ContextContribution {
	schema: typeof CONTEXT_HUB_CONTRIBUTION_SCHEMA;
	observedAt: number;
	sequence: number;
	producerName: string;
	segment: ContextSegment;
}

function nonEmptyString(value: unknown, name: string, maxLength: number): string {
	if (typeof value !== "string" || value.length === 0 || value.length > maxLength)
		throw new Error(`${name} must be a non-empty string of at most ${maxLength} characters`);
	return value;
}

function boundedInteger(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		throw new Error(`${name} must be a bounded non-negative integer`);
	return value;
}

function countItems(items: ContextSegmentItem[]): number {
	return items.reduce((sum, item) => sum + 1 + (item.children ? countItems(item.children) : 0), 0);
}

function validateSegmentItem(value: unknown, depth: number): ContextSegmentItem {
	if (depth > CONTEXT_HUB_MAX_ITEM_DEPTH) throw new Error(`context segment item nesting exceeds ${CONTEXT_HUB_MAX_ITEM_DEPTH} levels`);
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("context segment item must be an object");
	const input = value as Record<string, unknown>;
	for (const key of Object.keys(input)) {
		if (key !== "label" && key !== "estimatedTokens" && key !== "measurement" && key !== "requestTokenReconciliation" && key !== "children")
			throw new Error(`context segment item contains unexpected field: ${key}`);
	}
	const estimatedTokens = boundedInteger(input.estimatedTokens, "item.estimatedTokens");
	const measurement = input.measurement === undefined ? undefined : validateTokenMeasurement(input.measurement);
	if (measurement && measurement.tokens !== estimatedTokens) throw new Error("item measurement tokens must match item.estimatedTokens");
	const requestTokenReconciliation =
		input.requestTokenReconciliation === undefined ? undefined : validateRequestTokenReconciliation(input.requestTokenReconciliation);
	const item: ContextSegmentItem = {
		label: nonEmptyString(input.label, "item.label", CONTEXT_HUB_ITEM_LABEL_MAX_CHARACTERS),
		estimatedTokens,
		...(measurement ? { measurement } : {}),
		...(requestTokenReconciliation ? { requestTokenReconciliation } : {}),
	};
	if (input.children !== undefined) {
		if (!Array.isArray(input.children)) throw new Error("item.children must be an array");
		item.children = input.children.map((child) => validateSegmentItem(child, depth + 1));
	}
	return item;
}

/** Validates a bare segment (no contribution envelope) -- shared by validateContextContribution and Jittor's own directly-computed segments (tool ledger, base prompt, ...). */
export function validateContextSegment(value: unknown): ContextSegment {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("context segment must be an object");
	const input = value as Record<string, unknown>;
	for (const key of Object.keys(input)) {
		if (key !== "key" && key !== "label" && key !== "estimatedTokens" && key !== "confidence" && key !== "items" && key !== "unknown") {
			throw new Error(`context segment contains unexpected field: ${key}`);
		}
	}
	const confidence = input.confidence;
	if (typeof confidence !== "string" || !CONTEXT_HUB_CONFIDENCE_TIERS.includes(confidence as ContextConfidenceTier)) {
		throw new Error(`confidence must be one of ${CONTEXT_HUB_CONFIDENCE_TIERS.join(", ")}`);
	}
	if (input.unknown !== undefined && typeof input.unknown !== "boolean") throw new Error("segment.unknown must be a boolean");
	const segment: ContextSegment = {
		key: nonEmptyString(input.key, "segment.key", CONTEXT_HUB_SEGMENT_KEY_MAX_CHARACTERS),
		label: nonEmptyString(input.label, "segment.label", CONTEXT_HUB_SEGMENT_LABEL_MAX_CHARACTERS),
		estimatedTokens: boundedInteger(input.estimatedTokens, "segment.estimatedTokens"),
		confidence: confidence as ContextConfidenceTier,
		...(input.unknown !== undefined ? { unknown: input.unknown as boolean } : {}),
	};
	if (input.items !== undefined) {
		if (!Array.isArray(input.items)) throw new Error("segment.items must be an array");
		const items = input.items.map((item) => validateSegmentItem(item, 1));
		if (countItems(items) > CONTEXT_HUB_MAX_ITEMS_PER_SEGMENT)
			throw new Error(`segment.items exceeds ${CONTEXT_HUB_MAX_ITEMS_PER_SEGMENT} total items`);
		segment.items = items;
	}
	return segment;
}

const CONTRIBUTION_FIELDS = new Set(["schema", "observedAt", "sequence", "producerName", "segment"]);

/** Validates one contribution posted on CONTEXT_HUB_CONTRIBUTION_CHANNEL. Fails closed on schema drift or an oversized/malformed payload, the same posture as validatePapyrusContextInjection. */
export function validateContextContribution(value: unknown, now = Date.now()): ContextContribution {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("context contribution must be an object");
	const input = value as Record<string, unknown>;
	for (const key of Object.keys(input))
		if (!CONTRIBUTION_FIELDS.has(key)) throw new Error(`context contribution contains unexpected field: ${key}`);
	if (input.schema !== CONTEXT_HUB_CONTRIBUTION_SCHEMA) throw new Error("context contribution schema is not supported");
	const observedAt = boundedInteger(input.observedAt, "observedAt");
	if (Math.abs(now - observedAt) > CONTEXT_HUB_CONTRIBUTION_MAX_AGE_MS) throw new Error("context contribution is stale");
	return {
		schema: CONTEXT_HUB_CONTRIBUTION_SCHEMA,
		observedAt,
		sequence: boundedInteger(input.sequence, "sequence"),
		producerName: nonEmptyString(input.producerName, "producerName", CONTEXT_HUB_PRODUCER_NAME_MAX_CHARACTERS),
		segment: validateContextSegment(input.segment),
	};
}

/** Bounded, content-free metric projection for storage/history -- mirrors papyrusContextMetric's shape. */
export function contextContributionMetric(contribution: ContextContribution): MetricObservation {
	return {
		source: "context-hub",
		scope: contribution.producerName,
		metric: "segment-tokens",
		value: contribution.segment.estimatedTokens,
		unit: "count",
		observedAt: contribution.observedAt,
		attributes: {
			sequence: contribution.sequence,
			segmentKey: contribution.segment.key,
			segmentLabel: contribution.segment.label,
			confidence: contribution.segment.confidence,
			itemCount: contribution.segment.items ? countItems(contribution.segment.items) : 0,
		},
	};
}

/**
 * Exact, zero-cooperation attribution of tool-schema cost: every registered tool's `sourceInfo`
 * (populated by Pi's own resource loader from the extension that registered it, never guessed)
 * identifies its owning extension. Tool schemas are fixed overhead paid on every single turn
 * regardless of whether the tool is ever called, so this is the walking-skeleton signal --
 * buildable without any other package changing.
 */
export interface ToolLedgerEntry {
	name: string;
	description?: string;
	parameters?: unknown;
	promptGuidelines?: string[];
	promptSnippet?: string;
	sourceInfo?: { source?: string; path?: string };
}

export interface ToolLedgerToolUsage {
	name: string;
	characters: number;
	estimatedTokens: number;
}

export interface ToolLedgerSourceUsage {
	source: string;
	toolCount: number;
	characters: number;
	estimatedTokens: number;
	tools: ToolLedgerToolUsage[];
}

function toolCharacters(tool: ToolLedgerEntry): number {
	const parameterCharacters = tool.parameters === undefined ? 0 : JSON.stringify(tool.parameters).length;
	const guidelineCharacters = (tool.promptGuidelines ?? []).reduce((sum, guideline) => sum + guideline.length, 0);
	return tool.name.length + (tool.description?.length ?? 0) + parameterCharacters + guidelineCharacters + (tool.promptSnippet?.length ?? 0);
}

/** Groups every registered tool's serialized schema size by its owning extension (`sourceInfo.source`), sorted heaviest-first at both the source and tool level. A tool with no sourceInfo (e.g. an SDK-supplied custom tool) is grouped under "unknown" rather than dropped. */
export function computeToolSchemaLedger(tools: readonly ToolLedgerEntry[]): ToolLedgerSourceUsage[] {
	const bySource = new Map<string, ToolLedgerToolUsage[]>();
	for (const tool of tools) {
		const source = tool.sourceInfo?.source && tool.sourceInfo.source.length > 0 ? tool.sourceInfo.source : "unknown";
		const characters = toolCharacters(tool);
		const usage: ToolLedgerToolUsage = {
			name: tool.name,
			characters,
			estimatedTokens: Math.ceil(characters / CONTEXT_ESTIMATE_CHARACTERS_PER_TOKEN),
		};
		const existing = bySource.get(source);
		if (existing) existing.push(usage);
		else bySource.set(source, [usage]);
	}
	return [...bySource.entries()]
		.map(([source, toolUsages]) => {
			const sorted = [...toolUsages].sort((left, right) => right.characters - left.characters);
			return {
				source,
				toolCount: sorted.length,
				characters: sorted.reduce((sum, tool) => sum + tool.characters, 0),
				estimatedTokens: sorted.reduce((sum, tool) => sum + tool.estimatedTokens, 0),
				tools: sorted,
			};
		})
		.sort((left, right) => right.characters - left.characters);
}

/** Projects the tool-schema ledger into one ContextSegment (`toolDefinitions`), ready to merge alongside any contributed segment. */
export function toolLedgerSegment(tools: readonly ToolLedgerEntry[]): ContextSegment {
	const ledger = computeToolSchemaLedger(tools);
	const items: ContextSegmentItem[] = ledger.map((sourceUsage) => ({
		label: `${sourceUsage.source} (${sourceUsage.toolCount} tool${sourceUsage.toolCount === 1 ? "" : "s"})`,
		estimatedTokens: sourceUsage.estimatedTokens,
		children: sourceUsage.tools.map((tool) => ({ label: tool.name, estimatedTokens: tool.estimatedTokens })),
	}));
	return {
		key: "toolDefinitions",
		label: "Tool definitions",
		estimatedTokens: items.reduce((sum, item) => sum + item.estimatedTokens, 0),
		confidence: "exact-tool",
		items,
	};
}
