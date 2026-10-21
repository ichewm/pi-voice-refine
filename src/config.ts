/**
 * Configuration for pi-voice-refine.
 *
 * File: <agent-dir>/voice-refine.json  (default ~/.pi/agent/voice-refine.json)
 *
 * - Reads with defaults merged (deep) so missing keys never crash the extension.
 * - Caches by mtime: each get() re-reads only when the file changed, so the web
 *   config page can hot-apply changes without /reload.
 * - writeConfig() persists the full config and bumps mtime.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type RefineTemplate = "faithful-en" | "polish-zh";
export type RefineApi = "ollama" | "openai";
/** Single source of truth for valid template ids (index.ts + config page). */
export const REFINE_TEMPLATES = ["faithful-en", "polish-zh"] as const;
export const REFINE_TEMPLATE_LABELS: Record<RefineTemplate, string> = {
	"faithful-en": "faithful-en（忠实译成英文：仅去口水词/重复，零改写）",
	"polish-zh": "polish-zh（保留中文：仅去口水词/加标点）",
};
export type InsertMode = "paste" | "replace";
export type PipelineMode = "refine" | "raw";

export type CaptureMode = "persistent" | "ondemand";

export interface VoiceRefineConfig {
	hotkeyRefine: string;
	hotkeyRaw: string;
	/** Refine the current editor draft (translate Chinese prose, keep code). */
	hotkeyEditor: string;
	defaultMode: PipelineMode;
	asr: {
		backend: "sensevoice";
		modelPath: string;
		modelUrl: string;
	};
	capture: {
		tool: "ffmpeg";
		/** persistent = zero-latency (mic stays open all session);
		 * ondemand = spawns per recording (~9s AVFoundation open on USB mics). */
		mode: CaptureMode;
		/** Preferred input device NAME — stable across macOS index drift
		 * (e.g. ":0" flipping from the headset to a virtual loopback). */
		deviceName: string;
		/** Pre-warm while this session is actively used (input activity = focus proxy). */
		preWarm: boolean;
		/** Release the microphone after this many seconds without session activity. */
	idleReleaseSeconds: number;
		ffmpegPath: string;
		/** macOS avfoundation audio device index (":0" builtin). Empty = ":0". */
		device: string;
		sampleRate: number;
		channels: number;
		maxSeconds: number;
	};
	refine: {
		provider: "ollama";
		/** "ollama" → /api/chat with think:false; "openai" → /v1/chat/completions (llama.cpp server, LM Studio, …) */
		api: RefineApi;
		baseUrl: string;
		model: string;
		autoStartOllama: boolean;
		timeoutSeconds: number;
		temperature: number;
		template: RefineTemplate;
		glossary: string[];
	};
	output: {
		insertMode: InsertMode;
		appendTrailingSpace: boolean;
	};
}

export const DEFAULT_MODEL_DIR = "~/.pi/agent/voice-refine-models/sense-voice-small";

export const DEFAULT_CONFIG: VoiceRefineConfig = {
	// macOS note: F1-F12 default to media keys and option+letter types special
	// characters, so ctrl+alt+<letter> is the combination every terminal
	// delivers reliably without extra settings.
	hotkeyRefine: "ctrl+alt+v",
	hotkeyRaw: "ctrl+alt+r",
	hotkeyEditor: "ctrl+alt+e",
	defaultMode: "refine",
	asr: {
		backend: "sensevoice",
		modelPath: DEFAULT_MODEL_DIR,
		modelUrl:
			"https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2",
	},
	capture: {
		tool: "ffmpeg",
		mode: "persistent",
		deviceName: "",
		preWarm: true,
		idleReleaseSeconds: 60,
		ffmpegPath: "ffmpeg",
		device: "",
		sampleRate: 16000,
		channels: 1,
		maxSeconds: 120,
	},
	refine: {
		provider: "ollama",
		api: "ollama",
		baseUrl: "http://127.0.0.1:11434",
		model: "qwen3:8b",
		autoStartOllama: true,
		timeoutSeconds: 60,
		temperature: 0.3,
		template: "faithful-en",
		glossary: [],
	},
	output: {
		insertMode: "paste",
		appendTrailingSpace: true,
	},
};

