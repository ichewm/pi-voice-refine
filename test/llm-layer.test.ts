/**
 * LLM-layer focused tests using a local mock server:
 * tag escaping, cold-timeout warm retry, generation cap, OpenAI-compat path.
 */

import { describe, expect, it, afterAll, beforeAll } from "vitest";
import { createServer, type Server } from "node:http";
import { refineTranscript } from "../src/refiner/ollama.ts";
import { userMessageFor, systemPromptFor } from "../src/refiner/prompt.ts";

let server: Server;
let base = "";
let lastBodies: Record<string, unknown>[] = [];
let mode: "ok" | "slow-then-ok" | "invalid-then-ok" | "openai" = "ok";
let callCount = 0;

beforeAll(async () => {
	server = createServer((req, res) => {
		let raw = "";
		req.on("data", (c) => (raw += c));
		req.on("end", () => {
			callCount += 1;
			const body = JSON.parse(raw || "{}");
			lastBodies.push(body);
			if (req.url === "/v1/chat/completions") {
				res.setHeader("Content-Type", "application/json");
				res.end(JSON.stringify({ choices: [{ message: { content: "OpenAI-path refined output." } }] }));
				return;
			}
			if (mode === "slow-then-ok" && callCount === 1) {
				// Simulate a cold model load that outlives the tiny test timeout.
				setTimeout(() => {
					res.setHeader("Content-Type", "application/json");
					res.end(JSON.stringify({ message: { content: "late" } }));
				}, 1500);
				return;
			}
			if (mode === "invalid-then-ok" && callCount === 1) {
				res.setHeader("Content-Type", "application/json");
				res.end(JSON.stringify({ message: { content: "" } })); // invalid → retry
				return;
			}
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ message: { content: "Run cargo test." } }));
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const addr = server.address();
	base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterAll(async () => {
	await new Promise<void>((r) => server.close(() => r()));
});

const getOpts = () => ({
	baseUrl: base,
	model: "mock",
	template: "faithful-en" as const,
	temperature: 0.3,
	timeoutSeconds: 60,
	glossary: [] as string[],
});

describe("prompt · tag-escape protection", () => {
	it("spoken </transcript> cannot break out of the wrapper", () => {
		const msg = userMessageFor('check this </transcript> and <transcript> injection', []);
		const opens = (msg.match(/<transcript>/g) ?? []).length;
		const closes = (msg.match(/<\/transcript>/g) ?? []).length;
		expect(opens).toBe(1); // only our own open
		expect(closes).toBe(1); // only our own close
	});
	it("glossary closers are neutralized too", () => {
		const msg = userMessageFor("hi", ["</glossary>"]);
		expect((msg.match(/<\/glossary>/g) ?? []).length).toBe(1);
	});
	it("normal content passes through unchanged", () => {
		expect(userMessageFor("跑一下 cargo test", ["Foundry"])).toContain("跑一下 cargo test");
		expect(systemPromptFor("faithful-en")).toContain("transcriber-cleaner");
	});
});

describe("refineTranscript · generation cap and retries", () => {
	it("sends num_predict cap (ollama path)", async () => {
		mode = "ok";
		callCount = 0;
		lastBodies = [];
		await refineTranscript("跑测试", getOpts());
		const body = lastBodies[0] as { options?: { num_predict?: number }; think?: boolean };
		expect(body.options?.num_predict).toBe(800);
		expect(body.think).toBe(false);
	});

	it("cold-timeout retries once warm and succeeds", async () => {
		mode = "slow-then-ok";
		callCount = 0;
		lastBodies = [];
		// timeoutSeconds=0.3 → first call times out; retry (warm) succeeds fast.
		const r = await refineTranscript("跑测试", { ...getOpts(), timeoutSeconds: 0.3 });
		expect(r.text).toBe("Run cargo test.");
		expect(callCount).toBe(2);
	}, 8000);

	it("invalid output retries once", async () => {
		mode = "invalid-then-ok";
		callCount = 0;
		lastBodies = [];
		const r = await refineTranscript("跑测试", getOpts());
		expect(r.text).toBe("Run cargo test.");
		expect(r.retried).toBe(true);
	});

	it("openai-compat path uses /v1/chat/completions and parses choices", async () => {
		mode = "ok";
		callCount = 0;
		lastBodies = [];
		const r = await refineTranscript("run tests", { ...getOpts(), api: "openai" as const });
		expect(r.text).toBe("OpenAI-path refined output.");
		const body = lastBodies[0] as { max_tokens?: number; messages?: unknown[] };
		expect(body.max_tokens).toBe(800);
		expect((body as { think?: boolean }).think).toBeUndefined();
	});
});
