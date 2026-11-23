// SPDX-License-Identifier: Apache-2.0
//
// Copyright (c) 2026 minhquanghp86
// Licensed under the Apache License, Version 2.0 (see LICENSE).

// (14/06/2026) NGUON HINH CHO LOP THONG BAO TOAN MAN (Shell `openOverlay`).
//
// Truoc day thong bao camera chi co MOT anh tinh: server doi tham so `camera:` thanh
// `<go2rtc>/api/frame.jpeg?src=<ten>` (mot khung JPEG, tai dung MOT lan) — do that tren may that
// 22/11/2026: moi khung mat 4,9 s de render, va <img> KHONG tu cap nhat, nen man hinh chi hien
// mot tam anh dung im (dung loi nguoi dung bao).
//
// Nay: `camera:` -> LUONG MJPEG (`/api/stream.mjpeg`, multipart/x-mixed-replace) — Chromium ve
// tung khung trong <img> ma khong can JavaScript. Do that qua proxy cua addon: 11,8-12,1 khung/giay,
// ~8 KB/khung o 480x272; khung DAU TIEN den sau 0,26-1,1 s.
//
// Ham o day chi QUYET DINH dung gi (thuan, khong dung DOM) de test duoc:
//   stream -> <img src=stream> (MJPEG), anh tinh chi la du phong khi luong loi
//   image  -> <img src=image> nhu cu (tham so `image:` cua automation)
//   video  -> <video src=...>
//   audio  -> <audio src=...>

/** Cac truong hinh cua mot thong bao (giong `Notice` cua Shell, dat o day de test khong phai nap Shell). */
export interface OverlayMedia {
  /** Anh tinh (tham so `image:` cua automation). */
  img?: string | null;
  /** Video (tham so `video:`). */
  vid?: string | null;
  /** Am thanh (tham so `audio:`). */
  aud?: string | null;
  /** Luong MJPEG (tu tham so `camera:`). Uu tien cao nhat. */
  str?: string | null;
  /** Anh tinh du phong khi luong loi (poster). */
  pst?: string | null;
  /** (23/11/2026) Lap kin khung (cat 2 mep) thay vi letterbox — cho man vuong 480x480 voi camera 16:9. */
  fill?: boolean | null;
}

export type OverlayPlan =
  /** `src` la luong MJPEG; `poster` = anh tinh hien truoc / thay the khi luong loi (co the null). */
  | { kind: 'stream'; src: string; poster: string | null }
  | { kind: 'video'; src: string }
  | { kind: 'audio'; src: string }
  | { kind: 'image'; src: string }
  | { kind: 'none' };

/**
 * Chon nguon hinh cho lop thong bao.
 * Thu tu uu tien: luong MJPEG (`str`) > video > am thanh > anh tinh (`img`) > anh du phong (`pst`).
 * Ly do `str` dung dau: do that 22/11/2026 — thong bao camera chi co `image` cho ra MOT khung
 * (1 khung/10 s toi man); luong MJPEG cho 11,8-12,1 khung/giay.
 */
export function overlayPlan(m: OverlayMedia): OverlayPlan {
  const s = (v: string | null | undefined): string => (typeof v === 'string' ? v.trim() : '');
  const str = s(m.str), vid = s(m.vid), aud = s(m.aud), img = s(m.img), pst = s(m.pst);
  if (str) return { kind: 'stream', src: str, poster: img || pst || null };
  if (vid) return { kind: 'video', src: vid };
  if (aud) return { kind: 'audio', src: aud };
  if (img) return { kind: 'image', src: img };
  if (pst) return { kind: 'image', src: pst };
  return { kind: 'none' };
}

/**
 * (23/11/2026) Co nen LAP KIN khung (cover) khong:
 *  - MAC DINH: `contain` (giu nguyen khung hinh, co dai den neu lech ti le) — dung nhu mong doi;
 *  - chi khi automation dat `fill: true` moi dung `cover` (cat 2 mep).
 * `camAspect` = chieu rong/cao cua khung hinh camera (16/9 = 1,78).
 */
export function shouldFill(m: OverlayMedia, _screenW?: number, _screenH?: number, _camAspect?: number): boolean {
  // (23/11/2026) SUA THEO YEU CAU: KHONG tu dong cat khung. Nguoi dung chon `contain` (giu nguyen hinh, co dai den)
  // — tren man 4.0" 480x480 viec cat 2 mep lam mat noi dung camera. Chi lap kin khi automation dat `fill: true`.
  return m.fill === true;
}

/** Lop thong bao co phu TOAN MAN khong (co hinh). */
export function isFullMedia(m: OverlayMedia): boolean {
  return overlayPlan(m).kind !== 'none';
}
