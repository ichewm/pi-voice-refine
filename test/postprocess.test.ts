import { describe, expect, it } from "vitest";
import { stripThinkTags, stripCodeFence, stripPreamble, cleanRefinedOutput, looksInvalid } from "../src/refiner/postprocess.ts";

describe("stripThinkTags", () => {
	it("removes complete think blocks", () => {
		expect(stripThinkTags("<think>internal</think>Run tests.")).toBe("Run tests.");
	});
	it("removes unterminated think blocks", () => {
		expect(stripThinkTags("<think>oops the model rambles")).toBe("");
	});
	it("keeps text without think tags intact", () => {
		expect(stripThinkTags("plain output")).toBe("plain output");
	});
});

describe("stripCodeFence", () => {
	it("unwraps a fully fenced block", () => {
		expect(stripCodeFence("```\nRun cargo test.\n```")).toBe("Run cargo test.");
	});
	it("unwraps fenced block with language", () => {
		expect(stripCodeFence("```text\nRun cargo test.\n```")).toBe("Run cargo test.");
	});
	it("keeps inline code spans inside text", () => {
		expect(stripCodeFence("Use `cargo test` now.")).toBe("Use `cargo test` now.");
	});
});

describe("stripPreamble", () => {
	it("strips 'Here is the translation:' style preambles", () => {
		expect(stripPreamble("Here is the translation: Run tests.")).toBe("Run tests.");
		expect(stripPreamble("Here are the refined instructions:\nRun tests.")).toBe("Run tests.");
	});
	it("leaves normal text untouched", () => {
		expect(stripPreamble("Run the tests.")).toBe("Run the tests.");
	});
});

describe("cleanRefinedOutput", () => {
	it("handles think + fence + preamble combined", () => {
		const raw = "<think>hmm</think>\n```\nHere is the translation: Run cargo test.\n```";
		expect(cleanRefinedOutput(raw)).toBe("Run cargo test.");
	});
});

describe("looksInvalid", () => {
	it("flags empty output", () => {
		expect(looksInvalid("")).toBe(true);
		expect(looksInvalid("   ")).toBe(true);
	});
	it("flags assistant-narration", () => {
		expect(looksInvalid("As an AI, I cannot")).toBe(true);
	});
	it("accepts normal instructions", () => {
		expect(looksInvalid("Investigate the staking rewards bug. Do not modify code.")).toBe(false);
	});
});
