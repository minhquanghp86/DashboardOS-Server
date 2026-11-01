// SPDX-License-Identifier: Apache-2.0
//
// Copyright (c) 2026 minhquanghp86
// Licensed under the Apache License, Version 2.0 (see LICENSE).

// (13/12/2026) HALF-DUPLEX THICH NGHI (voice switch) cho cuoc goi DIEN THOAI <-> MAN P4.
//
// Trieu chung do + nghe tren thiet bi:
//   - noi vao dien thoai thi loa P4 NGHE NHO, khong nhay;
//   - tang am luong loa P4 len thi RU (howling).
// Nguyen nhan da xac dinh: VONG LAP AM HOC — loa P4 -> mic dien thoai -> ve P4 (va chieu nguoc lai P4 -> mic P4 ->
// dien thoai). AEC cua trinh duyet chi giam duoc MOT PHAN, phan con lai du de tu kich khi gain du lon. Vi vay khong
// the chi "tang gain" (AGC) — phai CAT mot chieu theo thoi diem, dung nhu bo dam thoai that (half-duplex / voice
// switch).
//
// Module nay lam dung mot viec: theo doi NANG LUONG RMS hai chieu cua CUNG MOT cuoc goi roi giam mot chieu khi chieu
// kia dang co tieng.
//   - `up`   = DIEN THOAI -> P4 (PCM di ra loa man, `sendToSpeaker()` trong src/callBridge.ts);
//   - `down` = P4 -> DIEN THOAI (mic cua man, `onMicFrame()` -> trang web / `sendWebAudio()`).
//
// LUAT (nhu yeu cau, tham so o duoi):
//   1. `up` > -34 dBFS (dang co nguoi noi toi P4) VA `up` >= `down` + 6 dB  -> giam `down` 20 dB (chi luc dang co
//      tieng `up`). Cat duong loa P4 -> mic P4 -> ve dien thoai: nguoi o dau day khong nghe lai chinh giong minh.
//   2. `down` >= `up` + 6 dB (va `down` cung phai > -34 dBFS — xem ghi chu o `decideTarget()`) -> giam `up` 12 dB.
//      Cat duong nguoc: loa P4 -> mic dien thoai -> ve loa P4 (day chinh la vong gay RU khi am luong lon).
//   3. Ca hai < -60 dBFS -> KHONG dung vao mau nao (im lang thi khong co gi de cat, va khong duoc
//      "khuech dai nhieu nen phong").
//   4. Chuyen trang thai MEM: attack 10 ms (luc bat dau giam) / release 250 ms (luc nha ra), va gain duoc NOI TUYEN
//      TU `gain` cua khung TRUOC toi `gain` cua khung nay tren tung mau — khong co buoc nhay o bien khung nen khong
//      nghe thay tieng "cup"/"tach".
//   - Trang thai RIENG cho tung cuoc goi (`callId`), xoa khi ket thuc (`forget()`).
//   - KHONG doi do dai goi (vao bao nhieu byte ra bay nhieu byte) va KHONG sua tai cho buffer cua nguoi goi.
//   - KHONG ap cho web <-> web (dien thoai <-> dien thoai): nhanh do khong di qua `sendToSpeaker()`/`onMicFrame()`.
//   - Bat/tat bang env `CCR_CALL_HALFDUPLEX` (mac dinh BAT, '0' de TAT = passthrough y nguyen byte de A/B).
//
// Vi sao `apply()` nhan them `levelDb`: chieu `up` di qua AGC/limiter (src/audioAgc.ts, muc nham -14 dBFS) TRUOC
// khi bi giam, nen neu do nang luong SAU AGC thi moi tieng on nen cua dien thoai cung bi AGC keo len ~-14 dBFS va
// luon vuot nguong -34 -> chieu `down` bi cat vinh vien ("man cam"). Vi vay `sendToSpeaker()` do muc THO cua khung
// (truoc EQ/AGC) roi truyen vao day, con gain giam duoc ap SAU AGC — de AGC khong the "keo lai" phan vua bi cat.

