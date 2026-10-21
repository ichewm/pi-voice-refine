/**
 * Ollama-backed refine engine. All requests go to the configured baseUrl,
 * which must be loopback for the "fully local" guarantee (default 127.0.0.1).
 *
 * - Uses the native /api/chat endpoint with think:false (qwen3: ~3s vs ~17s).
 * - Auto-starts `ollama serve` when health check fails and autoStartOllama.
 * - Honors external AbortSignal + timeout.
 */

import { spawn } from "node:child_process";
import { systemPromptFor, userMessageFor } from "./prompt.ts";
import { cleanRefinedOutput, looksInvalid } from "./postprocess.ts";
import type { RefineApi, RefineTemplate } from "../config.ts";

export interface RefineOptions {
	baseUrl: string;
	/** "ollama" uses /api/chat with think:false; "openai" uses the
	 * /v1/chat/completions path (llama.cpp server, LM Studio, vLLM…).
	 * Defaults to "ollama". */
	api?: RefineApi;
	model: string;
	template: RefineTemplate;
	temperature: number;
	timeoutSeconds: number;
	glossary: string[];
	signal?: AbortSignal;
}

export interface RefineResult {
	text: string;
	/** Round-trip duration in ms. */
	durationMs: number;
	/** True when the first attempt produced invalid output and we retried. */
	retried: boolean;
}

export class RefinerError extends Error {
	readonly code: string;
	readonly httpStatus?: number;
	constructor(
		message: string,
		code: string,
		httpStatus?: number,
	) {
		super(message);
		this.code = code;
		this.httpStatus = httpStatus;
		this.name = "RefinerError";
	}
}

export async function checkHealth(baseUrl: string, timeoutMs = 3000): Promise<boolean> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(new URL("/api/version", baseUrl), { signal: controller.signal });
		return res.ok;
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}

/** Ensure ollama is running; spawn `ollama serve` detached when allowed. */
export async function ensureOllamaRunning(baseUrl: string, autoStart: boolean): Promise<boolean> {
	if (await checkHealth(baseUrl)) return true;
	if (!autoStart) return false;
	try {
		const child = spawn("ollama", ["serve"], {
			detached: true,
			stdio: "ignore",
		});
		// ENOENT arrives asynchronously as an 'error' event; without a
		// listener it becomes an uncaught exception. Swallow it — the health
		// poll below reports the failure properly.
		child.once("error", () => {});
		child.unref();
	} catch {
		return false;
	}
	// Poll up to 15s for readiness.
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 500));
		if (await checkHealth(baseUrl)) return true;
	}
	return false;
}

interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

/** Single-round chat for internal callers (editor refine etc.). */
export async function llmChat(
	system: string,
	user: string,
	opts: RefineOptions,
): Promise<string> {
	return chatOnce(opts, [
		{ role: "system", content: system },
		{ role: "user", content: user },
	], opts.signal);
}

