// SPDX-License-Identifier: Apache-2.0
//
// Copyright (c) 2026 minhquanghp86
// Licensed under the Apache License, Version 2.0 (see LICENSE).

// (25/09/2026) SHELL — giao dien he thong kieu dien thoai, tiem vao MOI tab cua panel (xem Dashboard OS-Client: docs/server-noi-bo/KE-HOACH-GIAO-DIEN-HE-DIEU-HANH.md).
//   - Dong ho giua mep tren: CHI hien thi (26/09: cham xuyen qua xuong tab HA).
//   - Thanh keo xuong: SERVER nhan dien cu chi keo tu mep tren (src/gestures.ts) roi goi __rwvShell.gesture(...).
//     Dong: cham nen mo / vuot len tren thanh.
//   - Man hinh chinh cua OS (/os/home): tien ich + luoi ung dung + dock (Home Assistant dau tien).
// Du lieu: window.__RWV_CFG (server chen khi tiem) + trang thai thiet bi server day qua __rwvShell.state().
// Shadow DOM DONG: CSS cua trang khong anh huong. Chi DOM API (Trusted Types).
import { CSS } from './styles';
import { el, mdi, pad2, setText, svgEl } from './dom';
import { App, appIcon, weatherIcon } from './icons';
import { mountBrowserBar } from './browserBar';
import { HomeApi, mountHome } from './home';
import { classifyLockGesture } from './lockGesture';
import { loadClockFont } from './clockFont';
import { LwData, buildLockWidgets, lwModel } from './lockWidgets';
import { SbData, dropPath, netIcon, powerIcons, sbKey } from './statusIcons';
import { isFullMedia, overlayPlan } from '../cameraOverlay';
import type { HomeLayout } from '../homeLayout';

declare global { interface Window { [k: string]: any } }

type Motion = 'full' | 'reduced' | 'minimal';
interface Cfg {
  apps: App[]; home?: HomeLayout; groups: [string, string][]; motion: Motion;
  urls: { osHome: string; ha: string; weather: string; timer: string; cams: string };
  bindings: { url: string; control: string };
}
interface DevState {
  b: number | null; v: number | null; on: boolean; ctl: boolean; tv: boolean; skewMs: number; tz: number;
  tg: { noSleep: boolean; muted: boolean; aec: boolean } | null;
  /** (07/10/2026) fl..hr: chi tiet cho man hinh khoa (server >= 2.9.109; co the thieu). */
  wx: { t: number; code: number; day: boolean; pp: number | null; name: string; fl?: number | null; rh?: number | null; ws?: number | null;
    hi?: number | null; lo?: number | null; aqi?: number | null; pm?: number | null; hr?: { h: number; t: number; c: number; p: number | null }[] } | null;
  tm: { endsAt: number; label: string } | null;
  /** (26/09/2026) Tab nen dang phat (Radio/Nhac): k = khoa tab o server, l = ten ung dung. Server < 2.9.49 khong gui. */
  np?: { k: string; l: string }[];
  /** (26/09/2026 OS-5) Thong bao moi nhat truoc + Khong lam phien. Server < 2.9.53 khong gui. */
  nt?: Notice[];
  dnd?: boolean;
  /** (27/09/2026) Firmware co tro ly giong noi (nut "Tro ly"). */
  va?: boolean;
  /** (30/09/2026) Select "Nguon phat hien nguoi" cua thiet bi (chi P4 co). Server < 2.9.81 khong gui. */
  ps?: { v: string; o: string[] } | null;
  /** (01/10/2026) CHUA XEM tren chinh man hinh nay: cu = tin nhan chua doc, nu = thong bao thuong. Server < 2.9.94 khong gui. */
  cu?: number;
  nu?: number;
  /** (01/10/2026) Am thanh kieu dien thoai (server >= 2.9.95): snd = firmware tu phat am (co am luong Thong bao / Bao
   *  thuc); sv = hai am luong do (%); al = bao thuc ke tiep; rg = bao thuc / hen gio dang reo tren man hinh nay. */
  snd?: boolean;
  sv?: { alert: number; alarm: number };
  al?: { t: string; at: number; l: string } | null;
  rg?: AlarmInfo | null;
  /** (08/10/2026) Widget man hinh khoa: nang luong / lich / camera (server >= 2.9.116). */
  lw?: LwData | null;
  /** (08/10/2026) Pin (%) + mang (Wi-Fi / Ethernet) canh dong ho. */
  sb?: SbData | null;
}
/** Bao thuc dang reo: id, nhan, gio "HH:MM", phut bao lai (0 = khong), tm = hen gio, beep = keu bang WebAudio (firmware cu). */
interface AlarmInfo { id: string; l: string; t: string; sz: number; tm: boolean; beep?: boolean }
/** s = da xem tren man hinh nay; k = loai (chat = tin nhan, nt = thong bao thuong). Server < 2.9.94 khong gui. */
interface Notice { id: number; t: string; m: string; p: 'normal' | 'high' | 'critical' | 'urgent'; ts: number; img: string | null; vid: string | null; aud: string | null; dur: number | null; act: boolean;
  /** (14/06/2026) LUONG MJPEG cua camera (`camera:` cua automation) + anh tinh du phong. Server cu khong gui -> undefined. */
  str?: string | null; pst?: string | null;
  s?: boolean; k?: 'chat' | 'nt'; mc?: number }

