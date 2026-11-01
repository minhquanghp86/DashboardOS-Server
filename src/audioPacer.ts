// SPDX-License-Identifier: Apache-2.0
//
// Copyright (c) 2026 minhquanghp86
// Licensed under the Apache License, Version 2.0 (see LICENSE).

// (05/12/2026) NHIP GUI DEU 20 ms/khung cho nhanh XUONG LOA MAN (P4).
//
// Van de do duoc (xem bao cao "giat cuc" va src/callBridge.ts): truoc day server gui THANG moi goi PCM nhan duoc —
// `sendToSpeaker()` -> `sendToDevice()` -> `broadcaster.sendAudioFrame()` (mot goi WS rieng cho moi 640 byte), khong
// co hang doi, khong co dong ho. Nhip ra vi vay DUNG BANG nhip vao: dien thoai gui sao thi loa nhan vay, gom ca
// jitter cua Wi-Fi va ca luc trang goi "don" 2-3 khung mot lan. Phia firmware, `q_audio_` sau 30 goi nhung RING BUFFER
// cua loa chi 250 ms (i2s_audio_speaker: ring_buffer_duration = max(50 ms DMA, buffer_duration)) — mot dot 3 khung
// (60 ms) lam day ring buffer -> byte thua bi VUT (`aud_bytes_drop_`), roi ngay sau do khong con gi de phat -> loa
// duoc "va" bang im lang -> nghe GIA T CUC, HUT HOI. Do la co che "burst -> tran -> hut" cua hang doi.
//
// Module nay lam dung mot viec: nhan khung tu ben tren (co the den thanh tung dot), TRAI DEU ra mot khung moi 20 ms
// theo mot DONG HO TUYET DOI (moc t0 + k*20 ms, khong cong don sai so cua setTimeout), va DONG GIAY khi socket da don:
//   - tran hang doi `maxQueueFrames` (mac dinh 5 = 100 ms): qua thi bo khung CU NHAT -> do tre khong tich luy;
//   - tran `maxBacklogBytes` (bufferedAmount cua socket): socket dang nghen thi bo khung, khong day them;
//   - bu toi da `maxCatchUp` khung moi nhip khi event loop bi tre (khong xa hang loat 20 khung mot luc).
// Tat de A/B (quay lai dung hanh vi cu "gui ngay"): `CCR_CALL_PACE=0` (xem src/callBridge.ts).
//
// Module THUAN (khong import gi cua server, nhan `send`/`backlog`/dong ho qua tham so) nen test duoc bang vitest:
// src/audioPacer.test.ts — nhip 20 ms, khong bun no, tran hang doi, tran bufferedAmount, che do khong pace.
//
// (06/12/2026) `frameBytes` CAU HINH DUOC — nhip thi KHONG doi, luon 20 ms/nhip:
//   - 640  = 20 ms PCM s16le MONO 16 kHz  -> web <-> web, che do A/B `CCR_CALL_STEREO=0` (mac dinh cua module);
//   - 1280 = 20 ms PCM s16le STEREO 16 kHz (L = R) -> nhanh XUONG LOA MAN (xem src/audioStereo.ts).
// `frameBytes` CHI quyet dinh MOT lan `push()` dai bao nhieu byte thi thanh MOT goi; dong ho van la MOT goi moi
// `frameMs` ms. Vi vay 1280 byte/khung KHONG lam gui nhanh gap doi: 5 khung 1280 byte van ra tai 0/20/40/60/80 ms.
// Neu de sai `frameBytes` (vd. 640 trong khi nhan 1280 byte) thi mot khung 20 ms bi chia thanh HAI goi 640 byte va
// bo dem se ban hai goi moi nhip — dung cai phai tranh; src/callBridge.ts lay `SPEAKER_FRAME_BYTES` tu audioStereo.ts.

/** 20 ms/khung — KHONG doi du mono hay stereo. */
export const FRAME_MS = 20;
/** Mac dinh: 640 byte = 20 ms PCM s16le MONO 16 kHz (web <-> web). Man stereo dung 1280 (xem src/audioStereo.ts). */
export const FRAME_BYTES = 640;