async function chatOnce(opts: RefineOptions, messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(new Error("timeout")), opts.timeoutSeconds * 1000);
	const onExternalAbort = () => controller.abort(signal?.reason);
	signal?.addEventListener("abort", onExternalAbort, { once: true });
	try {
		const openai = (opts.api ?? "ollama") === "openai";
		// Output cap scales with input length: faithful translation output
		// grows ~linearly with the transcript, so a fixed 800 would truncate
		// long monologues (≈1500+ chars ≈ 6 min of speech). Floor 800 keeps
		// short runs tight; ceiling 3000 bounds runaway generation.
		const transcriptChars = messages.reduce((n, m) => n + (m.role === "user" ? m.content.length : 0), 0);
		const cap = Math.min(3000, Math.max(800, transcriptChars * 3));
		const body: Record<string, unknown> = openai
			? {
					model: opts.model,
					messages,
					temperature: opts.temperature,
					max_tokens: cap,
				}
			: {
					model: opts.model,
					messages,
					stream: false,
					think: false, // qwen3: skip reasoning phase (6x faster, verified)
					options: { temperature: opts.temperature, num_predict: cap },
				};
		let res: Response;
		try {
			res = await fetch(new URL(openai ? "/v1/chat/completions" : "/api/chat", opts.baseUrl), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
				signal: controller.signal,
			});
		} catch (err) {
			const reason = controller.signal.reason instanceof Error ? controller.signal.reason.message : "";
			if (reason === "timeout") throw new RefinerError("Refine request timed out", "TIMEOUT");
			if (signal?.aborted) throw new RefinerError("Refine cancelled", "CANCELLED");
			throw new RefinerError(`Ollama unreachable at ${opts.baseUrl}: ${(err as Error).message}`, "UNREACHABLE");
		}
		if (!res.ok) {
			const detail = (await res.text().catch(() => "")).slice(0, 300);
			if (res.status === 404 && detail.includes("model")) {
				throw new RefinerError(
					`Model "${opts.model}" not found in Ollama. Run: ollama pull ${opts.model}`,
					"MODEL_NOT_FOUND",
					res.status,
				);
			}
			throw new RefinerError(`Ollama HTTP ${res.status}: ${detail}`, "HTTP_ERROR", res.status);
		}
		let data: {
			message?: { content?: string }; // ollama
			choices?: { message?: { content?: string } }[]; // openai-compat
		};
		try {
			data = (await res.json()) as typeof data;
		} catch {
			// 200 with a non-JSON body (proxy/gateway/error page) — wrap it
			// instead of leaking a raw SyntaxError to the pipeline.
			throw new RefinerError("the LLM returned non-JSON content — check that baseUrl points to the correct local service", "INVALID_RESPONSE", res.status);
		}
		const content = data.message?.content ?? data.choices?.[0]?.message?.content ?? "";
		return cleanRefinedOutput(content);
	} finally {
		clearTimeout(timeout);
		signal?.removeEventListener("abort", onExternalAbort);
	}
}

/** Refine a transcript into English instructions via a local LLM. */
export async function refineTranscript(transcript: string, opts: RefineOptions): Promise<RefineResult> {
	const started = Date.now();
	const system = systemPromptFor(opts.template);
	const user = userMessageFor(transcript, opts.glossary);

	let text: string;
	try {
		text = await chatOnce(opts, [
			{ role: "system", content: system },
			{ role: "user", content: user },
		], opts.signal);
	} catch (err) {
		// A TIMEOUT is often just the cold model load; the model is warm now,
		// so retry once with a doubled budget before degrading to raw text.
		if ((err as { code?: string }).code !== "TIMEOUT" || opts.signal?.aborted) throw err;
		text = await chatOnce(
			{ ...opts, timeoutSeconds: opts.timeoutSeconds * 2 },
			[
				{ role: "system", content: system },
				{ role: "user", content: user },
			],
			opts.signal,
		);
	}

	let retried = false;
	if (looksInvalid(text)) {
		retried = true;
		text = await chatOnce(
			opts,
			[
				{ role: "system", content: system },
				{ role: "user", content: user },
				{ role: "assistant", content: text },
				{
					role: "user",
					content: "Invalid output. Output ONLY the refined English instructions, nothing else.",
				},
			],
			opts.signal,
		);
		if (looksInvalid(text)) {
			throw new RefinerError("Refiner returned invalid output twice", "INVALID_OUTPUT");
		}
	}

	return { text, durationMs: Date.now() - started, retried };
}

/** List locally installed ollama models (for the config page picker). */
export async function listOllamaModels(baseUrl: string): Promise<string[]> {
	try {
		const res = await fetch(new URL("/api/tags", baseUrl), {
			signal: AbortSignal.timeout(3000),
		});
		if (!res.ok) return [];
		const data = (await res.json()) as { models?: { name: string }[] };
		return (data.models ?? []).map((m) => m.name).sort();
	} catch {
		return [];
	}
}
