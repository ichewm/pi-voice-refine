import { describe, expect, it } from "vitest";
import { systemPromptFor, userMessageFor } from "../src/refiner/prompt.ts";

describe("systemPromptFor", () => {
	it("faithful-en: minimal-intervention contract is explicit", () => {
		const f = systemPromptFor("faithful-en");
		expect(f).toContain("MINIMAL intervention");
		expect(f).toContain("must NOT");
		expect(f).toContain("sentence by sentence");
		// 关键反增删规则存在
		expect(f).toContain("Add any word");
		expect(f).toContain("Reorder");
	});

	it("polish-zh forbids translation and keeps Chinese", () => {
		const polish = systemPromptFor("polish-zh");
		expect(polish).toContain("Do NOT translate");
		expect(polish).toContain("呃");
	});

	it("two templates are distinct", () => {
		expect(systemPromptFor("faithful-en")).not.toEqual(systemPromptFor("polish-zh"));
	});
});

describe("userMessageFor", () => {
	it("wraps transcript in tags", () => {
		const msg = userMessageFor("跑一下测试", []);
		expect(msg).toContain("<transcript>\n跑一下测试\n</transcript>");
		expect(msg).not.toContain("glossary");
	});
	it("injects glossary before transcript", () => {
		const msg = userMessageFor("看下 staking", ["staking", "rewardPerToken"]);
		expect(msg).toContain("<glossary>");
		expect(msg).toContain("- staking");
		expect(msg.indexOf("<glossary>")).toBeLessThan(msg.indexOf("<transcript>"));
	});
});
