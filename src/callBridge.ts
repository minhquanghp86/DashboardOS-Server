// SPDX-License-Identifier: Apache-2.0
//
// Copyright (c) 2026 minhquanghp86
// Licensed under the Apache License, Version 2.0 (see LICENSE).

// (14/10/2026) INTERCOM — GIAI DOAN 0 (thu nghiem): cau noi TIENG giua mot man va mot dau goi (trang thu trong trinh
// duyet qua ingress, hoac phep do vong lap cua chinh server).
//   - Man -> server: MicFrame (firmware bat khi nhan ControlField.Call = 1; tieng da khu vong).
//   - Server -> man: AudioFrame gui RIENG man do; trong luc goi tieng Chrome KHONG gui toi man nay (audioCapture.callHold).
// API:
//   GET  /call/devices                 man goi duoc (co mic cuoc goi + loa) — ingress / 127.0.0.1
//   WS   /call/ws?dev=<id>             trang thu: gui PCM s16le mono 16 kHz, nhan PCM mic cua man — ingress / 127.0.0.1
//   POST /call/test/loop?dev=&aec=0|1  do vong lap: bip ra loa man -> mic thu lai (do tre khu hoi, muc vong) — 127.0.0.1
//   WS   /call/video?dev=<id>          HINH camera man (dung chung ket noi /live voi Frigate — src/mkvLive.ts): tin text dau
//                                      {codec, avcc(base64)}, roi khung nhi phan [co: 1 = khung khoa][ts u32le ms] + AVCC
//   (05/12/2026) BO PHAT THU NGHIEM — do duong PHAT tren P4 bang file CO DINH, khong can mic nguoi:
//   GET  /call/test/files              liet ke tep mau trong test-audio/ (xem scripts/gen-test-audio.mjs)
//   POST /call/test/play?dev=&file=&loop=&agc=0|1&gain=<dB>[&eq=0|1]
//                                      phat WAV 16 kHz mono s16le qua DUNG duong `sendToSpeaker()`, nhip 20 ms/khung
//                                      (src/audioPacer.ts), tra {ok, dev, frames, dropped, ms}. Chi loopback / trang LAN
//                                      cung origin (KHONG qua ingress) — day la duong bom tieng ra loa that.
//                                      (06/12/2026) Nhanh xuong man gui STEREO 1280 B/goi (L = R, xem src/audioStereo.ts):
//                                      tep mono 640 B -> goi 1280 B, van 20 ms/goi (`CCR_CALL_STEREO=0` -> mono nhu cu).
//                                      (07/12/2026) `CCR_CALL_RATE8K=1` -> ha mau 16 kHz -> 8 kHz (loc 3,4 kHz roi bo mau
//                                      x2, src/audioResample8k.ts): 640 B -> 320 B, van 20 ms/goi (16 KB/s = dung nhip
//                                      tieu thu cua loa P4). MAC DINH TAT.
import fs from 'node:fs';
import http from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';

import { newAgcState, processPcm, AGC_ENABLED, AGC_SILENCE_DBFS, peakOf, type AgcState } from './audioAgc.js';
// (05/12/2026) NHIP GUI DEU 20 ms/khung xuong loa man (burst -> tran ring buffer 250 ms cua P4 -> "giat cuc").
import { FramePacer, type DropReason } from './audioPacer.js';
// (06/12/2026) MONO -> STEREO (L = R) cho nhanh xuong LOA MAN: mixer cua P4 khai 2 kenh nen 640 B mono chi la
// 10 ms stereo -> buffer loa luon day -> vut bot -> nghe dut quang. 1280 B/20 ms moi dung. Tat: CCR_CALL_STEREO=0.
import { monoToStereo, STEREO_ENABLED } from './audioStereo.js';
// (07/12/2026) HA 16 kHz -> 8 kHz (env `CCR_CALL_RATE8K`): loc thong thap 3,4 kHz roi bo mau x2 -> 320 B/20 ms.
// Do gia thuyet "I2S cua loa P4 chay 8 kHz" (P4 chi tieu thu ~16 KB/s trong khi server gui 32 KB/s) — xem
// src/audioResample8k.ts. MAC DINH TAT.
import {
  downsample2, frameBytesFor, newDownsample2State, rateLogLine, RATE8K_ENABLED, SPEAKER_RATE_HZ,
  type Downsample2State,
} from './audioResample8k.js';
// (05/12/2026) EQ bu loa nho cua P4: high-pass 120 Hz + presence +4 dB @ 1,5 kHz (env CCR_CALL_EQ de A/B).
import { EQ_ENABLED, eqApply, newEqState, type EqState } from './callEq.js';
// (05/12/2026) Do muc tieng that (web -> man): mot dong log moi 2 s, xem src/audioMeter.ts.
import { AudioMeters, METER_WINDOW_MS, type AudioMeter } from './audioMeter.js';
// (05/12/2026) Bo phat thu nghiem: doc WAV + nhip 20 ms theo moc tuyet doi (src/testAudio.ts).
import { frameCount, listTestAudio, loadTestAudio, playPaced, readPlayParams } from './testAudio.js';
// (09/12/2026) MOT CONG DUY NHAT xuong loa man + bo dem theo nguon: `sendPanelAudio()` (xem src/audioOut.ts).
// `holdVoice`/`releaseVoice` thay cho `callHold.add/delete` cu — cung mot tap, nhung dem tham chieu duoc (cuoc goi va
// phep do `/call/test/play` co the chong nhau) va chan luon nguon tieng Chrome khi man dang co tieng nguoi.
import { holdVoice, releaseVoice, sendPanelAudio, type AudioSource } from './audioOut.js';
import { subscribeLiveFrames } from './camProxy.js';
import { isDoor, subscribeDoorFrames } from './door.js';
import { isCallParty, isWebSource, subscribeWebFrames, videoAllowed, videoSourceOf } from './calls.js';
import { broadcaster, connectedScreens } from './deviceManager.js';
import { isLanBrowser, isLoopback } from './requestOrigin.js';
import { ControlField } from './protocol.js';

export const SAMPLE_RATE = 16000;
/** 20 ms PCM s16le MONO 16 kHz — dung cho `sendToDevice()` (trang thu / bip do vong lap). Duong xuong man
 *  (`sendToSpeaker`) gui 1280 byte stereo khi bat `CCR_CALL_STEREO` (xem src/audioStereo.ts). */
export const FRAME_BYTES = 640;   // 20 ms mono

