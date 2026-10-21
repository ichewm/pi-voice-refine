/**
 * Cross-platform microphone capture via ffmpeg → 16kHz mono WAV.
 *
 * Start() spawns ffmpeg; stop() asks it to finalize gracefully (send "q" on
 * stdin, then SIGINT as fallback) so the WAV header is written correctly.
 * A watcher reads the growing file tail to feed the level meter.
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync, openSync, readSync, closeSync, statSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import type { Writable } from "node:stream";

/** ffmpeg process with stdin (pipe), stdout (ignored), stderr (pipe). */
type FfmpegProcess = ChildProcessByStdio<Writable, null, import("node:stream").Readable>;

export interface RecorderOptions {
	ffmpegPath: string;
	/** macOS avfoundation device index string (":0"). Empty = auto ":0". */
	device: string;
	/** Preferred device NAME (stable across index drift), e.g. "USB Audio Device". */
	deviceName?: string;
	sampleRate: number;
	channels: number;
	maxSeconds: number;
	/** Called with normalized RMS 0..1 roughly every intervalMs while recording. */
	onLevel?: (rms: number) => void;
	levelIntervalMs?: number;
	/** Called once if startup is slow (likely macOS mic-permission dialog). */
	onSlowStart?: () => void;
	/** Persistent mode only: the backing process died unexpectedly. */
	onDeath?: (reason: string) => void;
}

const WAV_HEADER_BYTES = 44;

function buildArgs(opts: RecorderOptions, outPath: string): string[] {
	const device = opts.device || ":0";
	const common = [
		"-hide_banner",
		"-loglevel",
		"error",
		"-y",
	];
	const input: string[] = [];
	switch (platform()) {
		case "darwin":
			input.push("-f", "avfoundation", "-i", device);
			break;
		case "win32":
			input.push("-f", "dshow", "-i", opts.device || "audio=Microphone");
			break;
		default:
			// Linux: pulse/alsa default device.
			input.push("-f", "pulse", "-i", opts.device || "default");
			break;
	}
	return [
		...common,
		...input,
		"-ar",
		String(opts.sampleRate),
		"-ac",
		String(opts.channels),
		"-sample_fmt",
		"s16",
		"-f",
		"wav",
		outPath,
	];
}

export class RecorderError extends Error {
	readonly code: string;
	constructor(
		message: string,
		code: string,
	) {
		super(message);
		this.code = code;
		this.name = "RecorderError";
	}
}

export class Recorder {
	private resolvedDevice = "";

	/** Last device string actually used (for diagnostics). */
	get lastDevice(): string {
		return this.resolvedDevice;
	}
	private proc: FfmpegProcess | null = null;
	private outPath: string | null = null;
	private levelTimer: ReturnType<typeof setInterval> | null = null;
	private levelFd: number | null = null;
	private stderrTail = "";
	private startedAt = 0;

	get recording(): boolean {
		return this.proc !== null;
	}

	get elapsedMs(): number {
		return this.startedAt ? Date.now() - this.startedAt : 0;
	}

	get outputPath(): string | null {
		return this.outPath;
	}

