// SPDX-License-Identifier: Apache-2.0
//
// Copyright (c) 2026 minhquanghp86
// Licensed under the Apache License, Version 2.0 (see LICENSE).

// (09/12/2026) MOT CONG DUY NHAT de gui PCM xuong LOA MAN + bo dem theo NGUON.
//
// BANG CHUNG DO TREN P4 THAT (ban 2.9.321, mixer 1 kenh, 16 kHz mono): bai do `POST /call/test/play` ghi
//   1617 goi / 30 s (le ra 1500 = 50 goi/s), 1.472.640 B vao / 30 s = 49 KB/s (le ra 32 KB/s voi 640 B/20 ms),
//   loa tieu thu 32,9 KB/s => CO THEM MOT DUONG GUI AUDIO THU HAI bom ~17 KB/s vao CUNG mot loa.
// Bo dem nhip (src/audioPacer.ts) da dung 1 goi/20 ms, nen thu phai tim o cho KHAC: trong ma nguon co DUNG BA cho
// goi `broadcaster.sendAudioFrame()` cho mot man:
//   1. src/callBridge.ts  `sendToSpeaker()` -> bo dem nhip            -> tieng nguoi / phep do (DUONG CHINH, co nhip);
//   2. src/callBridge.ts  `sendToDevice()`  -> gui NGAY, tu chia 640 B -> trang thu `/call/ws` + bip do vong lap;
//   3. src/audioCapture.ts `drainTick()`    -> tieng Chrome/PulseAudio  -> gui NGAY, 1280 B/40 ms = 32 KB/s.
// Cho (3) CHI bi chan boi `callHold` (dat trong `startCall()`), nen khi chay `/call/test/play` (KHONG mo call record)
// no van bom them ~32 KB/s vao dung cai loa dang phat tep mau => 49-64 KB/s thay vi 32 KB/s. Do la duong GUI TRUNG.
//
// Module nay gom ca ba duong ve MOT cong `sendPanelAudio()` va dat LUAT: moi man chi co MOT duong "tieng nguoi"
// tai mot thoi diem.
//   - `holdVoice(dev)` / `releaseVoice(dev)`: man dang co duong tieng nguoi (cuoc goi, phep do) — dem tham chieu
//     (`startCall`/`endCall`, `playTestAudio` co the chong nhau);
//   - `sendPanelAudio(dev, frame, 'web')` (tieng Chrome) bi TU CHOI khi man dang duoc giu hoac VUA moi nhan tieng
//     nguoi (`GRACE_MS`) — khong con canh "32 KB/s tieng nguoi + 32 KB/s tieng Chrome" tren cung mot loa;
//   - bo dem theo nguon + dong log moi 5 s (yeu cau cua phep do):
//       `[audiosrc] speaker=<n> device=<n> loop=<n> web=<n> kb/s=<...>`
//     `speaker` = qua bo dem nhip (tieng nguoi + `/call/test/play`), `device` = `sendToDevice()` (trang thu /call/ws),
//     `loop` = `POST /call/test/loop`, `web` = tieng Chrome/PulseAudio (src/audioCapture.ts).
//     `kb/s` = tong byte THAT SU giao cho socket trong cua so / thoi gian cua so (1 KB = 1000 B, khop voi cach noi
//     "32 KB/s" = 32.000 B/s cua 16 kHz mono s16le).
// Nho mot cong duy nhat, "gui trung" tro thanh mot loi duy nhat co the dem duoc (`blocked`) thay vi mot gia thuyet.
import { broadcaster } from './deviceManager.js';

/** Nguon gui PCM xuong loa man — moi nguon co mot bo dem rieng trong dong `[audiosrc]`. */
export type AudioSource = 'speaker' | 'device' | 'loop' | 'web';

/** Cua so ghi dong `[audiosrc]` (ms) — dung nhu yeu cau cua phep do: mot dong moi 5 s. */
export const AUDIOSRC_LOG_MS = 5000;
/**
 * Man VUA nhan tieng nguoi trong bao lau thi tieng Chrome (nguon `web`) van bi chan (ms).
 * 250 ms = 5 khung 20 ms: du de khong xen ke giua hai khung tieng nguoi khi bo dem nhip dang rong (im lang).
 */
export const VOICE_GRACE_MS = 250;

/** Bat/tat gui tieng Chrome xuong man (mac dinh TAT — tranh man tu phat tieng khi khong co cuoc goi). */
export const MIRROR_AUDIO = /^(1|on|true|yes)$/i.test((process.env.CCR_MIRROR_AUDIO || '').trim());
if (!process.env.VITEST) console.log(`[audio] mirror=${MIRROR_AUDIO ? 'on' : 'off'}`);

const frames: Record<AudioSource, number> = { speaker: 0, device: 0, loop: 0, web: 0 };
const bytes: Record<AudioSource, number> = { speaker: 0, device: 0, loop: 0, web: 0 };
/** So khung tieng Chrome bi TU CHOI vi man dang co tieng nguoi (chan doan "gui trung da bi chan"). */
let blocked = 0;
let winStart = 0;
let timer: NodeJS.Timeout | null = null;

/** Man -> moc (ms) lan cuoi nhan tieng nguoi (speaker/device/loop). */
const lastVoiceAt = new Map<string, number>();
/** Man -> so lan `holdVoice()` chua duoc `releaseVoice()` (cuoc goi + phep do co the chong nhau). */
const holds = new Map<string, number>();