// ── (07/12/2026) DINH DANG MOT GOI 20 ms TREN DUONG XUONG LOA MAN (mot cho duy nhat) ────────────────────────────
/** So KENH cua mot goi 20 ms xuong man: 2 khi bat `CCR_CALL_STEREO` (mac dinh), 1 khi tat (A/B). */
export const SPEAKER_CHANNELS: number = STEREO_ENABLED ? 2 : 1;
/**
 * So byte cua MOT goi 20 ms xuong loa man — dung cho bo dem nhip (src/audioPacer.ts) va bao trong ket qua
 * `POST /call/test/play`:
 *   - 16 kHz mono (mac dinh `CCR_CALL_STEREO=0`)               = 640;
 *   - 16 kHz stereo (mac dinh)                                 = 1280;
 *   - 8 kHz mono  (`CCR_CALL_RATE8K=1`, `CCR_CALL_STEREO=0`)    = 320  (16 KB/s — dung nhip tieu thu cua P4);
 *   - 8 kHz stereo (`CCR_CALL_RATE8K=1`)                       = 640.
 */
export const SPEAKER_WIRE_FRAME_BYTES: number = frameBytesFor(SPEAKER_RATE_HZ, SPEAKER_CHANNELS);

interface Leg {
  dev: string;
  peers: Set<WebSocket>;
  listeners: Set<(pcm: Buffer, at: number) => void>;
  startedAt: number;
  micFrames: number;
  lost: number;
  lastSeq: number;
  /** (14/10/2026) Thiet bi dau kia (vd man <-> chuong cong): tieng mic cua leg nay phat ra loa cua no. */
  link?: string;
  /** (14/10/2026) Tat mic: khong chuyen tieng cua leg nay sang dau kia. */
  muted?: boolean;
}
const calls = new Map<string, Leg>();
/** (31/10/2026) Gain AGC/limiter rieng cho tung man (xem src/audioAgc.ts) — chi cho nhanh xuong LOA MAN. */
const agc = new Map<string, AgcState>();
/** (05/12/2026) Trang thai EQ (high-pass + presence) rieng cho tung man — xem src/callEq.ts. */
const eqs = new Map<string, EqState>();
/**
 * (07/12/2026) TRANG THAI BO LOC HA MAU 16 kHz -> 8 kHz, RIENG cho tung man (`CCR_CALL_RATE8K=1`).
 * Bo loc IIR co "nho" (z1/z2): cat khung 20 ms thanh tung lan loc rieng ma tra trang thai ve 0 se lam MOI BIEN
 * KHUNG thanh mot cu giat -> re 50 lan/giay. Vi vay giu MOT trang thai / man, xoa khi het cuoc goi / bat dau phep do.
 */
const resamplers = new Map<string, Downsample2State>();
/** Trang thai loc 8 kHz cua `dev` (tao lan dau, giu giua cac khung). */
function resamplerOf(dev: string): Downsample2State {
  let st = resamplers.get(dev);
  if (!st) { st = newDownsample2State(); resamplers.set(dev, st); }
  return st;
}
/**
 * (31/10/2026) BO DO MUC TIENG (src/audioMeter.ts) — mot bo do / man, chi song trong cuoc goi:
 *   - `startCall()` mo bo do, `endCall()` dong (khong log gi khi dong);
 *   - `sendToSpeaker()` cong don tung mau PCM (in = truoc AGC, out = sau AGC, peak = sau limiter, gain = hien tai);
 *   - hen gio 0,5 s doc so lieu: moi cua so 2 s in MOT dong, khong co khung nao -> `NO-FRAMES`.
 * Chi man dang trong cuoc goi moi co bo do => ranh thi khong spam log.
 */
const meters = new AudioMeters(METER_WINDOW_MS);
/**
 * (05/12/2026) Man dang duoc BO PHAT THU NGHIEM bom tieng (`POST /call/test/play`) — khong co cuoc goi nhung VAN can
 * cac dong `[audio]` de so sanh A/B (do la bang chung cua phep do). Chi song trong luc phat (xem `playTestAudio`).
 */
const testMeters = new Set<string>();
/** Nhip kiem tra cua so 2 s: 0,5 s de moi man dong cua so dung luc (nhieu man khong bi lech toi 2 s). */
const METER_TICK_MS = 500;
let meterT: NodeJS.Timeout | null = null;

/** Bat hen gio doc so lieu (mot hen gio chung, tu tat khi khong con bo do nao). */
function meterTimer(): void {
  if (meterT) return;
  meterT = setInterval(() => {
    for (const line of meters.tick(Date.now(), (d) => calls.has(d) || testMeters.has(d))) console.log(line);
    if (!meters.size && meterT) { clearInterval(meterT); meterT = null; }
  }, METER_TICK_MS);
  meterT.unref?.();                       // khong giu tien trinh song vi bo do
}

/** Bo do cua `dev` neu man do DANG trong cuoc goi (moi lai neu hen gio chua kip mo), nguoc lai null. */
function meterOf(dev: string): AudioMeter | undefined {
  return meters.get(dev) || (calls.has(dev) || testMeters.has(dev) ? (meterTimer(), meters.start(dev)) : undefined);
}

// ── (05/12/2026) NHIP GUI XUONG LOA MAN: 20 ms/khung, co tran ────────────────────────────────────────────────────
/** Doc env `CCR_CALL_PACE` MOT lan: mac dinh BAT, '0'/'off'/'no' -> gui ngay (hanh vi CU, de A/B). */
function readPace(): boolean {
  const v = (process.env.CCR_CALL_PACE ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'off' || v === 'false' || v === 'no');
}
const intEnv = (k: string, d: number): number => {
  const v = parseInt(process.env[k] ?? '', 10);
  return Number.isFinite(v) && v >= 0 ? v : d;
};
export const PACE_ENABLED: boolean = readPace();
/**
 * Hang doi nhip cho TUNG man — xem src/audioPacer.ts (vi sao: burst lam tran ring buffer 250 ms cua loa P4 roi HUT
 * 20-40 ms sau do = "giat cuc, hut hoi"). Tran:
 *   - `CCR_CALL_PACE_QUEUE`    so khung 20 ms trong hang doi (mac dinh 5 = 100 ms do tre toi da);
 *   - `CCR_CALL_PACE_BACKLOG`  tran bufferedAmount cua socket (mac dinh 32 KB ~ 1 s tieng); vuot -> bo khung.
 */
