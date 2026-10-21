import { describe, expect, it } from "vitest";
import { cleanupTempFile, formatDuration, levelToBar, tempWavPath, isSilentWav } from "../src/utils.ts";
import { writeFileSync, existsSync } from "node:fs";

describe("formatDuration", () => {
	it("formats ms as mm:ss", () => {
		expect(formatDuration(0)).toBe("00:00");
		expect(formatDuration(65_000)).toBe("01:05");
		expect(formatDuration(754_000)).toBe("12:34");
	});
});

describe("levelToBar", () => {
	it("maps low level to thin bar and high to thick", () => {
		expect(levelToBar(0)).toBe("▁");
		expect(levelToBar(0.99)).toBe("█");
	});
	it("clamps out-of-range values", () => {
		expect(levelToBar(-5)).toBe("▁");
		expect(levelToBar(5)).toBe("█");
	});
});

describe("temp files", () => {
	it("tempWavPath is unique per call", () => {
		expect(tempWavPath()).not.toBe(tempWavPath());
	});
	it("cleanupTempFile removes existing files and tolerates missing ones", () => {
		const p = tempWavPath();
		writeFileSync(p, "x");
		expect(existsSync(p)).toBe(true);
		expect(cleanupTempFile(p)).toBe(true);
		expect(cleanupTempFile(p)).toBe(true); // already gone
		expect(cleanupTempFile(undefined)).toBe(true);
	});
	it("isSilentWav treats tiny files as silent", () => {
		const p = tempWavPath();
		writeFileSync(p, Buffer.alloc(100));
		expect(isSilentWav(p)).toBe(true);
		cleanupTempFile(p);
	});
});
