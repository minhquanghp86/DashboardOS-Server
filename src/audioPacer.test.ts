// SPDX-License-Identifier: Apache-2.0
//
// Copyright (c) 2026 minhquanghp86
// Licensed under the Apache License, Version 2.0 (see LICENSE).

// (05/12/2026) BO DEM NHIP 20 ms/khung (src/audioPacer.ts) — kiem tra bang DONG HO GIA, khong can thiet bi:
//   - khung den thanh tung dot -> ra deu MOT khung moi 20 ms (khong bun no);
//   - hang doi co tran: khung cu nhat bi bo, do tre khong tich luy;
//   - tran bufferedAmount: socket nghen -> bo khung thay vi day them;
//   - `pace: false` (A/B, CCR_CALL_PACE=0) -> gui ngay nhu hanh vi cu;
//   - `send()` tra false -> tinh la `dropped` (truoc day khung bi bo im lang, khong ai biet).
// (08/12/2026) BAI TEST BAT LOI DO DUOC TREN P4 ("1750 goi / 30 s" = 58 goi/s thay vi 50):
//   du lieu `push()` lon hon `frameBytes` (640 B trong khi bo dem cau hinh 320) KHONG duoc phep lam nhip ra gap doi —
//   phan du phai nam trong hang doi va ra dan o cac nhip sau. Cu the: 10 khung 640 B + `frameBytes=320` => 10 goi
//   trong 200 ms (50 goi/s), khong phai 20 goi. Nhom test cuoi tep kiem tra dung dieu do (va ca khi bat/tat 8 kHz).
import { describe, expect, it } from 'vitest';

import { FramePacer, FRAME_BYTES, type PacerOptions } from './audioPacer.js';

interface Harness {
  pacer: FramePacer;
  sent: { at: number; bytes: number }[];
  dropped: string[];
  advance: (ms: number) => void;
  jump: (ms: number) => void;
  flush: () => void;
  t: () => number;
  backlog: (v: number) => void;
  sendOk: (v: boolean) => void;
}

/** Dong ho gia + hang doi hen gio gia: chay dung thu tu thoi gian, khong phu thuoc toc do may. */
function harness(opts: Partial<PacerOptions> = {}): Harness {
  let t = 0;
  let backlog = 0;
  let sendOk = true;
  const timers: { at: number; fn: () => void }[] = [];
  const sent: { at: number; bytes: number }[] = [];
  const dropped: string[] = [];
  const pacer: FramePacer = new FramePacer({
    send: (_dev, frame) => { if (sendOk) sent.push({ at: t, bytes: frame.length }); return sendOk; },
    backlog: () => backlog,
    now: () => t,
    setTimeout: (fn, ms) => { const id = { at: t + ms, fn }; timers.push(id); return id; },
    clearTimeout: (id) => { const i = timers.indexOf(id as { at: number; fn: () => void }); if (i >= 0) timers.splice(i, 1); },
    onDrop: (_dev, reason) => { dropped.push(reason); },
    ...opts,
  });
  const advance = (ms: number): void => {
    const end = t + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const n = timers[0];
      if (!n || n.at > end) break;
      timers.shift();
      t = n.at;
      n.fn();
    }
    t = end;
  };
  /** Event loop BI CHAN `ms`: dong ho nhay, hen gio KHONG duoc chay (tre that su, khong phai "chay dung luc"). */
  const jump = (ms: number): void => { t += ms; };
  /** Chay cac hen gio DA DEN HAN ngay bay gio (t KHONG lui ve moc hen gio) — mo phong event loop tinh day muon. */
  const flush = (): void => {
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const n = timers[0];
      if (!n || n.at > t) break;
      timers.shift();
      n.fn();
    }
  };
  return { pacer, sent, dropped, advance, jump, flush, t: () => t, backlog: (v) => { backlog = v; }, sendOk: (v) => { sendOk = v; } };
}