export const framePacer = new FramePacer({
  // (09/12/2026) Nguon cua tung goi do bo dem nhip phat ra = nguon da push vao (`pacerSrcOf`) — de dong
  // `[audiosrc]` tach duoc "tieng nguoi/phep do" (`speaker`) khoi PCM thang cua trang thu / bip do (`device`/`loop`).
  send: (dev, frame) => sendFrameToDevice(dev, frame, pacerSrcOf(dev)),
  backlog: (dev) => broadcaster.backlogBytes(dev),
  pace: PACE_ENABLED,
  // (06/12/2026) MOT goi 20 ms = 1280 byte khi bat stereo (640 khi tat) — nhip VAN 20 ms/goi, khong gui gap doi.
  // (07/12/2026) Khi bat 8 kHz (`CCR_CALL_RATE8K=1`) thi 320 byte (mono) / 640 (stereo): phai dung SO BYTE THAT,
  // neu khong mot khung 20 ms bi chia thanh 2 goi 640 B va bo dem ban 2 goi moi nhip (xem src/audioPacer.ts).
  // (08/12/2026) `frameBytes` = SO BYTE THAT cua mot goi tren duong xuong man (sau downsample + stereo) va du lieu
  // push vao duoc cat DUNG tung ay byte (`pushToPacer()`): bo dem luon phat 1 goi/20 ms, khong con chuyen "1 khung
  // vao -> 2 goi ra" (loi do duoc tren P4: 58 goi/s, 42,7 KB/s thay vi 50 goi/s, 32 KB/s).
  frameBytes: SPEAKER_WIRE_FRAME_BYTES,
  maxQueueFrames: intEnv('CCR_CALL_PACE_QUEUE', 5) || 5,
  maxBacklogBytes: intEnv('CCR_CALL_PACE_BACKLOG', 32 * 1024),
  onDrop: (dev, reason, queued) => logDrop(dev, reason, queued),
});

/**
 * (08/12/2026) Day PCM cua duong xuong man vao bo dem nhip SAU KHI da chia dung co mot goi:
 *   - dai DUNG `SPEAKER_WIRE_FRAME_BYTES` -> push thang (truong hop binh thuong: mic 640 B -> stereo 1280 B);
 *   - dai KHAC -> CAT NHO thanh tung goi `frameBytes` roi moi push, nho vay bo dem nhip chi con dung mot viec la
 *     phat MOT goi moi 20 ms, khong phai tu chia lai du lieu.
 *   - manh cuoi ngan hon mot goi (du lieu le) van duoc push NGAY, khong giu lai cho du byte: am thanh khong duoc
 *     phep "ket" trong luc cho them du lieu, va nhip ra van la 1 goi/20 ms nen mot goi ngan khong lam doi toc do.
 * (09/12/2026) `src` = NGUON cua du lieu nay; bo dem nhip gan nhan do cho tung goi no phat ra (`pacerSrcOf`).
 */
function pushToPacer(dev: string, pcm: Buffer, src: AudioSource = 'speaker'): void {
  pacerSrc.set(dev, src);
  const fb = SPEAKER_WIRE_FRAME_BYTES;
  if (pcm.length === fb) { framePacer.push(dev, pcm); return; }
  for (let o = 0; o < pcm.length; o += fb) framePacer.push(dev, pcm.subarray(o, Math.min(pcm.length, o + fb)));
}

/**
 * (09/12/2026) Nguon dang day du lieu vao bo dem nhip cua tung man. Bo dem nhip phat MOT goi moi 20 ms nhung khong
 * biet goi do den tu dau, nen nhan theo lan `push()` gan nhat. Binh thuong moi man CHI CO MOT nguon push (luat
 * "mot duong gui" cua src/audioOut.ts) nen "lan push gan nhat" la dung nguon.
 */
const pacerSrc = new Map<string, AudioSource>();
function pacerSrcOf(dev: string): AudioSource { return pacerSrc.get(dev) ?? 'speaker'; }
function forgetPacerSrc(dev: string): void { pacerSrc.delete(dev); }

/** Bo dem khung BI BO theo tung man (log toi da 1 lan / 5 s de khong spam khi mang nghen keo dai). */
const drops = new Map<string, { n: number; at: number; queue: number; backlog: number; send: number; late: number }>();
function logDrop(dev: string, reason: DropReason, queued: number): void {
  const now = Date.now();
  let d = drops.get(dev);
  if (!d) { d = { n: 0, at: 0, queue: 0, backlog: 0, send: 0, late: 0 }; drops.set(dev, d); }
  d.n++;
  d[reason]++;
  if (now - d.at < 5000) return;
  d.at = now;
  console.warn(`[audio] dev=${dev} bo ${d.n} khung (hang doi ${d.queue}, socket ${d.backlog}, gui loi ${d.send}, dung hinh ${d.late}) — dang cho ${queued} khung`);
  d.n = 0; d.queue = 0; d.backlog = 0; d.send = 0; d.late = 0;
}

if (!process.env.VITEST) {
  console.log(`[audio] pace=${PACE_ENABLED ? 'on' : 'off'} 20ms/khung`);
  // (07/12/2026) `[audio] rate=8k frame=320B/20ms` khi bat CCR_CALL_RATE8K, `[audio] rate=16k` khi tat (mac dinh).
  console.log(rateLogLine(SPEAKER_CHANNELS));
}

export function isInCall(dev: string): boolean { return calls.has(dev); }

export function startCall(dev: string): Leg | null {
  if (calls.has(dev)) return null;
  const leg: Leg = { dev, peers: new Set(), listeners: new Set(), startedAt: Date.now(), micFrames: 0, lost: 0, lastSeq: -1 };
  calls.set(dev, leg);
  meters.start(dev);                       // (31/10/2026) bat dau do muc tieng cho man nay (chi trong cuoc goi)
  meterTimer();
  holdVoice(dev);                          // (09/12/2026) loa cua man nay thuoc ve tieng nguoi: chan tieng Chrome (audioOut)
  broadcaster.sendDeviceControl(dev, ControlField.Call, 1);
  console.log(`[call] ${dev}: bat dau cuoc goi`);
  return leg;
}

export function endCall(dev: string): void {
  const leg = calls.get(dev);
  if (!leg) return;
  calls.delete(dev);
  agc.delete(dev);
  eqs.delete(dev);
  resamplers.delete(dev);                  // (07/12/2026) bo trang thai loc 8 kHz cua man nay
  framePacer.forget(dev);                  // (05/12/2026) bo khung con lai + hen gio cua man nay
  forgetPacerSrc(dev);                     // (09/12/2026) bo nhan nguon cua bo dem nhip
  drops.delete(dev);
  meters.stop(dev);                        // (31/10/2026) dong bo do: het cuoc goi thi khong log nua
  releaseVoice(dev);                       // (09/12/2026) tra loa lai (tieng Chrome duoc phep quay lai)
  broadcaster.sendDeviceControl(dev, ControlField.Call, 0);
  for (const p of leg.peers) { try { p.close(1000, 'het cuoc goi'); } catch { /* */ } }
  const s = Math.round((Date.now() - leg.startedAt) / 1000);
  console.log(`[call] ${dev}: ket thuc sau ${s} s — mic ${leg.micFrames} goi (le ra ~${s * 50}), mat ${leg.lost}`);
}

