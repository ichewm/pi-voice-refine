/**
 * Local web config page: /vrefine config starts an HTTP server bound to
 * 127.0.0.1 with a random port and one-time token, opens the browser,
 * and lets the user edit every setting in a form. Saving writes
 * voice-refine.json and hot-applies it (config is read by mtime each run).
 *
 * Security: loopback-only, token required on every request, idle auto-shutdown.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import {
	loadConfig,
	saveConfig,
	normalizeConfig,
	deepMerge,
	REFINE_TEMPLATE_LABELS,
	type VoiceRefineConfig,
} from "./config.ts";
import { refineTranscript, listOllamaModels, ensureOllamaRunning } from "./refiner/ollama.ts";
import { isModelReady } from "./model-manager.ts";
import { listAudioDevices, pickDeviceIndex, type AudioDevice } from "./recorder.ts";
import { expandTilde } from "./config.ts";

export interface ConfigServerHandle {
	url: string;
	port: number;
	stop(): Promise<void>;
}

const IDLE_SHUTDOWN_MS = 10 * 60 * 1000; // 10 min without any request → stop

function timingSafeEqualStr(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function authorized(req: IncomingMessage, url: URL, token: string): boolean {
	// DNS-rebinding hardening: only loopback hosts may talk to this server.
	const host = (req.headers.host ?? "").split(":")[0];
	if (host !== "127.0.0.1" && host !== "localhost" && host !== "[::1]") return false;
	const q = url.searchParams.get("token") ?? "";
	const header = req.headers.authorization ?? "";
	return timingSafeEqualStr(q, token) || timingSafeEqualStr(header.replace(/^Bearer /, ""), token);
}

function readBody(req: IncomingMessage, limit = 1 << 20): Promise<string> {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > limit) {
				reject(new Error("body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

function send(res: ServerResponse, status: number, body: string, type = "application/json"): void {
	res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
	res.end(body);
}

function openBrowser(url: string): void {
	// Windows `start` is a cmd.exe builtin, not an executable; other platforms
	// use their opener directly. The 'error' listener prevents spawn failures
	// (ENOENT etc.) from becoming uncaught exceptions.
	const cmd =
		process.platform === "darwin"
			? ["open", url]
			: process.platform === "win32"
				? ["cmd", "/c", "start", "", url]
				: ["xdg-open", url];
	try {
		const child = spawn(cmd[0], cmd.slice(1), { detached: true, stdio: "ignore" });
		child.once("error", () => {});
		child.unref();
	} catch {
		/* ignore */
	}
}

export function startConfigServer(onSaved?: (cfg: VoiceRefineConfig) => void): Promise<ConfigServerHandle> {
	const token = randomBytes(16).toString("hex");
	let idleTimer: ReturnType<typeof setTimeout> | null = null;
	let closed = false;

	const server = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		try {
			// Reset idle shutdown on any request.
			if (idleTimer) clearTimeout(idleTimer);
			idleTimer = setTimeout(() => void stop(), IDLE_SHUTDOWN_MS);

			if (!authorized(req, url, token)) {
				send(res, 403, '{"error":"invalid token"}');
				return;
			}

			if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
				send(res, 200, CONFIG_PAGE_HTML, "text/html; charset=utf-8");
				return;
			}

			if (req.method === "GET" && url.pathname === "/api/config") {
				send(res, 200, JSON.stringify(loadConfig()));
				return;
			}

			if (req.method === "GET" && url.pathname === "/api/ollama/models") {
				const cfg = loadConfig();
				const running = await ensureOllamaRunning(cfg.refine.baseUrl, cfg.refine.autoStartOllama);
				const models = running ? await listOllamaModels(cfg.refine.baseUrl) : [];
				send(res, 200, JSON.stringify({ running, models }));
				return;
			}

			if (req.method === "GET" && url.pathname === "/api/devices") {
				const cfg = loadConfig();
				let devices: AudioDevice[] = [];
				try {
					devices = await listAudioDevices(cfg.capture.ffmpegPath || "ffmpeg");
				} catch {
					/* non-macOS or ffmpeg missing */
				}
				const resolved =
					devices.length > 0 ? pickDeviceIndex(devices, cfg.capture.device, cfg.capture.deviceName) : null;
				send(
					res,
					200,
					JSON.stringify({ devices, resolved, deviceName: cfg.capture.deviceName, device: cfg.capture.device }),
				);
				return;
			}

			if (req.method === "GET" && url.pathname === "/api/model-status") {
				const cfg = loadConfig();
				send(res, 200, JSON.stringify({ asrModelReady: isModelReady(cfg.asr.modelPath) }));
				return;
			}

			if (req.method === "POST" && url.pathname === "/api/config") {
				const raw = JSON.parse(await readBody(req));
				const merged = normalizeConfig(loadConfig());
				// Accept only known fields, layered over current values.
				// Layered (deep) merge so a partial section POST never resets sibling keys.
				const next = normalizeConfig(deepMerge(merged, raw));
				saveConfig(next);
				onSaved?.(next);
				send(res, 200, JSON.stringify({ ok: true, needsReload: hotkeysChanged(merged, raw) }));
				return;
			}

			if (req.method === "POST" && url.pathname === "/api/test-refine") {
				const body = JSON.parse(await readBody(req)) as { text?: string };
				const cfg = loadConfig();
				const text = (body.text ?? "").trim();
				if (!text) {
					send(res, 400, JSON.stringify({ error: "text required" }));
					return;
				}
				const ok = await ensureOllamaRunning(cfg.refine.baseUrl, cfg.refine.autoStartOllama);
				if (!ok) {
					send(res, 502, JSON.stringify({ error: `Ollama not reachable at ${cfg.refine.baseUrl}` }));
					return;
				}
				const hasCJK = /[\u4e00-\u9fff]/.test(text);
				const effectiveTemplate = cfg.refine.template === "polish-zh" && !hasCJK ? "faithful-en" : cfg.refine.template;
				const result = await refineTranscript(text, {
					api: cfg.refine.api,
					baseUrl: cfg.refine.baseUrl,
					model: cfg.refine.model,
					template: effectiveTemplate,
					temperature: cfg.refine.temperature,
					timeoutSeconds: cfg.refine.timeoutSeconds,
					glossary: cfg.refine.glossary,
				});
				send(res, 200, JSON.stringify(result));
				return;
			}

			send(res, 404, '{"error":"not found"}');
		} catch (err) {
			send(res, 500, JSON.stringify({ error: (err as Error).message }));
		}
	});

	function hotkeysChanged(current: VoiceRefineConfig, patch: Record<string, unknown>): boolean {
		return (
			(patch.hotkeyRefine !== undefined && patch.hotkeyRefine !== current.hotkeyRefine) ||
			(patch.hotkeyRaw !== undefined && patch.hotkeyRaw !== current.hotkeyRaw)
		);
	}

	async function stop(): Promise<void> {
		if (closed) return;
		closed = true;
		if (idleTimer) clearTimeout(idleTimer);
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}

	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			idleTimer = setTimeout(() => void stop(), IDLE_SHUTDOWN_MS);
			resolve({
				url: `http://127.0.0.1:${port}/?token=${token}`,
				port,
				stop,
			});
		});
	});
}