const frame = (fill = 1): Buffer => Buffer.alloc(FRAME_BYTES, fill);
/** Moc gui mong doi cua `n` goi o nhip 20 ms: 0, 20, 40, ... */
const slots = (n: number): number[] => [...Array(n)].map((_, i) => i * 20);
/** So goi/giay do duoc tu cac moc da gui (khong dem khung bi bo). */
function packetsPerSecond(sent: { at: number }[]): number {
  if (sent.length < 2) return 0;
  const span = sent[sent.length - 1].at - sent[0].at + 20;      // +20: mot goi cuoi van chiem MOT nhip
  return Math.round((sent.length * 1000 * 100) / span) / 100;
}

describe('audioPacer — nhip 20 ms', () => {
  it('5 khung push MOT LAN -> gui tai 0, 20, 40, 60, 80 ms (khong bun no)', () => {
    const h = harness({ maxQueueFrames: 5 });
    for (let i = 0; i < 5; i++) h.pacer.push('p4', frame());
    h.advance(200);
    expect(h.sent.map((s) => s.at)).toEqual([0, 20, 40, 60, 80]);
    expect(h.pacer.stats('p4')).toEqual({ frames: 5, dropped: 0, queued: 0 });
  });

  it('mot goi 40 ms (1280 byte = 2 khung) -> trai thanh 0 ms va 20 ms', () => {
    const h = harness();
    h.pacer.push('p4', Buffer.alloc(2 * FRAME_BYTES, 7));
    h.advance(100);
    expect(h.sent.map((s) => s.at)).toEqual([0, 20]);
    expect(h.sent.every((s) => s.bytes === FRAME_BYTES)).toBe(true);   // LUON 640 byte/goi
  });

  it('khung den lien tuc moi 20 ms -> ra dung nhip 20 ms, khong trech', () => {
    const h = harness();
    for (let k = 0; k < 10; k++) { h.pacer.push('p4', frame()); h.advance(20); }
    h.advance(100);
    expect(h.sent.map((s) => s.at)).toEqual([0, 20, 40, 60, 80, 100, 120, 140, 160, 180]);
    expect(h.pacer.stats('p4').dropped).toBe(0);
  });

  it('DUNG MOT goi moi nhip — khong con "bu" 2 goi/nhip (maxCatchUp da bi xoa)', () => {
    const h = harness({ maxQueueFrames: 10 });
    for (let i = 0; i < 10; i++) h.pacer.push('p4', frame());
    h.advance(20);
    // Nhip 0 ms: 1 khung; nhip 20 ms: 1 khung. Khong nhip nao co 2 goi.
    expect(h.sent.filter((s) => s.at === 0).length).toBe(1);
    expect(h.sent.filter((s) => s.at === 20).length).toBe(1);
    expect(h.sent.length).toBe(2);
  });

  it('event loop tre 5 ms (chi jitter): van 1 goi/nhip, giu moc tuyet doi 0/20/40..., khong bun no', () => {
    const h = harness({ maxQueueFrames: 10 });
    for (let i = 0; i < 5; i++) h.pacer.push('p4', frame());
    h.flush();                                   // nhip 0 ms: 1 goi
    expect(h.sent.map((s) => s.at)).toEqual([0]);
    h.jump(25);                                  // hen gio 20 ms bi tinh day muon 5 ms
    h.flush();                                   // nhip "bi tre": van CHI 1 goi
    expect(h.sent.map((s) => s.at)).toEqual([0, 25]);
    h.advance(100);
    for (const at of new Set(h.sent.map((s) => s.at))) expect(h.sent.filter((s) => s.at === at).length).toBe(1);
    expect(h.sent.map((s) => s.at)).toEqual([0, 25, 40, 60, 80]);   // moc tuyet doi 40/60/80, khong duoi kip
  });

  it('dung hinh (tre >= 60 ms): bo khung CU trong hang doi thay vi phat bu ca loat', () => {
    const h = harness({ maxQueueFrames: 10 });
    for (let i = 0; i < 6; i++) h.pacer.push('p4', frame());
    h.flush();                                   // 1 goi tai 0 ms, con 5 khung trong hang doi
    h.jump(100);                                 // event loop bi chan 100 ms
    h.flush();                                   // chi 1 goi nua, khong ban 5 goi
    expect(h.sent.map((s) => s.at)).toEqual([0, 100]);
    expect(h.dropped).toContain('late');          // khung cu bi bo, khong don lai
    expect(h.pacer.stats('p4').dropped).toBeGreaterThan(0);
  });

  it('im lang lau roi phat lai -> khung dau di NGAY, khong bu 20 khung cu', () => {
    const h = harness();
    h.pacer.push('p4', frame());
    h.advance(500);
    h.pacer.push('p4', frame());
    h.advance(100);
    expect(h.sent.map((s) => s.at)).toEqual([0, 500]);
  });
});

