import { describe, expect, it } from "vitest";
import {
	DEFAULT_CONFIG,
	deepMerge,
	expandTilde,
	normalizeConfig,
	loadConfig,
	configPath,
} from "../src/config.ts";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function withTempAgentDir<T>(fn: (dir: string) => T): T {
	const dir = mkdtempSync(join(tmpdir(), "vrefine-cfg-"));
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		return fn(dir);
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("deepMerge", () => {
	it("merges nested objects without mutating inputs", () => {
		const target = { a: 1, nested: { x: 1, y: 2 } };
		const out = deepMerge(target, { nested: { y: 3, z: 4 } });
		expect(out).toEqual({ a: 1, nested: { x: 1, y: 3, z: 4 } });
		expect(target.nested.y).toBe(2);
	});

	it("replaces arrays wholesale", () => {
		expect(deepMerge({ list: [1, 2] }, { list: [9] })).toEqual({ list: [9] });
	});
});

describe("normalizeConfig", () => {
	it("fills defaults for a partial config", () => {
		const cfg = normalizeConfig({ refine: { model: "qwen3.5:9b" } });
		expect(cfg.refine.model).toBe("qwen3.5:9b");
		expect(cfg.refine.baseUrl).toBe(DEFAULT_CONFIG.refine.baseUrl);
		expect(cfg.hotkeyRefine).toBe("ctrl+alt+v");
	});

	it("dedupes and trims glossary", () => {
		const cfg = normalizeConfig({ refine: { glossary: [" staking ", "staking", "", "Foundry"] } });
		expect(cfg.refine.glossary).toEqual(["staking", "Foundry"]);
	});
});

describe("expandTilde", () => {
	it("expands ~ and ~/ prefixes", () => {
		expect(expandTilde("~")).toBe(process.env.HOME);
		expect(expandTilde("~/x").startsWith("/")).toBe(true);
		expect(expandTilde("/abs/path")).toBe("/abs/path");
	});
});

describe("loadConfig", () => {
	it("creates the default config file on first run", () => {
		withTempAgentDir(() => {
			const cfg = loadConfig();
			expect(cfg).toEqual(DEFAULT_CONFIG);
			const onDisk = JSON.parse(readFileSync(configPath(), "utf8"));
			expect(onDisk.hotkeyRefine).toBe("ctrl+alt+v");
		});
	});

	it("falls back to defaults on corrupt JSON", () => {
		withTempAgentDir(() => {
			writeFileSync(configPath(), "{ not json", "utf8");
			const cfg = loadConfig();
			expect(cfg.hotkeyRefine).toBe("ctrl+alt+v");
		});
	});
});