/** Tan so lay mau cua PCM tren ca hai chieu (s16le mono 16 kHz). */
export const DUPLEX_SAMPLE_RATE = 16000;
/** Do dai mot khung 20 ms = 320 mau = 640 byte. */
export const DUPLEX_FRAME_MS = 20;

/** Nguong "dang co tieng" (dBFS). Duoi nguong nay khong duoc phep cat chieu kia. */
export const DUPLEX_THRESHOLD_DBFS = -34;
/** Phai hon chieu kia it nhat bao nhieu dB thi moi duoc coi la "dang noi". */
export const DUPLEX_DOMINANCE_DB = 6;
/** Muc giam chieu `down` (P4 -> dien thoai) khi dang co tieng `up` (dB). */
export const DUPLEX_DOWN_ATTEN_DB = 20;
/** Muc giam chieu `up` (dien thoai -> P4) khi `down` dang hon (dB). */
export const DUPLEX_UP_ATTEN_DB = 12;
/** Hang so thoi gian LUC GIAM (ms) — du nhanh de bat kip vong lap, du cham de khong "cup". */
export const DUPLEX_ATTACK_MS = 10;
/** Hang so thoi gian LUC NHA (ms) — khong "bat/tat" theo tung tu. */
export const DUPLEX_RELEASE_MS = 250;
/** Duoi muc nay ca hai chieu = im lang: khong dung vao mau nao. */
export const DUPLEX_SILENCE_DBFS = -60;
/**
 * Mot chieu khong co khung moi trong bao lau thi coi nhu IM LANG (dB tinh tren do dai khung).
 * Can thiet de khong bi "cat ket" khi dau kia ngung gui (tat mic / mat mang): 250 ms sau la nha ra.
 */
export const DUPLEX_STALE_MS = 500;
/** Nhip in dong `[duplex]` chan doan khi dang co cat (ms) — chi de doc log tren thiet bi. */
export const DUPLEX_LOG_MS = 5000;

export type DuplexDir = 'up' | 'down';

/** Trang thai mot cuoc goi (hai chieu + gain da lam muot cua tung chieu). */
export interface DuplexState {
  /** Nang luong moi nhat cua chieu `up` (dBFS). */
  upDb: number;
  /** Nang luong moi nhat cua chieu `down` (dBFS). */
  downDb: number;
  /** Gain dang ap cho chieu `up` (dB, <= 0). */
  upGainDb: number;
  /** Gain dang ap cho chieu `down` (dB, <= 0). */
  downGainDb: number;
  /** Thoi diem (ms) cua khung `up` / `down` moi nhat. */
  upAt: number;
  downAt: number;
  /** So khung da bi giam cua tung chieu (chan doan). */
  upDucked: number;
  downDucked: number;
  /** Lan in log gan nhat (chan doan). */
  loggedAt: number;
  /** Thong so cua khung vua xu ly (null = chua co). */
  last: DuplexFrameStats | null;
}

