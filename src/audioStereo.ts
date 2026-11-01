// SPDX-License-Identifier: Apache-2.0
//
// Copyright (c) 2026 minhquanghp86
// Licensed under the Apache License, Version 2.0 (see LICENSE).

// (06/12/2026) MONO -> STEREO cho nhanh XUONG LOA MAN (P4): L = R (lap lai tung mau s16le).
//
// BANG CHUNG DO DUOC tren thiet bi that:
//   - server gui PCM MONO 16 kHz (640 B = 20 ms) xuong P4;
//   - log P4: `Mixer Source Speaker ... num_channels: 2`, "loa tu choi 201920-292800 B / 30 s",
//     "roi o hang doi 53-98 goi" => ring buffer cua loa LUON DAY va bi VUT BOT => nghe dut quang.
// Gia thuyet: mixer cua firmware khai STEREO (2 kenh) nhung nhan MONO => 640 B chi tuong duong 10 ms stereo
// (320 mau x 4 byte), tuc la "tieu thu" nhanh gap doi "do vao" => tran => vut. Mot goi phai dai 1280 B
// (320 khung mau x 2 kenh x 2 byte) moi dung 20 ms stereo.
//
// Module THUAN (khong import gi cua server) nen test duoc bang vitest: src/audioStereo.test.ts.
//   - `monoToStereo()`: moi mau s16le lap 2 lan (L = R), do dai x2 (640 -> 1280); KHONG doi do dai THOI GIAN
//     (320 mau mono 20 ms -> 320 khung mau stereo 20 ms), khong nhan he so, khong lam tron -> khong meo tieng;
//   - `stereoToMono()`: lay kenh TRAI (de kiem tra L = R va de so sanh byte voi dau vao mono);
//   - CHI ap cho nhanh xuong MAN (`sendToSpeaker()` trong src/callBridge.ts, SAU AGC, TRUOC bo dem nhip);
//     web <-> web (dien thoai <-> dien thoai dang tot) giu MONO nhu cu;
//   - bat/tat bang env `CCR_CALL_STEREO` (mac dinh '1' = BAT, '0'/'off'/'false'/'no' = TAT de A/B gui mono nhu cu).

/** 20 ms/khung (khong doi: stereo chi doi so KENH, khong doi nhip). */
export const FRAME_MS = 20;
export const SAMPLE_RATE = 16000;
/** s16le: 2 byte/mau/kenh. */
export const SAMPLE_BYTES = 2;
/** 20 ms MONO s16le 16 kHz = 320 mau = 640 byte (goi hien tai cua trang goi va cua bo dem nhip). */
export const MONO_FRAME_BYTES = 640;
/** 20 ms STEREO s16le 16 kHz = 320 khung mau x 2 kenh x 2 byte = 1280 byte. */
export const STEREO_FRAME_BYTES = MONO_FRAME_BYTES * 2;

/**
 * MONO s16le -> STEREO s16le (L = R). Do dai CHINH XAC x2 (640 -> 1280), moi mau duoc LAP LAI nguyen gia tri
 * (ke ca -32768 va cac gia tri am: `readInt16LE`/`writeInt16LE` giu nguyen bit, khong nhan he so).
 * Byte le cuoi cung (goi hong / khong chia het 2) duoc chep vao CA HAI kenh de do dai van dung x2.
 */
export function monoToStereo(pcm: Buffer): Buffer {
  const n = Math.floor(pcm.length / 2);                 // so mau mono
  const out = Buffer.allocUnsafe(pcm.length * 2);
  for (let i = 0; i < n; i++) {
    const v = pcm.readInt16LE(i * 2);
    out.writeInt16LE(v, i * 4);                         // kenh TRAI
    out.writeInt16LE(v, i * 4 + 2);                     // kenh PHAI = TRAI
  }
  if (pcm.length & 1) {                                 // goi le 1 byte: khong bo mat byte cuoi
    const b = pcm[pcm.length - 1];
    out[out.length - 2] = b;
    out[out.length - 1] = b;
  }
  return out;
}

/**
 * STEREO s16le -> MONO s16le: lay kenh TRAI. Dung de KIEM TRA (L = R) va de so sanh byte voi dau vao mono khi
 * AGC/EQ da tat — khong dung tren duong that (duong xuong man di mot chieu mono -> stereo).
 */
export function stereoToMono(pcm: Buffer): Buffer {
  const frames = Math.floor(pcm.length / 4);            // so khung mau stereo
  const out = Buffer.allocUnsafe(frames * 2);
  for (let i = 0; i < frames; i++) out.writeInt16LE(pcm.readInt16LE(i * 4), i * 2);
  return out;
}

/** Doc env MOT lan luc khoi dong: mac dinh BAT, chi '0' (hoac off/false/no) la TAT. */
export function readStereoEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.CCR_CALL_STEREO ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'off' || v === 'false' || v === 'no');
}

export const STEREO_ENABLED: boolean = readStereoEnabled();

/** So byte cua MOT khung 20 ms tren duong xuong loa man: 1280 (stereo) hoac 640 (mono, A/B). */
export function speakerFrameBytes(stereo: boolean): number {
  return stereo ? STEREO_FRAME_BYTES : MONO_FRAME_BYTES;
}

/** So byte/khung 20 ms ma bo dem nhip (src/audioPacer.ts) PHAI dung cho man: 1280 khi bat stereo, 640 khi tat. */
export const SPEAKER_FRAME_BYTES: number = speakerFrameBytes(STEREO_ENABLED);

/** Dong log khoi dong (cung dinh dang voi `[audio] agc=...` / `[audio] pace=...`). */
export const STEREO_LOG = `[audio] stereo=${STEREO_ENABLED ? 'on' : 'off'} frame=${SPEAKER_FRAME_BYTES}B/${FRAME_MS}ms`;
if (!process.env.VITEST) console.log(STEREO_LOG);
