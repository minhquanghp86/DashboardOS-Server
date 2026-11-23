// SPDX-License-Identifier: Apache-2.0
//
// Copyright (c) 2026 minhquanghp86
// Licensed under the Apache License, Version 2.0 (see LICENSE).

// (26/09/2026 OS-5) THONG BAO tu Home Assistant (chuong cua, canh bao, nhac viec...) toi panel.
// HA goi POST /notify (rest_command, xem DOCS.md) -> server luu lich su theo TUNG man hinh va hien the noi tren Shell.
// Muc uu tien:
//   normal   — the noi tu an (8 s); KHONG hien khi Khong lam phien (van vao lich su).
//   high     — bat sang man hinh + chuong ngan, the giu 20 s; KHONG hien khi Khong lam phien.
//   critical — (chuong cua, bao chay...) bat sang + chuong, the giu toi khi cham, hien CA KHI Khong lam phien.

export type Priority = 'normal' | 'high' | 'critical' | 'urgent';

export interface Notice {
  id: number;
  title: string;
  message: string;
  priority: Priority;
  /** Thoi diem nhan (ms epoch). */
  ts: number;
  /** Cham vao the: mo ung dung trong menu (vd 'cams') ... */
  app?: string;
  /** ... hoac mo URL nay. */
  url?: string;
  /** Anh kem theo (vd anh chup camera cong qua go2rtc). */
  image?: string;
  video?: string;
  audio?: string;
  /**
   * (14/06/2026) LUONG MJPEG cua camera (tu tham so `camera:` cua automation). Shell ve thang trong <img>
   * (multipart/x-mixed-replace) -> VIDEO TRUC TIEP. Truoc day `camera:` chi doi ra `image:` (mot khung, khong
   * tu cap nhat) nen man hinh chi hien anh chup tinh.
   */
  stream?: string;
  /** (14/06/2026) Anh tinh du phong (poster) hien ngay trong khi cho khung dau cua `stream`, va khi luong loi. */
  poster?: string;
  /** (23/11/2026) Lap kin khung (cover, cat 2 mep) thay vi letterbox. Bo trong = tu dong theo ti le man/camera. */
  fill?: boolean;
  /** (19/10/2026) So giay hien thi thong bao truoc khi thu gon. */
  duration?: number;
  /** (01/10/2026) Tham so cho ung dung `app` khi cham (vd id cuoc tro chuyen cua Tin nhan). */
  arg?: string;
  /** (01/10/2026) Nguoi dung DA XEM tren chinh man hinh nay (cham the / mo thanh keo xuong). The noi tu hien khi khong
   *  ai nhin KHONG tinh la da xem — cham bao (chuong) con cho toi khi co nguoi xem tren dung man hinh do. */
  seen?: boolean;
  /** (16/10/2026) CUOC GOI NHO (chuong cong / goi giua cac man): man hinh cho hien the do lon rieng, KHONG tat man hinh cho. */
  missed?: boolean;
}

/** Loai thong bao: tin nhan (ung dung Tin nhan) hay thong bao thuong (HA /notify, Bang tin...). */
export const noticeKind = (n: Pick<Notice, 'app'>): 'chat' | 'nt' => (n.app === 'chat' ? 'chat' : 'nt');

