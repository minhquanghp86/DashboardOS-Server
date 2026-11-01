// SPDX-License-Identifier: Apache-2.0
//
// Copyright (c) 2026 minhquanghp86
// Licensed under the Apache License, Version 2.0 (see LICENSE).

// (09/12/2026) MOT NGUON DUY NHAT cho tieng nguoi tren moi man — kiem tra bang so lieu, khong bang suy luan.
//
// Boi canh do duoc tren P4 that (ban 2.9.321, mixer 1 kenh, 16 kHz mono):
//   `POST /call/test/play` -> 1617 goi / 30 s (le ra 1500) va 49 KB/s (le ra 32 KB/s) => CO THEM MOT DUONG GUI THU HAI.
// Duong thu hai la src/audioCapture.ts `drainTick()`: tieng Chrome/PulseAudio (1280 B/40 ms = 32 KB/s) gui THANG cho
// moi man dang ky, chi bi chan boi `callHold` — ma `callHold` chi duoc dat trong `startCall()`, con phep do phat tep mau
// thi khong mo call record. Vay la cung mot loa nhan 2 luong.
//
// Cac bai duoi day khang dinh luat moi (src/audioOut.ts):
//   (a) MOT khung PCM vao -> dung MOT goi ra (khong 2);
//   (b) 50 khung trong 1 s -> 50 goi, 32.000 byte (32 KB/s) — dung nhip 20 ms;
//   (c) `POST /call/test/play` 10 s -> 500 goi, 320.000 byte = 32 KB/s (dung bai do cua thiet bi that);
//   (d) KHONG con nguon thu hai: tieng Chrome bi tu choi khi man dang phat tep mau / dang trong cuoc goi;
//   (e) mic cua mot man KHONG BAO GIO duoc gui ve chinh loa cua no (self-link -> khong echo);
//   (f) dong log `[audiosrc] speaker=<n> device=<n> loop=<n> web=<n> kb/s=<...>` co du bon nguon.
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

const DEV = 'p4-bep';
/** 20 ms PCM s16le MONO 16 kHz = 640 byte (dinh dang tep mau va cua trang goi). */
const MONO = 640;
/** 40 ms cua nguon Chrome/PulseAudio (src/audioCapture.ts `FRAME_BYTES`) = 1280 byte. */
const CAPTURE = 1280;

const sleep = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));

let dir = '';

/** WAV 16 kHz mono s16le tu `frames` khung 20 ms, song sin 1 kHz dinh -12 dBFS (giong src/callRate8k.test.ts). */
function makeWav(frames: number): Buffer {
  const n = frames * (MONO / 2);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 1000 * i) / 16000) * 8200), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1'); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8, 'latin1');
  h.write('fmt ', 12, 'latin1'); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36, 'latin1'); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

type Mods = {
  bridge: typeof import('./callBridge.js');
  capture: typeof import('./audioCapture.js');
  out: typeof import('./audioOut.js');
  /** Byte cua tung goi THAT SU giao cho socket cua man (spy `broadcaster.sendAudioFrame`). */
  sent: Buffer[];
};

/**
 * Nap lai toan bo chuoi am thanh trong CAU HINH CUA PHEP DO THAT: `CCR_CALL_STEREO=0`, khong ha mau
 * => mot goi 20 ms = 640 byte mono 16 kHz, 50 goi/s = 32.000 B/s = 32 KB/s.
 */
async function load(): Promise<Mods> {
  vi.resetModules();
  process.env.CCR_CALL_STEREO = '0';
  delete process.env.CCR_CALL_RATE8K;
  const dm = await import('./deviceManager.js');
  const bridge = await import('./callBridge.js');
  const capture = await import('./audioCapture.js');
  const out = await import('./audioOut.js');
  const sent: Buffer[] = [];
  vi.spyOn(dm.broadcaster, 'sendAudioFrame').mockImplementation((_dev: string, pcm: Buffer) => {
    sent.push(Buffer.from(pcm));
    return true;
  });
  vi.spyOn(console, 'log').mockImplementation(() => { });
  vi.spyOn(console, 'warn').mockImplementation(() => { });
  out.resetAudioSrc();
  return { bridge, capture, out, sent };
}

/** POST /call/test/play qua handler THAT (khong mo cong) — xem src/callTestAudio.test.ts. */
function play(bridge: { handleCallApi: (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => boolean },
  file: string, extra = ''): Promise<{ code: number; body: any }> {
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rwv-audiosrc-'));
  fs.writeFileSync(path.join(dir, 'short.wav'), makeWav(5));        // 5 khung = 100 ms
  fs.writeFileSync(path.join(dir, 'one.wav'), makeWav(1));          // 1 khung = 20 ms
  fs.writeFileSync(path.join(dir, 'ten.wav'), makeWav(500));        // 10 s = 500 khung (bai do cua thiet bi that)
  fs.writeFileSync(path.join(dir, 'sec.wav'), makeWav(50));         // 1 s = 50 khung (bai (d): cua so ngan)
  process.env.CCR_TEST_AUDIO_DIR = dir;
  screens.list = [{ id: DEV, w: 1024, h: 600, cam: true, sd: false, spk: true, mic: true }];
});

