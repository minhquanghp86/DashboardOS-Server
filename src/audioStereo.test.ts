// SPDX-License-Identifier: Apache-2.0
//
// Copyright (c) 2026 minhquanghp86
// Licensed under the Apache License, Version 2.0 (see LICENSE).

// (06/12/2026) MONO -> STEREO (src/audioStereo.ts) — kiem tra bang so lieu, khong can thiet bi:
//   - do dai CHINH XAC x2 (640 -> 1280) va 1280 B dung la 20 ms stereo (320 khung mau x 2 kenh x 2 byte);
//   - L = R voi MOI mau, ke ca mau am, mau duong va mau BIEN -32768 (khong bi bao hoa/nhan he so);
//   - khong doi do dai THOI GIAN: 320 mau mono 20 ms -> 320 khung mau stereo 20 ms;
//   - `stereoToMono()` lay kenh trai -> byte Y NGUYEN so voi dau vao mono (duong tat AGC/EQ thi khong mat gi);
//   - env `CCR_CALL_STEREO` doc MOT lan luc khoi dong (mac dinh BAT) + dong log khoi dong.
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  FRAME_MS,
  MONO_FRAME_BYTES,
  SAMPLE_BYTES,
  SAMPLE_RATE,
  SPEAKER_FRAME_BYTES,
  STEREO_ENABLED,
  STEREO_FRAME_BYTES,
  STEREO_LOG,
  monoToStereo,
  readStereoEnabled,
  speakerFrameBytes,
  stereoToMono,
} from './audioStereo.js';

/** PCM mono tu danh sach mau (s16le). */
const pcm = (...samples: number[]): Buffer => {
  const b = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => b.writeInt16LE(v, i * 2));
  return b;
};
const sampleAt = (b: Buffer, i: number): number => b.readInt16LE(i * 2);

/** Mot khung 20 ms mono 16 kHz: song sin 1 kHz, dinh `peak`. */
function sineFrame(peak = 8000): Buffer {
  const n = (SAMPLE_RATE / 1000) * FRAME_MS;                   // 320 mau
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 1000 * i) / SAMPLE_RATE) * peak), i * 2);
  return b;
}

describe('monoToStereo — do dai va L = R', () => {
  it('mot khung 20 ms: 640 byte mono -> 1280 byte stereo (x2)', () => {
    const mono = sineFrame();
    const st = monoToStereo(mono);
    expect(mono.length).toBe(MONO_FRAME_BYTES);
    expect(st.length).toBe(STEREO_FRAME_BYTES);
    expect(st.length).toBe(mono.length * 2);
    expect(st.length).toBe(1280);
  });

  it('1280 byte = 20 ms STEREO 16 kHz (320 khung mau x 2 kenh x 2 byte)', () => {
    const frames = STEREO_FRAME_BYTES / (2 * SAMPLE_BYTES);     // so khung mau (320)
    expect(frames).toBe(320);
    expect((frames / SAMPLE_RATE) * 1000).toBe(FRAME_MS);       // dung 20 ms
    expect(MONO_FRAME_BYTES).toBe((SAMPLE_RATE / 1000) * FRAME_MS * SAMPLE_BYTES);  // 640: cung 20 ms mono
  });

  it('moi khung mau stereo: kenh trai = kenh phai (tung mau, ca buffer dai)', () => {
    const mono = sineFrame(9000);
    const st = monoToStereo(Buffer.concat([mono, mono, mono]));
    for (let i = 0; i < mono.length / 2; i++) {
      expect(st.readInt16LE(i * 4)).toBe(mono.readInt16LE(i * 2));         // L
      expect(st.readInt16LE(i * 4 + 2)).toBe(mono.readInt16LE(i * 2));     // R = L
    }
  });

  it('gia tri AM va DUONG giu nguyen chinh xac (khong nhan he so, khong lam tron)', () => {
    const mono = pcm(1000, -1000, 32767, -32767, 0, 1, -1, 12345, -23456);
    const st = monoToStereo(mono);
    const left = [...Array(9)].map((_, i) => sampleAt(st, i * 2));
    const right = [...Array(9)].map((_, i) => sampleAt(st, i * 2 + 1));
    expect(left).toEqual([1000, -1000, 32767, -32767, 0, 1, -1, 12345, -23456]);
    expect(right).toEqual(left);
    expect(st.length).toBe(mono.length * 2);
  });

  it('mau BIEN -32768 (am nho nhat cua s16le) lap lai nguyen ven, khong tran thanh +32767', () => {
    const st = monoToStereo(pcm(-32768, 32767, -32768));
    expect([...Array(3)].map((_, i) => sampleAt(st, i * 2))).toEqual([-32768, 32767, -32768]);
    expect([...Array(3)].map((_, i) => sampleAt(st, i * 2 + 1))).toEqual([-32768, 32767, -32768]);
    expect(st.length).toBe(12);
  });

  it('buffer rong -> rong; buffer le 1 byte -> van x2 va khong mat byte cuoi', () => {
    expect(monoToStereo(Buffer.alloc(0)).length).toBe(0);
    const odd = Buffer.from([0x11, 0x22, 0x33]);                          // 1 mau (0x2211) + 1 byte le (0x33)
    const st = monoToStereo(odd);
    expect(st.length).toBe(6);                                           // x2 dung
    expect(sampleAt(st, 0)).toBe(0x2211);                                // L
    expect(sampleAt(st, 1)).toBe(0x2211);                                // R
    expect(st[4]).toBe(0x33);                                            // byte le: chep vao CA HAI kenh
    expect(st[5]).toBe(0x33);
  });

  it('khong sua buffer goc (duong xu ly khac co the con dung no)', () => {
    const mono = sineFrame();
    const before = Buffer.from(mono);
    monoToStereo(mono);
    expect(mono.equals(before)).toBe(true);
  });

  it('stereoToMono(monoToStereo(x)) = x (kenh trai dung la mono goc)', () => {
    const mono = sineFrame(5000);
    expect(stereoToMono(monoToStereo(mono)).equals(mono)).toBe(true);
    const small = pcm(-32768, 0, 32767, -1);
    expect(stereoToMono(monoToStereo(small)).equals(small)).toBe(true);
  });
});

