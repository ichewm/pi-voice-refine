/**
 * Small shared helpers: temp WAV lifecycle, silence heuristics, time formatting.
 */

import { existsSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempCounter = 0;

/** Create a unique temp WAV path (file is NOT created here). */
export function tempWavPath(): string {
	tempCounter += 1;
	return join(tmpdir(), `pi-voice-refine-${process.pid}-${Date.now()}-${tempCounter}.wav`);
}

/** Best-effort delete; never throws. Returns true if the file is gone afterwards. */
export function cleanupTempFile(path: string | undefined | null): boolean {
	if (!path) return true;
	try {
		if (existsSync(path)) {
			unlinkSync(path);
		}
		return !existsSync(path);
	} catch {
		return false;
	}
}

/** WAV header is 44 bytes for PCM; anything smaller cannot contain audio. */
export function isSilentWav(path: string): boolean {
	try {
		const size = statSync(path).size;
		// < ~0.03s of 16kHz mono 16-bit PCM (~1KB) is treated as silence.
		return size < 1024;
	} catch {
		return true;
	}
}

/** mm:ss for the recording timer. */
export function formatDuration(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const m = Math.floor(total / 60);
	const s = total % 60;
	return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Map a normalized RMS level (0..1) to a 5-bar waveform glyph. NaN-safe. */
export function levelToBar(rms: number): string {
	const bars = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
	if (!Number.isFinite(rms)) return bars[0];
	const idx = Math.min(bars.length - 1, Math.max(0, Math.floor(rms * bars.length)));
	return bars[idx];
}
