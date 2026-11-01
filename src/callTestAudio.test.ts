// SPDX-License-Identifier: Apache-2.0
//
// Copyright (c) 2026 minhquanghp86
// Licensed under the Apache License, Version 2.0 (see LICENSE).

// (05/12/2026) API BO PHAT THU NGHIEM — kiem tra `GET /call/test/files` va `POST /call/test/play` qua HTTP handler THAT
// (khong mo cong: goi thang `handleCallApi` voi req/res gia), tren mot tep WAV ngan sinh trong thu muc tam:
//   - tra dung so lieu {ok, dev, file, frames, dropped, ms} + dong log `[test] play ...`;
//   - frames/dropped phan anh DUNG viec gui duoc hay khong (khong co socket -> dropped = so khung);
//   - nhip 20 ms: 5 khung phai mat >= 80 ms (khong bun no);
//   - `agc=0&eq=0` -> PCM xuong loa Y NGUYEN BYTE tep mau (duong bypass);
//   - chan sai: man la, tep la, goi tu ngoai mang.
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

import { broadcaster } from './deviceManager.js';
import { handleCallApi } from './callBridge.js';
import { FRAME_BYTES } from './testAudio.js';
// (06/12/2026) Nhanh xuong man gui STEREO 1280 B/goi (L = R) — xem src/audioStereo.ts.
import { MONO_FRAME_BYTES, STEREO_FRAME_BYTES, stereoToMono } from './audioStereo.js';

const DEV = 'p4-bep';

const rms = (pcm: Buffer): number => {
  const n = pcm.length / 2;
  let s = 0;
  for (let i = 0; i < n; i++) { const v = pcm.readInt16LE(i * 2) / 32768; s += v * v; }
  return Math.sqrt(s / n);
};

/** WAV 16 kHz mono s16le tu `frames` khung 20 ms, song sin 1 kHz dinh -12 dBFS. */
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

/** req/res gia: chi nhung gi `handleCallApi` dung (`socket.remoteAddress`, `method`, `headers`). */
function call(method: string, url: string, from = '127.0.0.1'): Promise<{ code: number; body: any }> {
  const req = { socket: { remoteAddress: from }, method, headers: {} } as unknown as http.IncomingMessage;
  return new Promise((ok) => {
    const res = {
      writeHead: (code: number) => { status = code; },
      end: (body: string) => { ok({ code: status, body: JSON.parse(body) }); },
    } as unknown as http.ServerResponse;
    let status = 0;
    if (!handleCallApi(req, res, new URL(`http://x${url}`))) ok({ code: 0, body: null });
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rwv-test-audio-'));
  wavPcm = makeWav(5).subarray(44);                        // 5 khung = 100 ms
  fs.writeFileSync(path.join(dir, 'short.wav'), makeWav(5));
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'khong phai wav');
  process.env.CCR_TEST_AUDIO_DIR = dir;
  screens.list = [{ id: DEV, w: 1024, h: 600, cam: true, sd: false, spk: true, mic: true }];
});