/**
 * Tap man dang GIU loa cho tieng nguoi. Truoc day tap nay nam trong src/audioCapture.ts; nay chuyen ve day de
 * `sendPanelAudio()` tu kiem duoc ma khong phu thuoc vong import (audioCapture -> audioOut, mot chieu).
 */
export const callHold = new Set<string>();

/** Giu loa cua `dev` cho tieng nguoi (dem tham chieu — goi lai nhieu lan duoc). */
export function holdVoice(dev: string): void {
  if (!dev) return;
  holds.set(dev, (holds.get(dev) ?? 0) + 1);
  callHold.add(dev);
}

/** Nha loa cua `dev` (chi nha khi da `releaseVoice()` du so lan `holdVoice()`). */
export function releaseVoice(dev: string): void {
  const n = (holds.get(dev) ?? 1) - 1;
  if (n > 0) { holds.set(dev, n); return; }
  holds.delete(dev);
  callHold.delete(dev);
  lastVoiceAt.delete(dev);
}

/** `dev` co dang giu loa cho tieng nguoi khong. */
export function voiceHeld(dev: string): boolean { return callHold.has(dev); }

/**
 * CONG DUY NHAT: gui MOT goi PCM xuong loa man `dev`, ghi so lieu theo `src`.
 *
 * Tra `false` = KHONG gui (man dang giu tieng nguoi ma nguon la tieng Chrome / socket tu choi) — dung nhu
 * `broadcaster.sendAudioFrame()`, nen bo dem nhip van dem dung `dropped`.
 */
export function sendPanelAudio(dev: string, frame: Buffer, src: AudioSource = 'speaker'): boolean {
  const now = Date.now();
  // (01/11/2026) Tieng Chrome/PulseAudio CHI gui khi duoc BAT TUONG MINH (CCR_MIRROR_AUDIO=1).
  // Mac dinh TAT: truoc day P4 phat tieng cua trinh duyet 24/7 du khong co cuoc goi/app nao mo.
  if (src === 'web' && !MIRROR_AUDIO) return false;
  if (src === 'web' && (callHold.has(dev) || now - (lastVoiceAt.get(dev) ?? -Infinity) <= VOICE_GRACE_MS)) {
    blocked++;                                     // tieng Chrome KHONG duoc xen vao loa dang co tieng nguoi
    return false;
  }
  if (src !== 'web') lastVoiceAt.set(dev, now);
  const ok = broadcaster.sendAudioFrame(dev, frame) !== false;
  if (ok) { frames[src]++; bytes[src] += frame.length; }
  if (!winStart) winStart = now;
  armTimer();
  return ok;
}

/** Bat hen gio log neu chua co. Trong test (VITEST) khong hen gio: doc so lieu qua `audioSrcStats()`/`audioSrcLine()`. */
function armTimer(): void {
  if (timer || process.env.VITEST) return;
  timer = setInterval(() => {
    const line = flush(Date.now());
    if (line) console.log(line);
  }, AUDIOSRC_LOG_MS);
  timer.unref?.();                                  // khong giu tien trinh song vi bo dem
}

function stopTimer(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

/** Chot cua so: xoa bo dem + tra dong log. `null` = cua so khong co gi de bao (dung hen gio). */
function flush(now: number): string | null {
  const total = frames.speaker + frames.device + frames.loop + frames.web;
  if (!total && !blocked) { stopTimer(); winStart = 0; return null; }
  const line = audioSrcLine(now);
  for (const k of Object.keys(frames) as AudioSource[]) { frames[k] = 0; bytes[k] = 0; }
  blocked = 0;
  winStart = now;
  // Don moc "vua nhan tieng nguoi" cu de Map khong phinh khi man doi ten / ngat ket noi.
  for (const [d, at] of lastVoiceAt) if (now - at > VOICE_GRACE_MS) lastVoiceAt.delete(d);
  return line;
}

/** Dong log `[audiosrc] speaker=<n> device=<n> loop=<n> web=<n> kb/s=<...>` (khong lam thay doi bo dem). */
export function audioSrcLine(now: number = Date.now()): string {
  const ms = Math.max(1, now - (winStart || now - AUDIOSRC_LOG_MS));
  const total = bytes.speaker + bytes.device + bytes.loop + bytes.web;
  const kbs = total / (ms / 1000) / 1000;                       // 1 KB = 1000 byte -> "32 KB/s" = 32.000 B/s
  return `[audiosrc] speaker=${frames.speaker} device=${frames.device} loop=${frames.loop} web=${frames.web} ` +
    `kb/s=${kbs.toFixed(1)}`;
}

export interface AudioSrcStats {
  speaker: number;
  device: number;
  loop: number;
  web: number;
  /** Tong byte da giao cho socket trong cua so hien tai. */
  bytes: number;
  /** So khung tieng Chrome bi tu choi (gui trung da bi chan). */
  blocked: number;
  /** Do dai cua so hien tai (ms). */
  ms: number;
}

/** So lieu cua so hien tai (de test khang dinh "chi MOT nguon"). */
export function audioSrcStats(now: number = Date.now()): AudioSrcStats {
  return {
    speaker: frames.speaker, device: frames.device, loop: frames.loop, web: frames.web,
    bytes: bytes.speaker + bytes.device + bytes.loop + bytes.web, blocked,
    ms: Math.max(1, now - (winStart || now)),
  };
}

/** Xoa bo dem + hen gio (test / khi dung server). */
export function resetAudioSrc(): void {
  for (const k of Object.keys(frames) as AudioSource[]) { frames[k] = 0; bytes[k] = 0; }
  blocked = 0;
  winStart = 0;
  stopTimer();
}
