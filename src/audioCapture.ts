// SPDX-License-Identifier: Apache-2.0
//
// Copyright (c) 2026 minhquanghp86 - Apache License 2.0 (see LICENSE).

// (23/09/2026) Bat am thanh Chrome dua ra qua sink PulseAudio ao (xem
// docker-entrypoint.sh), phat lai qua WebSocket cho thiet bi da bao co loa
// (cfg.audioEnabled — xem config.ts, ensureDeviceAsync). Kien truc: MOT
// tien trinh Chrome dung chung cho ca ba thiet bi -> MOT sink audio duy
// nhat -> khong the tach am thanh theo tung tab/thiet bi (da xac minh khong
// co API nao lam duoc dieu nay tu ben ngoai trang — xem
// AUDIO-FEATURE-PLAN-2026-09-23.md muc 7.2 o repo Client). Vi vay module
// nay CHI gui cho cac thiet bi TU KHAI BAO audioEnabled=true (hien tai:
// chi P4) — khong co logic "chon thiet bi dang hoat dong" vi pham vi hien
// tai chi co dung mot dich.
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
// (09/12/2026) DUONG GUI THU HAI da bi tim ra — xem src/audioOut.ts. Tieng Chrome/PulseAudio truoc day goi thang
// `broadcaster.sendAudioFrame()` cho MOI man dang ky, va CHI bi chan boi `callHold` (dat trong `startCall()`). Phep do
// `POST /call/test/play` khong mo call record, nen no van bom ~32 KB/s vao dung cai loa dang phat tep mau: do tren P4
// la 49 KB/s thay vi 32 KB/s. Nay di qua cong `sendPanelAudio(..., 'web')`: bi tu choi khi man dang GIU loa cho tieng
// nguoi (`holdVoice` tu `startCall()` / `playTestAudio()`, hoac vua nhan tieng nguoi trong 250 ms).
import { sendPanelAudio } from './audioOut.js';
// (09/12/2026) `callHold` nay song trong src/audioOut.ts — tai xuat o day de moi cho doc cu (`callHold.has(...)`) khong
// phai doi; viec CHAN that su nam trong `sendPanelAudio()`.
export { callHold } from './audioOut.js';

const PULSE_MONITOR_SOURCE = process.env.PULSE_AUDIO_MONITOR || 'chrome_out.monitor';
const AUDIO_SAMPLE_RATE = 16000;
const AUDIO_CHANNELS = 1;
const AUDIO_BITS = 16;
// (23/09/2026) Kich thuoc khung gui ~40ms/goi (16000 * 2 byte/mau * 0.04s =
// 1280 byte) — du nho de khong tao do tre lon, du lon de khong lam ngap so
// luong goi WS/giay (25 goi/s, tuong duong nhip video luc tai vua phai).
const FRAME_BYTES = Math.round(AUDIO_SAMPLE_RATE * (AUDIO_BITS / 8) * AUDIO_CHANNELS * 0.04);

let captureProc: ChildProcessWithoutNullStreams | null = null;
// (23/09/2026 v2) SUA LOI THAT DA GAP: dat captureProc = null NGAY sau khi
// goi .kill() (khong doi su kien 'exit' that su) tao ke ho — neu thiet bi
// disconnect/reconnect rat nhanh (do that: 309ms), startCapture() moi thay
// captureProc == null nen spawn tien trinh THU HAI trong khi tien trinh CU
// co the con dang giu nguon PulseAudio (chua kip don xong sau SIGTERM) ->
// tien trinh moi bi tu choi, thoat ngay voi code 255. Sua: KHONG null hoa
// captureProc trong stopCapture(); chi handler 'exit' (xac nhan tien trinh
// THAT SU da ket thuc) moi duoc phep null hoa va (neu can) khoi dong lai.
let stopping = false;
let restartTimer: NodeJS.Timeout | null = null;
const subscribers = new Set<string>();
/** (14/10/2026) INTERCOM: man dang trong cuoc goi — KHONG gui tieng Chrome (tieng cuoc goi di rieng, src/callBridge.ts).
 *  (09/12/2026) Tap nay nay song trong src/audioOut.ts (`callHold`, dem tham chieu qua `holdVoice`/`releaseVoice`) va
 *  duoc tai xuat o day de moi cho doc cu van dung; viec CHAN that su nam trong `sendPanelAudio()`. */