export interface PacerStats {
  /** So khung da giao cho `send()` (khong tinh khung bi bo). */
  frames: number;
  /** So khung bi bo (hang doi day / socket nghen / `send()` tu choi). */
  dropped: number;
  /** So khung dang cho trong hang doi. */
  queued: number;
}

export type DropReason = 'queue' | 'backlog' | 'send';

export interface PacerOptions {
  /** Gui MOT khung 20 ms xuong thiet bi. Tra ve false = khong gui duoc (socket nghen/dong). */
  send: (dev: string, frame: Buffer) => boolean | void;
  /** So byte dang ton trong socket cua thiet bi (bufferedAmount). */
  backlog: (dev: string) => number;
  frameMs?: number;
  /** Tran so khung trong hang doi (mac dinh 5 = 100 ms) — vua du ha jitter Wi-Fi, van duoi 150 ms do tre. */
  maxQueueFrames?: number;
  /** Tran byte ton dong: vuot thi bo khung (mac dinh 32 KB ~ 1 s tieng). */
  maxBacklogBytes?: number;
  /** So khung toi da gui trong MOT nhip khi bi tre (mac dinh 2). */
  maxCatchUp?: number;
  /** false = gui ngay khi push (hanh vi CU, de A/B). */
  pace?: boolean;
  /**
   * So byte cua MOT khung tren duong xuong thiet bi (mac dinh 640 = 20 ms mono). Man stereo: 1280.
   * Chi doi viec CHIA goi, khong doi nhip: luon MOT goi moi `frameMs` ms.
   */
  frameBytes?: number;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (t: unknown) => void;
  /** Goi moi khi bo mot khung — de log/chan doan (`reason`: vi sao). */
  onDrop?: (dev: string, reason: DropReason, queued: number) => void;
}

interface DeviceState {
  q: Buffer[];
  timer: unknown | null;
  /** Moc (ms) cua khung KE TIEP theo lich tuyet doi; 0 = chua co moc (dang im). */
  lastAt: number;
  frames: number;
  dropped: number;
}

export class FramePacer {
  private readonly m = new Map<string, DeviceState>();
  private readonly frameMs: number;
  private readonly maxQueueFrames: number;
  private readonly maxBacklogBytes: number;
  private readonly maxCatchUp: number;
  private readonly pace: boolean;
  private readonly frameBytes: number;
  private readonly now: () => number;
  private readonly setT: (fn: () => void, ms: number) => unknown;
  private readonly clearT: (t: unknown) => void;

  constructor(private readonly o: PacerOptions) {
    this.frameMs = o.frameMs ?? FRAME_MS;
    this.maxQueueFrames = Math.max(1, o.maxQueueFrames ?? 5);
    this.maxBacklogBytes = Math.max(0, o.maxBacklogBytes ?? 32 * 1024);
    this.maxCatchUp = Math.max(1, o.maxCatchUp ?? 2);
    this.pace = o.pace !== false;
    this.frameBytes = Math.max(2, o.frameBytes ?? FRAME_BYTES);
    this.now = o.now ?? Date.now;
    this.setT = o.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearT = o.clearTimeout ?? ((t) => clearTimeout(t as NodeJS.Timeout));
  }

  /** Nhan PCM (1 hoac nhieu khung, doi dai tuy y) — chia khung 640 byte roi xep vao hang doi cua `dev`. */
  push(dev: string, pcm: Buffer): void {
    const st = this.state(dev);
    for (let o = 0; o + 1 < pcm.length; o += this.frameBytes) {
      const frame = pcm.subarray(o, Math.min(pcm.length, o + this.frameBytes));
      if (this.pace && st.q.length >= this.maxQueueFrames) {          // hang doi day: bo khung CU NHAT (giu do tre thap)
        st.q.shift();
        st.dropped++;
        this.o.onDrop?.(dev, 'queue', st.q.length);
      }
      st.q.push(frame);
    }
    if (!st.q.length) return;
    if (!this.pace) { this.drainNow(dev); return; }
    if (st.timer === null) this.schedule(dev);
  }

