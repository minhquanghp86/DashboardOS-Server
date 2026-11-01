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
//   - MOT goi moi nhip, khong bao gio phat bu (08/12/2026: da bo han `maxCatchUp`).
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
//
// (08/12/2026) SUA LOI DO DUOC TREN P4 THAT — "1 goi / 20 ms" la LUAT CUNG, khong con ngoai le:
//   Log P4: `1750 goi / 30 s` = **58 goi/s** (le ra 50 goi/s = 20 ms/goi) va toc do vao loa do duoc **42,7 KB/s**
//   thay vi 32 KB/s (16 kHz mono) => tran ring buffer 250 ms => `loa tu choi 319680 B` => nghe dut quang.
//   Nguyen nhan: bo dem duoc cau hinh `frameBytes` (320 hoac 640) nhung du lieu `push()` van la khung **640 B**
//   (PCM 16 kHz mono tu trang goi) => mot khung 20 ms bi chia thanh HAI goi 320 B, va `tick()` cu con gui toi
//   `maxCatchUp` (= 2) goi trong MOT nhip => gap doi luu luong.
//   Luat moi:
//     - **dung MOT goi moi `frameMs` ms**, bat ke `frameBytes` la bao nhieu;
//     - du lieu vao LON hon `frameBytes` -> phan du NAM LAI trong hang doi va ra dan o cac nhip sau (KHONG phat bu
//       trong cung mot nhip) => nhip ra luon 50 goi/s;
//     - BO HAN co che "catch-up phat nhieu goi/nhip" (`maxCatchUp` da bi xoa khoi `PacerOptions`);
//     - event loop tre thi nhip sau muon hon chu KHONG ban lien tiep; dung hinh (tre >= `STALL_FRAMES` nhip = 60 ms)
//       thi bo khung CU trong hang doi (tran hang doi giu nguyen) chu khong don chung lai.
//   Vi vay dat SAI `frameBytes` khong con lam gui nhanh gap doi — no chi lam MAT bot khung (hang doi day -> bo khung
//   cu), tuc la hanh vi an toan. src/callBridge.ts van phai dat `frameBytes` = so byte THAT cua mot goi tren duong
//   xuong man (sau downsample/stereo) va push vao DUNG tung ay byte mot (xem `SPEAKER_WIRE_FRAME_BYTES`).

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

/**
 * Vi sao bo mot khung:
 *   - `queue`   hang doi day (tran `maxQueueFrames` — bo khung CU NHAT, do tre khong tich luy);
 *   - `backlog` socket nghen (bufferedAmount vuot tran);
 *   - `send`    `send()` tu choi (socket dong);
 *   - `late`    dung hinh: event loop tre >= `STALL_FRAMES` nhip -> bo khung CU thay vi phat bu.
 */
export type DropReason = 'queue' | 'backlog' | 'send' | 'late';

/**
 * (08/12/2026) Tre bao nhieu nhip thi coi la "dung hinh" va bo khung cu: 3 nhip = 60 ms.
 * Duoi nguong nay chi la jitter cua `setTimeout` (1-2 ms) — van gui dung 1 goi/nhip, khong mat gi.
 */
const STALL_FRAMES = 3;

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
  /** false = gui ngay khi push (hanh vi CU, de A/B). */
  pace?: boolean;
  /**
   * So byte cua MOT khung tren duong xuong thiet bi (mac dinh 640 = 20 ms mono). Man stereo: 1280.
   * CHI quyet dinh cach CHIA du lieu vao thanh tung goi — nhip luon la MOT goi moi `frameMs` ms
   * (khong con `maxCatchUp`: xem ghi chu (08/12/2026) o dau tep).
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
  /**
   * (08/12/2026) Moc (ms) SOM NHAT duoc phep gui goi KE TIEP — chinh la luoi tuyet doi t0 + k*frameMs.
   * GIU NGUYEN khi hang doi rong (khong dat lai ve 0): neu dat lai thi mot lan `push()` den ngay sau khi hang doi
   * vua rong se gui NGAY va tao ra HAI goi trong cung mot o 20 ms — dung cai lam P4 nhan gap doi luu luong.
   * 0 = chua co moc (moi tao / sau `reset()`).
   */
  nextAt: number;
  /** Moc hen gio dang cho (ms) — `now - dueAt` = nhip nay TRE bao nhieu (de biet co phai "dung hinh" khong). */
  dueAt: number;
  frames: number;
  dropped: number;
}

export class FramePacer {
  private readonly m = new Map<string, DeviceState>();
  private readonly frameMs: number;
  private readonly maxQueueFrames: number;
  private readonly maxBacklogBytes: number;
  private readonly pace: boolean;
  private readonly frameBytes: number;
  private readonly now: () => number;
  private readonly setT: (fn: () => void, ms: number) => unknown;
  private readonly clearT: (t: unknown) => void;

