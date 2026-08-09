import {
	CONTEXT_DEFAULT_RESERVE_TOKENS,
	CONTEXT_ESTIMATE_CHARACTERS_PER_TOKEN,
	CONTEXT_TREE_MAX_NODES,
	type ContextSegment,
	type ContextSegmentItem,
} from "@danypops/jittor";
import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";

/**
 * Ported from pi-papyrus's context-budget.ts: the Pi-generic half (session message-history tree
 * walk, base-prompt structural breakdown, and the known-segments-vs-real-total composer) that
 * has nothing to do with Papyrus's own artifacts. Papyrus's rules/tasks segments stay in
 * pi-papyrus, contributed to this same breakdown over CONTEXT_HUB_CONTRIBUTION_CHANNEL instead
 * of being computed here.
 */

/**
 * Session entries and tree nodes as SessionManager exposes them (docs/session-format.md,
 * SessionTreeNode from @earendil-works/pi-coding-agent): a subset covering only the fields
 * this estimate reads, so this stays testable with plain object literals instead of
 * importing pi's own session types.
 */
export interface SessionEntryLike {
	id: string;
	type: string;
	message?: unknown;
	summary?: string;
}
export interface SessionTreeNodeLike {
	entry: SessionEntryLike;
	children: SessionTreeNodeLike[];
}

interface MessageContentAnalysis {
	characters: number;
	items: ContextSegmentItem[];
	imageCount: number;
}

function measuredItem(label: string, characters: number): ContextSegmentItem {
	return { label: `${label} · ${characters.toLocaleString()} chars (≈ char/4)`, estimatedTokens: toCeilTokens(characters) };
}

/** Breaks a message into the public content fields Pi actually persists. These are structural char/4 estimates, not tokenizer-exact costs. */
function analyzeMessageContent(message: unknown): MessageContentAnalysis {
	if (typeof message !== "object" || message === null) return { characters: 0, items: [], imageCount: 0 };
	const record = message as Record<string, unknown>;
	if (record.role === "bashExecution") {
		// Pi's own context builder excludes "!!"-prefixed bash output from context; match that.
		if (record.excludeFromContext === true) return { characters: 0, items: [], imageCount: 0 };
		const command = String(record.command ?? "");
		const output = String(record.output ?? "");
		return {
			characters: command.length + output.length,
			items: [measuredItem("command", command.length), measuredItem("output", output.length)].filter((item) => item.estimatedTokens > 0),
			imageCount: 0,
		};
	}
	const content = record.content;
	if (typeof content === "string") return { characters: content.length, items: [measuredItem("text", content.length)], imageCount: 0 };
	if (!Array.isArray(content)) return { characters: 0, items: [], imageCount: 0 };
	let characters = 0;
	let imageCount = 0;
	const items: ContextSegmentItem[] = [];
	for (let index = 0; index < content.length; index++) {
		const block = content[index];
		if (typeof block !== "object" || block === null) continue;
		const b = block as Record<string, unknown>;
		let blockCharacters = 0;
		let label = `block ${index + 1}`;
		if (b.type === "text") {
			blockCharacters = String(b.text ?? "").length;
			label = "text";
		} else if (b.type === "thinking") {
			blockCharacters = String(b.thinking ?? "").length;
			label = "thinking";
		} else if (b.type === "toolCall") {
			blockCharacters = JSON.stringify(b.arguments ?? {}).length;
			label = `tool call ${String(b.name ?? "(unknown)")} arguments`;
		} else if (b.type === "image") {
			imageCount += 1;
			continue; // image tokens are provider/model-specific and cannot be derived from base64 characters
		} else continue;
		characters += blockCharacters;
		if (blockCharacters > 0) items.push(measuredItem(label, blockCharacters));
	}
	return { characters, items, imageCount };
}

function messageSnippet(message: unknown, maxLength = 48): string {
	if (typeof message !== "object" || message === null) return "";
	const record = message as Record<string, unknown>;
	if (record.role === "bashExecution") return String(record.command ?? "");
	const content = record.content;
	const text =
		typeof content === "string"
			? content
			: Array.isArray(content)
				? content
						.map((block) =>
							typeof block === "object" && block !== null && (block as Record<string, unknown>).type === "text"
								? String((block as Record<string, unknown>).text ?? "")
								: "",
						)
						.join(" ")
				: "";
	const collapsed = text.replace(/\s+/g, " ").trim();
	return collapsed.length > maxLength ? `${collapsed.slice(0, maxLength - 1)}…` : collapsed;
}