(function () {
  if (window.__rwvShell) return;
  // (27/09/2026) Chi khung CHINH: script tiem chay ca trong iframe (the iframe tren dashboard HA, camera trong trang
  // chuong cua) — truoc day moi iframe mang them mot Shell thua (nut mo rong, thanh keo xuong trong khung).
  try { if (window.top !== window) return; } catch { return; }
  const CFG: Cfg = window.__RWV_CFG;
  if (!CFG) return;
  const Z = '2147483647';
  const WD = ['Chủ nhật', 'Thứ hai', 'Thứ ba', 'Thứ tư', 'Thứ năm', 'Thứ sáu', 'Thứ bảy'];

  function sendControl(obj: unknown): void {
    const fn = window[CFG.bindings.control];
    if (typeof fn === 'function') { try { fn(JSON.stringify(obj)); } catch { /* bo qua */ } }
  }
  // (26/09/2026 OS-2) MOI ung dung la MOT TAB rieng o server (Dashboard OS-Client: docs/server-noi-bo/KE-HOACH-GIAO-DIEN-HE-DIEU-HANH.md muc 3.1):
  // cham mot ung dung KHONG con dieu huong tab hien tai (location.href) ma xin SERVER chuyen sang dung tab do —
  // server tu tao tab neu chua co, giu am cac tab khac (radio/nhac van phat khi khong active). Nho vay quay lai
  // Home Assistant tuc thi, khong tai lai.
  function openApp(id: string): void { closeShade(false); closeRecents(); sendControl({ app: id }); }
  function openRecents(): void { closeShade(false); sendControl({ recents: 1 }); }
  function hasApp(id: string): boolean { return CFG.apps.some((a) => a.id === id); }

  // ── Khung Shadow DOM ──────────────────────────────────────────────────
  const host = document.createElement('rwv-shell');
  host.style.cssText = `position:fixed;inset:0;z-index:${Z};pointer-events:none;display:block`;
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = CSS;
  shadow.appendChild(style);
  loadClockFont();  // (07/10/2026) font dong ho man hinh khoa (Bebas Neue, chi chu so)
  const root = el('div', 'root');
  shadow.appendChild(root);

  // ── Trang thai + dong ho ─────────────────────────────────────────────
  let st: DevState | null = null;
  const clockEls: Element[] = [];
  const dateEls: Element[] = [];
  /** Gio THIET BI (doc bang getUTC*). (07/10/2026) Chua co (thiet bi chua bao gio, tab vua tao) -> gio TRINH DUYET (may
   *  chu HA, cung mui gio) thay vi null: truoc day man hinh cho / khoa lang le KHONG hien ma server tuong da hien. */
  function deviceNow(): Date {
    if (st && st.tv) return new Date(Date.now() + st.skewMs + st.tz * 60000);
    return new Date(Date.now() - new Date().getTimezoneOffset() * 60000);
  }
  function dateText(t: Date): string {
    const dd = t.getUTCDate(), mm = t.getUTCMonth() + 1;
    let s = WD[t.getUTCDay()] + ', ' + pad2(dd) + '/' + pad2(mm);
    const L = window.RwvLunar;
    if (L) { const l = L.solar2lunar(dd, mm, t.getUTCFullYear(), 7); s += ' · ' + l.day + '/' + l.month + (l.leap ? ' nhuận' : '') + ' âm lịch'; }
    return s;
  }

  // ── Nut dong ho ──────────────────────────────────────────────────────
  // (26/09/2026) CHI HIEN THI gio, KHONG nhan cham: nut nam de len dai tab cua HA -> bam tab hay bi bat nham thanh mo
  // thanh trang thai (nguoi dung bao). Thanh trang thai chi mo bang cu chi vuot tu mep tren (server, src/gestures.ts).
  const pill = el('div', 'pill');
  pill.setAttribute('aria-hidden', 'true');
  const drop = svgEl('svg', { class: 'drop', viewBox: '0 0 104 22', width: '104', height: '22' });
  const dropP = svgEl('path', { d: dropPath(0).d, fill: 'rgba(20,20,20,0.6)' });
  drop.appendChild(dropP);
  const pillT = el('span', 't');
  const pillChev = mdi('chevdown', 'chev');
  // (08/10/2026) Pin ben trai, mang ben phai gio (luoi 3 cot: gio luon o chinh giua du hai ben rong hep khac nhau).
  const sbL = el('span', 'sb-l'), sbR = el('span', 'sb-r'), pillRow = el('div', 'prow');
  pillRow.append(sbL, pillT, sbR);
  pill.append(drop, pillRow, pillChev);
  let sbShown = '';
  function renderStatusIcons(sb: SbData | null | undefined) {
    const k = sbKey(sb);
    if (k === sbShown) return;
    sbShown = k;
    sbL.replaceChildren(...powerIcons(sb));
    sbR.replaceChildren(...(sb?.nw ? [netIcon(sb.nw)] : []));
    const g = dropPath(k ? 50 : 0);
    dropP.setAttribute('d', g.d);
    drop.setAttribute('viewBox', `0 0 ${g.w} 22`); drop.setAttribute('width', String(g.w));
    pill.classList.toggle('wide', !!k);
  }

  // ── Thanh keo xuong ──────────────────────────────────────────────────
  const scrim = el('div', 'scrim');
  const shade = el('div', 'shade');
  const inner = el('div', 'shade-in');
  const handle = el('div', 'handle');
  shade.append(inner, handle);

  // Hang thong tin
  const info = el('div', 'info');
  const infoL = el('div');
  const sClock = el('div', 'clock'); const sDate = el('div', 'date');
  infoL.append(sClock, sDate); clockEls.push(sClock); dateEls.push(sDate);
  const timerChip = el('button', 'chip timer'); timerChip.append(mdi('timer'), el('span'));
  const wxChip = el('button', 'chip'); const wxIcoBox = el('span'); const wxTxt = el('span');
  wxChip.append(wxIcoBox, wxTxt);
  timerChip.addEventListener('click', () => openApp('timer'));
  // (01/10/2026) Bao thuc ke tiep (trong 24 gio) — cham mo ung dung Bao thuc.
  const alarmChip = el('button', 'chip alarmc'); alarmChip.append(mdi('alarm'), el('span'));
  alarmChip.addEventListener('click', () => openApp('alarm'));
  wxChip.addEventListener('click', () => openApp('weather'));
  info.append(infoL, el('div', 'spacer'), alarmChip, timerChip, wxChip);

  // O bat/tat nhanh
  interface Tile { el: HTMLElement; on: boolean; at: number; set(on: boolean): void }
  function makeTile(field: string, label: string, icon: string, color: string): Tile {
    const b = el('button', 'tile'); b.append(mdi(icon), el('span', '', label));
    const t: Tile = {
      el: b, on: false, at: 0,
      set(on: boolean) { if (Date.now() - t.at < 1500) return; show(on); },
    };
    function show(on: boolean) { t.on = on; b.classList.toggle('on', on); b.style.background = on ? color : ''; b.setAttribute('aria-pressed', String(on)); }
    b.addEventListener('click', (e) => { e.stopPropagation(); show(!t.on); t.at = Date.now(); sendControl({ f: field, v: t.on ? 1 : 0 }); });
    return t;
  }
  // (26/09/2026) 'ns' (No Sleep cua firmware) doi ten thanh "Man hinh cho": BAT = khong tat den nen, ranh thi hien man
  // hinh cho (dong ho); TAT = tat den nen sau Sleep time. Cung cong tac, chi doi ten/bieu tuong cho dung y nghia.
  const tiles = [makeTile('ns', 'Màn hình chờ', 'clock', '#fbbf24'), makeTile('mu', 'Im lặng', 'mute', '#f87171'), makeTile('aec', 'Khử vọng', 'mic_aec', '#34d399')];
  // (26/09/2026 OS-5) Khong lam phien: o SERVER (khong can firmware ho tro) nen hien tren moi man hinh.
  const dndTile = makeTile('dnd', 'Không làm phiền', 'bell_off', '#a78bfa');
  const tilesBox = el('div', 'tiles'); tiles.forEach((t) => tilesBox.appendChild(t.el)); tilesBox.appendChild(dndTile.el);

  // Thanh truot
  interface Slider { el: HTMLElement; set(v: number | null): void }
  function makeSlider(field: string, icon: string, color: string, label = ''): Slider {
    const track = el('div', 'slider'); const fill = el('div', 'fill'); fill.style.background = color;
    const pct = el('div', 'pct');
    track.append(fill, mdi(icon), pct);
    let value = 0, dragging = false, releasedAt = 0, lastSent = 0, timer: number | undefined;
    const show = (v: number) => { value = v; fill.style.width = v + '%'; pct.textContent = (label ? label + ' ' : '') + v + '%'; };
    const fromX = (x: number) => { const r = track.getBoundingClientRect(); return Math.max(0, Math.min(100, Math.round((x - r.left) / r.width * 100))); };
    const send = (final: boolean) => {
      const now = Date.now(); clearTimeout(timer);
      if (final || now - lastSent >= 150) { lastSent = now; sendControl({ f: field, v: value }); }
      else timer = window.setTimeout(() => send(true), 150 - (now - lastSent));
    };
    track.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation(); dragging = true;
      try { track.setPointerCapture(e.pointerId); } catch { /* */ }
      show(fromX(e.clientX)); send(false);
    });
    track.addEventListener('pointermove', (e) => { if (dragging) { show(fromX(e.clientX)); send(false); } });
    const end = () => { if (!dragging) return; dragging = false; releasedAt = Date.now(); send(true); };
    track.addEventListener('pointerup', end); track.addEventListener('pointercancel', end);
    return { el: track, set(v) { if (v == null || dragging || Date.now() - releasedAt < 1500) return; show(v); } };
  }
  const bri = makeSlider('b', 'sun', '#f59e0b');
  const vol = makeSlider('v', 'vol', '#3b82f6');
  const sliders = el('div', 'sliders'); sliders.append(bri.el, vol.el);
  // (01/10/2026) Bang am luong kieu dien thoai: nut ⌄ canh thanh am luong mo them Thong bao / Bao thuc (chi man tu phat am
  // — firmware ?snd=1). Thanh am luong san co = Media (YouTube, nhac, video...). Gia tri luu o server (src/sound.ts).
  const sndMore = el('button', 'snd-more'); sndMore.append(mdi('chevdown')); sndMore.setAttribute('aria-label', 'Âm lượng khác');
  const alertSl = makeSlider('alert', 'bell', '#f59e0b', 'Thông báo');
  const alarmSl = makeSlider('alarm', 'alarm', '#6366f1', 'Báo thức');
  const sndRow = el('div', 'sliders snd-row'); sndRow.append(alertSl.el, alarmSl.el); sndRow.style.display = 'none';
  let sndOpen = false;
  sndMore.addEventListener('click', (e) => {
    e.stopPropagation(); sndOpen = !sndOpen;
    sndRow.style.display = sndOpen ? '' : 'none'; sndMore.classList.toggle('open', sndOpen);
    if (shadeVisible > 0) setVisible(fullH(), false);
  });
  sliders.appendChild(sndMore);
  const ctl = el('div', 'ctl'); ctl.append(tilesBox, sliders, sndRow);

  // (30/09/2026) Hang "Phat hien nguoi": chon nguon danh thuc man hinh (select cua firmware P4 qua HA). "Tắt" dung dau.
  const psBox = el('div', 'ps'); psBox.style.display = 'none';
  const psLbl = el('div', 'ps-l'); psLbl.append(mdi('eye'), el('span', '', 'Phát hiện người'));
  const psSeg = el('div', 'seg'); psSeg.setAttribute('role', 'radiogroup'); psSeg.setAttribute('aria-label', 'Phát hiện người');
  psBox.append(psLbl, psSeg);
  let psSig = '', psPick = '', psAt = 0;
  function psMark(v: string) {
    psSeg.querySelectorAll<HTMLElement>('button').forEach((b) => {
      const on = b.dataset.v === v; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on));
    });
  }
  function renderPresenceSel(ps: { v: string; o: string[] } | null | undefined) {
    const show = !!ps && ps.o.length > 1;
    if ((psBox.style.display !== 'none') !== show) {
      psBox.style.display = show ? '' : 'none';
      if (shadeVisible > 0) setVisible(fullH(), false);
    }
    if (!ps || !show) return;
    const opts = [...ps.o].sort((a, b) => Number(b === 'Tắt') - Number(a === 'Tắt'));
    const sig = opts.join('|');
    if (sig !== psSig) {
      psSig = sig;
      psSeg.replaceChildren(...opts.map((o) => {
        const b = el('button', o === 'Tắt' ? 'off' : '', o); b.dataset.v = o; b.setAttribute('role', 'radio');
        b.addEventListener('click', (e) => { e.stopPropagation(); psPick = o; psAt = Date.now(); psMark(o); sendControl({ ps: 'set', v: o }); });
        return b;
      }));
    }
    psMark(Date.now() - psAt < 4000 ? psPick : ps.v);
  }

  // Hang bieu tuong mo trang toan man hinh (chi hien muc DA CO — khong de nut chet)
  const shortcuts = el('div', 'shortcuts');
  let vaBtn: HTMLElement | null = null;
  const SC: [string, string, string | null, () => void][] = [
    ['apps', 'Ứng dụng', null, () => openApp('__system')],
    ['ha', 'Home Assistant', 'home', () => openApp('home')],
    // (01/10/2026) "Camera" = chup/quay cua CHINH panel (chi man co camera — P4); "Frigate" = camera nha.
    ['camera', 'Camera', 'camera', () => openApp('camera')],
    ['frigate', 'Frigate', 'cams', () => openApp('cams')],
    ['recents', 'Gần đây', null, openRecents],
    ['settings', 'Cài đặt', 'settings', () => openApp('settings')],
    ['mic', 'Trợ lý', '__va', () => { closeShade(false); sendControl({ assist: 1 }); }],
  ];
  for (const [icon, label, appId, fn] of SC) {
    // Chi hien khi ung dung THAT SU co (chua bi an o Menu panel, hoac chua co Home URL) — khong de nut chet.
    if (appId && appId !== '__va' && !hasApp(appId)) continue;
    const b = el('button', 'sc');
    if (appId === '__va') { b.style.display = 'none'; vaBtn = b; } const c = el('span', 'b'); c.appendChild(mdi(icon)); b.append(c, el('span', 'l', label));
    if (icon === 'ha') c.style.background = '#1a8fd6';
    b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
    shortcuts.appendChild(b);
  }
  // The "Dang phat" (Dashboard OS-Client: docs/server-noi-bo/KE-HOACH-GIAO-DIEN-HE-DIEU-HANH.md muc 5.2): Radio/Nhac dang phat nen -> Mo lai / Dung ngay,
  // khong phai mo lai dung ung dung do moi tat duoc. Chi dung lai DOM khi danh sach DOI (moi lan ve = mot khung WiFi).
  const npBox = el('div', 'np');
  npBox.style.display = 'none';
  let npSig = '';
  function renderNowPlaying(list: { k: string; l: string }[]) {
    const sig = JSON.stringify(list);
    if (sig === npSig) return;
    npSig = sig;
    npBox.replaceChildren(...list.map((it) => {
      const row = el('div', 'np-row');
      const txt = el('div', 'np-t'); txt.append(el('span', 'np-l', it.l), el('span', 'np-s', 'Đang phát nền'));
      const open = el('button', 'np-b', 'Mở');
      open.addEventListener('click', (e) => { e.stopPropagation(); openApp(it.k); });
      const stop = el('button', 'np-b stop'); stop.setAttribute('aria-label', 'Dừng ' + it.l); stop.appendChild(mdi('stop'));
      stop.addEventListener('click', (e) => { e.stopPropagation(); row.classList.add('busy'); sendControl({ stop: it.k }); });
      row.append(mdi('music'), txt, open, stop);
      return row;
    }));
    npBox.style.display = list.length ? '' : 'none';
    if (shadeVisible > 0) setVisible(fullH(), false);  // bang dang mo: chieu cao noi dung vua doi
  }
  // Thong bao (OS-5): danh sach trong thanh keo xuong — cham = mo ung dung/URL kem theo, x = xoa, "Xoa het".
  const ntBox = el('div', 'nt'); ntBox.style.display = 'none';
  let ntSig = '';
  function ago(ts: number): string {
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    return s < 60 ? 'vừa xong' : s < 3600 ? Math.floor(s / 60) + ' phút' : s < 86400 ? Math.floor(s / 3600) + ' giờ' : Math.floor(s / 86400) + ' ngày';
  }
  function noticeIcon(n: Notice, cls: string): HTMLElement {
    const box = el('div', cls + ' ' + n.p);
    const ic = n.k === 'chat' ? 'message' : 'bell';
    if (n.img) { const im = document.createElement('img'); im.alt = ''; im.src = n.img; im.addEventListener('error', () => { im.replaceWith(mdi(ic)); }); box.appendChild(im); }
    else box.appendChild(mdi(ic));
    return box;
  }
  // (01/10/2026) So CHUA XEM cua man hinh nay. Server cu (khong gui cu/nu): coi moi thong bao con lai la chua xem.
  function unseenCounts(): { chat: number; nt: number } {
    if (st && st.nu != null) return { chat: st.cu || 0, nt: st.nu };
    return { chat: 0, nt: (st?.nt || []).length };
  }
  function renderNotices(list: Notice[]) {
    const sig = JSON.stringify(list.map((n) => [n.id, !!n.s]));
    const u = unseenCounts();
    pill.classList.toggle('unread', u.chat + u.nt > 0);
    renderChatBadge(u.chat);
    if (sig === ntSig) { ntBox.querySelectorAll<HTMLElement>('[data-ts]').forEach((e) => setText(e, ago(Number(e.dataset.ts)))); return; }
    ntSig = sig;
    ntBox.style.display = list.length ? '' : 'none';
    const head = el('div', 'nt-head'); head.append(el('span', 'nt-h', 'Thông báo'), el('div', 'spacer'));
    const clr = el('button', 'nt-clr', 'Xoá hết'); clr.addEventListener('click', (e) => { e.stopPropagation(); sendControl({ ntClear: 1 }); });
    head.appendChild(clr);
    const rows = list.slice(0, 4).map((n) => {
      const row = el('div', 'nt-row' + (n.s === false ? ' new' : ''));
      const txt = el('div', 'nt-txt'); const top = el('div', 'nt-top');
      const when = el('span', 'nt-ago', ago(n.ts)); when.dataset.ts = String(n.ts);
      top.append(el('span', 'nt-t', n.t || n.m), when);
      txt.append(top); if (n.t && n.m) txt.appendChild(el('div', 'nt-m', n.m));
      const x = el('button', 'nt-x', '✕'); x.setAttribute('aria-label', 'Xoá thông báo');
      x.addEventListener('click', (e) => { e.stopPropagation(); row.remove(); sendControl({ ntDel: n.id }); });
      row.append(noticeIcon(n, 'nt-ic'), txt, x);
      row.addEventListener('click', (e) => { e.stopPropagation(); closeShade(false); sendControl(n.act ? { ntOpen: n.id } : { ntDel: n.id }); });
      return row;
    });
    ntBox.replaceChildren(head, ...rows);
    if (shadeVisible > 0) setVisible(fullH(), false);
  }
  inner.append(info, ctl, psBox, npBox, ntBox, shortcuts);

  // Chieu cao, keo, mo/dong. Muc 'full' (P4): keo theo ngon; 'reduced'/'minimal' (S3): nhay thang.
  let shadeVisible = 0;
  const fullH = () => inner.offsetHeight;
  function setVisible(px: number, animate: boolean) {
    // Khong cao hon man hinh: noi dung nhieu hon (vd nhieu the Dang phat tren S3 480x272) thi cuon trong bang.
    const h = Math.min(fullH(), window.innerHeight);
    shade.classList.toggle('scroll', fullH() > h);
    shadeVisible = Math.max(0, Math.min(h, px));
    const anim = animate && CFG.motion === 'full';
    shade.classList.toggle('anim', anim); scrim.classList.toggle('anim', anim);
    shade.style.height = shadeVisible + 'px';
    scrim.style.opacity = String(h ? (shadeVisible / h) * 0.55 : 0);
    scrim.classList.toggle('on', shadeVisible > 0);
    pillChev.style.transform = shadeVisible > 0 ? 'translateX(-50%) rotate(180deg)' : 'translateX(-50%)';
  }
  function openShade(animate: boolean) {
    hideToast(); tick(); setVisible(fullH(), animate); if (st?.ps) sendControl({ ps: 'get' });
    // (01/10/2026) Nhin thay danh sach = DA XEM thong bao thuong tren man hinh nay (tin nhan: phai doc trong Tin nhan).
    if ((st?.nt || []).some((n) => n.s === false && n.k !== 'chat')) sendControl({ ntSeen: 1 });
  }
  function closeShade(animate: boolean) { setVisible(0, animate); }
  scrim.addEventListener('click', (e) => { e.stopPropagation(); closeShade(true); });
  // Vuot len tren nen thanh (khong tren nut/thanh truot) -> dong
  let pDown: { y: number; t: number } | null = null;
  shade.addEventListener('pointerdown', (e) => { if (e.target === inner || e.target === shade || e.target === handle || (e.target as Element).closest?.('.info')) pDown = { y: e.clientY, t: Date.now() }; });
  shade.addEventListener('pointerup', (e) => {
    if (pDown && pDown.y - e.clientY > 40) closeShade(true);
    pDown = null;
  });
  handle.addEventListener('click', () => closeShade(true));

  // ── Man hinh chinh cua OS ───────────────────────────────────────────
  let homeWx: HTMLElement | null = null, homeWxIco: HTMLElement | null = null, homeWxT: HTMLElement | null = null, homeWxS: HTMLElement | null = null;
  let homeApi: HomeApi | null = null;
  function launch(app: App) {
    if (app.action === 'url') { closeShade(false); openUrlBox(); return; }
    openApp(app.id);
  }
  function startHome() {
    homeApi = mountHome({
      apps: CFG.apps, home: CFG.home, groups: CFG.groups, motion: CFG.motion, root, shadow,
      launch, openApp, send: sendControl, clockEls, dateEls,
    });
    ({ box: homeWx, ico: homeWxIco, t: homeWxT, s: homeWxS } = homeApi.wx);
  }
  const isHome = (() => { try { return new URL(CFG.urls.osHome).pathname === location.pathname && location.port === new URL(CFG.urls.osHome).port; } catch { return false; } })();
  if (isHome) startHome();
  root.append(scrim, shade, pill);
  // (09/10/2026) Tab trinh duyet (ung dung Chrome): thanh cong cu kieu Chrome o day man hinh — src/shell/browserBar.ts.
  if ((window as unknown as { __RWV_BROWSER?: number }).__RWV_BROWSER && !isHome) mountBrowserBar(Z);

  // ── O nhap dia chi (ung dung Trinh duyet) — DOM THUONG (khong Shadow) de ban phim ao nhan focus ──
  let urlBox: HTMLDivElement | null = null, urlInput: HTMLInputElement | null = null;
  function normalizeUrl(raw: string): string {
    const t = (raw || '').trim();
    if (!t) return '';
    if (/^https?:\/\//i.test(t)) return t;
    if (/^[a-z][a-z0-9+.-]*:/i.test(t) && !/^[^/]+:\d+(\/|$)/.test(t)) return '';
    if (/\s/.test(t) || (t.indexOf('.') < 0 && !/^localhost(:\d+)?(\/|$)/i.test(t))) return 'https://www.google.com/search?q=' + encodeURIComponent(t);
    if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/|$)/i.test(t)) return 'http://' + t;
    return 'https://' + t;
  }
  function openUrlBox() {
    if (!urlBox) {
      urlBox = document.createElement('div');
      urlBox.id = '__rwv_url_box';
      urlBox.style.cssText = `position:fixed;top:8px;left:50%;transform:translateX(-50%);width:min(640px,calc(100vw - 16px));box-sizing:border-box;display:none;align-items:center;gap:8px;padding:6px;border-radius:10px;background:rgba(30,30,30,0.95);box-shadow:0 2px 10px rgba(0,0,0,0.4);z-index:${Z}`;
      urlInput = document.createElement('input');
      urlInput.type = 'url'; urlInput.autocomplete = 'off'; urlInput.spellcheck = false;
      urlInput.placeholder = 'Nhập địa chỉ web rồi bấm Enter';
      urlInput.style.cssText = 'flex:1;min-width:0;height:36px;box-sizing:border-box;padding:0 10px;border:none;border-radius:8px;outline:none;font:16px sans-serif;color:#111;background:#fff';
      const mk = (text: string, bg: string, fn: () => void) => {
        const b = document.createElement('div'); b.textContent = text;
        b.style.cssText = `flex:none;display:flex;align-items:center;justify-content:center;min-width:44px;padding:0 14px;height:36px;border-radius:8px;cursor:pointer;font:15px sans-serif;color:#fff;background:${bg}`;
        // pointerdown: ban phim ao dang hien se "nuot" click ngay sau khi an (xem lich su launcher)
        b.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); fn(); });
        return b;
      };
      const submit = () => {
        const url = normalizeUrl(urlInput!.value);
        if (!url) { urlInput!.style.outline = '2px solid #e55'; return; }
        urlBox!.style.display = 'none';
        const fn = window[CFG.bindings.url];
        if (typeof fn === 'function') { try { fn(url); return; } catch { /* */ } }
        location.href = url;
      };
      urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } else if (e.key === 'Escape') urlBox!.style.display = 'none'; });
      urlBox.append(urlInput, mk('Mở', '#2a7de1', submit), mk('✕', 'rgba(255,255,255,0.15)', () => { urlBox!.style.display = 'none'; }));
      (document.body || document.documentElement).appendChild(urlBox);
    }
    urlInput!.value = ''; urlInput!.style.outline = 'none';
    urlBox.style.display = 'flex';
    setTimeout(() => urlInput!.focus(), 30);
  }

  // ── Gan day (OS-3): the anh chup tung ung dung dang mo — cham de chuyen, x / vuot len de dong ──
  interface RecentCard { k: string; l: string; t: string | null; p: boolean; a: boolean }
  let recentsEl: HTMLElement | null = null;
  function closeRecents(): void { recentsEl?.remove(); recentsEl = null; }
  function appFor(c: RecentCard): App {
    return CFG.apps.find((a) => a.id === c.k)
      || { id: c.k, label: c.l, kind: c.k === 'browser' ? 'browser' : 'generic', color: '#475569', group: '' };
  }
  function renderRecents(list: RecentCard[], open: boolean): void {
    window.__rwvLastRecents = list;
    if (!open && !recentsEl) return;           // cap nhat sau khi dong mot the, nhung nguoi dung da thoat Gan day
    const fresh = !recentsEl;
    if (!recentsEl) {
      recentsEl = el('div', 'recents');
      recentsEl.addEventListener('click', (e) => { if (e.target === recentsEl || (e.target as Element).classList?.contains('rc-row')) closeRecents(); });
      root.appendChild(recentsEl);
    }
    recentsEl.classList.toggle('anim', fresh && CFG.motion === 'full');
    const head = el('div', 'rc-head'); head.append(el('span', 't', 'Gần đây'), el('div', 'spacer'));
    if (list.some((c) => !c.p && !c.a)) {
      const all = el('button', 'rc-all', 'Đóng tất cả');
      all.addEventListener('click', (e) => { e.stopPropagation(); sendControl({ closeAll: 1 }); });
      head.appendChild(all);
    }
    const row = el('div', 'rc-row');
    const ar = String(window.innerWidth / Math.max(1, window.innerHeight));
    for (const c of list) {
      const card = el('div', 'rc'); if (c.a) card.classList.add('cur');
      card.style.setProperty('--ar', ar);
      const top = el('div', 'rc-top'); top.append(appIcon(appFor(c), 'app-ic'), el('span', 'rc-l', c.l));
      const canClose = !c.p && !c.a;
      if (canClose) {
        const x = el('button', 'rc-x', '✕'); x.setAttribute('aria-label', 'Đóng ' + c.l);
        x.addEventListener('click', (e) => { e.stopPropagation(); dismiss(); });
        top.appendChild(x);
      }
      const img = el('div', 'rc-img');
      if (c.t) {
        const im = document.createElement('img'); im.alt = ''; im.src = c.t;
        im.addEventListener('error', () => { im.remove(); img.appendChild(appIcon(appFor(c), 'rc-ph')); });
        img.appendChild(im);
      } else img.appendChild(appIcon(appFor(c), 'rc-ph'));
      card.append(top, img);
      function dismiss() {
        card.classList.add('gone');
        sendControl({ close: c.k });
      }
      // Vuot len tren the de dong (P4 keo theo ngon); cham = chuyen sang ung dung do.
      let sy = 0, dy = 0, drag = false;
      card.addEventListener('pointerdown', (e) => { sy = e.clientY; dy = 0; drag = true; });
      card.addEventListener('pointermove', (e) => {
        if (!drag) return; dy = e.clientY - sy;
        if (canClose && dy < -10) card.style.transform = `translateY(${dy}px)`;   // (26/10/2026) moi panel deu keo theo tay
      });
      const end = () => {
        if (!drag) return; drag = false;
        if (canClose && dy < -70) { dismiss(); return; }
        card.style.transform = '';
      };
      card.addEventListener('pointerup', end); card.addEventListener('pointercancel', end);
      card.addEventListener('click', (e) => {
        e.stopPropagation();
        if (Math.abs(dy) > 12) return;
        if (c.a) closeRecents(); else openApp(c.k);
      });
      row.appendChild(card);
    }
    if (!list.length) row.appendChild(el('div', 'rc-empty', 'Không có ứng dụng nào đang mở'));
    recentsEl.replaceChildren(head, row);
    // Cuon cho the TRUOC (ung dung dung ngay truoc) vao giua — dung thao tac chuyen qua lai nhanh nhat.
    if (fresh && row.scrollWidth > row.clientWidth + 8) {
      const second = row.children[1] as HTMLElement | undefined;
      second?.scrollIntoView({ inline: 'center', block: 'nearest' });
    }
  }

  // ── Quay lai (OS-3): bong bong mui ten o mep khi vuot tu mep trai/phai (server nhan dien, src/gestures.ts) ──
  // Doi mau nhan khi da qua nguong = tha tay la Quay lai. Muc 'full' (P4) bong bong chay theo ngon tay; S3 chi ve lai
  // khi trang thai "da qua nguong" doi (moi khung ve lai la bang thong WiFi).
  const backEl = el('div', 'backbub'); backEl.appendChild(mdi('back'));
  root.appendChild(backEl);
  function backGesture(phase: 'start' | 'move' | 'end', side: 'left' | 'right', d: number, y: number): void {
    if (phase === 'end') { backEl.classList.remove('on', 'armed'); backEl.style.transform = ''; return; }
    const thr = Math.max(60, Math.round(window.innerWidth * 0.08));
    const armed = d >= thr;
    // (26/10/2026) bo chan theo motion: bong bong phai chay theo ngon tay o moi panel
    backEl.classList.add('on');
    backEl.classList.toggle('armed', armed);
    backEl.classList.toggle('right', side === 'right');
    backEl.style.top = Math.max(8, Math.min(window.innerHeight - 60, y - 26)) + 'px';
    const off = Math.min(d, thr) * 0.5;
    backEl.style.transform = `translateX(${side === 'left' ? off : -off}px)`;
  }

  // ── Vuot len tu mep duoi: thanh chi bao + goi y (tha = Man hinh chinh, giu = Gan day) — nhu dien thoai ──
  const homeBar = el('div', 'homebar'); const homeHint = el('div', 'hb-t'); homeBar.append(homeHint, el('div', 'hb-pill'));
  root.appendChild(homeBar);
  function homeDrag(phase: 'start' | 'move' | 'end', d: number): void {
    if (phase === 'end') { homeBar.classList.remove('on'); homeBar.style.transform = ''; return; }
    const thrRecents = Math.max(90, Math.round(window.innerHeight * 0.15));
    const hint = d >= thrRecents ? 'Giữ: Gần đây · Thả: Màn hình chính' : d > 50 ? 'Thả: Màn hình chính' : '';
    const changed = homeHint.textContent !== hint || !homeBar.classList.contains('on');
    // (26/10/2026) bo chan: thanh phai nhac theo tay o moi panel
    setText(homeHint, hint);
    homeBar.classList.add('on');
    homeBar.classList.toggle('armed', d >= thrRecents);
    const lift = Math.min(d, thrRecents * 1.3) * 0.5;
    homeBar.style.transform = `translateX(-50%) translateY(${-lift}px)`;
  }

  // ── Man hinh cho (OS-5): server bat sau mot luc khong cham (src/screensaver.ts). Dong ho lon + ngay am duong + thoi
  // tiet tren nen den; dich cho moi phut (chong luu anh), tong am toi tu 22h-6h. Cham = tat (cham do KHONG toi trang). ──
  let saverEl: HTMLElement | null = null, svBox: HTMLElement, svClock: HTMLElement, svDate: HTMLElement, svWx: HTMLElement;
  let svShiftMin = -1, svWxSig = '';
  let svFitRo: ResizeObserver | null = null, svFitBusy = false;
  /** Zoom khoi dong ho + the cho vua man (chua tinh goi y vuot o day): khong phong to, chi thu nho; khung anh nen thi bo qua. */
  function fitSaver(): void {
    if (!saverEl || !svBox || svFitBusy || saverEl.classList.contains('photo')) return;
    svFitBusy = true;
    try {
      svBox.style.zoom = '1';
      const hh = svBox.offsetHeight, ww = svBox.offsetWidth;
      const z = Math.min(1, (innerHeight * 0.86) / Math.max(1, hh), (innerWidth * 0.97) / Math.max(1, ww));
      svBox.style.zoom = z < 0.995 ? z.toFixed(3) : '';
    } finally { svFitBusy = false; }
  }
  // (27/09/2026) Nen anh gia dinh (server gui URL moi phut, null = chi dong ho — ban dem / khong co anh). Hai lop
  // chong mo cheo; anh tai xong moi hien (mang cham thi giu anh cu).
  // (27/09/2026) KHUNG ANH SO: server gui {url, cap, fx, dir, clock}. Hieu ung chuyen (mo dan / truot theo huong vuot /
  // thu phong / khong) chay MOT lan moi lan doi anh (~0,7 s) — man S3 luon 'khong' (moi khung dong ton bang thong).
  let svPh: HTMLElement[] = [], svTop = 0, svCap: HTMLElement;
  // (07/10/2026) MAN HINH KHOA: server goi screensaver({lock, clock, wx}). lock = chi VUOT LEN moi mo (lockGesture.ts),
  // cham chi hien goi y + bao server sang man; chip thong bao bam luc khoa -> nho viec, lam sau khi mo. Khong co chuyen
  // dong lap lien tuc (moi khung doi la mot khung gui qua WiFi) — goi y chi nhay mot lan khi cham.
  type SaverOpts = { lock?: boolean; clock?: 'm' | 'l' | 'xl'; wx?: boolean };
  let svOpts: SaverOpts = {}, svHint: HTMLElement | null = null, svCard: HTMLElement, svCardSig = '';
  let svPending: (() => void) | null = null;
  const WMO: Record<number, string> = { 0: 'Trời quang', 1: 'Ít mây', 2: 'Có mây', 3: 'Nhiều mây', 45: 'Sương mù', 48: 'Sương mù',
    51: 'Mưa phùn', 53: 'Mưa phùn', 55: 'Mưa phùn', 56: 'Mưa phùn lạnh', 57: 'Mưa phùn lạnh', 61: 'Mưa nhỏ', 63: 'Mưa', 65: 'Mưa to',
    66: 'Mưa lạnh', 67: 'Mưa lạnh', 71: 'Tuyết', 73: 'Tuyết', 75: 'Tuyết', 77: 'Tuyết', 80: 'Mưa rào', 81: 'Mưa rào',
    82: 'Mưa rào lớn', 85: 'Tuyết', 86: 'Tuyết', 95: 'Dông', 96: 'Dông, mưa đá', 99: 'Dông, mưa đá' };
  function applySaverOpts(): void {
    if (!saverEl) return;
    saverEl.classList.toggle('lock', !!svOpts.lock);
    saverEl.classList.remove('ck-m', 'ck-l', 'ck-xl'); saverEl.classList.add('ck-' + (svOpts.clock || 'l'));
    if (svOpts.lock && !svHint) {
      svHint = el('div', 'sv-hint'); svHint.append(mdi('chevup'), el('span', '', 'Vuốt lên để mở khóa'));
      saverEl.append(svHint);
    } else if (!svOpts.lock && svHint) { svHint.remove(); svHint = null; }
    svCardSig = '~'; svWxSig = ''; svLwSig = '';
  }
  function hintPulse(): void {
    if (!svHint) return;
    svHint.classList.remove('pulse'); void svHint.offsetWidth; svHint.classList.add('pulse');
  }
  function unlockNow(): void {
    const go = svPending; svPending = null;
    const done = () => { screensaver(false); sendControl({ unlock: 1 }); if (go) go(); };
    if (saverEl && CFG.motion === 'full') { saverEl.classList.add('unlocking'); setTimeout(done, 260); } else done();
  }
  function aqiCls(a: number): string { return a <= 50 ? 'a1' : a <= 100 ? 'a2' : a <= 150 ? 'a3' : 'a4'; }
  function renderCard(w: DevState['wx']): void {
    if (!w) { svCard.replaceChildren(); return; }
    const now = el('div', 'wc-now');
    const desc = el('div', 'wc-desc');
    // Moi cum mot <span> nowrap: chi xuong dong o " · " (do that P4: trinh duyet ngat ngay SAU dau "–" du da dung nbsp).
    const sub = el('div', 'wc-sub');
    [w.fl != null ? `Cảm giác ${w.fl}°` : '', w.hi != null && w.lo != null ? `${w.lo}° – ${w.hi}°` : ''].filter(Boolean)
      .forEach((t, i) => { if (i) sub.append(' · '); sub.append(el('span', 'nw', t)); });
    desc.append(el('div', 'wc-name', WMO[w.code] ?? ''), sub);
    now.append(weatherIcon(w.code, w.day), el('div', 'wc-t', `${w.t}°`), desc);
    const row = el('div', 'wc-row');
    const item = (icon: string, text: string, cls = '') => { const s = el('span', 'wc-i' + (cls ? ' ' + cls : '')); s.append(mdi(icon), el('span', '', text)); return s; };
    if (w.rh != null) row.append(item('drop', `${w.rh}%`));
    if (w.ws != null) row.append(item('wind', `${w.ws} km/h`));
    if (w.pp != null) row.append(item('umbrella', `${w.pp}%`));
    if (w.aqi != null) row.append(item('leaf', `AQI ${w.aqi}`, aqiCls(w.aqi)));
    const hrs = el('div', 'wc-hr');
    for (const h of w.hr || []) {
      const c = el('div', 'wc-h');
      c.append(el('span', 'wc-hh', `${h.h}h`), weatherIcon(h.c, h.h >= 6 && h.h < 18), el('span', 'wc-ht', `${h.t}°`));
      if (h.p != null && h.p >= 20) c.append(el('span', 'wc-hp', `${h.p}%`));
      hrs.append(c);
    }
    svCard.replaceChildren(now, row, hrs);
  }
  type SaverPhotoMsg = { url: string; cap?: string; fx?: string; dir?: number; clock?: boolean };
  function saverPhoto(o: SaverPhotoMsg | string | null): void {
    if (!saverEl) return;
    const m: SaverPhotoMsg | null = typeof o === 'string' ? { url: o } : o;
    if (!m || !m.url) { saverEl.classList.remove('photo'); svPh.forEach((p) => { p.className = 'sv-ph'; p.replaceChildren(); }); setText(svCap, ''); return; }
    // (30/10/2026) Hieu ung do NGUOI DUNG chon phai duoc ap dung ke ca khi panel o muc chuyen dong thap;
    // chi khi chua chon gi moi ha xuong 'none' cho man yeu.
    const fx = (m.fx && m.fx !== 'none') ? m.fx : (CFG.motion === 'full' ? 'fade' : 'none');
    const dir = (m.dir ?? 1) < 0 ? -1 : 1;
    const img = new Image();
    img.onload = () => {
      if (!saverEl) return;
      const next = svPh[1 - svTop], cur = svPh[svTop];
      const im = document.createElement('img');
      im.className = 'sv-img'; im.decoding = 'async'; im.src = m.url;
      next.replaceChildren(im);
      // Vi tri bat dau (khong hieu ung) -> khung sau: vi tri cuoi (co hieu ung)
      next.className = `sv-ph fx-${fx} from${dir > 0 ? 'R' : 'L'}`;
      void next.offsetWidth;
      next.className = `sv-ph fx-${fx} show`;
      cur.className = `sv-ph fx-${fx} to${dir > 0 ? 'L' : 'R'}`;
      svTop = 1 - svTop;
      // Vua chuyen tu dong ho giua man hinh sang khung anh: tinh lai vi tri dong ho (goc duoi trai, khong ra ngoai mep).
      if (!saverEl.classList.contains('photo')) { saverEl.classList.add('photo'); svShiftMin = -1; updateSaver(); }
      saverEl.classList.toggle('noclock', m.clock === false);
      setText(svCap, m.cap || '');
      window.__rwvSaverShown = m;
    };
    img.src = m.url;
  }
  // (01/10/2026) Bao trang dang mo (vd Tin nhan) man hinh cho bat/tat: trang khong "da doc" khi bi che, doc lai khi go.
  function saverSignal(on: boolean): void {
    if (!!window.__rwvSaverOn === on) return;
    window.__rwvSaverOn = on;
    freezeUnder(on);
    try { window.dispatchEvent(new CustomEvent('rwv-saver', { detail: on })); } catch { /* */ }
  }
  // (15/10/2026) Lop khoa / man hinh cho CHE KIN trang nhung hoat anh cua trang ben duoi van chay -> Chrome ve lai lien tuc
  // -> man nhan khung mai. Do P4 15/10: trang chu HA co the dong dien mat troi (8 <animate*> SVG) -> man KHOA van 29 khung/s,
  // ~670 KB/s; tam dung SMIL -> 0. Tam dung SMIL (svg.pauseAnimations) + CSS/Web Animations cua TRANG (khong dung hieu ung
  // cua chinh lop khoa, nam trong shadow cua Shell); lap lai moi 20 s de bat phan tu trang moi ve; go lop -> chay lai.
  let frzSvg: SVGSVGElement[] = [], frzAnim: Animation[] = [], frzTimer = 0;
  function freezePass(): void {
    const walk = (r: Document | ShadowRoot) => {
      for (const e of r.querySelectorAll('*')) {
        // Ca <svg> LONG ben trong: Chrome cho moi <svg> mot dong ho SMIL rieng (do 15/10: chi dung svg ngoai cung -> van 29 khung/s).
        if (e instanceof SVGSVGElement && !e.animationsPaused()) { e.pauseAnimations(); frzSvg.push(e); }
        const sr = (e as Element).shadowRoot;
        if (sr && sr !== shadow) walk(sr);
      }
    };
    try { walk(document); } catch { /* */ }
    try {
      for (const a of document.getAnimations()) {
        const t = (a.effect as KeyframeEffect | null)?.target;
        if (a.playState !== 'running' || (t && t.getRootNode() === shadow)) continue;
        a.pause(); frzAnim.push(a);
      }
    } catch { /* */ }
  }
  function freezeUnder(on: boolean): void {
    clearInterval(frzTimer); frzTimer = 0;
    if (on) { freezePass(); frzTimer = window.setInterval(freezePass, 20_000); return; }
    for (const s of frzSvg) try { s.unpauseAnimations(); } catch { /* */ }
    for (const a of frzAnim) try { if (a.playState === 'paused') a.play(); } catch { /* */ }
    frzSvg = []; frzAnim = [];
  }
  function screensaver(on: boolean | SaverOpts): void {
    // (30/10/2026) Dang hien thong bao co camera/anh: KHONG de man hinh cho bat len (no se che mat thong bao
    // va lam hieu nhu thong bao ket thuc som). Thong bao tu dong dong theo `duration`, roi moi tinh tiep.
    if (on && ovEl) return;
    if (!on) { svFitRo?.disconnect(); svFitRo = null; saverEl?.remove(); saverEl = null; svHint = null; svPending = null; saverSignal(false); return; }
    svOpts = typeof on === 'object' ? on : {};
    if (saverEl) { applySaverOpts(); updateSaver(); return; }  // dang hien: chi doi kieu (vd nguoi dung vua doi Cai dat)
    if (alarmId || shadow.querySelector('.alarm')) return;  // (01/10/2026) dang bao thuc: khong che
    // (01/10/2026) Ban phim ao (script tiem rieng, lop popover tren cung) tung nam de len man hinh cho.
    try { if (typeof window.__vkbHide === 'function') window.__vkbHide(); } catch { /* */ }
    if (!deviceNow()) return;
    closeShade(false); closeRecents();
    saverEl = el('div', 'saver'); svBox = el('div', 'sv-box');
    // (16/10/2026) Noi dung man hinh cho co the CAO hon man (the cuoc goi nho + 2 hang nang luong + thoi tiet + camera tren S3 480x480:
    // dong ho bi day len, mat ~1 nua) -> thu nho CA KHOI cho vua man (zoom), do lai moi khi khoi doi kich thuoc.
    try { svFitRo?.disconnect(); svFitRo = new ResizeObserver(() => fitSaver()); svFitRo.observe(svBox); } catch { /* */ }
    saverSignal(true);
    svClock = el('div', 'sv-clock'); svDate = el('div', 'sv-date'); svWx = el('div', 'sv-wx');
    svCap = el('div', 'sv-cap'); svCard = el('div', 'sv-card');
    svBadges = el('div', 'sv-bdg'); svBdgSig = '';
    svLw = el('div', 'sv-lw'); svLwSig = ''; svLwKey = '';
    const main = el('div', 'sv-main');
    main.append(svClock, svDate, svWx, svBadges, svLw, svCap);
    // (16/10/2026) Cot phai: the thoi tiet + dong camera / lich (man ngang — truoc day cac dong nay chen duoi dai nang luong ben
    // trai, cot trai qua cao, cot phai trong). Man vuong / thap: .sv-side { display: contents } -> thu tu nhu cu.
    svRows = el('div', 'sv-rows');
    const side = el('div', 'sv-side'); side.append(svCard, svRows);
    svBox.append(main, side);
    svPh = [el('div', 'sv-ph'), el('div', 'sv-ph')]; svTop = 0;
    // (16/10/2026) Goc tren phai kieu dien thoai: tin nhan / thong bao / bao thuc (bieu tuong + so), mang, pin cua man.
    svStat = el('div', 'sv-top');
    saverEl.append(svPh[0], svPh[1], svBox, svStat);
    if (CFG.motion === 'full') saverEl.classList.add('anim');
    applySaverOpts();
    // Tat o 'click' (khong phai pointerdown): neu go lop phu ngay luc cham xuong thi 'click' sau do roi xuong trang.
    // (27/09/2026) Dang hien anh: VUOT trai/phai = anh sau/truoc (khung anh so). (07/10/2026) Khoa: chi vuot len moi mo.
    // touch-action: none (styles) — neu khong trinh duyet coi vuot la cuon trang va huy (pointercancel).
    let sx = 0, sy = 0, lx = 0, ly = 0, t0 = 0, swiped = false, down = false;
    const drag = (dy: number) => {
      // (26/10/2026) man hinh khoa: keo theo tay o MOI panel (truoc day chi motion === 'full')
      if (saverEl && svOpts.lock) saverEl.style.transform = dy < 0 ? `translateY(${Math.round(dy * 0.5)}px)` : '';
    };
    saverEl.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation(); sx = lx = e.clientX; sy = ly = e.clientY; t0 = Date.now(); swiped = false; down = true;
    });
    saverEl.addEventListener('pointermove', (e) => { if (!down) return; lx = e.clientX; ly = e.clientY; drag(ly - sy); });
    saverEl.addEventListener('pointerup', () => {
      if (!down) return;
      down = false;
      const g = classifyLockGesture({ sx, sy, ex: lx, ey: ly, ms: Date.now() - t0, w: innerWidth, h: innerHeight,
        photo: !!saverEl?.classList.contains('photo') });
      if (g === 'unlock' && svOpts.lock) { swiped = true; unlockNow(); return; }
      drag(0);
      if (g === 'next' || g === 'prev') { swiped = true; sendControl({ saver: g }); return; }
      if (svOpts.lock) { swiped = true; hintPulse(); sendControl({ lockTap: 1 }); }
    });
    saverEl.addEventListener('pointercancel', () => { down = false; drag(0); });
    saverEl.addEventListener('click', (e) => {
      e.stopPropagation();
      if (swiped) { swiped = false; return; }
      if (svOpts.lock) return;
      screensaver(false); sendControl({ wake: 1 });
    });
    root.appendChild(saverEl);
    svShiftMin = -1; svWxSig = '';
    updateSaver();
  }
  // (01/10/2026) Man hinh cho: "2 tin nhắn · 1 thông báo" CHUA XEM tren chinh man hinh nay. Cham tin nhan -> mo Tin nhan,
  // cham thong bao -> mo thanh keo xuong. Chi doi DOM khi so dem doi (moi khung ve lai la bang thong WiFi).
  let svBadges: HTMLElement, svStat: HTMLElement, svBdgSig = '';
  function renderSaverBadges(): void {
    if (!saverEl) return;
    const u = unseenCounts();
    const al = st?.al && st.al.at - Date.now() < 24 * 3600_000 ? st.al : null;
    // (16/10/2026) CUOC GOI NHO chua xem (12 gio gan day): the do LON rieng, khong gop vao chip "N thông báo".
    const miss = (st?.nt || []).filter((n) => n.mc && !n.s && Date.now() - n.ts < 12 * 3600_000);
    const sig = u.chat + '|' + u.nt + '|' + (al ? al.t : '') + '|' + miss.map((n) => n.id).join(',') + '|' + sbKey(st?.sb);
    if (sig === svBdgSig) return;
    svBdgSig = sig;
    saverEl.classList.toggle('hasmiss', miss.length > 0);
    const chip = (icon: string, text: string, go: () => void) => {
      const c = el('button', 'sv-tb'); c.append(mdi(icon), el('span', '', text));
      c.addEventListener('pointerdown', (e) => e.stopPropagation());
      c.addEventListener('click', (e) => {
        e.stopPropagation();
        if (svOpts.lock) { svPending = go; hintPulse(); sendControl({ lockTap: 1 }); return; }  // khoa: mo sau khi vuot
        screensaver(false); sendControl({ wake: 1 }); go();
      });
      return c;
    };
    const out: HTMLElement[] = [];
    if (miss.length) {
      const n = miss[0];
      const c = el('button', 'sv-miss');
      const tx = el('div', 'sv-mtx');
      tx.append(el('b', '', miss.length > 1 ? miss.length + ' cuộc gọi nhỡ' : 'Cuộc gọi nhỡ'), el('span', '', n.m || n.t));
      const ic = el('span', 'sv-mic'); ic.append(mdi('phone-missed'));
      c.append(ic, tx);
      if (n.img) { const im = document.createElement('img'); im.className = 'sv-mimg'; im.src = n.img; im.alt = ''; c.appendChild(im); }
      c.addEventListener('pointerdown', (e) => e.stopPropagation());
      c.addEventListener('click', (e) => {
        e.stopPropagation();
        const go = () => sendControl({ ntOpen: n.id });
        if (svOpts.lock) { svPending = go; hintPulse(); sendControl({ lockTap: 1 }); return; }
        screensaver(false); sendControl({ wake: 1 }); go();
      });
      out.push(c);
    }
    const ntN = Math.max(0, u.nt - miss.length);
    const top: Element[] = [];
    if (u.chat) top.push(chip('message', String(u.chat), () => { if (hasApp('chat')) openApp('chat'); else openShade(true); }));
    if (ntN) top.push(chip('bell', String(ntN), () => openShade(true)));
    if (al) { const c = chip('alarm', al.t, () => openApp('alarm')); c.classList.add('al'); top.push(c); }
    const sb = st?.sb;
    if (sb?.nw) top.push(netIcon(sb.nw));
    const pw = powerIcons(sb);
    if (pw.length) { const b = el('span', 'sv-bt'); b.append(...pw); if (sb?.bt != null) b.append(el('span', '', Math.round(sb.bt) + '%')); top.push(b); }
    svStat.replaceChildren(...top);
    svBadges.replaceChildren(...out);
  }
  // Bieu tuong Tin nhan o man hinh chinh / dock: huy hieu so tin chua doc (style dong trong shadow — song qua moi lan ve lai).
  // (khong dung bien let/const o day: renderNotices co the chay truoc dong nay -> TDZ; luu tren chinh the style)
  function renderChatBadge(n: number): void {
    let sty = shadow.querySelector<HTMLStyleElement>('style.chat-bdg');
    if (!sty) { sty = document.createElement('style'); sty.className = 'chat-bdg'; sty.dataset.n = '-1'; shadow.appendChild(sty); }
    if (sty.dataset.n === String(n)) return;
    sty.dataset.n = String(n);
    sty.textContent = n > 0 ? `.app[data-k="chat"] .app-ic{position:relative;overflow:visible}` +
      `.app[data-k="chat"] .app-ic::after{content:"${n > 99 ? '99+' : n}";position:absolute;top:-4px;right:-6px;min-width:18px;height:18px;` +
      `padding:0 5px;box-sizing:border-box;border-radius:9px;background:#ef4444;color:#fff;font:700 11px/18px "Be Vietnam Pro",Roboto,sans-serif;` +
      `text-align:center;box-shadow:0 0 0 2px rgba(0,0,0,.35)}` : '';
  }
  // (08/10/2026) WIDGET man hinh khoa (lockWidgets.ts): ve lai NGAY khi cau truc doi (camera moi thay nguoi, su kien moi);
  // chi so lieu doi (cong suat, "x phut truoc") thi cho luc doi phut — cung khung voi dong ho, khong ton them khung.
  let svLw: HTMLElement, svRows: HTMLElement, svLwSig = '', svLwKey = '';
  function renderLockWidgets(minuteTick: boolean): void {
    if (!saverEl) return;
    const tz = st && st.tv ? st.tz : -new Date().getTimezoneOffset(), now = Date.now() + (st && st.tv ? st.skewMs : 0);
    // Man ngang du cao (P4): cot phai con cho -> toi da 4 su kien lich (con lai 2).
    const m = lwModel(st?.lw, now, tz, innerWidth >= innerHeight * 4 / 3 && innerHeight > 320 ? 4 : 2);
    const sig = m ? JSON.stringify([m.stats, m.rows]) : '';
    if (sig === svLwSig || (svLwSig && m && m.key === svLwKey && !minuteTick)) return;
    svLwSig = sig; svLwKey = m ? m.key : '';
    const parts = m ? buildLockWidgets(m) : [];
    svLw.replaceChildren(...parts.filter((e) => !e.classList.contains('lw-r')));
    svRows.replaceChildren(...parts.filter((e) => e.classList.contains('lw-r')));
    saverEl.classList.toggle('haslw', !!m);
  }
  function updateSaver(): void {
    const t = deviceNow();
    if (!saverEl || !t) return;
    renderSaverBadges();
    const h = t.getUTCHours(), m = t.getUTCMinutes();
    setText(svClock, pad2(h) + ':' + pad2(m));
    setText(svDate, dateText(t));
    saverEl.classList.toggle('night', h >= 22 || h < 6);
    const w = st?.wx;
    const sig = w ? `${w.code}|${w.day}|${w.t}|${w.name}` : '';
    if (sig !== svWxSig) {
      svWxSig = sig;
      svWx.replaceChildren(...(w ? [weatherIcon(w.code, w.day), el('span', '', `${w.t}° · ${w.name}`)] : []));
    }
    // (07/10/2026) The thoi tiet chi tiet (ca khi co anh nen: man ngang dat goc duoi phai, man vuong an — xem styles).
    const card = svOpts.wx !== false && w && w.hr ? w : null;
    const csig = card ? JSON.stringify([card.code, card.day, card.t, card.fl, card.rh, card.ws, card.hi, card.lo, card.pp, card.aqi, card.hr]) : '';
    if (csig !== svCardSig) { svCardSig = csig; renderCard(card); saverEl.classList.toggle('hascard', !!card); }
    renderLockWidgets(m !== svShiftMin);
    fitSaver();
    if (m !== svShiftMin) {  // moi phut mot vi tri moi — cung khung voi luc doi so phut, khong ton them khung nao
      svShiftMin = m;
      // Dang khung anh: dong ho o goc duoi trai -> chi dich vao trong (khong ra ngoai mep).
      const ph = saverEl.classList.contains('photo');
      // (07/10/2026) Co the thoi tiet (khoi rong gan het man): dich it lai de khong tran mep.
      const amp = saverEl.classList.contains('hascard') ? 2 : 7;
      const dx = ph ? Math.random() * (amp === 2 ? 1.5 : 4) : (Math.random() * 2 - 1) * amp, dy = ph ? -Math.random() * 4 : (Math.random() * 2 - 1) * (amp === 2 ? 3 : 9);
      svBox.style.transform = `translate(${dx.toFixed(1)}vw, ${dy.toFixed(1)}vh)`;
    }
  }

  // ── The thong bao noi (OS-5): truot xuong tu mep tren; tu an (normal 8 s, high 20 s), critical giu toi khi cham ──
  let toastEl: HTMLElement | null = null, toastTimer: number | undefined;
  function hideToast() { clearTimeout(toastTimer); toastEl?.remove(); toastEl = null; }
  function chime(strong: boolean) {
    try {
      const ctx = new AudioContext();
      const notes = strong ? [880, 660, 880, 660] : [880, 660];
      notes.forEach((f, i) => {
        const o = ctx.createOscillator(), g = ctx.createGain(), t0 = ctx.currentTime + i * 0.22;
        o.frequency.value = f; g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.45, t0 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.2);
        o.connect(g); g.connect(ctx.destination); o.start(t0); o.stop(t0 + 0.21);
      });
      setTimeout(() => { try { ctx.close(); } catch { /* */ } }, 1500);
    } catch { /* khong co am thanh */ }
  }
  function toast(n: Notice, onLock: boolean): void {
    hideToast();
    const t = el('div', 'toast ' + n.p); if (CFG.motion === 'full') t.classList.add('anim');
    if (onLock) t.classList.add('onlock');
    const txt = el('div', 'to-txt'); txt.append(el('div', 'to-t', n.t || n.m));
    if (n.t && n.m) txt.appendChild(el('div', 'to-m', n.m));
    const x = el('button', 'to-x', '✕'); x.setAttribute('aria-label', 'Đóng');
    x.addEventListener('click', (e) => { e.stopPropagation(); hideToast(); });
    t.append(noticeIcon(n, 'to-ic'), txt, x);
    t.addEventListener('pointerdown', (e) => e.stopPropagation());
    t.addEventListener('click', (e) => { e.stopPropagation(); hideToast(); if (n.act) sendControl({ ntOpen: n.id }); });
    root.appendChild(t); toastEl = t;
    if (n.p !== 'critical') toastTimer = window.setTimeout(hideToast, n.p === 'high' ? 20000 : 8000);
  }

  // (19/10/2026) Thong bao URGENT: phu toan man hinh tren moi ung dung, tu thu gon sau 6 s (hoac khi cham).
  let ovEl: HTMLElement | null = null, ovTimer = 0, ovNotice: Notice | null = null;
  /** (30/10/2026) Trang thai khoa TRUOC khi hien thong bao — tra lai dung khi thong bao ket thuc. */
  let ovWasLocked = false;
  function closeOverlay(collapse: boolean): void {
    clearTimeout(ovTimer);
    if (!ovEl) return;
    const n = ovNotice;
    ovEl.remove(); ovEl = null; ovNotice = null;
    if (collapse && n) toast(n, false);
    // (30/10/2026) KET THUC thong bao (timeout hoac cham): tra lai dung trang thai truoc do.
    //  - Truoc khi hien thong bao man DANG KHOA  -> khoa lai.
    //  - Truoc khi hien thong bao man DANG MO   -> ve man hinh chinh (khong khoa).
    if (collapse) {
      if (ovWasLocked) screensaver({ lock: true });
      else if (!saverEl) sendControl({ app: '__system' });
      ovWasLocked = false;
    }
  }
  function openOverlay(n: Notice, wasLocked = false): void {
    // (30/10/2026) notify() da go man hinh cho TRUOC khi goi ham nay, nen phai nhan co tu ngoai vao.
    ovWasLocked = wasLocked || !!(saverEl && svOpts.lock);
    closeOverlay(false); hideToast();
    const card = el('div', 'ov-card ' + n.p);
    const txt = el('div', 'ov-txt');
    txt.appendChild(el('div', 'ov-t', n.t || n.m));
    if (n.t && n.m) txt.appendChild(el('div', 'ov-m', n.m));
    card.append(noticeIcon(n, 'ov-ic'), txt);
    // (14/06/2026) NGUON HINH: `str` (tu `camera:` cua automation) la LUONG MJPEG -> <img src=luong>; Chromium tu ve
    // tung khung cua multipart/x-mixed-replace, KHONG can JavaScript, khong tai lai trang.
    // Truoc day chi co `img` (mot khung /api/frame.jpeg): do that 22/11/2026 — 1 khung/10 s toi man, tuc anh dung im.
    // Anh tinh (`img`/`pst`) giu lam POSTER: hien ngay trong khi cho khung dau (0,26-1,1 s) va khi luong loi.
    const plan = overlayPlan(n);
    if (plan.kind === 'stream') {
      const im = el('img', 'ov-img'); im.alt = '';
      // (23/11/2026) Dat style TRUC TIEP (khong chi dua vao CSS): tren P4 do that 23/11/2026 — luat CSS
      // `.ov-card.media-full .ov-img` khong ap vao <img> (khung ve theo kich thuoc tu nhien = anh nho giua man).
      im.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;z-index:1;';
      // Poster: 1 khung tinh hien NGAY (khong doi mang). Luong dat sau nhe de khung dau ghi de poster.
      if (plan.poster) {
        const p = el('img', 'ov-img ov-poster'); p.alt = ''; p.src = plan.poster;
        p.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;z-index:0;';
        card.appendChild(p);
      }
      const src = plan.src;
      // (22/11/2026) Khung DAU TIEN cua luong ve xong thi bo poster: khong con 2 lop anh chong nhau (nhin "roi").
      im.addEventListener('load', () => { const pst = card.querySelector('.ov-poster'); if (pst) pst.remove(); }, { once: true });
      let tries = 0;
      im.addEventListener('error', () => {
        // Luong dut (camera khoi dong lai / Wi-Fi chap chon): thu lai co gian cach, giu poster trong luc cho.
        if (++tries > 6 || !im.isConnected) return;
        window.setTimeout(() => { if (im.isConnected) im.src = src + '&_r=' + tries; }, Math.min(4000, 500 * tries));
      });
      im.src = src;
      card.appendChild(im);
    } else if (plan.kind === 'video') {
      const v = document.createElement('video'); v.className = 'ov-img'; v.src = plan.src;
      v.controls = true; v.autoplay = true; v.playsInline = true; v.muted = true; card.appendChild(v);
    } else if (plan.kind === 'audio') {
      const a = document.createElement('audio'); a.className = 'ov-aud'; a.src = plan.src; a.controls = true; a.autoplay = true;
      card.appendChild(a);
    } else if (plan.kind === 'image') {
      const im = el('img', 'ov-img'); im.src = plan.src;
      im.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;';
      card.appendChild(im);
    }
    // (30/10/2026) Thong bao co hinh (camera/anh/video): cho the phu TOAN MAN theo kich thuoc + goc xoay hien tai.
    if (isFullMedia(n)) card.classList.add('media-full');
    const row = el('div', 'ov-act');
    if (n.act) {
      const b = el('button', 'ov-btn', 'Mở');
      b.addEventListener('click', (e) => { e.stopPropagation(); closeOverlay(false); sendControl({ ntOpen: n.id }); });
      row.appendChild(b);
    }
    const c = el('button', 'ov-btn ghost', 'Đóng');
    c.addEventListener('click', (e) => { e.stopPropagation(); closeOverlay(true); });
    row.appendChild(c); card.appendChild(row);
    const box = el('div', 'ov'); box.appendChild(card);
    box.addEventListener('pointerdown', (e) => e.stopPropagation());
    // Cham vao bat ky dau (nen hay the) de dong; nut ben trong tu xu ly rieng.
    box.addEventListener('click', (e) => { e.stopPropagation(); closeOverlay(true); });
    card.addEventListener('click', (e) => { e.stopPropagation(); closeOverlay(true); });
    root.appendChild(box); ovEl = box; ovNotice = n;
    const seconds = n.dur === 0 ? 0 : (n.dur && n.dur > 0 ? n.dur : 10);
    if (seconds > 0) ovTimer = window.setTimeout(() => closeOverlay(true), seconds * 1000);
  }

  function notify(n: Notice, sound: boolean): void {
    window.__rwvLastNotice = n;
    // (07/10/2026) Dang KHOA: giu man hinh khoa, the thong bao hien de len nhung chi de xem.
    const onLock = !!(saverEl && svOpts.lock);
    if (n.p === 'urgent') { if (onLock) screensaver(false); openOverlay(n, onLock); if (sound) chime(true); return; }
    hideToast(); if (!onLock) screensaver(false);
    toast(n, onLock);
    if (sound) chime(n.p === 'critical');
  }

  // ── Bao thuc (het hen gio) ──────────────────────────────────────────
  // (01/10/2026) Man hinh BAO THUC dung chung cho Bao thuc + Hen gio (server src/alarms.ts): "Tat" / "Bao lai X phut"
  // gui ve server -> ngung tren MOI man hinh cung reo. Am: firmware tu phat (loai Bao thuc); firmware cu (beep) -> WebAudio.
  // Goi kieu cu alarm(label) (server < 2.9.95) = hen gio, keu WebAudio, cham dau cung tat.
  let alarmId = '';
  function alarmClose(id?: string) {
    if (id && id !== alarmId) return;
    (shadow.querySelector('.alarm') as (HTMLElement & { _stop?: () => void }) | null)?._stop?.();
    shadow.querySelector('.alarm')?.remove(); alarmId = '';
  }
  function alarm(label: string, o?: AlarmInfo) {
    alarmClose();
    screensaver(false); closeShade(false);
    const legacy = !o;
    const info: AlarmInfo = o || { id: '', l: label, t: '', sz: 0, tm: true, beep: true };
    alarmId = info.id;
    const ov = el('div', 'alarm') as HTMLElement & { _stop?: () => void };
    const t1 = info.tm ? 'Hết giờ!' : (info.t || 'Báo thức');
    const t2 = label || (info.tm ? 'Hẹn giờ đã kết thúc' : 'Báo thức');
    const btns = el('div', 'al-btns');
    if (info.sz > 0) {
      const sz = el('div', 'btn snz', `Báo lại ${info.sz} phút`);
      sz.addEventListener('click', (e) => { e.stopPropagation(); sendControl({ alarmSnooze: info.id }); stop(); });
      btns.appendChild(sz);
    }
    const off = el('div', 'btn', 'Tắt');
    off.addEventListener('click', (e) => { e.stopPropagation(); if (info.id) sendControl({ alarmStop: info.id }); stop(); });
    btns.appendChild(off);
    ov.append(mdi(info.tm ? 'timer' : 'alarm'), el('div', 't1', t1), el('div', 't2', t2), btns);
    let ctx: AudioContext | null = null, beep: number | undefined;
    const stopAt = Date.now() + 120000;
    const stop = () => { clearInterval(beep); try { ctx?.close(); } catch { /* */ } ov.remove(); if (alarmId === info.id) alarmId = ''; };
    ov._stop = () => { clearInterval(beep); try { ctx?.close(); } catch { /* */ } };
    if (info.beep !== false) try {
      ctx = new AudioContext();
      beep = window.setInterval(() => {
        if (Date.now() > stopAt) { stop(); return; }
        for (const dt of [0, 0.25, 0.5]) {
          const o = ctx!.createOscillator(), g = ctx!.createGain();
          o.frequency.value = 880;
          g.gain.setValueAtTime(0.0001, ctx!.currentTime + dt);
          g.gain.exponentialRampToValueAtTime(0.5, ctx!.currentTime + dt + 0.02);
          g.gain.exponentialRampToValueAtTime(0.0001, ctx!.currentTime + dt + 0.18);
          o.connect(g); g.connect(ctx!.destination); o.start(ctx!.currentTime + dt); o.stop(ctx!.currentTime + dt + 0.2);
        }
      }, 1500);
    } catch { /* khong co am thanh */ }
    ov.addEventListener('click', (e) => { e.stopPropagation(); if (legacy) stop(); });
    root.appendChild(ov);
  }

  // ── Cap nhat moi giay (chi doi DOM khi gia tri doi — moi lan ve lai la mot khung truyen qua WiFi) ──
  function tick() {
    const t = deviceNow();
    if (t) {
      const hm = pad2(t.getUTCHours()) + ':' + pad2(t.getUTCMinutes());
      setText(pillT, hm); pillChev.style.display = 'none';
      clockEls.forEach((e) => setText(e, hm));
      const dt = dateText(t); dateEls.forEach((e) => setText(e, dt));
    } else { setText(pillT, ''); pillChev.style.display = ''; }
    const al = st?.al;
    if (al && al.at - Date.now() < 24 * 3600_000 && al.at > Date.now()) {
      setText(alarmChip.lastChild as Element, al.t); alarmChip.classList.add('show');
    } else alarmChip.classList.remove('show');
    const tm = st?.tm;
    if (tm && tm.endsAt > Date.now()) {
      const rem = Math.ceil((tm.endsAt - Date.now()) / 1000), h = Math.floor(rem / 3600), m = Math.floor(rem % 3600 / 60), s = rem % 60;
      setText(timerChip.lastChild as Element, (h ? h + ':' + pad2(m) : String(m)) + ':' + pad2(s));
      timerChip.classList.add('show');
    } else timerChip.classList.remove('show');
    updateSaver();
    if (shadeVisible > 0 && st?.nt) renderNotices(st.nt);  // cap nhat "x phut" khi bang dang mo
  }
  setInterval(tick, 1000);

  function applyState(s: DevState) {
    st = s;
    if (vaBtn) vaBtn.style.display = s.va ? '' : 'none';
    window.__rwvLastState = s;
    // Khong lam phien la cua server -> hang o nhanh luon hien; o/thanh truot cua THIET BI chi khi firmware ho tro.
    sliders.style.display = s.ctl ? '' : 'none';
    tiles.forEach((t) => { t.el.style.display = s.ctl && s.tg ? '' : 'none'; });
    dndTile.el.style.display = s.dnd == null ? 'none' : '';
    if (s.dnd != null) dndTile.set(s.dnd);
    renderNotices(s.nt || []);
    renderStatusIcons(s.sb);
    // (30/09/2026) Thiet bi khong co loa (S3) bao am luong 'khong co' (null) -> an thanh am luong, do sang chiem ca hang.
    vol.el.style.display = s.v == null ? 'none' : '';
    bri.set(s.b); vol.set(s.v);
    sndMore.style.display = s.snd ? '' : 'none';
    if (!s.snd && sndOpen) { sndOpen = false; sndRow.style.display = 'none'; }
    if (s.sv) { alertSl.set(s.sv.alert); alarmSl.set(s.sv.alarm); }
    // Bao thuc dang reo (trang vua tai lai / man hinh vua noi lai): hien lai; server da ngung -> dong.
    if (s.rg && s.rg.id !== alarmId) alarm(s.rg.l, { ...s.rg, beep: false });
    else if (!s.rg && alarmId && s.rg !== undefined) alarmClose();
    if (s.tg) { tiles[0].set(s.tg.noSleep); tiles[1].set(s.tg.muted); tiles[2].set(s.tg.aec); }
    if (s.wx) {
      wxIcoBox.replaceChildren(weatherIcon(s.wx.code, s.wx.day));
      setText(wxTxt, s.wx.t + '°' + (s.wx.pp != null && s.wx.pp >= 30 ? '  ☂ ' + s.wx.pp + '%' : ''));
      wxChip.classList.add('show');
      if (homeWx) {
        homeWxIco!.replaceChildren(weatherIcon(s.wx.code, s.wx.day));
        setText(homeWxT!, s.wx.t + '°');
        setText(homeWxS!, s.wx.name + (s.wx.pp != null ? ' · mưa ' + s.wx.pp + '%' : ''));
        homeWx.classList.add('show');
      }
    }
    renderNowPlaying(s.np || []);
    renderPresenceSel(s.ps);
    tick();
    try { window.dispatchEvent(new CustomEvent('rwv-state', { detail: s })); } catch { /* */ }
  }

  // ── (27/09/2026) The TRO LY GIONG NOI: firmware bao trang thai (remote_webview.voice_state) -> server -> day.
  //    Dang nghe / dang xu ly (kem cau ban vua noi) / tra loi (kem cau tra loi) / loi. Cham the: dung (dang nghe)
  //    hoac dong. Xong: an sau vai giay (du doc cau tra loi).
  const VOICE_LABEL = ['Trợ lý', 'Đang nghe…', 'Đang xử lý…', 'Trợ lý', 'Không thực hiện được'];
  let vcEl: HTMLElement | null = null, vcIc: HTMLElement, vcL: HTMLElement, vcQ: HTMLElement, vcA: HTMLElement;
  let vcTimer: number | undefined, vcState = 0, vcAsked = '';
  function voiceHide() { clearTimeout(vcTimer); vcEl?.remove(); vcEl = null; vcAsked = ''; }
  function voice(v: { s: number; t: string }): void {
    clearTimeout(vcTimer);
    if (v.s === 0) {  // xong: giu cau tra loi mot luc roi an
      if (vcEl) vcTimer = window.setTimeout(voiceHide, vcA?.textContent ? 6000 : 1200);
      return;
    }
    if (!vcEl) {
      screensaver(false);
      vcEl = el('div', 'vc' + (CFG.motion === 'full' ? ' anim' : ''));
      vcIc = el('div', 'vc-ic'); vcIc.appendChild(mdi('mic'));
      const col = el('div', 'vc-t');
      vcL = el('div', 'vc-l'); vcQ = el('div', 'vc-q'); vcA = el('div', 'vc-a');
      col.append(vcL, vcQ, vcA);
      vcEl.append(vcIc, col);
      vcEl.addEventListener('click', (e) => {
        e.stopPropagation();
        if (vcState === 1 || vcState === 2) sendControl({ assist: 0 });
        voiceHide();
      });
      root.appendChild(vcEl);
    }
    vcState = v.s;
    vcEl.dataset.s = String(v.s);
    setText(vcL, VOICE_LABEL[v.s] || '');
    if (v.s === 1) { vcAsked = ''; setText(vcQ, ''); setText(vcA, ''); }
    if (v.s === 2 && v.t) vcAsked = v.t;
    setText(vcQ, vcAsked ? '“' + vcAsked + '”' : '');
    if (v.s === 3 || v.s === 4) setText(vcA, v.t || '');
    // Loi: tu an sau 8 s neu firmware khong bao "xong"
    if (v.s === 4) vcTimer = window.setTimeout(voiceHide, 8000);
    window.__rwvLastVoice = { s: v.s, l: vcL.textContent, q: vcQ.textContent, a: vcA.textContent };
  }

  // ── API cho server ──────────────────────────────────────────────────
  let gStartVisible = 0, gLastY = 0;
  window.__rwvShell = {
    state: applyState,
    /** Cu chi keo tu mep tren do server nhan dien: y = vi tri ngon tay (px trang). */
    gesture(phase: 'start' | 'move' | 'end', y: number) {
      const h = fullH();
      // (20/10/2026) Bang trang thai bam theo ngon tay ca khi keo xuong lan keo len (thu lai), moi che do chuyen dong.
      if (phase === 'start') { hideToast(); tick(); gStartVisible = shadeVisible; gLastY = y; return; }
      if (phase === 'move') { gLastY = y; setVisible(Math.max(0, Math.min(h, y)), false); return; }
      // end: qua 1/3 chieu cao thi mo han, khong thi dong
      if (Math.max(gStartVisible, gLastY) > h / 3) openShade(true); else closeShade(true);
    },
    open() { openShade(true); },
    recents: renderRecents,
    back: backGesture,
    homeDrag,
    screensaver,
    notify,
    alarmClose,
    /** (01/10/2026) Phat thu chuong (Cai dat) tren man chua tu phat am: strong = kieu bao thuc. */
    chime,
    close() { closeShade(true); },
    /**
     * (27/10/2026) Nút "Màn hình chính" khi ĐANG ở tab hệ thống: server không còn gì để điều hướng
     * (activateTab() return sớm) nên phải đóng lớp "Gần đây" / bảng điều khiển ngay tại Shell.
     */
    home() { closeRecents(); closeShade(true); },
    isOpen() { return shadeVisible > 0; },
    alarm,
    voice,
    saverPhoto,
    /** (27/09/2026 OS-3) Bo cuc man hinh chinh vua doi (tu panel khac). */
    layout(l: HomeLayout) { homeApi?.setLayout(l); },
    homeInfo() { return homeApi?.info() ?? null; },
  };
  window.__rwvDeviceState = applyState;   // ten cu (server < 2.9.45 goi ten nay)
  window.__rwvAlarm = alarm;

  function mount() {
    if (!document.documentElement) { requestAnimationFrame(mount); return; }
    document.documentElement.appendChild(host);
    setVisible(0, false);
    sendControl({ hello: 1 });  // xin server trang thai thiet bi
  }
  mount();
})();