export interface NotifyRequest {
  title?: unknown; message?: unknown; priority?: unknown; device?: unknown; app?: unknown; url?: unknown;
  image?: unknown; video?: unknown; audio?: unknown; camera?: unknown; duration?: unknown; arg?: unknown; missed?: unknown;
  /** (14/06/2026) `stream` (mac dinh) = `camera:` thanh LUONG MJPEG; `snapshot` = mot anh tinh nhu truoc. */
  camera_mode?: unknown;
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/**
 * Kiem tra/chuan hoa yeu cau tu HA. Tra ve loi (chuoi) neu khong hop le. `go2rtc` = dia chi go2rtc de dung hinh tu ten
 * luong camera (truong `camera`).
 *
 * (14/06/2026) SUA LOI "man hinh chi hien anh chup tinh": truong `camera` truoc day doi ra `image` =
 * `<go2rtc>/api/frame.jpeg?src=<ten>` — MOT khung JPEG, va the <img> cua Shell khong bao gio tai lai. Do that tren may
 * that 22/11/2026 (P4 esp32-80f1b2d35fb5, camera ezviz): frame.jpeg mat 4,9 s/khung va chi 1 khung / 10 s toi man.
 * Nay `camera` -> `stream` = `<go2rtc>/api/stream.mjpeg?src=<ten>` (multipart/x-mixed-replace): 11,8-12,1 khung/giay,
 * khung dau sau 0,26-1,1 s. `image` van giu lam poster (hien ngay, thay the neu luong loi).
 *
 * Tuong thich nguoc:
 *   - Automation cu chi gui `camera:` -> TU DONG thanh luong (khong phai sua gi).
 *   - `camera_mode: snapshot` -> giu nguyen hanh vi cu (mot anh tinh) cho ai can.
 */
/**
 * (22/11/2026) Do that tren P4: `/go2rtc/api/stream.mjpeg?src=ezviz` cho **1,6 khung/giay** vi go2rtc phai
 * giai ma + nen lai khung 1920x1080; them `&w=480&h=272` cho **12,0 khung/giay** (7,9 KB/khung). Vi vay moi man
 * nhan mot URL MJPEG **da scale dung do phan giai cua no** — man 480x272/480x480/800x480/1024x600 khac nhau.
 */
export function streamForSize(base: string, src: string, w?: number, h?: number): string {
  const url = `${base}/api/stream.mjpeg?src=${src}`;
  if (!w || !h || !Number.isFinite(w) || !Number.isFinite(h) || w < 16 || h < 16) return url;
  const sw = Math.min(1920, Math.round(w / 2) * 2), sh = Math.min(1080, Math.round(h / 2) * 2);
  return `${url}&w=${sw}&h=${sh}`;
}

/** Poster (1 khung tinh) cung scale theo man, de khung dau khong phai giai ma anh 1080p tren ESP32. */
export function posterForSize(base: string, src: string, w?: number, h?: number): string {
  const url = `${base}/api/frame.jpeg?src=${src}`;
  if (!w || !h || !Number.isFinite(w) || !Number.isFinite(h) || w < 16 || h < 16) return url;
  return `${url}&w=${Math.round(w / 2) * 2}&h=${Math.round(h / 2) * 2}`;
}

/**
 * (22/11/2026) Doi `stream`/`poster` cua MOT thong bao sang dung do phan giai cua man nhan.
 * Ly do: go2rtc tra MJPEG 1,6 khung/giay o 1920x1080 nhung 12,0 khung/giay khi them `w/h` = kich thuoc man.
 * Tra ve notice moi (khong sua ban goc trong lich su).
 */
export function scaleNoticeMedia<T extends { stream?: string; poster?: string }>(n: T, w?: number, h?: number): T {
  if (!w || !h) return n;
  const out = { ...n };
  const srcOf = (u: string): string | null => {
    try { const p = new URL(u); return p.searchParams.get('src'); } catch { return null; }
  };
  const baseOf = (u: string): string | null => {
    try { const p = new URL(u); return `${p.origin}${p.pathname.replace(/\/api\/(stream\.mjpeg|frame\.jpeg)$/, '')}`; } catch { return null; }
  };
  if (out.stream) { const sr = srcOf(out.stream), b = baseOf(out.stream); if (sr && b) out.stream = streamForSize(b, sr, w, h); }
  if (out.poster) { const sr = srcOf(out.poster), b = baseOf(out.poster); if (sr && b) out.poster = posterForSize(b, sr, w, h); }
  return out;
}

export function parseNotify(body: NotifyRequest, go2rtc: string):
  { ok: true; device: string; notice: Omit<Notice, 'id' | 'ts'> } | { ok: false; error: string } {
  const title = str(body.title, 80), message = str(body.message, 300);
  if (!title && !message) return { ok: false, error: 'can title hoac message' };
  const pr = str(body.priority, 10);
  const priority: Priority = pr === 'urgent' ? 'urgent' : pr === 'high' || pr === 'critical' ? pr : 'normal';
  const url = str(body.url, 1024);
  if (url && !/^https?:\/\//i.test(url)) return { ok: false, error: 'url phai la http(s)' };
  const image = str(body.image, 2048);
  if (image && !/^(https?:\/\/|\/notify\/media\/)/i.test(image)) return { ok: false, error: 'image phai la http(s) hoac /notify/media/...' };
  const video = str(body.video, 2048);
  if (video && !/^(https?:\/\/|\/notify\/media\/)/i.test(video)) return { ok: false, error: 'video phai la http(s) hoac /notify/media/...' };
  const audio = str(body.audio, 2048);
  if (audio && !/^(https?:\/\/|\/notify\/media\/)/i.test(audio)) return { ok: false, error: 'audio phai la http(s) hoac /notify/media/...' };
  const camera = str(body.camera, 64);
  // (14/06/2026) `stream` (mac dinh) | `snapshot`. Gia tri la -> mac dinh `stream` (KHONG lam hong yeu cau cu).
  const cameraMode = str(body.camera_mode, 12).toLowerCase() === 'snapshot' ? 'snapshot' : 'stream';
  // (23/11/2026) `fill`: lap kin khung (cover). Khong gui = tu dong (xem cameraOverlay.shouldFill).
  const fillRaw = (body as { fill?: unknown }).fill;
  const fill = fillRaw === undefined || fillRaw === null ? undefined : (fillRaw === true || fillRaw === 'true' || fillRaw === '1');
  let stream = '', poster = '';
  if (camera) {
    if (!/^[\w.-]+$/.test(camera)) return { ok: false, error: 'ten camera khong hop le' };
    const base = go2rtc.replace(/\/$/, ''), name = encodeURIComponent(camera);
    if (cameraMode === 'snapshot') {
      poster = `${base}/api/frame.jpeg?src=${name}`;
    } else {
      stream = `${base}/api/stream.mjpeg?src=${name}`;
      poster = `${base}/api/frame.jpeg?src=${name}`;
    }
  }
  const durRaw = Number(body.duration);
  const duration = Number.isFinite(durRaw) && durRaw >= 0 ? Math.min(600, Math.round(durRaw)) : undefined;
  const app = str(body.app, 40);
  const arg = app ? str(body.arg, 64) : '';
  return {
    ok: true,
    device: str(body.device, 64) || 'all',
    notice: { title, message, priority, ...(body.missed === true ? { missed: true } : {}), ...(app ? { app } : {}), ...(arg ? { arg } : {}), ...(url ? { url } : {}), ...(image ? { image } : {}), ...(video ? { video } : {}), ...(audio ? { audio } : {}), ...(stream ? { stream } : {}), ...(poster ? { poster } : {}), ...(fill !== undefined ? { fill } : {}), ...(duration !== undefined ? { duration } : {}) },
  };
}

/** Co hien the noi khong (luon vao lich su du hien hay khong). */
export function shouldPopup(n: Pick<Notice, 'priority'>, dnd: boolean): boolean {
  return n.priority === 'urgent' || !dnd || n.priority === 'critical';
}

/** Co bat sang man hinh (va keu chuong) khong. */
export function shouldWake(n: Pick<Notice, 'priority'>, dnd: boolean): boolean {
  return n.priority === 'urgent' || n.priority === 'critical' || (n.priority === 'high' && !dnd);
}

/** Lich su thong bao cua MOT man hinh: toi da `max` muc, moi nhat truoc. */
export class NoticeStore {
  private items: Notice[] = [];
  private nextId = 1;
  /** (01/10/2026) Goi sau moi thay doi — server luu ra dia (thong bao chua xem con sau khi cap nhat addon). */
  onChange: () => void = () => { };
  constructor(private max = 30) { }

  add(n: Omit<Notice, 'id' | 'ts'>, now = Date.now()): Notice {
    // Cung ung dung + cung tham so (vd cung mot cuoc tro chuyen): thay the bao cu, khong chat dong.
    if (n.app && n.arg) this.items = this.items.filter((x) => !(x.app === n.app && x.arg === n.arg));
    const full: Notice = { ...n, id: this.nextId++, ts: now };
    this.items.unshift(full);
    if (this.items.length > this.max) this.items.length = this.max;
    this.onChange();
    return full;
  }
  get(id: number): Notice | undefined { return this.items.find((n) => n.id === id); }
  remove(id: number): void { this.removeWhere((n) => n.id === id); }
  clear(): void { if (this.items.length) { this.items = []; this.onChange(); } }
  /** true = co thay doi. */
  removeWhere(pred: (n: Notice) => boolean): boolean {
    const before = this.items.length;
    this.items = this.items.filter((n) => !pred(n));
    if (this.items.length === before) return false;
    this.onChange(); return true;
  }
  /** Danh dau DA XEM moi thong bao loai `kind` (mo thanh keo xuong: thong bao thuong). true = co thay doi. */
  markSeen(kind: 'chat' | 'nt' | 'all' = 'all'): boolean {
    let ch = false;
    for (const n of this.items) if (!n.seen && (kind === 'all' || noticeKind(n) === kind)) { n.seen = true; ch = true; }
    if (ch) this.onChange();
    return ch;
  }
  unseen(kind: 'chat' | 'nt'): number { return this.items.filter((n) => !n.seen && noticeKind(n) === kind).length; }
  /** Luu / nap (file /data). */
  dump(): { next: number; items: Notice[] } { return { next: this.nextId, items: this.items }; }
  restore(d: { next?: number; items?: Notice[] } | undefined): void {
    if (!d || !Array.isArray(d.items)) return;
    this.items = d.items.filter((n) => n && typeof n.id === 'number').slice(0, this.max);
    this.nextId = Math.max(Number(d.next) || 1, ...this.items.map((n) => n.id + 1));
  }
  /** `limit` muc moi nhat — gui xuong Shell (giu goi trang thai nho). */
  list(limit = 10): Notice[] { return this.items.slice(0, limit); }
  get size(): number { return this.items.length; }
}
