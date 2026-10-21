# pi-voice-refine

Local voice dictation for the [Pi coding agent](https://github.com/earendil-works/pi): press a hotkey, speak in Chinese or English (or mixed), and get a **faithful English translation of exactly what you said** — filler words removed, nothing added, nothing reordered — inserted at your cursor. Fully offline: audio and text never leave your machine.

```
hotkey ─► speak (zh / en / mixed)
       ─► capture   ffmpeg → 16 kHz mono PCM (persistent, zero-latency)
       ─► ASR       SenseVoice int8 via sherpa-onnx, in-process (~1 s)
       ─► refine    local LLM (Ollama): sentence-by-sentence faithful
                    translation, disfluency removal only (~1–3 s warm)
       ─► insert    at the cursor — never auto-submitted
```

## Why "faithful" is the default

Most voice-to-prompt tools rewrite your speech into "professional" instructions. This project deliberately does not: **the only transformation is translation plus filler removal.** Every sentence you speak maps to one sentence in the output, in the same order. If you said something vague, it stays vague; if you set a constraint, it appears exactly once — never invented, never dropped. This matters when you cannot proofread the output yourself.

Two modes are available:

| Template | Behavior |
|---|---|
| `faithful-en` (default) | Sentence-by-sentence translation to English; removes only filler words, repetitions, and false starts. No additions, deletions, reordering, restructuring, or register changes. |
| `polish-zh` | Keep Chinese; clean disfluencies and fix punctuation. English-only input is automatically routed to `faithful-en`. |

Switch with `/vrefine template <name>` or from the web config page.

## Features

- **Zero-latency capture** — the microphone is held open for the session (macOS), so pressing the hotkey starts recording instantly (~0 ms vs ~9 s cold open on USB microphones)
- **Device-name pinning** — survives macOS input-device index drift; virtual loopback devices (VB-Cable, BlackHole, MorphVOX, …) are never auto-selected
- **Self-healing capture** — device loss mid-recording salvages the buffered audio; zero-signal streams (device conflict or hardware mute) are detected and restarted automatically
- **Degradation guarantees** — if the LLM fails or times out, the raw transcript is inserted instead of being lost; a warm retry handles cold model loads
- **Mixed-draft refinement** — dictate the prose (`ctrl+alt+r`), paste any code/links/logs wherever you like, then `ctrl+alt+e` translates the Chinese prose while every technical element is kept byte-exact (protected content is never sent to the model)
- **Local-first config UI** — `/vrefine config` opens a browser page (loopback + one-time token) with hotkey recording, live device/model pickers, and a try-it box; saves hot-apply. The page is bilingual (English / 中文): the language follows your browser and can be toggled in the header
- **Editor safety** — results are only ever inserted, never auto-submitted; your existing input is never clobbered
- **Privacy** — inference is in-process (WASM) or loopback-only (Ollama); temp audio is cleaned on every exit path

## Requirements

- macOS with a working microphone (Linux/Windows: see [Platform notes](#platform-notes))
- [Pi](https://github.com/earendil-works/pi) ≥ 1.1.0
- Node.js ≥ 18 to run the extension under Pi (≥ 22.6 for the development scripts, which use native TypeScript stripping)
- `ffmpeg` on `PATH` (`brew install ffmpeg`)
- [Ollama](https://ollama.com) with a chat model pulled, e.g. `ollama pull qwen3:8b`

The ASR model (SenseVoice int8, ~230 MB) is downloaded once on first use — `/vrefine model download`.

## Installation

### From a git checkout (this repository)

```bash
git clone <your-repo-url>/pi-voice-refine.git
cd pi-voice-refine
npm install

# Link the extension into Pi's personal extensions directory
mkdir -p ~/.pi/agent/extensions
ln -sfn "$(pwd)/src" ~/.pi/agent/extensions/voice-refine
```

Restart Pi (or run `/reload`). Press the default hotkey; if macOS asks for microphone permission, click **Allow** once.

### As a Pi package

Once published (`npm publish` under a scope of your choice):

```bash
pi install npm:<your-scope>/pi-voice-refine
```

Or directly from a git URL:

```bash
pi install git:github.com/<you>/pi-voice-refine
```

### Verify the install

```
/vrefine status   # ASR model, Ollama reachability, hotkeys, template
/vrefine test     # end-to-end self-test with a sample sentence
```

## Usage

| Key / command | Action |
|---|---|
| `ctrl+alt+v` (default; a `ctrl+super+v` twin is auto-registered for keyboards whose Alt maps to ⌘) | idle: start recording · recording: stop and process · processing: cancel |
| `ctrl+alt+r` | same toggle, but inserts the raw transcript (no LLM) |
| `ctrl+alt+e` | refine the current editor draft: translate its Chinese prose to English; pasted code/links/logs are kept byte-exact (never sent to the LLM) |
| `Esc` | cancel an active recording/processing run only |
| `/vrefine status` | state, config path, model + Ollama health, resolved input device |
| `/vrefine editor` | same as the `ctrl+alt+e` hotkey (only reachable when the editor is empty — with a draft loaded, typed commands append as text; use the hotkey) |
| `/vrefine cancel` | cancel current run (also aborts a model download) |
| `/vrefine test` | self-check + one real refine round-trip |
| `/vrefine model` · `/vrefine model download` | model status / one-time download (cancellable) |
| `/vrefine model use <name>` | hot-switch the refine model (validates against installed models) |
| `/vrefine template [name]` | show or switch the processing template |
| `/vrefine devices` | list audio inputs with the resolved current device |
| `/vrefine config` · `/vrefine config stop` | open/close the local web config page |

Speaking longer than `capture.maxSeconds` (default 120 s) auto-stops and processes.

### Two workflows

**Pure dictation** — speak, get English, send:

```
ctrl+alt+v  →  speak  →  ctrl+alt+v  →  English is inserted  →  Enter
```

**Mixed draft** — when you need to embed code, links, or logs that cannot be spoken:

```
ctrl+alt+r  →  speak the narration  →  ctrl+alt+r   (raw Chinese transcript inserted)
paste code / links / logs anywhere in the draft
ctrl+alt+e  →  Chinese prose is translated; pasted content stays byte-exact
Enter
```

The refine step sends only the Chinese lines to the model — a 200-line paste costs zero model tokens and cannot be altered.

## Configuration

`~/.pi/agent/voice-refine.json` (created with defaults on first run). Everything is editable from `/vrefine config` — including the hotkeys (click, then press the combination; Mac and Windows modifiers both supported), the microphone (by stable device name, with live enumeration), capture mode (`persistent` zero-latency vs `ondemand`), the Ollama model, timeout, temperature, and a glossary of terms that must be preserved verbatim.

Highlights:

```jsonc
{
  "hotkeyRefine": "ctrl+alt+v",       // dictate → faithful English
  "hotkeyRaw": "ctrl+alt+r",          // dictate → raw transcript (for the mixed-draft flow)
  "hotkeyEditor": "ctrl+alt+e",       // refine the editor draft (translate Chinese prose only)
  "capture": {
    "mode": "persistent",      // zero-latency; mic follows the active window
    "preWarm": true,           // pre-warm on input activity (focus proxy)
    "deviceName": "",          // pin by name, e.g. "Yeti Nano"; empty = auto
    "maxSeconds": 120,
    "idleReleaseSeconds": 60   // release the mic after this much inactivity
  },
  "refine": {
    "api": "ollama",           // or "openai" for llama.cpp/LM Studio servers
    "baseUrl": "http://127.0.0.1:11434",
    "model": "qwen3:8b",
    "template": "faithful-en",
    "glossary": []
  },
  "output": { "insertMode": "paste" } // or "replace"
}
```

## Platform notes

- **macOS** — full support. Capture uses AVFoundation; device resolution and persistent mode are macOS-specific. The first hotkey press may surface the TCC microphone permission dialog.
- **Linux** — works with on-demand capture through PulseAudio (`capture.device` accepts a Pulse source name; persistent mode and device-name pinning are AVFoundation-only and auto-fallback). Set `capture.device` manually.
- **Windows** — experimental: on-demand capture via DirectShow with `capture.device` set to a `audio=<name>` device string. Not covered by CI; reports welcome.
- **CPU arch** — SenseVoice runs via the sherpa-onnx WASM build (single-threaded); Apple Silicon and modern x86 are both fine.

### Remote / headless / PaaS deployments

This extension is designed for **local use with Pi's interactive TUI**, because two pieces fundamentally require local resources:

1. **The microphone** — capture needs an audio input device on the machine running Pi. Containers/PaaS instances have none.
2. **The TUI** — hotkeys, the status bar, and cursor insertion only exist in interactive mode.

What does work remotely, and how people typically run it:

- **Pi on a remote box, mic in front of you** — not currently supported. There is no audio-bridge transport (uploading mic frames from a local helper to the remote Pi) in this project yet; that is the main open feature for remote use. Everything else in the pipeline (ASR inference, Ollama refine, the config page) is location-agnostic.
- **Ollama on a different host** — set `refine.baseUrl` to that host. Keep it on a private network or an SSH tunnel (`ssh -L 11434:127.0.0.1:11434 host`); the default config assumes loopback for the fully-local guarantee.
- **The config page over SSH** — `/vrefine config` binds `127.0.0.1` with a random port and one-time token. Forward it: `ssh -L 8123:127.0.0.1:<port> host`, then open the printed URL locally (swap the hostname).
- **ASR + refine only (no capture)** — the transcriber and refiner are plain TypeScript modules with no TUI dependencies; you can reuse them in your own tooling (`import { Transcriber } from "…"`, `refineTranscript(…)`) on any host, including PaaS.

If you want first-class remote capture (local mic → remote Pi over an authenticated tunnel, similar to how some STT extensions do it), contributions are welcome — the recorder is behind a small interface (`RecorderLike`) precisely so a bridge implementation can slot in.

## Development

```bash
npm run typecheck                                      # tsc --noEmit
npm test                                               # vitest (unit + edge + LLM-layer suites)
node --experimental-strip-types scripts/smoke.ts       # load the real extension with a mock ExtensionAPI
node --experimental-strip-types scripts/exception-battery.ts   # 34 real failure scenarios (bad device, dead model, abusive HTTP, …)
E2E_VOICE="…" node --experimental-strip-types scripts/e2e.ts "text to synthesize"  # full chain via macOS `say`
```

Project layout:

```
src/
  index.ts            # Pi extension entry: hotkeys, commands, lifecycle
  pipeline.ts         # state machine: STARTING→RECORDING→TRANSCRIBING→REFINING→INSERTED
  recorder.ts         # on-demand + persistent (zero-latency) ffmpeg capture, device resolution
  transcriber.ts      # sherpa-onnx (SenseVoice) wrapper
  model-manager.ts    # one-time model download/extract/verify
  refiner/            # ollama client (ollama + OpenAI-compatible), prompt contract, post-processing
  config.ts           # typed config, hostile-input normalization, mtime cache
  config-server.ts    # loopback web config page (token auth, hot-apply)
  status.ts, formatter.ts, utils.ts
test/                 # vitest suites incl. fidelity and regression tests
```

### Known limitations

- Long recordings block the UI briefly during transcription (in-process WASM inference: ~4 s for 60 s of audio; keep utterances under a minute for a snappy feel).
- ASR accuracy on English terms inside Chinese speech depends on pronunciation; add frequent terms to the glossary.
- The refine output cap scales with input length (800–3000 tokens); monologues beyond ~10 minutes may truncate.
- After `ctrl+alt+e` refines a draft, the content is written back as plain editor text: Pi no longer treats large pastes as collapsible attachments when the message is sent, so long code blocks are submitted inline and consume agent-context tokens.
- Recognition errors pass through uncorrected by design — faithful mode translates what was heard, it never "fixes" it.
- Multiple Pi windows coexist by design: the microphone follows the window you are actually using. Keystrokes (which only reach the focused window) keep that session's capture warm; a window with no activity for `idleReleaseSeconds` (default 60 s) releases the microphone so other sessions can take it. The first press in a newly-active window may pay a one-time device-open delay.

## Privacy & security

- No telemetry. The only network requests are model download (explicit, one-time) and the configured loopback LLM endpoint.
- For diagnostics, hotkey-related terminal input chunks and pipeline state transitions are appended to a size-capped local log at `~/.pi/agent/voice-refine-debug.log`. It is plain text on your machine only; delete it any time.
- The config server binds `127.0.0.1` only, requires a per-session token (constant-time compared), validates the `Host` header, and shuts down after 10 idle minutes.
- Temporary WAV files are removed on success, failure, cancel, and shutdown paths.
- Speech content is treated strictly as data; the prompt contract forbids transcript-driven instruction changes.

## License

[MIT](./LICENSE)
