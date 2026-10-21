/**
 * One-time SenseVoice model download + extraction + verification.
 *
 * The archive is a .tar.bz2 from k2-fsa/sherpa-onnx GitHub Releases.
 * Extraction uses the system `tar` (bsdtar/gnu-tar handle .tar.bz2 on
 * macOS, Linux, and Windows 10+).
 */

import { spawn } from "node:child_process";
import {
	createWriteStream,
	existsSync,
	mkdirSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
} from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { expandTilde } from "./config.ts";

export interface DownloadProgress {
	/** Bytes downloaded so far. */
	received: number;
	/** Total bytes if the server sent content-length. */
	total: number | null;
}

export class ModelManagerError extends Error {
	readonly code: string;
	constructor(
		message: string,
		code: string,
	) {
		super(message);
		this.code = code;
		this.name = "ModelManagerError";
	}
}

/** Locate model.int8.onnx + tokens.txt within 2 levels under dir. */
export function findModelDir(dir: string): { modelFile: string; tokensFile: string; dir: string } | null {
	const model = "model.int8.onnx";
	const tokens = "tokens.txt";
	if (existsSync(join(dir, model)) && existsSync(join(dir, tokens))) {
		return { modelFile: join(dir, model), tokensFile: join(dir, tokens), dir };
	}
	try {
		// One nested level (archive often extracts to <name>-<date>/)
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const sub = join(dir, entry.name);
			if (existsSync(join(sub, model)) && existsSync(join(sub, tokens))) {
				return { modelFile: join(sub, model), tokensFile: join(sub, tokens), dir: sub };
			}
		}
	} catch {
		/* dir may not exist */
	}
	return null;
}

/** True when the model appears downloaded and complete. */
export function isModelReady(modelPath: string): boolean {
	const dir = expandTilde(modelPath);
	const found = findModelDir(dir);
	if (!found) return false;
	// model.int8.onnx is ~230MB; treat <100MB as a corrupt/partial download.
	try {
		return statSync(found.modelFile).size > 100 * 1024 * 1024;
	} catch {
		return false;
	}
}

async function runTar(archive: string, destDir: string): Promise<void> {
	// bsdtar/gnu-tar both handle .tar.bz2 via -xjf.
	const tarBin = process.platform === "win32" ? "C:\\Windows\\System32\\tar.exe" : "tar";
	await new Promise<void>((resolve, reject) => {
		const child = spawn(tarBin, ["-xjf", archive, "-C", destDir], { stdio: "ignore" });
		child.once("error", (err) =>
			reject(new ModelManagerError(`tar spawn failed: ${err.message}`, "TAR_SPAWN")),
		);
		child.once("exit", (code) => {
			if (code === 0) resolve();
			else reject(new ModelManagerError(`tar exited with code ${code}`, "TAR_EXIT"));
		});
	});
}

class CountingTransform extends Transform {
	received = 0;
	private readonly onDelta: (received: number) => void;
	constructor(onDelta: (received: number) => void) {
		super({ highWaterMark: 1 << 20 });
		this.onDelta = onDelta;
	}
	override _transform(
		chunk: Buffer,
		_enc: BufferEncoding,
		callback: (err?: Error | null, data?: Buffer) => void,
	): void {
		this.received += chunk.length;
		this.onDelta(this.received);
		callback(null, chunk);
	}
}

/** Download and install the SenseVoice model. Resolves with the model dir. */
export async function downloadModel(
	modelPath: string,
	modelUrl: string,
	onProgress?: (p: DownloadProgress) => void,
	signal?: AbortSignal,
): Promise<string> {
	const destDir = expandTilde(modelPath);
	mkdirSync(destDir, { recursive: true });
	if (isModelReady(modelPath)) return findModelDir(destDir)!.dir;

	const archivePath = join(destDir, "model.tar.bz2");

	// Stream download with progress.
	let response: Response;
	try {
		response = await fetch(modelUrl, { redirect: "follow", signal });
	} catch (err) {
		throw new ModelManagerError(`Model download failed: ${(err as Error).message}`, "DOWNLOAD_FAILED");
	}
	if (!response.ok || !response.body) {
		throw new ModelManagerError(`Model download HTTP ${response.status}`, "DOWNLOAD_HTTP");
	}
	const totalHeader = response.headers.get("content-length");
	const total = totalHeader ? Number(totalHeader) : null;
	const counter = new CountingTransform((received) => onProgress?.({ received, total }));
	await pipeline(Readable.fromWeb(response.body as never), counter, createWriteStream(archivePath));

	if (statSync(archivePath).size < 1024 * 1024) {
		throw new ModelManagerError("Downloaded archive is suspiciously small (<1MB)", "DOWNLOAD_CORRUPT");
	}

	// Extract into a temp subdir then locate the model.
	const extractDir = join(destDir, ".extract");
	mkdirSync(extractDir, { recursive: true });
	// Delete the archive regardless of outcome — keeping a ~230MB .done file
	// is pure disk waste; a failed install simply re-downloads.
	try {
		await runTar(archivePath, extractDir);
	} finally {
		try {
			rmSync(archivePath, { force: true });
		} catch {
			/* best effort */
		}
	}

	// Move found model files to destDir root for a stable layout.
	const found = findModelDir(extractDir);
	if (!found) {
		throw new ModelManagerError(
			"Archive extracted but model.int8.onnx + tokens.txt not found inside",
			"ARCHIVE_INVALID",
		);
	}
	renameSync(found.modelFile, join(destDir, "model.int8.onnx"));
	renameSync(found.tokensFile, join(destDir, "tokens.txt"));
	// Clean the extraction tree (best effort).
	try {
		rmSync(extractDir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}

	if (!isModelReady(modelPath)) {
		throw new ModelManagerError("Model install verification failed", "VERIFY_FAILED");
	}
	return destDir;
}