/** Goi MicFrame tu thiet bi: [type][ver][seq u16le] + PCM. */
export function onMicFrame(dev: string, buf: Buffer): void {
  const leg = calls.get(dev);
  if (!leg || buf.length <= 4) return;
  const seq = buf.readUInt16LE(2);
  if (leg.lastSeq >= 0) leg.lost += (seq - leg.lastSeq - 1 + 65536) % 65536;
  leg.lastSeq = seq;
  leg.micFrames++;
  const pcm = buf.subarray(4);
  const at = Date.now();
  for (const p of leg.peers) if (p.readyState === WebSocket.OPEN && p.bufferedAmount < 64 * 1024) p.send(pcm);
  // (09/12/2026) KHONG BAO GIO gui mic cua mot man ve CHINH loa cua no (`leg.link !== dev`): mot self-link (du lieu
  // hong / goi tu chinh no) truoc day tao vong echo mic -> loa -> mic -> ... tren cung mot thiet bi.
  if (leg.link && leg.link !== dev && !leg.muted && calls.has(leg.link)) sendToSpeaker(leg.link, pcm);
  for (const f of leg.listeners) f(pcm, at);
}

/** (14/10/2026) Noi tieng hai chieu giua hai thiet bi DANG trong cuoc goi (man <-> chuong cong). */
export function linkCalls(a: string, b: string): boolean {
  const la = calls.get(a), lb = calls.get(b);
  if (!la || !lb) return false;
  la.link = b; lb.link = a;
  console.log(`[call] noi tieng ${a} <-> ${b}`);
  return true;
}

/** (14/10/2026) Nghe tieng mic cua man trong cuoc goi (tong dai cuoc goi video gui sang trinh duyet). Tra ham huy. */
export function onMicListener(dev: string, fn: (pcm: Buffer) => void): () => void {
  const l = calls.get(dev);
  if (!l) return () => { };
  const f = (pcm: Buffer) => fn(pcm);
  l.listeners.add(f);
  return () => { l.listeners.delete(f); };
}

export function setMuted(dev: string, on: boolean): boolean { const l = calls.get(dev); if (!l) return false; l.muted = on; return true; }

/** Ghi de tung lan goi cho `sendToSpeaker` (bo phat thu nghiem A/B) — bo qua = lay theo env. */
export interface SpeakerOpts {
  agc?: boolean;
  eq?: boolean;
  /** Gain them (dB) truoc AGC — do do nhay cua loa theo muc vao. */
  gainDb?: number;
}

/**
 * Gui MOT khung PCM xuong man qua CONG DUY NHAT (`sendPanelAudio` — src/audioOut.ts). `false` = KHONG gui duoc
 * (socket dong / bufferedAmount qua cao — xem AUDIO_HIGH_WATER trong src/broadcaster.ts) hoac nguon nay bi chan vi
 * man dang co tieng nguoi (chi voi nguon `web`). Nho co `false` ma bo dem nhip (src/audioPacer.ts) dem duoc `dropped`
 * that su thay vi "gui ma khong biet co toi noi hay khong".
 */
export function sendFrameToDevice(dev: string, frame: Buffer, src: AudioSource = 'speaker'): boolean {
  return sendPanelAudio(dev, frame, src);
}

/**
 * (09/12/2026) Dinh dang THAT cua mot goi 20 ms tren duong xuong loa man: MONO -> [8 kHz] -> [STEREO].
 * Dung CHUNG cho `sendToSpeaker()` va `sendToDevice()` de moi goi xuong loa deu cung mot dinh dang (truoc day
 * `sendToDevice()` gui 640 B mono trong khi duong chinh gui 1280 B stereo tren CUNG mot loa).
 */
function speakerWire(dev: string, mono: Buffer): Buffer {
  // (07/12/2026) HA 16 kHz -> 8 kHz NGAY TRUOC khi nhan doi kenh (`CCR_CALL_RATE8K=1`), trang thai loc theo TUNG man.
  const mono8 = RATE8K_ENABLED ? downsample2(mono, resamplerOf(dev)) : mono;
  // (06/12/2026) MONO -> STEREO (L = R): 640 B -> 1280 B, do dai THOI GIAN khong doi (van 20 ms).
  return STEREO_ENABLED ? monoToStereo(mono8) : mono8;
}

/**
 * (09/12/2026) PCM cua may/trang thu phat ra loa man (bip do vong lap, PCM tu trang `/call/ws`) — KHONG qua EQ/AGC
 * (de phep do khong bi lam sai lech) NHUNG di qua CUNG bo dem nhip 20 ms va CUNG dinh dang goi nhu `sendToSpeaker()`.
 *
 * Truoc day ham nay tu chia 640 B roi gui NGAY (`broadcaster.sendAudioFrame` truc tiep, khong nhip), nen:
 *   - mot khung 20 ms bi chia thanh 2 goi khi duong xuong man la stereo 1280 B (goi 640 B khong dung 20 ms);
 *   - va no la duong GUI THU HAI khong qua bo dem nhip -> khong bi gioi han toc do, khong dem duoc `dropped`.
 * Nay bo dem nhip la noi DUY NHAT chia goi + giu nhip, dung nhu ghi chu (08/12/2026) cua src/audioPacer.ts.
 */
export function sendToDevice(dev: string, pcm: Buffer, src: AudioSource = 'device'): void {
  for (let o = 0; o + 1 < pcm.length; o += FRAME_BYTES) {
    pushToPacer(dev, speakerWire(dev, pcm.subarray(o, Math.min(pcm.length, o + FRAME_BYTES))), src);
  }
}

/** Ap them gain tuyen tinh (dB) vao MOT buffer PCM — copy, khong sua buffer goc. Dung cho tham so `gain=` cua
 *  `POST /call/test/play` (do do nhay cua loa theo muc vao, khong doi AGC). */
export function applyGainDb(pcm: Buffer, gainDb: number): Buffer {
  const g = 10 ** (gainDb / 20);
  const out = Buffer.from(pcm);
  for (let i = 0; i + 1 < out.length; i += 2) {
    const v = Math.max(-32768, Math.min(32767, Math.round(out.readInt16LE(i) * g)));
    out.writeInt16LE(v, i);
  }
  return out;
}

