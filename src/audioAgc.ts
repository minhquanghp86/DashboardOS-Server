// SPDX-License-Identifier: Apache-2.0
//
// Copyright (c) 2026 minhquanghp86
// Licensed under the Apache License, Version 2.0 (see LICENSE).

// (31/10/2026) AGC + LIMITER cho duong tieng DIEN THOAI -> LOA MAN (P4).
//
// Trieu chung: noi vao dien thoai thi loa P4 gan nhu KHONG nghe, nhung thoi nhe vao mic lai RAT TO. Nguyen nhan:
// PCM s16le tu trang goi duoc gui THANG xuong loa man (`src/calls.ts:690` -> `sendToDevice`), khong co AGC /
// limiter / make-up gain nao; cong them (a) trang goi decimate 3:1 khong loc chong alias (public/call-web.html,
// da sua cung dot) va (b) DAC ES8311 tren P4 co duong cong phi tuyen — tieng nho bi chim, tieng lon bi vo.
//
// Module nay lam dung mot viec: dua muc am luong cua tung khung 20 ms ve muc nham `AGC_TARGET_DBFS` roi chan dinh o
// `LIMIT_DBFS`.
//   - KHONG them do tre: xu ly ngay tung khung 20 ms (320 mau / 640 byte) khi no den, khong giu dem.
//   - KHONG doi kich thuoc goi: vao bao nhieu byte ra bay nhieu byte (duoi le < 640 byte giu nguyen).
//   - Chi ap cho nhanh xuong MAN (`peer.kind === 'panel'`); web <-> web (dien thoai <-> dien thoai dang tot)
//     khong di qua day.
//   - Bat/tat bang env `CCR_CALL_AGC` (mac dinh '1' = bat, '0' = tat de A/B).
// (13/12/2026) Khi bat HALF-DUPLEX (`src/audioDuplex.ts`, env `CCR_CALL_HALFDUPLEX`, mac dinh BAT) thi vong lap am
// hoc da bi chan o phia server, nen cho phep muc nham TO hon (-14 dBFS) va gain toi da +24 dB: "tieng nho, khong
// nhay" la do thieu do nhay THAT, khong con phai hy sinh do nhay de tranh ru. Tat half-duplex (A/B) -> giu nguyen
// bo so cu (-16 dBFS / +12 dB) de so sanh cong bang tren cung mot cuoc goi.
import { HALFDUPLEX_ENABLED } from './audioDuplex.js';

export const FRAME_MS = 20;
export const SAMPLE_RATE = 16000;
export const FRAME_SAMPLES = 320;
export const FRAME_BYTES = FRAME_SAMPLES * 2;         // 640

/** Muc am luong khung nham toi (dBFS). */
// (05/12/2026) -18 -> -26 dBFS: do that tren P4 cho thay muc nham -18 dBFS lam loa nho cua may bi nen manh
// (AGC day gain len +15..+24 dB roi limiter phai lam viec lien tuc) — tieng "to nhung rop", de kich vong lap am hoc
// (loa P4 -> mic dien thoai -> "ru rit"). -26 dBFS = con du headroom cho loa + 14 dB dinh cua tieng noi.
// (13/12/2026) HALF-DUPLEX BAT -> -14 dBFS (muc nham cuoi cung la -16, su that la -26 chi de tranh ru; da chan duoc
// vong lap o `src/audioDuplex.ts` nen tra lai do nhay). TAT half-duplex -> -16 dBFS nhu truoc (A/B).
export const AGC_TARGET_DBFS = HALFDUPLEX_ENABLED ? -14 : -16;
/** Gain len nhanh (5 ms) — tieng nho thanh ro ngay. */
export const AGC_ATTACK_MS = 5;
/** Gain xuong cham (200 ms) — khong "tho" am luong theo tung tu. */
export const AGC_RELEASE_MS = 200;
export const AGC_MIN_GAIN_DB = -6;
// (05/12/2026) +24 -> +12 dB: tren -26 dBFS thi +12 dB da dua khung -38 dBFS len dung muc nham; khuech dai qua
// +12 dB chi keo nhieu nen phong len (tieng "re re" giua cac tu) — dung voi chieu "giam AGC / tat NS" cua bao cao.
// (13/12/2026) HALF-DUPLEX BAT -> +24 dB: muc nham -14 dBFS can +24 dB de keo tieng dien thoai o -38 dBFS len dung
// muc; limiter mem -4 dBFS van chan dinh. TAT half-duplex -> +12 dB nhu truoc (A/B).
export const AGC_MAX_GAIN_DB = HALFDUPLEX_ENABLED ? 24 : 12;
/** Duoi muc nay la im lang: KHONG khuech dai (tranh khuech dai nhieu nen phong). */
export const AGC_SILENCE_DBFS = -60;
/** Nguong limiter (dBFS): -4 dBFS = 32767 * 0,6310. */
// (05/12/2026) -1 -> -4 dBFS: DAC ES8311 cua P4 da phi tuyen gan dinh (tai -1 dBFS tieng bi "vo"); -4 dBFS van
// to hon 3 dB so voi muc nham -26 dBFS RMS nhung con 4 dB du phong cho dinh cua tieng noi, va tranh kich vong lap.
export const LIMIT_DBFS = -4;
export const LIMIT_PEAK = Math.round(32767 * 10 ** (LIMIT_DBFS / 20));
/** Bat dau vao mien nen mem: duoi nguong nay giu NGUYEN mau (chi dinh moi qua limiter). */
export const LIMIT_KNEE = Math.round(LIMIT_PEAK * 0.8);

