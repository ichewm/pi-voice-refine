/**
 * Editor-draft refinement tests: segmentation, marker restoration, and a
 * full refine round-trip with a mock LLM.
 */

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import {
	splitDraft,
	restoreDraft,
	refineDraft,
	hasCJK,
	EditorRefineError,
} from "../src/refiner/editor-refine.ts";

describe("splitDraft · segmentation", () => {
	it("code fences, log lines, URLs and long tokens become verbatim segments", () => {
		const draft = [
			"帮我看看这个报错",
			"```ts",
			"const x: number = 42;",
			"```",
			"日志里出现了这个：2026-10-21 13:44:45 [ERROR] connection refused",
			"相关链接是 https://example.com/a/very/long/path?x=1",
			"配置文件在 /etc/nginx/nginx.conf 里面",
			"commit 是 a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2 这样",
			"Already-English line stays.",
		].join("\n");
		const r = splitDraft(draft);
		// Whole technical lines are fully verbatim…
		expect(r.masked).not.toContain("const x");
		expect(r.masked).toContain("帮我看看这个报错");
		expect(r.masked).toContain("Already-English line stays.");
		expect(r.verbatim.length).toBeGreaterThanOrEqual(3);
		// …and Chinese PROSE keeps its technical fragments masked inline.
		const maskedUrlLine = r.masked.split("\n").find((l) => l.includes("相关链接")) ?? "";
		expect(maskedUrlLine).not.toContain("https://");
		const maskedLogLine = r.masked.split("\n").find((l) => l.includes("日志里")) ?? "";
		expect(maskedLogLine).not.toContain("2026-10-21");
		expect(maskedLogLine).not.toContain("[ERROR]");
		const maskedPathLine = r.masked.split("\n").find((l) => l.includes("配置文件")) ?? "";
		expect(maskedPathLine).not.toContain("/etc/nginx");
		const maskedHashLine = r.masked.split("\n").find((l) => l.includes("commit")) ?? "";
		expect(maskedHashLine).not.toContain("a1b2c3d4");
	});

	it("prose chars exclude markers and whitespace", () => {
		const r = splitDraft("你好世界 ⟦V1⟧\n\nhello");
		expect(r.proseChars).toBeGreaterThan(0);
		expect(r.masked).toContain("⟦V1⟧"); // existing markers stay verbatim
	});
});

describe("restoreDraft · byte-exact restoration", () => {
	it("restores every marker", () => {
		const out = restoreDraft("Check ⟦V1⟧ and ⟦V2⟧ please.", ["CODE-A", "CODE-B"]);
		expect(out).toBe("Check CODE-A and CODE-B please.");
	});
	it("fails when a marker is missing (never corrupt the draft)", () => {
		expect(restoreDraft("Only ⟦V1⟧ here.", ["A", "B"])).toBeNull();
	});
	it("fails when stray markers remain", () => {
		expect(restoreDraft("⟦V1⟧ ⟦V1⟧", ["A"])).toBeNull(); // duplicated
	});
});