/**
 * (31/10/2026) Tieng MIC -> LOA MAN co AGC + limiter (src/audioAgc.ts). Day la duong DUY NHAT xuong loa man cho
 * tieng nguoi noi (trang goi -> man, chuong cong -> man); tieng may phat ra (bip do vong lap) van di thang qua
 * `sendToDevice` de phep do khong bi AGC lam sai lech.
 *   - (05/12/2026) Muc nham -26 dBFS, attack 5 ms / release 200 ms, gain [-6 dB, +12 dB], limiter mem -4 dBFS.
 *   - (05/12/2026) TRUOC AGC co EQ (src/callEq.ts): high-pass 120 Hz + presence +4 dB @ 1,5 kHz, `CCR_CALL_EQ=0` de tat.
 *   - (05/12/2026) SAU AGC di vao bo dem nhip 20 ms/khung (src/audioPacer.ts), `CCR_CALL_PACE=0` = gui ngay nhu cu.
 *   - Khong im lang: khung < -60 dBFS di nguyen (khong khuech dai nhieu nen phong).
 *   - (06/12/2026) KHONG con giu nguyen kich thuoc goi tren duong xuong MAN: AGC/EQ van xu ly MONO (vao 640 byte,
 *     ra 640 byte — do muc `[audio] in/out` tinh tren mono), roi `monoToStereo()` nhan doi kenh (L = R) thanh
 *     **1280 byte = 20 ms stereo** truoc bo dem nhip (mixer P4 khai 2 kenh — xem src/audioStereo.ts).
 *     `CCR_CALL_STEREO=0` -> gui mono 640 byte nhu cu (A/B). Web <-> web khong di qua day nen van mono.
 *   - (07/12/2026) TRUOC `monoToStereo()` co the co buoc HA MAU 16 kHz -> 8 kHz (`CCR_CALL_RATE8K=1`): loc thong thap
 *     3,4 kHz roi lay moi mau thu 2 (src/audioResample8k.ts), 640 B -> 320 B, van 20 ms — de do gia thuyet "I2S cua
 *     loa P4 chay 8 kHz" (loa chi tieu thu ~16 KB/s trong khi server gui 32 KB/s). MAC DINH TAT. Ha mau tren MONO
 *     (truoc khi nhan doi kenh) vi bo loc/bo mau chi co nghia voi mot kenh.
 *   - (08/12/2026) `frameBytes` cua bo dem nhip PHAI bang SO BYTE THAT cua mot goi tren duong xuong man (sau ha mau
 *     + nhan doi kenh) va du lieu push vao duoc cat dung tung ay byte (`pushToPacer()`), nen bo dem luon phat dung
 *     MOT goi moi 20 ms — "mot khung vao -> hai goi ra" (58 goi/s, 42,7 KB/s do duoc tren P4) khong con xay ra.
 *   - Tat AGC bang env CCR_CALL_AGC=0 (A/B: so sanh truc tiep tren cung mot cuoc goi).
 *   - (31/10/2026) DO MUC THAT tai day: `in` = RMS truoc AGC, `out` = RMS sau AGC, `peak` = dinh sau limiter,
 *     `gain` = gain hien tai (src/audioMeter.ts in ra mot dong log moi 2 s cho moi man dang trong cuoc goi).
 *   - (05/12/2026) `opts` cho phep GHI DE tung lan goi (bo phat thu nghiem A/B khong can khoi dong lai add-on):
 *     `{agc, eq, gainDb}` — khong co gi thi lay theo env nhu cu.
 */
export function sendToSpeaker(dev: string, pcm: Buffer, opts?: SpeakerOpts): void {
  const m = meterOf(dev);                                   // null = man nay khong trong cuoc goi -> khong do
  const inDb = m ? db(rms(pcm)) : 0;
  const eqOn = opts?.eq ?? EQ_ENABLED;
  const agcOn = opts?.agc ?? AGC_ENABLED;
  const extraDb = opts?.gainDb ?? 0;
  let out: Buffer = pcm;                                    // MONO s16le 16 kHz tren TOAN BO duong xu ly
  let gainDb = 0;
  if (eqOn) {                                               // (05/12/2026) EQ TRUOC AGC: dinh tang do presence bi limiter chan
    let st = eqs.get(dev);
    if (!st) { st = newEqState(SAMPLE_RATE); eqs.set(dev, st); }
    out = eqApply(st, out, true);
  }
  if (extraDb) out = applyGainDb(out, extraDb);
  if (agcOn) {
    let st = agc.get(dev);
    if (!st) { st = newAgcState(); agc.set(dev, st); }
    out = processPcm(out, st);
    gainDb = st.gainDb;
  }                                                         // AGC tat -> passthrough y nguyen byte (A/B)
  // (06/12/2026) MONO -> STEREO SAU AGC, TRUOC bo dem nhip: moi mau lap 2 lan (L = R), 640 B -> 1280 B, do dai
  // THOI GIAN khong doi (van 20 ms). Ly do: mixer cua P4 khai 2 kenh — 640 B mono chi la 10 ms stereo nen buffer
  // loa luon day va bi vut. `CCR_CALL_STEREO=0` -> gui mono nhu cu (A/B). Chi nhanh xuong MAN di qua day.
  // (07/12/2026) HA 16 kHz -> 8 kHz NGAY TRUOC khi nhan doi kenh (`CCR_CALL_RATE8K=1`): loc thong thap 3,4 kHz roi
  // bo mau x2, 640 B -> 320 B (van 20 ms). Dat TRUOC `monoToStereo()` vi `downsample2()` nhan PCM MONO: loc tren
  // du lieu XEN KENH L/R thi `bo mau x2` chi con lai mot kenh (mat kenh kia) -> phai ha mau tren mono roi moi lap kenh.
  // Trang thai loc lay theo TUNG man (`resamplerOf`) -> khong re o bien khung.
  // (09/12/2026) Dinh dang goi nay dung CHUNG voi `sendToDevice()` (`speakerWire`) — mot loa, mot dinh dang goi.
  const wire = speakerWire(dev, out);
  // (08/12/2026) PUSH SAU KHI CHIA DUNG CO MOT GOI: bo dem nhip chi phat 1 goi/20 ms, nen du lieu vao phai duoc cat
  // nho theo `SPEAKER_WIRE_FRAME_BYTES` TRUOC khi push — xem `pushToPacer()`. Truoc day push thang `wire` nen khi
  // `frameBytes` = 320/640 ma du lieu la 640 B thi mot khung 20 ms bi chia 2 va loa nhan gap doi.
  // (09/12/2026) `src='speaker'`: day la DUONG CHINH (tieng nguoi + `POST /call/test/play`) — duong duy nhat duoc
  // phep bom vao loa khi man dang trong cuoc goi / dang duoc phat tep mau (xem src/audioOut.ts).
  pushToPacer(dev, wire, 'speaker');
  if (m) {
    // (06/12/2026) Do muc tren MONO (truoc khi nhan doi kenh) -> dBFS giu nguyen y nghia, so duoc voi cac lan truoc.
    m.add({ inDb, outDb: db(rms(out)), peakDb: db(peakOf(out) / 32768), gainDb,
      silent: inDb < AGC_SILENCE_DBFS, frames: frameCount(pcm.length) });   // 640 byte = 1 khung 20 ms -> ~100 khung/2 s
  }
}

// ── Do vong lap ──────────────────────────────────────────────────────────────────────────────────────────────
/** RMS (0..1) cua mot khung PCM s16le. */
export function rms(pcm: Buffer): number {
  const n = Math.floor(pcm.length / 2);
  if (!n) return 0;
  let s = 0;
  for (let i = 0; i < n; i++) { const v = pcm.readInt16LE(i * 2) / 32768; s += v * v; }
  return Math.sqrt(s / n);
}
export const db = (x: number) => (x > 0 ? Math.round(20 * Math.log10(x) * 10) / 10 : -120);
/** Bien do (0..1) thanh phan tan so `hz` trong khung (Goertzel) — tach tieng bip khoi tieng on nen. */
export function toneLevel(pcm: Buffer, hz: number): number {
  const n = Math.floor(pcm.length / 2);
  if (!n) return 0;
  const k = 2 * Math.cos(2 * Math.PI * hz / SAMPLE_RATE);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < n; i++) { const s0 = pcm.readInt16LE(i * 2) / 32768 + k * s1 - s2; s2 = s1; s1 = s0; }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - k * s1 * s2)) * 2 / n;
}