	async start(outPath: string, opts: RecorderOptions): Promise<void> {
		if (this.proc) throw new RecorderError("Recording already in progress", "ALREADY_RECORDING");

		const ffmpeg = opts.ffmpegPath || "ffmpeg";
		// Name-based resolution is avfoundation (macOS) only — dshow/pulse take
		// their own device syntax, so pass the user string through as-is.
		this.resolvedDevice =
			platform() === "darwin"
				? await resolveDevice(ffmpeg, opts.device, opts.deviceName ?? "")
				: opts.device;
		const args = buildArgs({ ...opts, device: this.resolvedDevice || ":0" }, outPath);
		let proc: FfmpegProcess;
		try {
			proc = spawn(ffmpeg, args, { stdio: ["pipe", "ignore", "pipe"] }) as FfmpegProcess;
		} catch (err) {
			throw new RecorderError(
				`Failed to launch ffmpeg at "${ffmpeg}": ${(err as Error).message}`,
				"SPAWN_FAILED",
			);
		}

		this.proc = proc;
		this.outPath = outPath;
		this.stderrTail = "";
		// 'q' written at stop can EPIPE if ffmpeg died first — never crash on it.
		proc.stdin.on("error", () => {});
		this.startedAt = Date.now();

		proc.stderr.setEncoding("utf8");
		proc.stderr.on("data", (chunk: string) => {
			this.stderrTail = (this.stderrTail + chunk).slice(-2000);
		});

		// Wait until ffmpeg has created the output file (device open succeeded),
		// or the process died (bad device / no permission).
		// macOS shows a TCC mic-permission dialog on first use; the dialog blocks
		// avfoundation, so allow a generous window and tell the user what's up.
		const START_TIMEOUT_MS = 20_000;
		let slowStartNotified = false;
		await new Promise<void>((resolve, reject) => {
			const startupTimer = setInterval(() => {
				if (existsSync(outPath) && statSync(outPath).size > WAV_HEADER_BYTES - 1) {
					clearInterval(startupTimer);
					clearTimeout(giveUp);
					clearTimeout(slowStart);
					resolve();
				}
			}, 80);
			const slowStart = setTimeout(() => {
				slowStartNotified = true;
				opts.onSlowStart?.();
			}, 6000);
			const giveUp = setTimeout(() => {
				clearInterval(startupTimer);
				clearTimeout(slowStart);
				reject(
					new RecorderError(
						`ffmpeg did not start writing audio within ${START_TIMEOUT_MS / 1000}s` +
						(slowStartNotified
							? " — if a microphone permission dialog appeared, click Allow and try again. Otherwise check the audio device (/vrefine devices)"
						: `. stderr: ${this.stderrTail.trim() || "(none)"}`),
						"START_TIMEOUT",
					),
				);
			}, START_TIMEOUT_MS);
			proc.once("exit", (code, signal) => {
				clearInterval(startupTimer);
				clearTimeout(giveUp);
				clearTimeout(slowStart);
				reject(
					new RecorderError(
						`ffmpeg exited during startup (code=${code} signal=${signal})` +
							`. If macOS denied microphone access, allow it in System Settings → Privacy & Security → Microphone for your terminal app. stderr: ${this.stderrTail.trim() || "(none)"}`,
						"EARLY_EXIT",
					),
				);
			});
			proc.once("error", (err) => {
				clearInterval(startupTimer);
				clearTimeout(giveUp);
				clearTimeout(slowStart);
				reject(new RecorderError(`ffmpeg spawn error: ${err.message}`, "SPAWN_FAILED"));
			});
		});

		proc.removeAllListeners("exit");
		proc.once("exit", () => {
			// Identity-guard: a superseded (killed) process must not clear the
			// reference of a newer recording started afterwards.
			if (this.proc === proc) {
				this.stopLevelMeter();
				this.proc = null;
			}
		});

		this.startLevelMeter(opts);
	}

	/** Stop recording and finalize the WAV. Resolves with the file path. */
	async stop(): Promise<string> {
		const proc = this.proc;
		if (!proc || !this.outPath) throw new RecorderError("Not recording", "NOT_RECORDING");
		const path = this.outPath;
		this.stopLevelMeter();

		await new Promise<void>((resolve) => {
			const done = () => resolve();
			proc.once("exit", done);
			// Graceful: 'q' makes ffmpeg finalize the container and exit cleanly.
			proc.stdin.write("q");
			setTimeout(() => {
				if (proc.exitCode === null && proc.signalCode === null) {
					proc.kill("SIGINT");
				}
			}, 1500);
			setTimeout(() => {
				if (proc.exitCode === null && proc.signalCode === null) {
					proc.kill("SIGKILL");
				}
				resolve();
			}, 4000);
			// 'exit' listener above resolves; the timers resolve regardless so we never hang.
			setTimeout(done, 4500);
		});

		this.proc = null;
		if (!existsSync(path)) {
			throw new RecorderError(
				`Recording file missing after stop: ${path}. stderr: ${this.stderrTail.trim() || "(none)"}`,
				"NO_OUTPUT",
			);
		}
		return path;
	}

