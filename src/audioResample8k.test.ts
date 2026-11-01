// SPDX-License-Identifier: Apache-2.0
//
// Copyright (c) 2026 minhquanghp86
// Licensed under the Apache License, Version 2.0 (see LICENSE).

// (07/12/2026) HA MAU 16 kHz -> 8 kHz (src/audioResample8k.ts) — kiem tra bang SO LIEU, khong can thiet bi:
//   - do dai ra = MOT NUA (640 B/20 ms -> 320 B/20 ms), van s16le mono;
//   - 1 kHz o 16 kHz -> van 1 kHz o 8 kHz (dem zero-crossing: KHONG doi cao do);
//   - 6 kHz o 16 kHz -> bi dap manh (alias 2 kHz con < 1% bien do) — day la ly do phai LOC truoc khi bo mau;
//   - TRANG THAI LOC giu giua cac khung: cat doi buffer cho ra BYTE Y HET nhu loc mot lan (khong co bien gia);
//   - mau bien do (DC +-32767, xung vuong) khong bi tran/khong lat dau;
//   - `frameBytesFor()`: 320 cho 8 kHz, 640 cho 16 kHz, x2 khi stereo;
//   - bo dem nhip voi `frameBytes = 320` van MOT goi moi 20 ms (0/20/40... ms), toc do byte 16 KB/s.
//   - env `CCR_CALL_RATE8K` doc MOT lan luc khoi dong (mac dinh TAT) + dong log `[audio] rate=...`.
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CUTOFF_HZ,
  FRAME_MS,
  IN_MONO_FRAME_BYTES,
  IN_RATE_HZ,
  OUT_MONO_FRAME_BYTES,
  OUT_RATE_HZ,
  RATE8K_ENABLED,
  RATE_LOG,
  SPEAKER_RATE_HZ,
  downsample2,
  frameBytesFor,
  newDownsample2State,
  rateLogLine,
  readRate8kEnabled,
} from './audioResample8k.js';
import { FramePacer, type PacerOptions } from './audioPacer.js';

/** Song sin `hz` o tan so `rate`, `ms` ms, dinh `amp` (0..1). */
function tone(hz: number, ms: number, amp = 0.5, rate = IN_RATE_HZ): Buffer {
  const n = Math.round((rate * ms) / 1000);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * amp * 32767), i * 2);
  return b;
}

const samples = (b: Buffer): number[] => [...Array(Math.floor(b.length / 2))].map((_, i) => b.readInt16LE(i * 2));

/** RMS chuan hoa (0..1) cua PCM s16le. */
function rms(b: Buffer): number {
  const n = Math.floor(b.length / 2);
  if (!n) return 0;
  let s = 0;
  for (let i = 0; i < n; i++) { const v = b.readInt16LE(i * 2) / 32768; s += v * v; }
  return Math.sqrt(s / n);
}

/** Bien do (0..1) cua thanh phan tan so `hz` (Goertzel) trong buffer o tan so `rate`. */
function levelAt(b: Buffer, hz: number, rate: number): number {
  const n = Math.floor(b.length / 2);
  const k = 2 * Math.cos((2 * Math.PI * hz) / rate);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < n; i++) { const s0 = b.readInt16LE(i * 2) / 32768 + k * s1 - s2; s2 = s1; s1 = s0; }
  return (Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - k * s1 * s2)) * 2) / n;
}

/** Tan so do duoc bang ZERO-CROSSING (so lan doi dau / 2 / so giay). */
function zeroCrossingHz(b: Buffer, rate: number): number {
  const n = Math.floor(b.length / 2);
  let cross = 0;
  for (let i = 1; i < n; i++) {
    const a = b.readInt16LE((i - 1) * 2), c = b.readInt16LE(i * 2);
    if ((a < 0 && c >= 0) || (a > 0 && c <= 0)) cross++;
  }
  return cross / 2 / (n / rate);
}