/** Open (or reuse) the config page. Called from /vrefine config. */
export async function openConfigPage(onSaved?: (cfg: VoiceRefineConfig) => void): Promise<ConfigServerHandle> {
	const handle = await startConfigServer(onSaved);
	openBrowser(handle.url);
	return handle;
}

/* ---------------------------------------------------------------------- */
/* Inline config page HTML (kept in one string so the extension is a       */
/* self-contained directory; no asset path resolution issues with symlinks).*/
/* ---------------------------------------------------------------------- */

const CONFIG_PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>pi-voice-refine · Settings</title>
<style>
:root{
  --bg:#0d1117;--panel:#151b23;--panel2:#1a2230;--line:#28313d;--line2:#333e4d;
  --fg:#e6edf3;--dim:#8b98a5;--faint:#5c6a78;--acc:#4da3ff;--acc2:#2f81f7;
  --ok:#3ecf8e;--warn:#f2b544;--err:#ff6b6b;
  --label-w:190px;--radius:10px;
}
*{box-sizing:border-box}
html{-webkit-font-smoothing:antialiased}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;padding:0 0 90px}
.wrap{max-width:980px;margin:0 auto;padding:0 20px}

/* ── page header ─────────────────────────────── */
header{padding:34px 0 22px;border-bottom:1px solid var(--line);margin-bottom:26px}
.hrow{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
h1{font-size:21px;margin:0;font-weight:700}
.badge{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:99px;font-size:12px;border:1px solid}
.badge.ok{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 35%,transparent);background:color-mix(in srgb,var(--ok) 10%,transparent)}
.badge.bad{color:var(--err);border-color:color-mix(in srgb,var(--err) 35%,transparent);background:color-mix(in srgb,var(--err) 10%,transparent)}
.sub{color:var(--dim);margin:8px 0 0;font-size:13px}

/* ── section cards ───────────────────────────── */
section{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);margin-bottom:18px;overflow:hidden}
.sec-head{display:flex;align-items:baseline;gap:10px;padding:16px 22px 12px;border-bottom:1px solid var(--line)}
.sec-head .no{font-size:12px;color:var(--acc);font-weight:700;letter-spacing:.08em}
.sec-head h2{margin:0;font-size:15px;font-weight:650}
.sec-head .desc{color:var(--faint);font-size:12.5px;margin-left:auto;text-align:right}
.sec-body{padding:18px 22px 20px}

/* ── form grid: aligned label column ─────────── */
.row{display:grid;grid-template-columns:var(--label-w) 1fr 1fr;gap:14px 18px;align-items:start}
.row>.field{grid-column:2 / span 2;min-width:0}
.field+.field{margin-top:14px}
.field label{display:block;font-size:13px;font-weight:600;margin-bottom:6px}
.field label .en{color:var(--faint);font-weight:400;font-size:11.5px;margin-left:6px;font-family:ui-monospace,Menlo,monospace}
.field .hint{color:var(--faint);font-size:12px;margin-top:5px;line-height:1.5}
.field input[type=text],.field input[type=number],.field select,.field textarea{
  width:100%;background:var(--bg);border:1px solid var(--line2);border-radius:8px;color:var(--fg);
  padding:8px 12px;font:inherit;font-size:13.5px;transition:border-color .15s}
