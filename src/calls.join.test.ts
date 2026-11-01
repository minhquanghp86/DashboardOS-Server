// SPDX-License-Identifier: Apache-2.0
//
// Copyright (c) 2026 minhquanghp86
// Licensed under the Apache License, Version 2.0 (see LICENSE).

// (GD3) DIEN THOAI VAO CUOC GOI BANG TRINH DUYET — `call-web.html?call=<id>` sau khi bam "Nghe":
// app da POST /app/answer (cuoc goi active) roi mo trang; trang mo WS /calls/web va gui {type:'join'}.
// Test nay chay HTTP + WebSocket THAT (khong gia lap socket) tren 127.0.0.1:
//   1. man P4 goi dien thoai -> /app/incoming thay cuoc goi
//   2. app nghe: POST /app/answer
//   3. trang goi cua dien thoai join -> {type:'joined', ok:true, peer:<man>, peerName}
//   4. TIENG 2 CHIEU: mic man -> khung 0x01 xuong WS cua trang; PCM trang gui len -> loa man (sendToDevice)
//   5. ket thuc: POST /app/hangup -> trang nhan 'ended', danh ba het ban
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
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

import { finish, handleCallsApi, handleCallsUpgrade, join, setCallHooks, state } from './calls.js';
import { onMicFrame } from './callBridge.js';
import { broadcaster } from './deviceManager.js';
import { handlePhoneApi } from './phones.js';
import { PhoneStore, phones, setPhoneStore } from './phoneStore.js';

const PANEL = 'p4-bep';
const PHONE = 'phone-abc123';
const st = (id: string) => state(id) as { state: string; from: string; to: string; fromName: string; toName: string; reason?: string; phone?: string };

/** Server that, giong src/index.ts: API /calls/* + /app/* va nang cap WS /calls/web. */
let server: http.Server | null = null;
let base = '';
const live: string[] = [];
const sockets: WebSocket[] = [];

