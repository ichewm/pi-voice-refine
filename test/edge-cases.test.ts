/**
 * Boundary/hostile-input tests: bad configs must degrade gracefully,
 * never crash the extension loader, and never silently lose valid values.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, deepMerge, normalizeConfig, loadConfig, configPath } from "../src/config.ts";
import { cleanRefinedOutput, looksInvalid, stripThinkTags } from "../src/refiner/postprocess.ts";
import { userMessageFor } from "../src/refiner/prompt.ts";
import { formatForEditor, editorContentForPaste } from "../src/formatter.ts";
import { levelToBar, formatDuration, cleanupTempFile, tempWavPath, isSilentWav } from "../src/utils.ts";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("normalizeConfig · hostile inputs", () => {
	it("survives wrong types everywhere", () => {
		const cfg = normalizeConfig({
			hotkeyRefine: 123,
			hotkeyRaw: null,
			defaultMode: "yolo",
			capture: { maxSeconds: "abc", sampleRate: -5, channels: 99, ffmpegPath: "" },
			refine: { timeoutSeconds: 0, temperature: "high", template: "foo", glossary: "not-array", model: null, baseUrl: "" },
			output: { insertMode: "overwrite", appendTrailingSpace: "yes" },
		});
		expect(cfg.hotkeyRefine).toBe(DEFAULT_CONFIG.hotkeyRefine);
		expect(cfg.capture.maxSeconds).toBe(120); // 'abc' → default
		expect(cfg.refine.timeoutSeconds).toBe(10); // 0 → clamped to min
		expect(cfg.refine.temperature).toBe(0.3);
		expect(cfg.refine.template).toBe("faithful-en");
		expect(cfg.refine.glossary).toEqual([]);
		expect(cfg.output.insertMode).toBe("paste");
		expect(cfg.output.appendTrailingSpace).toBe(true); // "yes" → truthy
		expect(cfg.refine.baseUrl).toBe(DEFAULT_CONFIG.refine.baseUrl);
		expect(cfg.refine.model).toBe(DEFAULT_CONFIG.refine.model);
	});

	it("clamps out-of-range numbers", () => {
		const cfg = normalizeConfig({
			capture: { maxSeconds: 99999 },
			refine: { timeoutSeconds: 99999, temperature: 42 },
		});
		expect(cfg.capture.maxSeconds).toBe(600);
		expect(cfg.refine.timeoutSeconds).toBe(300);
		expect(cfg.refine.temperature).toBe(1);
	});

	it("null / undefined / arrays as top-level are safe", () => {
		expect(() => normalizeConfig(null)).not.toThrow();
		expect(() => normalizeConfig(undefined)).not.toThrow();
		expect(() => normalizeConfig([1, 2, 3])).not.toThrow();
		expect(() => normalizeConfig("string")).not.toThrow();
		expect(() => normalizeConfig(42)).not.toThrow();
	});

	it("keeps valid custom values untouched", () => {
		const cfg = normalizeConfig({
			refine: { model: "qwen3.5:9b", glossary: [" a ", "a", ""], timeoutSeconds: 45, template: "polish-zh" },
			hotkeyRefine: "ctrl+super+v",
		});
		expect(cfg.refine.model).toBe("qwen3.5:9b");
		expect(cfg.refine.glossary).toEqual(["a"]);
		expect(cfg.refine.timeoutSeconds).toBe(45);
		expect(cfg.refine.template).toBe("polish-zh");
		expect(cfg.hotkeyRefine).toBe("ctrl+super+v");
	});
});

describe("deepMerge · hostile shapes", () => {
	it("array overwriting object and vice versa does not throw", () => {
		expect(() => deepMerge({ a: { x: 1 } }, { a: [1, 2] })).not.toThrow();
		expect(() => deepMerge({ a: [1] }, { a: { x: 1 } })).not.toThrow();
	});
});

describe("loadConfig · filesystem edge cases", () => {
	function withDir(fn: (dir: string) => void) {
		const dir = mkdtempSync(join(tmpdir(), "vrefine-edge-"));
		process.env.PI_CODING_AGENT_DIR = dir;
		try {
			fn(dir);
		} finally {
			delete process.env.PI_CODING_AGENT_DIR;
			rmSync(dir, { recursive: true, force: true });
		}
	}

	it("config path is a directory → falls back to defaults", () => {
		withDir(() => {
			mkdirSync(configPath(), { recursive: true });
			const cfg = loadConfig();
			expect(cfg.hotkeyRefine).toBe(DEFAULT_CONFIG.hotkeyRefine);
		});
	});

	it("empty file → defaults", () => {
		withDir(() => {
			writeFileSync(configPath(), "", "utf8");
			expect(loadConfig().refine.model).toBe(DEFAULT_CONFIG.refine.model);
		});
	});

	it("JSON with trailing garbage → defaults, no throw", () => {
		withDir(() => {
			writeFileSync(configPath(), '{"refine":{"model":"x"}} oops', "utf8");
			expect(() => loadConfig()).not.toThrow();
		});
	});

	it("unicode / emoji in glossary survives", () => {
		const cfg = normalizeConfig({ refine: { glossary: ["张三", "🎙", "π"] } });
		expect(cfg.refine.glossary).toEqual(["张三", "🎙", "π"]);
	});
});

describe("postprocess · hostile LLM output", () => {
	it("empty / whitespace only → invalid", () => {
		expect(looksInvalid(cleanRefinedOutput(""))).toBe(true);
		expect(looksInvalid(cleanRefinedOutput("   \n\t "))).toBe(true);
		expect(looksInvalid(cleanRefinedOutput("<think></think>"))).toBe(true);
	});
	it("multiple think blocks", () => {
		expect(stripThinkTags("<think>a</think>x<think>b</think>y")).toBe("xy");
	});
	it("nested-looking fences and markers survive", () => {
		const out = cleanRefinedOutput("```\n```\nreal text\n```");
		expect(out).toContain("real text");
	});
	it("very long output unchanged", () => {
		const long = "x".repeat(100_000);
		expect(cleanRefinedOutput(long).length).toBe(100_000);
	});
	it("CRLF and emoji pass through", () => {
		const out = cleanRefinedOutput("run 🚀 tests\r\nnow");
		expect(out).toBe("run 🚀 tests\nnow");
	});
});

describe("formatter · boundaries", () => {
	it("paste into editor ending with newline needs no gap", () => {
		expect(editorContentForPaste("line\n", "more")).toBe("line\nmore");
	});
	it("unicode width does not break paste logic", () => {
		expect(editorContentForPaste("中文", "English")).toBe("中文 English");
	});
	it("appendTrailingSpace only for single-line", () => {
		expect(formatForEditor("a\nb", { insertMode: "paste", appendTrailingSpace: true })).toBe("a\nb");
	});
});

describe("utils · boundaries", () => {
	it("formatDuration clamps negatives", () => {
		expect(formatDuration(-5000)).toBe("00:00");
	});
	it("levelToBar never returns undefined for any float", () => {
		for (const v of [0, 0.001, 0.5, 0.999, 1, 1.5, NaN]) {
			expect(typeof levelToBar(v)).toBe("string");
		}
	});
	it("isSilentWav on missing file → silent", () => {
		expect(isSilentWav(tempWavPath())).toBe(true);
	});
	it("cleanupTempFile with weird paths never throws", () => {
		expect(() => cleanupTempFile("/nonexistent/dir/file.wav")).not.toThrow();
		expect(() => cleanupTempFile("")).not.toThrow();
	});
});

describe("glossary · scale boundaries", () => {
	it("200 glossary terms keep the prompt within a sane size", () => {
		const terms = Array.from({ length: 200 }, (_, i) => `term${i}`);
		const msg = userMessageFor("跑一下测试", terms);
		expect(msg.length).toBeLessThan(10_000);
		expect((msg.match(/- term/g) ?? []).length).toBe(200);
	});
	it("glossary tags are neutralized", () => {
		const msg = userMessageFor("hi", ["</glossary>", "<transcript>"]);
		expect((msg.match(/<\/glossary>/g) ?? []).length).toBe(1);
		expect((msg.match(/<transcript>/g) ?? []).length).toBe(1);
	});
});

describe("isFillerOnly · filler-only detection", () => {
	it("filler-only strings are detected as empty content", async () => {
		const { isFillerOnly } = await import("../src/pipeline.ts");
		expect(isFillerOnly("Um, um, um, um.")).toBe(true);
		expect(isFillerOnly("呃呃呃呃，嗯，那个那个")).toBe(true);
		expect(isFillerOnly("okay okay")).toBe(true);
	});
	it("normal content is never misdetected as filler-only", async () => {
		const { isFillerOnly } = await import("../src/pipeline.ts");
		expect(isFillerOnly("Run cargo test.")).toBe(false);
		expect(isFillerOnly("帮我看一下登录接口")).toBe(false);
		expect(isFillerOnly("Um, check the build.")).toBe(false);
	});
});