.field input:focus,.field select:focus,.field textarea:focus{outline:none;border-color:var(--acc)}
.field select{appearance:none;background-image:linear-gradient(45deg,transparent 50%,var(--dim) 50%),linear-gradient(135deg,var(--dim) 50%,transparent 50%);background-position:calc(100% - 18px) 55%,calc(100% - 13px) 55%;background-size:5px 5px;background-repeat:no-repeat;padding-right:34px}
.field textarea{min-height:84px;resize:vertical;font-family:ui-monospace,Menlo,monospace;font-size:12.5px;line-height:1.7}
.half{display:grid;grid-template-columns:1fr 1fr 1fr;gap:0 18px}
@media (max-width:900px){.half{grid-template-columns:1fr 1fr}}
@media (max-width:620px){.half{grid-template-columns:1fr}}
.half .field+.field{margin-top:0}
.checkline{display:flex;align-items:center;gap:10px;padding:9px 12px;background:var(--bg);border:1px solid var(--line2);border-radius:8px;cursor:pointer;user-select:none}
.checkline input{width:16px;height:16px;accent-color:var(--acc2)}
.checkline .t{font-size:13.5px}
.checkline .d{color:var(--faint);font-size:12px;margin-left:auto}

/* ── hotkey capture ───────────────────────────── */
.kb{display:flex;align-items:center;gap:10px;background:var(--bg);border:1px solid var(--line2);border-radius:8px;padding:8px 12px;min-height:44px;cursor:pointer;transition:all .15s}
.kb:hover{border-color:var(--acc)}
.kb.listening{border-color:var(--warn);box-shadow:0 0 0 3px color-mix(in srgb,var(--warn) 18%,transparent)}
.kb .chips{display:flex;gap:6px;flex-wrap:wrap;flex:1}
.kb .ph{color:var(--faint);font-size:13px}
.kb kbd{display:inline-flex;align-items:center;justify-content:center;min-width:30px;height:28px;padding:0 9px;background:var(--panel2);border:1px solid var(--line2);border-bottom-width:2.5px;border-radius:7px;font:600 12.5px ui-monospace,Menlo,monospace;color:var(--fg)}
.kb .st{font-size:12px;color:var(--warn)}
.kb .x{border:0;background:transparent;color:var(--faint);cursor:pointer;font-size:15px;padding:2px 6px;border-radius:6px}
.kb .x:hover{color:var(--err);background:color-mix(in srgb,var(--err) 12%,transparent)}
.kbd-note{color:var(--faint);font-size:12px;margin-top:7px;line-height:1.6}
.kbd-note b{color:var(--dim);font-weight:600}

/* ── try-it box ───────────────────────────────── */
.try{border-top:1px dashed var(--line);margin-top:18px;padding-top:16px}
.try-row{display:grid;grid-template-columns:1fr auto;gap:12px;align-items:center}
#testOut{background:var(--bg);border:1px solid var(--line2);border-radius:8px;padding:12px 14px;white-space:pre-wrap;font-family:ui-monospace,Menlo,monospace;font-size:12.5px;min-height:22px;margin-top:10px;color:var(--fg)}

/* ── bottom save bar ──────────────────────────── */
.savebar{position:fixed;left:0;right:0;bottom:0;background:color-mix(in srgb,var(--panel) 92%,transparent);backdrop-filter:blur(10px);border-top:1px solid var(--line);padding:13px 0;z-index:10}
.savebar .wrap{display:flex;align-items:center;gap:12px}
#msg{font-size:13px;min-height:20px;flex:1}
#msg.ok{color:var(--ok)}#msg.warn{color:var(--warn)}#msg.err{color:var(--err)}
button{border:0;border-radius:8px;padding:9px 20px;font:600 13.5px inherit;cursor:pointer;transition:filter .15s}
button:hover{filter:brightness(1.12)}
button:disabled{opacity:.5;cursor:default}
#btnSave{background:var(--acc2);color:#fff}
.ghost{background:transparent;border:1px solid var(--line2);color:var(--fg)}
@media (max-width:760px){.row{grid-template-columns:1fr}.row>.field{grid-column:1}.half{grid-template-columns:1fr}}
</style>
</head>
<body>
<header><div class="wrap">
  <div class="hrow">
    <h1>🎙 pi-voice-refine</h1>
    <button class="ghost" id="btnLang" style="padding:3px 12px;font-size:12px">中 / EN</button>
    <span id="asrBadge" class="badge"></span><span id="llmBadge" class="badge"></span>
  </div>
  <p class="sub" data-i18n="headerSub"></p>
</div></header>

<div class="wrap">

<section>
  <div class="sec-head"><span class="no">01</span><h2 data-i18n="secHotkeys"></h2><span class="desc" data-i18n="secHotkeysDesc"></span></div>
  <div class="sec-body">
    <div class="row">
      <div class="field" style="grid-column:1 / span 3;margin-bottom:16px">
        <div class="half">
          <div>
            <label><span data-i18n="lblHotkeyRefine"></span><span class="en">hotkeyRefine</span></label>
            <div class="kb" id="kbRefine" tabindex="0"><span class="chips"></span><span class="ph">Click, then press a key combination…</span><button class="x" title="Clear">✕</button></div>
          </div>
          <div>
            <label><span data-i18n="lblHotkeyRaw"></span><span class="en">hotkeyRaw</span></label>
            <div class="kb" id="kbRaw" tabindex="0"><span class="chips"></span><span class="ph">Click, then press a key combination…</span><button class="x" title="Clear">✕</button></div>
          </div>
          <div>
            <label><span data-i18n="lblHotkeyEditor"></span><span class="en">hotkeyEditor</span></label>
            <div class="kb" id="kbEditor" tabindex="0"><span class="chips"></span><span class="ph">Click, then press a key combination…</span><button class="x" title="Clear">✕</button></div>
          </div>
        </div>
        <div class="kbd-note" data-i18n-html="kbdNote"></div>
      </div>
    </div>
  </div>
</section>

