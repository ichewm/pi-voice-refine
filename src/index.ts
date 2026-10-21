/**
 * pi-voice-refine — local voice → refined English instructions for Pi.
 *
 * ctrl+alt+v  record → SenseVoice ASR → Ollama refine → insert at cursor (never sent)
 * ctrl+alt+r  record → SenseVoice ASR → insert raw transcript
 *
 * Commands: /vrefine status|refine|raw|cancel|test|model|model download|config|config stop
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, statSync, truncateSync } from "node:fs";
import { join } from "node:path";
import {
	loadConfig,
	configPath,
	expandTilde,
	agentDir,
	saveConfig,
	REFINE_TEMPLATES,
	type RefineTemplate,
} from "./config.ts";
import { VoicePipeline, type PipelineUI } from "./pipeline.ts";
import { downloadModel, isModelReady } from "./model-manager.ts";
import { openConfigPage, type ConfigServerHandle } from "./config-server.ts";
import { checkHealth, ensureOllamaRunning, refineTranscript } from "./refiner/ollama.ts";

export default function (pi: ExtensionAPI) {
	const config = loadConfig();
	let pipeline: VoicePipeline | null = null;
	let configServer: ConfigServerHandle | null = null;
	let downloadAbort: AbortController | null = null;

	// ------------------------------------------------------------------
	// Rolling debug log — records key bytes reaching Pi and shortcut fires,
	// so "nothing happens" reports can be diagnosed from a file.
	// ------------------------------------------------------------------
	const DEBUG_LOG = join(agentDir(), "voice-refine-debug.log");
	const DEBUG_CAP = 256 * 1024;
	function debugLog(line: string): void {
		try {
			appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${line}\n`);
			if (statSync(DEBUG_LOG).size > DEBUG_CAP) {
				const tail = readFileSync(DEBUG_LOG, "utf8").slice(-DEBUG_CAP / 2);
				truncateSync(DEBUG_LOG, 0);
				appendFileSync(DEBUG_LOG, tail);
			}
		} catch {
			/* never break the extension for logging */
		}
	}
	debugLog(`loaded: shortcuts ${config.hotkeyRefine}/${config.hotkeyRaw} pi=${process.version}`);

	function uiAdapter(ctx: { ui: ExtensionContext["ui"] }): PipelineUI {
		return {
			notify: (msg, type) => ctx.ui.notify(msg, type),
			setStatus: (key, text) => ctx.ui.setStatus(key, text),
			pasteToEditor: (text) => ctx.ui.pasteToEditor(text),
			setEditorText: (text) => ctx.ui.setEditorText(text),
			getEditorText: () => ctx.ui.getEditorText(),
		};
	}

	async function refineEditorDraft(ctx: { ui: ExtensionContext["ui"] }): Promise<void> {
		const draft = ctx.ui.getEditorText();
		if (!draft.trim()) {
			ctx.ui.notify("Editor is empty — dictate first (hotkey), paste code/links, then press the editor-refine hotkey.", "info");
			return;
		}
		const { refineDraft, hasCJK } = await import("./refiner/editor-refine.ts");
		if (!hasCJK(draft)) {
			ctx.ui.notify("No Chinese found in the editor — nothing to translate.", "info");
			return;
		}
		const cfg = loadConfig();
		ctx.ui.setStatus("voice-refine", "⏳ refining editor draft…");
		try {
			const ok = await ensureOllamaRunning(cfg.refine.baseUrl, cfg.refine.autoStartOllama);
			if (!ok) throw new Error(`Ollama not reachable at ${cfg.refine.baseUrl}`);
			const { llmChat } = await import("./refiner/ollama.ts");
			const r = await refineDraft(draft, {
				api: cfg.refine.api,
				baseUrl: cfg.refine.baseUrl,
				model: cfg.refine.model,
				temperature: cfg.refine.temperature,
				timeoutSeconds: cfg.refine.timeoutSeconds,
			}, (system, user, o) =>
				llmChat(system, user, {
					api: o.api, baseUrl: o.baseUrl, model: o.model, template: "faithful-en",
					temperature: o.temperature, timeoutSeconds: o.timeoutSeconds,
					glossary: cfg.refine.glossary,
				} as Parameters<typeof llmChat>[2]),
			);
			ctx.ui.setStatus("voice-refine", undefined);
			if (r.translatedProseChars === 0) {
				ctx.ui.notify("No translatable Chinese prose found (code/links already preserved).", "info");
				return;
			}
			ctx.ui.setEditorText(r.text);
			ctx.ui.notify(
				`Draft refined in ${(r.durationMs / 1000).toFixed(1)}s — translated ${r.translatedProseChars} chars of Chinese, kept ${r.verbatimSegments} technical block(s) byte-exact.`,
				"info",
			);
		} catch (err) {
			ctx.ui.setStatus("voice-refine", undefined);
			ctx.ui.notify(`Editor refine failed: ${(err as Error).message}`, "error");
		}
	}

	function getPipeline(ctx: { ui: ExtensionContext["ui"] }): VoicePipeline {
		if (!pipeline) {
			pipeline = new VoicePipeline(uiAdapter(ctx), {
				debug: (msg) => debugLog(`pipe: ${msg}`),
			});
			debugLog("pipeline created");
		}
		return pipeline;
	}

	// ------------------------------------------------------------------
	// Shortcuts. Windows keyboards plugged into a Mac map the physical Alt
	// key to ⌘ (super), not ⌥ (alt) — so every "ctrl+alt+X" also gets a
	// "ctrl+super+X" twin registered automatically. Invalid values must not
	// crash extension loading.
	// ------------------------------------------------------------------
	type ShortcutKey = Parameters<ExtensionAPI["registerShortcut"]>[0];
	function deriveAliases(hotkey: string): string[] {
		const aliases = [hotkey];
		const alt = hotkey.match(/^ctrl\+alt\+([a-z0-9]+)$/i);
		if (alt) aliases.push(`ctrl+super+${alt[1].toLowerCase()}`);
		const sup = hotkey.match(/^ctrl\+super\+([a-z0-9]+)$/i);
		if (sup) aliases.push(`ctrl+alt+${sup[1].toLowerCase()}`);
		return [...new Set(aliases)];
	}
	function registerHotkey(
		hotkey: string,
		mode: "refine" | "raw" | "editor",
		description: string,
	): void {
		for (const alias of deriveAliases(hotkey)) {
			try {
				pi.registerShortcut(alias as ShortcutKey, {
					description,
					handler: async (ctx) => {
						debugLog(`shortcut fired: ${alias} (${mode})`);
						if (mode === "editor") {
							await refineEditorDraft(ctx);
						} else {
							await getPipeline(ctx).toggle(mode);
						}
					},
				});
			} catch {
				debugLog(`invalid hotkey "${alias}" — not registered`);
				console.warn(`[voice-refine] invalid hotkey "${alias}" — not registered`);
			}
		}
	}
	registerHotkey(config.hotkeyRefine, "refine", "voice-refine: record → transcribe → refine to English instructions");
	registerHotkey(config.hotkeyRaw, "raw", "voice-refine: record → transcribe → insert raw transcript");
	registerHotkey(config.hotkeyEditor, "editor", "voice-refine: refine the editor draft (translate Chinese prose, keep code/links byte-exact)");

	// ------------------------------------------------------------------
	// Esc cancels an active recording/processing run (pass-through otherwise).
	// We consume the raw ESC byte only while the pipeline is busy, so Pi's
	// native app.interrupt is untouched in the common case.
	// ------------------------------------------------------------------
	pi.on("session_start", async (_event, ctx) => {
		const HOTKEY_CHUNK = /(\[118;\d+|\[114;\d+)/;
		ctx.ui.onTerminalInput((data: string) => {
			// Focus proxy: keystrokes land only in the focused window.
			pipeline?.touchActivity();
			// Log only while a run is active or the chunk looks like one of our
			// hotkeys — avoid filling the file with arrow-key noise.
			const busy = pipeline !== null && pipeline.currentState !== "IDLE";
			if (data.includes("\x1b") && (busy || HOTKEY_CHUNK.test(data))) {
				debugLog(`input: ${JSON.stringify(data)}`);
			}
			if (data !== "\x1b") return undefined; // only bare ESC
			if (!pipeline || pipeline.currentState === "IDLE") return undefined;
			pipeline.cancel("Recording cancelled (Esc)");
			return { consume: true };
		});
	});

	// NOTE: no pre-warm at session start. Multiple Pi sessions each holding
	// the microphone at boot conflict over the audio device (only one gets a
	// real signal). Instead, terminal input activity — which only reaches the
	// focused window — pre-warms lazily; idle sessions release the mic.
	pi.on("session_start", async (_event, ctx) => {
		if (!pipeline) pipeline = getPipeline(ctx);
	});

	// One-time warning when the ASR model is missing.
	pi.on("session_start", async (_event, ctx) => {
		if (!isModelReady(config.asr.modelPath)) {
			ctx.ui.notify(
				"pi-voice-refine: SenseVoice model not downloaded yet. Run /vrefine model download",
				"warning",
			);
		}
	});

	pi.on("session_shutdown", async () => {
		downloadAbort?.abort(new Error("shutdown"));
		pipeline?.dispose();
		// The pipeline captured this session's ctx.ui — drop it so the next
		// session builds a fresh one against its own (session-scoped) UI.
		pipeline = null;
		try {
			await configServer?.stop();
		} catch {
			/* ignore */
		}
		configServer = null;
	});

	// ------------------------------------------------------------------
	// Commands
	// ------------------------------------------------------------------
	pi.registerCommand("vrefine", {
		description: "voice-refine control (status|refine|raw|cancel|test|model|config)",
		handler: async (args: string, ctx) => {
			const [sub = "status", ...rest] = args.trim().split(/\s+/);
			const pipelineOrNew = getPipeline(ctx);

			switch (sub) {
				case "status": {
					const cfg = loadConfig();
					const lines: string[] = [];
					lines.push(`state: ${pipeline?.currentState ?? "IDLE"}`);
					lines.push(`config: ${configPath()}`);
					const asrReady = isModelReady(cfg.asr.modelPath);
					lines.push(`asr: ${asrReady ? "model ready" : "MODEL NOT DOWNLOADED (/vrefine model download)"}`);
					const llmUp = await checkHealth(cfg.refine.baseUrl);
					lines.push(`llm: ${llmUp ? "ollama running" : "ollama NOT running"} · model=${cfg.refine.model} · ${cfg.refine.baseUrl}`);
					lines.push(
						`hotkeys: ${cfg.hotkeyRefine}=refine  ${cfg.hotkeyRaw}=raw  ${cfg.hotkeyEditor}=refine-editor-draft  (ctrl+alt+X ⇔ ctrl+super+X twins auto-registered; Esc cancels an active run)`,
					);
					lines.push(`template=${cfg.refine.template} glossary=${cfg.refine.glossary.length} terms`);
					lines.push(`config page: ${configServer ? configServer.url : "/vrefine config to open"}`);
					ctx.ui.notify(lines.join("\n"), "info");
					break;
				}

				case "refine":
				case "raw":
					await pipelineOrNew.toggle(sub);
					break;

				case "cancel":
					if (downloadAbort) {
						downloadAbort.abort(new Error("user-cancelled"));
						downloadAbort = null;
						ctx.ui.notify("Model download cancelled.", "info");
					}
					pipelineOrNew.cancel("Cancelled");
					break;

				case "test": {
					const cfg = loadConfig();
					ctx.ui.notify("voice-refine self-test…", "info");
					const asrOk = isModelReady(cfg.asr.modelPath);
					const llmOk = await ensureOllamaRunning(cfg.refine.baseUrl, cfg.refine.autoStartOllama);
					if (!asrOk) {
						ctx.ui.notify("❌ ASR model missing — run /vrefine model download", "error");
					}
					if (!llmOk) {
						ctx.ui.notify(`❌ Ollama not reachable at ${cfg.refine.baseUrl} (autoStart=${cfg.refine.autoStartOllama})`, "error");
					}
					if (asrOk && llmOk) {
						try {
							const r = await refineTranscript("帮我跑一下 cargo test，看看嗯看看能不能过", {
								api: cfg.refine.api,
								baseUrl: cfg.refine.baseUrl,
								model: cfg.refine.model,
								template: cfg.refine.template,
								temperature: cfg.refine.temperature,
								timeoutSeconds: cfg.refine.timeoutSeconds,
								glossary: cfg.refine.glossary,
							});
							ctx.ui.notify(
								`✅ ASR model ready · Ollama ${cfg.refine.model}\nrefine self-test (${(r.durationMs / 1000).toFixed(1)}s):\n${r.text}`,
								"info",
							);
						} catch (err) {
							ctx.ui.notify(`⚠️ refine failed: ${(err as Error).message}`, "warning");
						}
					}
					break;
				}

				case "model": {
					const cfg = loadConfig();
					if (rest[0] === "use" && rest[1]) {
						// /vrefine model use qwen3.5:9b — hot-switch the refine LLM.
						const name = rest.slice(1).join(" ").trim();
						const { listOllamaModels } = await import("./refiner/ollama.ts");
						const known = await listOllamaModels(cfg.refine.baseUrl).catch(() => [] as string[]);
						cfg.refine.model = name;
						saveConfig(cfg);
						if (known.length > 0 && !known.includes(name)) {
							ctx.ui.notify(
								`Refine model switched to ${name}, but it is not installed in your local Ollama (installed: ${known.join(", ")})\nRun first: ollama pull ${name}`,
								"warning",
							);
						} else {
							ctx.ui.notify(`Refine model switched to ${name} (applied immediately)`, "info");
						}
						break;
					}
					if (rest[0] === "download") {
						ctx.ui.notify("Downloading SenseVoice model (~230MB)… (/vrefine cancel aborts)", "info");
						downloadAbort = new AbortController();
						try {
							await downloadModel(cfg.asr.modelPath, cfg.asr.modelUrl, (p) => {
								const pct = p.total ? ` ${Math.floor((p.received / p.total) * 100)}%` : ` ${(p.received / 1048576).toFixed(0)}MB`;
								ctx.ui.setStatus("voice-refine", `⏬ model${pct}`);
							}, downloadAbort.signal);
							ctx.ui.setStatus("voice-refine", undefined);
							ctx.ui.notify("✅ SenseVoice model ready. Press " + cfg.hotkeyRefine + " to record.", "info");
						} catch (err) {
							ctx.ui.setStatus("voice-refine", undefined);
							ctx.ui.notify(`❌ model download failed: ${(err as Error).message}`, "error");
						} finally {
							downloadAbort = null;
						}
					} else {
						const ready = isModelReady(cfg.asr.modelPath);
						ctx.ui.notify(
							`model: ${ready ? "ready" : "not downloaded"}\npath: ${expandTilde(cfg.asr.modelPath)}\ndownload: /vrefine model download`,
							"info",
						);
					}
					break;
				}

				case "config": {
					if (rest[0] === "stop") {
						if (configServer) {
							await configServer.stop();
							configServer = null;
							ctx.ui.notify("config page closed", "info");
						} else {
							ctx.ui.notify("config page not running", "info");
						}
						break;
					}
					if (configServer) {
						ctx.ui.notify(`config page already running:\n${configServer.url}`, "info");
						break;
					}
					configServer = await openConfigPage((saved) => {
						ctx.ui.notify(
							`config saved (model=${saved.refine.model}, template=${saved.refine.template}). Hot-applied.`,
							"info",
						);
					});
					ctx.ui.notify(`config page:\n${configServer.url}\n(auto-closes after 10 min idle; /vrefine config stop)`, "info");
					break;
				}

				case "debug": {
					let tail = "(log empty)";
					try {
						const text = readFileSync(DEBUG_LOG, "utf8").trim();
						tail = text ? text.split("\n").slice(-15).join("\n") : "(log empty)";
					} catch {
						/* fallthrough */
					}
					ctx.ui.notify(`debug log: ${DEBUG_LOG}\n${tail}`, "info");
					break;
				}

				case "template": {
					const cfg = loadConfig();
					const valid = REFINE_TEMPLATES as readonly RefineTemplate[];
					const next = rest[0] as RefineTemplate | undefined;
					if (!next) {
						ctx.ui.notify(
							`template: ${cfg.refine.template}\nAvailable (switch immediately with /vrefine template <name>):\n  faithful-en  faithful sentence-by-sentence translation, filler removal only (default)\n  polish-zh    keep Chinese, clean fillers/punctuation only`,
							"info",
						);
					} else if (valid.includes(next)) {
						cfg.refine.template = next;
						saveConfig(cfg);
						ctx.ui.notify(`Template switched to ${next} (applies immediately to refine mode)`, "info");
					} else {
						ctx.ui.notify(`Unknown template "${next}". Available: ${valid.join(" | ")}`, "warning");
					}
					break;
				}

				case "editor": {
					// NOTE: with a draft in the editor, typed slash commands are
					// appended as text — use the ctrl+alt+e hotkey instead. This
					// command exists for empty-editor invocation completeness.
					await refineEditorDraft(ctx);
					break;
				}

				case "devices": {
					const cfg = loadConfig();
					const ffmpeg = cfg.capture.ffmpegPath || "ffmpeg";
					if (process.platform !== "darwin") {
						ctx.ui.notify(
							"Device listing is macOS-only (AVFoundation). Set capture.device manually on this platform.",
							"info",
						);
						break;
					}
					let out = "";
					try {
						out = await new Promise<string>((resolve, reject) => {
							const child = spawn(ffmpeg, ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""], {
								stdio: ["ignore", "pipe", "pipe"],
						});
						let text = "";
							child.stderr.on("data", (c: Buffer) => (text += c));
							child.stdout.on("data", (c: Buffer) => (text += c));
							child.once("exit", () => resolve(text));
							child.once("error", reject);
						});
					} catch (err) {
						ctx.ui.notify(`❌ ffmpeg failed: ${(err as Error).message}`, "error");
						break;
					}
					const { parseAudioDevices, pickDeviceIndex } = await import("./recorder.ts");
					const devices = parseAudioDevices(out);
					const resolved = devices.length > 0 ? pickDeviceIndex(devices, cfg.capture.device, cfg.capture.deviceName) : null;
					const lines = devices
						.map((d) => `[${d.index}] ${d.name}${resolved === d.index ? "  ✓ active" : ""}`)
						.join("\n");
					ctx.ui.notify(
						`audio input devices:\n${lines || "(none found)"}\n\nRecommended: pin by name via /vrefine config → Microphone (immune to index drift)\nCurrent: deviceName="${cfg.capture.deviceName || "(auto)"}"${resolved !== null ? ` → resolves to :${resolved}` : ""}${cfg.capture.device ? ` (index override "${cfg.capture.device}")` : ""}`,
						"info",
					);
					break;
				}

				default:
					ctx.ui.notify(
						"usage: /vrefine status | refine | raw | editor | cancel | test | model [download|use <name>] | config [stop] | devices | template [name] | debug",
						"info",
					);
			}
		},
	});
}
