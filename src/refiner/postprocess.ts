/**
 * Post-processing of LLM refine output before it goes into the editor.
 * Keeps the inserted text clean even when the model leaks reasoning or fences.
 */

/** Remove <think>…</think> blocks (some local models leak them). */
export function stripThinkTags(text: string): string {
	return text
		.replace(/<think>[\s\S]*?<\/think>/gi, "")
		.replace(/<think>[\s\S]*$/i, ""); // unterminated think block → drop to end
}

/** If the entire output is wrapped in one fenced code block, unwrap it. */
export function stripCodeFence(text: string): string {
	const trimmed = text.trim();
	const match = trimmed.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/);
	if (match) return match[1];
	// Also handle single-line fences: ```text```
	const single = trimmed.match(/^```[a-zA-Z]*\s*(.*?)\s*```$/);
	if (single) return single[1];
	return trimmed;
}

const PREAMBLE_PATTERNS = [
	/^here (is|are)[^:\n]{0,60}[:：]\s*/i,
	/^(refined|translated|translation|english|instructions?)[^:\n]{0,40}[:：]\s*/i,
	/^sure[,!]?\s*here[^:\n]{0,60}[:：]\s*/i,
];

/** Remove common leading preambles like "Here is the translation:". */
export function stripPreamble(text: string): string {
	let out = text.trim();
	for (const pat of PREAMBLE_PATTERNS) {
		out = out.replace(pat, "");
	}
	return out.trim();
}

/** Full cleanup pipeline. */
export function cleanRefinedOutput(raw: string): string {
	let out = stripThinkTags(raw);
	out = stripCodeFence(out);
	out = stripPreamble(out);
	return out.replace(/\r\n/g, "\n").trim();
}

/** True when the output looks like the model refused / chatted instead of refining. */
export function looksInvalid(text: string): boolean {
	const t = text.trim();
	if (t.length === 0) return true;
	// The model narrating instead of instructing (rare with the contract).
	if (/^as an ai/i.test(t) && t.length < 200) return true;
	return false;
}