<section>
  <div class="sec-head"><span class="no">02</span><h2 data-i18n="secCapture"></h2><span class="desc" data-i18n="secCaptureDesc"></span></div>
  <div class="sec-body">
    <div class="row">
      <div class="field">
        <label><span data-i18n="lblMode"></span><span class="en">mode</span></label>
        <select id="captureMode">
          <option value="persistent" data-i18n="optPersistent"></option>
          <option value="ondemand" data-i18n="optOndemand"></option>
        </select>
        <div class="hint" data-i18n="hintMode"></div>
      </div>
      <div class="field">
        <label><span data-i18n="lblPreWarm"></span><span class="en">preWarm</span></label>
        <label class="checkline"><input id="preWarm" type="checkbox"><span class="t" data-i18n="lblPreWarmT"></span><span class="d" data-i18n="lblPreWarmD"></span></label>
      </div>
    </div>
    <div class="row">
      <div class="field">
        <label><span data-i18n="lblMic"></span><span class="en">deviceName</span></label>
        <select id="deviceName"><option value="" data-i18n="optAutoDevice"></option></select>
        <div class="hint" data-i18n="hintMic"></div>
      </div>
    </div>
    <div class="row">
      <div class="field">
        <label><span data-i18n="lblMaxSec"></span><span class="en">maxSeconds</span></label>
          <div class="hint" data-i18n="hintMaxSec"></div>
        </div>
        <div class="field">
          <label><span data-i18n="lblIdleRelease"></span><span class="en">idleReleaseSeconds</span></label>
          <input id="idleReleaseSeconds" type="number" min="10" max="600">
          <div class="hint" data-i18n="hintIdleRelease"></div>
        <input id="maxSeconds" type="number" min="5" max="600">
        <div class="hint" data-i18n="hintMaxSec"></div>
      </div>
      <div class="field">
        <label><span data-i18n="lblFfmpeg"></span><span class="en">ffmpegPath</span></label>
        <input id="ffmpegPath" type="text">
        <div class="hint">Usually leave the default · Advanced: device index override <input id="device" type="text" placeholder='":3", leave empty' style="display:inline-block;width:110px;padding:3px 8px;font-size:12px;margin-left:6px"></div>
      </div>
    </div>
  </div>
</section>

<section>
  <div class="sec-head"><span class="no">03</span><h2 data-i18n="secEngine"></h2><span class="desc" data-i18n="secEngineDesc"></span></div>
  <div class="sec-body">
    <div class="row">
      <div class="field">
        <label><span data-i18n="lblModel"></span><span class="en">model</span></label>
        <select id="model"><option value="">Loading…</option></select>
        <div class="hint" data-i18n="hintModel"></div>
      </div>
      <div class="field">
        <label><span data-i18n="lblTemplate"></span><span class="en">template</span></label>
        <select id="template">
          <option value="faithful-en" data-i18n="optFaithful"></option>
          <option value="polish-zh" data-i18n="optPolish"></option>
        </select>
        <div class="hint" data-i18n="hintTemplate"></div>
      </div>
    </div>
    <div class="row">
      <div class="field">
        <div class="half">
          <div>
            <label><span data-i18n="lblTimeout"></span><span class="en">timeoutSeconds</span></label>
            <input id="timeoutSeconds" type="number" min="10" max="300">
          </div>
          <div>
            <label><span data-i18n="lblTemp"></span><span class="en">temperature</span></label>
            <input id="temperature" type="number" step="0.1" min="0" max="1">
            <div class="hint" data-i18n="hintTemp"></div>
          </div>
        </div>
      </div>
      <div class="field">
        <label><span data-i18n="lblAutoStart"></span><span class="en">autoStartOllama</span></label>
        <label class="checkline"><input id="autoStartOllama" type="checkbox"><span class="t" data-i18n="lblAutoStartT"></span><span class="d">ollama serve</span></label>
      </div>
    </div>
    <div class="row">
      <div class="field">
        <label><span data-i18n="lblGlossary"></span><span class="en">glossary</span> <span style="color:var(--faint);font-weight:400;font-size:12px" data-i18n="lblGlossaryNote"></span></label>
        <textarea id="glossary" placeholder="staking&#10;rewardPerToken&#10;Foundry"></textarea>
      </div>
    </div>
    <div class="try">
      <div class="try-row">
        <div class="field" style="margin:0">
          <label><span data-i18n="lblTry"></span><span class="en">test</span></label>
          <input id="testInput" type="text" data-i18n-ph="phTest">
        </div>
        <button class="ghost" id="btnTest" style="margin-top:22px" data-i18n="btnTry"></button>
      </div>
      <div id="testOut" data-i18n="testOutInit"></div>
    </div>
  </div>
</section>

<section>
  <div class="sec-head"><span class="no">04</span><h2 data-i18n="secOutput"></h2><span class="desc" data-i18n="secOutputDesc"></span></div>
  <div class="sec-body">
    <div class="row">
      <div class="field">
        <label><span data-i18n="lblInsert"></span><span class="en">insertMode</span></label>
        <select id="insertMode">
          <option value="paste" data-i18n="optPaste"></option>
          <option value="replace" data-i18n="optReplace"></option>
        </select>
      </div>
      <div class="field">
        <label><span data-i18n="lblTrailing"></span><span class="en">appendTrailingSpace</span></label>
        <label class="checkline"><input id="appendTrailingSpace" type="checkbox"><span class="t" data-i18n="lblTrailingT"></span><span class="d" data-i18n="lblTrailingD"></span></label>
      </div>
    </div>
  </div>
</section>

</div>

