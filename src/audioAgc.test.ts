// SPDX-License-Identifier: Apache-2.0
//
// Copyright (c) 2026 minhquanghp86
// Licensed under the Apache License, Version 2.0 (see LICENSE).

// (31/10/2026) AGC + LIMITER cho duong tieng DIEN THOAI -> LOA MAN (P4) — kiem tra thuan so hoc, khong can
// thiet bi that:
//   - im lang -> khong doi mau nao (khong khuech dai nhieu nen phong);
//   - khung nho -> gain tang dung huong, dung gioi han [AGC_MIN_GAIN_DB, AGC_MAX_GAIN_DB], dua RMS ve AGC_TARGET_DBFS
//     (moi ky vong deu DOC TU HANG SO cua module: -14 dBFS / +24 dB khi bat half-duplex, -16 / +12 khi tat);
//   - khung lon (0 dBFS) -> limiter mem giu dinh <= LIMIT_DBFS, khong thanh "song vuong"/rach tieng;
//   - attack 5 ms (len nhanh) / release 200 ms (xuong cham);
//   - CCR_CALL_AGC=0 -> passthrough y nguyen byte (A/B);
//   - khung 20 ms: vao 640 byte ra 640 byte (khong doi kich thuoc goi, khong them do tre).
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AGC_ENABLED, AGC_MAX_GAIN_DB, AGC_MIN_GAIN_DB, AGC_TARGET_DBFS, AGC_SILENCE_DBFS,
  FRAME_BYTES, LIMIT_DBFS, LIMIT_KNEE, LIMIT_PEAK, newAgcState, peakOf, processFrame, processPcm, rmsDbOf, softClip,
} from './audioAgc.js';

/** Mot khung 20 ms (320 mau) hinh sin `hz`, dinh = `dbfs`. */
function sineFrame(dbfs: number, hz = 1000, offset = 0): Buffer {
  const amp = 32767 * 10 ** (dbfs / 20);
  const b = Buffer.alloc(FRAME_BYTES);
  for (let i = 0; i < FRAME_BYTES / 2; i++) b.writeInt16LE(Math.round(Math.sin(2 * Math.PI * hz * (i + offset) / 16000) * amp), i * 2);
  return b;
}

/** N khung lien tiep cua cung mot tin hieu (offset tang dan cho lien mach). */
function sinePcm(n: number, dbfs: number, hz = 1000): Buffer {
  return Buffer.concat(Array.from({ length: n }, (_, k) => sineFrame(dbfs, hz, k * (FRAME_BYTES / 2))));
}

const dbfsOf = (peak: number, full = 32767) => 20 * Math.log10(peak / full);
/** He so dinh (peak / RMS): song vuong ~1,0; hinh sin ~1,41. */
function crestFactor(pcm: Buffer): number {
  const peak = peakOf(pcm);
  return peak / (32768 * 10 ** (rmsDbOf(pcm) / 20));
}
/** Bien do (0..1) thanh phan `hz` trong khung (Goertzel) — 250 Hz = dung 5 chu ky / 320 mau. */
function toneLevelAt(pcm: Buffer, hz: number): number {
  const n = pcm.length / 2;
  const k = 2 * Math.cos(2 * Math.PI * hz / 16000);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < n; i++) { const s0 = pcm.readInt16LE(i * 2) / 32768 + k * s1 - s2; s2 = s1; s1 = s0; }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - k * s1 * s2)) * 2 / n;
}
/** Tong meo hai hai (%, so voi thanh phan co ban) — cat cung/song vuong cho THD rat lon. */
function thdPct(pcm: Buffer, hz: number): number {
  const a1 = toneLevelAt(pcm, hz);
  let e = 0;
  for (let i = 0; i < pcm.length / 2; i++) { const v = pcm.readInt16LE(i * 2) / 32768; e += v * v; }
  e /= pcm.length / 2;
  const fund = a1 * a1 / 2;
  return 100 * Math.sqrt(Math.max(0, e - fund) / fund);
}