/** Thong so cua MOT lan `apply()` — de test va de in log chan doan. */
export interface DuplexFrameStats {
  dir: DuplexDir;
  /** Muc do cua khung nay (dBFS) — do TRUOC khi giam. */
  levelDb: number;
  /** Muc do moi nhat cua chieu kia (dBFS, da tinh "cu" -> -120). */
  otherDb: number;
  /** Muc giam nham toi cua chieu nay cho khung nay (dB, <= 0). */
  targetDb: number;
  /** Gain thuc su ap cho khung nay (dB, sau lam muot). */
  gainDb: number;
  /** So dB bi giam (= -gainDb, >= 0) de doc log. */
  attenDb: number;
  /** true = mau bi sua. */
  changed: boolean;
  /** true = ca hai chieu < -60 dBFS -> khong dung vao mau. */
  silent: boolean;
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
/**
 * He so lam muot exponential cho mot khung dai `durMs`: 1 - e^(-durMs/tau).
 * Tinh theo DO DAI THAT cua khung nen goi 20 ms (640 byte) cho dung attack 10 ms / release 250 ms, va goi ngan hon
 * (vd 10 ms = 320 byte) cung giu dung hang so thoi gian, khong bi nhanh gap doi.
 */
const coef = (tauMs: number, durMs: number): number => 1 - Math.exp(-durMs / tauMs);

/** RMS cua mot buffer PCM s16le (dBFS, -120 = im lang tuyet doi). */
export function levelDbOf(pcm: Buffer): number {
  const n = Math.floor(pcm.length / 2);
  if (!n) return -120;
  let s = 0;
  for (let i = 0; i < n; i++) { const v = pcm.readInt16LE(i * 2) / 32768; s += v * v; }
  return 20 * Math.log10(Math.max(Math.sqrt(s / n), 1e-9));
}

/** Doc env MOT lan luc khoi dong: mac dinh BAT, chi '0' (hoac off/false/no) la TAT. */
function readEnabled(): boolean {
  const v = (process.env.CCR_CALL_HALFDUPLEX ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'off' || v === 'false' || v === 'no');
}

export const HALFDUPLEX_ENABLED: boolean = readEnabled();
// Nhat ky khoi dong: 'CCR_CALL_HALFDUPLEX=0' -> "[audio] halfduplex=off ..." (A/B khong can sua ma).
if (!process.env.VITEST) {
  console.log(`[audio] halfduplex=${HALFDUPLEX_ENABLED ? 'on' : 'off'} thr=${DUPLEX_THRESHOLD_DBFS}dBFS ` +
    `duck=down${DUPLEX_DOWN_ATTEN_DB}/up${DUPLEX_UP_ATTEN_DB}dB attack=${DUPLEX_ATTACK_MS}ms release=${DUPLEX_RELEASE_MS}ms`);
}

/** Trang thai moi cho mot cuoc goi: im lang, khong giam gi. */
export function newDuplexState(): DuplexState {
  return {
    upDb: -120, downDb: -120, upGainDb: 0, downGainDb: 0, upAt: 0, downAt: 0,
    upDucked: 0, downDucked: 0, loggedAt: 0, last: null,
  };
}

/** Muc giam toi da cua mot chieu (dB, duong). */
export const maxAttenOf = (dir: DuplexDir): number => (dir === 'down' ? DUPLEX_DOWN_ATTEN_DB : DUPLEX_UP_ATTEN_DB);

/**
 * Muc do cua mot chieu, co tinh "CU" (`DUPLEX_STALE_MS` khong co khung moi -> coi nhu im lang).
 * Khong co buoc nay thi khi dien thoai tat mic / mat mang, chieu con lai bi cat mai mai.
 */
function levelOf(db: number, at: number, now: number): number {
  return now - at <= DUPLEX_STALE_MS ? db : -120;
}

/**
 * Muc giam nham toi cho `dir` theo muc do hai chieu (da tinh "cu").
 *
 * GHI CHU ve nguong -34 dBFS o CA HAI chieu (khac voi cau chu "down >= up + 6 dB" khong kem nguong): mic cua man
 * LUON gui khung (ke ca phong im lang ~ -55 dBFS). Neu chieu `down` khong co nguong hoat dong thi phong im lang
 * (`down` = -55, `up` = -120 khi dien thoai khong gui gi) cung "hon 6 dB" -> chieu `up` bi giam 12 dB VINH VIEN,
 * dung nguoc voi muc tieu "tang do nhay". Vi vay mot chieu chi duoc quyen cat chieu kia khi chinh no > -34 dBFS
 * (dung nghia "dang co tieng").
 */
export function decideTarget(dir: DuplexDir, upDb: number, downDb: number): number {
  const upActive = upDb > DUPLEX_THRESHOLD_DBFS;
  const downActive = downDb > DUPLEX_THRESHOLD_DBFS;
  if (dir === 'down') {
    // Dang co nguoi noi toi P4 va no hon han tieng o phong -> cat mic man (chan vong P4 -> mic P4 -> dien thoai).
    return upActive && upDb - downDb >= DUPLEX_DOMINANCE_DB ? -DUPLEX_DOWN_ATTEN_DB : 0;
  }
  // Tieng o phong (mic man) hon han tieng dien thoai -> cat duong dien thoai -> loa P4 (chan vong nguoc).
  return downActive && downDb - upDb >= DUPLEX_DOMINANCE_DB ? -DUPLEX_UP_ATTEN_DB : 0;
}

/**
 * Bo HALF-DUPLEX cho MOT server. Moi cuoc goi mot `DuplexState` (key = id thiet bi / cuoc goi).
 * Thuan so hoc: khong I/O, khong hen gio, khong doc env (tru khi tao bang `createHalfDuplex()` khong truyen `enabled`).
 */
export class HalfDuplex {
  readonly enabled: boolean;
  private readonly states = new Map<string, DuplexState>();
  private readonly now: () => number;
  private readonly log: boolean;