<div class="savebar"><div class="wrap">
  <button id="btnSave" data-i18n="btnSave"></button>
  <button class="ghost" id="btnReload" data-i18n="btnDiscard"></button>
  <span id="msg"></span>
</div></div>

<input type="hidden" id="hotkeyRefine" value=""><input type="hidden" id="hotkeyRaw" value=""><input type="hidden" id="hotkeyEditor" value=""><input type="hidden" id="baseUrl" value="http://127.0.0.1:11434">
<script>
var I18N = {"en":{"title":"pi-voice-refine · Settings","headerSub":"All settings are written to your local ~/.pi/agent/voice-refine.json · saves hot-apply (hotkey changes need /reload in Pi) · this page closes after 10 idle minutes","secHotkeys":"Hotkeys","secHotkeysDesc":"Same key toggles: start → stop & process · press while processing = cancel","lblHotkeyRefine":"Refine-mode record key ","lblHotkeyRaw":"Raw-transcript record key ","kbdNote":"Click a field → press the combination (e.g. <b>Ctrl+Alt+V</b>) → captured automatically. On macOS, a Windows keyboard's Alt key registers as <b>⌘</b>; both variants are registered interchangeably. Esc cancels capture. Run <b>/reload</b> in Pi after changing hotkeys.","phKb":"Click, then press a key combination…","phKbListening":"Press a key combination… (Esc cancels)","clear":"Clear","secCapture":"Capture","secCaptureDesc":"Zero latency = the microphone stays open","lblMode":"Capture mode ","optPersistent":"persistent · zero latency (recommended; mic stays open)","optOndemand":"ondemand · per-recording (~9 s device open)","hintMode":"persistent pre-warms the device when Pi starts, so recording begins in ~0 ms; the trade-off is an always-on mic indicator while Pi runs","lblPreWarm":"Pre-warm ","lblPreWarmT":"Pre-warm the microphone when Pi starts","lblPreWarmD":"first press has no wait","lblMic":"Microphone ","optAutoDevice":"(auto: first non-virtual device)","hintMic":"Pinned by name so macOS device-index drift cannot break it; the list is enumerated live, ✓ marks the active device","lblMaxSec":"Max recording seconds ","hintMaxSec":"Auto-stops and processes at the limit · range 5–600","lblFfmpeg":"ffmpeg path ","phDevice":"e.g. :3 — leave empty","secEngine":"Refine engine (local LLM)","secEngineDesc":"Text never leaves this machine","lblModel":"Model ","hintModel":"Lists models installed in your local Ollama; or hot-switch with /vrefine model use <name>","lblTemplate":"Template ","optFaithful":"faithful-en · faithful translation, filler removal only (default)","optPolish":"polish-zh · keep Chinese, clean fillers/punctuation","hintTemplate":"Speak Chinese and want Chinese output → pick polish-zh","lblTimeout":"Timeout (seconds) ","lblTemp":"Temperature ","hintTemp":"Lower is more faithful · 0–1","lblAutoStart":"Ollama auto-start ","lblAutoStartT":"Start Ollama automatically when it is not running","lblGlossary":"Glossary ","lblGlossaryNote":"one per line · preserved verbatim","lblTry":"Try it with the current settings ","phTest":"e.g. run cargo test and tell me if it passes","btnTry":"Try ⏎","testOutInit":"Result and timing will appear here…","secOutput":"Output","secOutputDesc":"Results only enter the input box, never auto-submitted","lblInsert":"Insert mode ","optPaste":"paste · insert at the cursor (recommended)","optReplace":"replace · replace the whole input box","lblTrailing":"Trailing space ","lblTrailingT":"Append a space after insertion","lblTrailingD":"handy for continued typing","btnSave":"Save & apply","btnDiscard":"Discard changes","msgLoaded":"Loaded current settings","msgSaving":"Saving…","msgSaved":"Saved and applied","msgSavedReload":"Saved · run /reload in Pi to apply hotkey changes","msgSaveFailed":"Save failed: ","msgEnterText":"Enter some text to test first","msgThinking":"Thinking… (the first run may need to load the model)","msgRetried":" (retried once)","devActive":" ✓ active","devVirtual":" (virtual · not recommended)","devAuto":"(auto: first non-virtual device)","badgeAsrOk":"ASR model ready","badgeAsrMissing":"ASR model not downloaded","badgeLlmOk":"Ollama running","badgeLlmDown":"Ollama not running","modelLoading":"Loading…","lblHotkeyEditor":"Editor-draft refine key ","lblIdleRelease":"Mic idle release (s) ","hintIdleRelease":"Release the microphone after this many seconds without activity in this window — lets other Pi sessions use it"},"zh":{"title":"pi-voice-refine · 设置","headerSub":"所有配置仅写入本机 ~/.pi/agent/voice-refine.json · 保存即热生效（快捷键需在 Pi 中 /reload）· 页面 10 分钟无操作自动关闭","secHotkeys":"快捷键","secHotkeysDesc":"同一键为乒乓开关：开始 → 停止并处理 · 处理中再按 = 取消","lblHotkeyRefine":"重述模式录音键 ","lblHotkeyRaw":"原文模式录音键 ","kbdNote":"点击输入框 → 直接按组合键（如 <b>Ctrl+Alt+V</b> / Mac 上 <b>⌃⌥V</b>）→ 自动识别。Windows 键盘的 Alt 在 macOS 中按 <b>⌘</b> 识别，两者自动互通；Esc 取消录制。修改后需在 Pi 中执行 <b>/reload</b> 生效。","phKb":"点击后按下组合键…","phKbListening":"按下组合键…（Esc 取消）","clear":"清除","secCapture":"录音采集","secCaptureDesc":"零延迟 = 麦克风常驻（指示灯常亮）","lblMode":"采集模式 ","optPersistent":"persistent · 零延迟（推荐，麦克风常开）","optOndemand":"ondemand · 按需（每次开启约 9 秒）","hintMode":"persistent 在 Pi 启动时预热设备，按键 0ms 即录；代价是运行期间麦克风指示灯常亮","lblPreWarm":"启动预热 ","lblPreWarmT":"Pi 启动时预热麦克风","lblPreWarmD":"首次按键零等待","lblMic":"麦克风设备 ","optAutoDevice":"（自动：第一个非虚拟设备）","hintMic":"按名字锁定，不受 macOS 设备索引漂移影响；列表实时枚举，✓ 为当前生效","lblMaxSec":"最长录音时长（秒） ","hintMaxSec":"到时自动停止并处理 · 范围 5–600","lblFfmpeg":"ffmpeg 路径 ","phDevice":"如 :3，留空","secEngine":"重述引擎（本地 LLM）","secEngineDesc":"文本不出本机","lblModel":"模型 ","hintModel":"自动列出本机 Ollama 已安装模型；也可用命令 /vrefine model use <name> 热切换","lblTemplate":"处理模板 ","optFaithful":"faithful-en · 忠实译成英文：仅去口水词，零改写（默认）","optPolish":"polish-zh · 保留中文：去口水词/加标点","hintTemplate":"说中文想直接出中文 → 选 polish-zh","lblTimeout":"超时（秒） ","lblTemp":"温度 ","hintTemp":"越低越忠实 · 0–1","lblAutoStart":"Ollama 自动拉起 ","lblAutoStartT":"Ollama 未运行时自动拉起","lblGlossary":"术语表 ","lblGlossaryNote":"每行一个 · 原样保留","lblTry":"用当前配置试一句 ","phTest":"例如：帮我跑一下 cargo test 看看能不能过","btnTry":"试跑 ⏎","testOutInit":"结果与耗时显示在这里…","secOutput":"输出","secOutputDesc":"结果只进输入框，永不自动发送","lblInsert":"插入方式 ","optPaste":"paste · 插入光标处（推荐）","optReplace":"replace · 替换整个输入框","lblTrailing":"尾随空格 ","lblTrailingT":"插入后补一个空格","lblTrailingD":"方便继续键入","btnSave":"保存并生效","btnDiscard":"放弃修改","msgLoaded":"已载入当前配置","msgSaving":"保存中…","msgSaved":"已保存并生效","msgSavedReload":"已保存 · 快捷键改动需在 Pi 中执行 /reload 生效","msgSaveFailed":"保存失败：","msgEnterText":"请先输入测试文本","msgThinking":"思考中…（首次可能需加载模型）","msgRetried":"（重试过一次）","devActive":" ✓ 当前生效","devVirtual":"（虚拟·不建议）","devAuto":"（自动：第一个非虚拟设备）","badgeAsrOk":"ASR 模型就绪","badgeAsrMissing":"ASR 模型未下载","badgeLlmOk":"Ollama 运行中","badgeLlmDown":"Ollama 未运行","modelLoading":"加载中…","lblHotkeyEditor":"编辑器草稿精炼键 ","lblIdleRelease":"麦克风闲置释放（秒） ","hintIdleRelease":"本窗口无输入活动超过该秒数后释放麦克风——其他 Pi 窗口即可使用"}};
var LANG = (function(){
  try { var saved = localStorage.getItem('vr-lang'); if(saved==='en'||saved==='zh') return saved; } catch(e){}
  return (navigator.language||'').toLowerCase().indexOf('zh')===0 ? 'zh' : 'en';
})();
function t(key){ return (I18N[LANG] && I18N[LANG][key]) || (I18N.en[key] || '') ; }
function applyI18n(){
  document.title = t('title');
  [].forEach.call(document.querySelectorAll('[data-i18n]'), function(el){ el.textContent = t(el.getAttribute('data-i18n')); });
  [].forEach.call(document.querySelectorAll('[data-i18n-html]'), function(el){ el.innerHTML = t(el.getAttribute('data-i18n-html')); });
  [].forEach.call(document.querySelectorAll('[data-i18n-ph]'), function(el){ el.placeholder = t(el.getAttribute('data-i18n-ph')); });
  $('btnLang').textContent = LANG==='en' ? '中文' : 'EN';
}
$('btnLang').onclick = function(){
  LANG = LANG==='en' ? 'zh' : 'en';
  try { localStorage.setItem('vr-lang', LANG); } catch(e){}
  applyI18n(); renderKbPlaceholders();
};
function renderKbPlaceholders(){
  [].forEach.call(document.querySelectorAll('.kb'), function(el){
    var ph = el.querySelector('.ph'); if(!ph) return;
    if(el.classList.contains('listening')) { ph.textContent = t('phKbListening'); }
    else if(!el.querySelector('chips').children.length){ ph.textContent = t('phKb'); ph.style.display=''; }
  });
}

