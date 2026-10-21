/**
 * Status bar rendering: recording timer + live waveform, processing states.
 * All output goes through ctx.ui.setStatus under the key "voice-refine".
 */

import { formatDuration, levelToBar } from "./utils.ts";

const STATUS_KEY = "voice-refine";

export interface StatusView {
	setStarting(): void;
	setRecording(elapsedMs: number, rms: number): void;
	setRecordingMuted(elapsedMs: number): void;
	setTranscribing(): void;
	setRefining(model: string): void;
	setDone(summary: string): void;
	clear(): void;
}

const WAVEFORM_SLOTS = 10;

export function createStatusView(
	// setStatus comes from ctx.ui; typed loosely to keep this testable.
	setStatus: (key: string, text: string | undefined) => void,
): StatusView {
	let bars: string[] = new Array(WAVEFORM_SLOTS).fill("▁");

	const push = (text: string | undefined) => {
		try {
			setStatus(STATUS_KEY, text);
		} catch {
			/* UI may be unavailable in non-interactive modes */
		}
	};

	return {
		setStarting(): void {
			push("🎙 opening microphone…");
		},
		setRecording(elapsedMs: number, rms: number): void {
			bars = [...bars.slice(1), levelToBar(rms)];
			push(`🎙 ${formatDuration(elapsedMs)} ${bars.join("")}`);
		},
		setRecordingMuted(elapsedMs: number): void {
			bars = [...bars.slice(1), "▁"];
			push(`🎙 ${formatDuration(elapsedMs)} ${bars.join("")} (muted?)`);
		},
		setTranscribing(): void {
			push("⏳ transcribing…");
		},
		setRefining(model: string): void {
			push(`⏳ refining (${model})…`);
		},
		setDone(summary: string): void {
			push(summary);
		},
		clear(): void {
			push(undefined);
		},
	};
}