describe('downsample2 — do dai va nhip', () => {
  it('mot khung 20 ms: 640 B (16 kHz mono) -> 320 B (8 kHz mono), do dai MOT NUA', () => {
    const pcm = tone(1000, FRAME_MS);
    expect(pcm.length).toBe(IN_MONO_FRAME_BYTES);            // 640
    const out = downsample2(pcm, newDownsample2State());
    expect(out.length).toBe(OUT_MONO_FRAME_BYTES);            // 320
    expect(out.length).toBe(pcm.length / 2);
  });

  it('320 B dau ra van la DUNG 20 ms o 8 kHz (160 mau x 2 byte)', () => {
    expect(OUT_MONO_FRAME_BYTES).toBe((OUT_RATE_HZ / 1000) * FRAME_MS * 2);   // 8 * 20 * 2
    expect(IN_MONO_FRAME_BYTES).toBe((IN_RATE_HZ / 1000) * FRAME_MS * 2);     // 16 * 20 * 2
    expect(OUT_RATE_HZ).toBe(IN_RATE_HZ / 2);
  });

  it('do dai MOT NUA voi moi do dai chan (2/3/10 khung); buffer rong -> rong', () => {
    for (const frames of [1, 2, 3, 10]) {
      const pcm = tone(700, FRAME_MS * frames);
      expect(downsample2(pcm, newDownsample2State()).length).toBe(pcm.length / 2);
    }
    expect(downsample2(Buffer.alloc(0), newDownsample2State()).length).toBe(0);
  });

  it('so mau le (byte le cuoi) bi bo cho tron mau — khong lam lech do dai cua khung sau', () => {
    const pcm = Buffer.concat([tone(1000, FRAME_MS), Buffer.from([0x7f])]);   // 641 byte = 320 mau + 1 byte le
    expect(downsample2(pcm, newDownsample2State()).length).toBe(320);         // 160 mau -> 320 byte
  });

  it('khong sua buffer goc', () => {
    const pcm = tone(1000, FRAME_MS);
    const before = Buffer.from(pcm);
    downsample2(pcm, newDownsample2State());
    expect(pcm.equals(before)).toBe(true);
  });
});

describe('downsample2 — cao do: 1 kHz giu nguyen, 6 kHz bi dap (khong alias)', () => {
  it('tone 1 kHz o 16 kHz -> van 1 kHz o 8 kHz (zero-crossing, sai so < 1%)', () => {
    const pcm = tone(1000, 1000, 0.5);
    const out = downsample2(pcm, newDownsample2State());
    const hz = zeroCrossingHz(out, OUT_RATE_HZ);
    expect(hz).toBeGreaterThan(990);
    expect(hz).toBeLessThan(1010);
    expect(zeroCrossingHz(pcm, IN_RATE_HZ)).toBeGreaterThan(990);   // dau vao dung la 1 kHz
  });

  it('cac tone trong dai tieng noi (300/500/1500/2500 Hz) giu nguyen tan so sau khi ha mau', () => {
    for (const hz of [300, 500, 1500, 2500]) {
      const out = downsample2(tone(hz, 1000, 0.5), newDownsample2State());
      const got = zeroCrossingHz(out, OUT_RATE_HZ);
      expect(Math.abs(got - hz) / hz).toBeLessThan(0.02);
    }
  });

  it('bien do 1 kHz sau khi ha mau gan nhu khong doi (loc cat 3,4 kHz: < 0,5 dB duoi 2,5 kHz)', () => {
    const pcm = tone(1000, 1000, 0.5);
    const out = downsample2(pcm, newDownsample2State());
    expect(rms(out) / rms(pcm)).toBeGreaterThan(0.95);
    expect(rms(out) / rms(pcm)).toBeLessThan(1.05);
  });

  it('tone 6 kHz (tren Nyquist 4 kHz cua 8 kHz) bi dap > 30 dB — loc TRUOC khi bo mau', () => {
    const pcm = tone(6000, 1000, 0.5);
    const out = downsample2(pcm, newDownsample2State());
    const dB = 20 * Math.log10(rms(out) / rms(pcm));
    expect(dB).toBeLessThan(-30);                             // do dac bo loc: ~ -58 dB
    expect(CUTOFF_HZ).toBe(3400);                             // diem cat nam duoi Nyquist 4 kHz
  });

  it('alias cua 6 kHz (roi xuong 2 kHz = 8000 - 6000) con < 1% bien do goc', () => {
    const pcm = tone(6000, 1000, 0.5);
    const out = downsample2(pcm, newDownsample2State());
    // Neu CHI bo mau ma khong loc, 6 kHz se hien ra thanh 2 kHz voi bien do ~0,5 (alias that).
    expect(levelAt(out, 2000, OUT_RATE_HZ)).toBeLessThan(0.005);   // < 0,5% toan thang
    expect(levelAt(pcm, 2000, IN_RATE_HZ)).toBeLessThan(0.01);     // dau vao KHONG co 2 kHz
  });

  it('doi chieu: bo mau KHONG loc (lay mau chan) thi 6 kHz thanh 2 kHz ro rang — chung minh phai loc', () => {
    const pcm = tone(6000, 1000, 0.5);
    const naive = Buffer.alloc(pcm.length / 2);
    for (let i = 0; i < naive.length / 2; i++) naive.writeInt16LE(pcm.readInt16LE(i * 4), i * 2);
    expect(levelAt(naive, 2000, OUT_RATE_HZ)).toBeGreaterThan(0.4);   // alias ~ 0,5 (nghe thanh tieng 2 kHz la)
  });
});

