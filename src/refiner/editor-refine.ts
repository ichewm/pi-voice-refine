/**
 * Editor-draft refinement: translate the Chinese prose inside a mixed draft
 * (spoken-English + manually pasted code/links/logs) while keeping every
 * technical element BYTE-EXACT.
 *
 * Strategy — placeholders, not trust: code blocks, log lines, URLs, paths and
 * long technical tokens are extracted and replaced with ⟦Vn⟧ markers BEFORE
 * the LLM sees anything. The model only ever translates prose, so it cannot
 * alter, truncate, or "translate" technical content, and draft length is
 * bounded by prose length, not by pasted-log size.
 */

import type { RefineApi, RefineTemplate } from "../config.ts";

const MARKER_RE = /⟦V(\d+)⟧/;

/** True if the text contains CJK characters (i.e. something to translate). */
export function hasCJK(text: string): boolean {
	return /[\u4e00-\u9fff]/.test(text);
}

export interface SplitResult {
	/** Document with verbatim segments replaced by ⟦Vn⟧ markers (LLM input). */
	masked: string;
	/** Verbatim segments by marker index (1-based). */
	verbatim: string[];
	/** Prose chars actually sent to the LLM. */
	proseChars: number;
}

/**
 * Technical-looking line heuristics — lines WITHOUT CJK that should never
 * reach the model: code, logs, paths, URLs, long tokens, shell commands.
 */
function isTechnicalLine(line: string): boolean {
	// A line containing Chinese is prose by definition — inline URLs and
	// tokens inside it are extracted by maskInline instead. Without this,
	// a sentence like "文档在这里 https://… 也可以参考" would be swallowed
	// whole as "technical" and never translated.
	if (hasCJK(line)) return false;
	if (line.includes("⟦")) return true; // existing markers stay verbatim
	const t = line.trim();
	if (t === "") return false;
	if (/https?:\/\/\S+/.test(t)) return true; // links
	if (/(?:^|\s)\/[\w./-]{3,}/.test(t) && !hasCJK(t)) return true; // paths
	if (/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(t)) return true; // log timestamps
	if (/\[(ERROR|WARN|INFO|DEBUG|TRACE|FATAL)\]/i.test(t)) return true; // log levels
	if (/\b(?:ERROR|WARN|INFO|DEBUG)\b\s*[:|]/.test(t)) return true;
	// Code density: semicolons, braces, arrows, comparison/assignment ops.
	const codeish = (t.match(/[;{}()=><>!&|[\]]/g) ?? []).length;
	if (codeish >= 2 && !hasCJK(t)) return true;
	// Shell-ish lines.
	if (/^\s*(?:\$|>|#|%|npm|pnpm|yarn|cargo|git|docker|kubectl|curl|brew|pip|python|node|make)\b/.test(t) && !hasCJK(t))
		return true;
	// One long unbroken token (hashes, IDs, base64…).
	if (/\S{32,}/.test(t) && !hasCJK(t)) return true;
	return false;
}

/** Chars that mark the start of Chinese content (ideographs + fullwidth
 * punctuation) — used to split mixed "code-prefix + Chinese" lines. */
const CJK_START = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/;

/** Mask a leading non-Chinese fragment (pasted code that didn't end with a
 * newline, e.g. "      logo_url: null,，这里插个路由…"). The code part
 * becomes a placeholder so the model only ever sees the Chinese prose. */
function maskLeadingFragment(line: string, push: (s: string) => string): string {
	// NOTE: leading whitespace must be INSIDE the capture group — if `^\s*`
	// consumed it outside the group, `prefix.length` would not equal the
	// match offset and the marker would replace the wrong span (observed as
	// duplicated code fragments after restore).
	const m = line.match(/^(\s*[\s\S]*?)(?=[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef])/);
	if (!m) return line;
	const prefix = m[1];
	if (prefix.trim().length < 8) return line; // trivial glue, not code
	return push(prefix) + line.slice(prefix.length);
}

/** URL characters stop at whitespace AND CJK — `\S` alone would swallow a
 * Chinese tail glued right after the link (observed: "https://x，看看结果"
 * became one giant verbatim blob and the Chinese never got translated). */
const URL_BODY = /https?:\/\/[^\s\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]+/;

/** Trim trailing punctuation from a URL match: "(see https://x.com/a)" must
 * not swallow the closing paren. Balanced brackets (e.g. wiki "Route_(x)")
 * are kept. */
function trimUrlTail(url: string): { core: string; tail: string } {
	let core = url;
	let tail = "";
	const TRAILING = /^[)}\]},;.!?'"]+/;
	while (TRAILING.test(core.slice(-1)) && core.length > 0) {
		const last = core.slice(-1);
		if ((last === ")" && core.includes("(")) || (last === "]" && core.includes("[")) || (last === "}" && core.includes("{")))
			break; // balanced — keep it
		tail = last + tail;
		core = core.slice(0, -1);
	}
	return { core, tail };
}