  constructor(private readonly o: PacerOptions) {
    this.frameMs = o.frameMs ?? FRAME_MS;
    this.maxQueueFrames = Math.max(1, o.maxQueueFrames ?? 5);
    this.maxBacklogBytes = Math.max(0, o.maxBacklogBytes ?? 32 * 1024);
    this.pace = o.pace !== false;
    this.frameBytes = Math.max(2, o.frameBytes ?? FRAME_BYTES);
    this.now = o.now ?? Date.now;
    this.setT = o.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearT = o.clearTimeout ?? ((t) => clearTimeout(t as NodeJS.Timeout));
  }

  /**
   * Nhan PCM (1 hoac nhieu khung, doi dai tuy y) — chia thanh tung goi `frameBytes` ROI XEP VAO HANG DOI.
   * (08/12/2026) Phan du KHONG duoc phat ngay: no nam trong hang doi va ra dan o cac nhip sau, moi nhip dung MOT goi
   * (xem `tick()`), nho vay du lieu vao lon hon `frameBytes` khong lam nhip ra nhanh gap doi.
   */
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
    st.nextAt = 0;                                     // lan push sau gui NGAY (khong giu luoi cu)
    st.dueAt = 0;
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
    if (!st) { st = { q: [], timer: null, nextAt: 0, dueAt: 0, frames: 0, dropped: 0 }; this.m.set(dev, st); }
    return st;
  }

  /**
   * Dat hen gio cho goi KE TIEP. Moc = `nextAt` (luoi tuyet doi), nhung khong bao gio hen o qua khu:
   * im lang / nhip truoc TRE thi hen ngay bay gio (van chi MOT goi — xem `tick()`).
   */
  private schedule(dev: string): void {
    const st = this.state(dev);
    const now = this.now();
    if (!st.nextAt) st.nextAt = now;                  // chua co moc: lan dau tinh tu bay gio
    const at = Math.max(st.nextAt, now);              // moc da qua -> gui ngay (khong doi cho vo ich)
    st.dueAt = at;
    const t = this.setT(() => { st.timer = null; this.tick(dev); }, at - now);
    (t as { unref?: () => void }).unref?.();          // khong giu tien trinh song vi hen gio am thanh
    st.timer = t;
  }

  /**
   * (08/12/2026) MOT NHIP = MOT GOI. Khong con vong `while` phat bu: du hang doi con 20 khung thi moi nhip van chi ra
   * dung MOT goi (cac khung con lai ra dan o cac nhip sau), nho vay nhip ra luon = 1/frameMs goi/s (50 goi/s).
   * Event loop tre: gui 1 goi roi dat moc KE TIEP = bay gio + frameMs (khong ban lien tiep de "duoi kip"); dung hinh
   * (tre >= `STALL_FRAMES` nhip) thi bo khung CU trong hang doi — tran hang doi giu nguyen — chu khong don chung lai.
   */
  private tick(dev: string): void {
    const st = this.state(dev);
    const now = this.now();
    if (!st.q.length) return;                      // khong con gi: `nextAt` GIU NGUYEN (luoi 1 goi/20 ms khong bi pha)

    const late = st.dueAt ? now - st.dueAt : 0;    // nhip nay TRE bao nhieu so voi gio hen
    if (late >= this.frameMs * STALL_FRAMES) {     // dung hinh: bo khung CU, giu lai it nhat MOT khung
      const behind = Math.floor(late / this.frameMs);
      for (let i = 0; i < behind && st.q.length > 1; i++) {
        st.q.shift();
        st.dropped++;
        this.o.onDrop?.(dev, 'late', st.q.length);
      }
    }

    const frame = st.q.shift()!;
    if (this.o.backlog(dev) > this.maxBacklogBytes) {
      st.dropped++;
      this.o.onDrop?.(dev, 'backlog', st.q.length);
    } else {
      const ok = this.o.send(dev, frame);
      if (ok === false) { st.dropped++; this.o.onDrop?.(dev, 'send', st.q.length); } else st.frames++;
    }

    // Luoi tuyet doi t0 + k*frameMs (khong cong don sai so); TRE qua mot nhip thi moc ke tiep = bay gio + frameMs
    // (KHONG bu cac nhip da mat).
    if (!st.nextAt) st.nextAt = now;
    st.nextAt += this.frameMs;
    if (st.nextAt <= now) st.nextAt = now + this.frameMs;
    if (st.q.length) this.schedule(dev);
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
    st.nextAt = 0;                                    // da xa het: lan push sau bat dau luoi moi tu bay gio
    st.dueAt = 0;
  }
}