function providerPromptUsage(message: unknown): string {
	if (typeof message !== "object" || message === null) return "";
	const usage = (message as Record<string, unknown>).usage;
	if (typeof usage !== "object" || usage === null) return "";
	const record = usage as Record<string, unknown>;
	const input = typeof record.input === "number" && record.input >= 0 ? record.input : 0;
	const cacheRead = typeof record.cacheRead === "number" && record.cacheRead >= 0 ? record.cacheRead : 0;
	const cacheWrite = typeof record.cacheWrite === "number" && record.cacheWrite >= 0 ? record.cacheWrite : 0;
	const promptTokens = input + cacheRead + cacheWrite;
	if (promptTokens <= 0) return "";
	const cache =
		cacheRead > 0 || cacheWrite > 0
			? `; new ${input.toLocaleString()}, cache read ${cacheRead.toLocaleString()}, write ${cacheWrite.toLocaleString()}`
			: "";
	return ` · provider-reported request context ${promptTokens.toLocaleString()} tok${cache}`;
}

function entryLabel(entry: SessionEntryLike, imageCount = 0): string {
	if (entry.type === "compaction") return "compaction summary";
	if (entry.type === "branch_summary") return "branch summary";
	const role = typeof entry.message === "object" && entry.message !== null ? (entry.message as Record<string, unknown>).role : undefined;
	const prefix = typeof role === "string" ? role : entry.type;
	const snippet = messageSnippet(entry.message);
	const images = imageCount > 0 ? ` · ${imageCount} image${imageCount === 1 ? "" : "s"} (token cost unavailable)` : "";
	return `${snippet ? `${prefix}: ${snippet}` : prefix}${providerPromptUsage(entry.message)}${images}`;
}

export interface MessageHistoryTree {
	/** One item per real tree root (ordinarily one, the session's first entry). */
	items: ContextSegmentItem[];
	/** Sum of tokens for entries on the CURRENT active path only -- what actually feeds the LLM's context right now, unlike content sitting in an abandoned /tree branch. */
	activeTokens: number;
	/** True if the walk hit CONTEXT_TREE_MAX_NODES or found a cycle -- the tree shown is a bounded prefix, not necessarily the complete session. */
	truncated: boolean;
}

interface WalkFrame {
	node: SessionTreeNodeLike;
	parentIndex: number | null;
}

/**
 * Walks Pi's own real session tree (ctx.sessionManager.getTree(), docs/session-format.md --
 * entries form a genuine tree via id/parentId, not just the linear current-branch path) to
 * estimate the conversation's context contribution AND surface branches explored via /tree
 * that are no longer on the active path -- content that cost real tokens to generate but is
 * NOT currently part of the context window. Bounded and cycle-safe (CONTEXT_TREE_MAX_NODES).
 *
 * `activeEntryIds` MUST come from ctx.sessionManager.buildContextEntries(), not getBranch().
 * getBranch()'s own docstring says it "[i]ncludes all entry types... Use buildSessionContext()
 * to get the resolved messages for the LLM" -- it does not skip entries a real compaction has
 * already summarized away; using it here would overcount activeTokens for any session that has
 * been compacted at all. buildContextEntries() is Pi's own compaction-aware entry list: the
 * latest compaction entry, its kept entries from firstKeptEntryId onward, and everything after.
 *
 * `branchEntryIds` (optional) is the full raw current-path id set (getBranch()'s own output).
 * When given, an entry on the branch path but excluded from activeEntryIds is labeled
 * "(compacted)" rather than the less accurate "(inactive branch)", which is reserved for
 * entries not on the current path at all (a genuinely abandoned /tree branch). Omitting it
 * preserves the simpler binary active/inactive-branch labeling for callers that only have one
 * set to give (e.g. tests).
 *
 * Iterative (not recursive) two-pass walk: an explicit-stack pre-order discovery pass followed
 * by a reverse-order (children-before-parent) construction pass -- an ordinary long-running
 * session is one long linear chain, so recursion depth would equal entry count.
 */
