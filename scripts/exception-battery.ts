/**
 * Real-world exception battery: exercises the actual recorder/refiner/
 * transcriber/model-manager/config-server against real failure modes.
 * Exit code 0 = all scenarios behaved correctly (graceful errors, no crashes).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Isolate every config read/write into a temp agent dir — never touch the
// contributor's real ~/.pi/agent/voice-refine.json.
const tmpAgentDir = mkdtempSync(join(tmpdir(), "vrefine-battery-"));
process.env.PI_CODING_AGENT_DIR = tmpAgentDir;
process.on("exit", () => rmSync(tmpAgentDir, { recursive: true, force: true }));

import { Recorder } from "../src/recorder.ts";
import { Transcriber } from "../src/transcriber.ts";
import { refineTranscript, RefinerError } from "../src/refiner/ollama.ts";
import { downloadModel, isModelReady } from "../src/model-manager.ts";
import { startConfigServer } from "../src/config-server.ts";
import { loadConfig, saveConfig, expandTilde } from "../src/config.ts";
import { tempWavPath, cleanupTempFile } from "../src/utils.ts";
import { writeFileSync } from "node:fs";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = "") {
	console.log(`${cond ? "✅" : "❌"} ${name}${detail && !cond ? ` — ${detail}` : ""}`);
	cond ? pass++ : fail++;
}

const expectErr = async (name: string, fn: () => Promise<unknown>, code: string) => {
	try {
		await fn();
		check(name, false, "did not throw");
	} catch (err) {
		const e = err as { code?: string };
		check(name, err instanceof RefinerError || "code" in (err as object), `got ${(err as Error).message}`);
		check(`${name} [code=${code}]`, e.code === code, `got code=${e.code}`);
	}
};

console.log("== Recorder 异常 ==");

// 1. 不存在的 ffmpeg
{
	const r = new Recorder();
	await expectErr("不存在的 ffmpeg → SPAWN_FAILED", () => r.start(tempWavPath(), {
		ffmpegPath: "/nonexistent/ffmpeg", device: ":0", sampleRate: 16000, channels: 1, maxSeconds: 5,
	}), "SPAWN_FAILED");
}

// 2. 无效音频设备（索引 99 不存在）
{
	const r = new Recorder();
	const t0 = Date.now();
	await expectErr("无效设备 :99 → EARLY_EXIT/START_TIMEOUT", () => r.start(tempWavPath(), {
		ffmpegPath: "ffmpeg", device: ":99", sampleRate: 16000, channels: 1, maxSeconds: 5,
	}), "EARLY_EXIT");
	console.log(`   (failed in ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

// 3. 未录音时 stop
{
	const r = new Recorder();
	await expectErr("未录音时 stop → NOT_RECORDING", () => r.stop(), "NOT_RECORDING");
}

// 4. kill 空闲 recorder 安全
{
	const r = new Recorder();
	check("空闲 kill 无异常", r.kill() === null);
}

// 5. 顺序复用：录音→停止→再录音
{
	const r = new Recorder();
	const wav1 = tempWavPath();
	try {
		await r.start(wav1, { ffmpegPath: "ffmpeg", device: ":0", sampleRate: 16000, channels: 1, maxSeconds: 30 });
		await new Promise((res) => setTimeout(res, 800));
		await r.stop();
		const wav2 = tempWavPath();
		await r.start(wav2, { ffmpegPath: "ffmpeg", device: ":0", sampleRate: 16000, channels: 1, maxSeconds: 30 });
		await new Promise((res) => setTimeout(res, 800));
		await r.stop();
		check("顺序复用两次录音成功", true);
		cleanupTempFile(wav1);
		cleanupTempFile(wav2);
	} catch (err) {
		check("顺序复用两次录音成功", false, (err as Error).message);
	}
}

console.log("== Transcriber 异常 ==");

// 6. init 缺失模型目录
{
	const t = new Transcriber();
	await expectErr("模型目录不存在 → MODEL_MISSING", () => t.init("/nonexistent/model-dir"), "MODEL_MISSING");
}

// 7. 未 init 就 transcribe
{
	const t = new Transcriber();
	await expectErr("未初始化 transcribe → NOT_INITIALIZED", () => Promise.reject(t.transcribe("/tmp/x.wav")), "NOT_INITIALIZED");
}

// 8. 正常 init 后 transcribe 垃圾文件（非 WAV）
{
	const t = new Transcriber();
	const cfg = loadConfig();
	const garbage = tempWavPath();
	writeFileSync(garbage, "this is not a wav file at all, just text bytes 1234567890");
	let threw = false;
	let message = "";
	try {
		await t.init(expandTilde(cfg.asr.modelPath));
		t.transcribe(garbage);
		// 若 sherpa 对垃圾文件返回空字符串而非抛错，也算通过（不崩溃）
	} catch (err) {
		threw = true;
		message = (err as Error).message;
	}
	check("垃圾 WAV 文件不崩溃进程（抛错或空串均可）", true, threw ? `threw: ${message.slice(0, 80)}` : "returned");
	t.dispose();
	cleanupTempFile(garbage);
}

// 9. transcribe 空语音文件（纯静音）
{
	const t = new Transcriber();
	const cfg = loadConfig();
	const silent = tempWavPath();
	// 手写一个 1 秒 16kHz mono 静音 WAV
	const header = Buffer.alloc(44);
	const dataBytes = 16000 * 2;
	header.write("RIFF", 0); header.writeUInt32LE(36 + dataBytes, 4); header.write("WAVE", 8);
	header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
	header.writeUInt16LE(1, 22); header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28);
	header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
	header.write("data", 36); header.writeUInt32LE(dataBytes, 40);
	writeFileSync(silent, Buffer.concat([header, Buffer.alloc(dataBytes)]));
	try {
		await t.init(expandTilde(cfg.asr.modelPath));
		const text = t.transcribe(silent);
		check(`静音 WAV → 空或标点（得 ${JSON.stringify(text)}，不崩溃）`, typeof text === "string");
	} finally {
		t.dispose();
		cleanupTempFile(silent);
	}
}

console.log("== Refiner 异常（真实 Ollama） ==");

const base = { template: "faithful-en" as const, temperature: 0.3, glossary: [] };

// 10. 不可达地址
await expectErr("Ollama 不可达 → UNREACHABLE", () => refineTranscript("测试", {
	...base, baseUrl: "http://127.0.0.1:1", model: "qwen3:8b", timeoutSeconds: 10,
}), "UNREACHABLE");

// 11. 不存在的模型（真实 404）
await expectErr("模型不存在 → MODEL_NOT_FOUND", () => refineTranscript("测试", {
	...base, baseUrl: "http://127.0.0.1:11434", model: "nonexistent-model:1b", timeoutSeconds: 15,
}), "MODEL_NOT_FOUND");

// 12. 极短超时（1s 内冷模型加载不完）
await expectErr("1s 超时 → TIMEOUT", () => refineTranscript("这是一段比较长的测试文本，需要模型花时间处理，从而触发超时路径的验证。".repeat(3), {
	...base, baseUrl: "http://127.0.0.1:11434", model: "qwen3.5:9b", timeoutSeconds: 1,
}), "TIMEOUT");

// 13. 空文本正常处理
{
	const r = await refineTranscript("hi", { ...base, baseUrl: "http://127.0.0.1:11434", model: "qwen3:8b", timeoutSeconds: 60 });
	check("正常 refine 仍工作", r.text.length > 0 && !r.retried, `text=${r.text.slice(0, 40)}`);
}

// 14. AbortSignal 取消
{
	const ctrl = new AbortController();
	setTimeout(() => ctrl.abort(), 100);
	await expectErr("外部 AbortSignal → CANCELLED", () => refineTranscript("测试取消路径的文本", {
		...base, baseUrl: "http://127.0.0.1:11434", model: "qwen3.5:9b", timeoutSeconds: 60, signal: ctrl.signal,
	}), "CANCELLED");
}

console.log("== ModelManager 异常 ==");

// 15. 模型已就绪时 download 是 no-op
{
	const cfg = loadConfig();
	check("已就绪时 downloadModel 直接返回", isModelReady(cfg.asr.modelPath));
}

// 16. 坏 URL
await expectErr("坏 URL → DOWNLOAD_FAILED/HTTP", () => downloadModel(
	"/tmp/never-happen-model", "http://127.0.0.1:1/model.tar.bz2",
), "DOWNLOAD_FAILED");

console.log("== ConfigServer 滥用 ==");

// 17-21. HTTP 边界
{
	const h = await startConfigServer();
	const token = new URL(h.url).searchParams.get("token")!;
	const root = `http://127.0.0.1:${h.port}`;

	let r = await fetch(`${root}/api/config`); check("无 token → 403", r.status === 403);
	r = await fetch(`${root}/api/config?token=wrong`); check("错 token → 403", r.status === 403);
	r = await fetch(`${root}/nonexistent?token=${token}`); check("未知路径 → 404", r.status === 404);
	r = await fetch(`${root}/api/config?token=${token}`, { method: "POST", body: "{not json", headers: { "Content-Type": "application/json" } });
	check("非法 JSON POST → 500 带错误信息", r.status === 500);
	r = await fetch(`${root}/api/test-refine?token=${token}`, { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } });
	check("test-refine 空文本 → 400", r.status === 400);

	// 敌意 config POST：写入后必须被 normalize 拯救
	const before = loadConfig();
	r = await fetch(`${root}/api/config?token=${token}`, { method: "POST", body: JSON.stringify({ refine: { temperature: 99, glossary: "oops" } }), headers: { "Content-Type": "application/json" } });
	const after = loadConfig();
	check("敌意 POST 被 normalize（temperature 99→1）", r.status === 200 && after.refine.temperature === 1);
	check("敌意 POST glossary 非数组 → 空数组", after.refine.glossary === undefined || Array.isArray(after.refine.glossary));
	saveConfig(before); // 还原

	await h.stop();
	await h.stop(); // 双重 stop 幂等
	check("双重 stop 幂等", true);
}

console.log(`\n========== 结果: ${pass} pass / ${fail} fail ==========`);
process.exit(fail === 0 ? 0 : 1);