describe('audioPacer — tran hang doi va tran bufferedAmount', () => {
  it('hang doi toi da `maxQueueFrames` khung: khung CU NHAT bi bo, do tre khong tich luy', () => {
    const h = harness({ maxQueueFrames: 3 });
    for (let i = 0; i < 10; i++) h.pacer.push('p4', frame(i + 1));
    const st = h.pacer.stats('p4');
    expect(st.queued).toBe(3);
    expect(st.dropped).toBe(7);
    expect(h.dropped).toEqual(Array(7).fill('queue'));
  });

  it('mac dinh: hang doi 5 khung = 100 ms do tre toi da', () => {
    const h = harness();
    for (let i = 0; i < 12; i++) h.pacer.push('p4', frame());
    expect(h.pacer.stats('p4')).toMatchObject({ queued: 5, dropped: 7 });
  });

  it('socket nghen (bufferedAmount > tran) -> bo khung, khong gui them', () => {
    const h = harness({ maxBacklogBytes: 1024 });
    h.backlog(4096);
    for (let i = 0; i < 3; i++) h.pacer.push('p4', frame());
    h.advance(200);
    expect(h.sent).toEqual([]);
    expect(h.pacer.stats('p4')).toMatchObject({ frames: 0, dropped: 3 });
    // Nghen xong (bufferedAmount tut xuong) -> chay lai binh thuong
    h.backlog(0);
    h.pacer.push('p4', frame());
    h.advance(50);
    expect(h.sent.length).toBe(1);
  });

  it('`send()` tra false (khong co client / socket dong) -> tinh la dropped', () => {
    const h = harness();
    h.sendOk(false);
    h.pacer.push('p4', frame());
    h.advance(50);
    expect(h.pacer.stats('p4')).toMatchObject({ frames: 0, dropped: 1 });
    expect(h.dropped).toEqual(['send']);
  });

  it('reset() xoa hang doi + hen gio (ket thuc cuoc goi khong con khung cu)', () => {
    const h = harness();
    for (let i = 0; i < 3; i++) h.pacer.push('p4', frame());
    h.pacer.reset('p4');                               // huy TRUOC khi hen gio kip chay -> khong khung nao di
    h.advance(200);
    expect(h.sent).toEqual([]);
    expect(h.pacer.stats('p4')).toEqual({ frames: 0, dropped: 0, queued: 0 });
  });
});

describe('audioPacer — che do khong pace (A/B: CCR_CALL_PACE=0)', () => {
  it('push 3 khung -> gui NGAY ca 3 trong cung mot thoi diem (hanh vi CU)', () => {
    const h = harness({ pace: false });
    for (let i = 0; i < 3; i++) h.pacer.push('p4', frame());
    expect(h.sent.map((s) => s.at)).toEqual([0, 0, 0]);
    expect(h.pacer.stats('p4')).toMatchObject({ frames: 3, dropped: 0 });
  });
});