describe('downsample2 — trang thai loc giua cac khung (khong re o bien)', () => {
  it('cat doi buffer cho ra BYTE Y HET nhu loc mot lan (state lien tuc)', () => {
    const whole = tone(1000, 2 * FRAME_MS, 0.5);
    const a = whole.subarray(0, IN_MONO_FRAME_BYTES);
    const b = whole.subarray(IN_MONO_FRAME_BYTES);
    const st = newDownsample2State();
    const split = Buffer.concat([downsample2(a, st), downsample2(b, st)]);
    const oneShot = downsample2(whole, newDownsample2State());
    expect(split.length).toBe(oneShot.length);
    expect(split.equals(oneShot)).toBe(true);
  });

  it('5 khung lien tiep (1 kHz) cat nho -> ghep lai van = mot lan loc', () => {
    const whole = tone(1000, 5 * FRAME_MS, 0.6);
    const st = newDownsample2State();
    const parts: Buffer[] = [];
    for (let k = 0; k < 5; k++) parts.push(downsample2(whole.subarray(k * IN_MONO_FRAME_BYTES, (k + 1) * IN_MONO_FRAME_BYTES), st));
    expect(Buffer.concat(parts).equals(downsample2(whole, newDownsample2State()))).toBe(true);
  });

  it('neu TRA trang thai ve 0 moi khung thi co BIEN GIA (test tren khong vo nghia)', () => {
    const whole = tone(500, 2 * FRAME_MS, 1);
    const a = whole.subarray(0, IN_MONO_FRAME_BYTES);
    const b = whole.subarray(IN_MONO_FRAME_BYTES);
    const shared = newDownsample2State();
    const ok = Buffer.concat([downsample2(a, shared), downsample2(b, shared)]);
    const reset = Buffer.concat([downsample2(a, newDownsample2State()), downsample2(b, newDownsample2State())]);
    // Loc lien tuc: buoc nhay lon nhat giua hai mau lien tiep chi la doc tu nhien cua sin 500 Hz o 8 kHz
    // (2 * 32767 * sin(pi * 500 / 8000) ~ 12780) — khong co cu giat nao o moc noi hai khung.
    const d0 = samples(ok);
    const maxStep = Math.max(...d0.slice(1).map((v, i) => Math.abs(v - d0[i])));
    const naturalStep = 2 * 32767 * Math.sin((Math.PI * 500) / OUT_RATE_HZ);
    expect(maxStep).toBeLessThanOrEqual(naturalStep * 1.05);
    // Trang thai bi reset -> moc noi khong con la tin hieu, lech HAN so voi duong loc lien tuc.
    const d = samples(ok), w = samples(reset);
    const maxDiff = Math.max(...d.map((v, i) => Math.abs(v - w[i])));
    expect(maxDiff).toBeGreaterThan(1000);
  });

  it('bien khung khong sinh ra tan so la: 1 kHz xuyen qua 10 khung van la 1 kHz', () => {
    const whole = tone(1000, 10 * FRAME_MS, 0.5);
    const st = newDownsample2State();
    const parts: Buffer[] = [];
    for (let k = 0; k < 10; k++) parts.push(downsample2(whole.subarray(k * IN_MONO_FRAME_BYTES, (k + 1) * IN_MONO_FRAME_BYTES), st));
    const out = Buffer.concat(parts);
    expect(Math.abs(zeroCrossingHz(out, OUT_RATE_HZ) - 1000)).toBeLessThan(15);
    expect(rms(out) / rms(whole)).toBeGreaterThan(0.95);       // khong bi hut muc o cac bien khung
  });
});

