/**
 * End-to-end verification (no Pi required):
 *   say → wav(16k mono) → SenseVoice transcribe → Ollama refine
 *
 * Usage: node --experimental-strip-types scripts/e2e.ts [text-to-speak]
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const text =
	process.argv[2] ?? "你先看一下这个合约为什么 staking 的时候奖励算错了，不要直接改代码，先分析一下问题在哪里";

const dir = mkdtempSync(join(tmpdir(), "vrefine-e2e-"));
const aiff = join(dir, "speech.aiff");
const wav = join(dir, "speech.wav");

try {
	// 1. Synthesize speech (macOS say).
	const voice = process.env.E2E_VOICE ?? "";
	execFileSync("say", voice ? ["-v", voice, "-o", aiff, text] : ["-o", aiff, text]);
	// 2. Convert to 16kHz mono s16 WAV (same as recorder output).
	execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", aiff, "-ar", "16000", "-ac", "1", "-sample_fmt", "s16", wav]);
	console.log(`[e2e] audio ready (${text.length} chars text)`);

	// 3. Transcribe.
	const { Transcriber } = await import("../src/transcriber.ts");
	const { loadConfig, expandTilde } = await import("../src/config.ts");
	const cfg = loadConfig();
	const t0 = Date.now();
	const transcriber = new Transcriber();
	await transcriber.init(expandTilde(cfg.asr.modelPath));
	const loadMs = Date.now() - t0;
	const t1 = Date.now();
	const transcript = transcriber.transcribe(wav);
	const asrMs = Date.now() - t1;
	console.log(`[e2e] model load: ${(loadMs / 1000).toFixed(2)}s, transcribe: ${(asrMs / 1000).toFixed(2)}s`);
	console.log(`[e2e] transcript: ${transcript}`);
	if (!transcript) {
		console.error("[e2e] FAIL: empty transcript");
		process.exitCode = 1;
	}

	// 4. Refine via local Ollama.
	const { refineTranscript, ensureOllamaRunning } = await import("../src/refiner/ollama.ts");
	const ok = await ensureOllamaRunning(cfg.refine.baseUrl, cfg.refine.autoStartOllama);
	if (!ok) {
		console.error("[e2e] FAIL: ollama not reachable");
		process.exitCode = 1;
	} else {
		const result = await refineTranscript(transcript, {
			baseUrl: cfg.refine.baseUrl,
			model: cfg.refine.model,
			template: cfg.refine.template,
			temperature: cfg.refine.temperature,
			timeoutSeconds: cfg.refine.timeoutSeconds,
			glossary: cfg.refine.glossary,
		});
		console.log(`[e2e] refine (${(result.durationMs / 1000).toFixed(1)}s): ${result.text}`);
	}

	transcriber.dispose();
} catch (err) {
	console.error(`[e2e] FAIL: ${(err as Error).stack ?? err}`);
	process.exitCode = 1;
} finally {
	rmSync(dir, { recursive: true, force: true });
}
