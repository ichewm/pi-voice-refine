/**
 * Pipeline state-machine tests with injected fake recorder/transcriber.
 * The refine leg points at an unreachable loopback port so the degradation
 * path (fallback to raw transcript) is exercised without any real LLM.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VoicePipeline, type PipelineState, type RecorderLike, type TranscriberLike } from "../src/pipeline.ts";
import { configPath } from "../src/config.ts";
import { cleanupTempFile } from "../src/utils.ts";

/** Real temp file (>1KB) so the pipeline's silence heuristic passes. */
function realWavPath(): string {
	const p = join(tmpdir(), `vrefine-fake-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
	writeFileSync(p, Buffer.alloc(4096, 1));
	return p;
}

class FakeRecorder implements RecorderLike {
	elapsedMs = 1000;
	started = false;
	stopCalls = 0;
	killed = false;
	wavPath = realWavPath();
	opts: Parameters<RecorderLike["start"]>[1] | null = null;
	async start(_outPath: string, opts?: Parameters<RecorderLike["start"]>[1]): Promise<void> {
		this.started = true;
		this.opts = opts ?? null;
	}
	async stop(): Promise<string> {
		this.stopCalls += 1;
		this.started = false;
		return this.wavPath;
	}
	kill(): string | null {
		this.killed = true;
		this.started = false;
		return this.wavPath;
	}
}

class FakeTranscriber implements TranscriberLike {
	ready = true;
	transcript = "帮我跑一下 cargo test 看看能不能过";
	initCalls = 0;
	async init(): Promise<unknown> {
		this.initCalls += 1;
		this.ready = true;
		return {};
	}
	transcribe(): string {
		return this.transcript;
	}
	dispose(): void {}
}

interface Harness {
	states: PipelineState[];
	notify: ReturnType<typeof vi.fn>;
	pasted: string[];
	editorText: string;
	pipeline: VoicePipeline;
	recorder: FakeRecorder;
	transcriber: FakeTranscriber;
}

function writeTestConfig(overrides: Record<string, unknown> = {}): void {
	writeFileSync(
		configPath(),
		JSON.stringify({
			capture: { mode: "ondemand", ffmpegPath: "ffmpeg", device: ":0", maxSeconds: 120 },
			refine: {
				baseUrl: "http://127.0.0.1:1", // unreachable loopback → degradation path
				autoStartOllama: false,
				timeoutSeconds: 5,
				model: "qwen3:8b",
				template: "faithful-en",
				temperature: 0.3,
				glossary: [],
			},
			output: { insertMode: "paste", appendTrailingSpace: false },
			...overrides,
		}),
		"utf8",
	);
}

function makeHarness(): Harness {
	const states: PipelineState[] = [];
	const notify = vi.fn();
	const pasted: string[] = [];
	let editorText = "";
	const recorder = new FakeRecorder();
	const transcriber = new FakeTranscriber();
	const pipeline = new VoicePipeline(
		{
			notify,
			setStatus: () => {},
			pasteToEditor: (t: string) => {
				pasted.push(t);
				editorText += t;
			},
			setEditorText: (t: string) => {
				editorText = t;
			},
			getEditorText: () => editorText,
		},
		{ onStateChange: (s) => states.push(s) },
		{ recorder, transcriber },
	);
	return { states, notify, pasted, get editorText() { return editorText; }, pipeline, recorder, transcriber };
}

let agentTmp: string | null = null;

beforeEach(() => {
	agentTmp = mkdtempSync(join(tmpdir(), "vrefine-pipe-"));
	process.env.PI_CODING_AGENT_DIR = agentTmp;
	writeTestConfig();
});

afterEach(() => {
	delete process.env.PI_CODING_AGENT_DIR;
	if (agentTmp) rmSync(agentTmp, { recursive: true, force: true });
	agentTmp = null;
});

describe("VoicePipeline", () => {
	it("raw mode inserts the transcript and returns to IDLE", async () => {
		const h = makeHarness();
		await h.pipeline.toggle("raw");
		h.recorder.opts?.onLevel?.(0.4); // simulate audible speech
		await h.pipeline.toggle("raw"); // stop → transcribe → insert
		expect(h.pasted).toEqual(["帮我跑一下 cargo test 看看能不能过"]);
		expect(h.pipeline.currentState).toBe("IDLE");
		expect(h.states).toEqual(["STARTING", "RECORDING", "TRANSCRIBING", "INSERTED", "IDLE"]);
	});

	it("refine failure degrades to raw transcript with a warning", async () => {
		const h = makeHarness();
		await h.pipeline.toggle("refine");
		h.recorder.opts?.onLevel?.(0.4); // simulate audible speech
		await h.pipeline.toggle("refine");
		expect(h.pasted).toEqual(["帮我跑一下 cargo test 看看能不能过"]);
		const warning = h.notify.mock.calls.find((c) => c[1] === "warning");
		expect(warning?.[0]).toMatch(/Refine failed/);
		expect(h.pipeline.currentState).toBe("IDLE");
	});

	it("second press during STARTING cancels instead of double-starting", async () => {
		const h = makeHarness();
		// Make startup hang (simulates the macOS mic-permission dialog).
		let releaseStart: () => void = () => {};
		h.recorder.start = () =>
			new Promise((resolve) => {
				releaseStart = () => resolve();
			});
		void h.pipeline.toggle("raw");
		expect(h.pipeline.currentState).toBe("STARTING");
		// Second press while still starting → cancel, not a second recording.
		await h.pipeline.toggle("raw");
		expect(h.pipeline.currentState).toBe("IDLE");
		expect(h.recorder.killed).toBe(true);
		releaseStart();
		await new Promise((r) => setTimeout(r, 20));
		// The late startup result must not flip state back or notify an error.
		expect(h.pipeline.currentState).toBe("IDLE");
		expect(h.pasted).toEqual([]);
		expect(h.notify.mock.calls.some((c) => c[1] === "error")).toBe(false);
	});

	it("cancel during RECORDING kills the recorder and notifies", async () => {
		const h = makeHarness();
		await h.pipeline.toggle("refine");
		expect(h.pipeline.currentState).toBe("RECORDING");
		h.pipeline.cancel("Cancelled");
		expect(h.recorder.killed).toBe(true);
		expect(h.pipeline.currentState).toBe("IDLE");
		expect(h.pasted).toEqual([]);
	});

	it("pressing hotkey during TRANSCRIBING aborts instead of double-inserting", async () => {
		const h = makeHarness();
		// Make transcriber.init hang until released (ready=false forces the init path).
		h.transcriber.ready = false;
		let releaseInit: () => void = () => {};
		h.transcriber.init = () =>
			new Promise((resolve) => {
				releaseInit = () => resolve({});
			});
		await h.pipeline.toggle("raw"); // RECORDING
		const processing = h.pipeline.toggle("raw"); // stops → TRANSCRIBING, hangs in init
		await new Promise((r) => setTimeout(r, 20));
		expect(h.pipeline.currentState).toBe("TRANSCRIBING");
		// While busy in processing, another toggle cancels.
		await h.pipeline.toggle("raw");
		expect(h.pipeline.currentState).toBe("IDLE");
		releaseInit();
		await processing;
		expect(h.pasted).toEqual([]); // aborted run must not insert
	});

	it("empty transcript notifies and inserts nothing", async () => {
		const h = makeHarness();
		h.transcriber.transcript = "   ";
		await h.pipeline.toggle("raw");
		await h.pipeline.toggle("raw");
		expect(h.pasted).toEqual([]);
		const warning = h.notify.mock.calls.find((c) => c[1] === "warning");
		expect(warning?.[0]).toMatch(/No speech detected/);
	});

	it("silence gate: quiet recording + short hallucinated text inserts nothing", async () => {
		const h = makeHarness();
		// Simulate a completely quiet recording: no onLevel ticks (peak stays 0).
		h.transcriber.transcript = "그."; // SenseVoice hallucination on silence
		await h.pipeline.toggle("raw");
		await h.pipeline.toggle("raw");
		expect(h.pasted).toEqual([]);
		const warning = h.notify.mock.calls.find((c) => c[1] === "warning");
		expect(warning?.[0]).toMatch(/too quiet|No speech/);
	});

	it("silence gate: quiet recording with long transcript still inserts (never lose real speech)", async () => {
		const h = makeHarness();
		h.transcriber.transcript = "这是一段足够长的识别文本，即使录音音量很低也不应该被静音门禁丢弃";
		await h.pipeline.toggle("raw");
		await h.pipeline.toggle("raw");
		expect(h.pasted.length).toBe(1);
	});

	it("H2: failed run never inserts the PREVIOUS run's transcript", async () => {
		const h = makeHarness();
		// Run 1 succeeds and inserts.
		h.transcriber.transcript = "FIRST RUN: run cargo test";
		await h.pipeline.toggle("raw");
		h.recorder.opts?.onLevel?.(0.4);
		await h.pipeline.toggle("raw");
		expect(h.pasted).toEqual(["FIRST RUN: run cargo test"]);
		// Run 2: transcription throws → must NOT re-insert run 1's text.
		// (Recreate the temp file: run 1's finally deleted it.)
		writeFileSync(h.recorder.wavPath, Buffer.alloc(4096, 1));
		h.transcriber.transcribe = () => {
			throw new Error("asr exploded");
		};
		await h.pipeline.toggle("raw");
		h.recorder.opts?.onLevel?.(0.4);
		await h.pipeline.toggle("raw");
		expect(h.pasted.length).toBe(1); // nothing new inserted
		const error = h.notify.mock.calls.find((c) => c[1] === "error");
		expect(error?.[0]).toMatch(/Transcription failed/);
	});

	it("rapid double-press during stop does not double-fail", async () => {
		const h = makeHarness();
		// Delayed stop: the first toggle is still finalizing when the second lands.
		const origStop = h.recorder.stop.bind(h.recorder);
		h.recorder.stop = () => new Promise((resolve) => setTimeout(() => resolve(origStop()), 60));
		await h.pipeline.toggle("raw");
		h.recorder.opts?.onLevel?.(0.4);
		const first = h.pipeline.toggle("raw");
		await new Promise((r) => setTimeout(r, 10));
		const second = h.pipeline.toggle("raw"); // arrives during stop await
		await Promise.all([first, second]);
		expect(h.pasted).toEqual(["帮我跑一下 cargo test 看看能不能过"]); // exactly one insert
		const error = h.notify.mock.calls.find((c) => c[1] === "error");
		expect(error).toBeUndefined(); // no NOT_RECORDING failure
	});

	it("device death mid-recording salvages buffered audio", async () => {
		const salvagedWav = realWavPath();
		const notify = vi.fn();
		const pasted: string[] = [];
		let editorText = "";
		const fakePersistent = {
			elapsedMs: 1000,
			lastOpts: null as null | { onDeath?: (r: string) => void; onLevel?: (rms: number) => void },
			async start(
				_p: string,
				opts: { onDeath?: (r: string) => void; onLevel?: (rms: number) => void },
			) {
				this.lastOpts = opts;
			},
			async stop() {
				const { RecorderError } = await import("../src/recorder.ts");
				throw new RecorderError("Not recording", "NOT_RECORDING");
			},
			kill: () => null,
			salvagePartial: () => salvagedWav,
		};
		const transcriber = new FakeTranscriber();
		const pipeline = new VoicePipeline(
			{
				notify,
				setStatus: () => {},
				pasteToEditor: (t: string) => pasted.push(t),
				setEditorText: (t: string) => (editorText = t),
				getEditorText: () => editorText,
			},
			{},
			{
				recorder: new FakeRecorder(),
				transcriber,
				persistent: fakePersistent as never,
			},
		);
		writeFileSync(
			configPath(),
			JSON.stringify({
				capture: { mode: "persistent", preWarm: false, ffmpegPath: "ffmpeg", device: ":0", maxSeconds: 120 },
				refine: { baseUrl: "http://127.0.0.1:1", autoStartOllama: false, timeoutSeconds: 5, model: "qwen3:8b", template: "faithful-en", temperature: 0.3, glossary: [] },
				output: { insertMode: "paste", appendTrailingSpace: false },
			}),
			"utf8",
		);
		await pipeline.toggle("raw");
		expect(pipeline.currentState).toBe("RECORDING");
		fakePersistent.lastOpts?.onLevel?.(0.5); // audible speech was captured
		// Simulate the backing process dying mid-recording.
		fakePersistent.lastOpts?.onDeath?.("ffmpeg exited (code=1)");
		await new Promise((r) => setTimeout(r, 50));
		expect(pipeline.currentState).toBe("IDLE");
		expect(pasted.length).toBe(1); // salvaged audio was processed & inserted
		expect(notify.mock.calls.some((c) => c[0].includes("salvaging"))).toBe(true);
		cleanupTempFile(salvagedWav);
	});

	it("REGRESSION: persistent-mode stop routes to the persistent recorder", async () => {
		// The bug: activeRecorder was never set on the persistent path, so stop()
		// hit the on-demand recorder and threw NOT_RECORDING while the persistent
		// one kept recording=true (→ ALREADY_RECORDING on later presses).
		const wav = realWavPath();
		const calls: string[] = [];
		let onLevelCb: ((rms: number) => void) | undefined;
		const fakePersistent = {
			elapsedMs: 1000,
			async start(_p: string, opts: { onDeath?: (r: string) => void; onLevel?: (r: number) => void }) {
				calls.push("start");
				onLevelCb = opts.onLevel;
			},
			async stop() {
				calls.push("stop");
				return wav;
			},
			kill: () => {
				calls.push("kill");
				return null;
			},
			salvagePartial: () => null,
		};
		const notify = vi.fn();
		const pasted: string[] = [];
		let editorText = "";
		const pipeline = new VoicePipeline(
			{
				notify,
				setStatus: () => {},
				pasteToEditor: (t: string) => pasted.push(t),
				setEditorText: (t: string) => (editorText = t),
				getEditorText: () => editorText,
			},
			{},
			{ recorder: new FakeRecorder(), transcriber: new FakeTranscriber(), persistent: fakePersistent as never },
		);
		writeFileSync(
			configPath(),
			JSON.stringify({
				capture: { mode: "persistent", preWarm: false, ffmpegPath: "ffmpeg", device: ":0", maxSeconds: 120 },
				refine: { baseUrl: "http://127.0.0.1:1", autoStartOllama: false, timeoutSeconds: 5, model: "qwen3:8b", template: "faithful-en", temperature: 0.3, glossary: [] },
				output: { insertMode: "paste", appendTrailingSpace: false },
			}),
			"utf8",
		);
		await pipeline.toggle("raw");
		onLevelCb?.(0.5); // audible
		await pipeline.toggle("raw"); // stop → must call PERSISTENT.stop, not on-demand
		expect(calls).toEqual(["start", "stop"]);
		expect(pasted.length).toBe(1);
		expect(notify.mock.calls.some((c) => /NOT_RECORDING|stop failed/.test(c[0]))).toBe(false);
		cleanupTempFile(wav);
	});

	it("dispose cancels active recording", async () => {
		const h = makeHarness();
		await h.pipeline.toggle("refine");
		h.pipeline.dispose();
		expect(h.recorder.killed).toBe(true);
		expect(h.pipeline.currentState).toBe("IDLE");
	});
});

describe("multi-window mic arbitration · activity proxy", () => {
	it("idle sessions release the microphone so other windows can use it", async () => {
		vi.useFakeTimers();
		try {
			writeTestConfig({ capture: { mode: "persistent", preWarm: false, ffmpegPath: "ffmpeg", device: ":0", maxSeconds: 120, idleReleaseSeconds: 10 } });
			const shutdown = vi.fn();
			const fakePersistent = {
				elapsedMs: 0,
				async start() {},
				async stop() { return realWavPath(); },
				kill: () => null,
				salvagePartial: () => null,
				shutdown,
				ensureRunning: async () => {},
			};
			const pipeline = new VoicePipeline(
				{
					notify: () => {},
					setStatus: () => {},
					pasteToEditor: () => {},
					setEditorText: () => {},
					getEditorText: () => "",
				},
				{},
				{ recorder: new FakeRecorder(), transcriber: new FakeTranscriber(), persistent: fakePersistent as never },
			);
			// Simulate terminal activity in this window → holds the mic…
			(pipeline as unknown as { persistent: unknown }).persistent = fakePersistent;
			pipeline.touchActivity();
			vi.advanceTimersByTime(500); // debounce fires
			vi.advanceTimersByTime(6_000); // idle check ticks — still within 10s
			expect(shutdown).not.toHaveBeenCalled();
			// …then the window goes idle past the limit → releases.
			vi.advanceTimersByTime(12_000);
			expect(shutdown).toHaveBeenCalled();
			pipeline.dispose();
		} finally {
			vi.useRealTimers();
		}
	});
});