export function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function configPath(): string {
	return join(agentDir(), "voice-refine.json");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep merge source over target; arrays replace, objects recurse. Never mutates inputs. */
export function deepMerge<T>(target: T, source: unknown): T {
	if (!isPlainObject(target) || !isPlainObject(source)) {
		return (source === undefined ? target : source) as T;
	}
	const out: Record<string, unknown> = { ...target };
	for (const [k, v] of Object.entries(source)) {
		if (v === undefined) continue;
		out[k] = k in out ? deepMerge((out as Record<string, unknown>)[k], v) : v;
	}
	return out as T;
}

/** Expand "~" prefix to the home directory. */
export function expandTilde(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return join(homedir(), p.slice(2));
	return p;
}

/** Parse a raw JSON object into a complete config with defaults filled in.
 * Never throws: hostile or mistyped values are coerced/clamped so a bad
 * hand-edited config degrades gracefully instead of silently reverting. */
export function normalizeConfig(raw: unknown): VoiceRefineConfig {
	const merged = deepMerge(DEFAULT_CONFIG, isPlainObject(raw) ? raw : {});

	const asString = (v: unknown, fallback: string): string => {
		const s = typeof v === "string" ? v.trim() : "";
		return s.length > 0 ? s : fallback;
	};
	const asNumber = (v: unknown, fallback: number): number => {
		const n = typeof v === "number" ? v : Number(v);
		return Number.isFinite(n) ? n : fallback;
	};
	const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));
	const asEnum = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
		allowed.includes(v as T) ? (v as T) : fallback;
	const asHotkey = (v: unknown, fallback: string): string => {
		const s = typeof v === "string" ? v.trim().toLowerCase() : "";
		return s.length > 0 ? s : fallback; // registerShortcut failures are caught at registration
	};

	return {
		hotkeyRefine: asHotkey(merged.hotkeyRefine, DEFAULT_CONFIG.hotkeyRefine),
		hotkeyRaw: asHotkey(merged.hotkeyRaw, DEFAULT_CONFIG.hotkeyRaw),
		hotkeyEditor: asHotkey(merged.hotkeyEditor, DEFAULT_CONFIG.hotkeyEditor),
		defaultMode: asEnum(merged.defaultMode, ["refine", "raw"] as const, "refine"),
		asr: {
			backend: asEnum(merged.asr.backend, ["sensevoice"] as const, "sensevoice"),
			modelPath: asString(merged.asr.modelPath, DEFAULT_CONFIG.asr.modelPath),
			modelUrl: asString(merged.asr.modelUrl, DEFAULT_CONFIG.asr.modelUrl),
		},
		capture: {
			tool: "ffmpeg",
			mode: asEnum(merged.capture.mode, ["persistent", "ondemand"] as const, "persistent"),
			preWarm: merged.capture.preWarm === undefined ? true : Boolean(merged.capture.preWarm),
			idleReleaseSeconds: clamp(Math.floor(asNumber(merged.capture.idleReleaseSeconds, 60)), 10, 600),
			ffmpegPath: asString(merged.capture.ffmpegPath, "ffmpeg"),
			device: typeof merged.capture.device === "string" ? merged.capture.device.trim() : "",
			deviceName: asString(merged.capture.deviceName, ""),
			sampleRate: 16000, // SenseVoice int8 requires 16kHz mono s16
			channels: 1,
			maxSeconds: clamp(Math.floor(asNumber(merged.capture.maxSeconds, 120)), 5, 600),
		},
		refine: {
			provider: "ollama",
			api: asEnum(merged.refine.api, ["ollama", "openai"] as const, "ollama"),
			baseUrl: asString(merged.refine.baseUrl, DEFAULT_CONFIG.refine.baseUrl),
			model: asString(merged.refine.model, DEFAULT_CONFIG.refine.model),
			autoStartOllama: Boolean(merged.refine.autoStartOllama),
			timeoutSeconds: clamp(Math.floor(asNumber(merged.refine.timeoutSeconds, 60)), 10, 300),
			temperature: clamp(asNumber(merged.refine.temperature, 0.3), 0, 1),
			template: asEnum(merged.refine.template, REFINE_TEMPLATES, "faithful-en"),
			glossary: Array.isArray(merged.refine.glossary)
				? [
					...new Set(
						merged.refine.glossary
							.map((g) => String(g).trim())
							.filter((g) => g.length > 0),
					),
				]
				: [],
		},
		output: {
			insertMode: asEnum(merged.output.insertMode, ["paste", "replace"] as const, "paste"),
			appendTrailingSpace: Boolean(merged.output.appendTrailingSpace),
		},
	};
}

let cached: { mtimeMs: number; config: VoiceRefineConfig } | null = null;

/** Load config (cached by mtime). Creates the file with defaults on first run. */
export function loadConfig(): VoiceRefineConfig {
	const path = configPath();
	try {
		if (!existsSync(path)) {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, JSON.stringify(DEFAULT_CONFIG, null, "\t") + "\n", "utf8");
			return { ...DEFAULT_CONFIG };
		}
		const mtimeMs = statSync(path).mtimeMs;
		if (cached && cached.mtimeMs === mtimeMs) return cached.config;
		const raw = JSON.parse(readFileSync(path, "utf8"));
		const config = normalizeConfig(raw);
		cached = { mtimeMs, config };
		return config;
	} catch {
		// Corrupt JSON etc.: fall back to defaults rather than crashing the extension.
		return structuredClone(DEFAULT_CONFIG);
	}
}

/** Persist config and refresh the cache. */
export function saveConfig(config: VoiceRefineConfig): void {
	const path = configPath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(config, null, "\t") + "\n", "utf8");
	cached = { mtimeMs: statSync(path).mtimeMs, config: normalizeConfig(config) };
}
