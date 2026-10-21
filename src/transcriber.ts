/**
 * SenseVoice offline recognizer via the sherpa-onnx Node module.
 *
 * Loads the model once (init), then per WAV: readWave → createStream →
 * acceptWaveform → decode → getResult. All inference is in-process and local.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

export interface TranscriberInitResult {
	modelDir: string;
}

export class TranscriberError extends Error {
	readonly code: string;
	constructor(
		message: string,
		code: string,
	) {
		super(message);
		this.code = code;
		this.name = "TranscriberError";
	}
}

export class Transcriber {
	/* eslint-disable @typescript-eslint/no-explicit-any */
	private sherpa: any = null;
	private recognizer: any = null;
	private modelDir = "";

	async init(modelDir: string, numThreads = 1): Promise<TranscriberInitResult> {
		const modelFile = join(modelDir, "model.int8.onnx");
		const tokensFile = join(modelDir, "tokens.txt");
		if (!existsSync(modelFile) || !existsSync(tokensFile)) {
			throw new TranscriberError(
				`SenseVoice model not found under ${modelDir} (need model.int8.onnx + tokens.txt). Run /vrefine model download`,
				"MODEL_MISSING",
			);
		}
		// Release any previous instance before loading a new one.
		this.dispose();

		const sherpa = await import("sherpa-onnx");
		const createOfflineRecognizer = sherpa.createOfflineRecognizer ?? sherpa.default?.createOfflineRecognizer;
		if (typeof createOfflineRecognizer !== "function") {
			throw new TranscriberError(
				"sherpa-onnx loaded but createOfflineRecognizer is unavailable",
				"NO_RECOGNIZER",
			);
		}
		const recognizer = createOfflineRecognizer({
			modelConfig: {
				senseVoice: {
					model: modelFile,
					language: "", // auto (zh/en/ja/ko/yue mixed)
					useInverseTextNormalization: 1,
				},
				tokens: tokensFile,
				// sherpa-onnx Node/WASM build does not support multi-threading; keep 1.
				numThreads,
				provider: "cpu",
				debug: 0,
			},
			decodingMethod: "greedy_search",
			maxActivePaths: 4,
		});
		this.sherpa = sherpa;
		this.recognizer = recognizer;
		this.modelDir = modelDir;
		return { modelDir };
	}

	get ready(): boolean {
		return this.recognizer !== null;
	}

	get loadedModelDir(): string {
		return this.modelDir;
	}

	/** Transcribe a 16kHz mono WAV file. Returns the raw transcript text. */
	transcribe(wavPath: string): string {
		if (!this.sherpa || !this.recognizer) {
			throw new TranscriberError("Transcriber not initialized", "NOT_INITIALIZED");
		}
		const wave = this.sherpa.readWave(wavPath);
		const stream = this.recognizer.createStream();
		try {
			stream.acceptWaveform(wave.sampleRate, wave.samples);
			this.recognizer.decode(stream);
			const result = this.recognizer.getResult(stream); // { text: string }
			const text = typeof result?.text === "string" ? result.text : "";
			return text.trim();
		} finally {
			try {
				stream.free();
			} catch {
				/* ignore */
			}
		}
	}

	dispose(): void {
		if (this.recognizer) {
			try {
				this.recognizer.free?.();
			} catch {
				/* ignore */
			}
		}
		this.recognizer = null;
		this.sherpa = null;
		this.modelDir = "";
	}
	/* eslint-enable @typescript-eslint/no-explicit-any */
}