	/** Hard-kill; used on cancel. Returns the (possibly partial) path or null. */
	kill(): string | null {
		const proc = this.proc;
		const path = this.outPath;
		this.stopLevelMeter();
		if (proc) {
			try {
				proc.stdin.destroy();
			} catch {
				/* ignore */
			}
			proc.kill("SIGKILL");
			this.proc = null;
		}
		return path;
	}

	private startLevelMeter(opts: RecorderOptions): void {
		if (!opts.onLevel) return;
		const onLevel = opts.onLevel;
		const interval = opts.levelIntervalMs ?? 150;
		const buf = Buffer.alloc(3200); // ~100ms of 16k mono s16
		this.levelTimer = setInterval(() => {
			if (!this.outPath || !existsSync(this.outPath)) return;
			try {
				if (this.levelFd === null) this.levelFd = openSync(this.outPath, "r");
				const size = statSync(this.outPath).size;
				const start = Math.max(WAV_HEADER_BYTES, size - buf.length);
				const bytesRead = readSync(this.levelFd, buf, 0, Math.min(buf.length, size - start), start);
				if (bytesRead <= 1) return;
				let sumSquares = 0;
				for (let i = 0; i + 1 < bytesRead; i += 2) {
					const sample = buf.readInt16LE(i);
					sumSquares += (sample * sample) / (32768 * 32768);
				}
				const rms = Math.sqrt(sumSquares / Math.max(1, bytesRead / 2));
				onLevel(Math.min(1, rms * 4)); // amplify for visibility
			} catch {
				/* file might be mid-write; skip tick */
			}
		}, interval);
	}

	private stopLevelMeter(): void {
		if (this.levelTimer) clearInterval(this.levelTimer);
		this.levelTimer = null;
		if (this.levelFd !== null) {
			try {
				closeSync(this.levelFd);
			} catch {
				/* ignore */
			}
			this.levelFd = null;
		}
	}
}

/** Minimal recorder surface the pipeline depends on (injectable for tests). */
export interface RecorderLike {
	readonly elapsedMs: number;
	start(outPath: string, opts: RecorderOptions): Promise<void>;
	stop(): Promise<string>;
	kill(): string | null;
}

/* ---------------------------------------------------------------------- */
/* Persistent (zero-latency) capture                                      */
/* ---------------------------------------------------------------------- */

/** Parsed audio input device list entry. */
export interface AudioDevice {
	index: number;
	name: string;
}

/** Parse `ffmpeg -f avfoundation -list_devices` stderr into audio devices. */
export function parseAudioDevices(output: string): AudioDevice[] {
	const audioSection = output.slice(Math.max(0, output.indexOf("audio devices")));
	return [...audioSection.matchAll(/\[(\d+)\] (.+)$/gm)]
		.map((m) => ({ index: Number(m[1]), name: m[2].trim() }))
		.filter((d) => Number.isInteger(d.index));
}

/** Virtual loopback drivers that capture silence unless fed — never pick. */
const VIRTUAL_DEVICE_RE = /morphvox|vb-?cable|blackhole|loopback|soundflower|aggregate|virtual/i;

/** Choose the avfoundation index: explicit device > deviceName match > first non-virtual. */
export function pickDeviceIndex(devices: AudioDevice[], device: string, deviceName: string): number {
	if (/^:\d+$/.test(device)) return Number(device.slice(1));
	const wanted = deviceName.trim().toLowerCase();
	if (wanted) {
		const hit = devices.find((d) => d.name.toLowerCase() === wanted);
		if (hit) return hit.index;
		const partial = devices.find((d) => d.name.toLowerCase().includes(wanted));
		if (partial) return partial.index;
	}
	const real = devices.find((d) => !VIRTUAL_DEVICE_RE.test(d.name));
	return real ? real.index : (devices[0]?.index ?? 0);
}