export function buildMessageHistoryTree(
	roots: ReadonlyArray<SessionTreeNodeLike>,
	activeEntryIds: ReadonlySet<string>,
	branchEntryIds?: ReadonlySet<string>,
): MessageHistoryTree {
	const visited = new Set<string>();
	let truncated = false;
	let activeTokens = 0;

	const order: WalkFrame[] = [];
	const stack: WalkFrame[] = [...roots].reverse().map((root) => ({ node: root, parentIndex: null }));
	while (stack.length > 0) {
		const frame = stack.pop()!;
		if (order.length >= CONTEXT_TREE_MAX_NODES) {
			truncated = true;
			break;
		}
		if (visited.has(frame.node.entry.id)) {
			truncated = true;
			continue;
		} // cycle guard
		visited.add(frame.node.entry.id);
		const index = order.length;
		order.push(frame);
		const children = [...frame.node.children].reverse().map((child) => ({ node: child, parentIndex: index }));
		stack.push(...children);
	}
	if (stack.length > 0) truncated = true; // node bound hit with more work still queued

	const childItemsByParent = new Map<number, ContextSegmentItem[]>();
	const itemByIndex = new Map<number, ContextSegmentItem>();
	for (let index = order.length - 1; index >= 0; index--) {
		const frame = order[index]!;
		const entry = frame.node.entry;
		const analysis = entry.type === "message" ? analyzeMessageContent(entry.message) : { characters: 0, items: [], imageCount: 0 };
		const characters =
			entry.type === "message"
				? analysis.characters
				: entry.type === "compaction" || entry.type === "branch_summary"
					? (entry.summary ?? "").length
					: 0;
		const tokens = Math.ceil(characters / CONTEXT_ESTIMATE_CHARACTERS_PER_TOKEN);
		const isActive = activeEntryIds.has(entry.id);
		if (isActive) activeTokens += tokens;
		const isOnBranch = branchEntryIds ? branchEntryIds.has(entry.id) : isActive; // no branch set given -- fall back to the old binary active/inactive-branch label

		const treeChildren = childItemsByParent.get(index) ?? [];
		const contentChildren = analysis.items;
		const children = [...contentChildren, ...treeChildren];
		if (tokens === 0 && children.length === 0 && analysis.imageCount === 0) continue; // no content, no descendants, and no unknown-cost image -- nothing to show

		const label = entryLabel(entry, analysis.imageCount);
		const item: ContextSegmentItem = {
			label: isActive ? label : isOnBranch ? `${label} (compacted)` : `${label} (inactive branch)`,
			estimatedTokens: tokens,
			...(children.length > 0 ? { children } : {}),
		};
		itemByIndex.set(index, item);
		if (frame.parentIndex !== null) {
			const siblings = childItemsByParent.get(frame.parentIndex) ?? [];
			siblings.unshift(item); // reverse-order processing -- unshift restores original document order
			childItemsByParent.set(frame.parentIndex, siblings);
		}
	}

	const items: ContextSegmentItem[] = [];
	for (let index = 0; index < order.length; index++) {
		if (order[index]!.parentIndex === null) {
			const item = itemByIndex.get(index);
			if (item) items.push(item);
		}
	}
	return { items, activeTokens, truncated };
}

function toCeilTokens(characters: number): number {
	return Math.ceil(characters / CONTEXT_ESTIMATE_CHARACTERS_PER_TOKEN);
}

/**
 * Splits Pi's base system prompt into real structural sub-segments instead of one opaque
 * number, using BeforeAgentStartEvent's own systemPromptOptions field -- Pi's own doc comment
 * on it: "Extensions can inspect this to understand what Pi loaded without re-discovering
 * resources." No new hook, no new risk: before_agent_start is already wired.
 *
 * Deliberately measures each INPUT's raw content size (tool snippet text, skill metadata,
 * context file content) rather than attempting to byte-for-byte reproduce Pi's internal
 * wrapping/tag format -- buildSystemPrompt() and formatSkillsForPrompt() are Pi-internal
 * functions, not part of the public extension API. The remainder item absorbs whatever
 * wrapping/template text this doesn't attribute, so the segment's total always still matches
 * the real observed prompt length exactly.
 *
 * Measured as of THIS extension's own before_agent_start handler, which runs at whatever point
 * Pi's own extension-load order places it in the before_agent_start chain -- an earlier
 * extension's own systemPrompt mutation (e.g. an injected Rules/Tasks block) is already baked
 * into event.systemPrompt by the time a later handler sees it. There is no per-handler identity
 * in Pi's event payload to detect this, so this measurement is only as "pure Pi base prompt" as
 * this extension's actual position in the load order happens to make it -- a real, documented
 * limitation, not a promise.
 */
