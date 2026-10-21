/**
 * Pipeline state machine: RECORDING → TRANSCRIBING → REFINING → INSERTED → IDLE.
 *
 * Guarantees:
 * - Only one run at a time (start() is guarded).
 * - Pressing the hotkey during processing cancels (AbortController).
 * - maxSeconds auto-stop.
 * - Refine failure NEVER loses the transcript: raw text is inserted + warning.
 * - Temp WAV cleaned on success/failure/cancel paths.
 */

import { Recorder, RecorderError, PersistentRecorder, type RecorderLike } from "./recorder.ts";
export type { RecorderLike };
import { Transcriber, TranscriberError } from "./transcriber.ts";
import { refineTranscript, RefinerError, ensureOllamaRunning, checkHealth } from "./refiner/ollama.ts";
import { createStatusView, type StatusView } from "./status.ts";
import { formatForEditor, editorContentForPaste, editorContentForReplace } from "./formatter.ts";
import { cleanupTempFile, isSilentWav, tempWavPath } from "./utils.ts";
import { existsSync } from "node:fs";
import { loadConfig, expandTilde, type PipelineMode } from "./config.ts";

export type PipelineState = "IDLE" | "STARTING" | "RECORDING" | "TRANSCRIBING" | "REFINING" | "INSERTED";

/** UI surface the pipeline needs (satisfied by ExtensionContext in Pi). */
export interface PipelineUI {
	notify(message: string, type?: "info" | "warning" | "error"): void;
	setStatus(key: string, text: string | undefined): void;
	/** Insert at cursor (recommended) — keeps existing editor content. */
	pasteToEditor(text: string): void;
	/** Replace the whole editor content (insertMode: "replace"). */
	setEditorText(text: string): void;
	getEditorText(): string;
}

export interface PipelineEvents {
	onStateChange?: (state: PipelineState) => void;
	/** Diagnostic trace hook (wired to the extension debug log). */
	debug?: (message: string) => void;
}

/** Minimal transcriber surface the pipeline depends on. */
export interface TranscriberLike {
	readonly ready: boolean;
	init(modelDir: string, numThreads?: number): Promise<unknown>;
	transcribe(wavPath: string): string;
	dispose(): void;
}

/** True when the text contains nothing but filler/discourse words. */
export function isFillerOnly(text: string): boolean {
	const stripped = text
		.replace(/[\p{P}\p{S}\s]/gu, "")
		.replace(/呃|嗯|啊|那个|就是|这个|uh|um|er|ah|okay|ok|mm+/gi, "");
	return stripped.length === 0;
}

export class VoicePipeline {
	private recorder: RecorderLike;
	private transcriber: TranscriberLike;
	private state: PipelineState = "IDLE";
	private mode: PipelineMode = "refine";
	private abort: AbortController | null = null;
	private autoStopTimer: ReturnType<typeof setTimeout> | null = null;
	private lastRawTranscript = "";
	private statusView: StatusView;
	private lowLevelTicks = 0;
	private micHintShown = false;
	/** Last terminal-input activity (focus proxy): keystrokes only reach the focused window. */
	private lastActivityAt = 0;
	private idleTimer: ReturnType<typeof setInterval> | null = null;
	private prewarmDebounce: ReturnType<typeof setTimeout> | null = null;
	/** Peak level seen during the current recording (amplified RMS, 0..1). */
	private peakRms = 0;
	private recorderStart = 0;
	/** Recorder the current/last run uses (persistent or on-demand). */
	private activeRecorder: RecorderLike | null = null;
	/** Guards against a second stop entering while the first is finalizing. */
	private stopping = false;
	/** The temp WAV of the run in flight (for salvage / NOT_RECORDING tolerance). */
	private currentWavPath: string | null = null;
	private persistent: PersistentRecorder | null = null;

	private readonly ui: PipelineUI;
	private readonly events: PipelineEvents;

