// SPDX-License-Identifier: Apache-2.0
//
// Copyright (c) 2026 minhquanghp86
// Licensed under the Apache License, Version 2.0 (see LICENSE).

// (07/12/2026) TICH HOP `CCR_CALL_RATE8K=1` tren DUNG duong xuong loa man — bai do `POST /call/test/play` phai di
// qua cung duong voi tieng nguoi noi (`sendToSpeaker`), nen so lieu do duoc la so lieu THAT:
//   - 8 kHz mono  (`CCR_CALL_RATE8K=1`, `CCR_CALL_STEREO=0`): goi 320 B/20 ms, tong 16 KB/s, PCM = downsample2(tep);
//   - 8 kHz stereo (`CCR_CALL_RATE8K=1`, `CCR_CALL_STEREO=1`): goi 640 B/20 ms, L = R, moi kenh = downsample2(tep);
//   - mac dinh (khong co `CCR_CALL_RATE8K`) van 16 kHz: goi 640/1280 B — khong doi hanh vi cu.
//   - `frameBytes` tra ve = SO BYTE THAT cua mot goi (bo dem nhip dung cung con so do -> khong chia doi khung).
import fs from 'node:fs';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const screens = vi.hoisted(() => ({ list: [] as { id: string; w: number; h: number; cam: boolean; sd: boolean; spk: boolean; mic: boolean }[] }));

vi.mock('./deviceManager.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./deviceManager.js')>();
  return {
    ...real,
    connectedScreens: () => screens.list,
    openRingPage: () => true,
    answerDoorbell: () => true,
    closeDoorbell: () => true,
    postNotify: () => ({ ok: true }),
  };
});

import { downsample2, newDownsample2State } from './audioResample8k.js';
import { stereoToMono } from './audioStereo.js';

const DEV = 'p4-bep';
const FRAME_BYTES = 640;                                  // 20 ms mono 16 kHz (tep mau + duong xuong man)

/** WAV 16 kHz mono s16le tu `frames` khung 20 ms, song sin 1 kHz dinh -12 dBFS (giong src/callTestAudio.test.ts). */
function makeWav(frames: number): Buffer {
  const n = frames * (FRAME_BYTES / 2);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 1000 * i) / 16000) * 8200), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1'); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8, 'latin1');
  h.write('fmt ', 12, 'latin1'); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36, 'latin1'); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

let dir = '';
let wavPcm: Buffer = Buffer.alloc(0);

/** Nap lai `callBridge` voi env da dat (env doc MOT lan luc khoi dong) va spy `broadcaster.sendAudioFrame`. */
async function loadBridge(env: { rate8k: boolean; stereo: boolean }) {
  vi.resetModules();
  if (env.rate8k) process.env.CCR_CALL_RATE8K = '1'; else delete process.env.CCR_CALL_RATE8K;
  if (env.stereo) delete process.env.CCR_CALL_STEREO; else process.env.CCR_CALL_STEREO = '0';
  const dm = await import('./deviceManager.js');
  const bridge = await import('./callBridge.js');
  const sent: Buffer[] = [];
  vi.spyOn(dm.broadcaster, 'sendAudioFrame').mockImplementation((_dev: string, pcm: Buffer) => { sent.push(Buffer.from(pcm)); return true; });
  vi.spyOn(console, 'log').mockImplementation(() => { });
  return { bridge, sent };
}

