/**
 * Output formatting: how the final text lands in the editor.
 */

import type { InsertMode } from "./config.ts";

export interface OutputOptions {
	insertMode: InsertMode;
	appendTrailingSpace: boolean;
}

/** Prepare text for insertion (normalize newlines, optional trailing space). */
export function formatForEditor(text: string, opts: OutputOptions): string {
	let out = text.replace(/\r\n/g, "\n").trim();
	if (opts.appendTrailingSpace && !out.includes("\n")) {
		out += " ";
	}
	return out;
}

/** Compute the final editor content for "replace" mode (replaces everything). */
export function editorContentForReplace(currentEditorText: string, insert: string): string {
	return insert;
}

/** Compute the insertion for "paste" mode: appended after existing content. */
export function editorContentForPaste(currentEditorText: string, insert: string): string {
	if (currentEditorText.length === 0) return insert;
	const needsGap = !/\s$/.test(currentEditorText);
	return currentEditorText + (needsGap ? " " : "") + insert;
}
