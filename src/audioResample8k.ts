// SPDX-License-Identifier: Apache-2.0
//
// Copyright (c) 2026 minhquanghp86
// Licensed under the Apache License, Version 2.0 (see LICENSE).

// (07/12/2026) HA 16 kHz -> 8 kHz cho nhanh XUONG LOA MAN (P4) — phep do gia thuyet "I2S cua loa chay 8 kHz".
//
// BANG CHUNG DO TREN THIET BI THAT: P4 khai `sample_rate: 16000`, mixer 1 kenh; server gui 16 kHz mono
// 640 B/20 ms (32 KB/s) va `dropped=0` (khong he mat khung nao tren duong WS). Nhung log P4 ghi
// "loa tu choi 485120 B / 30 s" = ~16 KB/s — tuc la loa CHI TIEU THU dung MOT NUA so byte duoc gui:
// 16000 byte/s = 8000 mau s16le/s = **8 kHz mono**. Gia thuyet khop voi con so do: I2S cua loa chay 8 kHz, nen
// mot nua so mau bi ring buffer cua loa tu choi (log `aud_bytes_drop_`) -> mat mau -> nghe nhanh/dut quang.
//
// Module nay lam dung mot viec: HA TAN SO LAY MAU 16 kHz -> 8 kHz bang cach LOC THONG THAP roi BO MAU (decimate x2),
// de server gui dung 320 B/20 ms (16 kHz -> 8 kHz mono) va do lai xem "loa tu choi" co het khong.
//
//     PCM 16 kHz s16le mono (640 B/20 ms)
//        -> [loc thong thap 3,4 kHz: Butterworth bac 6 = 3 tang biquad, trang thai rieng tung man]
//        -> lay moi mau thu 2 (i = 0, 2, 4, ...)
//        -> PCM 8 kHz s16le mono (320 B/20 ms)
//
// VI SAO PHAI LOC TRUOC KHI BO MAU (khong duoc chi "lay moi mau thu 2"):
//   Tieng 6 kHz (trong dai 4-8 kHz) sau khi bo mau se ROI XUONG 2 kHz: 8000 - 6000 = 2000 Hz. Do la alias — mot
//   tieng KHONG CO trong tin hieu goc, khong loc nao go duoc sau khi da bo mau. Vi vay phai cat truoc Nyquist moi
//   (4 kHz) bang bo loc thong thap. Do dac cua bo loc dang dung (Butterworth bac 6, fc = 3,4 kHz, fs = 16 kHz):
//       0,5k: -0,0 dB   1k: -0,0 dB   1,5k: -0,0 dB   2k: -0,0 dB   2,5k: -0,0 dB
//       3k:   -0,6 dB   3,4k: -3,0 dB (diem cat)      4k:   -12,6 dB
//       5k:   -33,4 dB  6k:   -58,3 dB                 7k:   -96,6 dB
//   => dai tieng noi (300-3400 Hz) di qua GAN NHU NGUYEN VEN (suy hao < 0,1 dB duoi 2,5 kHz), con 6 kHz bi dap
//   -58 dB nen alias 2 kHz con ~0,1% — khong nghe thay.
//
// TRANG THAI LOC GIU GIUA CAC KHUNG (`Downsample2State`): mot bo loc IIR co "nho" (z1/z2), cat khung 20 ms thanh
// tung lan loc rieng roi tra lai trang thai 0 se lam MOI BIEN KHUNG thanh mot cu giat (nghe "re"/"lach tach" 50
// lan/giay). Vi vay `sendToSpeaker()` giu MOT trang thai cho MOI man (`resamplers` trong src/callBridge.ts) va
// `downsample2(pcm, state)` cho ra BYTE Y HET nhu khi loc ca mot buffer dai (xem test "state lien tuc").
//
// Module THUAN (khong import gi cua server), test duoc bang vitest: src/audioResample8k.test.ts.
//
// CACH DOC KET QUA CUA PHEP DO (bat buoc phai doc dung, neu khong se ket luan nguoc):
//   Phat mot tone 1 kHz (vd. `POST /call/test/play?dev=<man>&file=...` voi tep 1 kHz) trong hai lan:
//     A) `CCR_CALL_RATE8K` khong dat  -> gui 16 kHz (640 B/20 ms mono)  = "loa dang nhan 16 kHz";
//     B) `CCR_CALL_RATE8K=1`          -> gui 8 kHz  (320 B/20 ms mono)  = "loa dang nhan 8 kHz".
//   - Neu loa THAT SU chay I2S 8 kHz: lan B nghe DUNG 1 kHz (cao do khong doi) va log P4 THOI bao "loa tu choi"
//     (khong con `aud_bytes_drop_` / so byte bi tu choi tut ve ~0) -> GIA THUYET DUNG, giu 8 kHz.
//   - Neu loa VAN chay 16 kHz: 320 B/20 ms duoc doc thanh 160 mau/20 ms = 8 kHz, tuc la phat CHAM gap doi
//     -> nghe thanh **500 Hz** (thap hon mot quang tam), va/hoac P4 van bao "loa tu choi" vi gio lai THIEU byte
//     (buffer can 640 B/20 ms ma chi nhan 320 B). -> GIA THUYET SAI: loa chay 16 kHz, van de 16 kHz va tim nguyen
//     nhan khac cho con so 16 KB/s.
//   - 1 kHz -> 2 kHz (cao gap doi) la truong hop khac: khong phai do tan so lay mau ma do firmware doc sai dinh dang.
// Vi vay khi do PHAI dung mot tone DA BIET tan so (1 kHz) va so sanh cao do giua lan A va lan B, dung chi nhin
// `dropped` cua server (server `dropped=0` chi co nghia la WS da gui du byte, khong noi gi ve phia loa).
//
// BAT/TAT: env `CCR_CALL_RATE8K` doc MOT lan luc khoi dong — MAC DINH TAT; `1`/`on`/`true`/`yes` = BAT.
// Khi BAT thi bo dem nhip (src/audioPacer.ts) phai dung `frameBytes = frameBytesFor(8000, soKenh)` = 320 (mono),
// neu khong mot khung 20 ms se bi chia thanh NHIEU goi 640 byte va bo dem ban nhieu goi moi nhip (xem
// src/audioPacer.ts). `SPEAKER_WIRE_FRAME_BYTES` trong src/callBridge.ts tinh dung con so do MOT lan.