var TOKEN = new URLSearchParams(location.search).get('token');
function api(path, opts){
  opts = opts || {};
  opts.headers = Object.assign({'Authorization':'Bearer '+TOKEN,'Content-Type':'application/json'}, opts.headers||{});
  return fetch(path, opts).then(function(r){ return r.json().then(function(j){ if(!r.ok) throw new Error(j.error||r.status); return j; }); });
}
function $(id){ return document.getElementById(id); }
function setMsg(t, cls){ var m=$('msg'); m.textContent=t; m.className=cls||''; }
var IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/* ── hotkey capture widget ────────────────────── */
function comboChips(combo){ // combo: {ctrl,alt,shift,super,key}
  var chips = [];
  if(combo.ctrl)   chips.push(IS_MAC ? '⌃ Ctrl' : 'Ctrl');
  if(combo.alt)    chips.push(IS_MAC ? '⌥ Alt' : 'Alt');
  if(combo.shift)  chips.push(IS_MAC ? '⇧ Shift' : 'Shift');
  if(combo.super)  chips.push(IS_MAC ? '⌘ Cmd' : 'Win');
  if(combo.key)    chips.push(combo.key.length===1 ? combo.key.toUpperCase() : combo.key);
  return chips;
}
function comboToId(c){
  var parts = [];
  if(c.ctrl) parts.push('ctrl'); if(c.alt) parts.push('alt');
  if(c.shift) parts.push('shift'); if(c.super) parts.push('super');
  if(c.key) parts.push(c.key);
  return parts.join('+');
}
function idToCombo(id){
  var c = {ctrl:false,alt:false,shift:false,super:false,key:''};
  id.toLowerCase().split('+').forEach(function(p){
    if(p==='ctrl')c.ctrl=true; else if(p==='alt')c.alt=true; else if(p==='shift')c.shift=true;
    else if(p==='super')c.super=true; else if(p)c.key=p;
  });
  return c;
}
function keyFromEvent(e){
  var k = e.key;
  if(!k || ['Control','Alt','Shift','Meta','Dead','Unidentified'].indexOf(k)>=0) return null;
  if(k===' ') return 'space';
  if(k==='Escape') return 'escape';
  if(k==='Enter') return 'enter';
  if(k==='Tab') return 'tab';
  if(k==='Backspace') return 'backspace';
  if(k==='ArrowUp') return 'up'; if(k==='ArrowDown') return 'down';
  if(k==='ArrowLeft') return 'left'; if(k==='ArrowRight') return 'right';
  if(k==='PageUp') return 'pageup'; if(k==='PageDown') return 'pagedown';
  if(k==='Home') return 'home'; if(k==='End') return 'end'; if(k==='Delete') return 'delete';
  if(/^F(\d{1,2})$/.test(k)) return k.toLowerCase();
  if(k.length===1) return k.toLowerCase();
  return null;
}
function kbWidget(el, hiddenSetter, getter){
  var combo = null, listening = false;
  var chips = el.querySelector('.chips'), ph = el.querySelector('.ph'), x = el.querySelector('.x');
  function render(){
    chips.innerHTML = '';
    if(listening){ el.classList.add('listening'); ph.textContent=t('phKbListening'); ph.style.display=''; }
    else { el.classList.remove('listening'); if(combo){ ph.style.display='none';
        comboChips(combo).forEach(function(t){ var k=document.createElement('kbd'); k.textContent=t; chips.appendChild(k); });
      } else { ph.style.display=''; ph.textContent=t('phKb'); } }
    x.style.display = combo ? '' : 'none';
    hiddenSetter(combo ? comboToId(combo) : '');
  }
  el.addEventListener('click', function(ev){ if(ev.target===x) return; el.focus(); });
  el.addEventListener('keydown', function(e){
    e.preventDefault(); e.stopPropagation();
    if(!listening){ listening = true; render(); return; }
    if(e.key==='Escape'){ listening=false; render(); return; }
    var k = keyFromEvent(e);
    if(k===null){ combo = {ctrl:e.ctrlKey,alt:e.altKey,shift:e.shiftKey,super:e.metaKey,key:''}; render(); return; } // modifier-only press: stash until the main key arrives
    combo = {ctrl:e.ctrlKey,alt:e.altKey,shift:e.shiftKey,super:e.metaKey,key:k};
    listening = false; render(); el.blur();
  });
  el.addEventListener('blur', function(){ listening=false; render(); });
  x.addEventListener('click', function(ev){ ev.stopPropagation(); combo=null; listening=false; render(); el.focus(); });
  return { set:function(id){ combo = id ? idToCombo(id) : null; listening=false; render(); }, get:function(){ return combo ? comboToId(combo) : ''; } };
}
var wRefine = kbWidget($('kbRefine'), function(v){ $('hotkeyRefine').value=v; });
var wRaw    = kbWidget($('kbRaw'),    function(v){ $('hotkeyRaw').value=v; });
var wEditor = kbWidget($('kbEditor'), function(v){ $('hotkeyEditor').value=v; });