/** Inline technical tokens inside prose lines: URLs and long unbroken tokens. */
function maskInline(line: string, push: (s: string) => string): string {
	return (
		line
			.replace(URL_BODY, (m) => {
				const { core, tail } = trimUrlTail(m);
				return push(core) + tail;
			})
			// Log timestamps and levels inside prose (spoken lead-ins like
			// "日志如下：2026-10-21 13:44 [ERROR] conn refused").
			.replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(?:[.,]\d+)?\b/g, (m) => push(m))
			.replace(/\[[A-Z]{4,8}\]/g, (m) => push(m))
			.replace(/(?:[\w./:@%+#-]){14,}/g, (m) => (hasCJK(m) ? m : push(m)))
			// Short shell commands inside speech ("跑一下 npm run dev 看看").
			.replace(
				/\b(?:npm|pnpm|yarn|cargo|git|docker|kubectl|brew|pip3?|python3?|node|make|go)\s+[\w./@:-]+(?:\s+[\w./@:-]+)*/g,
				(m) => (hasCJK(m) ? m : push(m)),
			)
	);
}

/** Split a draft into masked prose + verbatim segments. */
export function splitDraft(text: string): SplitResult {
	const verbatim: string[] = [];
	const push = (s: string) => {
		verbatim.push(s);
		return `⟦V${verbatim.length}⟧`;
	};

	// 1. Fenced code blocks first (``` … ```), keeping the fences verbatim.
	let work = text.replace(/```[\s\S]*?```/g, (m) => push(m));

	// 2. Whole technical lines (group consecutive ones into one segment to
	//    keep block structure and minimize marker count).
	const lines = work.split("\n");
	const out: string[] = [];
	let block: string[] = [];
	const flushBlock = () => {
		if (block.length > 0) {
			out.push(push(block.join("\n")));
			block = [];
		}
	};
	for (const line of lines) {
		// Lines that are already a bare marker (from the fence phase) must
		// pass through untouched — re-wrapping would corrupt marker numbering.
		if (/^⟦V\d+⟧$/.test(line.trim())) {
			flushBlock();
			out.push(line);
		} else if (isTechnicalLine(line)) {
			block.push(line);
		} else {
			flushBlock();
			out.push(line);
		}
	}
	flushBlock();
	work = out.join("\n");

	// 3. Inline tokens inside remaining prose lines: leading pasted-code
	//    fragments first, then URLs/log-tokens within the prose.
	work = work
		.split("\n")
		.map((line) => {
			if (!hasCJK(line)) return line;
			let l = maskLeadingFragment(line, push);
			l = maskInline(l, push);
			return l;
		})
		.join("\n");

	const proseChars = work.replace(MARKER_RE, "").replace(/\s/g, "").length;
	return { masked: work, verbatim, proseChars };
}

/** Restore ⟦Vn⟧ markers. Returns null when any marker is missing or altered. */
export function restoreDraft(translated: string, verbatim: string[]): string | null {
	let out = translated;
	for (let i = 0; i < verbatim.length; i++) {
		const marker = `⟦V${i + 1}⟧`;
		if (!out.includes(marker)) return null;
		out = out.replace(marker, () => verbatim[i]);
	}
	// No stray or duplicated markers may survive.
	if (MARKER_RE.test(out)) return null;
	return out;
}



export interface EditorRefineOptions {
	api?: RefineApi;
	baseUrl: string;
	model: string;
	temperature: number;
	timeoutSeconds: number;
	signal?: AbortSignal;
	/** Internal: template kept for future routing; the editor command always
	 * targets English output for Chinese prose. */
	template?: RefineTemplate;
}

export interface EditorRefineResult {
	text: string;
	translatedProseChars: number;
	verbatimSegments: number;
	durationMs: number;
}

/**Thrown when the model output fails marker/preservation checks. */
export class EditorRefineError extends Error {
	readonly code: string;
	constructor(message: string, code: string) {
		super(message);
		this.code = code;
		this.name = "EditorRefineError";
	}
}

/** LLM transport injected by the caller (reuses the ollama client machinery). */
export type LlmChat = (
	system: string,
	user: string,
	opts: EditorRefineOptions,
) => Promise<string>;

export interface DraftSegment {
	kind: "prose" | "verbatim";
	lines: string[];
}

/** Split a draft into ordered segments: Chinese prose vs verbatim technical. */
export function segmentDraft(text: string): DraftSegment[] {
	const segs: DraftSegment[] = [];
	let block: string[] = [];
	let blockKind: "prose" | "verbatim" | null = null;
	const flush = () => {
		if (blockKind !== null && block.length > 0) segs.push({ kind: blockKind, lines: block });
		block = [];
		blockKind = null;
	};
	for (const line of text.split("\n")) {
		const kind: "prose" | "verbatim" = isTechnicalLine(line) ? "verbatim" : "prose";
		if (kind !== blockKind) {
			flush();
			blockKind = kind;
		}
		block.push(line);
	}
	flush();
	return segs;
}

/**
 * Numbered-line protocol: only Chinese-containing lines are sent to the LLM
 * (each with a ⟨n⟩ prefix and inline technical tokens masked). Verbatim
 * segments never leave this process, so code cannot be altered or truncated
 * and 200-line pastes cost zero model tokens.
 */


function parseNumbered(response: string, count: number): (string | null)[] {
	const out: (string | null)[] = new Array(count).fill(null);
	for (const raw of response.split("\n")) {
		// [\s\S]* (not .) so a trailing \r from CRLF drafts survives parsing.
		const m = raw.match(/^\s*⟨(\d+)⟩\s?([\s\S]*)$/);
		if (!m) continue;
		const n = Number(m[1]);
		if (n >= 1 && n <= count) out[n - 1] = m[2];
	}
	return out;
}

export const EDITOR_REFINE_SYSTEM = `You translate Chinese lines inside a developer's draft.

You receive numbered lines in the form ⟨n⟩ text. Each line may contain Chinese
prose, English, and markers like ⟦V1⟧ that stand for code/links you cannot see.

For EVERY numbered line:
1. Translate the Chinese faithfully into natural English — sentence by sentence,
   same order, same meaning; remove only disfluencies (呃、嗯、那个, repetitions).
2. Keep existing English exactly as written.
3. Keep every ⟦Vn⟧ marker exactly as-is, in place.
4. Answer with the SAME ⟨n⟩ prefix, one line per number, same order, nothing else.
Never merge, split, add, or skip numbered lines.`;

export async function refineDraft(
	text: string,
	opts: EditorRefineOptions,
	chat: LlmChat,
): Promise<EditorRefineResult> {
	const started = Date.now();
	// Protocol collision guard: ⟨n⟩ line prefixes and ⟦Vn⟧ markers are our
	// wire format — pre-existing occurrences in user text would corrupt
	// parsing/restoration, so fail loudly instead of mangling the draft.
	if (text.includes("⟨") || text.includes("⟦")) {
		throw new EditorRefineError(
			"the draft contains ⟨ or ⟦ characters, which the refine protocol reserves — remove or replace them and retry",
			"PROTOCOL_CHARS",
		);
	}
	const segments = segmentDraft(text);

	// Prose lines to translate, with inline tokens masked per line.
	interface ProseJob {
		segIndex: number;
		lineIndex: number;
		masked: string;
		verbatim: string[];
	}
	const jobs: ProseJob[] = [];
	segments.forEach((seg, si) => {
		if (seg.kind !== "prose") return;
		seg.lines.forEach((line, li) => {
			if (!hasCJK(line)) return;
			const single = splitDraft(line);
			jobs.push({ segIndex: si, lineIndex: li, masked: single.masked, verbatim: single.verbatim });
		});
	});

	if (jobs.length === 0) {
		return { text, translatedProseChars: 0, verbatimSegments: segments.filter((s) => s.kind === "verbatim").length, durationMs: 0 };
	}

	const proseChars = jobs.reduce((n, j) => n + j.masked.replace(/⟦V\d+⟧/g, "").replace(/\s/g, "").length, 0);
	if (proseChars > 12_000) {
		throw new EditorRefineError(
			`Chinese text too long for one pass (${proseChars} chars; limit 12000) — split the draft`,
			"TOO_LONG",
		);
	}

	// One request with all numbered lines (chunks of 40 keep prompts tight).
	const BATCH = 40;
	for (let base = 0; base < jobs.length; base += BATCH) {
		const batch = jobs.slice(base, base + BATCH);
		const req = batch.map((j, i) => `⟨${base + i + 1}⟩ ${j.masked}`).join("\n");
		let translations = parseNumbered(await chat(EDITOR_REFINE_SYSTEM, req, opts), batch.length);

		// Per-line retry for anything missing, malformed, or still Chinese.
		for (let i = 0; i < batch.length; i++) {
			let t = translations[i];
			const ok =
				t !== null &&
				(() => {
					const back = restoreDraft(t, batch[i].verbatim);
					return back !== null && !hasCJK(back);
				})();
			if (!ok) {
				t = await chat(
					EDITOR_REFINE_SYSTEM,
					`⟨1⟩ ${batch[i].masked}\n\n(Answer with exactly: ⟨1⟩ <translation>)`,
					opts,
				);
				translations[i] = parseNumbered(t, 1)[0];
			}
		}

		// Splice results back into the segment lines.
		for (let i = 0; i < batch.length; i++) {
			const job = batch[i];
			const t = translations[i];
			const back = t === null ? null : restoreDraft(t, job.verbatim);
			if (back === null || hasCJK(back)) {
				throw new EditorRefineError(
					`a Chinese line could not be translated — original draft left untouched`,
					"UNTRANSLATED_LEFT",
				);
			}
			segments[job.segIndex].lines[job.lineIndex] = back;
		}
	}

	const result = segments.map((s) => s.lines.join("\n")).join("\n");
	return {
		text: result,
		translatedProseChars: proseChars,
		verbatimSegments: segments.filter((s) => s.kind === "verbatim").length,
		durationMs: Date.now() - started,
	};
}