describe('downsample2 — mau bien do khong tran', () => {
  it('DC +32767 -> ra +32767 (khong tran thanh so am), DC -32768 -> -32768', () => {
    const hi = Buffer.alloc(IN_MONO_FRAME_BYTES);
    for (let i = 0; i < hi.length; i += 2) hi.writeInt16LE(32767, i);
    const lo = Buffer.alloc(IN_MONO_FRAME_BYTES);
    for (let i = 0; i < lo.length; i += 2) lo.writeInt16LE(-32768, i);
    const outHi = samples(downsample2(hi, newDownsample2State()));
    const outLo = samples(downsample2(lo, newDownsample2State()));
    for (let i = 40; i < outHi.length; i++) { expect(outHi[i]).toBeGreaterThanOrEqual(32766); expect(outHi[i]).toBeLessThanOrEqual(32767); }
    for (let i = 40; i < outLo.length; i++) { expect(outLo[i]).toBeLessThanOrEqual(-32767); expect(outLo[i]).toBeGreaterThanOrEqual(-32768); }
  });

  it('xung vuong +-32767 (bien do cuc dai) -> moi mau trong [-32768, 32767], khong lat dau', () => {
    const n = Math.round((IN_RATE_HZ * FRAME_MS) / 1000);
    const sq = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) sq.writeInt16LE(Math.floor(i / 40) % 2 ? -32767 : 32767, i * 2);   // 200 Hz
    const out = samples(downsample2(sq, newDownsample2State()));
    for (const v of out) { expect(v).toBeGreaterThanOrEqual(-32768); expect(v).toBeLessThanOrEqual(32767); }
    // Moi mau ra thu k = mau vao thu 2k: vung +- dang + phai ra duong, vung - phai ra am — khong mau nao bi
    // lat dau do tran (do vot dinh cua bo loc da duoc CHAN trong [-32768, 32767]).
    expect(out[45]).toBeGreaterThan(20000);                    // vao (90) dang o nua DUONG
    expect(out[70]).toBeLessThan(-20000);                      // vao (140) dang o nua AM
    expect(out.filter((v) => v > 0).length).toBeGreaterThan(60);   // ~ mot nua so mau duong
    expect(out.filter((v) => v < 0).length).toBeGreaterThan(60);
  });

  it('sine dinh 32767 -> khong co mau nao vuot khoang s16le (lam tron + chan)', () => {
    const pcm = tone(1000, 4 * FRAME_MS, 1);
    const out = samples(downsample2(pcm, newDownsample2State()));
    expect(Math.max(...out)).toBeLessThanOrEqual(32767);
    expect(Math.min(...out)).toBeGreaterThanOrEqual(-32768);
    expect(Math.max(...out)).toBeGreaterThan(30000);           // van giu duoc dinh (khong bi bop nho)
  });
});

describe('frameBytesFor + env CCR_CALL_RATE8K', () => {
  it('320 cho 8 kHz (20 ms), 640 cho 16 kHz, x2 khi stereo', () => {
    expect(frameBytesFor(8000)).toBe(320);
    expect(frameBytesFor(16000)).toBe(640);
    expect(frameBytesFor(8000, 2)).toBe(640);
    expect(frameBytesFor(16000, 2)).toBe(1280);
    expect(frameBytesFor(8000)).toBe(frameBytesFor(16000) / 2);
  });

  it('320 B/20 ms = 16 KB/s, 640 B/20 ms = 32 KB/s (dung con so do cua P4: loa tieu thu ~16 KB/s)', () => {
    expect(frameBytesFor(8000) * (1000 / FRAME_MS)).toBe(16000);
    expect(frameBytesFor(16000) * (1000 / FRAME_MS)).toBe(32000);
  });

  it('mac dinh TAT: chi 1/on/true/yes la BAT', () => {
    expect(readRate8kEnabled({})).toBe(false);
    for (const v of ['0', '', 'off', 'false', 'no', ' 0 ']) expect(readRate8kEnabled({ CCR_CALL_RATE8K: v })).toBe(false);
    for (const v of ['1', 'on', 'true', 'yes', ' ON ']) expect(readRate8kEnabled({ CCR_CALL_RATE8K: v })).toBe(true);
  });

  it('nap module khong co env -> TAT: rate 16 kHz, log `[audio] rate=16k`', () => {
    expect(RATE8K_ENABLED).toBe(false);
    expect(SPEAKER_RATE_HZ).toBe(16000);
    expect(RATE_LOG).toBe('[audio] rate=16k');
    expect(rateLogLine(2)).toBe('[audio] rate=16k');
  });

  it('CCR_CALL_RATE8K=1 doc MOT lan luc khoi dong -> rate 8 kHz, log frame=320B/20ms', async () => {
    const saved = process.env.CCR_CALL_RATE8K;
    try {
      vi.resetModules();
      process.env.CCR_CALL_RATE8K = '1';
      const on = await import('./audioResample8k.js');
      expect(on.RATE8K_ENABLED).toBe(true);
      expect(on.SPEAKER_RATE_HZ).toBe(8000);
      expect(on.RATE_LOG).toBe('[audio] rate=8k frame=320B/20ms');
      expect(on.rateLogLine(1)).toBe('[audio] rate=8k frame=320B/20ms');   // mono
      expect(on.rateLogLine(2)).toBe('[audio] rate=8k frame=640B/20ms');    // stereo (van dung byte that)

      vi.resetModules();
      delete process.env.CCR_CALL_RATE8K;
      const off = await import('./audioResample8k.js');
      expect(off.RATE8K_ENABLED).toBe(false);
      expect(off.SPEAKER_RATE_HZ).toBe(16000);
    } finally {
      if (saved === undefined) delete process.env.CCR_CALL_RATE8K;
      else process.env.CCR_CALL_RATE8K = saved;
    }
  });
});