	constructor(
		ui: PipelineUI,
		events: PipelineEvents = {},
		deps: { recorder?: RecorderLike; transcriber?: TranscriberLike; persistent?: PersistentRecorder } = {},
	) {
		this.ui = ui;
		this.events = events;
		this.deps = deps;
		this.statusView = createStatusView(ui.setStatus.bind(ui));
		this.recorder = deps.recorder ?? new Recorder();
		this.transcriber = deps.transcriber ?? new Transcriber();
	}

	private readonly deps: { recorder?: RecorderLike; transcriber?: TranscriberLike; persistent?: PersistentRecorder };

/** Pre-warm the persistent capture so the first press is instant.
 * Fire-and-forget: failures surface at press time instead. */
	prepare(): void {
		const cfg = loadConfig();
		if (cfg.capture.mode !== "persistent" || !cfg.capture.preWarm) return;
		if (process.platform !== "darwin") return; // persistent is macOS-only
		void this.getOrCreatePersistent(cfg)
			.ensureRunning({
				ffmpegPath: cfg.capture.ffmpegPath,
				device: cfg.capture.device,
				deviceName: cfg.capture.deviceName,
				sampleRate: cfg.capture.sampleRate,
				channels: cfg.capture.channels,
				onLevel: (rms) => this.handleLevel(rms),
				onDeath: (reason) => this.handleRecorderDeath(reason),
			})
			.catch(() => {
				/* surfacing here would be noise; the press path reports real errors */
			});
		this.ensureIdleWatch();
	}

	/**
	 * Terminal input arrived in THIS Pi session — keystrokes only reach the
	 * focused window, so activity is a reliable focus proxy. Refreshes the
	 * hold on the microphone and (debounced) pre-warms so the next press is
	 * instant. Multiple Pi windows coexist: only the one being used holds it.
	 */
	touchActivity(kind: "input" | "event" = "input"): void {
		this.lastActivityAt = Date.now();
		if (kind === "event") {
			// Voice runs produce no keystrokes while the user is speaking;
			// without this refresh the idle countdown would eat the speaking
			// time and release the mic seconds after processing finishes.
			this.ensureIdleWatch();
			return;
		}
		const cfg = loadConfig();
		if (cfg.capture.mode !== "persistent" && this.prewarmDebounce === null) return;
		if (this.prewarmDebounce) return;
		this.prewarmDebounce = setTimeout(() => {
			this.prewarmDebounce = null;
			if (this.state === "IDLE") this.prepare();
			else this.ensureIdleWatch();
		}, 400);
		this.ensureIdleWatch();
	}

	/** Watch for idle: release the microphone when this session stops being used. */
	private ensureIdleWatch(): void {
		if (this.idleTimer) return;
		this.idleTimer = setInterval(() => {
			const cfg = loadConfig();
			const active = Date.now() - this.lastActivityAt;
			const busy = this.state !== "IDLE";
			if (!busy && this.persistent !== null && active > cfg.capture.idleReleaseSeconds * 1000) {
				this.events.debug?.("idle: releasing microphone");
				this.persistent?.shutdown();
				this.persistent = null;
			}
		}, 5_000);
	}

	private getOrCreatePersistent(_cfg: ReturnType<typeof loadConfig>): PersistentRecorder {
		if (!this.persistent) this.persistent = this.deps.persistent ?? new PersistentRecorder();
		return this.persistent;
	}

