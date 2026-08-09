export interface ContextGrowthPoint {
	turn: number;
	tokens: number;
}

/**
 * Owns the current post-compaction context-growth observation window. Trend fitting and a
 * trailing-size cap deliberately remain outside this task; reset() is the critical invariant
 * that prevents one regression window from spanning a real compaction discontinuity.
 */
export class ContextGrowthCapability {
	private points: ContextGrowthPoint[] = [];

	observe(turn: number, tokens: number): void {
		if (!Number.isInteger(turn) || turn < 0 || !Number.isFinite(tokens) || tokens < 0) return;
		this.points.push({ turn, tokens });
	}

	observations(): readonly ContextGrowthPoint[] {
		return this.points.map((point) => ({ ...point }));
	}

	reset(): void {
		this.points = [];
	}
}