// (23/09/2026 v8) SUA LOI THAT DA GAP: truoc day feedChunk() gui NGAY moi
// khi ffmpeg co du lieu — nhung PulseAudio/ffmpeg khong giao du lieu deu,
// ma theo tung DOT LON cach nhau ~2s (do that, xem CHANGELOG V2.9.11/13).
// Gui thang nghia la firmware nhan CA DOT (hang chuc goi) don don trong
// vai chuc ms roi IM LANG ~2s — hang doi phia thiet bi (dau da tach rieng,
// sau 30) van bi TRAN ngay tai moi dot ("hang doi day, rot goi" do that).
//
// Sua tan goc: bo dem jitter (jitterBuf) + nhip gui CO DINH moi
// FRAME_MS bang setInterval — accumulateFromSource() CHI gom du lieu vao
// bo dem, KHONG gui gi ca; drainTick() (chay dung nhip, doc lap voi luc
// ffmpeg giao du lieu) moi thuc su cat 1 khung va gui di. Nho vay thiet bi
// luon nhan dung nhip ~25 goi/giay bat ke nguon giao don hay deu, giong
// het vai tro "jitter buffer" chuan trong moi he thong streaming audio.
const FRAME_MS = 40;
// (23/09/2026 v10) ~1s -> ~200ms. Bo dem cang lon thi am thanh cang di SAU
// hinh: 1 giay o day CONG THEM 1 giay cua buffer_duration phia loa (da ha
// xuong 250ms) lam tieng tre han so voi video — nguoi dung bao "ca video lan
// am thanh deu lag". 200ms du hap thu do giat cua mang/WS ma do lech con
// gan nhu khong nhan ra.
const MAX_JITTER_BYTES = FRAME_BYTES * 5;
let jitterBuf: Buffer = Buffer.alloc(0);
let jitterTimer: NodeJS.Timeout | null = null;

// (25/09/2026) Chan doan "tieng tach tach" khi xem YouTube: dem moi cho co the lam DUT song am phia server.
const diag = { trims: 0, trimmedBytes: 0, framesSent: 0, maxTickGapMs: 0, lateTicks: 0, maxBufBytes: 0, lastTickMs: 0, lastLogMs: 0 };

function accumulateFromSource(chunk: Buffer): void {
  if (subscribers.size === 0) return; // khong ai can nghe -> bo qua (khong ton CPU/RAM dem)
  jitterBuf = jitterBuf.length ? Buffer.concat([jitterBuf, chunk]) : chunk;
  if (jitterBuf.length > MAX_JITTER_BYTES) {
    // nguon dang giao nhanh hon toc do phat that su cua thiet bi (vd sau
    // mot khoang gian doan mang) — cat bot phan CU nhat, giu do tre thap
    // thay vi de bo dem phinh to va am thanh ngay cang tre so voi hinh.
    diag.trims++;
    diag.trimmedBytes += jitterBuf.length - MAX_JITTER_BYTES;
    jitterBuf = jitterBuf.subarray(jitterBuf.length - MAX_JITTER_BYTES);
  }
  if (jitterBuf.length > diag.maxBufBytes) diag.maxBufBytes = jitterBuf.length;
}

