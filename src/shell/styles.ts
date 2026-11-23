// SPDX-License-Identifier: Apache-2.0
//
// Copyright (c) 2026 minhquanghp86
// Licensed under the Apache License, Version 2.0 (see LICENSE).

// (25/09/2026) CSS cua Shell — nam trong Shadow DOM nen trang web ben duoi khong de duoc (truoc day font dong ho bi
// trang doi). Kich thuoc theo vmin: cung ma chay tren P4 1024x600 va S3 480x480 / 480x272.
// KHONG hieu ung chay lien tuc: moi khung dong la bang thong WiFi. Chi transform/opacity/height ngan (muc 'full').
export const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.root {
  --bg: #0f1117; --surface: #171a22; --surface-2: #232834; --surface-3: #2d3342; --line: rgba(255,255,255,0.07);
  --text: #f2f4f8; --muted: #9aa3b5; --accent: #3b82f6;
  --r-lg: clamp(14px, 3.4vmin, 26px); --r-md: clamp(10px, 2.4vmin, 18px);
  --gap: clamp(6px, 1.8vmin, 14px); --pad: clamp(10px, 2.8vmin, 22px);
  font: 400 clamp(11px, 2.6vmin, 16px)/1.3 "Be Vietnam Pro", Roboto, "Noto Sans", "DejaVu Sans", sans-serif;
  color: var(--text); -webkit-user-select: none; user-select: none; -webkit-tap-highlight-color: transparent;
  position: fixed; inset: 0; pointer-events: none;
}
.ic { width: 1.25em; height: 1.25em; flex: none; display: block; }
button { font: inherit; color: inherit; border: none; background: none; padding: 0; cursor: pointer; }
button:focus-visible, [tabindex]:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.tnum { font-variant-numeric: tabular-nums; }

/* ── Dong ho (giot nuoc o giua mep tren) — chi hien thi, cham xuyen qua ─ */
.pill { position: absolute; top: 0; left: 50%; transform: translateX(-50%); width: 128px; height: 32px;
  display: flex; justify-content: center; pointer-events: none; }  /* cham xuyen qua xuong trang (tab HA) */
.pill svg.drop { display: block; filter: drop-shadow(0 1px 2px rgba(0,0,0,0.35)); }
/* (08/10/2026) Hang trong giot nuoc: [pin] gio [mang] — luoi 3 cot, gio luon o chinh giua. */
.pill .prow { position: absolute; top: 1px; left: 0; right: 0; height: 19px; display: grid; grid-template-columns: 1fr auto 1fr;
  align-items: center; column-gap: 6px; pointer-events: none; }