describe('audioAgc — im lang', () => {
  it('khung toan so 0 -> nguyen byte, gain khong doi, bao silent', () => {
    const st = newAgcState(18);                     // dang co gain cao tu khung truoc
    const f = Buffer.alloc(FRAME_BYTES);
    const r = processFrame(f, st);
    expect(r.silent).toBe(true);
    expect(r.gainDb).toBe(18);                      // giu nguyen gain, khong "tha" ve 0
    expect(st.gainDb).toBe(18);
    expect(f.equals(Buffer.alloc(FRAME_BYTES))).toBe(true);
    expect(r.peak).toBe(0);
  });

  it('nhieu nen -70 dBFS (< -60 dBFS) -> KHONG khuech dai, nguyen byte', () => {
    const st = newAgcState(0);
    const f = sineFrame(-70);
    const before = Buffer.from(f);
    const r = processFrame(f, st);
    expect(r.silent).toBe(true);
    expect(r.rmsDb).toBeLessThan(AGC_SILENCE_DBFS);
    expect(st.gainDb).toBe(0);
    expect(f.equals(before)).toBe(true);
  });
});

describe('audioAgc — khung nho: tang gain dung huong va dung gioi han', () => {
  it('khung nho -> gain huong ve AGC_TARGET_DBFS, RMS ra dung muc nham (khong hard-code so dB)', () => {
    const st = newAgcState(0);
    const rmsIn = rmsDbOf(sineFrame(-30));
    // Ky vong doc THANG tu hang so cua module (muc nham doi theo CCR_CALL_HALFDUPLEX: -14 dBFS khi bat, -16 khi tat)
    // va tu gioi han gain toi da — khong viet cung con so dB nao.
    const want = Math.max(AGC_MIN_GAIN_DB, Math.min(AGC_MAX_GAIN_DB, AGC_TARGET_DBFS - rmsIn));
    const pcm = sinePcm(40, -30);                   // ~800 ms: du cho release/attack on dinh
    const out = processPcm(pcm, st);
    expect(st.gainDb).toBeCloseTo(want, 0);
    expect(st.gainDb).toBeGreaterThan(want - 1);
    expect(st.gainDb).toBeLessThan(want + 1);
    const last = out.subarray(out.length - FRAME_BYTES);
    expect(rmsDbOf(last)).toBeCloseTo(rmsIn + want, 0);         // = AGC_TARGET_DBFS khi khong bi chan gain
    if (want < AGC_MAX_GAIN_DB && want > AGC_MIN_GAIN_DB) {
      expect(rmsDbOf(last)).toBeGreaterThan(AGC_TARGET_DBFS - 1);
      expect(rmsDbOf(last)).toBeLessThan(AGC_TARGET_DBFS + 1);
    }
  });

  it('-40 dBFS -> gain len nhung KHONG vuot AGC_MAX_GAIN_DB (gain toi da)', () => {
    const st = newAgcState(0);
    processPcm(sinePcm(40, -40), st);               // gain can > AGC_MAX_GAIN_DB -> kep o AGC_MAX_GAIN_DB
    expect(st.gainDb).toBeCloseTo(AGC_MAX_GAIN_DB, 2);
    expect(st.gainDb).toBeLessThanOrEqual(AGC_MAX_GAIN_DB);
  });

  it('khung rat nho (-50 dBFS) va khung lon (0 dBFS) -> gain luon trong [AGC_MIN_GAIN_DB, AGC_MAX_GAIN_DB]', () => {
    const st = newAgcState(0);
    processPcm(sinePcm(60, -50), st);
    expect(st.gainDb).toBeLessThanOrEqual(AGC_MAX_GAIN_DB + 1e-9);
    processPcm(sinePcm(120, 0), st);
    expect(st.gainDb).toBeGreaterThanOrEqual(AGC_MIN_GAIN_DB - 1e-9);
    expect(st.gainDb).toBeCloseTo(AGC_MIN_GAIN_DB, 1);
  });
});