describe('bo dem nhip voi frameBytes = 320 (8 kHz mono)', () => {
  /** Dong ho gia + hang doi hen gio gia (giong src/audioPacer.test.ts). */
  function harness(opts: Partial<PacerOptions> = {}) {
    let t = 0;
    const timers: { at: number; fn: () => void }[] = [];
    const sent: { at: number; bytes: number }[] = [];
    const pacer = new FramePacer({
      send: (_dev, frame) => { sent.push({ at: t, bytes: frame.length }); return true; },
      backlog: () => 0,
      now: () => t,
      setTimeout: (fn, ms) => { const id = { at: t + ms, fn }; timers.push(id); return id; },
      clearTimeout: (id) => { const i = timers.indexOf(id as { at: number; fn: () => void }); if (i >= 0) timers.splice(i, 1); },
      frameBytes: 320,
      ...opts,
    });
    const advance = (ms: number): void => {
      const end = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const n = timers[0];
        if (!n || n.at > end) break;
        timers.shift();
        t = n.at;
        n.fn();
      }
      t = end;
    };
    return { pacer, sent, advance };
  }

  it('5 khung 320 B push MOT LAN -> goi tai 0/20/40/60/80 ms, moi goi 320 byte (van 20 ms/nhip)', () => {
    const h = harness({ maxQueueFrames: 5 });
    for (let i = 0; i < 5; i++) h.pacer.push('p4', Buffer.alloc(320, i));
    h.advance(200);
    expect(h.sent.map((s) => s.at)).toEqual([0, 20, 40, 60, 80]);
    expect(h.sent.every((s) => s.bytes === 320)).toBe(true);
    expect(h.pacer.bytesPerFrame).toBe(320);
    expect(h.pacer.stats('p4')).toEqual({ frames: 5, dropped: 0, queued: 0 });
  });

  it('khung 320 B den moi 20 ms -> dung nhip, tong toc do 16 KB/s (1/2 so voi 16 kHz mono)', () => {
    const h = harness();
    for (let k = 0; k < 10; k++) { h.pacer.push('p4', Buffer.alloc(320)); h.advance(20); }
    h.advance(100);
    expect(h.sent.length).toBe(10);
    expect(h.sent.map((s) => s.at)).toEqual([0, 20, 40, 60, 80, 100, 120, 140, 160, 180].map((v) => v + (v === 0 ? 0 : 0)));
    const bytes = h.sent.reduce((s, x) => s + x.bytes, 0);
    expect((bytes / (h.sent[h.sent.length - 1].at + 20)) * 1000).toBe(16000);   // 16 KB/s
  });

  it('frameBytes = 320 nhung push 640 B (mot khung 20 ms o 8 kHz stereo) -> 2 goi o 0 va 20 ms, KHONG phai 2 goi/nhip', () => {
    const h = harness({ frameBytes: 320, maxQueueFrames: 8 });
    h.pacer.push('p4', Buffer.alloc(640));
    h.advance(100);
    expect(h.sent.map((s) => s.bytes)).toEqual([320, 320]);       // cau hinh SAI phai tranh (dung frameBytesFor(rate, kenh))
    expect(h.sent.map((s) => s.at)).toEqual([0, 20]);             // (08/12/2026) nhip VAN 20 ms/goi — khong gui gap doi
  });
});