	/** The persistent mic's backing process died mid-run: salvage what we have. */
	private handleRecorderDeath(reason: string): void {
		if (this.state !== "RECORDING" && this.state !== "STARTING") {
			// Not an active capture (e.g. death raced a stop) — just make sure
			// the recorder never keeps a stale recording flag.
			this.persistent?.kill();
			return;
		}
		this.events.debug?.(`recorder death: ${reason.slice(0, 60)}`);
		if (reason.startsWith("zero-signal")) {
			// The buffered audio is pure zeros — nothing to salvage. The
			// recorder already restarted itself; tell the user to speak again.
			this.ui.notify("🎤 No microphone signal — the device is held by another process (another running Pi session?) or hardware-muted. Capture restarted automatically. Close unused Pi sessions, confirm the mic is not muted, then press the hotkey again.", "warning");
			this.reset();
			return;
		}
		const salvaged = this.persistent?.salvagePartial(tempWavPath());
		if (salvaged) {
			this.ui.notify(`⚠️ Microphone device lost (${reason}) — salvaging captured audio…`, "warning");
			this.currentWavPath = salvaged;
			void this.processWav(salvaged).finally(() => this.reset());
		} else {
			this.ui.notify(
				`❌ Microphone device lost (${reason}) — recording aborted. Press the hotkey to restart it.`,
				"error",
			);
			this.reset();
		}
	}

	get currentState(): PipelineState {
		return this.state;
	}

	get currentMode(): PipelineMode {
		return this.mode;
	}

	get lastTranscript(): string {
		return this.lastRawTranscript;
	}

	get transcriberRef(): TranscriberLike {
		return this.transcriber;
	}

	private setState(state: PipelineState): void {
		this.state = state;
		this.events.debug?.(`state: ${this.state}`);
		this.events.onStateChange?.(state);
	}

	/** Hotkey/command entry point. Behavior depends on current state. */
	async toggle(mode: PipelineMode): Promise<void> {
		switch (this.state) {
			case "IDLE":
				await this.start(mode);
				break;
			case "STARTING":
				// Microphone still warming up (e.g. macOS permission dialog):
				// a second press cancels instead of starting a duplicate run.
				this.cancel("Cancelled before recording started");
				break;
			case "RECORDING":
				await this.stopAndProcess();
				break;
			case "TRANSCRIBING":
			case "REFINING":
				// A press while the stop is still finalizing is almost always a
				// double-tap — ignore it rather than cancelling (which would
				// discard the recording). Cancelling real processing stays
				// possible once finalization finished.
				if (this.stopping) break;
				this.cancel("Processing cancelled");
				break;
			case "INSERTED":
				break;
		}
	}

	private handleLevel(rms: number): void {
		// The persistent mic streams levels even while idle — only render (and
		// track peak) while a run is actually starting/recording.
		if (this.state !== "RECORDING" && this.state !== "STARTING") return;
		if (rms < 0.02) {
			this.lowLevelTicks = Math.min(this.lowLevelTicks + 1, 20);
		} else {
			this.lowLevelTicks = 0;
		}
		if (this.lowLevelTicks >= 10) this.statusView.setRecordingMuted(this.elapsed());
		else this.statusView.setRecording(this.elapsed(), rms);
		if (rms > this.peakRms) this.peakRms = rms;
	}

	private elapsed(): number {
		return this.state === "RECORDING" ? Date.now() - this.recorderStart : this.recorder.elapsedMs;
	}