afterEach(() => {
  delete process.env.CCR_TEST_AUDIO_DIR;
  delete process.env.CCR_CALL_STEREO;
  delete process.env.CCR_CALL_RATE8K;
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('(f) dong log [audiosrc] — bon nguon + KB/s', () => {
  it('dem dung tung nguon va tu choi nguon `web` khi man dang giu loa', async () => {
    const { out, sent } = await load();
    expect(out.sendPanelAudio(DEV, Buffer.alloc(MONO, 1), 'speaker')).toBe(true);
    expect(out.sendPanelAudio(DEV, Buffer.alloc(MONO, 1), 'speaker')).toBe(true);
    expect(out.sendPanelAudio(DEV, Buffer.alloc(MONO, 1), 'device')).toBe(true);
    expect(out.sendPanelAudio(DEV, Buffer.alloc(MONO, 1), 'loop')).toBe(true);
    expect(sent.length).toBe(4);

    out.holdVoice(DEV);                                          // man dang co tieng nguoi
    expect(out.sendPanelAudio(DEV, Buffer.alloc(CAPTURE, 2), 'web')).toBe(false);
    expect(sent.length).toBe(4);                                 // tieng Chrome KHONG duoc gui

    const line = out.audioSrcLine();
    expect(line).toMatch(/^\[audiosrc\] speaker=2 device=1 loop=1 web=0 kb\/s=\d+\.\d+$/);
    const st = out.audioSrcStats();
    expect(st.bytes).toBe(4 * MONO);
    expect(st.blocked).toBe(1);

    out.releaseVoice(DEV);                                       // tra loa lai -> tieng Chrome di duoc
    expect(out.sendPanelAudio(DEV, Buffer.alloc(CAPTURE, 2), 'web')).toBe(true);
    expect(sent[sent.length - 1].length).toBe(CAPTURE);
    expect(out.audioSrcStats().web).toBe(1);
  });
});

describe('(a) MOT khung PCM vao -> dung MOT goi ra', () => {
  it('sendToSpeaker: 1 khung 640 B -> 1 goi 640 B (khong 2)', async () => {
    const { bridge, sent } = await load();
    bridge.framePacer.forget(DEV);
    bridge.sendToSpeaker(DEV, Buffer.alloc(MONO, 7), { agc: false, eq: false });
    await sleep(80);
    expect(sent.length).toBe(1);
    expect(sent[0].length).toBe(MONO);
    expect(bridge.framePacer.stats(DEV).dropped).toBe(0);
  });

  it('sendToDevice: 1 khung 640 B -> 1 goi (truoc day gui NGAY va tu chia khung lan nua)', async () => {
    const { bridge, sent } = await load();
    bridge.framePacer.forget(DEV);
    bridge.sendToDevice(DEV, Buffer.alloc(MONO, 3));             // PCM cua trang thu /call/ws
    await sleep(80);
    expect(sent.length).toBe(1);
    expect(sent[0].length).toBe(MONO);
  });
});

describe('(b) 50 khung trong 1 s -> 50 goi / 32.000 byte', () => {
  it('nhip 20 ms giu dung 50 goi/s, moi goi 640 B', async () => {
    const { bridge, sent } = await load();
    bridge.framePacer.forget(DEV);
    const t0 = Date.now();
    for (let i = 0; i < 50; i++) {
      bridge.sendToSpeaker(DEV, Buffer.alloc(MONO, 1), { agc: false, eq: false });
      if (i < 49) await sleep(20);
    }
    const ms = Date.now() - t0;
    await sleep(80);                                             // cho bo dem nhip xa not khung cuoi
    const bytes = sent.reduce((n, b) => n + b.length, 0);

    expect(sent.every((b) => b.length === MONO)).toBe(true);
    expect(sent.length).toBeGreaterThanOrEqual(49);
    expect(sent.length).toBeLessThanOrEqual(51);
    expect(bytes).toBe(sent.length * MONO);                      // khong co goi nao bi chia doi
    expect(bytes / (ms / 1000)).toBeGreaterThan(30_000);         // ~32.000 B/s = 32 KB/s
    expect(bytes / (ms / 1000)).toBeLessThan(34_000);
    expect(bridge.framePacer.stats(DEV).dropped).toBe(0);
  });
});

describe('(c) POST /call/test/play 10 s -> 32 KB/s', () => {
  it('500 goi, 320.000 byte, ~32 KB/s (bai do dung tren P4)', async () => {
    const { bridge, sent } = await load();
    const r = await play(bridge, 'ten.wav', '&agc=0&eq=0');
    expect(r.code).toBe(200);
    expect(r.body.frames).toBe(500);
    expect(r.body.dropped).toBe(0);
    expect(r.body.frameBytes).toBe(MONO);                        // 16 kHz mono: 640 B/20 ms
    expect(sent.length).toBe(500);
    expect(sent.every((b) => b.length === MONO)).toBe(true);
    const bytes = sent.reduce((n, b) => n + b.length, 0);
    expect(bytes).toBe(500 * MONO);                              // 320.000 byte = 32 KB/s trong 10 s
    if (r.body.ms > 9000) {                                      // chi kiem toc do khi may chay kip 10 s
      expect(bytes / (r.body.ms / 1000)).toBeGreaterThan(28_000);
      expect(bytes / (r.body.ms / 1000)).toBeLessThan(34_000);
    }
  }, 30_000);
});

describe('(d) KHONG con nguon gui thu hai', () => {
  it('tieng Chrome (src/audioCapture.ts) bi TU CHOI khi man dang phat tep mau', async () => {
    const m = await load();
    const results: boolean[] = [];
    // Nguon thu hai bom dung nhu parec/PulseAudio: mot khung 1280 B moi 40 ms (drainTick cua audioCapture).
    const iv = setInterval(() => results.push(m.capture.sendCapturedFrame(DEV, Buffer.alloc(CAPTURE, 5))), 10);
    const r = await play(m.bridge, 'sec.wav', '&agc=0&eq=0');
    clearInterval(iv);
    await sleep(80);

    expect(r.code).toBe(200);
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((v) => v === false)).toBe(true);         // KHONG gui duoc khung nao cua tieng Chrome
    expect(m.sent.every((b) => b.length === MONO)).toBe(true);    // khong co goi 1280 B nao tren loa
    expect(m.sent.length).toBe(50);                               // dung so khung cua tep mau, khong hon

    const st = m.out.audioSrcStats();
    expect(st.web).toBe(0);                                       // nguon thu hai = 0 goi
    expect(st.speaker).toBe(50);                                  // chi con duong chinh
    expect(st.blocked).toBeGreaterThan(0);                        // va so lan bi chan dem duoc
    expect(st.bytes).toBe(50 * MONO);

    // Phep thu tren la THAT (khong phai gate ket kin): het phep do -> loa duoc tra lai, tieng Chrome di duoc.
    expect(m.capture.sendCapturedFrame(DEV, Buffer.alloc(CAPTURE, 5))).toBe(true);
    expect(m.sent[m.sent.length - 1].length).toBe(CAPTURE);
  }, 10_000);

  it('trong cuoc goi: chi duong speaker, tieng Chrome van bi chan (callHold)', async () => {
    const m = await load();
    m.bridge.startCall(DEV);
    m.bridge.sendToSpeaker(DEV, Buffer.alloc(MONO, 4), { agc: false, eq: false });
    expect(m.capture.sendCapturedFrame(DEV, Buffer.alloc(CAPTURE, 5))).toBe(false);
    await sleep(60);
    expect(m.sent.length).toBe(1);
    expect(m.out.voiceHeld(DEV)).toBe(true);
    m.bridge.endCall(DEV);
    expect(m.out.voiceHeld(DEV)).toBe(false);                     // het cuoc goi -> tra loa lai
  });
});

describe('(e) mic cua mot man khong bao gio gui ve chinh loa cua no', () => {
  it('self-link -> khong echo; link that -> gui cho dau kia dung 1 goi', async () => {
    const m = await load();
    const A = 'p4-a', B = 'p4-b';
    expect(m.bridge.startCall(A)).not.toBeNull();
    expect(m.bridge.startCall(B)).not.toBeNull();
    const mic = Buffer.concat([Buffer.from([0x03, 0x01, 0x00, 0x00]), Buffer.alloc(MONO, 9)]);

    m.bridge.linkCalls(A, A);                                     // du lieu hong: man noi voi chinh no
    m.bridge.onMicFrame(A, mic);
    await sleep(60);
    expect(m.sent.length).toBe(0);                                // khong echo ve chinh A

    m.bridge.linkCalls(A, B);                                     // lien ket that
    m.bridge.onMicFrame(A, mic);
    await sleep(60);
    expect(m.sent.length).toBe(1);                                // chi mot goi, cho B
    expect(m.sent[0].length).toBe(MONO);
    m.bridge.endCall(A);
    m.bridge.endCall(B);
  });
});