// (06/12/2026) KHUNG 1280 BYTE = 20 ms STEREO (L = R) cho nhanh xuong loa man P4 (xem src/audioStereo.ts).
// `frameBytes` chi doi viec CHIA goi: mot lan push 1280 byte = MOT goi, va van MOT goi moi 20 ms.
// (08/12/2026) Neu de SAI `frameBytes` (640 trong khi nhan 1280) thi mot khung 20 ms bi chia thanh HAI goi — hai goi
// do ra o HAI nhip (0 va 20 ms), KHONG phai hai goi trong cung mot nhip: nhip ra van 50 goi/s, chi la nua so khung
// bi day ra sau va hang doi day dan (tran 5) -> mat tieng. Do la hanh vi an toan (khong con "gui gap doi").
describe('audioPacer — khung 1280 byte (20 ms stereo cho loa man)', () => {
  const stereoFrame = (fill = 3): Buffer => Buffer.alloc(1280, fill);

  it('mac dinh cua module van la 640 (web <-> web khong doi)', () => {
    const h = harness();
    expect(FRAME_BYTES).toBe(640);
    expect(h.pacer.bytesPerFrame).toBe(FRAME_BYTES);
  });

  it('frameBytes=1280: mot lan push 1280 byte -> MOT goi 1280 byte (khong bi chia doi)', () => {
    const h = harness({ frameBytes: 1280 });
    expect(h.pacer.bytesPerFrame).toBe(1280);
    h.pacer.push('p4', stereoFrame());
    h.advance(100);
    expect(h.sent).toEqual([{ at: 0, bytes: 1280 }]);
    expect(h.pacer.stats('p4')).toEqual({ frames: 1, dropped: 0, queued: 0 });
  });

  it('frameBytes=1280: 5 khung push MOT LAN -> 0/20/40/60/80 ms, moi goi 1280 byte (KHONG bun no)', () => {
    const h = harness({ frameBytes: 1280, maxQueueFrames: 5 });
    for (let i = 0; i < 5; i++) h.pacer.push('p4', stereoFrame());
    h.advance(300);
    expect(h.sent.map((s) => s.at)).toEqual([0, 20, 40, 60, 80]);
    expect(h.sent.every((s) => s.bytes === 1280)).toBe(true);
    expect(h.pacer.stats('p4')).toEqual({ frames: 5, dropped: 0, queued: 0 });
  });

  it('frameBytes=1280: 20 khung den moi 20 ms -> 20 goi trong 400 ms (dung 1 goi/20 ms, toc do byte 2x nhung nhip khong doi)', () => {
    const h = harness({ frameBytes: 1280, maxQueueFrames: 8 });
    for (let k = 0; k < 20; k++) { h.pacer.push('p4', stereoFrame()); h.advance(20); }
    h.advance(200);
    const at = h.sent.map((s) => s.at).filter((v, i, a) => a.indexOf(v) === i);   // cac moc co gui
    expect(at).toEqual([...Array(20)].map((_, i) => i * 20));                     // 0,20,...,380 ms
    // Khong bao gio 2 goi trong CUNG mot moc 20 ms sau khi hang doi da on dinh (nhip 1 goi/nhip).
    for (const t of at.slice(1)) expect(h.sent.filter((s) => s.at === t).length).toBe(1);
    expect(h.sent.length).toBe(20);
    expect(h.pacer.stats('p4').dropped).toBe(0);
  });

  it('frameBytes=1280: mot goi 40 ms (2560 byte) -> trai thanh 2 goi 1280 byte o 0 va 20 ms', () => {
    const h = harness({ frameBytes: 1280 });
    h.pacer.push('p4', Buffer.alloc(2560, 9));
    h.advance(100);
    expect(h.sent.map((s) => s.at)).toEqual([0, 20]);
    expect(h.sent.every((s) => s.bytes === 1280)).toBe(true);
  });

  it('frameBytes=640 nhung nhan 1280 byte -> 2 goi o 0 va 20 ms (cau hinh SAI: cham gap doi, KHONG phai 2 goi/nhip)', () => {
    const h = harness({ frameBytes: 640, maxQueueFrames: 8 });
    h.pacer.push('p4', stereoFrame());
    h.advance(100);
    expect(h.sent.map((s) => s.bytes)).toEqual([640, 640]);       // vi sao callBridge phai dat dung SPEAKER_WIRE_FRAME_BYTES
    expect(h.sent.map((s) => s.at)).toEqual([0, 20]);             // KHONG BAO GIO 2 goi trong cung mot nhip
  });

  it('frameBytes=640 + push 1280 byte MOI 20 ms (dung loi P4) -> van 50 goi/s, phan du bi bo chu KHONG gui gap doi', () => {
    const h = harness({ frameBytes: 640, maxQueueFrames: 5 });
    for (let k = 0; k < 25; k++) { h.pacer.push('p4', stereoFrame()); h.advance(20); }
    h.advance(200);
    // Moi nhip CHI mot goi: 500 ms / 20 ms = 25 nhip.
    expect(packetsPerSecond(h.sent)).toBe(50);
    for (const at of new Set(h.sent.map((s) => s.at))) expect(h.sent.filter((s) => s.at === at).length).toBe(1);
    // Du lieu vao gap doi so voi toc do ra -> hang doi luon day -> khung cu bi bo (mat tieng, nhung KHONG tran loa).
    expect(h.pacer.stats('p4').dropped).toBeGreaterThan(0);
  });

  it('frameBytes=1280 van giu tran hang doi tinh theo KHUNG (5 khung = 100 ms)', () => {
    const h = harness({ frameBytes: 1280, maxQueueFrames: 5 });
    for (let i = 0; i < 8; i++) h.pacer.push('p4', stereoFrame());
    expect(h.pacer.stats('p4')).toMatchObject({ queued: 5, dropped: 3 });
    expect(h.dropped).toEqual(['queue', 'queue', 'queue']);
  });
});