/** 20 ms/khung — ha mau chi doi TAN SO LAY MAU, KHONG doi nhip (van MOT goi moi 20 ms). */
export const FRAME_MS = 20;
/** Tan so lay mau dau vao cua duong xuong man (trang goi, tep mau, mic P4 — tat ca deu 16 kHz). */
export const IN_RATE_HZ = 16000;
/** Tan so lay mau dau ra khi bat `CCR_CALL_RATE8K`. */
export const OUT_RATE_HZ = 8000;
/** s16le: 2 byte/mau (mono — `downsample2` nhan va tra ve PCM MONO). */
export const SAMPLE_BYTES = 2;
/** Diem cat thong thap: ~3,4 kHz (duoi Nyquist 4 kHz cua 8 kHz, tren day tieng noi 300-3400 Hz). */
export const CUTOFF_HZ = 3400;
/** MOT khung 20 ms MONO 16 kHz = 320 mau = 640 byte — dau vao cua `downsample2()`. */
export const IN_MONO_FRAME_BYTES = (IN_RATE_HZ / 1000) * FRAME_MS * SAMPLE_BYTES;
/** MOT khung 20 ms MONO 8 kHz = 160 mau = 320 byte — dau ra cua `downsample2()` (`frameBytesFor(8000)`). */
export const OUT_MONO_FRAME_BYTES = (OUT_RATE_HZ / 1000) * FRAME_MS * SAMPLE_BYTES;

/**
 * So byte cua MOT goi 20 ms o tan so `rateHz` (va `channels` kenh) — dung cho bo dem nhip:
 * `frameBytesFor(8000)` = **320** (8 kHz mono), `frameBytesFor(16000)` = 640 (16 kHz mono),
 * `frameBytesFor(8000, 2)` = 640 (8 kHz stereo), `frameBytesFor(16000, 2)` = 1280 (16 kHz stereo).
 */
export function frameBytesFor(rateHz: number, channels: number = 1): number {
  return Math.round((rateHz / 1000) * FRAME_MS * SAMPLE_BYTES * Math.max(1, channels));
}

// ── Bo loc thong thap (Butterworth bac 6 = 3 tang biquad, he so tinh 1 lan luc nap module) ───────────────────────
/** Mot tang biquad chuan hoa theo a0 = 1 (RBJ audio EQ cookbook), dang transposed direct form II. */
interface Biquad { b0: number; b1: number; b2: number; a1: number; a2: number }

/** He so low-pass RBJ cho MOT tang (Q quyet dinh hinh dang; day la cac Q cua Butterworth bac `order`). */
function lowpassSection(fc: number, fs: number, q: number): Biquad {
  const w0 = (2 * Math.PI * fc) / fs;
  const cw = Math.cos(w0), sw = Math.sin(w0);
  const alpha = sw / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: ((1 - cw) / 2) / a0,
    b1: (1 - cw) / a0,
    b2: ((1 - cw) / 2) / a0,
    a1: (-2 * cw) / a0,
    a2: (1 - alpha) / a0,
  };
}

/**
 * Butterworth bac `order` (chan) = `order / 2` tang biquad noi tiep. Q cua tung tang lay tu vi tri cuc cua
 * Butterworth: Q_k = 1 / (2 * cos((2k+1) * pi / (2 * order))). Bac 6 -> Q = 0,5176 / 0,7071 / 1,9319.
 */
function butterworthLowpass(fc: number, fs: number, order: number): Biquad[] {
  const halves = Math.round(order / 2);
  const out: Biquad[] = [];
  for (let k = 0; k < halves; k++) out.push(lowpassSection(fc, fs, 1 / (2 * Math.cos(((2 * k + 1) * Math.PI) / (2 * order)))));
  return out;
}