  constructor(opts: { enabled?: boolean; now?: () => number; log?: boolean } = {}) {
    this.enabled = opts.enabled ?? HALFDUPLEX_ENABLED;
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log ?? !process.env.VITEST;
  }

  /** Trang thai cua `callId` (tao neu chua co). */
  state(callId: string): DuplexState {
    let st = this.states.get(callId);
    if (!st) { st = newDuplexState(); this.states.set(callId, st); }
    return st;
  }

  /** Trang thai hien tai neu da co cuoc goi nay, nguoc lai `undefined`. */
  peek(callId: string): DuplexState | undefined { return this.states.get(callId); }

  /** Quen trang thai cua mot cuoc goi (ket thuc cuoc goi / bat dau phep do). */
  forget(callId: string): void { this.states.delete(callId); }

  /** Xoa toan bo (test). */
  reset(): void { this.states.clear(); }

  /** So cuoc goi dang duoc theo doi. */
  get size(): number { return this.states.size; }

  /**
   * Do nang luong cua MOT khung cua chieu `dir` roi tra ve buffer DA GIAM (cung do dai, buffer moi neu mau bi sua).
   *
   *   - `levelDb` (tuy chon): muc do THO cua khung nay, do o noi goi TRUOC chuoi EQ/AGC (xem dau file). Khong
   *     truyen -> tu do RMS tren chinh `pcm`.
   *   - `enabled === false` (CCR_CALL_HALFDUPLEX=0): tra ve DUNG buffer dau vao, khong copy, khong sua, khong doi
   *     trang thai -> passthrough y nguyen byte (A/B).
   */
  apply(callId: string, dir: DuplexDir, pcm: Buffer, levelDb?: number): Buffer {
    if (!this.enabled) return pcm;
    const n = Math.floor(pcm.length / 2);
    if (!n) return pcm;
    const now = this.now();
    const st = this.state(callId);
    const level = Number.isFinite(levelDb) ? (levelDb as number) : levelDbOf(pcm);
    if (dir === 'up') { st.upDb = level; st.upAt = now; } else { st.downDb = level; st.downAt = now; }

    const upDb = levelOf(st.upDb, st.upAt, now);
    const downDb = levelOf(st.downDb, st.downAt, now);
    const otherDb = dir === 'up' ? downDb : upDb;
    const silent = upDb < DUPLEX_SILENCE_DBFS && downDb < DUPLEX_SILENCE_DBFS;
    const target = silent ? 0 : decideTarget(dir, upDb, downDb);

    const prevGainDb = dir === 'up' ? st.upGainDb : st.downGainDb;
    let gainDb = prevGainDb;
    if (!silent) {
      // Di XUONG (giam nhieu hon) = attack nhanh; NHA RA (ve 0) = release cham.
      const tau = target < prevGainDb ? DUPLEX_ATTACK_MS : DUPLEX_RELEASE_MS;
      const durMs = (n / DUPLEX_SAMPLE_RATE) * 1000;
      const k = coef(tau, durMs);
      gainDb = clamp(prevGainDb + k * (target - prevGainDb), -maxAttenOf(dir), 0);
      // Duoi 0,05 dB coi nhu 0: duong release tiem can 0 theo ham mu nen se con lai nhung gia tri -0,03 dB vo nghia
      // (va lam moi khung bi copy lai vo ich). Nghe khong phan biet duoc 0,05 dB.
      if (Math.abs(gainDb) < 0.05) gainDb = 0;
    }
    if (dir === 'up') st.upGainDb = gainDb; else st.downGainDb = gainDb;
    if (gainDb < 0 || prevGainDb < 0) {
      if (target < 0) { if (dir === 'up') st.upDucked++; else st.downDucked++; }
      this.logLine(callId, st, upDb, downDb, dir, gainDb, target, prevGainDb, now);
    }
    const audible = level >= DUPLEX_SILENCE_DBFS;                 // khung NAY co tieng de giam khong
    st.last = {
      dir, levelDb: level, otherDb, targetDb: target, gainDb,
      attenDb: -gainDb, changed: !silent && audible && (gainDb < 0 || prevGainDb < 0), silent,
    };
    // Ca hai chieu im lang, hoac chinh khung nay im lang: KHONG dung vao mot mau nao (khong ai nghe thay, va khong
    // cap phat buffer vo ich). Gain van duoc cap nhat o tren nen khung CO tieng ke tiep da dung muc.
    if (silent || !audible) return pcm;
    if (prevGainDb === 0 && gainDb === 0) return pcm;            // khong co gi de giam -> nguyen ban
    return rampGain(pcm, prevGainDb, gainDb, n);
  }