/** Enumerate avfoundation audio inputs. macOS only. */
export async function listAudioDevices(ffmpegPath: string): Promise<AudioDevice[]> {
	const out = await new Promise<string>((resolve, reject) => {
		const child = spawn(ffmpegPath, ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let text = "";
		// Hard timeout: a wedged ffmpeg must not hang recording startup forever.
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			// Destroy the pipes too: an orphaned grandchild can keep the
			// stream (and a draining event loop) open indefinitely.
			child.stdout?.destroy();
			child.stderr?.destroy();
			reject(new Error("device enumeration timed out"));
		}, 5000);
		child.stderr.on("data", (c: Buffer) => (text += c));
		child.stdout.on("data", (c: Buffer) => (text += c));
		child.once("exit", () => {
			clearTimeout(timer);
			resolve(text);
		});
		child.once("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
	return parseAudioDevices(out);
}

/** Resolve the concrete ":N" device string, immune to index drift. */
export async function resolveDevice(ffmpegPath: string, device: string, deviceName: string): Promise<string> {
	if (/^:\d+$/.test(device.trim())) return device.trim();
	try {
		const devices = await listAudioDevices(ffmpegPath);
		if (devices.length > 0) return `:${pickDeviceIndex(devices, device, deviceName)}`;
	} catch {
		/* fall through */
	}
	return device.trim() || ":0";
}

/** True when every s16le sample in the buffer is exactly zero. */
export function isAllZero(buf: Buffer): boolean {
	for (let i = 0; i + 1 < buf.length; i += 2) {
		if (buf.readInt16LE(i) !== 0) return false;
	}
	return true;
}

/** Build a 44-byte PCM WAV header for s16le mono data. */
export function wavHeader(dataBytes: number, sampleRate = 16000, channels = 1): Buffer {
	const h = Buffer.alloc(44);
	h.write("RIFF", 0);
	h.writeUInt32LE(36 + dataBytes, 4);
	h.write("WAVE", 8);
	h.write("fmt ", 12);
	h.writeUInt32LE(16, 16);
	h.writeUInt16LE(1, 20); // PCM
	h.writeUInt16LE(channels, 22);
	h.writeUInt32LE(sampleRate, 24);
	h.writeUInt32LE((sampleRate * channels * 16) / 8, 28);
	h.writeUInt16LE(channels * 2, 32);
	h.writeUInt16LE(16, 34);
	h.write("data", 36);
	h.writeUInt32LE(dataBytes, 40);
	return h;
}

export interface PersistentOptions {
	ffmpegPath: string;
	device: string;
	/** Preferred device NAME (stable across index drift). */
	deviceName?: string;
	sampleRate: number;
	channels: number;
	onLevel?: (rms: number) => void;
	/** Called when the backing process dies unexpectedly (device loss). */
	onDeath?: (reason: string) => void;
}

/**
 * Zero-latency recorder: one ffmpeg process stays open for the whole session,
 * streaming raw s16le PCM to stdout. start() just resets the buffer (≈0ms —
 * this removes the ~9s AVFoundation device-open latency per press); stop()
 * wraps the buffered PCM into a WAV temp file.
 *
 * Trade-off: the macOS microphone indicator stays on while Pi runs.
 */
/** ffmpeg process with stdout PCM (pipe) for persistent capture. */
type PersistentProc = ChildProcessByStdio<null, import("node:stream").Readable, import("node:stream").Readable>;

export class PersistentRecorder implements RecorderLike {
	private proc: PersistentProc | null = null;
	private stderrTail = "";
	private chunks: Buffer[] = [];
	private recording = false;
	private startedAt = 0;
	private dying = false;
	private spawnPromise: Promise<void> | null = null;
	private opts: PersistentOptions | null = null;
	private exited = false;
	private outPath = "";

	get running(): boolean {
		return this.proc !== null && !this.exited;
	}

	/** Spawn (or re-spawn after device loss) the backing ffmpeg. Resolves when
	 * PCM is flowing. Safe to call repeatedly; concurrent calls share one spawn. */
	async ensureRunning(opts: PersistentOptions): Promise<void> {
		// Merge, don't replace — and skip undefined values, because spread
		// would otherwise clobber earlier callbacks (e.g. onDeath registered
		// by prepare()) when a later call explicitly passes onDeath: undefined.
		const merged = { ...this.opts } as Record<string, unknown>;
		for (const [k, v] of Object.entries(opts as unknown as Record<string, unknown>)) {
			if (v !== undefined) merged[k] = v;
		}
		this.opts = merged as unknown as PersistentOptions;
		if (this.running) return;
		if (this.spawnPromise) return this.spawnPromise;
		this.exited = false;
		this.spawnPromise = this.spawnFfmpeg(opts).finally(() => {
			this.spawnPromise = null;
		});
		return this.spawnPromise;
	}

	private async spawnFfmpeg(opts: PersistentOptions): Promise<void> {
		const device = await resolveDevice(opts.ffmpegPath, opts.device, opts.deviceName ?? "");
		const args = [
			"-hide_banner",
			"-loglevel",
			"error",
			"-f",
			"avfoundation",
			"-i",
			device,
			"-ar",
			String(opts.sampleRate),
			"-ac",
			String(opts.channels),
			"-sample_fmt",
			"s16",
			"-f",
			"s16le",
			"pipe:1",
		];
		const proc = spawn(opts.ffmpegPath || "ffmpeg", args, {
			stdio: ["ignore", "pipe", "pipe"],
		}) as unknown as PersistentProc;
		this.proc = proc;
		this.stderrTail = "";
		proc.stderr.setEncoding("utf8");
		proc.stderr.on("data", (c: string) => {
			this.stderrTail = (this.stderrTail + c).slice(-2000);
		});

		await new Promise<void>((resolve, reject) => {
			let settled = false;
			const firstChunk = (buf: Buffer) => {
				if (settled) return;
				settled = true;
				clearTimeout(giveUp);
				this.consume(buf);
				resolve();
			};
			proc.stdout.once("data", firstChunk);
			const giveUp = setTimeout(() => {
				if (settled) return;
				settled = true;
				this.proc = null;
				proc.kill("SIGKILL");
				reject(
					new RecorderError(
						"persistent ffmpeg produced no audio within 20s — check mic permission and device" +
							` (stderr: ${this.stderrTail.trim() || "(none)"})`,
						"START_TIMEOUT",
					),
				);
			}, 20_000);
			proc.once("exit", (code, signal) => {
				this.exited = true;
				if (!settled) {
					settled = true;
					clearTimeout(giveUp);
					if (!this.dying) {
						reject(
							new RecorderError(
								`persistent ffmpeg exited (code=${code} signal=${signal}). stderr: ${this.stderrTail.trim() || "(none)"}`,
								"EARLY_EXIT",
							),
						);
					}
				}
			});
			proc.once("error", (err) => {
				if (settled) return;
				settled = true;
				clearTimeout(giveUp);
				reject(new RecorderError(`ffmpeg spawn error: ${err.message}`, "SPAWN_FAILED"));
			});
		});

		// Continuous consumption after the first chunk resolved the promise.
		proc.stdout.on("data", (buf: Buffer) => this.consume(buf));
		proc.once("exit", (code, signal) => {
			const wasRecording = this.recording;
			this.proc = null;
			// Keep `recording` true when a capture was in flight so the caller
			// can salvage the buffered audio via salvagePartial().
			if (!wasRecording) this.recording = false;
			if (!this.dying) {
				this.opts?.onDeath?.(`ffmpeg exited (code=${code} signal=${signal}). stderr: ${this.stderrTail.trim() || "(none)"}`);
			}
		});
	}

	private zeroMs = 0;

	private consume(buf: Buffer): void {
		if (this.recording) this.chunks.push(buf);
		// Zero-signal guard: when another process holds the input device,
		// AVFoundation hands later openers an instantly-"working" stream of
		// pure zeros — real mics always have a nonzero noise floor. Sustained
		// exact-zero audio while capturing means the device is conflicted.
		if (this.recording) {
			if (isAllZero(buf)) {
				this.zeroMs += (buf.length / (16000 * 2)) * 1000;
				// 3.5s of EXACT zeros: headsets with firmware noise gates emit
				// literal zeros in silence, so a shorter window would misfire on
				// users who pause ~2s after pressing record before speaking.
				if (this.zeroMs > 3500) {
					const reason = "zero-signal: device held by another process or hardware-muted; restarting capture";
					this.dying = false;
					this.recording = false;
					this.chunks = [];
					try {
						this.proc?.kill("SIGKILL");
					} catch {
						/* ignore */
					}
					this.proc = null;
					this.opts?.onDeath?.(reason);
					// Pre-spawn a replacement in the background so the next
					// press is instant again (best effort).
					if (this.opts) void this.ensureRunning(this.opts).catch(() => {});
					return;
				}
			} else {
				this.zeroMs = 0;
			}
		}
		const onLevel = this.opts?.onLevel;
		if (!onLevel) return;
		let sumSquares = 0;
		for (let i = 0; i + 1 < buf.length; i += 2) {
			const s = buf.readInt16LE(i);
			sumSquares += (s * s) / (32768 * 32768);
		}
		const rms = Math.sqrt(sumSquares / Math.max(1, buf.length / 2));
		onLevel(Math.min(1, rms * 4));
	}

	async start(outPath: string, opts: Parameters<RecorderLike["start"]>[1]): Promise<void> {
		if (this.recording) {
			// Stale flag: pipeline only calls start() from IDLE, so a leftover
			// recording=true is debris from an unhandled device death or a
			// cancelled finalization — discard it and start fresh.
			this.recording = false;
			this.chunks = [];
		}
		this.outPath = outPath;
		const po: PersistentOptions = {
			ffmpegPath: opts.ffmpegPath,
			device: opts.device,
			deviceName: opts.deviceName,
			sampleRate: opts.sampleRate,
			channels: opts.channels,
			onLevel: opts.onLevel,
			onDeath: opts.onDeath,
		};
		// (Re)spawn if the process died since the last use.
		this.zeroMs = 0;
		await this.ensureRunning(po);
		this.chunks = [];
		this.recording = true;
		this.startedAt = Date.now();
	}

	get elapsedMs(): number {
		return this.startedAt ? Date.now() - this.startedAt : 0;
	}

	get recordingActive(): boolean {
		return this.recording;
	}

	async stop(): Promise<string> {
		if (!this.recording) throw new RecorderError("Not recording", "NOT_RECORDING");
		this.recording = false;
		const data = Buffer.concat(this.chunks);
		this.chunks = [];
		if (data.length < 1024) {
			throw new RecorderError("No audio captured", "NO_OUTPUT");
		}
		writeFileSync(this.outPath, Buffer.concat([wavHeader(data.length), data]));
		return this.outPath;
	}

	/** Finalize the buffered audio of a run whose backing process died.
	 * Returns the WAV path, or null when nothing usable was captured. */
	salvagePartial(outPath: string): string | null {
		if (!this.recording) return null;
		this.recording = false;
		const data = Buffer.concat(this.chunks);
		this.chunks = [];
		if (data.length < 16000) return null; // < 0.5s — nothing worth saving
		writeFileSync(outPath, Buffer.concat([wavHeader(data.length), data]));
		return outPath;
	}

	/** Discard the current recording but keep the process warm. */
	kill(): string | null {
		this.recording = false;
		this.chunks = [];
		return null;
	}

	/** Really stop: kills the backing process (session shutdown / dispose). */
	shutdown(): void {
		this.dying = true;
		this.kill();
		if (this.proc) {
			try {
				this.proc.kill("SIGKILL");
			} catch {
				/* ignore */
			}
		}
		this.proc = null;
	}
}