// (08/12/2026) BON PHEP DO BAT BUOC — dung loi do tren P4 (`1750 goi / 30 s` = 58 goi/s thay vi 50, 42,7 KB/s thay
// vi 32 KB/s, `loa tu choi 319680 B`). Truoc khi sua, `push()` 640 B voi `frameBytes` = 320/640 sinh ra 2 goi va
// `tick()` cu gui toi `maxCatchUp` = 2 goi/nhip => gap doi luu luong. Nay: **1 goi / 20 ms o MOI cau hinh**.
describe('audioPacer — dung MOT goi moi 20 ms (50 goi/s) o moi cau hinh', () => {
  it('push 10 khung 640 B voi frameBytes=320 -> 10 goi trong 200 ms (50 goi/s), KHONG phai 20 goi', () => {
    const h = harness({ frameBytes: 320, maxQueueFrames: 64 });
    for (let i = 0; i < 10; i++) h.pacer.push('p4', Buffer.alloc(640, i + 1));
    h.advance(199);                                              // cua so 0..199 ms (goi thu 11 den o moc 200 ms)
    expect(h.sent.length).toBe(10);                              // 10 goi, KHONG phai 20
    expect(h.sent.map((s) => s.at)).toEqual(slots(10));          // 0, 20, ..., 180 ms
    expect(h.sent.every((s) => s.bytes === 320)).toBe(true);
    expect(packetsPerSecond(h.sent)).toBe(50);
    // Phan du (10 khung) NAM TRONG HANG DOI, ra dan o cac nhip sau — khong phat bu trong cung nhip.
    expect(h.pacer.stats('p4')).toMatchObject({ frames: 10, dropped: 0, queued: 10 });
    h.advance(201);
    expect(h.sent.length).toBe(20);
    expect(h.sent.map((s) => s.at)).toEqual(slots(20));          // 0, 20, ..., 380 ms
    expect(packetsPerSecond(h.sent)).toBe(50);
    expect(h.pacer.stats('p4')).toMatchObject({ frames: 20, dropped: 0, queued: 0 });
  });

  it('push 10 khung 640 B voi frameBytes=640 -> 10 goi / 200 ms', () => {
    const h = harness({ frameBytes: 640, maxQueueFrames: 64 });
    for (let i = 0; i < 10; i++) h.pacer.push('p4', frame());
    h.advance(199);
    expect(h.sent.length).toBe(10);
    expect(h.sent.map((s) => s.at)).toEqual(slots(10));
    expect(h.sent.every((s) => s.bytes === 640)).toBe(true);
    expect(packetsPerSecond(h.sent)).toBe(50);
    h.advance(101);
    expect(h.pacer.stats('p4')).toMatchObject({ frames: 10, dropped: 0, queued: 0 });
  });

  it('push don 100 khung CUNG LUC (tran du rong) -> dung 50 goi/s, khong bun no', () => {
    const h = harness({ frameBytes: 640, maxQueueFrames: 200 });
    for (let i = 0; i < 100; i++) h.pacer.push('p4', frame(i + 1));
    h.advance(2100);
    expect(h.sent.length).toBe(100);
    expect(h.sent.map((s) => s.at)).toEqual(slots(100));          // 0, 20, ..., 1980 ms
    expect(new Set(h.sent.map((s) => s.at)).size).toBe(100);      // moi moc CHI mot goi
    expect(packetsPerSecond(h.sent)).toBe(50);
    expect(h.pacer.stats('p4')).toMatchObject({ frames: 100, dropped: 0 });
  });

  it('push don 100 khung voi TRAN HANG DOI MAC DINH -> 5 goi (50 goi/s), 95 khung cu bi bo (khong xa 100 goi)', () => {
    const h = harness();
    for (let i = 0; i < 100; i++) h.pacer.push('p4', frame(i + 1));
    expect(h.pacer.stats('p4')).toMatchObject({ queued: 5, dropped: 95 });   // tran hang doi giu nguyen
    h.advance(200);
    expect(h.sent.map((s) => s.at)).toEqual([0, 20, 40, 60, 80]);            // khong bun no
    expect(packetsPerSecond(h.sent)).toBe(50);
  });

  it('bat/tat 8 kHz khong doi so goi/giay: 320 / 640 / 1280 B deu 50 goi/s', () => {
    // 320 = 8 kHz mono (CCR_CALL_RATE8K=1, stereo=0); 640 = 8 kHz stereo (= 16 kHz mono); 1280 = 16 kHz stereo.
    for (const fb of [320, 640, 1280]) {
      const h = harness({ frameBytes: fb, maxQueueFrames: 64 });
      for (let i = 0; i < 25; i++) h.pacer.push('p4', Buffer.alloc(fb, i));
      h.advance(600);
      expect(h.sent.length, `frameBytes=${fb}`).toBe(25);
      expect(h.sent.map((s) => s.at), `frameBytes=${fb}`).toEqual(slots(25));
      expect(packetsPerSecond(h.sent), `frameBytes=${fb}`).toBe(50);
      expect(new Set(h.sent.map((s) => s.at)).size, `frameBytes=${fb}`).toBe(25);
    }
  });

  it('dung loi P4: push 640 B MOI 20 ms voi frameBytes=320 -> van 50 goi/s (khong phai 58 hay 100)', () => {
    const h = harness({ frameBytes: 320, maxQueueFrames: 5 });
    for (let k = 0; k < 25; k++) { h.pacer.push('p4', Buffer.alloc(640)); h.advance(20); }
    // Moi nhip CHI mot goi va goi nao cung nam tren luoi 20 ms: 0, 20, 40, ... (khong co moc nao 2 goi).
    expect(h.sent.map((s) => s.at)).toEqual(slots(h.sent.length));
    expect(packetsPerSecond(h.sent)).toBe(50);
    h.advance(200);                                                 // xa not phan du trong hang doi
    expect(h.sent.map((s) => s.at)).toEqual(slots(h.sent.length));
    expect(packetsPerSecond(h.sent)).toBe(50);
    // Du lieu vao gap doi toc do ra: hang doi luon day -> khung CU bi bo (mat tieng, KHONG tran ring buffer loa).
    expect(h.pacer.stats('p4').dropped).toBeGreaterThan(0);
  });
});