  /** Dong `[duplex]` chan doan: chi in khi BAT DAU cat hoac 5 s/lan luc dang cat (khong spam log). */
  private logLine(callId: string, st: DuplexState, upDb: number, downDb: number,
    dir: DuplexDir, gainDb: number, target: number, prevGainDb: number, now: number): void {
    if (!this.log) return;
    const entering = target !== 0 && prevGainDb === 0;            // vua chuyen sang cat (hoac doi chieu cat)
    if (!entering && now - st.loggedAt < DUPLEX_LOG_MS) return;
    st.loggedAt = now;
    console.log(`[duplex] ${callId} up=${upDb.toFixed(1)}dBFS down=${downDb.toFixed(1)}dBFS ` +
      `giam ${dir} ${(-gainDb).toFixed(1)}dB (nham ${-target}dB) | tong: down ${(-st.downGainDb).toFixed(1)}dB, ` +
      `up ${(-st.upGainDb).toFixed(1)}dB`);
  }
}

/**
 * Ap gain tu `fromDb` (khung truoc) toi `toDb` (khung nay) theo kieu NOI TUYEN TREN TUNG MAU trong khung.
 * Nho vay mot buoc gain 17 dB cua attack 10 ms khong con la mot "bac" o bien khung (nguon tieng "cup"/"tach"):
 * tai moi mau, gain di mot doan nho.
 */
function rampGain(pcm: Buffer, fromDb: number, toDb: number, n: number): Buffer {
  const out = Buffer.allocUnsafe(pcm.length);
  for (let i = 0; i < n; i++) {
    // Mau dau tien dung DUNG gain cua khung truoc, mau cuoi cung dung gan gain cua khung nay: khong co buoc nhay.
    const g = i === 0 ? fromDb : fromDb + (toDb - fromDb) * (i / n);
    const lin = 10 ** (g / 20);
    const v = Math.round(pcm.readInt16LE(i * 2) * lin);
    out.writeInt16LE(v > 32767 ? 32767 : v < -32768 ? -32768 : v, i * 2);
  }
  if (pcm.length & 1) out[pcm.length - 1] = pcm[pcm.length - 1];   // duoi le: giu nguyen
  return out;
}

/** Tao mot bo HALF-DUPLEX doc lap (test / phep do). */
export function createHalfDuplex(opts: { enabled?: boolean; now?: () => number; log?: boolean } = {}): HalfDuplex {
  return new HalfDuplex(opts);
}

/**
 * Bo HALF-DUPLEX DUNG CHUNG cua server — `src/callBridge.ts` goi `duplex.apply(dev, 'up'|'down', pcm)`.
 * Trang thai theo `dev` (moi thiet bi trong cuoc goi mot trang thai; xoa trong `endCall()` / `playTestAudio()`).
 */
export const duplex = new HalfDuplex();