function tone(ms: number, hz: number, amp: number, offsetSamples: number): Buffer {
  const n = Math.round(SAMPLE_RATE * ms / 1000), b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(2 * Math.PI * hz * (i + offsetSamples) / SAMPLE_RATE) * amp * 32767), i * 2);
  return b;
}

export interface BeepResult { latMs: number | null; peakDb: number }
/** Phan tich (muc 1 kHz moi khung): nen = trung vi truoc tieng bip dau; moi bip: khung dau tien vuot nen x4 (> -60 dB) trong 1 s. */
export function analyze(frames: { at: number; r: number }[], beepAt: number[]): { floorDb: number; beeps: BeepResult[] } {
  const pre = frames.filter((f) => f.at < beepAt[0]).map((f) => f.r).sort((a, b) => a - b);
  const floor = pre.length ? pre[Math.floor(pre.length / 2)] : 0;
  const thr = Math.max(floor * 4, 10 ** (-60 / 20));
  const beeps = beepAt.map((t) => {
    const win = frames.filter((f) => f.at >= t && f.at < t + 1000);
    const hit = win.find((f) => f.r > thr);
    const peak = win.reduce((m, f) => Math.max(m, f.r), 0);
    return { latMs: hit ? hit.at - t : null, peakDb: db(peak) };
  });
  return { floorDb: db(floor), beeps };
}

async function loopTest(dev: string, aec: boolean): Promise<unknown> {
  broadcaster.sendDeviceControl(dev, ControlField.Aec, aec ? 1 : 0);
  const leg = startCall(dev);
  if (!leg) throw new Error('man dang trong cuoc goi');
  const frames: { at: number; r: number }[] = [];
  const raw: Buffer[] = [];
  leg.listeners.add((pcm, at) => { frames.push({ at, r: toneLevel(pcm, 1000) }); raw.push(Buffer.from(pcm)); });
  const beepAt: number[] = [];
  // 1,5 s im lang (do nen) roi 5 tieng bip 1 kHz 200 ms, cach 1,2 s; giu nhip 20 ms bang khung im lang.
  const plan = [1500, 2700, 3900, 5100, 6300];
  const t0 = Date.now();
  let sent = 0;
  await new Promise<void>((done) => {
    const iv = setInterval(() => {
      const el = Date.now() - t0;
      while (sent * 20 <= el) {
        const at = sent * 20;
        const b = plan.findIndex((p) => at >= p && at < p + 200);
        if (b >= 0 && at === plan[b]) beepAt.push(Date.now());
        // (09/12/2026) `src='loop'`: bip do di qua cung bo dem nhip (khong con gui thang), de nguon duoc dem rieng
        // trong dong `[audiosrc]` va de "mot khung 20 ms -> mot goi".
        sendToDevice(dev, b >= 0 ? tone(20, 1000, 0.35, (at - plan[b]) * SAMPLE_RATE / 1000) : Buffer.alloc(FRAME_BYTES), 'loop');
        sent++;
      }
      if (el > 7800) { clearInterval(iv); done(); }
    }, 10);
  });
  const stats = { micFrames: leg.micFrames, lost: leg.lost, ms: Date.now() - leg.startedAt };
  endCall(dev);
  // Ban thu tho (chan doan): /tmp/call-loop-aec<0|1>.raw (s16le mono 16 kHz) trong container.
  import('node:fs').then((fs) => fs.promises.writeFile(`/tmp/call-loop-aec${aec ? 1 : 0}.raw`, Buffer.concat(raw))).catch(() => { });
  if (!aec) broadcaster.sendDeviceControl(dev, ControlField.Aec, 1);   // tra ve mac dinh (bat khu vong)
  return { dev, aec, ...stats, ...analyze(frames, beepAt) };
}

// ── (05/12/2026) BO PHAT THU NGHIEM: tep WAV co dinh -> loa man, khong can cuoc goi that ─────────────────────────
/**
 * Phep do "duong phat" tren P4 bang tep CO DINH (`POST /call/test/play`).
 *
 * Vi sao khong dung cuoc goi that: doi tuong can do la DUONG XUONG LOA (AGC/EQ/nhip/pacer/buffer cua P4), khong phai
 * micro cua dien thoai. Bo cuoc goi ra khoi phep do thi moi lan chay lai cho ra cung mot dau vao -> so sanh duoc
 * `frames`/`dropped`/`[audio]`/`[audio-diag]` giua hai lan bat/tat AGC, EQ, pace.
 *
 * Di DUNG duong that: `sendToSpeaker()` (EQ -> AGC -> [HA MAU 8 kHz] -> MONO->STEREO -> pacer ->
 * broadcaster.sendAudioFrame), KHONG
 * tao call record (`startCall` khong duoc goi => khong co `[call]`, khong bat ControlField.Call, khong dung mic cua
 * man). Tep mau van la MONO 16 kHz (dung dinh dang trang goi gui len) nen bai do di qua dung chuoi xu ly that:
 * 640 B mono vao -> **1280 B stereo ra**, 20 ms/goi (xem src/audioStereo.ts).
 * Man phai dang ket noi WS voi server (`connectedScreens()`), neu khong `broadcaster.sendAudioFrame` khong co socket
 * nao de gui -> `dropped` tang, va do la thong tin that (khong phai loi).
 */
export interface TestPlayResult {
  ok: true;
  dev: string;
  file: string;
  /** So khung 20 ms DA GUI xuong socket (khong tinh khung bi bo). */
  frames: number;
  /** So khung bi bo (hang doi day / socket nghen / gui loi) — xem src/audioPacer.ts. */
  dropped: number;
  /** Thoi gian tu khung dau toi khi hang doi nhip rong (ms). */
  ms: number;
  loop: number;
  agc: boolean;
  eq: boolean;
  gain: number;
  /** (06/12/2026) Duong xuong man gui STEREO (1280 B/goi) hay MONO (640 B/goi, A/B `CCR_CALL_STEREO=0`). */
  stereo: boolean;
  /** So byte cua MOT goi gui xuong man (1280 stereo / 640 mono / 320 khi bat 8 kHz mono / 640 khi 8 kHz stereo). */
  frameBytes: number;
  /** (07/12/2026) Tan so lay mau THAT SU gui xuong man: 8000 khi bat `CCR_CALL_RATE8K`, nguoc lai 16000. */
  rate: number;
  /** (07/12/2026) `CCR_CALL_RATE8K=1`? (ha mau 16 kHz -> 8 kHz truoc khi gui — xem src/audioResample8k.ts). */
  rate8k: boolean;
  /** So nhip bi tre qua muc bu (event loop cua server bi chan) — "giat do server". */
  late: number;
}