describe("refineDraft · end-to-end with mock LLM", () => {
	let server: Server;
	let base = "";
	let lastUser = "";

	beforeAll(async () => {
		server = createServer((req, res) => {
			let raw = "";
			req.on("data", (c) => (raw += c));
			req.on("end", () => {
				const body = JSON.parse(raw || "{}");
				lastUser = body.messages?.[body.messages.length - 1]?.content ?? "";
				res.setHeader("Content-Type", "application/json");
				// Echo policy: translate the fixed Chinese phrase, keep markers.
				let out = lastUser
					.replace(/帮我看看这个报错/g, "Please look into this error")
					.replace(/链接/g, "Link ")
					.replace(/也保留/g, " should be kept too");
				res.end(JSON.stringify({ message: { content: out } }));
			});
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	});
	afterAll(async () => {
		await new Promise<void>((r) => server.close(() => r()));
	});

	const chat = async (_s: string, user: string) => {
		const { llmChat } = await import("../src/refiner/ollama.ts");
		return llmChat(_s, user, {
			baseUrl: base,
			model: "mock",
			template: "faithful-en",
			temperature: 0.3,
			timeoutSeconds: 10,
			glossary: [],
		});
	};
	const opts = { baseUrl: base, model: "mock", temperature: 0.3, timeoutSeconds: 10 };

	it("translates prose and restores code byte-exact", async () => {
		const code = "const answer: number = 42; // ⟵ keep me";
		const draft = `帮我看看这个报错\n\n\`\`\`ts\n${code}\n\`\`\`\n\n链接 https://example.com/x?y=1 也保留`;
		const r = await refineDraft(draft, opts, chat);
		expect(r.text).toContain("Please look into this error");
		expect(r.text).toContain(code);
		expect(r.text).toContain("https://example.com/x?y=1");
		expect(r.translatedProseChars).toBeGreaterThan(0);
	});

	it("no Chinese → returns draft untouched without calling the LLM", async () => {
		let called = false;
		const r = await refineDraft("Only English here\n```js\nlet x=1;\n```", opts, async () => {
			called = true;
			return "";
		});
		expect(called).toBe(false);
		expect(r.translatedProseChars).toBe(0);
	});

	it("model that drops markers → hard error, original preserved", async () => {
		await expect(
			refineDraft("帮我看看这个报错\n```js\nlet x=1;\n```", opts, async () => "translation without markers"),
		).rejects.toThrow(EditorRefineError);
	});

	it("over-length prose → typed error", async () => {
		const long = "帮我看看".repeat(3200);
		await expect(refineDraft(long, opts, chat)).rejects.toMatchObject({ code: "TOO_LONG" });
	});
});

describe("hasCJK", () => {
	it("detects Chinese, ignores English/code", () => {
		expect(hasCJK("你好")).toBe(true);
		expect(hasCJK("hello world")).toBe(false);
		expect(hasCJK("const x = 1;")).toBe(false);
	});
});

describe("maskLeadingFragment · 代码前缀与中文黏连", () => {
	it("captures the full prefix including leading whitespace (offset bug)", () => {
		const line = "      logo_url: null,，这里插个路由http://x";
		const r = splitDraft("ctx\n" + line);
		const masked = r.masked.split("\n")[1];
		// The whole code prefix must be inside one marker — no leakage.
		expect(masked).not.toContain("null");
		expect(masked.startsWith("⟦")).toBe(true);
		expect(r.verbatim.some((v) => v === "      logo_url: null," || v === "logo_url: null,")).toBe(true);
	});
	it("restores without duplication", () => {
		const line = "      logo_url: null,，这里插个路由http://example.com/a";
		const r = splitDraft(line);
		const restored = restoreDraft(r.masked.replace(/，这里插个路由/, " , insert a route "), r.verbatim);
		expect(restored).not.toBeNull();
		expect(restored!.match(/null,/g)?.length).toBe(1);
	});
	it("short glue prefixes are not masked", () => {
		const r = splitDraft("看一下 doc 这个");
		expect(r.masked).toContain("doc");
	});
});

describe("maskInline · URL 与中文黏连（回归）", () => {
	it("a URL glued to Chinese does not swallow the Chinese tail", () => {
		const line = "，然后填1个URL https://github.com/a/b/issues，然后看看结果正不正常呗。";
		const r = splitDraft(line);
		// The Chinese tail must survive OUTSIDE the verbatim segment.
		expect(r.masked).toContain("然后看看结果正不正常呗");
		const urlSeg = r.verbatim.find((v) => v.startsWith("https://"));
		expect(urlSeg).toBe("https://github.com/a/b/issues");
	});
});

describe("boundary suite · 开源边界锁定", () => {
	// Mock chat that records every request and echoes translations deterministically.
	function makeRecordingChat(translations: Record<string, string>) {
		const requests: string[] = [];
		const chat = async (_s: string, user: string) => {
			requests.push(user);
			// Echo protocol: translate known Chinese lines, keep everything else.
			return user
				.split("\n")
				.map((l) => {
					const m = l.match(/^⟨(\d+)⟩\s?([\s\S]*)$/); // [\s\S] keeps \r from CRLF drafts
					if (!m) return l;
					const t = translations[m[2]] ?? m[2].replace(/[\u4e00-\u9fff]+/g, "T");
					return `⟨${m[1]}⟩ ${t}`;
				})
				.join("\n");
		};
		return { chat, requests };
	}
	const opts = { baseUrl: "http://127.0.0.1:1", model: "m", temperature: 0.3, timeoutSeconds: 5 };

	it("short code lines that MISS heuristics are never sent to the LLM", async () => {
		const shortCode = ["}", "});", "const x = 1", "export default foo", ");", "{", "type X =", "*/"];
		const draft = ["帮我看下这里", ...shortCode, "，然后收尾"].join("\n");
		const { chat, requests } = makeRecordingChat({});
		const r = await refineDraft(draft, opts, chat);
		// Only the two Chinese lines ever reach the model.
		const sent = requests.join("\n");
		for (const c of shortCode) expect(sent).not.toContain(c);
		expect(r.text).toContain("export default foo"); // byte-exact in output
		expect(r.text).toContain("const x = 1");
	});

	it("short shell commands inside Chinese lines are masked (npm run dev)", () => {
		const r = splitDraft("帮我看下这里");
		const line = "帮我跑一下 npm run dev 看看能不能起来";
		const sp = splitDraft(line);
		expect(sp.verbatim).toContain("npm run dev");
		expect(sp.masked).not.toContain("npm");
	});

	it("multi-word commands are masked as one segment (cargo test --release --quiet)", () => {
		const sp = splitDraft("先跑 cargo test --release --quiet 再说");
		expect(sp.verbatim).toContain("cargo test --release --quiet");
	});

	it("protocol characters ⟨/⟦ in user text fail loudly (PROTOCOL_CHARS)", async () => {
		await expect(refineDraft("含⟨1⟩的草稿", opts, async () => "x")).rejects.toMatchObject({
			code: "PROTOCOL_CHARS",
		});
		await expect(refineDraft("含⟦V1⟧的草稿", opts, async () => "x")).rejects.toMatchObject({
			code: "PROTOCOL_CHARS",
		});
	});

	it("CRLF drafts: non-Chinese lines keep their \\r byte-exact", async () => {
		const draft = "中文行\r\nconst x = 1;\r\nplain english stays\r\n，收尾\r\n";
		const { chat } = makeRecordingChat({});
		const r = await refineDraft(draft, opts, chat);
		expect(r.text).toContain("const x = 1;\r");
		expect(r.text).toContain("plain english stays\r");
	});

	it("URL trailing fullwidth punctuation stays OUT of the masked URL", () => {
		const sp = splitDraft("看下 https://x.com/a。然后继续");
		expect(sp.verbatim).toContain("https://x.com/a");
		expect(sp.verbatim.find((v) => v.startsWith("http"))).not.toContain("。");
	});

	it("fullwidth-punctuation-only 'Chinese' lines are not translated (no ideographs)", async () => {
		const draft = "，https://x.com/a。";
		const { chat, requests } = makeRecordingChat({});
		const r = await refineDraft(draft, opts, chat);
		expect(requests.length).toBe(0); // nothing sent
		expect(r.text).toBe(draft); // untouched
	});

	it("blank lines and whitespace survive byte-exact", async () => {
		const draft = "中文\n\n   \n\t\n中文2";
		const { chat } = makeRecordingChat({});
		const r = await refineDraft(draft, opts, chat);
		const lines = r.text.split("\n");
		expect(lines[1]).toBe("");
		expect(lines[2]).toBe("   ");
		expect(lines[3]).toBe("\t");
	});

	it("markdown link with Chinese label: URL masked, label translated", () => {
		const sp = splitDraft("参考[这个文档](https://docs.example.com/x)即可");
		expect(sp.verbatim).toContain("https://docs.example.com/x");
		expect(sp.masked).toContain("这个文档");
	});

	it("log line glued after Chinese lead-in: timestamp+level masked", () => {
		const sp = splitDraft("报错是 2026-10-21 13:44:45 [ERROR] timeout after 30000ms 你看下");
		expect(sp.verbatim.some((v) => v.startsWith("2026-10-21"))).toBe(true);
		expect(sp.verbatim).toContain("[ERROR]");
		expect(sp.masked).toContain("你看下");
	});
});
