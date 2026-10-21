import { describe, expect, it } from "vitest";
import { formatForEditor, editorContentForPaste, editorContentForReplace } from "../src/formatter.ts";

describe("formatForEditor", () => {
	it("appends trailing space for single-line output when configured", () => {
		expect(formatForEditor("Run tests.", { insertMode: "paste", appendTrailingSpace: true })).toBe("Run tests. ");
	});
	it("does not append space for multi-line output", () => {
		const out = formatForEditor("A.\nB.", { insertMode: "paste", appendTrailingSpace: true });
		expect(out).toBe("A.\nB.");
	});
	it("trims and normalizes CRLF", () => {
		expect(formatForEditor("  hi\r\nthere  ", { insertMode: "paste", appendTrailingSpace: false })).toBe("hi\nthere");
	});
});

describe("editorContentForPaste", () => {
	it("appends with a space after existing text", () => {
		expect(editorContentForPaste("half sentence", "and more")).toBe("half sentence and more");
	});
	it("does not double the gap when existing text ends with space", () => {
		expect(editorContentForPaste("text ", "more")).toBe("text more");
	});
	it("returns insert alone for empty editor", () => {
		expect(editorContentForPaste("", "more")).toBe("more");
	});
});

describe("editorContentForReplace", () => {
	it("replaces the editor content", () => {
		expect(editorContentForReplace("old stuff", "new")).toBe("new");
	});
});