/**
 * (09/12/2026) MOT CHO DUY NHAT gui tieng Chrome/PulseAudio xuong loa mot man.
 *
 * Day chinh la "duong gui audio thu hai" da tim ra khi do tren P4 (49 KB/s thay vi 32 KB/s khi chay
 * `POST /call/test/play`): truoc day ham nay goi thang `broadcaster.sendAudioFrame(id, frame)` va chi bi chan boi
 * `callHold` — ma `callHold` chi duoc dat trong `startCall()`, con phep do phat tep mau thi khong mo call record.
 *
 * Nay di qua cong `sendPanelAudio(id, frame, 'web')` (src/audioOut.ts):
 *   - man dang GIU loa cho tieng nguoi (`holdVoice` tu `startCall()` / `playTestAudio()`) -> TU CHOI (`false`);
 *   - man VUA nhan tieng nguoi (<= 250 ms) -> cung TU CHOI (khong xen tieng Chrome giua hai khung tieng nguoi);
 *   - moi khung duoc dem vao nguon `web` cua dong `[audiosrc]`, nen "nguon thu hai" tro thanh so lieu do duoc.
 */
export function sendCapturedFrame(id: string, frame: Buffer): boolean {
  return sendPanelAudio(id, frame, 'web');
}

function drainTick(): void {
  const now = Date.now();
  if (diag.lastTickMs) {
    const gap = now - diag.lastTickMs;
    if (gap > diag.maxTickGapMs) diag.maxTickGapMs = gap;
    if (gap > FRAME_MS * 1.5) diag.lateTicks++;
  }
  diag.lastTickMs = now;
  if (subscribers.size > 0 && now - diag.lastLogMs >= 30_000) {
    if (diag.lastLogMs) {
      console.log(`[audio-diag] 30s: gui ${diag.framesSent} khung (le ra ~750), CAT ${diag.trims} lan/${diag.trimmedBytes} B, ` +
        `nhip tre ${diag.lateTicks} lan (max ${diag.maxTickGapMs} ms), dem max ${diag.maxBufBytes} B`);
    }
    Object.assign(diag, { trims: 0, trimmedBytes: 0, framesSent: 0, maxTickGapMs: 0, lateTicks: 0, maxBufBytes: 0, lastLogMs: now });
  }
  if (subscribers.size === 0) return;
  // (25/09/2026) GUI MOI KHUNG DA DU, khong chi mot khung/nhip. Do that (log [audio-diag]): setInterval(40) chay trung
  // binh ~41 ms -> 732 khung/30 s thay vi 750 -> gui 31,2 KB/s trong khi nguon 32 KB/s -> bo dem day va bi CAT ~190
  // lan/30 s (24 KB) — MOI LAN CAT LA MOT TIENG "TACH" (nguoi dung nghe tach tach lien tuc khi xem YouTube; nguon
  // Chrome/PulseAudio da do la sach). Gui het phan da du thi tre nhip khong con don thanh thieu hut.
  while (jitterBuf.length >= FRAME_BYTES) {
    const frame = jitterBuf.subarray(0, FRAME_BYTES);
    jitterBuf = jitterBuf.subarray(FRAME_BYTES);
    // (09/12/2026) `framesSent` gio chi dem khung THUC SU xuong duoc loa (nguon `web` bi chan khi man dang co tieng
    // nguoi) — nho vay dong `[audio-diag]` khong con bao "da gui" cho nhung khung bi tu choi.
    let any = false;
    for (const id of subscribers) if (sendCapturedFrame(id, frame)) any = true;
    if (any) diag.framesSent++;
  }
}