/** Bac 6: -0,0 dB duoi 2,5 kHz, -3 dB @ 3,4 kHz, -58 dB @ 6 kHz (bang so o dau tep). */
const SECTIONS: readonly Biquad[] = butterworthLowpass(CUTOFF_HZ, IN_RATE_HZ, 6);

/** Trang thai cua bo loc (z1/z2 cua tung tang) — PHAI giu giua cac khung de khong re o bien. */
export interface Downsample2State {
  z: { z1: number; z2: number }[];
}

/** Trang thai loc MOI (tat ca bang 0 = im lang, khong co "cu giat" dau tien). */
export function newDownsample2State(): Downsample2State {
  return { z: SECTIONS.map(() => ({ z1: 0, z2: 0 })) };
}

/** Trang thai dung chung — CHI dung khi that su chi co MOT luong am thanh (test, hoac goi mot lan). */
const SHARED: Downsample2State = newDownsample2State();

/**
 * HA 16 kHz -> 8 kHz: loc thong thap (3 tang biquad, cat ~3,4 kHz) roi lay MOI MAU THU 2 (i = 0, 2, 4, ...).
 *   - vao: PCM s16le MONO 16 kHz (doi dai tuy y, thuong la 640 B = 20 ms);
 *   - ra: PCM s16le MONO 8 kHz, do dai = MOT NUA (640 -> 320 B; so mau le -> bo byte cuoi cho tron mau);
 *   - `st` giu trang thai loc giua cac khung: chia buffer thanh nhieu lan loc cho ra BYTE Y HET nhu loc mot lan
 *     (`downsample2(a.concat(b), st) === Buffer.concat([downsample2(a, st), downsample2(b, st)])`);
 *   - moi mau ra duoc LAM TRON va CHAN trong [-32768, 32767] (biquad co the vot qua dinh mot chut o bien do
 *     -> khong de tran bit thanh tieng "rach");
 *   - khong sua buffer goc; khong cap phat buffer trung gian nao ngoai buffer ra.
 */
export function downsample2(pcm16k: Buffer, st: Downsample2State = SHARED): Buffer {
  const n = Math.floor(pcm16k.length / 2);                 // so mau vao (mono s16le)
  const out = Buffer.allocUnsafe((n >> 1) * 2);            // so mau ra = n/2
  const secs = SECTIONS, z = st.z;
  for (let i = 0; i < n; i++) {
    let x = pcm16k.readInt16LE(i * 2) / 32768;             // chuan hoa ve [-1, 1) — he so biquad tinh theo don vi nay
    for (let k = 0; k < secs.length; k++) {                // 3 tang noi tiep, transposed direct form II
      const c = secs[k], s = z[k];
      const y = c.b0 * x + s.z1;
      s.z1 = c.b1 * x - c.a1 * y + s.z2;
      s.z2 = c.b2 * x - c.a2 * y;
      x = y;
    }
    if ((i & 1) === 0) {                                   // BO MAU: chi giu mau chan (0, 2, 4, ...)
      const v = Math.round(x * 32768);
      out.writeInt16LE(v > 32767 ? 32767 : v < -32768 ? -32768 : v, (i >> 1) * 2);   // mau thu k = mau vao thu 2k
    }
  }
  return out;
}

// ── Bat/tat bang env (A/B tren cung mot thiet bi) ──────────────────────────────────────────────────────────────
/** Doc env `CCR_CALL_RATE8K` MOT lan luc khoi dong: MAC DINH TAT, chi '1'/'on'/'true'/'yes' la BAT. */
export function readRate8kEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.CCR_CALL_RATE8K ?? '').trim().toLowerCase();
  return v === '1' || v === 'on' || v === 'true' || v === 'yes';
}

export const RATE8K_ENABLED: boolean = readRate8kEnabled();

/** Tan so lay mau THAT tren duong xuong loa man: 8000 khi bat `CCR_CALL_RATE8K`, nguoc lai 16000. */
export const SPEAKER_RATE_HZ: number = RATE8K_ENABLED ? OUT_RATE_HZ : IN_RATE_HZ;

/**
 * Dong log khoi dong (cung dinh dang voi `[audio] stereo=...` / `[audio] pace=...`):
 *   - BAT:  `[audio] rate=8k frame=320B/20ms`  (mono) / `[audio] rate=8k frame=640B/20ms` (stereo);
 *   - TAT:  `[audio] rate=16k`.
 * In ra tu src/callBridge.ts (noi biet so KENH that tren duong xuong man), khong in o day de khong lap dong log.
 */
export function rateLogLine(channels: number = 1): string {
  return RATE8K_ENABLED ? `[audio] rate=8k frame=${frameBytesFor(OUT_RATE_HZ, channels)}B/${FRAME_MS}ms` : '[audio] rate=16k';
}

/** Dong log khoi dong cho duong MONO (dang dung khi chay mot minh, va de test). */
export const RATE_LOG: string = rateLogLine(1);