/** POST /call/test/play qua handler THAT (khong mo cong). */
function play(bridge: { handleCallApi: (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => boolean }, file: string, extra = ''): Promise<{ code: number; body: any }> {
  const req = { socket: { remoteAddress: '127.0.0.1' }, method: 'POST', headers: {} } as unknown as http.IncomingMessage;
  return new Promise((ok) => {
    let status = 0;
    const res = {
      writeHead: (code: number) => { status = code; },
      end: (body: string) => { ok({ code: status, body: JSON.parse(body) }); },
    } as unknown as http.ServerResponse;
    bridge.handleCallApi(req, res, new URL(`http://x/call/test/play?dev=${DEV}&file=${file}${extra}`));
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rwv-rate8k-'));
  wavPcm = makeWav(5).subarray(44);                        // 5 khung = 100 ms
  fs.writeFileSync(path.join(dir, 'short.wav'), makeWav(5));
  fs.writeFileSync(path.join(dir, 'one.wav'), makeWav(1));
  process.env.CCR_TEST_AUDIO_DIR = dir;
  screens.list = [{ id: DEV, w: 1024, h: 600, cam: true, sd: false, spk: true, mic: true }];
});

afterEach(() => {
  delete process.env.CCR_TEST_AUDIO_DIR;
  delete process.env.CCR_CALL_RATE8K;
  delete process.env.CCR_CALL_STEREO;
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('CCR_CALL_RATE8K=1 — duong xuong loa man phat 8 kHz', () => {
  it('8 kHz MONO: goi 320 B/20 ms, 16 KB/s, PCM = downsample2(tep mau)', async () => {
    const { bridge, sent } = await loadBridge({ rate8k: true, stereo: false });
    const r = await play(bridge, 'one.wav', '&agc=0&eq=0');
    expect(r.code).toBe(200);
    expect(r.body.frames).toBe(1);
    expect(r.body.dropped).toBe(0);
    expect(r.body.rate8k).toBe(true);
    expect(r.body.rate).toBe(8000);
    expect(r.body.stereo).toBe(false);
    expect(r.body.frameBytes).toBe(320);                              // frameBytesFor(8000) = 320
    expect(sent.length).toBe(1);
    expect(sent[0].length).toBe(320);                                 // 640 B mono 16 kHz -> 320 B mono 8 kHz
    expect(sent[0].equals(downsample2(wavPcm.subarray(0, FRAME_BYTES), newDownsample2State()))).toBe(true);
  });

  it('8 kHz MONO: 5 khung -> 5 goi 320 B va ghep lai = loc MOT LAN ca tep (trang thai loc lien tuc)', async () => {
    const { bridge, sent } = await loadBridge({ rate8k: true, stereo: false });
    const r = await play(bridge, 'short.wav', '&agc=0&eq=0');
    expect(r.body.frames).toBe(5);
    expect(sent.map((b) => b.length)).toEqual([320, 320, 320, 320, 320]);
    const wire = Buffer.concat(sent);
    expect(wire.length).toBe(wavPcm.length / 2);                      // 3200 B = 5 x 20 ms o 8 kHz mono
    expect(wire.equals(downsample2(wavPcm, newDownsample2State()))).toBe(true);   // KHONG co bien gia giua cac khung
    expect(r.body.ms).toBeGreaterThanOrEqual(80);                     // van 20 ms/goi (khong bun no)
  });

  it('8 kHz + STEREO: goi 640 B/20 ms (L = R), moi kenh = downsample2(tep mau)', async () => {
    const { bridge, sent } = await loadBridge({ rate8k: true, stereo: true });
    const r = await play(bridge, 'one.wav', '&agc=0&eq=0');
    expect(r.body.rate8k).toBe(true);
    expect(r.body.stereo).toBe(true);
    expect(r.body.frameBytes).toBe(640);                             // frameBytesFor(8000, 2) = 640
    expect(sent.length).toBe(1);
    expect(sent[0].length).toBe(640);
    expect(stereoToMono(sent[0]).equals(downsample2(wavPcm.subarray(0, FRAME_BYTES), newDownsample2State()))).toBe(true);
    for (let i = 0; i < 160; i++) expect(sent[0].readInt16LE(i * 4)).toBe(sent[0].readInt16LE(i * 4 + 2));   // L = R
  });

  it('mac dinh (khong co env) van 16 kHz: 1280 B stereo / 640 B mono — khong doi hanh vi cu', async () => {
    const on = await loadBridge({ rate8k: false, stereo: true });
    const r1 = await play(on.bridge, 'one.wav', '&agc=0&eq=0');
    expect(r1.body.rate8k).toBe(false);
    expect(r1.body.rate).toBe(16000);
    expect(r1.body.frameBytes).toBe(1280);
    expect(on.sent[0].length).toBe(1280);                                              // 320 khung mau x 2 kenh x 2 B
    expect(stereoToMono(on.sent[0]).equals(wavPcm.subarray(0, FRAME_BYTES))).toBe(true);   // kenh trai = mono 16 kHz

    const off = await loadBridge({ rate8k: false, stereo: false });
    const r2 = await play(off.bridge, 'one.wav', '&agc=0&eq=0');
    expect(r2.body.rate8k).toBe(false);
    expect(r2.body.frameBytes).toBe(640);
    expect(off.sent[0].length).toBe(640);
    expect(off.sent[0].equals(wavPcm.subarray(0, FRAME_BYTES))).toBe(true);             // mono 16 kHz: nguyen byte
  });

  it('dong log khoi dong cua callBridge: `[audio] rate=8k frame=320B/20ms` khi bat (mono)', async () => {
    vi.resetModules();
    process.env.CCR_CALL_RATE8K = '1';
    process.env.CCR_CALL_STEREO = '0';
    delete process.env.VITEST;                                          // cho phep in dong log khoi dong
    const log = vi.spyOn(console, 'log').mockImplementation(() => { });
    try {
      await import('./callBridge.js');
      const lines = log.mock.calls.map((c) => String(c[0]));
      expect(lines).toContain('[audio] rate=8k frame=320B/20ms');
      expect(lines).toContain('[audio] stereo=off frame=640B/20ms');     // dong log cua src/audioStereo.ts
    } finally {
      process.env.VITEST = 'true';
      delete process.env.CCR_CALL_RATE8K;
      delete process.env.CCR_CALL_STEREO;
    }
  });
});