async function boot(): Promise<void> {
  server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://x');
    if (handleCallsApi(req, res, url)) return;
    if (handlePhoneApi(req, res, url)) return;
    res.writeHead(404); res.end();
  });
  server.on('upgrade', (req, socket, head) => { if (!handleCallsUpgrade(req, socket, head)) socket.destroy(); });
  await new Promise<void>((ok) => server!.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

/** Trang goi trong trinh duyet: mo WS /calls/web, cho `hello`, tra ve {id, next()}. */
function openPage(name = 'Dashboard · điện thoại'): Promise<{ id: string; ws: WebSocket; next: () => Promise<any> }> {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/calls/web?name=` + encodeURIComponent(name));
  ws.binaryType = 'arraybuffer';
  sockets.push(ws);
  const queue: any[] = [];
  const waiters: ((m: any) => void)[] = [];
  ws.on('message', (d, bin) => {
    const m = bin ? { bin: Buffer.from(d as Buffer) } : JSON.parse(d.toString());
    const w = waiters.shift();
    if (w) w(m); else queue.push(m);
  });
  const next = () => new Promise<any>((ok, bad) => {
    const m = queue.shift();
    if (m) return void ok(m);
    const t = setTimeout(() => bad(new Error('khong nhan duoc tin nhan WS')), 3000);
    waiters.push((x) => { clearTimeout(t); ok(x); });
  });
  return next().then((hello) => ({ id: hello.id as string, ws, next }));
}

const post = (path: string) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  .then((r) => r.json().then((j) => ({ code: r.status, body: j as any })));

beforeEach(async () => {
  screens.list = [{ id: PANEL, w: 1280, h: 800, cam: true, sd: false, spk: true, mic: true }];
  setCallHooks({ name: (id) => (id === PANEL ? 'Màn hình bếp' : undefined) });
  setPhoneStore(new PhoneStore(null));
  phones.register({ id: PHONE, name: 'Pixel 8', url: 'https://hass.local/x/call-web.html' }, 1000);
  await boot();
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const id of live.splice(0)) finish(id, 'Hết');
  for (const s of sockets.splice(0)) { try { s.close(); } catch { /* */ } }
  const srv = server; server = null;
  if (srv) await new Promise<void>((ok) => srv.close(() => ok()));
});

describe('dien thoai vao cuoc goi bang call-web.html?call=', () => {
  it('join -> cuoc goi co dau cuoi web, ten nguoi goi dung, tieng di 2 chieu', async () => {
    const page = await openPage();
    // 1. man goi dien thoai
    const r = await post(`/calls/start?from=${PANEL}&to=${PHONE}`);
    expect(r.code).toBe(200);
    const callId = r.body.call as string;
    live.push(callId);
    expect(st(callId).state).toBe('ringing');

    // 2. app bam "Nghe" (truoc khi mo WebView)
    expect((await post(`/app/answer?phone=${PHONE}&call=${callId}`)).code).toBe(200);
    expect(st(callId).state).toBe('active');

    // Trang goi hoi /calls/state de biet ten nguoi goi truoc khi join.
    const s0 = await fetch(`${base}/calls/state?call=${callId}`).then((x) => x.json());
    expect(s0).toMatchObject({ state: 'active', from: PANEL, to: PHONE, fromName: 'Màn hình bếp' });

    // 3. join: dien thoai = ben nhan -> trang web thanh dau cuoi tieng cua may
    page.ws.send(JSON.stringify({ type: 'join', call: callId, phone: PHONE }));
    const joined = await page.next();
    expect(joined).toMatchObject({ type: 'joined', ok: true, call: callId, peer: PANEL, peerName: 'Màn hình bếp' });

    const s1 = st(callId);
    expect(s1.state).toBe('active');
    expect(s1.to).toBe(page.id);          // c.to = phien web cua trang goi
    expect(s1.phone).toBe(PHONE);         // van biet may nao dang trong cuoc goi -> ban
    expect((await fetch(`${base}/calls/contacts?self=web-khac`).then((x) => x.json()))
      .find((c: { id: string }) => c.id === PHONE)?.busy).toBe(true);

    // 4a. TIENG MAN -> DIEN THOAI: mic man (MicFrame [type][ver][seq u16le] + PCM) -> khung 0x01 tren WS trang
    const pcm = Buffer.alloc(640);
    for (let i = 0; i < 320; i++) pcm.writeInt16LE(i % 2 ? 1200 : -1200, i * 2);
    const mic = Buffer.concat([Buffer.from([0x03, 0x01, 0x00, 0x00]), pcm]);
    onMicFrame(PANEL, mic);
    const down = await page.next();
    expect(Buffer.isBuffer(down.bin)).toBe(true);
    expect(down.bin[0]).toBe(1);                                    // 0x01 = tieng
    expect(down.bin.subarray(1).equals(pcm)).toBe(true);

    // 4b. TIENG DIEN THOAI -> MAN: PCM trang gui len -> loa man (sendAudioFrame chia khung 20 ms).
    // (31/10/2026) Nhanh xuong MAN di qua AGC/limiter (`sendToSpeaker` -> src/audioAgc.ts) nen mau PCM KHONG con
    // giong byte voi dau vao, nhung KHONG duoc thanh im lang. Chieu web <-> web van nguyen byte (kiem o
    // src/calls.phonephone.test.ts).
    // (06/12/2026) MONO -> STEREO (L = R) SAU AGC: 320 byte mono vao -> 640 byte stereo ra (xem src/audioStereo.ts).
    // Do dai THOI GIAN khong doi (320 mau = 10 ms, van 1 khung), chi moi mau duoc lap sang 2 kenh.
    const spy = vi.spyOn(broadcaster, 'sendAudioFrame');
    const up = Buffer.alloc(1 + 320);
    up[0] = 1;
    for (let i = 0; i < 160; i++) up.writeInt16LE(700, 1 + i * 2);
    page.ws.send(up);
    await new Promise((ok) => setTimeout(ok, 120));
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls[0][0]).toBe(PANEL);
    const toPanel = spy.mock.calls[0][1];
    expect(toPanel.length).toBe(640);                                       // 320 mono -> 640 stereo (2 kenh)
    expect(toPanel.equals(Buffer.from(up.subarray(1)))).toBe(false);        // co AGC + stereo: khac byte tho
    expect(toPanel.some((b) => b !== 0)).toBe(true);                        // van co tieng, khong bi tat
    for (let i = 0; i < 160; i++) expect(toPanel.readInt16LE(i * 4)).toBe(toPanel.readInt16LE(i * 4 + 2));  // L = R

    // 5. "Kết thúc" tren dien thoai -> trang nhan 'ended', cuoc goi ket thuc
    expect((await post(`/app/hangup?phone=${PHONE}&call=${callId}`)).code).toBe(200);
    const end = await page.next();
    expect(end).toMatchObject({ type: 'ended', call: callId, reason: 'Đã kết thúc' });
    expect(st(callId)).toEqual({ state: 'ended', reason: 'Đã kết thúc' });
  });

  it('sai may / cuoc goi khong ton tai -> joined ok:false (trang hien loi, khong vao cuoc goi)', async () => {
    const page = await openPage();
    const r = await post(`/calls/start?from=${PANEL}&to=${PHONE}`);
    const callId = r.body.call as string;
    live.push(callId);

    page.ws.send(JSON.stringify({ type: 'join', call: callId, phone: 'phone-may-khac' }));
    expect((await page.next()).ok).toBe(false);

    page.ws.send(JSON.stringify({ type: 'join', call: 'khong-co', phone: PHONE }));
    expect((await page.next()).ok).toBe(false);
  });

  it('join khi cuoc goi con do chuong = nghe luon (app chua kip POST /app/answer)', async () => {
    const page = await openPage();
    const r = await post(`/calls/start?from=${PANEL}&to=${PHONE}`);
    const callId = r.body.call as string;
    live.push(callId);
    expect(st(callId).state).toBe('ringing');

    page.ws.send(JSON.stringify({ type: 'join', call: callId, phone: PHONE }));
    expect((await page.next()).ok).toBe(true);
    expect(st(callId).state).toBe('active');
  });

  it('join lai tu cung phien khong noi tieng lan 2, van ok', async () => {
    const page = await openPage();
    const r = await post(`/calls/start?from=${PANEL}&to=${PHONE}`);
    const callId = r.body.call as string;
    live.push(callId);
    await post(`/app/answer?phone=${PHONE}&call=${callId}`);

    page.ws.send(JSON.stringify({ type: 'join', call: callId, phone: PHONE }));
    expect((await page.next()).ok).toBe(true);
    page.ws.send(JSON.stringify({ type: 'join', call: callId, phone: PHONE }));
    const again = await page.next();
    expect(again.ok).toBe(true);
    // Chi MOT duong tieng: mot lan mic man -> dung mot khung 0x01 (khong nhan doi).
    const pcm = Buffer.alloc(640, 5);
    onMicFrame(PANEL, Buffer.concat([Buffer.from([3, 1, 0, 0]), pcm]));
    expect((await page.next()).bin.length).toBe(641);
  });

  it('/app/hangup tu choi khi sai may, va /app/decline van chay nhu cu', async () => {
    const r = await post(`/calls/start?from=${PANEL}&to=${PHONE}`);
    const callId = r.body.call as string;
    live.push(callId);
    expect((await post(`/app/hangup?phone=phone-khac&call=${callId}`)).code).toBe(409);
    expect(st(callId).state).toBe('ringing');
    expect((await post(`/app/decline?phone=${PHONE}&call=${callId}`)).code).toBe(200);
    expect(st(callId)).toEqual({ state: 'ended', reason: 'Từ chối' });
  });
});

describe('join() chan cac truong hop sai', () => {
  it('phien web khong ton tai -> loi ro rang', async () => {
    const r = await post(`/calls/start?from=${PANEL}&to=${PHONE}`);
    live.push(r.body.call as string);
    expect(join(r.body.call as string, 'web-khong-co', PHONE)).toMatchObject({ ok: false });
  });

  it('cuoc goi khong danh cho dien thoai (man <-> man) -> khong join duoc', async () => {
    screens.list = [...screens.list, { id: 'p4-khach', w: 1280, h: 800, cam: true, sd: false, spk: true, mic: true }];
    const page = await openPage();
    const r = await post(`/calls/start?from=${PANEL}&to=p4-khach`);
    live.push(r.body.call as string);
    page.ws.send(JSON.stringify({ type: 'join', call: r.body.call, phone: PHONE }));
    const j = await page.next();
    expect(j.ok).toBe(false);
    expect(j.error).toMatch(/không dành cho điện thoại/i);
  });
});