	private async start(mode: PipelineMode): Promise<void> {
		const cfg = loadConfig();
		this.mode = mode;
		this.abort = new AbortController();
		const wavPath = tempWavPath();

		// Instant visual feedback the moment the key is pressed, and mark the
		// run as STARTING so a second press cancels rather than double-starts
		// (macOS may block up to 20s on the first-use mic permission dialog).
		this.statusView.setStarting();
		this.setState("STARTING");
		this.peakRms = 0;
		this.recorderStart = Date.now();
		this.lastRawTranscript = ""; // never leak a previous run's transcript
		this.currentWavPath = wavPath;

		// Zero-latency path: persistent recorder (mic already open).
		// Persistent capture is avfoundation-based → macOS only; other
		// platforms silently fall back to on-demand recording.
		if (cfg.capture.mode === "persistent" && process.platform === "darwin") {
			const persistent = this.getOrCreatePersistent(cfg);
			try {
				await persistent.start(wavPath, {
					ffmpegPath: cfg.capture.ffmpegPath,
					device: cfg.capture.device,
					deviceName: cfg.capture.deviceName,
					sampleRate: cfg.capture.sampleRate,
					channels: cfg.capture.channels,
					maxSeconds: cfg.capture.maxSeconds,
					onLevel: (rms) => this.handleLevel(rms),
					onDeath: (reason) => this.handleRecorderDeath(reason),
				});
				if (this.abort === null) {
					// Cancelled while waiting for the device — do not resurrect.
					persistent.kill();
					cleanupTempFile(wavPath);
					this.reset();
					return;
				}
				this.activeRecorder = persistent;
			} catch (err) {
				cleanupTempFile(wavPath);
				if (this.abort === null) {
					this.reset();
					return;
				}
				this.fail(err, "Could not start recording");
				return;
			}
			this.setState("RECORDING");
			this.lowLevelTicks = 0;
			this.autoStopTimer = setTimeout(() => {
				if (this.state === "RECORDING") {
					this.ui.notify(`Max recording time reached (${cfg.capture.maxSeconds}s), processing…`, "info");
					void this.stopAndProcess();
				}
			}, cfg.capture.maxSeconds * 1000);
			return;
		}

		try {
			await this.recorder.start(wavPath, {
				ffmpegPath: cfg.capture.ffmpegPath,
				device: cfg.capture.device,
				deviceName: cfg.capture.deviceName,
				sampleRate: cfg.capture.sampleRate,
				channels: cfg.capture.channels,
				maxSeconds: cfg.capture.maxSeconds,
				onSlowStart: () => {
					// USB audio devices can take 3-6s to open even when permission is
					// granted — warn at most once per session so this isn't noise.
					if (this.micHintShown) return;
					this.micHintShown = true;
					this.ui.notify(
						"🎙 waiting for microphone… if macOS asked for mic permission, click Allow (System Settings → Privacy & Security → Microphone).",
						"warning",
					);
				},
				onLevel: (rms) => this.handleLevel(rms),
			});
			if (this.abort === null) {
				// Cancelled while starting (second press / Esc): the recorder was
				// already killed by cancel(); do not resurrect this run.
				cleanupTempFile(wavPath);
				this.reset();
				return;
			}
			this.activeRecorder = this.recorder;
		} catch (err) {
			cleanupTempFile(wavPath);
			// User pressed again / Esc during startup — cancel() already nulled
			// the abort controller; stay silent instead of showing a stale error.
			if (this.abort === null) {
				this.reset();
				return;
			}
			this.fail(err, "Could not start recording");
			return;
		}

		this.setState("RECORDING");
		this.lowLevelTicks = 0;

		// Auto-stop at maxSeconds.
		this.autoStopTimer = setTimeout(() => {
			if (this.state === "RECORDING") {
				this.ui.notify(`Max recording time reached (${cfg.capture.maxSeconds}s), processing…`, "info");
				void this.stopAndProcess();
			}
		}, cfg.capture.maxSeconds * 1000);
	}

