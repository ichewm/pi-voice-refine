import { describe, expect, it } from "vitest";
import { parseAudioDevices, pickDeviceIndex } from "../src/recorder.ts";

const LIST_OUTPUT = `[AVFoundation indev @ 0x1] AVFoundation video devices:
[AVFoundation indev @ 0x1] [0] USB Camera
[AVFoundation indev @ 0x1] AVFoundation audio devices:
[AVFoundation indev @ 0x1] [0] MorphVOX Audio
[AVFoundation indev @ 0x1] [1] Unknown USB Audio Device
[AVFoundation indev @ 0x1] [2] VB-Cable
[AVFoundation indev @ 0x1] [3] USB Headset
[in#0 @ 0x1] Error opening input: Input/output error`;

describe("parseAudioDevices", () => {
	it("parses only the audio section", () => {
		const devices = parseAudioDevices(LIST_OUTPUT);
		expect(devices.map((d) => d.name)).toEqual([
			"MorphVOX Audio",
			"Unknown USB Audio Device",
			"VB-Cable",
			"USB Headset",
		]);
	});
	it("empty output → no devices", () => {
		expect(parseAudioDevices("")).toEqual([]);
	});
});

describe("pickDeviceIndex · index-drift protection", () => {
	const devices = parseAudioDevices(LIST_OUTPUT);

	it("explicit :N always wins", () => {
		expect(pickDeviceIndex(devices, ":2", "")).toBe(2);
	});
	it("deviceName locks onto the right index even after drift", () => {
		expect(pickDeviceIndex(devices, "", "USB Headset")).toBe(3);
	});
	it("deviceName does substring matching", () => {
		expect(pickDeviceIndex(devices, "", "headset")).toBe(3);
	});
	it("no name → first NON-VIRTUAL device (skips MorphVOX)", () => {
		expect(pickDeviceIndex(devices, "", "")).toBe(1);
	});
	it("unknown name → first non-virtual fallback", () => {
		expect(pickDeviceIndex(devices, "", "不存在的设备")).toBe(1);
	});
	it("all virtual → index 0 fallback", () => {
		expect(pickDeviceIndex([{ index: 0, name: "VB-Cable" }], "", "")).toBe(0);
	});
});
