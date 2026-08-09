import { describe, expect, it } from "bun:test";
import { ContextGrowthCapability } from "../extension/src/observability/context-growth.ts";

describe("ContextGrowthCapability", () => {
	it("starts a fresh observation series after compaction reset", () => {
		const growth = new ContextGrowthCapability();
		growth.observe(1, 90_000);
		growth.observe(2, 105_000);
		expect(growth.observations()).toEqual([
			{ turn: 1, tokens: 90_000 },
			{ turn: 2, tokens: 105_000 },
		]);

		growth.reset();
		expect(growth.observations()).toEqual([]);
		growth.observe(3, 30_000);
		expect(growth.observations()).toEqual([{ turn: 3, tokens: 30_000 }]);
	});

	it("does not retain malformed points", () => {
		const growth = new ContextGrowthCapability();
		growth.observe(-1, 10);
		growth.observe(1.5, 10);
		growth.observe(1, Number.NaN);
		growth.observe(1, -10);
		expect(growth.observations()).toEqual([]);
	});
});