export function buildBasePromptItems(options: BuildSystemPromptOptions, totalCharacters: number): ContextSegmentItem[] {
	const items: ContextSegmentItem[] = [];

	const toolSnippetEntries = Object.entries(options.toolSnippets ?? {});
	// Mirrors buildSystemPrompt()'s own "- name: snippet\n" line shape closely enough to be a
	// fair estimate without importing Pi-internal formatting code.
	const toolSnippetDetails = toolSnippetEntries.map(([name, snippet]) => measuredItem(name, name.length + snippet.length + 4));
	const toolSnippetsCharacters = toolSnippetEntries.reduce((sum, [name, snippet]) => sum + name.length + snippet.length + 4, 0);
	if (toolSnippetsCharacters > 0) {
		items.push({
			label: `Tool snippets (${toolSnippetEntries.length} tools)`,
			estimatedTokens: toCeilTokens(toolSnippetsCharacters),
			children: toolSnippetDetails,
		});
	}

	const visibleSkills = (options.skills ?? []).filter((skill) => !skill.disableModelInvocation);
	const skillsCharacters = visibleSkills.reduce(
		(sum, skill) => sum + skill.name.length + skill.description.length + skill.filePath.length + 20,
		0,
	);
	if (skillsCharacters > 0) {
		items.push({
			label: `Skills catalog (${visibleSkills.length} skills)`,
			estimatedTokens: toCeilTokens(skillsCharacters),
			children: visibleSkills.map((skill) =>
				measuredItem(skill.name, skill.name.length + skill.description.length + skill.filePath.length + 20),
			),
		});
	}

	const contextFiles = options.contextFiles ?? [];
	const contextFilesCharacters = contextFiles.reduce((sum, file) => sum + file.path.length + file.content.length + 40, 0);
	if (contextFilesCharacters > 0) {
		items.push({
			label: `Project context files (${contextFiles.length}, e.g. AGENTS.md)`,
			estimatedTokens: toCeilTokens(contextFilesCharacters),
			children: contextFiles.map((file) => measuredItem(file.path, file.path.length + file.content.length + 40)),
		});
	}

	const promptGuidelines = options.promptGuidelines ?? [];
	const promptGuidelinesCharacters = promptGuidelines.reduce((sum, guideline) => sum + guideline.length + 2, 0);
	if (promptGuidelinesCharacters > 0) {
		items.push({
			label: `Tool guidelines (${promptGuidelines.length})`,
			estimatedTokens: toCeilTokens(promptGuidelinesCharacters),
			children: promptGuidelines.map((guideline, index) => measuredItem(`guideline ${index + 1}`, guideline.length + 2)),
		});
	}

	const customPromptCharacters = options.customPrompt?.length ?? 0;
	if (customPromptCharacters > 0) items.push(measuredItem("Custom system prompt", customPromptCharacters));
	const appendedPromptCharacters = options.appendSystemPrompt?.length ?? 0;
	if (appendedPromptCharacters > 0) items.push(measuredItem("Appended system prompt", appendedPromptCharacters));

	const knownCharacters =
		toolSnippetsCharacters +
		skillsCharacters +
		contextFilesCharacters +
		promptGuidelinesCharacters +
		customPromptCharacters +
		appendedPromptCharacters;
	const remainderCharacters = Math.max(0, totalCharacters - knownCharacters);
	if (remainderCharacters > 0 || items.length === 0) {
		items.push({ label: "Base template, guidelines, and formatting", estimatedTokens: toCeilTokens(remainderCharacters) });
	}

	return items;
}

/** Wraps a cached before_agent_start observation into the basePrompt ContextSegment -- `unknown` before any turn has run yet, so a display layer never mistakes "not observed yet" for "measured and empty". */
export function basePromptSegment(estimatedTokens: number | null, items: ContextSegmentItem[]): ContextSegment {
	return {
		key: "basePrompt",
		label: estimatedTokens === null ? "Base system prompt (not observed yet)" : "Base system prompt (Pi + host instructions)",
		estimatedTokens: estimatedTokens ?? 0,
		confidence: "exact-structural",
		...(estimatedTokens === null ? { unknown: true } : {}),
		...(items.length > 0 ? { items } : {}),
	};
}