describe('audioStereo — bat/tat bang env CCR_CALL_STEREO (A/B)', () => {
  const saved = process.env.CCR_CALL_STEREO;
  afterEach(() => {
    if (saved === undefined) delete process.env.CCR_CALL_STEREO;
    else process.env.CCR_CALL_STEREO = saved;
  });

  it('mac dinh BAT: khong dat env -> true (1280 B/khung)', () => {
    expect(readStereoEnabled({})).toBe(true);
    expect(readStereoEnabled({ CCR_CALL_STEREO: '' })).toBe(true);
    expect(readStereoEnabled({ CCR_CALL_STEREO: '1' })).toBe(true);
    expect(readStereoEnabled({ CCR_CALL_STEREO: 'on' })).toBe(true);
    expect(STEREO_ENABLED).toBe(true);                          // nap module khong co env -> BAT
    expect(SPEAKER_FRAME_BYTES).toBe(1280);
  });

  it('CCR_CALL_STEREO=0/off/false/no -> TAT (gui mono 640 B nhu cu)', () => {
    for (const v of ['0', 'off', 'false', 'no', ' OFF ']) expect(readStereoEnabled({ CCR_CALL_STEREO: v })).toBe(false);
  });

  it('speakerFrameBytes: stereo -> 1280, mono -> 640 (nhip van 20 ms)', () => {
    expect(speakerFrameBytes(true)).toBe(1280);
    expect(speakerFrameBytes(false)).toBe(640);
    expect(speakerFrameBytes(true)).toBe(speakerFrameBytes(false) * 2);
  });

  it('dong log khoi dong dung dinh dang [audio] stereo=on frame=1280B/20ms', () => {
    expect(STEREO_LOG).toBe('[audio] stereo=on frame=1280B/20ms');
  });

  it('CCR_CALL_STEREO=0 doc MOT lan luc khoi dong -> STEREO_ENABLED = false, khung 640', async () => {
    vi.resetModules();
    process.env.CCR_CALL_STEREO = '0';
    const off = await import('./audioStereo.js');
    expect(off.STEREO_ENABLED).toBe(false);
    expect(off.SPEAKER_FRAME_BYTES).toBe(640);
    expect(off.STEREO_LOG).toBe('[audio] stereo=off frame=640B/20ms');

    vi.resetModules();
    delete process.env.CCR_CALL_STEREO;
    const on = await import('./audioStereo.js');
    expect(on.STEREO_ENABLED).toBe(true);
    expect(on.SPEAKER_FRAME_BYTES).toBe(1280);
  });

  it('bat/tat KHONG doi tan so lay mau: van 16 kHz, 20 ms, chi doi so kenh', () => {
    expect(SAMPLE_RATE).toBe(16000);
    expect(FRAME_MS).toBe(20);
    expect(speakerFrameBytes(true) / (2 * SAMPLE_BYTES)).toBe(320);                       // 320 khung mau
    expect((speakerFrameBytes(true) / (2 * SAMPLE_BYTES) / SAMPLE_RATE) * 1000).toBe(FRAME_MS);
    expect((speakerFrameBytes(false) / SAMPLE_BYTES / SAMPLE_RATE) * 1000).toBe(FRAME_MS);
  });
});