function startCapture(): void {
  // Dang co tien trinh song, HOAC dang doi tien trinh cu thoat han (SIGTERM
  // vua gui) — nhanh nay se duoc goi lai tu handler 'exit' khi that su san
  // sang, khong spawn chong len tien trinh cu.
  if (captureProc || stopping) return;

  console.log(`[audio] Bat dau bat am thanh tu ${PULSE_MONITOR_SOURCE} (${AUDIO_SAMPLE_RATE}Hz/${AUDIO_BITS}bit/${AUDIO_CHANNELS}ch)`);

  // (23/09/2026 v11) DOI TU ffmpeg SANG parec — DO THAT, khong suy luan:
  // do nhip giao du lieu cua ca hai tren chinh may nay, cung mot nguon, 8s:
  //     ffmpeg : 2 mang / 8s, khoang cach 1994ms va 1995ms, 63900B moi mang
  //     parec  : 356 mang / 8s, khoang cach trung binh 22ms (max 26ms), ~742B
  //     toc do : ffmpeg 23.959 B/s (THIEU 25%) | parec 31.949 B/s (= dung
  //              thoi gian thuc: 16000 mau * 2 byte = 32.000 B/s)
  //
  // ffmpeg chi nha du lieu MOI ~2 GIAY MOT CUC LON. Khong bo dem nao cuu
  // duoc dieu do tru khi dem >= 2 giay — ma nhu vay thi tieng di sau hinh
  // 2 giay, con te hon. Day chinh la nguon goc tieng "tach" deu dan moi 2
  // giay: giua hai cuc, ring buffer phia loa can kiet -> i2s speaker
  // "Stopped" -> cuc moi toi lai "Starting" -> moi lan dung/chay sinh mot
  // transient nghe thanh tieng tach.
  //
  // parec la cong cu GOC cua PulseAudio cho dung viec nay: xuat PCM tho,
  // khong qua tang muxer/timestamp nao, va --latency-msec chi dinh thang do
  // tre mong muon. Da co san trong image (goi pulseaudio-utils).
  const proc = spawn('parec', [
    `--device=${PULSE_MONITOR_SOURCE}`,
    '--format=s16le',
    `--rate=${AUDIO_SAMPLE_RATE}`,
    `--channels=${AUDIO_CHANNELS}`,
    '--latency-msec=40',
  ]);
  captureProc = proc;
  jitterBuf = Buffer.alloc(0);
  if (!jitterTimer) jitterTimer = setInterval(drainTick, FRAME_MS);

  proc.stdout.on('data', accumulateFromSource);
  proc.stderr.on('data', (d: Buffer) => console.warn(`[audio] parec: ${d.toString().trim()}`));

  proc.on('exit', (code, signal) => {
    const wasDeliberate = stopping; // ta tu kill() de dung/khoi dong lai, khong phai loi that
    console.warn(`[audio] parec thoat (code=${code}, signal=${signal}, chu dong=${wasDeliberate})`);
    captureProc = null;
    stopping = false;
    jitterBuf = Buffer.alloc(0);

    if (subscribers.size === 0) return; // khong ai can nghe nua -> khong khoi dong lai

    if (restartTimer) return; // da co lich khoi dong lai roi
    // Thoat CHU DONG (ta vua kill de restart nhanh, vd do subscriber doi
    // lien tuc) -> thu lai gan nhu ngay. Thoat NGOAI Y MUON (loi that,
    // PulseAudio gian doan...) -> doi lau hon, tranh vong lap loi lien tuc.
    const delayMs = wasDeliberate ? 200 : 3000;
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (subscribers.size > 0) startCapture();
    }, delayMs);
  });

  proc.on('error', (err) => {
    console.error(`[audio] Khong chay duoc parec: ${err.message}`);
    captureProc = null;
    stopping = false;
  });
}

function stopCapture(): void {
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  if (jitterTimer) { clearInterval(jitterTimer); jitterTimer = null; }
  if (captureProc && !stopping) {
    console.log('[audio] Dung bat am thanh (khong con thiet bi nao can nghe)');
    stopping = true;
    captureProc.kill('SIGTERM');
    // KHONG null hoa captureProc o day — xem chu thich o dau file.
  }
  jitterBuf = Buffer.alloc(0);
}

export function subscribeDeviceAudio(id: string): void {
  if (subscribers.has(id)) return;
  subscribers.add(id);
  console.log(`[audio] ${id} dang ky nhan audio (${subscribers.size} thiet bi)`);
  startCapture();
}

export function unsubscribeDeviceAudio(id: string): void {
  if (!subscribers.delete(id)) return;
  console.log(`[audio] ${id} huy dang ky nhan audio (${subscribers.size} thiet bi con lai)`);
  if (subscribers.size === 0) stopCapture();
}