/** Wraps a buildMessageHistoryTree() result into the messageHistory ContextSegment -- only the active-path token sum counts toward the segment total; an abandoned /tree branch still appears in items but contributes zero. */
export function messageHistorySegment(tree: MessageHistoryTree): ContextSegment {
	return {
		key: "messageHistory",
		label: "Conversation message history",
		estimatedTokens: tree.activeTokens,
		confidence: "exact-structural",
		...(tree.items.length > 0 ? { items: tree.items } : {}),
	};
}

export interface ContextBreakdown {
	/** Real usage from ctx.getContextUsage() -- ground truth, not estimated. Null only when Pi has no usage yet (e.g. before the first turn). */
	totalTokens: number | null;
	/** From ctx.model.contextWindow. Null when the active model's context window is unknown. */
	contextWindow: number | null;
	/** contextWindow - reserveTokens, mirroring Pi's own compaction-trigger formula. Null when contextWindow is unknown. */
	effectiveBudget: number | null;
	/**
	 * How much the known segments (Jittor's own plus whatever else was contributed) exceed the
	 * real total, when they do. Zero means no overshoot. This must stay visible rather than only
	 * being absorbed into "unaccounted" clamping to zero -- a clamped-to-zero unaccounted segment
	 * does NOT mean wire-protocol overhead is actually free; it means the other segments already
	 * consumed the entire real budget on paper. Hiding that distinction would make a genuinely
	 * nonzero cost look like zero.
	 */
	overshootTokens: number;
	/** Every input segment, in the order given, plus "other" absorbing whatever real usage the rest don't account for. */
	segments: ContextSegment[];
}

export interface ComposeContextBreakdownInput {
	totalTokens: number | null;
	contextWindow: number | null;
	reserveTokens?: number;
	/** Every segment currently known: Jittor's own directly-computed ones (basePrompt, messageHistory, toolDefinitions) plus whatever else was contributed on CONTEXT_HUB_CONTRIBUTION_CHANNEL (e.g. Papyrus's rules/tasks). Order is preserved for rendering. */
	segments: ContextSegment[];
}

/**
 * Composes every segment currently known (Jittor's own, plus whatever any extension
 * contributed) against the real total Pi reports, deriving "unaccounted" (genuine
 * wire-protocol overhead -- message envelope/role wrapping, cache-control markers -- which
 * really is invisible to any extension) as the remainder. The remainder is clamped to zero
 * rather than shown negative -- char/4 token estimation is approximate, and a small overshoot
 * in the known segments must not display as a nonsensical negative bucket -- but the clamp
 * amount itself is preserved as overshootTokens rather than silently discarded, so a consumer
 * can tell "genuinely zero" apart from "our other estimates already exceeded the real total".
 * When the real total is unavailable, unaccounted is reported as zero and totalTokens surfaces
 * as null so callers can label the whole breakdown as estimate-only rather than silently
 * treating a partial sum as ground truth.
 */
export function composeContextBreakdown(input: ComposeContextBreakdownInput): ContextBreakdown {
	const reserveTokens = input.reserveTokens ?? CONTEXT_DEFAULT_RESERVE_TOKENS;
	const knownTokens = input.segments.reduce((sum, segment) => sum + segment.estimatedTokens, 0);
	const overshootTokens = input.totalTokens === null ? 0 : Math.max(0, knownTokens - input.totalTokens);
	const other: ContextSegment = {
		key: "other",
		label:
			overshootTokens > 0
				? `Unaccounted (message envelope, cache-control markers, and other wire-protocol overhead) -- estimate overshoot: other segments' estimates already exceed the real total by ~${overshootTokens} tokens, so this is a floor, not a real zero`
				: "Unaccounted (message envelope, cache-control markers, and other wire-protocol overhead)",
		estimatedTokens: input.totalTokens === null ? 0 : Math.max(0, input.totalTokens - knownTokens),
		confidence: "correlated",
	};
	return {
		totalTokens: input.totalTokens,
		contextWindow: input.contextWindow,
		effectiveBudget: input.contextWindow === null ? null : Math.max(0, input.contextWindow - reserveTokens),
		overshootTokens,
		segments: [...input.segments, other],
	};
}