/* ── load / collect ───────────────────────────── */
function fill(cfg){
  $('hotkeyRefine').value = cfg.hotkeyRefine||''; $('hotkeyRaw').value = cfg.hotkeyRaw||''; $('hotkeyEditor').value = cfg.hotkeyEditor||'';
  wRefine.set(cfg.hotkeyRefine||''); wRaw.set(cfg.hotkeyRaw||''); wEditor.set(cfg.hotkeyEditor||'');
  $('captureMode').value=cfg.capture.mode||'persistent'; $('preWarm').checked=cfg.capture.preWarm!==false;
  $('maxSeconds').value=cfg.capture.maxSeconds; $('idleReleaseSeconds').value=cfg.capture.idleReleaseSeconds||60; $('ffmpegPath').value=cfg.capture.ffmpegPath;
  $('device').value=cfg.capture.device||''; $('baseUrl').value=cfg.refine.baseUrl;
  $('model').value=cfg.refine.model; $('template').value=cfg.refine.template;
  $('timeoutSeconds').value=cfg.refine.timeoutSeconds; $('temperature').value=cfg.refine.temperature;
  $('autoStartOllama').checked=!!cfg.refine.autoStartOllama; $('glossary').value=cfg.refine.glossary.join('\\n');
  $('insertMode').value=cfg.output.insertMode; $('appendTrailingSpace').checked=!!cfg.output.appendTrailingSpace;
  var sel=$('model');
  if(![].some.call(sel.options,function(o){return o.value===cfg.refine.model;})){
    var o=document.createElement('option'); o.value=o.textContent=cfg.refine.model; sel.appendChild(o); sel.value=cfg.refine.model;
  }
}
function collect(){
  return {
    hotkeyRefine: $('hotkeyRefine').value.trim() || 'ctrl+alt+v',
    hotkeyRaw: $('hotkeyRaw').value.trim() || 'ctrl+alt+r',
    hotkeyEditor: $('hotkeyEditor').value.trim() || 'ctrl+alt+e',
    capture:{
      mode:$('captureMode').value, preWarm:$('preWarm').checked,
      deviceName:$('deviceName').value.trim(), device:$('device').value.trim(),
      ffmpegPath:$('ffmpegPath').value.trim()||'ffmpeg',
      maxSeconds:Math.max(5,Math.min(600,parseInt($('maxSeconds').value)||120)), idleReleaseSeconds:Math.max(10,Math.min(600,parseInt($('idleReleaseSeconds').value)||60))
    },
    refine:{
      baseUrl:$('baseUrl').value.trim()||'http://127.0.0.1:11434',
      model:$('model').value, template:$('template').value,
      timeoutSeconds:Math.max(10,Math.min(300,parseInt($('timeoutSeconds').value)||60)),
      temperature:Math.min(1,Math.max(0,parseFloat($('temperature').value)||0.3)),
      autoStartOllama:$('autoStartOllama').checked,
      glossary:$('glossary').value.split('\\n').map(function(s){return s.trim();}).filter(Boolean)
    },
    output:{ insertMode:$('insertMode').value, appendTrailingSpace:$('appendTrailingSpace').checked }
  };
}
function load(){ return api('/api/config').then(fill).then(function(){ setMsg(t('msgLoaded'),'ok'); }); }
$('btnSave').onclick=function(){
  setMsg(t('msgSaving'),'');
  api('/api/config',{method:'POST',body:JSON.stringify(collect())})
   .then(function(r){ setMsg(r.needsReload?t('msgSavedReload'):t('msgSaved'),'ok'); load(); })
   .catch(function(e){ setMsg(t('msgSaveFailed')+e.message,'err'); });
};
$('btnReload').onclick=function(){ load(); };
$('btnTest').onclick=doTest;
$('testInput').addEventListener('keydown',function(e){ if(e.key==='Enter') doTest(); });
function doTest(){
  var t=$('testInput').value.trim(); if(!t){ setMsg(t('msgEnterText'),'warn'); return; }
  $('btnTest').disabled=true; $('testOut').textContent=t('msgThinking');
  var p = api('/api/test-refine',{method:'POST',body:JSON.stringify({text:t})})
   .then(function(r){ $('testOut').textContent=r.text+'\\n\\n⏱ '+(r.durationMs/1000).toFixed(1)+'s'+(r.retried?t('msgRetried'):''); })
   .catch(function(e){ $('testOut').textContent='❌ '+e.message; });
  Promise.resolve(p).finally ? p.finally(function(){ $('btnTest').disabled=false; }) : p.then(function(){ $('btnTest').disabled=false; },function(){ $('btnTest').disabled=false; });
}