	/** Stop recording, then ASR (+ refine in refine mode), then insert. */
	private async stopAndProcess(): Promise<void> {
		if (this.stopping) {
			this.events.debug?.("stop debounced (already finalizing)");
			return;
		}
		this.stopping = true;
		this.events.debug?.("stopAndProcess enter");
		if (this.autoStopTimer) {
			clearTimeout(this.autoStopTimer);
			this.autoStopTimer = null;
		}

		// Claim TRANSCRIBING BEFORE awaiting stop() so a second press (or the
		// auto-stop timer racing a manual press) cancels instead of double-stopping.
		this.setState("TRANSCRIBING");
		this.statusView.setTranscribing();

		let wavPath: string | null = null;
		try {
			wavPath = (await (this.activeRecorder ?? this.recorder).stop()) as string;
			this.events.debug?.("stop ok");
		} catch (err) {
			// The backing process can die mid-recording (device loss): its exit
			// clears the recorder's flag before our stop lands. If the run's WAV
			// already exists, continue with the captured audio instead of failing.
			const code = (err as { code?: string }).code;
			this.events.debug?.(`stop threw ${code}`);
			if (code === "NOT_RECORDING" && this.currentWavPath && existsSync(this.currentWavPath)) {
				wavPath = this.currentWavPath;
				this.ui.notify("Recording had already stopped — continuing with captured audio.", "info");
			} else if (code === "NO_OUTPUT") {
				// Stopped almost instantly (<~30ms of audio): nothing to process.
				this.ui.notify("Recording was too short to capture anything. Press the hotkey and speak again.", "warning");
				this.reset();
				return;
			} else {
				this.fail(err, "Recording stop failed");
				return;
			}
		}

		if (!wavPath) {
			this.reset();
			return;
		}

		// Finalization done — a press from here on cancels processing again.
		this.stopping = false;
		await this.processWav(wavPath);
	}

	/** Transcribe → (refine) → insert for a finalized WAV. */
	private async processWav(wavPath: string): Promise<void> {
		const cfg = loadConfig();
		const signal = this.abort?.signal ?? new AbortController().signal;

		try {
			// Lazy-init the transcriber (also picks up a newly downloaded model).
			if (!this.transcriber.ready) {
				await this.transcriber.init(expandTilde(cfg.asr.modelPath));
				if (signal.aborted) {
					this.cancel("Cancelled");
					return;
				}
			}

			if (isSilentWav(wavPath)) {
				this.ui.notify("Recording appears silent — nothing to transcribe.", "warning");
				this.reset();
				return;
			}

			const raw = this.transcriber.transcribe(wavPath).trim();
			this.lastRawTranscript = raw;
			// Silence gate: with near-silent audio SenseVoice can hallucinate short
			// garbage text (observed: Korean chars). If the whole recording was
			// extremely quiet AND the text is short, treat it as no speech.
			if (this.peakRms < 0.01 && raw.length < 30) {
				this.ui.notify("No speech detected (recording too quiet).", "warning");
				this.reset();
				return;
			}
			// SenseVoice emits "." (or bare punctuation) for near-silence.
			const hasContent = raw.replace(/[\p{P}\p{S}\s]/gu, "").length > 0;
			if (!hasContent) {
				this.ui.notify("No speech detected in recording.", "warning");
				this.reset();
				return;
			}

			if (this.mode === "raw" || signal.aborted) {
				this.insert(raw);
				this.touchActivity("event");
				this.reset();
				return;
			}

			this.setState("REFINING");
			this.statusView.setRefining(cfg.refine.model);

			const running = await checkHealth(cfg.refine.baseUrl);
			if (!running) {
				if (cfg.refine.autoStartOllama) {
					this.ui.notify("Starting local Ollama…", "info");
				}
				const ok = await ensureOllamaRunning(cfg.refine.baseUrl, cfg.refine.autoStartOllama);
				if (!ok) throw new RefinerError("Ollama not running and auto-start failed", "UNREACHABLE");
			}

			// Language routing: polish-zh is for Chinese speech; an English-only
			// transcript routes to faithful-en so it stays English (cleaned).
			const hasCJK = /[\u4e00-\u9fff]/.test(raw);
			const effectiveTemplate = cfg.refine.template === "polish-zh" && !hasCJK ? "faithful-en" : cfg.refine.template;
			if (effectiveTemplate !== cfg.refine.template) {
				this.events.debug?.("route: polish-zh × English input → faithful-en");
			}
			const result = await refineTranscript(raw, {
				api: cfg.refine.api,
				baseUrl: cfg.refine.baseUrl,
				model: cfg.refine.model,
				template: effectiveTemplate,
				temperature: cfg.refine.temperature,
				timeoutSeconds: cfg.refine.timeoutSeconds,
				glossary: cfg.refine.glossary,
				signal,
			});

			if (isFillerOnly(result.text)) {
				// The speech was all disfluencies ("呃呃呃") — nothing worth inserting.
				this.ui.notify("No usable content was captured (only filler syllables). Press the hotkey and speak again.", "warning");
				this.reset();
				return;
			}
			this.insert(result.text);
			this.touchActivity("event");
			this.statusView.setDone(`🎙 refined in ${(result.durationMs / 1000).toFixed(1)}s`);
			setTimeout(() => {
				if (this.state === "IDLE") this.statusView.clear();
			}, 4000);
			this.reset(false); // keep status text for a few seconds
		} catch (err) {
			// Degradation path: never lose the transcript.
			if (signal.aborted) {
				this.cancel("Cancelled");
				return;
			}
			const reason = err instanceof RefinerError ? err.message : (err as Error).message;
			if (this.lastRawTranscript) {
				this.insert(this.lastRawTranscript);
				this.ui.notify(`Refine failed (${reason}) — inserted raw transcript instead.`, "warning");
			} else {
				this.ui.notify(`Transcription failed: ${reason}`, "error");
			}
			this.reset();
		} finally {
			cleanupTempFile(wavPath);
		}
	}