/** Trang thai gain cua mot duong tieng (mot man). */
export interface AgcState {
  /** Gain hien tai (dB), da lam muot attack/release. */
  gainDb: number;
}

export interface AgcFrameStats {
  /** RMS khung TRUOC khi xu ly (dBFS, -120 = im lang tuyet doi). */
  rmsDb: number;
  /** Gain thuc su ap cho khung nay (dB) — sau lam muot attack/release. */
  gainDb: number;
  /** Dinh tuyet doi cua khung SAU xu ly (mau 16-bit). */
  peak: number;
  /** So mau phai qua limiter (mem). */
  limited: number;
  /** true = khung im lang (< -60 dBFS) -> khong ap gain. */
  silent: boolean;
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
/**
 * He so lam muot exponential cho mot khung dai `durMs`: 1 - e^(-durMs/tau).
 * Tinh theo DO DAI THAT cua khung nen goi 20 ms (640 byte) cho dung attack 5 ms / release 200 ms, va mot goi
 * ngan hon (vd 10 ms = 320 byte cua client khac) cung giu dung hang so thoi gian, khong bi nhanh gap doi.
 */
const coef = (tauMs: number, durMs: number): number => 1 - Math.exp(-durMs / tauMs);

/**
 * Nen mem (soft clip) C1-lien tuc: duoi `LIMIT_KNEE` giu nguyen mau, tren do nen bang tanh de dinh tien dan toi
 * `LIMIT_PEAK` (khong bao gio vuot) — khong tao "song vuong"/rach tieng nhu cat cung.
 */
export function softClip(v: number): number {
  const a = Math.abs(v);
  if (a <= LIMIT_KNEE) return v;
  const room = LIMIT_PEAK - LIMIT_KNEE;
  const y = LIMIT_KNEE + room * Math.tanh((a - LIMIT_KNEE) / room);
  return v < 0 ? -y : y;
}

/** Doc env MOT lan luc khoi dong: mac dinh BAT, chi '0' (hoac off/false/no) la TAT. */
function readEnabled(): boolean {
  const v = (process.env.CCR_CALL_AGC ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'off' || v === 'false' || v === 'no');
}

export const AGC_ENABLED: boolean = readEnabled();
// Nhat ky khoi dong: 'CCR_CALL_AGC=0' -> "[audio] agc=off target=-14dBFS".
if (!process.env.VITEST) console.log(`[audio] agc=${AGC_ENABLED ? 'on' : 'off'} target=${AGC_TARGET_DBFS}dBFS maxgain=+${AGC_MAX_GAIN_DB}dB`);

export function newAgcState(gainDb = 0): AgcState { return { gainDb } }

export function rmsDbOf(pcm: Buffer): number {
  const n = Math.floor(pcm.length / 2);
  if (!n) return -120;
  let s = 0;
  for (let i = 0; i < n; i++) { const v = pcm.readInt16LE(i * 2) / 32768; s += v * v; }
  return 20 * Math.log10(Math.max(Math.sqrt(s / n), 1e-9));
}

export function peakOf(pcm: Buffer): number {
  const n = Math.floor(pcm.length / 2);
  let p = 0;
  for (let i = 0; i < n; i++) { const a = Math.abs(pcm.readInt16LE(i * 2)); if (a > p) p = a; }
  return p;
}

/**
 * Xu ly MOT khung 20 ms (640 byte = 320 mau) TAI CHO, cap nhat `state`.
 * Khong cap phat buffer, khong doi do dai, khong doi kich thuoc goi.
 * `enabled === false` (A/B): do dung so lieu chan doan nhung KHONG sua mau nao.
 */
export function processFrame(frame: Buffer, state: AgcState, enabled: boolean = AGC_ENABLED): AgcFrameStats {
  const n = Math.floor(frame.length / 2);
  if (!n) return { rmsDb: -120, gainDb: state.gainDb, peak: 0, limited: 0, silent: true };
  const rmsDb = rmsDbOf(frame);
  if (!enabled) {
    const peak = peakOf(frame);
    return { rmsDb, gainDb: 0, peak, limited: 0, silent: rmsDb < AGC_SILENCE_DBFS };
  }
  if (rmsDb < AGC_SILENCE_DBFS) {
    // Im lang: giu nguyen mau va giu nguyen gain (khong khuech dai nhieu nen phong).
    return { rmsDb, gainDb: state.gainDb, peak: peakOf(frame), limited: 0, silent: true };
  }
  const target = clamp(AGC_TARGET_DBFS - rmsDb, AGC_MIN_GAIN_DB, AGC_MAX_GAIN_DB);
  const durMs = (n / SAMPLE_RATE) * 1000;                             // 640 byte = 20 ms
  const k = target > state.gainDb ? coef(AGC_ATTACK_MS, durMs) : coef(AGC_RELEASE_MS, durMs);   // len nhanh, xuong cham
  state.gainDb = clamp(state.gainDb + k * (target - state.gainDb), AGC_MIN_GAIN_DB, AGC_MAX_GAIN_DB);
  const g = 10 ** (state.gainDb / 20);
  let peak = 0, limited = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 2;
    let v = frame.readInt16LE(o) * g;
    if (v > LIMIT_KNEE || v < -LIMIT_KNEE) { v = softClip(v); limited++; }
    const s = Math.max(-32768, Math.min(32767, Math.round(v)));
    frame.writeInt16LE(s, o);
    const a = Math.abs(s);
    if (a > peak) peak = a;
  }
  return { rmsDb, gainDb: state.gainDb, peak, limited, silent: false };
}

/**
 * Xu ly ca mot buffer PCM s16le mono 16 kHz: moi khung 640 byte (20 ms) qua AGC/limiter, duoi le giu nguyen.
 * LUON tra buffer MOI cung DO DAI (byte-for-byte) — goi khong bi doi kich thuoc, khong bi sua tai cho.
 * Goi ngan hon mot khung (vd 320 byte = 10 ms cua client khac) van duoc xu ly nhu MOT khung, nho vay AGC khong bi
 * "ho" tren client dung goi khac 20 ms.
 * `enabled === false` (CCR_CALL_AGC=0) -> passthrough y nguyen byte (A/B).
 */
export function processPcm(pcm: Buffer, state: AgcState, enabled: boolean = AGC_ENABLED): Buffer {
  const out = Buffer.from(pcm);                      // copy: buffer cua WS co the dang duoc dung o noi khac
  if (!enabled || out.length < 2) return out;
  if (out.length <= FRAME_BYTES) { processFrame(out, state); return out; }
  for (let o = 0; o + FRAME_BYTES <= out.length; o += FRAME_BYTES) processFrame(out.subarray(o, o + FRAME_BYTES), state);
  return out;
}