export interface TestPlayOptions {
  dev: string;
  file: string;
  loop?: number;
  agc?: boolean;
  eq?: boolean;
  gainDb?: number;
}

/** Moi man chi MOT phep phat cung luc (hai luong cung bom vao mot loa la vo nghia va lam sai so lieu). */
const playing = new Map<string, { aborted: boolean }>();

/** Cho hang doi nhip cua `dev` rong (toi da `timeoutMs`) — de `frames`/`dropped` tinh ca cac khung con dang xep. */
async function waitPacerIdle(dev: string, timeoutMs = 300): Promise<void> {
  const t0 = Date.now();
  while (framePacer.stats(dev).queued > 0 && Date.now() - t0 < timeoutMs) {
    await new Promise<void>((ok) => setTimeout(ok, 10));
  }
}

/** Phat `file` ra loa cua `dev` theo nhip 20 ms/khung; tra so lieu do duoc (xem TestPlayResult). */
export async function playTestAudio(o: TestPlayOptions): Promise<TestPlayResult> {
  if (playing.has(o.dev)) throw new Error(`${o.dev} dang phat mot tep thu nghiem khac`);
  const { name, wav } = loadTestAudio(o.file, fs);
  const loop = Math.max(1, Math.min(600, Math.round(o.loop ?? 1)));
  const agcOn = o.agc ?? AGC_ENABLED;
  const eqOn = o.eq ?? EQ_ENABLED;
  const gainDb = o.gainDb ?? 0;
  const signal = { aborted: false };
  playing.set(o.dev, signal);
  framePacer.forget(o.dev);                // so lieu sach cho lan phat nay
  forgetPacerSrc(o.dev);                   // (09/12/2026) nhan nguon sach
  agc.delete(o.dev);                       // gain bat dau tu 0 (khong keo gain cu cua cuoc goi truoc)
  eqs.delete(o.dev);                       // trang thai EQ sach
  resamplers.delete(o.dev);                // (07/12/2026) trang thai loc 8 kHz sach (bat dau tu im lang)
  drops.delete(o.dev);
  // (09/12/2026) SUA LOI "49 KB/s trong khi le ra 32 KB/s": phep do phat tep mau qua `sendToSpeaker()` (32 KB/s) NHUNG
  // khong mo call record, nen `callHold` khong co `dev` -> src/audioCapture.ts van bom them tieng Chrome/PulseAudio
  // (1280 B/40 ms = 32 KB/s) vao CUNG cai loa do. Nay phep do GIU loa (hold) trong suot thoi gian phat: nguon `web`
  // bi tu choi (`sendPanelAudio`) => chi con MOT duong gui, dong `[audiosrc]` chi ra `speaker=<n> ... web=0`.
  holdVoice(o.dev);
  testMeters.add(o.dev);                   // in `[audio] ...` moi 2 s du KHONG co cuoc goi — day la bang chung do
  meters.start(o.dev);
  meterTimer();
  const t0 = Date.now();
  try {
    const r = await playPaced({
      pcm: wav.data,
      loop,
      send: (frame) => sendToSpeaker(o.dev, frame, { agc: agcOn, eq: eqOn, gainDb }),
      signal,
    });
    await waitPacerIdle(o.dev);
    const st = framePacer.stats(o.dev);
    const last = meters.get(o.dev)?.flush(Date.now());     // chot cua so cuoi (< 2 s) de khong mat so lieu
    if (last) console.log(last.line);
    const ms = Date.now() - t0;
    // (06/12/2026) Log kem `stereo=`/`frame=` de bai do khang dinh DUNG dinh dang goi da gui (1280 B/20 ms stereo
    // so voi 640 B mono truoc day) — day la bang chung A/B, khong phai suy doan tu ma nguon.
    console.log(`[test] play dev=${o.dev} file=${name} frames=${st.frames} dropped=${st.dropped} ` +
      `loop=${loop} agc=${agcOn ? 1 : 0} eq=${eqOn ? 1 : 0} gain=${gainDb} ` +
      `stereo=${STEREO_ENABLED ? 1 : 0} frame=${framePacer.bytesPerFrame} ms=${ms} late=${r.lateTicks} ` +
      `rate=${SPEAKER_RATE_HZ}`);
    return {
      ok: true, dev: o.dev, file: name, frames: st.frames, dropped: st.dropped, ms, loop,
      agc: agcOn, eq: eqOn, gain: gainDb, stereo: STEREO_ENABLED, frameBytes: framePacer.bytesPerFrame, late: r.lateTicks,
      rate: SPEAKER_RATE_HZ, rate8k: RATE8K_ENABLED,
    };
  } finally {
    playing.delete(o.dev);
    testMeters.delete(o.dev);
    meters.stop(o.dev);
    resamplers.delete(o.dev);              // (07/12/2026) giai phong trang thai loc 8 kHz
    framePacer.forget(o.dev);
    forgetPacerSrc(o.dev);                 // (09/12/2026) giai phong nhan nguon
    releaseVoice(o.dev);                   // (09/12/2026) tra loa lai: tieng Chrome duoc phep quay lai (neu dang bat)
  }
}

/** Dung phep phat dang chay cua `dev` (vd. thiet bi ngat / nguoi do bam dung). */
export function stopTestAudio(dev: string): boolean {
  const s = playing.get(dev);
  if (!s) return false;
  s.aborted = true;
  return true;
}