	private insert(text: string): void {
		const cfg = loadConfig();
		const formatted = formatForEditor(text, cfg.output);
		if (cfg.output.insertMode === "replace") {
			this.ui.setEditorText(formatted.trim());
		} else {
			// pasteToEditor inserts at the cursor in Pi; compute fallback content
			// for hosts without paste semantics.
			const current = this.ui.getEditorText();
			const next = editorContentForPaste(current, formatted);
			this.ui.pasteToEditor(formatted);
			// Defensive: if paste did not change the editor (host limitation), set it.
			setTimeout(() => {
				try {
					if (this.ui.getEditorText() === current && current !== next) {
						this.ui.setEditorText(next);
					}
				} catch {
					/* ignore */
				}
			}, 50);
		}
		this.setState("INSERTED");
		this.ui.notify(this.mode === "raw" ? "🎙 transcript inserted" : "🎙 refined instruction inserted", "info");
	}

	/** Cancel recording or processing; cleanup temp artifacts. */
	cancel(reason = "Cancelled"): void {
		// A stop is finalizing this run — cancelling now would reset the state
		// machine to IDLE while the recorder still closes, desyncing both.
		if (this.stopping) {
			this.events.debug?.("cancel ignored (finalizing)");
			return;
		}
		this.events.debug?.(`cancel: ${reason}`);
		if (this.autoStopTimer) {
			clearTimeout(this.autoStopTimer);
			this.autoStopTimer = null;
		}
		const wav = (this.activeRecorder ?? this.recorder).kill();
		cleanupTempFile(wav);
		this.abort?.abort(new Error("user-cancelled"));
		this.abort = null;
		if (this.state !== "IDLE") this.ui.notify(`${reason}.`, "info");
		this.reset();
	}

	private fail(err: unknown, prefix: string): void {
		const detail =
			err instanceof RecorderError || err instanceof TranscriberError || err instanceof RefinerError
				? `${err.message} [${err.code}]`
				: (err as Error).message;
		this.ui.notify(`${prefix}: ${detail}`, "error");
		this.reset();
	}

	private reset(clearStatus = true): void {
		this.setState("IDLE");
		this.abort = null;
		this.stopping = false;
		this.currentWavPath = null;
		if (clearStatus) this.statusView.clear();
	}

	/** Session shutdown: release model memory and any live recording. */
	dispose(): void {
		this.cancel("Session shutdown");
		this.transcriber.dispose();
		this.persistent?.shutdown();
		this.persistent = null;
		if (this.idleTimer) {
			clearInterval(this.idleTimer);
			this.idleTimer = null;
		}
		if (this.prewarmDebounce) {
			clearTimeout(this.prewarmDebounce);
			this.prewarmDebounce = null;
		}
	}
}