describe('audioAgc — khung lon: limiter mem -4 dBFS', () => {
  it('0 dBFS -> dinh ra <= -4 dBFS, meo dang nho (khong bi cat cung thanh song vuong)', () => {
    const st = newAgcState(0);                      // vao tu gain 0 dB: dinh 0 dBFS vuot nguong -> limiter chay
    const f = sineFrame(0, 250);                    // 250 Hz: 5 chu ky / khung -> do THD chinh xac
    const r = processFrame(f, st);
    expect(r.limited).toBeGreaterThan(0);           // co mau phai qua limiter
    expect(r.peak).toBeLessThanOrEqual(LIMIT_PEAK);
    expect(dbfsOf(r.peak)).toBeLessThanOrEqual(LIMIT_DBFS);
    expect(dbfsOf(r.peak)).toBeGreaterThan(LIMIT_DBFS - 1);   // van to, chi bi nen dinh chu khong bi bop nho
    // Tran -4 dBFS nen mot sin 0 dBFS bi nen that su (THD ~14%): do la gia cua tran thap, KHONG phai cat cung.
    // Muc thuc te cua tep mau (dinh <= -6 dBFS) nam DUOI knee -4,9 dBFS -> trong suot, xem test ngay duoi.
    expect(thdPct(f, 250)).toBeLessThan(20);        // cat cung ~20-30%, song vuong > 40%
    // Tran -4 dBFS nen mot sin 0 dBFS bi nen sau hon so voi tran -1 dBFS: crest ~1,2 (van khac song vuong = 1,0).
    expect(crestFactor(f)).toBeGreaterThan(1.15);   // song vuong ~1,0, sin nguyen ven ~1,41
  });

  it('-5 dBFS (duoi knee -4,9 dBFS, dung muc tep mau) -> limiter TRONG SUOT: THD < 1%', () => {
    const st = newAgcState(AGC_MIN_GAIN_DB);        // gain da xuong day -> chinh xac muc vao, khong AGC keo len
    const f = sineFrame(-5, 250);
    const r = processFrame(f, st);
    expect(r.limited).toBe(0);
    expect(thdPct(f, 250)).toBeLessThan(1);
    expect(dbfsOf(r.peak)).toBeLessThan(LIMIT_DBFS + 0.2);
  });

  it('khung o muc binh thuong (sau AGC, duoi knee) -> limiter KHONG dung (trong suot)', () => {
    const st = newAgcState(0);
    processPcm(sinePcm(30, -30), st);               // gain on dinh theo AGC_TARGET_DBFS (duoi knee nen khong nen)
    const r = processFrame(sineFrame(-30, 250), st);
    expect(r.limited).toBe(0);
    expect(dbfsOf(r.peak)).toBeLessThan(-2);        // duoi knee -> nguyen dang song sin
    expect(thdPct(sineFrame(-30, 250), 250)).toBeLessThan(1);
  });

  it('gain cuc dai (AGC_MAX_GAIN_DB) van khong bao gio vuot LIMIT_DBFS', () => {
    const st = newAgcState(AGC_MAX_GAIN_DB);
    for (let k = 0; k < 5; k++) {
      const f = sineFrame(0, 1000, k * 320);
      const r = processFrame(f, st);
      expect(r.peak).toBeLessThanOrEqual(LIMIT_PEAK);
    }
  });

  it('softClip: tuyen tinh duoi knee, don dieu tang, co dinh <= LIMIT_PEAK', () => {
    expect(softClip(0)).toBe(0);
    expect(softClip(1000)).toBe(1000);
    expect(softClip(LIMIT_KNEE)).toBeCloseTo(LIMIT_KNEE, 6);
    // Don dieu tang tren toan dai 16-bit: khong co "vung chet"/plateau nhu cat cung.
    let prev = -Infinity;
    for (let v = LIMIT_KNEE; v <= 32767; v += 500) {
      const y = softClip(v);
      expect(y).toBeGreaterThan(prev);
      expect(y).toBeLessThan(LIMIT_PEAK);           // trong dai 16-bit: chua cham nguong
      prev = y;
    }
    for (const v of [32767, 65534, 1 << 20]) expect(softClip(v)).toBeLessThanOrEqual(LIMIT_PEAK);
    expect(softClip(-32767)).toBeLessThan(-LIMIT_KNEE);
    expect(-softClip(-32767)).toBeCloseTo(softClip(32767), 6);
  });
});