/* ── devices / models / status badges ─────────── */
api('/api/devices').then(function(d){
  var sel=$('deviceName'), cur=d.deviceName||'';
  sel.innerHTML='<option value="">'+t('devAuto')+'</option>';
  (d.devices||[]).forEach(function(dev){
    var virt=/morphvox|vb-?cable|blackhole|loopback|soundflower|aggregate|virtual/i.test(dev.name);
    var mark=(d.resolved===dev.index?t('devActive'):'')+(virt?t('devVirtual'):'');
    var o=document.createElement('option'); o.value=dev.name; o.textContent='['+dev.index+'] '+dev.name+mark; sel.appendChild(o);
  });
  if(cur && [].every.call(sel.options,function(o){return o.value!==cur;})){var o=document.createElement('option');o.value=o.textContent=cur;sel.appendChild(o);}
  sel.value=cur;
}).catch(function(){});
api('/api/model-status').then(function(s){
  var b=$('asrBadge'); b.textContent = s.asrModelReady?t('badgeAsrOk'):t('badgeAsrMissing'); b.className='badge '+(s.asrModelReady?'ok':'bad');
}).catch(function(){});
api('/api/ollama/models').then(function(s){
  var b=$('llmBadge');
  if(!s.running){ b.textContent=t('badgeLlmDown'); b.className='badge bad'; return; }
  b.textContent=t('badgeLlmOk'); b.className='badge ok';
  var sel=$('model'), cur=sel.value;
  sel.innerHTML='<option value="">'+t('modelLoading')+'</option>';
  s.models.forEach(function(m){ var o=document.createElement('option'); o.value=o.textContent=m; sel.appendChild(o); });
  if(s.models.indexOf(cur)===-1 && cur){ var o=document.createElement('option'); o.value=o.textContent=cur; sel.appendChild(o); }
  sel.value=cur||s.models[0]||'';
}).catch(function(){});
applyI18n();
load();
</script>
</body>
</html>`;