.pill .t { text-align: center; font: 600 14px/19px "Be Vietnam Pro", Roboto,
  "Noto Sans", "DejaVu Sans", sans-serif; letter-spacing: 0.5px; font-variant-numeric: tabular-nums; color: #fff; pointer-events: none; }
.pill .sb-l { justify-self: end; display: flex; } .pill .sb-r { justify-self: start; display: flex; }
.pill .sb-bat { width: 22px; height: 11px; color: #fff; display: block; }
.pill .sb-bat.low .lvl { fill: #ff453a; }
/* (16/10/2026) Dang sac / cam nguon: muc pin xanh la (nhu dien thoai); phich cam canh pin hoac thay pin (khong co pin). */
.sb-bat.chg .lvl { fill: #34c759; }
.pill .sb-plug { width: 14px; height: 14px; color: #fff; display: block; }
.sv-top .sb-plug { width: 1.1em; height: 1.1em; display: block; }
.pill .sb-wifi { width: 17px; height: 14px; color: #fff; display: block; }
.pill .sb-eth { width: 15px; height: 15px; color: #fff; display: block; }
.pill.wide { width: 160px; }
.pill .chev { position: absolute; top: 3px; left: 50%; transform: translateX(-50%); width: 16px; height: 16px; color: #fff; }

/* ── Thanh keo xuong ──────────────────────────────────────────────────── */
.scrim { position: absolute; inset: 0; background: #000; opacity: 0; pointer-events: none; }
.scrim.on { pointer-events: auto; }
.shade { position: absolute; top: 0; left: 0; right: 0; height: 0; overflow: hidden; pointer-events: auto;
  background: var(--surface); border-radius: 0 0 var(--r-lg) var(--r-lg); box-shadow: 0 10px 40px rgba(0,0,0,0.5); }
.shade.scroll { overflow-y: auto; overscroll-behavior: contain; }
.shade.anim { transition: height 180ms cubic-bezier(.2,.8,.2,1); }
.scrim.anim { transition: opacity 180ms linear; }
.shade-in { padding: calc(var(--pad) + 6px) var(--pad) calc(var(--pad) + 14px); display: flex; flex-direction: column; gap: var(--gap); }
.handle { position: absolute; left: 50%; bottom: 7px; width: 44px; height: 5px; margin-left: -22px; border-radius: 3px; background: rgba(255,255,255,0.28); }

.info { display: flex; align-items: center; gap: var(--gap); }
.clock { font-weight: 600; font-size: clamp(22px, 7.5vmin, 46px); line-height: 1; letter-spacing: 0.5px; font-variant-numeric: tabular-nums; }
.date { color: var(--muted); margin-top: clamp(2px, 0.8vmin, 6px); white-space: nowrap; }
.spacer { flex: 1; }
.chip { display: none; align-items: center; gap: 6px; padding: clamp(5px, 1.4vmin, 9px) clamp(9px, 2.4vmin, 15px); border-radius: 999px;
  background: var(--surface-2); font-weight: 600; white-space: nowrap; font-variant-numeric: tabular-nums; }
.chip.show { display: flex; }
.chip.timer { background: rgba(249,115,22,0.22); }
.chip.alarmc { background: rgba(99,102,241,0.25); }
.snd-more { flex: none; width: clamp(34px, 7vmin, 46px); border: none; border-radius: var(--r-md); background: rgba(255,255,255,0.08);
  color: #fff; display: flex; align-items: center; justify-content: center; cursor: pointer; }
.snd-more svg { width: 60%; height: 60%; transition: transform .15s; }
.snd-more.open svg { transform: rotate(180deg); }
.snd-row { flex-basis: 100%; }
.alarm { z-index: 3; }
.alarm .al-btns { display: flex; gap: 4vmin; margin-top: 3vmin; }
.alarm .al-btns .btn { margin-top: 0; }
.alarm .btn.snz { background: rgba(255,255,255,0.14); }
.sv-b.al { background: rgba(99,102,241,0.22); color: #c7d2fe; }
.wx-ic { width: 1.4em; height: 1.4em; flex: none; }

.ctl { display: flex; flex-wrap: wrap; gap: var(--gap); align-items: stretch; }
.tiles { display: flex; gap: var(--gap); }
.tile { display: flex; align-items: center; gap: clamp(6px, 1.6vmin, 10px); height: clamp(40px, 10vmin, 58px); padding: 0 clamp(10px, 2.6vmin, 18px);
  border-radius: var(--r-md); background: var(--surface-2); font-weight: 600; white-space: nowrap; }
.tile .ic { width: 1.45em; height: 1.45em; }
.tile.on { color: #0f1117; }
/* Man hep (S3 480): o nhanh chi con bieu tuong (mau nen khi bat van cho biet trang thai) — vua mot hang */
@media (max-width: 560px) { .tile > span { display: none; } .tile { padding: 0 clamp(10px, 3vmin, 16px); } .tiles { flex: 1; justify-content: space-between; } }
.sliders { flex: 1 1 320px; display: flex; gap: var(--gap); min-width: 0; }
.slider { position: relative; flex: 1; min-width: 0; height: clamp(40px, 10vmin, 58px); border-radius: var(--r-md); background: var(--surface-2);
  overflow: hidden; touch-action: none; cursor: pointer; }
.slider .fill { position: absolute; left: 0; top: 0; bottom: 0; width: 0; }
.slider .ic { position: absolute; left: clamp(10px, 2.6vmin, 16px); top: 50%; transform: translateY(-50%); width: 1.45em; height: 1.45em; }
.slider .pct { position: absolute; right: clamp(10px, 2.6vmin, 16px); top: 50%; transform: translateY(-50%); font-weight: 600; font-variant-numeric: tabular-nums; }

/* The "Dang phat": tab nen dang phat (Radio/Nhac) — mo lai hoac dung ngay tu thanh keo xuong */
.ps { display: flex; align-items: center; gap: var(--gap); }
.ps-l { display: flex; align-items: center; gap: clamp(6px, 1.6vmin, 10px); flex: none; color: var(--muted); font-weight: 600; white-space: nowrap; }
.ps-l .ic { width: 1.35em; height: 1.35em; }
.seg { flex: 1; min-width: 0; display: flex; gap: 4px; padding: 4px; border-radius: var(--r-md); background: var(--surface-2); }
.seg button { flex: 1 1 0; min-width: 0; height: clamp(32px, 8vmin, 48px); border-radius: calc(var(--r-md) - 4px); color: var(--muted);
  font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding: 0 6px; }
.seg button.on { background: var(--accent); color: #fff; }
.seg button.off.on { background: var(--surface-3); color: var(--text); }
@media (max-width: 560px) { .ps-l span { display: none; } }
.np { display: flex; flex-direction: column; gap: calc(var(--gap) * 0.6); }
.np-row { display: flex; align-items: center; gap: var(--gap); padding: clamp(6px, 1.6vmin, 10px) clamp(10px, 2.6vmin, 16px);
  border-radius: var(--r-md); background: rgba(234,88,12,0.18); }
.np-row .ic { width: 1.45em; height: 1.45em; color: #fdba74; }
.np-t { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.np-l { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.np-s { color: var(--muted); font-size: 0.86em; }
.np-b { flex: none; height: clamp(32px, 8vmin, 44px); min-width: clamp(32px, 8vmin, 44px); padding: 0 clamp(10px, 2.4vmin, 16px);
  border-radius: 999px; background: var(--surface-2); font-weight: 600; display: flex; align-items: center; justify-content: center; }
.np-b.stop { padding: 0; background: #ea580c; }
.np-b.stop .ic { color: #fff; width: 1.2em; height: 1.2em; }
.np-row.busy { opacity: 0.5; }
/* Man thap (S3 480x272): cac the nam NGANG mot hang, bo dong phu — de bang khong vuot chieu cao man hinh */
@media (max-height: 320px) {
  .np { flex-direction: row; }
  .np-row { flex: 1 1 0; min-width: 0; gap: 6px; padding: 4px 6px 4px 10px; }
  .np-s, .np-row > .ic { display: none; }
}

.shortcuts { display: flex; gap: var(--gap); justify-content: space-around; padding-top: 2px; }
.sc { display: flex; flex-direction: column; align-items: center; gap: clamp(4px, 1vmin, 7px); min-width: 0; flex: 1; max-width: 120px; }
.sc .b { width: clamp(40px, 10vmin, 58px); height: clamp(40px, 10vmin, 58px); border-radius: 50%; background: var(--surface-2);
  display: flex; align-items: center; justify-content: center; }
.sc .b .ic { width: 50%; height: 50%; }
.sc .l { font-size: 0.86em; color: var(--muted); text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }

/* ── Man hinh chinh cua OS (/os/home) ────────────────────────────────── */
.home { position: absolute; inset: 0; pointer-events: auto; overflow: hidden; touch-action: none;
  background: radial-gradient(120% 90% at 15% 0%, #1d2a4a 0%, rgba(29,42,74,0) 55%),
              radial-gradient(90% 80% at 100% 100%, #2a1d44 0%, rgba(42,29,68,0) 60%), var(--bg);
  display: flex; flex-direction: column; padding: calc(var(--pad) + 26px) calc(var(--pad) * 1.6) var(--pad); gap: var(--gap); }
.widgets { display: flex; align-items: flex-end; gap: var(--gap); flex: none; }
.w-clock .clock { font-size: clamp(34px, 13vmin, 84px); font-weight: 500; }
.w-clock .date { font-size: 1.1em; }
.w-wx { display: none; align-items: center; gap: clamp(8px, 2vmin, 14px); padding: clamp(8px, 2vmin, 14px) clamp(12px, 3vmin, 20px);
  border-radius: var(--r-lg); background: rgba(255,255,255,0.07); cursor: pointer; }
.w-wx.show { display: flex; }
.w-wx .wx-ic { width: clamp(30px, 8vmin, 50px); height: clamp(30px, 8vmin, 50px); }
.w-wx .t { font-size: clamp(18px, 5.5vmin, 34px); font-weight: 600; line-height: 1; }
.w-wx .s { color: var(--muted); font-size: 0.9em; margin-top: 3px; white-space: nowrap; }
.pager { flex: 1; min-height: 0; overflow: hidden; position: relative; }
.pages { display: flex; height: 100%; }
.pages.anim { transition: transform 200ms cubic-bezier(.2,.8,.2,1); }
.page { flex: none; width: 100%; height: 100%; display: grid; align-content: start;
  grid-template-columns: repeat(var(--cols), minmax(0, 1fr)); gap: clamp(8px, 2.4vmin, 18px) clamp(4px, 1vmin, 10px); padding-top: clamp(6px, 2vmin, 16px); }
.app { display: flex; flex-direction: column; align-items: center; gap: clamp(4px, 1vmin, 7px); cursor: pointer; min-width: 0; }
.app-ic { width: clamp(38px, 11vmin, 66px); height: clamp(38px, 11vmin, 66px); border-radius: 26%; display: flex; align-items: center;
  justify-content: center; box-shadow: 0 3px 10px rgba(0,0,0,0.35), inset 0 0 0 1px rgba(255,255,255,0.14); flex: none; }
.app .l { font-size: 0.92em; text-align: center; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dots { display: flex; justify-content: center; gap: 7px; height: 8px; flex: none; }
.dots i { width: 7px; height: 7px; border-radius: 50%; background: rgba(255,255,255,0.25); }
.dots i.on { background: #fff; }
.dock { flex: none; align-self: center; display: flex; gap: clamp(10px, 3vmin, 24px); padding: clamp(8px, 2vmin, 12px) clamp(14px, 3.4vmin, 24px);
  border-radius: calc(var(--r-lg) + 6px); background: rgba(255,255,255,0.08); }
.dock .app .l { display: none; }
.dock .app[data-app="ha"] .app-ic { box-shadow: 0 0 0 2px rgba(65,189,245,0.65), 0 3px 10px rgba(0,0,0,0.35); }

/* (27/09/2026 OS-3) Che do sap xep + thu muc. Khong co hieu ung chay lien tuc (bang thong WiFi). */
.editbar { display: none; position: absolute; left: calc(var(--pad) * 1.6); right: calc(var(--pad) * 1.6); top: calc(var(--pad) + 22px);
  align-items: center; gap: var(--gap); min-width: 0; z-index: 3; }
.eb-t { flex: 1; min-width: 0; color: var(--muted); font-size: 0.95em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.eb-b { flex: none; padding: clamp(6px, 1.6vmin, 10px) clamp(12px, 3vmin, 20px); border-radius: 999px; background: var(--surface-3); font-weight: 600; }
.eb-b.pri { background: var(--accent); }
.home.editing .editbar { display: flex; }
.home.editing .w-clock, .home.editing .w-wx { visibility: hidden; }
.home.editing .page { outline: 1px dashed rgba(255,255,255,0.14); outline-offset: -2px; border-radius: var(--r-md); }
.home.editing .app .app-ic { transform: scale(0.92); }
.app.ghost { opacity: 0.25; }
.app.merge .app-ic { transform: scale(1.12); box-shadow: 0 0 0 3px rgba(255,255,255,0.75), 0 3px 10px rgba(0,0,0,0.35); }
.app.drag { position: absolute; left: 0; top: 0; pointer-events: none; z-index: 5; transform-origin: 30% 30%; }
.app.drag .app-ic { box-shadow: 0 10px 26px rgba(0,0,0,0.55), inset 0 0 0 1px rgba(255,255,255,0.2); }
.app.drag .l { display: none; }
/* padding/gap % tinh theo o CHA (khong phai chinh no) -> dung vmin */
.app-ic.fold { background: rgba(255,255,255,0.16); display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-content: start;
  justify-content: stretch; align-items: start; gap: clamp(3px, 0.9vmin, 5px); padding: clamp(5px, 1.5vmin, 9px); }
.app-ic .mini { aspect-ratio: 1; border-radius: 26%; display: flex; align-items: center; justify-content: center; }
.fpop { position: absolute; inset: 0; z-index: 4; background: rgba(8,10,16,0.72); display: flex; align-items: center; justify-content: center; }
.fpanel { width: min(92%, 640px); max-height: 86%; overflow: hidden; border-radius: calc(var(--r-lg) + 4px); background: rgba(40,46,60,0.96);
  padding: var(--pad); display: flex; flex-direction: column; gap: var(--gap); }
.f-name { font-size: 1.25em; font-weight: 600; text-align: center; }
.f-chips { display: flex; flex-wrap: wrap; justify-content: center; gap: 6px; }
.fchip { padding: 5px 12px; border-radius: 999px; background: var(--surface-3); font-size: 0.9em; }
.fchip.on { background: var(--accent); }
.f-grid { display: grid; grid-template-columns: repeat(var(--cols), minmax(0, 1fr)); gap: clamp(8px, 2.4vmin, 18px) clamp(4px, 1vmin, 10px); }

/* ── Gan day (OS-3) ────────────────────────────────────────────────── */
.recents { position: absolute; inset: 0; pointer-events: auto; background: rgba(12,14,20,0.97); display: flex; flex-direction: column;
  padding: calc(var(--pad) + 8px) 0 var(--pad); gap: var(--gap); }
.recents.anim { animation: rc-in 140ms ease-out; }
@keyframes rc-in { from { opacity: 0; } }
.rc-head { display: flex; align-items: center; gap: var(--gap); padding: 0 calc(var(--pad) * 1.6); }
.rc-head .t { font-size: 1.35em; font-weight: 600; }
.rc-all { padding: clamp(6px, 1.6vmin, 10px) clamp(12px, 3vmin, 20px); border-radius: 999px; background: var(--surface-2); font-weight: 600; }
.rc-row { flex: 1; min-height: 0; display: flex; align-items: center; gap: calc(var(--gap) * 1.8); overflow-x: auto; overflow-y: hidden;
  padding: 0 calc(var(--pad) * 1.6); scroll-snap-type: x mandatory; scrollbar-width: none; }
.rc-row::-webkit-scrollbar { display: none; }
.rc { flex: none; width: clamp(140px, 29vw, 360px); display: flex; flex-direction: column; gap: clamp(6px, 1.4vmin, 10px);
  scroll-snap-align: center; touch-action: pan-x; cursor: pointer; transition: transform 160ms ease-out, opacity 160ms ease-out; }
/* can giua khi vua man hinh, van cuon duoc khi tran */
.rc:first-child { margin-left: auto; }
.rc:last-child { margin-right: auto; }
.rc-top { display: flex; align-items: center; gap: clamp(6px, 1.4vmin, 10px); min-width: 0; }
.rc-top .app-ic { width: clamp(22px, 5.5vmin, 32px); height: clamp(22px, 5.5vmin, 32px); border-radius: 28%; box-shadow: none; }
.rc-l { flex: 1; min-width: 0; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rc-x { flex: none; width: clamp(26px, 6.5vmin, 36px); height: clamp(26px, 6.5vmin, 36px); border-radius: 50%; background: var(--surface-2);
  display: flex; align-items: center; justify-content: center; font-size: 0.95em; }
.rc-img { position: relative; aspect-ratio: var(--ar, 1.7); max-height: 62vh; border-radius: var(--r-lg); overflow: hidden; background: var(--surface-2);
  box-shadow: 0 8px 28px rgba(0,0,0,0.45), inset 0 0 0 1px rgba(255,255,255,0.08); display: flex; align-items: center; justify-content: center; }
.rc-img img { width: 100%; height: 100%; object-fit: cover; display: block; }
.rc-ph { width: 30%; aspect-ratio: 1; border-radius: 26%; display: flex; align-items: center; justify-content: center; }
.rc.cur .rc-img { box-shadow: 0 0 0 2px var(--accent), 0 8px 28px rgba(0,0,0,0.45); }
.rc.gone { opacity: 0; transform: translateY(-40%); pointer-events: none; }
.rc-empty { margin: auto; color: var(--muted); }

/* ── Quay lai (OS-3) ─────────────────────────────────────────────────── */
.backbub { position: absolute; left: -10px; top: 50%; width: 52px; height: 52px; border-radius: 50%; pointer-events: none; opacity: 0;
  display: flex; align-items: center; justify-content: center; background: rgba(35,40,52,0.94); color: #fff;
  box-shadow: 0 4px 16px rgba(0,0,0,0.45); transition: opacity 120ms linear, background-color 120ms linear; }
.backbub.right { left: auto; right: -10px; }
.backbub .ic { width: 26px; height: 26px; }
.backbub.on { opacity: 1; }
.backbub.armed { background: var(--accent); }

/* ── Vuot len tu mep duoi (Home / giu = Gan day) ─────────────────────── */
.homebar { position: absolute; left: 50%; bottom: 10px; transform: translateX(-50%); display: flex; flex-direction: column; align-items: center;
  gap: 8px; pointer-events: none; opacity: 0; transition: opacity 120ms linear; }
.homebar.on { opacity: 1; }
.hb-pill { width: clamp(90px, 22vmin, 150px); height: 6px; border-radius: 3px; background: rgba(255,255,255,0.9);
  box-shadow: 0 0 0 1px rgba(0,0,0,0.25), 0 2px 10px rgba(0,0,0,0.4); }
.homebar.armed .hb-pill { background: var(--accent); }
.hb-t { font-weight: 600; font-size: 0.95em; white-space: nowrap; padding: 5px 12px; border-radius: 999px; background: rgba(20,22,30,0.88); }
.hb-t:empty { display: none; }

/* ── Man hinh cho (OS-5) ──────────────────────────────────────────────── */
.saver { position: absolute; inset: 0; pointer-events: auto; touch-action: none; background: #000; display: flex; align-items: center; justify-content: center; }
.saver.anim { animation: sv-in 500ms ease-out; }
@keyframes sv-in { from { opacity: 0; } }
.sv-box { display: flex; flex-direction: column; align-items: center; gap: clamp(4px, 1.6vmin, 14px); }
/* (07/10/2026) Bebas Neue (clockFont.ts, nguoi dung chon): chu cao + hep, mot do dam; line-height 0.82 vi chu so chi cao ~0,7em. */
.sv-clock { font-family: "RwvClock", "Be Vietnam Pro", Roboto, sans-serif; font-size: min(30vmin, 21vw); font-weight: 400; line-height: 0.82;
  letter-spacing: 0.02em; font-variant-numeric: tabular-nums; color: #f2f4f8; }
.sv-date { font-size: clamp(13px, 3.8vmin, 28px); color: var(--muted); }
.sv-wx { display: flex; align-items: center; gap: clamp(6px, 1.4vmin, 12px); font-size: clamp(13px, 3.6vmin, 26px); color: #cfd6e4; }
.sv-wx:empty { display: none; }
.sv-wx .wx-ic { width: 1.4em; height: 1.4em; }
.saver.night .sv-clock { color: #9a6a58; }
.saver.night .sv-date, .saver.night .sv-wx { color: #5e463d; }
.saver.night .sv-wx .wx-ic { opacity: 0.4; filter: sepia(1); }
/* (27/09/2026) Man hinh cho dang khung anh: anh phu kin, dong ho nho o goc duoi trai (van dich moi phut). */
.sv-ph { position: absolute; inset: 0; background: #000; opacity: 0; overflow: hidden; }
/* (30/10/2026) Anh nen ve bang <img> (object-fit: cover) thay background-image: Chrome headless raster
   lop background bi soc khi scale anh lon; the <img> khong bi. Giu nguyen hieu ung chuyen. */
.sv-img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.sv-ph.show { opacity: 1; }
/* (27/09/2026) Hieu ung chuyen anh — chay mot lan (~0,7 s) moi lan doi, khong co chuyen dong lien tuc. */
.sv-ph.fx-fade { transition: opacity 1600ms ease; }
.sv-ph.fx-slide { transition: transform 1600ms cubic-bezier(.2,.8,.2,1); opacity: 1; }
.sv-ph.fx-slide.fromR { transform: translateX(100%); transition: none; }
.sv-ph.fx-slide.fromL { transform: translateX(-100%); transition: none; }
.sv-ph.fx-slide.show { transform: translateX(0); }
.sv-ph.fx-slide.toL { transform: translateX(-100%); }
.sv-ph.fx-slide.toR { transform: translateX(100%); }
.sv-ph.fx-zoom { transition: opacity 1600ms ease, transform 1800ms ease; }
.sv-ph.fx-zoom.fromR { transform: scale(1.25); }
.sv-ph.fx-zoom.fromL { transform: scale(0.8); }
/* Hieu ung moi */
.sv-ph.fx-blur { transition: opacity 1500ms ease, filter 1600ms ease; }
.sv-ph.fx-blur.show { filter: blur(0); }
.sv-ph.fx-blur.fromR, .sv-ph.fx-blur.fromL { filter: blur(18px); }
.sv-ph.fx-ken .sv-img { animation: svKen 18s ease-out forwards; }
@keyframes svKen { from { transform: scale(1); } to { transform: scale(1.08); } }
/* Hieu ung trinh chieu mo rong (30/10/2026) */
.sv-ph.fx-rotate { transition: opacity 1400ms ease, transform 1800ms cubic-bezier(.2,.8,.2,1); }
.sv-ph.fx-rotate.fromR { transform: rotate(10deg) scale(1.18); opacity: 0; }
.sv-ph.fx-rotate.fromL { transform: rotate(-10deg) scale(1.18); opacity: 0; }
.sv-ph.fx-rotate.show { transform: rotate(0) scale(1); opacity: 1; }
.sv-ph.fx-rotate.toL { transform: rotate(-6deg) scale(.92); opacity: 0; }
.sv-ph.fx-rotate.toR { transform: rotate(6deg) scale(.92); opacity: 0; }
.sv-ph.fx-drop { transition: transform 1800ms cubic-bezier(.2,.9,.3,1.12), opacity 1000ms ease; }
.sv-ph.fx-drop.fromR, .sv-ph.fx-drop.fromL { transform: translateY(-110%); }
.sv-ph.fx-drop.show { transform: translateY(0); }
.sv-ph.fx-drop.toL, .sv-ph.fx-drop.toR { transform: translateY(30%); opacity: 0; }
.sv-ph.fx-flip { transition: transform 1800ms ease, opacity 900ms ease; }
.sv-ph.fx-flip.fromR { transform: perspective(1400px) rotateY(90deg); opacity: 0; }
.sv-ph.fx-flip.fromL { transform: perspective(1400px) rotateY(-90deg); opacity: 0; }
.sv-ph.fx-flip.show { transform: perspective(1400px) rotateY(0); opacity: 1; }
.sv-ph.fx-flip.toL { transform: perspective(1400px) rotateY(-90deg); opacity: 0; }
.sv-ph.fx-flip.toR { transform: perspective(1400px) rotateY(90deg); opacity: 0; }
.sv-ph.fx-zoom.fromR, .sv-ph.fx-zoom.fromL { transform: scale(1.08); transition: none; }
.sv-ph.fx-zoom.show { transform: scale(1); }
.sv-ph.fx-none { transition: none; }
.sv-bdg { display: flex; gap: clamp(6px, 1.6vmin, 12px); flex-wrap: wrap; justify-content: center; }
.sv-bdg:empty { display: none; }
.sv-b { display: inline-flex; align-items: center; gap: 0.4em; padding: 0.35em 0.9em; border: none; border-radius: 999px; cursor: pointer;
  background: rgba(59,130,246,0.22); color: #dbeafe; font: 600 clamp(12px, 3.2vmin, 22px)/1.2 "Be Vietnam Pro", Roboto, sans-serif; }
.sv-b .ic, .sv-b svg { width: 1.2em; height: 1.2em; }
.sv-b + .sv-b { background: rgba(245,158,11,0.2); color: #fde68a; }
.saver.night .sv-b { background: rgba(120,80,60,0.25); color: #9a6a58; }
/* (16/10/2026) Goc tren phai man hinh cho kieu dien thoai: tin nhan / thong bao / bao thuc (bieu tuong + so), mang, pin. */
.sv-top { position: absolute; top: clamp(6px, 1.6vmin, 14px); right: clamp(10px, 2.4vmin, 20px); display: flex; align-items: center;
  gap: clamp(8px, 1.8vmin, 14px); color: #fff; font: 600 clamp(13px, 3vmin, 19px)/1 "Be Vietnam Pro", Roboto, sans-serif; z-index: 2; }
.sv-top:empty { display: none; }
.sv-tb { display: inline-flex; align-items: center; gap: 0.3em; padding: 0.28em 0.7em; border: none; border-radius: 999px; cursor: pointer;
  background: rgba(255,255,255,0.14); color: inherit; font: inherit; }
.sv-tb .ic { width: 1.15em; height: 1.15em; }
.sv-tb.al { background: rgba(245,158,11,0.22); color: #fde68a; }
.sv-top .sb-wifi { width: 1.2em; height: 1em; display: block; }
.sv-top .sb-eth { width: 1.1em; height: 1.1em; display: block; }
.sv-bt { display: inline-flex; align-items: center; gap: 0.3em; font-variant-numeric: tabular-nums; }
.sv-top .sb-bat { width: 1.6em; height: 0.8em; display: block; }
.sv-top .sb-bat.low .lvl { fill: #ff453a; }
.saver.photo .sv-top { text-shadow: 0 1px 6px rgba(0,0,0,0.7); }
.saver.photo .sv-tb { background: rgba(0,0,0,0.45); }
.saver.night .sv-top { color: #9a6a58; }
.saver.night .sv-tb { background: rgba(120,80,60,0.2); }
/* (16/10/2026) CUOC GOI NHO tren man hinh cho: the do dac, chu trang lon, bieu tuong tron + anh khach (chuong cong) — khac han
   chip thong bao xanh. Chiem ca hang cua dai chip (flex-basis 100%). */
/* Dai chip chi con the goi nho (chip da len goc tren phai): gian het be ngang cot de the khong co lai theo chu. */
.sv-main > .sv-bdg { align-self: stretch; }
.sv-miss { flex: 1 0 100%; display: flex; align-items: center; gap: clamp(8px, 2.2vmin, 16px); box-sizing: border-box; max-width: min(92vw, 560px);
  padding: clamp(6px, 1.6vmin, 12px) clamp(10px, 2.4vmin, 18px); border: none; border-radius: clamp(14px, 3.2vmin, 24px); cursor: pointer;
  background: #dc2626; color: #fff; text-align: left; box-shadow: 0 6px 24px rgba(220,38,38,0.35); font-family: "Be Vietnam Pro", Roboto, sans-serif; }
.sv-mic { flex: none; display: inline-flex; align-items: center; justify-content: center; border-radius: 50%; background: #fff; color: #dc2626;
  width: clamp(30px, 8.4vmin, 60px); height: clamp(30px, 8.4vmin, 60px); }
.sv-mic .ic { width: 62%; height: 62%; }
.sv-mtx { display: flex; flex-direction: column; min-width: 0; flex: 1 1 auto; }
.sv-mtx b { font: 700 clamp(15px, 4.6vmin, 32px)/1.15 "Be Vietnam Pro", Roboto, sans-serif; white-space: nowrap; }
.sv-mtx span { font: 500 clamp(11px, 2.8vmin, 19px)/1.25 "Be Vietnam Pro", Roboto, sans-serif; opacity: 0.92; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sv-mimg { flex: none; height: clamp(34px, 9.6vmin, 72px); aspect-ratio: 4/3; object-fit: cover; border-radius: clamp(8px, 1.8vmin, 14px); }
.saver.night .sv-miss { background: #7f1d1d; color: #f3d6cf; box-shadow: none; }
.saver.night .sv-mic { background: #f3d6cf; color: #7f1d1d; }
.saver.photo .sv-miss { text-shadow: none; }
.saver.photo .sv-b { text-shadow: 0 1px 6px rgba(0,0,0,0.7); background: rgba(0,0,0,0.45); }
.nt-row.new .nt-t::before { content: ''; display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #3b82f6; margin-right: 6px; vertical-align: middle; }
.sv-cap { font-size: clamp(11px, 2.6vmin, 16px); color: #fff; opacity: 0.85; text-shadow: 0 1px 8px rgba(0,0,0,0.8); }
.sv-cap:empty { display: none; }
.saver:not(.photo) .sv-cap { display: none; }
.saver.photo.noclock .sv-clock, .saver.photo.noclock .sv-date, .saver.photo.noclock .sv-wx { display: none; }
.sv-box { position: relative; }
.saver.photo { align-items: flex-end; justify-content: flex-start; padding: clamp(14px, 4vmin, 34px); }
.saver.photo .sv-box { align-items: flex-start; gap: 2px; }
.saver.photo .sv-clock { font-size: min(15vmin, 12vw); font-weight: 400; text-shadow: 0 2px 14px rgba(0,0,0,0.75); }
.saver.photo .sv-date, .saver.photo .sv-wx { color: #fff; text-shadow: 0 1px 8px rgba(0,0,0,0.8); }
/* (07/10/2026) Man hinh khoa: 3 co dong ho, the thoi tiet chi tiet (ngang: dong ho trai / the phai; vuong: xep doc), goi y
   vuot len o day. KHONG co hoat anh lap lien tuc (moi khung doi = mot khung gui qua WiFi). */
.sv-main { display: flex; flex-direction: column; align-items: center; gap: clamp(4px, 1.6vmin, 14px); }
.saver.photo .sv-main { align-items: flex-start; gap: 2px; }
.saver.ck-m .sv-clock { font-size: min(40vmin, 34vw); }
.saver.ck-l .sv-clock { font-size: min(52vmin, 42vw); }
.saver.ck-xl .sv-clock { font-size: min(64vmin, 50vw); }
.saver.photo.ck-m .sv-clock { font-size: min(20vmin, 16vw); }
.saver.photo.ck-l .sv-clock { font-size: min(26vmin, 20vw); }
.saver.photo.ck-xl .sv-clock { font-size: min(32vmin, 25vw); }
.saver.hascard .sv-wx { display: none; }
.sv-card:empty { display: none; }
/* (16/10/2026) Cot phai (man ngang): the thoi tiet + dong camera / lich ngay duoi. Man vuong: tan vao sv-box (thu tu cu). */
.sv-side { display: flex; flex-direction: column; align-items: stretch; gap: clamp(10px, 2.4vmin, 18px); min-width: 0; }
.sv-rows { display: flex; flex-direction: column; align-items: flex-start; gap: clamp(8px, 1.8vmin, 14px); padding: 0 clamp(4px, 1vmin, 8px); min-width: 0; }
.sv-rows:empty { display: none; }
.saver:not(.hascard) .sv-rows { align-items: center; }
@media (max-aspect-ratio: 4/3) { .sv-side { display: contents; } .sv-rows { align-items: inherit; } }
.sv-card { display: flex; flex-direction: column; gap: clamp(8px, 2vmin, 16px); color: #dfe6f2; box-sizing: border-box;
  padding: clamp(10px, 2.4vmin, 20px) clamp(12px, 3vmin, 24px); border-radius: clamp(14px, 3vmin, 24px); background: rgba(255,255,255,0.06); }
.wc-now { display: flex; align-items: center; gap: clamp(8px, 2vmin, 16px); }
.wc-now .wx-ic { width: clamp(44px, 12vmin, 92px); height: clamp(44px, 12vmin, 92px); }
.wc-t { font-size: clamp(34px, 11vmin, 84px); font-weight: 300; line-height: 1; font-variant-numeric: tabular-nums; }
.wc-desc { display: flex; flex-direction: column; gap: 2px; }
.wc-name { font-size: clamp(14px, 3.6vmin, 26px); font-weight: 600; }
.wc-sub { font-size: clamp(12px, 2.8vmin, 20px); color: var(--muted); }
.wc-sub .nw { white-space: nowrap; }
.wc-row { display: flex; flex-wrap: wrap; gap: clamp(10px, 2.4vmin, 20px); font-size: clamp(12px, 3vmin, 21px); }
.wc-i { display: inline-flex; align-items: center; gap: 0.3em; }
.wc-i .ic { width: 1.2em; height: 1.2em; opacity: 0.8; }
.wc-i.a1 { color: #86efac; } .wc-i.a2 { color: #fde047; } .wc-i.a3 { color: #fdba74; } .wc-i.a4 { color: #fca5a5; }
.wc-hr { display: flex; justify-content: space-between; gap: clamp(6px, 1.6vmin, 14px); }
.wc-h { display: flex; flex-direction: column; align-items: center; gap: 2px; font-size: clamp(11px, 2.6vmin, 18px); color: #cfd6e4; font-variant-numeric: tabular-nums; }
.wc-h .wx-ic { width: clamp(20px, 5vmin, 36px); height: clamp(20px, 5vmin, 36px); }
.wc-hp { color: #93c5fd; font-size: 0.85em; }
@media (min-aspect-ratio: 4/3) {
  /* Dong ho + the cung hang: thang co rieng de tong be rong <= 94vw (do that P4: xl 44vmin + the tran mep phai). */
  .saver.hascard .sv-box { flex-direction: row; align-items: center; gap: clamp(16px, 4vw, 48px); max-width: 92vw; }
  .saver.hascard .sv-main { align-items: flex-start; flex: 0 1 auto; min-width: 0; }
  .saver.hascard .sv-side { flex: 0 1 auto; max-width: 40vw; }
  .saver.hascard.ck-m .sv-clock { font-size: min(32vmin, 21vw); }
  .saver.hascard.ck-l .sv-clock { font-size: min(40vmin, 25vw); }
  .saver.hascard.ck-xl .sv-clock { font-size: min(46vmin, 28vw); }
  /* (16/10/2026) Them the "Cuoc goi nho" + 2 hang nang luong: cot trai cao hon man (do that P4: dinh dong ho bi cat). */
  .saver.hasmiss.hascard .sv-main .sv-clock { font-size: min(34vmin, 22vw); }
}
@media (max-aspect-ratio: 4/3) {
  /* Man vuong (S3 480x480): dong ho + ngay + the xep doc gan het chieu cao -> bot mot nac co de chua cho goi y vuot. */
  .saver.hascard .sv-card { padding: 8px 12px; gap: 6px; }
  .saver.hascard .wc-h:nth-child(n+5) { display: none; }
  .saver.hascard.ck-m .sv-clock { font-size: min(26vmin, 24vw); }
  .saver.hascard.ck-l .sv-clock { font-size: min(32vmin, 28vw); }
  .saver.hascard.ck-xl .sv-clock { font-size: min(38vmin, 32vw); }
}
.sv-hint { position: absolute; left: 0; right: 0; bottom: clamp(8px, 2.6vmin, 22px); display: flex; flex-direction: column; align-items: center;
  gap: 2px; color: rgba(226,232,240,0.5); font: 500 clamp(12px, 2.8vmin, 18px)/1.2 "Be Vietnam Pro", Roboto, sans-serif; pointer-events: none; }
.sv-hint .ic { width: clamp(20px, 4.4vmin, 30px); height: clamp(20px, 4.4vmin, 30px); }
.sv-hint.pulse { color: #fff; }
.saver.anim .sv-hint.pulse { animation: sv-pulse 700ms ease-out; }
@keyframes sv-pulse { 0% { transform: translateY(0); } 35% { transform: translateY(-10px); } 100% { transform: translateY(0); } }
.saver.night .sv-hint { color: rgba(154,106,88,0.55); }
.saver.night .sv-card { background: rgba(120,80,60,0.12); color: #9a6a58; }
.saver.night .wc-h, .saver.night .wc-sub, .saver.night .wc-hp { color: #7a5848; }
.saver.night .sv-card .wx-ic { opacity: 0.4; filter: sepia(1); }
/* (08/10/2026) Dem: chu AQI theo tong toi cua the (do that: "AQI 76" vang sang giua man tong nau). */
.saver.night .wc-i.a1, .saver.night .wc-i.a2, .saver.night .wc-i.a3, .saver.night .wc-i.a4 { color: inherit; }
.saver.unlocking { transform: translateY(-100%) !important; opacity: 0; transition: transform 260ms ease-in, opacity 260ms ease-in; }
.saver.lock.photo { padding-bottom: clamp(40px, 9vmin, 70px); }
/* Chua cho dong goi y vuot o day (do that S3: goi y de len the thoi tiet). */
.saver.lock:not(.photo) { padding-bottom: clamp(34px, 10vmin, 64px); box-sizing: border-box; }
.saver.photo .sv-card { background: rgba(0,0,0,0.45); color: #fff; text-shadow: 0 1px 6px rgba(0,0,0,0.6); }
/* (16/10/2026) zoom dat tren CA cot phai (the trong .sv-side: zoom rieng the khong con thu nho be rong cot -> S3 480x272 the
   rong them ~30 px, nhan nang luong bi cat). Man vuong: .sv-side la display: contents -> zoom lai tren the. */
@media (min-aspect-ratio: 4/3) { .saver.photo .sv-side { zoom: 0.82; } }
@media (max-aspect-ratio: 4/3) { .saver.photo .sv-card { zoom: 0.82; } }
.saver.photo .wc-sub, .saver.photo .wc-h { color: #e5e7eb; }
@media (min-aspect-ratio: 4/3) {
  .saver.photo.hascard .sv-box { flex-direction: row; align-items: flex-end; justify-content: space-between; width: 100%; }
}
@media (max-aspect-ratio: 4/3) {
  .saver.photo.hascard .sv-card { display: none; }
  .saver.photo.hascard .sv-wx { display: flex; }
}

/* (08/10/2026) Widget man hinh khoa (lockWidgets.ts): dai nang luong (mat troi / pin / tieu thu) + dong lich / camera duoi
   ngay thang. Mau theo vai tro (mat troi ho phach, pin theo %, camera dang thay nguoi = do). Khong hoat anh. */
.sv-lw { display: flex; flex-direction: column; align-items: inherit; gap: clamp(6px, 1.6vmin, 12px); max-width: 100%; margin-top: clamp(2px, 1vmin, 8px); }
.sv-lw:empty { display: none; }
/* (16/10/2026) 6 chi so: luoi 3 cot x 2 hang (cot rong theo noi dung, cac o cung cot thang hang). */
.lw-en { display: grid; grid-template-columns: repeat(3, auto); justify-content: center; gap: clamp(8px, 2.4vmin, 18px) clamp(14px, 3.6vmin, 30px); }
.lw-s { display: flex; align-items: center; gap: clamp(6px, 1.4vmin, 10px); min-width: 0; }
.lw-s > .ic { flex: none; width: clamp(26px, 6.4vmin, 40px); height: clamp(26px, 6.4vmin, 40px); }
.lw-tx { display: flex; flex-direction: column; min-width: 0; }
.lw-v { font: 600 clamp(16px, 4.4vmin, 30px)/1.05 "Be Vietnam Pro", Roboto, sans-serif; color: #eef2f8; font-variant-numeric: tabular-nums; white-space: nowrap; }
.lw-l { margin-top: 2px; font: 500 clamp(10px, 2.4vmin, 15px)/1.2 "Be Vietnam Pro", Roboto, sans-serif; color: var(--muted); white-space: nowrap; }
.lw-s.sun > .ic { color: #fbbf24; }
.lw-s.sun.off > .ic { color: #64748b; }
.lw-s.b-ok > .ic { color: #4ade80; }
.lw-s.b-mid > .ic { color: #fbbf24; }
.lw-s.b-low > .ic { color: #f87171; }
.lw-s.load > .ic, .lw-s.grid > .ic { color: #93c5fd; }
.lw-r { display: flex; align-items: center; gap: clamp(6px, 1.4vmin, 10px); max-width: min(100%, 88vw); color: #cfd6e4;
  font: 400 clamp(12px, 3vmin, 19px)/1.25 "Be Vietnam Pro", Roboto, sans-serif; }
.lw-ri { flex: none; display: inline-flex; align-items: center; justify-content: center; width: clamp(22px, 5.2vmin, 32px); height: clamp(22px, 5.2vmin, 32px);
  border-radius: 50%; background: rgba(255,255,255,0.08); }
.lw-ri .ic { width: 64%; height: 64%; }
.lw-r.cal .lw-ri { color: #a5b4fc; }
.lw-r.cam .lw-ri { color: #67e8f9; }
.lw-r.cam.live .lw-ri { color: #fff; background: #dc2626; }
.lw-rt { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lw-rt b { font-weight: 600; color: #eef2f8; }
.saver.night .lw-v, .saver.night .lw-rt b { color: #9a6a58; }
.saver.night .lw-l, .saver.night .lw-r { color: #5e463d; }
.saver.night .lw-s > .ic, .saver.night .lw-ri { color: #7a5848; }
.saver.night .lw-ri { background: rgba(120,80,60,0.15); }
.saver.night .lw-r.cam.live .lw-ri { color: #e9d5c9; background: #7f1d1d; }
.saver.photo .sv-lw { text-shadow: 0 1px 6px rgba(0,0,0,0.75); }
.saver.photo .lw-en { justify-content: flex-start; }
.saver.photo .lw-l, .saver.photo .lw-r { color: #e5e7eb; }
.saver.photo .lw-ri { background: rgba(0,0,0,0.45); }
@media (min-aspect-ratio: 4/3) {
  .saver.hascard .lw-en { justify-content: flex-start; }
  .saver.hascard .lw-r { max-width: 100%; }
}
/* Man vuong (S3 480x480): dong ho + ngay + nang luong + the thoi tiet da gan het chieu cao (do that ban xem truoc: tran ca
   mep tren lan goi y vuot) -> co widget thi the bo hang du bao theo gio; toi da 2 dong lich / camera. */
@media (max-aspect-ratio: 4/3) {
  .saver.haslw.hascard .wc-hr { display: none; }
  .saver.haslw .lw-r ~ .lw-r ~ .lw-r { display: none; }
}
/* Co anh nen (khung anh gia dinh): chi dai nang luong + 1 dong — khong che anh qua nhieu. Khung anh tat "Hiện đồng hồ"
   (xem anh tron): an luon widget. */
.saver.photo.haslw .lw-r ~ .lw-r { display: none; }
.saver.photo.noclock .sv-lw { display: none; }
/* (16/10/2026) Man NGANG THAP (S3 480x272) co the thoi tiet: cot trai (dong ho / ngay / widget) KHONG duoc lan sang the — do
   that: dai nang luong 3 o ~350 px > ~270 px con lai -> "Tieu thu" de len the thoi tiet. Cot trai co theo cho con lai, the giu
   be rong, 3 o nang luong chia deu va nhan xuong dong; co cuoc goi nho thi bo dong lich / camera cho du cho. */
@media (min-aspect-ratio: 4/3) and (max-height: 320px) {
  .saver.hascard .sv-box { width: 100%; gap: 12px; }
  .saver.hascard .sv-main { flex: 1 1 0; min-width: 0; }
  .saver.hascard .sv-side { flex: none; }
  .saver.hascard .lw-en { width: 100%; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 3px 6px; }
  .saver.hascard .lw-s { gap: 3px; }
  .saver.hascard .lw-s > .ic { width: 16px; height: 16px; }
  .saver.hascard .lw-v { font-size: 13px; }
  .saver.hascard .lw-l { font-size: 9px; margin-top: 0; overflow: hidden; text-overflow: ellipsis; }
  /* (16/10/2026) The thoi tiet SAT TREN (ngay duoi thanh trang thai), cho trong ben duoi danh cho 1 dong camera / lich
     (truoc day an tren man nay). */
  .saver.hascard .sv-box { align-self: stretch; }
  .saver.hascard .sv-main { align-self: flex-end; }
  .saver.hascard .sv-side { align-self: flex-start; margin-top: 28px; }
  .saver.hascard .sv-rows .lw-r ~ .lw-r { display: none; }
  .saver.hascard .sv-rows { padding: 0 2px; }
  .saver.hascard .lw-r { max-width: 100%; }
  .saver.hasmiss.hascard .sv-mimg { display: none; }
  /* Co the goi nho: cot trai cao them ~50 px -> dong ho nho lai, bo chu thich anh (do that: dong ho tran mep tren). */
  .saver.hasmiss.hascard .sv-main .sv-clock { font-size: 22vmin; }
  .saver.hasmiss .sv-cap { display: none; }
  .saver.hasmiss .sv-main { gap: 4px; }
  .sv-miss { padding: 5px 10px; }
  .sv-mic { width: 30px; height: 30px; }
}

/* ── Thong bao (OS-5) ────────────────────────────────────────────────── */
.pill.unread::after { content: ''; position: absolute; top: 6px; right: 26px; width: 7px; height: 7px; border-radius: 50%; background: #f59e0b; }
.nt { display: flex; flex-direction: column; gap: calc(var(--gap) * 0.6); }
.nt-head { display: flex; align-items: center; gap: var(--gap); }
.nt-h { font-weight: 600; color: var(--muted); font-size: 0.9em; letter-spacing: 0.04em; text-transform: uppercase; }
.nt-clr { font-size: 0.9em; color: var(--muted); padding: 4px 8px; }
.nt-row { display: flex; align-items: center; gap: var(--gap); padding: clamp(6px, 1.5vmin, 10px) clamp(8px, 2vmin, 14px); border-radius: var(--r-md);
  background: var(--surface-2); cursor: pointer; }
.nt-ic, .to-ic { flex: none; width: clamp(30px, 7.5vmin, 44px); height: clamp(30px, 7.5vmin, 44px); border-radius: 30%; overflow: hidden;
  display: flex; align-items: center; justify-content: center; background: rgba(59,130,246,0.22); color: #93c5fd; }
.nt-ic.high, .to-ic.high { background: rgba(245,158,11,0.22); color: #fcd34d; }
.nt-ic.critical, .to-ic.critical { background: rgba(239,68,68,0.25); color: #fca5a5; }
.nt-ic img, .to-ic img { width: 100%; height: 100%; object-fit: cover; display: block; }
.nt-ic .ic, .to-ic .ic { width: 55%; height: 55%; }
.nt-txt, .to-txt { flex: 1; min-width: 0; }
.nt-top { display: flex; align-items: baseline; gap: 8px; }
.nt-t { flex: 1; min-width: 0; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.nt-ago { flex: none; color: var(--muted); font-size: 0.82em; }
.nt-m { color: var(--muted); font-size: 0.92em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.nt-x, .to-x { flex: none; width: clamp(24px, 6vmin, 32px); height: clamp(24px, 6vmin, 32px); border-radius: 50%; display: flex; align-items: center;
  justify-content: center; color: var(--muted); }
.toast { position: absolute; top: 12px; left: 50%; transform: translateX(-50%); width: min(620px, calc(100vw - 20px)); box-sizing: border-box;
  display: flex; align-items: center; gap: clamp(8px, 2vmin, 14px); padding: clamp(8px, 2vmin, 14px); border-radius: var(--r-lg);
  background: rgba(23,26,34,0.97); box-shadow: 0 10px 34px rgba(0,0,0,0.5), inset 0 0 0 1px rgba(255,255,255,0.08); pointer-events: auto; cursor: pointer; }
.toast.anim { animation: to-in 200ms cubic-bezier(.2,.8,.2,1); }
.toast.onlock { pointer-events: none; }
@keyframes to-in { from { transform: translate(-50%, -130%); } }
.toast.critical { box-shadow: 0 10px 34px rgba(0,0,0,0.5), inset 0 0 0 2px rgba(239,68,68,0.8); }
.toast .to-ic { width: clamp(44px, 12vmin, 76px); height: clamp(44px, 12vmin, 76px); }
.toast.critical .to-ic { width: clamp(64px, 20vmin, 132px); height: clamp(48px, 15vmin, 100px); border-radius: var(--r-md); }
.to-t { font-weight: 700; font-size: 1.08em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.to-m { color: #cfd6e4; margin-top: 2px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }

/* ── (27/09/2026) The tro ly giong noi ──────────────────────────────── */
.vc { position: absolute; left: 50%; bottom: clamp(18px, 5vmin, 34px); transform: translateX(-50%); width: min(640px, calc(100vw - 24px));
  pointer-events: auto; display: flex; align-items: center; gap: clamp(10px, 2.4vmin, 16px); padding: clamp(10px, 2.4vmin, 16px);
  border-radius: calc(var(--r-lg) + 4px); background: rgba(24,28,38,0.96); box-shadow: 0 10px 34px rgba(0,0,0,0.5), inset 0 0 0 1px rgba(255,255,255,0.08); }
.vc.anim { animation: to-in 200ms cubic-bezier(.2,.8,.2,1); }
.vc-ic { flex: none; width: clamp(44px, 11vmin, 64px); height: clamp(44px, 11vmin, 64px); border-radius: 50%; display: flex; align-items: center;
  justify-content: center; background: var(--surface-3); }
.vc-ic .ic { width: 50%; height: 50%; }
.vc[data-s="1"] .vc-ic { background: var(--accent); box-shadow: 0 0 0 6px rgba(59,130,246,0.25); }
.vc[data-s="2"] .vc-ic { background: #7c3aed; }
.vc[data-s="3"] .vc-ic { background: #0d9488; }
.vc[data-s="4"] .vc-ic { background: #dc2626; }
.vc-t { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.vc-l { font-weight: 600; color: var(--muted); font-size: 0.92em; }
.vc-q { font-size: 1.05em; color: #cfd6e4; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.vc-q:empty, .vc-a:empty { display: none; }
.vc-a { font-size: 1.12em; display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }

/* ── Bao thuc ────────────────────────────────────────────────────────── */
.alarm { position: absolute; inset: 0; pointer-events: auto; background: rgba(10,12,18,0.95); display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 3vmin; cursor: pointer; }
.alarm .ic { width: 18vmin; height: 18vmin; color: #f97316; }
.alarm .t1 { font-size: 8vmin; font-weight: 700; }
.alarm .t2 { font-size: 4vmin; color: var(--muted); }
.alarm .btn { margin-top: 3vmin; padding: 2vmin 7vmin; border-radius: 999px; background: #f97316; font-size: 4.5vmin; font-weight: 600; }

/* (27/09/2026 OS-6) Man hinh thap (S3 480x272): bo hang tien ich (dong ho da co o thanh keo xuong) de luoi duoc 2 hang;
   thanh sap xep thu gon, de len vung dem tren cung. */
@media (max-height: 320px) {
  .home { padding-top: calc(var(--pad) + 12px); }
  .home .widgets { display: none; }
  .editbar { top: 4px; }
  .eb-t { display: none; }
  .editbar { justify-content: flex-end; }
  .eb-b { padding: 4px 12px; }
}
/* S3 480x480: dong ho nho lai mot chut de luoi du 3 hang (12 ung dung/trang thay vi 8). */
@media (max-width: 600px) and (min-height: 321px) {
  .w-clock .clock { font-size: 46px; line-height: 1.05; }
  .page { padding-top: 4px; row-gap: 8px; }
  .page .app-ic { width: 48px; height: 48px; }
}
/* (19/10/2026) Thong bao URGENT: phu toan man hinh tren moi ung dung */
.ov { position: fixed; inset: 0; z-index: 2147483000; display: flex; align-items: center; justify-content: center;
      padding: 16px; box-sizing: border-box; background: rgba(0,0,0,0.62); animation: ov-fade 160ms ease-out; }
.ov-card { width: min(760px, 100%); max-height: calc(100vh - 32px); overflow: auto; box-sizing: border-box;
           display: flex; flex-direction: column; gap: clamp(10px, 2vmin, 18px);
           padding: clamp(16px, 4vmin, 32px); border-radius: 18px; background: #1e1e22; color: #fff;
           box-shadow: 0 24px 70px rgba(0,0,0,0.6), inset 0 0 0 2px rgba(239,68,68,0.85); }
.ov-ic { width: clamp(56px, 16vmin, 120px); height: clamp(56px, 16vmin, 120px); }
.ov-t { font-size: clamp(20px, 4.4vmin, 40px); font-weight: 700; line-height: 1.2; }
.ov-m { font-size: clamp(16px, 3.2vmin, 30px); opacity: 0.9; line-height: 1.35; margin-top: 6px; }
.ov-aud { width: 100%; }
.ov-img { width: 100%; max-height: 42vh; object-fit: contain; border-radius: 12px; }
/* (30/10/2026) Thong bao co camera/anh: phu kin man hinh, anh giu dung ti le (khong meo), nen den lap vien. */
.ov-card.media-full { width: 100%; height: 100%; max-height: none; border-radius: 0; padding: 0; box-sizing: border-box;
  display: flex; flex-direction: column; justify-content: center; background: #000; overflow: hidden; }
/* (30/10/2026) Giu CHU tren anh: chi an icon + hang nut; tieu de/noi dung phu o day anh (nen gradient). */
.ov-card.media-full .ov-ic, .ov-card.media-full .ov-act { display: none; }
.ov-card.media-full .ov-txt { position: absolute; left: 0; right: 0; top: 0; padding: clamp(10px, 2.4vmin, 20px);
  background: linear-gradient(to bottom, rgba(0,0,0,0.88), rgba(0,0,0,0)); text-align: left; }
.ov-card.media-full .ov-t { font-size: clamp(14px, 2.6vmin, 22px); color: #bef264; }
.ov-card.media-full .ov-m { font-size: clamp(12px, 2.2vmin, 18px); color: #d9f99d; }
/* (22/11/2026) Camera TOAN MAN: poster (anh tinh) va luong MJPEG phai chong KHIT nhau.
   Loi cu: poster dat absolute inset:0 (kin man) con luong dat relative height:100% -> trong flex column chieu cao
   khong giai ra duoc nen luong ve theo kich thuoc tu nhien = KHUNG NHO de len anh tinh lon (nguoi dung thay "roi").
   Nay CA HAI deu absolute inset:0 + object-fit: contain -> luong thay poster dung vi tri, khong thay doi bo cuc. */
.ov-card.media-full .ov-img { position: absolute !important; inset: 0 !important; width: 100% !important;
  height: 100% !important; max-height: none !important; object-fit: contain !important; border-radius: 0 !important; }
.ov-card.media-full .ov-poster { z-index: 0 !important; }
.ov-card.media-full .ov-img:not(.ov-poster) { z-index: 1 !important; }
.ov-act { display: flex; gap: 12px; justify-content: flex-end; }
.ov-btn { font: inherit; font-size: clamp(15px, 2.8vmin, 24px); padding: 10px 22px; border-radius: 999px; border: 0;
          background: #3b82f6; color: #fff; }
.ov-btn.ghost { background: rgba(255,255,255,0.14); }
@keyframes ov-fade { from { opacity: 0 } to { opacity: 1 } }
`;
