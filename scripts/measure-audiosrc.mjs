#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Copyright (c) 2026 minhquanghp86
// Licensed under the Apache License, Version 2.0 (see LICENSE).

// (09/12/2026) DO "GUI TRUNG AUDIO" BANG BYTE THAT — khong can man P4.
//
// Vi sao co script nay: tren P4 (ban 2.9.321, mixer 1 kenh, 16 kHz mono) bai do `POST /call/test/play` ghi
//   1617 goi / 30 s (le ra 1500 = 50 goi/s) va 1.472.640 B / 30 s = 49 KB/s (le ra 32 KB/s)
// => CO THEM MOT DUONG GUI AUDIO THU HAI bom vao cung mot loa. Script nay dung lai dung tinh huong do tren LOOPBACK:
// mot client WebSocket GIA dong vai "man hinh" (nhan dung cac goi AudioFrame cua firmware), roi:
//   - bom tep mau qua DUNG duong that `playTestAudio()` (EQ -> AGC -> [8 kHz] -> [stereo] -> bo dem nhip -> socket);
//   - DONG THOI bom "tieng Chrome/PulseAudio" dung nhu src/audioCapture.ts (1280 B / 40 ms = 32 KB/s), qua hai che do:
//       --old  : goi THANG `broadcaster.sendAudioFrame()`  = HANH VI TRUOC KHI SUA (duong gui thu hai, khong bi chan)
//       (mac dinh): qua cong `audioCapture.sendCapturedFrame()` = `sendPanelAudio(..., 'web')` (bi chan khi man dang
//                   phat tep mau / dang trong cuoc goi) — xem src/audioOut.ts
// Ket qua in ra: so goi, so byte, KB/s, va cac dong `[audiosrc] speaker=... device=... loop=... web=... kb/s=...`
// do chinh server in ra moi 5 s. Chay sau khi da `npm run build`:
//
//   node scripts/measure-audiosrc.mjs            # sau khi sua: 50 goi/s, 32 KB/s, web=0
//   node scripts/measure-audiosrc.mjs --old      # truoc khi sua: ~75 goi/s, ~64 KB/s (gui trung)
//   node scripts/measure-audiosrc.mjs --file=speech-like.wav --loop=1
//
// LUU Y: day la do tren loopback (khong co Wi-Fi, khong co video chen kenh) nen no do dung phan SERVER quyet dinh —
// "mot man chi nhan mot duong tieng nguoi". Phan ring buffer cua loa P4 van phai do tren thiet bi that.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = (name) => path.join(ROOT, 'dist', name);

const argOf = (k, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : d;
};
const OLD = process.argv.includes('--old');
const FILE = argOf('file', 'tone-1k.wav');
const LOOP = Math.max(1, Number(argOf('loop', '1')));
const DEV = argOf('dev', 'fake-p4');
/** Nguon thu hai (src/audioCapture.ts): 40 ms/frame = 1280 B o 16 kHz mono. */
const CAPTURE_BYTES = 1280;
const CAPTURE_EVERY_MS = 40;

// Cau hinh cua phep do that: man 16 kHz MONO, mixer 1 kenh -> mot goi 20 ms = 640 B -> 32.000 B/s = 32 KB/s.
// (env doc MOT lan luc nap module, nen phai dat TRUOC khi import dist/.)
if (process.env.CCR_CALL_STEREO === undefined) process.env.CCR_CALL_STEREO = '0';
delete process.env.CCR_CALL_RATE8K;

const dm = await import(dist('deviceManager.js'));
const bridge = await import(dist('callBridge.js'));
const capture = await import(dist('audioCapture.js'));

// ── "Man hinh" gia: mot client WS that, nhan dung cac goi ma broadcaster gui ───────────────────────────────────────
const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise((ok) => wss.once('listening', ok));
const port = wss.address().port;
const { WebSocket } = await import('ws');
const got = { packets: 0, bytes: 0, sizes: [], at: [] };
// Phai dang ky 'connection' TRUOC khi client ket noi (neu khong su kien da ban ra va cho mai).
const connected = new Promise((ok) => wss.once('connection', ok));
const client = new WebSocket(`ws://127.0.0.1:${port}/`);
client.on('message', (data) => {
  const b = data.length;
  got.packets++;
  got.bytes += b;
  got.sizes.push(b);
  got.at.push(Date.now());
});
await new Promise((ok, bad) => { client.once('open', ok); client.once('error', bad); });
const serverSide = await connected;
dm.broadcaster.addClient(DEV, serverSide);
await new Promise((ok) => setTimeout(ok, 50));

// ── Nguon thu hai: tieng Chrome/PulseAudio (parec -> drainTick cua src/audioCapture.ts) ─────────────────────────────
const second = { sent: 0, blocked: 0 };
const iv = setInterval(() => {
  const frame = Buffer.alloc(CAPTURE_BYTES);
  const ok = OLD
    ? dm.broadcaster.sendAudioFrame(DEV, frame)          // HANH VI CU: goi thang, khong ai chan
    : capture.sendCapturedFrame(DEV, frame);             // SAU KHI SUA: qua cong sendPanelAudio(..., 'web')
  if (ok) second.sent++; else second.blocked++;
}, CAPTURE_EVERY_MS);

// ── Duong phat that: `POST /call/test/play` (goi thang playTestAudio) ───────────────────────────────────────────────
const t0 = Date.now();
const r = await bridge.playTestAudio({ dev: DEV, file: FILE, loop: LOOP });
const ms = Date.now() - t0;
clearInterval(iv);
await new Promise((ok) => setTimeout(ok, 150));          // cho loa "tieu thu" not phan con lai

const kbs = (n) => (n / (ms / 1000) / 1000).toFixed(1);
const sizes = [...new Set(got.sizes)].sort((a, b) => a - b);
console.log('');
console.log(`[measure] che do            : ${OLD ? 'TRUOC KHI SUA (goi thang broadcaster)' : 'SAU KHI SUA (cong sendPanelAudio)'}`);
console.log(`[measure] tep               : ${r.file} loop=${r.loop} agc=${r.agc ? 1 : 0} eq=${r.eq ? 1 : 0} stereo=${r.stereo ? 1 : 0} framebytes=${r.frameBytes}`);
console.log(`[measure] thoi gian phat    : ${ms} ms (bo dem nhip bao: frames=${r.frames} dropped=${r.dropped})`);
console.log(`[measure] man NHAN duoc     : ${got.packets} goi, ${got.bytes} byte -> ${kbs(got.bytes)} KB/s, ${(got.packets / (ms / 1000)).toFixed(1)} goi/s`);
console.log(`[measure] co goi (byte)     : ${sizes.join(', ') || 'khong co'}`);
console.log(`[measure] nguon thu hai     : gui duoc ${second.sent} khung, bi chan ${second.blocked} khung (1280 B/40 ms)`);
console.log(`[measure] ket luan          : ${got.bytes / (ms / 1000) <= 34000 ? 'MOT duong (32 KB/s)' : 'GUI TRUNG (tren 32 KB/s)'}`);

client.close();
serverSide.close();
await new Promise((ok) => wss.close(ok));
process.exit(0);
