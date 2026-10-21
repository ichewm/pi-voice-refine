/**
 * Smoke test: load the real extension entry with a mock ExtensionAPI and
 * exercise command handlers. Requires no Pi runtime (type-only peer import).
 */

export {}; // mark as module for top-level await

type Handler = (args: string, ctx: any) => Promise<void> | void;

const shortcuts: Array<{ key: string; desc?: string }> = [];
const commands = new Map<string, Handler>();
const events = new Map<string, Handler>();
const notifications: string[] = [];
const statuses = new Map<string, string | undefined>();
let editorText = "";

const mockCtx = {
	ui: {
		notify: (msg: string) => notifications.push(msg),
		setStatus: (key: string, text: string | undefined) => statuses.set(key, text),
		pasteToEditor: (t: string) => (editorText += t),
		setEditorText: (t: string) => (editorText = t),
		getEditorText: () => editorText,
		onTerminalInput: () => () => {},
	},
};

const mockPi = {
	registerShortcut: (key: string, opts: { description?: string; handler: Handler }) => {
		shortcuts.push({ key, desc: opts.description });
	},
	registerCommand: (name: string, opts: { handler: Handler }) => {
		commands.set(name, opts.handler);
	},
	on: (event: string, handler: Handler) => {
		events.set(event, handler);
	},
};

const mod = await import("../src/index.ts");
mod.default(mockPi as never);

let failures = 0;
function check(name: string, cond: boolean) {
	console.log(`${cond ? "✅" : "❌"} ${name}`);
	if (!cond) failures += 1;
}

check("registers refine shortcut (ctrl+alt+v)", shortcuts.some((s) => s.key === "ctrl+alt+v"));
check("registers raw shortcut (ctrl+alt+r)", shortcuts.some((s) => s.key === "ctrl+alt+r"));
check("registers /vrefine command", commands.has("vrefine"));
check("listens to session_start", events.has("session_start"));
check("listens to session_shutdown", events.has("session_shutdown"));

// Drive /vrefine status
notifications.length = 0;
await commands.get("vrefine")!("status", mockCtx);
check(
	"/vrefine status prints ASR + LLM state",
	notifications.some((n) => n.includes("asr:") && n.includes("llm:")),
);

// Drive /vrefine cancel (no active run — must not throw)
await commands.get("vrefine")!("cancel", mockCtx);
check("/vrefine cancel safe when idle", true);

// Usage line for unknown subcommand
notifications.length = 0;
await commands.get("vrefine")!("bogus", mockCtx);
check("unknown subcommand prints usage", notifications.some((n) => n.includes("usage")));

process.exit(failures === 0 ? 0 : 1);