  stats(dev: string): PacerStats {
    const st = this.m.get(dev);
    return st ? { frames: st.frames, dropped: st.dropped, queued: st.q.length } : { frames: 0, dropped: 0, queued: 0 };
  }

  /** Xoa hang doi + hen gio + so lieu cua `dev` (ket thuc cuoc goi / bat dau phep do moi). */
  reset(dev: string): void {
    const st = this.m.get(dev);
    if (!st) return;
    if (st.timer !== null) { this.clearT(st.timer); st.timer = null; }
    st.q.length = 0;
    st.lastAt = 0;
    st.frames = 0;
    st.dropped = 0;
  }

  /** Xoa HAN trang thai (giai phong bo nho khi thiet bi ngat / het cuoc goi). */
  forget(dev: string): void {
    this.reset(dev);
    this.m.delete(dev);
  }

  /** So thiet bi dang co trang thai (chan doan ro ri). */
  get size(): number { return this.m.size; }

  /** So byte cua MOT khung dang dung (640 mono / 1280 stereo) — de log/chan doan va test. */
  get bytesPerFrame(): number { return this.frameBytes; }

  /** Dung hen gio cua moi thiet bi (dung trong test / khi tat server). */
  stopAll(): void {
    for (const dev of [...this.m.keys()]) this.reset(dev);
  }

  private state(dev: string): DeviceState {
    let st = this.m.get(dev);
    if (!st) { st = { q: [], timer: null, lastAt: 0, frames: 0, dropped: 0 }; this.m.set(dev, st); }
    return st;
  }

  /** Dat hen gio cho lan gui KE TIEP theo moc tuyet doi `lastAt` (khong phai "20 ms ke tu bay gio"). */
  private schedule(dev: string): void {
    const st = this.state(dev);
    const now = this.now();
    if (!st.lastAt) st.lastAt = now;
    const wait = Math.max(0, st.lastAt - now);
    const t = this.setT(() => { st.timer = null; this.tick(dev); }, wait);
    (t as { unref?: () => void }).unref?.();          // khong giu tien trinh song vi hen gio am thanh
    st.timer = t;
  }

  private tick(dev: string): void {
    const st = this.state(dev);
    const now = this.now();
    // Im lang lau (khong co gi de gui): bo qua phan "bu" cua qua khu, coi nhu bat dau lai tu bay gio.
    if (st.lastAt && now - st.lastAt > this.frameMs * this.maxCatchUp) st.lastAt = now;
    let n = 0;
    while (st.q.length && n < this.maxCatchUp && now >= st.lastAt - 1) {
      const frame = st.q.shift()!;
      if (this.o.backlog(dev) > this.maxBacklogBytes) {
        st.dropped++;
        this.o.onDrop?.(dev, 'backlog', st.q.length);
      } else {
        const ok = this.o.send(dev, frame);
        if (ok === false) { st.dropped++; this.o.onDrop?.(dev, 'send', st.q.length); } else st.frames++;
      }
      st.lastAt += this.frameMs;
      n++;
    }
    if (st.q.length) {
      // Vua phai BU (gui toi da maxCatchUp khung trong mot nhip): day moc ke tiep ra sau MOT khung de khong
      // "don no" bang cach ban lien tiep (nhip sau lai gui 2 khung ngay lap tuc -> thanh bun no that su).
      if (n >= this.maxCatchUp && st.lastAt < now + this.frameMs) st.lastAt = now + this.frameMs;
      this.schedule(dev);
      return;
    }
    st.lastAt = 0;                                     // het khung: lan push sau gui ngay
  }

  /** `pace: false` (A/B): gui TAT CA khung dang cho ngay lap tuc, khong hen gio — dung hanh vi CU. */
  private drainNow(dev: string): void {
    const st = this.state(dev);
    while (st.q.length) {
      const frame = st.q.shift()!;
      if (this.o.backlog(dev) > this.maxBacklogBytes) {
        st.dropped++;
        this.o.onDrop?.(dev, 'backlog', st.q.length);
        continue;
      }
      const ok = this.o.send(dev, frame);
      if (ok === false) { st.dropped++; this.o.onDrop?.(dev, 'send', st.q.length); } else st.frames++;
    }
    st.lastAt = 0;
  }
}