// ── HTTP + WS ────────────────────────────────────────────────────────────────────────────────────────────────
const isLocal = (req: http.IncomingMessage) => /^(::ffff:)?127\.0\.0\.1$|^::1$/.test(req.socket.remoteAddress || '');
const isIngress = (req: http.IncomingMessage) => (req.socket.remoteAddress || '').replace(/^::ffff:/, '') === '172.30.32.2';
function json(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
export function callableScreens(): { id: string; w: number; h: number; busy: boolean }[] {
  return connectedScreens().filter((s) => s.mic && s.spk).map((s) => ({ id: s.id, w: s.w, h: s.h, busy: calls.has(s.id) }));
}

/** true = da xu ly request. */
export function handleCallApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL): boolean {
  const p = url.pathname;
  if (!p.startsWith('/call/')) return false;
  if (!isLocal(req) && !isIngress(req)) { json(res, 403, { error: 'Chỉ dùng trong Home Assistant.' }); return true; }
  if (p === '/call/devices' && req.method === 'GET') { json(res, 200, callableScreens()); return true; }
  if (p === '/call/test/loop' && req.method === 'POST' && isLocal(req)) {
    const dev = url.searchParams.get('dev') || '';
    if (!callableScreens().some((s) => s.id === dev)) { json(res, 404, { error: 'man khong goi duoc' }); return true; }
    loopTest(dev, url.searchParams.get('aec') !== '0').then((r) => json(res, 200, r)).catch((e) => json(res, 409, { error: (e as Error).message }));
    return true;
  }
  // (05/12/2026) BO PHAT THU NGHIEM — chi loopback hoac trang trong LAN cung origin, KHONG qua ingress: day la duong
  // bom tieng ra loa that cua mot man trong nha, khong duoc phep tu ben ngoai.
  if (p.startsWith('/call/test/play') || p.startsWith('/call/test/files')) {
    if (!isLoopback(req) && !isLanBrowser(req)) { json(res, 403, { error: 'chỉ loopback hoặc trang trong LAN' }); return true; }
    if (p === '/call/test/files' && req.method === 'GET') {
      json(res, 200, { ok: true, files: listTestAudio(fs) });
      return true;
    }
    if (p === '/call/test/play' && req.method === 'POST') {
      const dev = url.searchParams.get('dev') || '';
      if (!callableScreens().some((s) => s.id === dev)) { json(res, 404, { error: 'man khong goi duoc (chua ket noi / khong co loa)' }); return true; }
      const q = readPlayParams((k) => url.searchParams.get(k));
      playTestAudio({ dev, ...q })
        .then((r) => json(res, 200, r))
        .catch((e) => json(res, 400, { error: (e as Error).message }));
      return true;
    }
    json(res, 405, { error: 'GET /call/test/files hoac POST /call/test/play' });
    return true;
  }
  json(res, 404, { error: 'khong co' });
  return true;
}

const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 64 * 1024 });
/** Nang cap WS /call/ws va /call/video (cong HEALTH_PORT). true = da nhan. */
export function handleCallUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): boolean {
  const url = new URL(req.url || '/', 'http://x');
  if (url.pathname.endsWith('/call/video')) return videoUpgrade(req, socket, head, url);
  if (!url.pathname.endsWith('/call/ws')) return false;
  if (!isLocal(req) && !isIngress(req)) { socket.destroy(); return true; }
  const dev = url.searchParams.get('dev') || '';
  wss.handleUpgrade(req, socket, head, (ws) => {
    if (!callableScreens().some((s) => s.id === dev)) { ws.close(4004, 'man khong goi duoc'); return; }
    const leg = startCall(dev);
    if (!leg) { ws.close(4009, 'man dang ban'); return; }
    leg.peers.add(ws);
    ws.on('message', (data, isBinary) => { if (isBinary) sendToDevice(dev, data as Buffer, 'device'); });
    ws.on('close', () => { leg.peers.delete(ws); if (calls.get(dev) === leg) endCall(dev); });
    ws.on('error', () => { /* close xu ly */ });
  });
  return true;
}

/** Hinh camera man qua WS. Mang cham (dem > 1 MB): bo khung thuong toi khung khoa ke tiep (khong de tre don lai). */
function videoUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer, url: URL): boolean {
  if (!isLocal(req) && !isIngress(req)) { socket.destroy(); return true; }
  const dev = url.searchParams.get('dev') || '';
  // (17/11/2026) GD9 — SUA LOI "P4 KHONG NHAN DUOC HINH khi goi dien thoai": trang P4 lay `peer` tu /calls/state;
  // trong khoang app da POST /app/answer nhung trang call-web.html?call= CHUA kip `join`, `state.to` van la ID MAY,
  // nen P4 mo `/call/video?dev=<id may>` -> khong phai phien web / khong phai man co camera -> server dong 4004 va
  // P4 chi hien "Đang kết nối hình…" mai mai (du tieng van chay).
  // Nay: (a) id may duoc anh xa sang phien web dang giu cuoc goi cua may do (videoSourceOf), va (b) neu dien thoai
  // CHUA join thi giu socket lai ~8 s, tu gan nguon ngay khi phien web xuat hien (khong bat trang phai doan lai).
  if (!isDoor(dev) && !isWebSource(dev) && !connectedScreens().some((s) => s.id === dev && s.cam) && !isCallParty(dev)) {
    wss.handleUpgrade(req, socket, head, (ws) => ws.close(4004, 'nguon khong co camera'));
    return true;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    // (14/10/2026) ?call=<id>: hinh trong cuoc goi video — chi gui khi cuoc goi dang chay va nguon khong tat camera.
    const callId = url.searchParams.get('call');
    let unsub = (): void => { };
    let src = '';
    let sent = 0, dropped = 0, skip = false;
    const t0 = Date.now();
    /** Gan nguon hinh that su; false = nguon chua san sang (dien thoai chua `join`). */
    const attach = (): boolean => {
      const s = videoSourceOf(dev);
      const door = isDoor(s), web = isWebSource(s);
      if (!door && !web && !connectedScreens().some((x) => x.id === s && x.cam)) return false;
      src = s;
      if (s !== dev) console.log(`[call] ${dev}: xem hinh qua phien web ${s}`);
      unsub = (door ? subscribeDoorFrames : web ? subscribeWebFrames : subscribeLiveFrames)(s, (e) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (callId && e.kind === 'frame' && !videoAllowed(callId, s)) { skip = true; return; }
        if (e.kind === 'config') { ws.send(JSON.stringify({ codec: e.codec, avcc: e.avcc.toString('base64') })); return; }
        if (ws.bufferedAmount > 1024 * 1024) skip = true;
        if (skip && !e.key) { dropped++; return; }
        skip = false;
        const h = Buffer.alloc(5);
        h.writeUInt8(e.key ? 1 : 0, 0); h.writeUInt32LE(e.ts >>> 0, 1);
        ws.send(Buffer.concat([h, e.data])); sent++;
      });
      console.log(`[call] ${dev}: xem hinh camera (nguon ${s})`);
      return true;
    };

    let wait: NodeJS.Timeout | null = null;
    if (!attach()) {
      // Dien thoai da nghe nhung trang goi chua kip `join` (thuong < 2 s) -> cho toi 8 s.
      let waited = 0;
      wait = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) { clearInterval(wait!); wait = null; return; }
        if (attach()) { clearInterval(wait!); wait = null; return; }
        waited += 400;
        if (waited >= 8_000) {
          clearInterval(wait!); wait = null;
          console.log(`[call] ${dev}: khong tim thay nguon hinh sau 8 s — dong`);
          ws.close(4004, 'chua co nguon hinh');
        }
      }, 400);
    }
    ws.on('close', () => {
      if (wait) { clearInterval(wait); wait = null; }
      unsub();
      console.log(`[call] ${dev}: ngung xem hinh sau ${Math.round((Date.now() - t0) / 1000)} s — gui ${sent} khung, bo ${dropped}`);
    });
    ws.on('error', () => { /* close xu ly */ });
  });
  return true;
}