afterEach(() => {
  delete process.env.CCR_TEST_AUDIO_DIR;
  delete process.env.CCR_CALL_STEREO;          // (06/12/2026) test A/B khong duoc ro ri sang test khac
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('/call/test/files', () => {
  it('liet ke tep .wav trong thu muc mau (bo qua tep khac)', async () => {
    const r = await call('GET', '/call/test/files');
    expect(r.code).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.files).toEqual([{ name: 'short.wav', bytes: 5 * FRAME_BYTES + 44, ms: 100 }]);
  });

  it('tu choi request tu ngoai mang (khong phai loopback/LAN)', async () => {
    const r = await call('GET', '/call/test/files', '203.0.113.9');
    expect(r.code).toBe(403);
  });
});

describe('POST /call/test/play', () => {
  it('khong co socket nao (man chua ket noi WS) -> frames 0, dropped = so khung, van tra 200', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => { });
    const r = await call('POST', `/call/test/play?dev=${DEV}&file=short.wav`);
    expect(r.code).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.dev).toBe(DEV);
    expect(r.body.file).toBe('short.wav');
    expect(r.body.frames).toBe(0);
    expect(r.body.dropped).toBe(5);                        // khong gui duoc khung nao
    expect(r.body.ms).toBeGreaterThanOrEqual(80);          // 5 khung x 20 ms = 100 ms (nhip that, khong bun no)
    // (06/12/2026) So lieu tra ve noi RO dinh dang goi da gui: stereo 1280 B/20 ms (truoc day 640 B mono).
    expect(r.body.stereo).toBe(true);
    expect(r.body.frameBytes).toBe(STEREO_FRAME_BYTES);
    const line = log.mock.calls.map((c) => String(c[0])).find((s) => s.startsWith('[test] play'));
    expect(line).toBe(`[test] play dev=${DEV} file=short.wav frames=0 dropped=5 loop=1 agc=1 eq=1 gain=0 stereo=1 frame=1280 ms=${r.body.ms} late=0`);
  });

  it('TICH HOP: 1 khung mono 640 B -> goi gui xuong man 1280 B (L = R), nhip 20 ms', async () => {
    const got: Buffer[] = [];
    vi.spyOn(broadcaster, 'sendAudioFrame').mockImplementation((_dev: string, pcm: Buffer) => { got.push(Buffer.from(pcm)); return true; });
    vi.spyOn(console, 'log').mockImplementation(() => { });
    // Moi khung cua tep mau la 640 B mono 20 ms (agc=0&eq=0 -> duong di y nguyen byte, de so sanh chinh xac).
    fs.writeFileSync(path.join(dir, 'one.wav'), makeWav(1));
    const r = await call('POST', `/call/test/play?dev=${DEV}&file=one.wav&agc=0&eq=0`);
    expect(r.code).toBe(200);
    expect(r.body.frames).toBe(1);
    expect(got.length).toBe(1);
    expect(got[0].length).toBe(STEREO_FRAME_BYTES);                    // 640 mono -> 1280 stereo
    expect(got[0].length).toBe(MONO_FRAME_BYTES * 2);
    expect(stereoToMono(got[0]).equals(wavPcm.subarray(0, FRAME_BYTES))).toBe(true);   // kenh trai = mono goc
    for (let i = 0; i < 320; i++) expect(got[0].readInt16LE(i * 4)).toBe(got[0].readInt16LE(i * 4 + 2));  // L = R
  });

  it('gui duoc: frames = so khung, moi goi 1280 byte (20 ms stereo), nhip 20 ms (AGC/EQ mac dinh)', async () => {
    const sent: number[] = [];
    vi.spyOn(broadcaster, 'sendAudioFrame').mockImplementation((_dev: string, pcm: Buffer) => { sent.push(pcm.length); return true; });
    vi.spyOn(console, 'log').mockImplementation(() => { });
    const r = await call('POST', `/call/test/play?dev=${DEV}&file=short.wav`);
    expect(r.code).toBe(200);
    expect(r.body.frames).toBe(5);
    expect(r.body.dropped).toBe(0);
    expect(sent).toEqual(Array(5).fill(STEREO_FRAME_BYTES));           // 1280 B/goi, MOT goi moi 20 ms
    expect(r.body.ms).toBeGreaterThanOrEqual(80);
    expect(r.body.stereo).toBe(true);
    expect(r.body.frameBytes).toBe(1280);
  });

  it('file= thieu .wav -> van phat duoc: {file:"short"} = {file:"short.wav"}', async () => {
    const sent: number[] = [];
    vi.spyOn(broadcaster, 'sendAudioFrame').mockImplementation((_dev: string, pcm: Buffer) => { sent.push(pcm.length); return true; });
    const log = vi.spyOn(console, 'log').mockImplementation(() => { });
    const short = await call('POST', `/call/test/play?dev=${DEV}&file=short`);
    expect(short.code).toBe(200);
    expect(short.body.ok).toBe(true);
    expect(short.body.file).toBe('short.wav');                 // ten da chuan hoa (them .wav)
    expect(short.body.frames).toBe(5);
    expect(sent).toEqual(Array(5).fill(STEREO_FRAME_BYTES));
    expect(log.mock.calls.map((c) => String(c[0])).find((s) => s.startsWith('[test] play'))).toContain('file=short.wav');
  });

  it('loop=2 -> 10 khung, ms >= 180 (khong bun no)', async () => {
    const sent: number[] = [];
    vi.spyOn(broadcaster, 'sendAudioFrame').mockImplementation((_dev: string, pcm: Buffer) => { sent.push(pcm.length); return true; });
    vi.spyOn(console, 'log').mockImplementation(() => { });
    const r = await call('POST', `/call/test/play?dev=${DEV}&file=short.wav&loop=2&agc=0&eq=0`);
    expect(r.body.frames).toBe(10);
    expect(r.body.loop).toBe(2);
    expect(r.body.agc).toBe(false);
    expect(r.body.eq).toBe(false);
    expect(sent.length).toBe(10);
    expect(sent.every((n) => n === STEREO_FRAME_BYTES)).toBe(true);    // 10 goi, khong goi nao bi chia doi
    expect(r.body.ms).toBeGreaterThanOrEqual(180);
  });

  it('agc=0&eq=0 -> PCM xuong loa Y NGUYEN BYTE tep mau (sau khi bo kenh phai = mono goc)', async () => {
    const got: Buffer[] = [];
    vi.spyOn(broadcaster, 'sendAudioFrame').mockImplementation((_dev: string, pcm: Buffer) => { got.push(Buffer.from(pcm)); return true; });
    vi.spyOn(console, 'log').mockImplementation(() => { });
    await call('POST', `/call/test/play?dev=${DEV}&file=short.wav&agc=0&eq=0`);
    const wire = Buffer.concat(got);                       // 5 goi x 1280 byte stereo = 6400 byte
    expect(wire.length).toBe(wavPcm.length * 2);
    const mono = stereoToMono(wire);                       // lay kenh trai -> phai trung byte voi tep mau
    expect(mono.equals(wavPcm)).toBe(true);
    expect(rms(mono)).toBeGreaterThan(0.1);                // co tieng that, khong phai im lang
    expect(rms(wire)).toBeCloseTo(rms(mono), 6);           // nhan doi kenh KHONG doi muc (dBFS giu y nghia)
  });

  it('agc=1 -> PCM khac tep mau (co xu ly) nhung KHONG im lang, do dai goi = 2x mono', async () => {
    const got: Buffer[] = [];
    vi.spyOn(broadcaster, 'sendAudioFrame').mockImplementation((_dev: string, pcm: Buffer) => { got.push(Buffer.from(pcm)); return true; });
    vi.spyOn(console, 'log').mockImplementation(() => { });
    await call('POST', `/call/test/play?dev=${DEV}&file=short.wav&agc=1&eq=0`);
    const wire = Buffer.concat(got);
    expect(wire.length).toBe(wavPcm.length * 2);           // stereo: 2 byte/mau/kenh
    const mono = stereoToMono(wire);
    expect(mono.length).toBe(wavPcm.length);
    expect(mono.equals(wavPcm)).toBe(false);               // AGC co tac dung
    expect(rms(mono)).toBeGreaterThan(0.1);
  });

  it('gain=-6 dB -> muc ra nho hon ~2 lan', async () => {
    const got: Buffer[] = [];
    vi.spyOn(broadcaster, 'sendAudioFrame').mockImplementation((_dev: string, pcm: Buffer) => { got.push(Buffer.from(pcm)); return true; });
    vi.spyOn(console, 'log').mockImplementation(() => { });
    await call('POST', `/call/test/play?dev=${DEV}&file=short.wav&agc=0&eq=0&gain=-6`);
    const ratio = rms(stereoToMono(Buffer.concat(got))) / rms(wavPcm);
    expect(ratio).toBeCloseTo(0.5, 1);
  });

  it('A/B CCR_CALL_STEREO=0 -> gui MONO 640 B/goi nhu cu (van 20 ms/goi)', async () => {
    vi.resetModules();                                     // doc env MOT lan luc khoi dong (nhu tien trinh that)
    process.env.CCR_CALL_STEREO = '0';
    const dm = await import('./deviceManager.js');
    const off = await import('./callBridge.js');
    const sent: number[] = [];
    const spy = vi.spyOn(dm.broadcaster, 'sendAudioFrame').mockImplementation((_dev: string, pcm: Buffer) => { sent.push(pcm.length); return true; });
    vi.spyOn(console, 'log').mockImplementation(() => { });
    const r = await new Promise<{ code: number; body: any }>((ok) => {
      const req = { socket: { remoteAddress: '127.0.0.1' }, method: 'POST', headers: {} } as unknown as http.IncomingMessage;
      const res = {
        writeHead: (code: number) => { status = code; },
        end: (body: string) => { ok({ code: status, body: JSON.parse(body) }); },
      } as unknown as http.ServerResponse;
      let status = 0;
      off.handleCallApi(req, res, new URL(`http://x/call/test/play?dev=${DEV}&file=short.wav&agc=0&eq=0`));
    });
    expect(r.code).toBe(200);
    expect(r.body.frames).toBe(5);
    expect(r.body.stereo).toBe(false);
    expect(r.body.frameBytes).toBe(MONO_FRAME_BYTES);
    expect(sent).toEqual(Array(5).fill(MONO_FRAME_BYTES));            // 640 B/goi nhu truoc 06/12/2026
    expect(spy).toHaveBeenCalled();
    delete process.env.CCR_CALL_STEREO;
  });

  it('man khong goi duoc -> 404; tep la -> 400; sai method -> 405', async () => {
    screens.list = [];
    expect((await call('POST', `/call/test/play?dev=${DEV}&file=short.wav`)).code).toBe(404);
    screens.list = [{ id: DEV, w: 1024, h: 600, cam: true, sd: false, spk: true, mic: true }];
    const bad = await call('POST', `/call/test/play?dev=${DEV}&file=../etc/passwd.wav`);
    expect(bad.code).toBe(400);
    expect(bad.body.error).toMatch(/khong hop le/);
    const missing = await call('POST', `/call/test/play?dev=${DEV}&file=khong-co.wav`);
    expect(missing.code).toBe(400);
    expect(missing.body.error).toMatch(/khong co tep/);
    expect(missing.body.error).toMatch(/da tim: /);          // thong diep chi ra thu muc da tim (chan doan image)
    expect((await call('GET', `/call/test/play?dev=${DEV}`)).code).toBe(405);
  });

  it('goi tu ngoai mang -> 403 (khong bom duoc tieng vao nha tu Internet)', async () => {
    const r = await call('POST', `/call/test/play?dev=${DEV}&file=short.wav`, '203.0.113.9');
    expect(r.code).toBe(403);
  });
});