describe('audioAgc — attack 5 ms / release 200 ms', () => {
  it('gain LEN nhanh: mot khung -30 dBFS da dat >90% gain muc tieu', () => {
    const st = newAgcState(0);
    processFrame(sineFrame(-30), st);
    // Muc tieu doc tu hang so (co the bi chan boi gain toi da) — khong viet cung so dB.
    const want = Math.max(AGC_MIN_GAIN_DB,
      Math.min(AGC_MAX_GAIN_DB, AGC_TARGET_DBFS - rmsDbOf(sineFrame(-30))));
    expect(want).toBeGreaterThan(0);
    expect(st.gainDb).toBeGreaterThan(0.9 * want);             // 0,9817 * want
  });

  it('gain XUONG cham: mot khung 0 dBFS chi giam <15% quang duong', () => {
    const st = newAgcState(AGC_MAX_GAIN_DB);
    processFrame(sineFrame(0), st);                 // target bi kep o AGC_MIN_GAIN_DB -> quang duong 18 dB
    const dist = AGC_MAX_GAIN_DB - AGC_MIN_GAIN_DB;
    expect(st.gainDb).toBeLessThan(AGC_MAX_GAIN_DB);
    expect(st.gainDb).toBeGreaterThan(AGC_MAX_GAIN_DB - 0.2 * dist);   // 0,0952 * 18 = 1,7 dB moi khung
  });
});

describe('audioAgc — bat/tat bang env CCR_CALL_AGC (A/B) và kích thước gói', () => {
  const saved = process.env.CCR_CALL_AGC;
  afterEach(() => {
    if (saved === undefined) delete process.env.CCR_CALL_AGC;
    else process.env.CCR_CALL_AGC = saved;
  });

  it('mac dinh BAT (AGC_ENABLED = true khi khong dat env)', () => {
    expect(AGC_ENABLED).toBe(true);
  });

  it('tat -> passthrough y nguyen byte, gain khong bi sua', () => {
    const st = newAgcState(0);
    const pcm = sinePcm(3, -40);
    const out = processPcm(pcm, st, false);
    expect(out.length).toBe(pcm.length);
    expect(out.equals(pcm)).toBe(true);
    expect(st.gainDb).toBe(0);
  });

  it('CCR_CALL_AGC=0 doc MOT lan luc khoi dong -> AGC_ENABLED = false', async () => {
    vi.resetModules();
    process.env.CCR_CALL_AGC = '0';
    const off = await import('./audioAgc.js');
    expect(off.AGC_ENABLED).toBe(false);
    // va passthrough khong can truyen co
    const pcm = sinePcm(1, -40);
    expect(off.processPcm(pcm, off.newAgcState()).equals(pcm)).toBe(true);

    vi.resetModules();
    delete process.env.CCR_CALL_AGC;
    const on = await import('./audioAgc.js');
    expect(on.AGC_ENABLED).toBe(true);
  });

  it('khung 20 ms: vao 640 byte -> ra 640 byte (khong doi kich thuoc goi)', () => {
    const st = newAgcState(0);
    const pcm = sineFrame(-30);
    expect(pcm.length).toBe(FRAME_BYTES);
    const out = processPcm(pcm, st);
    expect(out.length).toBe(640);
    expect(out.equals(pcm)).toBe(false);            // AGC co tac dung (khac byte voi dau vao)
    expect(rmsDbOf(out)).toBeGreaterThan(rmsDbOf(pcm));
  });

  it('nhieu khung va duoi le: do dai byte khong doi, duoi le giu nguyen', () => {
    const st = newAgcState(0);
    const pcm = Buffer.concat([sinePcm(2, -30), Buffer.from([1, 2, 3, 4, 5, 6])]);
    const out = processPcm(pcm, st);
    expect(out.length).toBe(pcm.length);
    expect(out.subarray(out.length - 6).equals(pcm.subarray(pcm.length - 6))).toBe(true);
  });

  it('goi ngan 10 ms (320 byte) van duoc xu ly, do dai khong doi', () => {
    const st = newAgcState(0);
    const src = Buffer.from(sineFrame(-30, 250).subarray(0, 320));   // client gui goi 10 ms thay vi 20 ms
    const want = Math.min(AGC_MAX_GAIN_DB, AGC_TARGET_DBFS - rmsDbOf(src));
    const out = processPcm(src, st);
    expect(out.length).toBe(320);
    expect(out.equals(src)).toBe(false);
    expect(rmsDbOf(out)).toBeGreaterThan(rmsDbOf(src));
    // Hang so thoi gian tinh theo do dai that cua khung: 10 ms -> he so attack 1 - e^-2 = 0,865 (khong phai ~1).
    expect(st.gainDb).toBeCloseTo(0.865 * want, 0);
    expect(st.gainDb).toBeLessThanOrEqual(AGC_MAX_GAIN_DB);
  });
});
