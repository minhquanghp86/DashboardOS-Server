// SPDX-License-Identifier: Apache-2.0 AND MIT
//
// Portions Copyright (c) 2025 strange_v - MIT License (see LICENSE-MIT).
// Modifications Copyright (c) 2026 minhquanghp86 - Apache License 2.0 (see LICENSE).
//
// Derived from strange-v/RemoteWebViewServer. THIS FILE HAS BEEN MODIFIED.

import { CDPSession } from "playwright-core";
import sharp from "sharp";
import { DeviceConfig, deviceConfigsEqual } from "./config.js";
import { getRoot } from "./cdpRoot.js";
import { FrameProcessor } from "./frameProcessor.js";
import { DeviceBroadcaster } from "./broadcaster.js";
import { hash32 } from "./util.js";
import { metrics } from "./metrics.js";
import { AdaptiveState, DEFAULT_ADAPTIVE_CFG, LinkEstimate, decideAdaptive, initialAdaptiveState, updateLinkEstimate } from "./adaptive.js";
import { SelfTestRunner } from "./selfTest.js";
import { tuning } from "./tuning.js";
import { nudgeRepaintAsync } from "./browser.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildLauncherApps, listAllApps, GROUP_TITLES, LOCAL_ORIGIN, LAUNCHER_CAMS_URL, LAUNCHER_OS_HOME_URL, LAUNCHER_TIMER_URL, LAUNCHER_WEATHER_URL } from "./launcherApps.js";
import { createRequire } from "node:module";
import { getWeatherMini, onWeatherMiniUpdate } from "./weatherMini.js";
import { SerialQueue, appKeyForUrl, ghostUrlFor, nowPlaying, parseMeminfo, pickEvictions, pickIdleCloses, recentsList, tabBudget } from "./tabPolicy.js";
import { SCREENSAVER_IDLE_S, SCREENSAVER_PHOTOS, deviceHour, nightNow, shouldShowSaver } from "./screensaver.js";
import { listPhotos } from "./homeApi.js";
import { panelPrefs } from "./panelPrefs.js";
import { Nav, albumItems, caption, photoUrl, refKey, sourceList, step } from "./photoSource.js";
/** Tuy chon addon gphotos_album — mac dinh khi chua dan link o Cai dat. */
const GPHOTOS_ALBUM = process.env.GPHOTOS_ALBUM || '';
import { deviceClock, parseWindow, shouldGreet } from "./today.js";
import { getToday, speakOnPanel } from "./todayData.js";
import { parseDoorbell, unlockCall } from "./doorbell.js";
import { ringtoneExists } from "./ringtone.js";
import type { DialHooks } from "./dial.js";
import { Notice, NoticeStore, NotifyRequest, noticeKind, parseNotify, scaleNoticeMedia, shouldPopup, shouldWake } from "./notifications.js";
import { Sound, soundForNotice, soundPrefs } from "./sound.js";
import { alarms, type Ringing } from "./alarms.js";
import { callService, getRegistry, getSettingsView, getStates, haReady, getStatusIcons, getPowerState } from "./haSettings.js";
import { NetIcon, PowerState, findDeviceByMac, findNoSleepSwitch, findPresenceSelect, isSaverPhotosSwitchId, macFromDeviceId, planCamAuth, planSet, planWifi } from "./settingsModel.js";
import { getLauncherConfig, saveHomeLayout } from "./launcherConfig.js";
import { lockWidgetsFor, refreshLockWidgets } from "./lockWidgets.js";
import { getHaLocation, haLocationCached } from "./haLocation.js";
import { HomeLayout, resolveLayout } from "./homeLayout.js";
import { ControlField, DeviceEventKind, DeviceStateInfo, Encoding, VoiceState, FRAME_HEADER_BYTES, TILE_HEADER_BYTES, parseDeviceStatePacket } from "./protocol.js";
import { tvSwipeKeys, TV_KEY_CODE } from "./gestures.js";

// ── Type-safe interface cho CDP root (thay thế cast `any`) ────────────────────
interface CDPRoot {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  session(sessionId: string): CDPSession;
}

export type DeviceSession = {
  id: string;
  deviceId: string;
  cdp: CDPSession;
  cfg: DeviceConfig;
  url: string;
  lastActive: number;
  frameId: number;
  prevFrameHash: number;
  processor: FrameProcessor;
  selfTestRunner: SelfTestRunner;

  pendingB64?: string;
  /** (27/10/2026) Khung JPEG gan nhat da nhan (dung lam thumbnail 'Gan day', tranh chup CDP). */
  lastFrameB64?: string;
  /** (27/10/2026) Lan cuoi phat hien khung screencast sai kich thuoc -> khoi phuc viewport. */
  vpFixAt?: number;
  throttleTimer?: NodeJS.Timeout;
  lastProcessedMs?: number;
  /** (17/09/2026) han che tan suat log canh bao ap luc nguoc */
  lastBacklogLogMs?: number;
  /**
   * (23/09/2026) KHOA MOT KHUNG MOT LUC.
   *
   * `flushPending` la ham async khong he tu loai tru. Nhip duoc ep bang
   * `lastProcessedMs` — danh moc NGAY KHI BAT DAU (sua loi 17/09) — nhung moc
   * do chi bao dam KHOANG CACH GIUA HAI LAN BAT DAU, khong bao dam lan truoc
   * da xong. Khi nen mot khung ton 146ms ma nhip dieu tiet la 50ms thi cu
   * 50ms lai co them mot flushPending chay CHONG LEN cai dang chay.
   *
   * Do that tren addon 2.9.18 (P4, 571 giay): encodeMsTotal = 629 giay tren
   * uptime 400 giay — hon 100% thoi gian tuong, chi co the giai thich bang
   * chong cheo. Hai hau qua: (1) 2-3 duong ong sharp tranh CPU nen khung nao
   * cung cham hon; (2) `processor._prev` (bang bam tile) bi hai lan chay cung
   * sua -> vi sai tinh sai -> khung rach.
   */
  flushInFlight?: boolean;

  // (17/09/2026) GIA TRI DA DIEU TIET — TACH HAN khoi `cfg`.
  //
  // Truoc day runAdaptiveTick ghi thang vao `device.cfg.minFrameInterval`. Hai
  // hau qua nghiem trong, do duoc tren thiet bi that:
  //   1. `cfg` la ban sao DUY NHAT cua "thiet bi yeu cau gi" (tu tham so URI).
  //      Ghi de no lam deviceConfigsEqual() o ensureDeviceAsync SAI ngay lan noi
  //      lai ke tiep (cfg=400 vs URI=100) -> di nhanh "Reconfiguring" ->
  //      deleteDeviceAsync() -> DUNG LAI CA TARGET CHROMIUM. Tuc la chinh hanh
  //      dong dieu tiet tu bao dam phien thiet bi se bi pha huy khi noi lai.
  //   2. Phien moi lay lai cfg goc (100ms/q70) trong khi adaptiveStates van nho
  //      "da kich san" -> decideAdaptive tra changed=false -> gia tri da ha
  //      KHONG BAO GIO duoc ap lai. Thiet bi chay full tai vinh vien con vong
  //      dieu khien thi tuong minh da ha tai xong.
  // Nay `cfg` bat bien; moi dieu tiet nam o day.
  tunedMinFrameIntervalMs?: number;
  /** (21/10/2026) Nguoi dung dat chat luong JPEG (20..90). Co gia tri -> bo qua bo dieu tiet, dung dung muc nay. */
  qualityOverride?: number;
  /** Muc chat luong da ap dung gan nhat (tranh setTuning lap lai). */
  lastAppliedQuality?: number;

  // (17/09/2026) Thoi diem cuoi cung nhan su kien cham tu thiet bi.
  // Do muot CHI thuc su quan trong khi nguoi dung DANG thao tac — vuot, cuon,
  // bam. Tab camera treo tuong thi 2.5fps khong ai de y. Trong
  // INTERACTION_BOOST_MS sau moi lan cham, bo qua nhip da dieu tiet va chay o
  // nhip GOC (tran fps thiet bi yeu cau), sau do tra ve muc da dieu tiet.
  lastInputMs?: number;

  // Cải tiến: theo dõi lỗi frame liên tiếp để tự phục hồi
  consecutiveFrameErrors: number;

  // (16/09/2026) Đường tắt "chuyển thẳng JPEG của Chrome" — xem flushPending
  recentFrameMs: number[];
  passthroughFrames: number;
  passthroughOn: boolean;

  // (24/09/2026) Khung VIDEO nua do phan giai cho thiet bi bao ?half=1 — xem flushPending.
  halfOn: boolean;
  halfFrames: number;
  /** (30/09/2026) Khung video Chrome hoi vuot tran goi -> nen lai MOT lan ca khung cho vua (xem flushPending). */
  fitFrames?: number;
  /** (30/09/2026) Moc bat dau chuoi khung nhip cao + hen gio tra chat luong screencast ve muc tinh. */
  lowqStreakMs?: number;
  /** So khung LIEN TIEP van qua to du screencast da ha chat luong (trang co video nho giua nhieu chu). */
  lowqBigRun?: number;
  /** Khong thu ha chat luong lai truoc moc nay (sau khi thay khong co ich / doi chat luong loi). */
  lowqBackoffUntil?: number;
  lowqTimer?: NodeJS.Timeout;
  /** Khung di duong thuong (giai nen RGBA + so sanh o + nen tung o). */
  slowFrames?: number;
  /** (30/09/2026) Ly do roi vao duong cham: nhip thap / khung Chrome qua to / sai kich thuoc / lam net. */
  slowWhy?: { fps: number; big: number; dims: number; sharp: number; lastBytes: number; lastW: number; lastH: number };
  /** Anh Chrome cua khung video gan nhat — dung de gui lai ban NET khi video dung. */
  lastVideoB64?: string;
  sharpTimer?: NodeJS.Timeout;
  /** Khung dang xu ly la ban "lam net lai" (khong tinh vao nhip, khong di nhanh video). */
  forceSharp: boolean;
  /** Anh thu nho xam 64x38 cua khung truoc — do ti le dien tich thay doi (nhan dien video). */
  prevThumb?: Buffer;
  /** Lan cuoi mot khung THOA dieu kien video (nhip + dien tich) — de giu che do video mot luc. */
  halfLastQualifyMs?: number;
  /** Moc bat dau chuoi khung LIEN TIEP thoa dieu kien video (chua bat che do) — can keo dai HALF_SUSTAIN_MS. */
  halfStreakStartMs?: number;
  /** Gui NGAY ban net cua khung video cuoi (goi khi nguoi dung cham luc dang o che do video). */
  sharpenNow?: () => void;
  /** Ti le man hinh cua the <video> DANG PHAT lon nhat (hoi Chrome qua CDP, cache) — nhan dien video chac chan. */
  videoElArea?: number;
  /** (30/09/2026) Chieu cao NGUON (videoHeight) cua <video> dang phat lon nhat — cho quy tac nua do phan giai YouTube TV. */
  videoSrcH?: number;
  videoProbeMs?: number;
  videoProbeBusy?: boolean;

  // (23/09/2026 v3) Id cua script launcher da dang ky qua
  // Page.addScriptToEvaluateOnNewDocument — can de GO BO va DANG KY LAI khi
  // homeUrl doi (xem nhanh "equal config" trong ensureDeviceAsync). homeUrl
  // KHONG nam trong deviceConfigsEqual() (co y, xem config.ts) nen doi no
  // khong lam "Reconfiguring"/pha Target — nhung cung vi vay phai tu tay
  // cap nhat script, server khong tu lam lai viec nay.
  /** (25/09/2026) Trang thai thiet bi bao len (DeviceState): do sang, am luong, gio — cho menu va dong ho. */
  devState?: DeviceStateInfo & { receivedAt: number };
  /** (25/09/2026) Hen gio cua menu — giu o SERVER nen van reo khi nguoi dung da chuyen trang. */
  timer?: { endsAt: number; label: string; handle: NodeJS.Timeout };

  // (26/09/2026 OS-2) MOI UNG DUNG LA MOT TAB CHROMIUM RIENG — xem Dashboard OS-Client: docs/server-noi-bo/KE-HOACH-GIAO-DIEN-HE-DIEU-HANH.md muc 3.1.
  // `cdp`/`url` o tren LUON phan anh tab dang ACTIVE (dang hien tren man hinh — chi tab nay duoc Page.startScreencast).
  // Cac tab khac (Home Assistant ghim + toi da MAX_APP_TABS ung dung) van "am": JS chay binh thuong, radio/nhac phat
  // duoc, nhung KHONG duoc gui hinh — chuyen ve chi la doi con tro `cdp` + bat lai screencast, tuc thi, khong tai lai.
  tabs: Map<string, Tab>;
  /** Khoa cua tab dang active trong `tabs` ('' = chua co tab nao — chi dung trong luc ensureDeviceAsync khoi tao). */
  activeTabKey: string;
  /** (26/09/2026) Moi thao tac mo/chuyen tab (openApp, navigateToUrl) chay TUAN TU — xem SerialQueue (tabPolicy.ts). */
  tabOps: SerialQueue;
  /** (30/09/2026) Tab da bi DONG de tiet kiem RAM (nhan roi/qua han muc): van hien trong "Gan day" (anh + URL cu), cham
   * vao = mo lai dung trang do. Nguoi dung tu dong o Gan day thi xoa han. */
  closedRecents?: Map<string, { label: string; thumb?: string; url: string; lastUsed: number }>;
  /** (26/09/2026 OS-5) Lan cham cuoi (moc cho man hinh cho) va man hinh cho dang hien tren tab active hay khong. */
  lastTouchMs: number;
  saverOn: boolean;
  /** (07/10/2026) MAN HINH KHOA: dang khoa (chi vuot len tren Shell moi xoa — tin "unlock"). Bao thuc / chuong cua / thong
   *  bao chi tam hien de len, xong lai khoa ngay. lockDim = da giam sang khi khoa, prev = do sang nguoi dung de tra lai. */
  locked?: boolean;
  lockDim?: { prev: number } | null;
  lockWakeTimer?: ReturnType<typeof setTimeout>;
  /** (01/10/2026) Dang hoi trang co video dang chay khong truoc khi hien man hinh cho. */
  saverProbeBusy?: boolean;
  /** (01/10/2026) Trang thai cong tac HA "Ảnh màn hình chờ" lan dong bo cuoi (undefined = chua thay). */
  photoSwSeen?: boolean;
  /** (27/09/2026) Man hinh cho dang khung anh: anh dang hien + luc doi. */
  saverPhoto?: string | null;
  saverPhotoAt?: number;
  /** (27/09/2026) Lich su anh da xem (vuot trai/phai). */
  saverNav?: Nav;
  /** (27/09/2026) Tro ly giong noi: trang thai cuoi (s = VoiceState) + chu. */
  voice?: { s: number; t: string; at: number };
  /** (27/09/2026) Co nguoi truoc man hinh (camera cua panel). */
  presence?: { on: boolean; at: number };
  /** (30/09/2026) Select "Nguon phat hien nguoi" cua thiet bi (HA) cho thanh trang thai; null = thiet bi khong co. */
  presenceSel?: { id: string; v: string; o: string[]; at: number } | null;
  /** (08/10/2026) Bieu tuong canh dong ho: pin (%) + mang (Wi-Fi vach / Ethernet), doc tu HA moi 30 s. */
  sb?: { nw: NetIcon | null; bt: number | null; ch?: PowerState; pwId?: string; at: number };
  /** (27/09/2026) Ngay (gio thiet bi) da chao buoi sang — moi ngay mot lan. */
  morningDate?: string;
  /** (27/09/2026) Chuong cua dang hien: id lan bam, URL trang, tab dang dung truoc do, hen gio tu dong. */
  /** saver: man dang o man hinh cho / khoa LUC chuong reo -> het chuong hien lai ngay (16/10/2026). */
  doorbell?: { id: string; url: string; prevKey: string; timer: NodeJS.Timeout; unlock: string | null; saver?: boolean };
  /** (27/09/2026) Dien thoai dang truyen YouTube: URL youtube.com/tv (kem pairingCode) + ung dung dang dung truoc do. */
  castUrl?: string;
  /** (30/09/2026) Luc thiet bi NOI LAI gan nhat (phien cu duoc dung lai) — xem navigateToUrl. */
  reconnectedMs?: number;
  /** (30/09/2026) Luc bat dau truyen YouTube TV gan nhat — xem navigateToUrl. */
  castLaunchMs?: number;
  /** (30/09/2026) Lan cuoi thay khung YouTube TV day du QUA TO — giu nua do phan giai 10 s tu moc nay. */
  tvBigMs?: number;
  /** (01/10/2026) P4 (half=1): duong truyen nghen -> khung video nua do phan giai toi moc nay. */
  netHalfUntilMs?: number;
  /** (15/10/2026) Luc bat dau dot khung nua vi nghen hien tai — xem tuning halfGraceMs. */
  netHalfStartMs?: number;
  /** (30/09/2026) Gia tri 'dang phat media' da gui thiet bi gan nhat (ControlField.Media) — undefined = chua gui. */
  mediaSent?: boolean;
  /** (07/10/2026) Lan cuoi hoi trang "lop man hinh cho con khong" (xem screensaverTick — tu lanh). */
  saverCheckAt?: number;
  saverCheckBusy?: boolean;
  /** (30/09/2026) Trang thai man hinh cho da bao thiet bi (ControlField.Saver). */
  saverSent?: number;  // (07/10/2026) 0/1/2 — 2 = man hinh KHOA (xem syncSaver)
  castPrev?: string;
  /**
   * (26/09/2026) Ton dong socket LON NHAT tai cac lan PHAI BO KHUNG vi nghen, ke tu tick dieu tiet truoc. Vong dieu
   * tiet chi doc ton dong DUNG luc tick (5 s/lan) — do that tren P4 (2.9.52, YouTube): bo khung ~5 s/lan lien tuc ma
   * nhip van ket 33 ms, vi luc tick socket vua xa bot. Dua dinh nay vao quyet dinh de no thay nghen that.
   */
  backlogSkipPeak?: number;
};

/** (26/09/2026 OS-2) Mot "ung dung" = mot Chromium target/session rieng cua MOT thiet bi. */
interface Tab {
  /** 'home' (Home Assistant, ghim), '__system' (man hinh chinh /os/home, ghim), 'browser' (URL ngoai HA),
   *  hoac id ung dung tu launcherApps.ts ('cams', 'radio', 'c_xxx'...). */
  key: string;
  kind: string;
  /** Ten hien thi (the "Đang phát" trong thanh trang thai). */
  label: string;
  url: string;
  targetId: string;
  session: CDPSession;
  /** Id script Shell da dang ky qua Page.addScriptToEvaluateOnNewDocument — de go/thay khi homeUrl doi. */
  launcherScriptId?: string;
  /** Khong bao gio bi don don theo MAX_APP_TABS (Home Assistant + man hinh chinh). */
  pinned: boolean;
  screencastOn: boolean;
  /** True neu duoc phep nghe tieng KE CA khi khong active (radio/nhac dang phat nen). */
  backgroundAudio: boolean;
  /** Trang thai am thanh HIEN TAI da gui cho tab nay — xem setTabAudioAllowed. */
  audioAllowed: boolean;
  /** (26/09/2026) Trang tu bao dang phat <audio>/<video> (buildAudioGuardScript -> {media}), reset moi lan dieu huong. */
  mediaPlaying: boolean;
  /** (01/10/2026) Luc ngung phat gan nhat — man hinh cho dem thoi gian ranh tu day (xem shouldShowSaver). */
  mediaStoppedMs?: number;
  /** Trang da bao trang thai phat it nhat mot lan tu lan dieu huong gan nhat (chua bao -> chinh sach don than trong). */
  mediaKnown: boolean;
  lastUsed: number;
  /** (26/09/2026 OS-3) Anh thu nho (data URL JPEG ~320 px) chup luc roi tab — cho man hinh "Gan day". */
  thumb?: string;
  /** (30/09/2026) JavaScript cua tab dang bi tam dung (Debugger.pause, tab nen) — xem freezeTab(). */
  frozen?: boolean;
  /** (30/09/2026) Chat luong JPEG screencast DANG dung cua tab (doi khi phat video — xem videoScreencastQuality). */
  scQuality?: number;
  /** (23/10/2026) Viewport thuc su cua tab (yttv 1920x1080 de youtube.com/tv render day; khac cfg -> resize truoc khi gui). */
  vw?: number;
  vh?: number;
}

// (23/09/2026) SUA LOI: "man ngu tu bat lai nhung khong hien gi, phai vuot
// lan 2" — chi xay ra sau khi da xem camera (che do passthrough) roi Go Home
// ve dashboard tinh, ngu, roi thuc.
//
// Nguyen nhan: flushPending() lay `dev.prevFrameHash` de BO QUA khung TRUNG
// HET VOI KHUNG TRUOC (xem check `if (dev.prevFrameHash === h32) return;`
// ngay dau flushPending, o TREN CA nhanh passthrough lan nhanh thuong). Khung
// "nudge" ma server tu ve khi thiet bi resume() (mot the <div> 2x2px, opacity
// 0.004 doi mau — xem nudgeRepaintAsync) qua nho: sau khi Chrome nen JPEG,
// xac suat cao no round-trip ve BYTE Y HET khung tinh truoc luc ngu -> h32
// TRUNG -> flushPending tra ve SOM, khong bao gio cham toi doan
// requestFullFrame() da dat san -> thiet bi ket "man den" cho toi khi nguoi
// dung tu tay cham that (tao ra thay doi diem anh lon, khong the trung hash).
//
// Sua tan goc: MOI LAN xin full frame, VO HIEU HOA LUON prevFrameHash bang
// gia tri khong bao gio trung that (-1 — hash32() luon >>> 0 nen >= 0). Nho
// vay khung ke tiep, du trung byte tuyet doi voi khung cu, VAN duoc xu ly.
export function requestFullFrameFor(dev: DeviceSession): void {
  dev.processor.requestFullFrame();
  dev.prevFrameHash = -1;
}

/**
 * (30/09/2026) HA CHAT LUONG SCREENCAST KHI PHAT VIDEO. Thiet bi goi nho (P4: 32 KB < 128 KB) truoc day LUON nhan
 * screencast Chrome o SCREENCAST_JPEG_QUALITY (90) — khung video 60-120 KB, khong bao gio vua mot goi -> duong tat
 * khong bao gio chay, 100% khung video di duong cham (giai nen ca khung + so sanh o + nen lai; do 30/09: Node ~120%
 * CPU, /metrics pipeline: 0 khung duong tat). Nay: nhip cao lien tuc >= 1,5 s -> doi screencast sang chat luong
 * thiet bi (Chrome nen san dung muc can -> chuyen thang); het khung nhip cao 1,5 s -> tra ve 90 va ve lai khung net.
 * Tat nong: "videoLowQ": false trong /data/rwv-tuning.json.
 */
/** (27/10/2026) Chat luong JPEG HIEU LUC: nguoi dung dat trong Dashboard UI (rwv.quality) > YAML (cfg.jpegQuality).
 *  Truoc day duong screencast bo qua hoan toan gia tri UI -> dat q40/q50/q60 deu cho khung ~18 KB nhu nhau. */
function effectiveJpegQuality(dev: DeviceSession): number {
  return dev.qualityOverride ?? dev.cfg.jpegQuality;
}

function videoScreencastQuality(dev: DeviceSession, fps: number, nowMs: number): void {
  const tab = dev.tabs.get(dev.activeTabKey);
  if (!tab || !tab.screencastOn || dev.cfg.rotation || PASSTHROUGH_MIN_FPS <= 0) return;
  // (27/10/2026) Nguoi dung dat chat luong -> ap cho MOI khung (ca tinh lan video), khong con nguong 128 KB.
  const effQ = effectiveJpegQuality(dev);
  const base = dev.qualityOverride != null
    ? effQ
    : (dev.cfg.maxBytesPerMessage >= 131072 ? dev.cfg.jpegQuality : SCREENCAST_JPEG_QUALITY);
  const low = effQ;
  if (base === low) {
    // Van phai EP dung muc: screencast co the dang chay o 90 (chat luong khoi tao) du dich la q nguoi dung dat.
    if (tab.scQuality !== base && nowMs >= (dev.lowqBackoffUntil ?? 0)) setScreencastQuality(dev, tab, base, 'chat luong dich');
    return;
  }
  const enabled = tuning().videoLowQ !== false && nowMs >= (dev.lowqBackoffUntil ?? 0);
  if (enabled && fps >= PASSTHROUGH_MIN_FPS) {
    dev.lowqStreakMs ??= nowMs;
    if (nowMs - dev.lowqStreakMs >= 1500 && tab.scQuality !== low) setScreencastQuality(dev, tab, low, `video ${fps.toFixed(0)} fps`);
  } else {
    dev.lowqStreakMs = undefined;
  }
  // Chi GIA HAN hen gio khi con nhip video; khung lai rai nhip thap khong duoc giu chat luong thap mai.
  const videoNow = enabled && fps >= PASSTHROUGH_MIN_FPS;
  if (tab.scQuality !== base && (videoNow || !dev.lowqTimer)) {
    if (dev.lowqTimer) clearTimeout(dev.lowqTimer);
    dev.lowqTimer = setTimeout(() => {
      dev.lowqTimer = undefined;
      dev.lowqStreakMs = undefined;
      if (dev.tabs.get(dev.activeTabKey) === tab && tab.scQuality !== base) {
        setScreencastQuality(dev, tab, base, 'het video');
        requestFullFrameFor(dev);
        nudgeRepaintAsync(dev.cdp).catch(() => { });
      }
    }, enabled ? 1500 : 0);
  }
}

function setScreencastQuality(dev: DeviceSession, tab: Tab, q: number, why: string): void {
  const prevQ = tab.scQuality;
  tab.scQuality = q;
  // Chrome KHONG cho goi lai startScreencast khi dang chay ("Screencast is already active" — do that 30/09) -> dung roi
  // bat lai voi chat luong moi (khung ke tiep den ngay sau khi bat lai). Loi: giu chat luong cu, khong thu lai tung khung.
  (async () => {
    await tab.session.send('Page.stopScreencast');
    if (dev.tabs.get(dev.activeTabKey) !== tab) { tab.screencastOn = false; return; }  // da roi tab trong luc cho
    await tab.session.send('Page.startScreencast', {
      format: 'jpeg', quality: q, maxWidth: dev.cfg.width, maxHeight: dev.cfg.height, everyNthFrame: dev.cfg.everyNthFrame,
    });
    console.log(`[screencast] ${dev.deviceId}: chat luong ${q} (${why})`);
  })().catch((e: unknown) => {
    console.warn(`[screencast] ${dev.deviceId}: doi chat luong ${prevQ} -> ${q} that bai:`, e);
    // Bat lai voi chat luong cu cho chac (neu stop da chay ma start loi, tab se khong con khung nao).
    tab.session.send('Page.startScreencast', {
      format: 'jpeg', quality: prevQ ?? q, maxWidth: dev.cfg.width, maxHeight: dev.cfg.height, everyNthFrame: dev.cfg.everyNthFrame,
    }).catch(() => { });
    tab.scQuality = prevQ;
    dev.lowqBackoffUntil = Date.now() + 60_000;  // tam ngung thu lai 1 phut
  });
}

const PREFERS_REDUCED_MOTION = /^(1|true|yes|on)$/i.test(process.env.PREFERS_REDUCED_MOTION ?? '');
const BROWSER_LOCALE = process.env.BROWSER_LOCALE || 'en-US';

// Cải tiến: giới hạn số device đồng thời, đọc từ env, mặc định 8
const MAX_DEVICES = Math.max(1, parseInt(process.env.MAX_DEVICES ?? '8', 10) || 8);

// Cải tiến: số lỗi frame liên tiếp trước khi tự restart device
const MAX_CONSECUTIVE_FRAME_ERRORS = 10;

// Cải tiến: JPEG quality cho Chrome screencast (giảm tải CPU encode phía server)
// PNG → JPEG: Chrome encode JPEG trực tiếp, bỏ bước sharp decode PNG → raw RGBA
const SCREENCAST_JPEG_QUALITY = Math.min(100, Math.max(1,
  parseInt(process.env.SCREENCAST_JPEG_QUALITY ?? '90', 10) || 90
));
// (16/09/2026) Đường tắt "chuyển thẳng JPEG của Chrome" — xem giải thích đầy đủ
// trong flushPending. Bật khi nhịp screencast đủ cao (nội dung động kiểu video),
// vì khi đó khung nào cũng sẽ là full-frame.
//
// TẮT HẲN tính năng này: đặt PASSTHROUGH_MIN_FPS = 0 (không phải một số rất
// lớn như 99999). Một ngưỡng cực cao chỉ khiến điều kiện chuyển mạch thực tế
// (dòng "fps >= PASSTHROUGH_MIN_FPS" bên dưới) không bao giờ đạt được, nhưng
// `canPassthrough` (dùng để chọn screencastQuality — xem flushPending) vẫn
// coi là true vì nó chỉ kiểm tra "> 0". Kết quả: ảnh vẫn bị encode ở chất
// lượng đích của thiết bị (cfg.jpegQuality) thay vì SCREENCAST_JPEG_QUALITY,
// dù đường tắt không bao giờ thực sự kích hoạt — khác hành vi so với tắt
// thật bằng 0. (Phát hiện khi debug sống trên addon 17/09/2026.)
const PASSTHROUGH_MIN_FPS = Math.max(0, parseFloat(process.env.PASSTHROUGH_MIN_FPS ?? '8') || 0);
const PASSTHROUGH_RATE_WINDOW = 6; // số khung gần nhất dùng để tính nhịp
// (24/09/2026) Video dung bao lau (khong co khung moi) thi gui lai khung cuoi o do phan giai day du.
const SHARP_REFRESH_MS = Math.max(100, parseInt(process.env.SHARP_REFRESH_MS ?? '700', 10) || 700);
// (24/09/2026) 5/3 -> 2,5/1,5: tieu chi video THAT la dien tich thay doi (ben duoi); nhip chi de loai trang tinh.
// Do that: sau khi thiet bi khoi dong lai, server bat dau o nhip than trong 200-275 ms (< 4 fps) -> khong bao
// gio dat 5 fps -> khong vao che do video -> thiet bi xu ly cham -> nhip khong tang (vong luan quan).
const HALF_ON_FPS = Math.max(0.5, parseFloat(process.env.HALF_ON_FPS ?? '2.5') || 2.5);
const HALF_OFF_FPS = Math.max(0.5, parseFloat(process.env.HALF_OFF_FPS ?? '1.5') || 1.5);
// Ti le dien tich man hinh thay doi giua hai khung: > HALF_ON_AREA moi coi la video; dang o che do video thi
// giu toi khi <= HALF_KEEP_AREA.
const HALF_ON_AREA = 0.35;
const HALF_KEEP_AREA = 0.2;
// (24/09/2026 toi) Dien tich thay doi KHONG du tin cay: trang xem YouTube 1024x600, khung video chi ~39% man hinh,
// giua 2 khung lien tiep chi 0-22% diem anh doi ro (canh san khau cham), cong don 1 s cung chi 3-39% -> video test
// khong bao gio vao che do nua. Hoi thang Chrome: co the <video> DANG PHAT chiem >= HALF_VIDEO_EL_AREA man hinh
// thi la video. Anh dong/GIF tren dashboard khong phai <video> nen van net. Dien tich giu lai cho video trong iframe.
const HALF_VIDEO_EL_AREA = 0.2;
const VIDEO_PROBE_MS = 500;
const VIDEO_PROBE_JS = `(() => {
  const W = innerWidth, H = innerHeight; let best = 0, srcH = 0;
  for (const v of document.querySelectorAll('video')) {
    if (v.paused || v.ended || v.readyState < 3) continue;
    const r = v.getBoundingClientRect();
    const w = Math.max(0, Math.min(r.right, W) - Math.max(r.left, 0));
    const h = Math.max(0, Math.min(r.bottom, H) - Math.max(r.top, 0));
    const a = (w * h) / (W * H);
    if (a > best) { best = a; srcH = v.videoHeight || 0; }
  }
  return { a: best, h: srcH };
})()`;
// (30/09/2026) Ngoai le cho quy tac "du do phan giai" (25/09): tab YOUTUBE TV phat TOAN MAN HINH, nguon thuong chi
// 240-360p -> gui khung NUA do phan giai (P4 phong x2 bang PPA) gan nhu khong mat chi tiet ma bot ~4 lan du lieu.
// Do that 30/09 khi truyen tu dien thoai: 22,6 khung/s, ~9 lan nen lai/giay (khung vuot tran 32 KB), CPU addon ~285%.
// Nguoi dung dong y 30/09. Nguon cao hon nguong -> van du do phan giai. YT_TV_HALF_MAX_H=0 de tat.
const YT_TV_HALF_MAX_H = Math.max(0, parseInt(process.env.YT_TV_HALF_MAX_H ?? '360', 10) || 0);
// (25/09/2026) Nguoi dung chon DU DO PHAN GIAI (do net cao) -> mac dinh KHONG gui khung video 1/2 nua, ke ca khi
// thiet bi bao ?half=1 (firmware P4 van bat half_scale_video vi ly do khac — xem YAML). Bat lai: HALF_SCALE_VIDEO=1.
const HALF_SCALE_VIDEO = process.env.HALF_SCALE_VIDEO === '1';
// (01/10/2026) Giu khung nua bao lau sau lan nghen cuoi (P4). 0 = tat tinh nang.
// (15/10/2026) 15 -> 60 s + an han 8 s (HALF_GRACE_MS): A/B xen ke 3+3 luot YouTube toan man 150 s tren P4 cap — A (15 s,
// khong an han) 8/3/0 mau < 22 fps, thap nhat 16-19 fps; B 0/0/0, thap nhat 28-30 fps (ngoai quang cao).
const NET_HALF_HOLD_MS = Math.max(0, parseInt(process.env.NET_HALF_HOLD_MS ?? '60000', 10) || 0);
const HALF_GRACE_MS = Math.max(0, parseInt(process.env.HALF_GRACE_MS ?? '8000', 10) || 0);
const HALF_HOLD_MS = Math.max(0, parseInt(process.env.HALF_HOLD_MS ?? '3000', 10) || 3000);
// Thay doi lon phai keo dai lien tuc bao lau moi coi la video (loai hieu ung chuyen tab).
const HALF_SUSTAIN_MS = Math.max(0, parseInt(process.env.HALF_SUSTAIN_MS ?? '1000', 10) || 1000);
// Sau moi lan cham man hinh, bao lau KHONG dung nua do phan giai.
const HALF_AFTER_TOUCH_MS = Math.max(0, parseInt(process.env.HALF_AFTER_TOUCH_MS ?? '2000', 10) || 2000);

// (17/09/2026) Ngưỡng áp lực ngược: số byte còn kẹt trong bộ đệm gửi của
// WebSocket mà trên mức đó thì BỎ khung mới thay vì dồn thêm. Một full-frame
// 1024x600 ở quality 70 vào khoảng 100-150KB, nên 192KB ~ "đang nợ hơn một
// khung" — đủ rộng để không phản ứng thái quá với biến động bình thường.
// (17/09/2026) Cua so "dang thao tac" sau moi su kien cham.
const INTERACTION_BOOST_MS = Math.max(0,
  parseInt(process.env.CCR_INTERACTION_BOOST_MS ?? '2000', 10) || 0
);

// (17/09/2026) KHOI DONG THAN TRONG.
//
// Tu khi min_frame_interval doi vai tro thanh "TRAN fps mong muon" (33ms =
// 30fps), moi lan thiet bi HOAC server khoi dong lai deu bat dau o ngay tran do
// va doi 30fps cho toi khi vong dieu tiet keo xuong (~55 giay). Trong khoang do
// loopTask cua ESPHome bi doi, thiet bi khong phuc vu noi API -> ket noi HA don
// day 10 khe max_connections -> thiet bi "mat tich" tren HASS. Da xay ra that.
//
// Nguyen tac: BAT DAU CHAM, TU KIEM CHUNG ROI MOI NHANH LEN. Phien moi khoi dau
// o muc an toan nay; nhanh hoi phuc (LIFO) se rut dan ve tran ma thiet bi yeu
// cau khi no chung minh duoc la theo kip.
const SAFE_START_INTERVAL_MS = Math.max(0,
  parseInt(process.env.CCR_SAFE_START_MS ?? '200', 10) || 0
);

const WS_HIGH_WATER_BYTES = Math.max(
  16_384,
  parseInt(process.env.CCR_WS_HIGH_WATER ?? '196608', 10) || 196608
);

const devices = new Map<string, DeviceSession>();
let _cleanupRunning = false;
let _codecVerified = false;
export const broadcaster = new DeviceBroadcaster();

// ============================================================
// Keyboard + Telex IME — embedded as TS template literal.
// Rules: no backticks inside JS, CSS uses string concat,
//        backslash chars use \\u005C unicode escape.
//
// Cải tiến:
//   - Thay window.__vkb* global bằng closure-private _shield object
//     → tránh xung đột với script khác trong trang HA
//   - Thay document.execCommand (deprecated) bằng Selection/Range API
//     cho insertText và delete trong contentEditable
//   - Cải thiện tonePos() để xử lý đúng vị trí thanh cho các vần
//     có nhiều nguyên âm liên tiếp (uyên, oai, uya, ươi...)
//     theo quy tắc: ưu tiên nguyên âm "chính" (vị trí âm tiết chuẩn)
// ============================================================
const KIOSK_KEYBOARD_SCRIPT = `(function(){
  var VKB_WIDTH  = '100%';
  // (25/10/2026) Man thap (480x272) ma de 196px thi ban phim chiem 72% chieu cao man.
  // Lay min(196px, 50vh): man >= 392px cao giu nguyen 196px, man 272px con 136px.
  var VKB_HEIGHT = 'min(196px, 62vh)';
  if (window.__kioskKeyboardInitialized) return;
  window.__kioskKeyboardInitialized = true;

  // Cải tiến: dùng closure-private object thay vì window.__vkb* globals
  var _shield = { closing: 0, opening: 0, lastTap: 0, outsideAt: 0 };

  var keyboardContainer = null;
  var currentLayout    = 'default';
  var activeInput      = null;
  var isShifted        = false;
  var isVietnamese     = false;
  var telexWord        = '';
  var commitOnEnterOnly = true;

  function commitInput(){
    if(!activeInput) return;
    activeInput.dispatchEvent(new Event('input',{bubbles:true,composed:true}));
    activeInput.dispatchEvent(new Event('change',{bubbles:true,composed:true}));
    console.log('[VKB] Commit input');
  }

  var layouts = {
    default: [
      ['q','w','e','r','t','y','u','i','o','p'],
      ['a','s','d','f','g','h','j','k','l'],
      ['\\u21E7','z','x','c','v','b','n','m','\\u232B'],
      ['\\u25BC','?123','VN','\\u25C4','Space','\\u25BA','.','\\u23CE']
    ],
    shift: [
      ['Q','W','E','R','T','Y','U','I','O','P'],
      ['A','S','D','F','G','H','J','K','L'],
      ['\\u21E7','Z','X','C','V','B','N','M','\\u232B'],
      ['\\u25BC','?123','VN','\\u25C4','Space','\\u25BA','.','\\u23CE']
    ],
    symbols: [
      ['1','2','3','4','5','6','7','8','9','0'],
      ['@','#','$','%','&','*','-','+','(',')'],
      ['ABC','!','"',"'",':', ';','/','?','\\u232B'],
      ['\\u25BC','=\\u005C<',',','\\u25C4','Space','\\u25BA','.','\\u23CE']
    ],
    extended: [
      ['~','|','^','_','=','{','}','[',']','\\u2713'],
      ['<','>','\\u00A3','\\u20AC','\\u00A2','\\u00B0','\\u00B1','\\u00F7','\\u00D7','\\u005C'],
      ['?123','\\u21B9','\\u00A9','\\u00AE','\\u2122','\\u00BF','\\u00A1','\\u00A7','\\u232B'],
      ['\\u25BC','ABC',',','\\u25C4','Space','\\u25BA','.','\\u23CE']
    ]
  };

  /* ---- Telex engine ----------------------------------------
     tone index: 0=flat 1=sac 2=huyen 3=hoi 4=nga 5=nang      */
  var TONE_KEYS = {s:1, f:2, r:3, x:4, j:5, z:0};

  var TONE_MAP = {
    'a'        :['a',        '\\u00E1','\\u00E0','\\u1EA3','\\u00E3','\\u1EA1'],
    '\\u0103'  :['\\u0103',  '\\u1EAF','\\u1EB1','\\u1EB3','\\u1EB5','\\u1EB7'],
    '\\u00E2'  :['\\u00E2',  '\\u1EA5','\\u1EA7','\\u1EA9','\\u1EAB','\\u1EAD'],
    'e'        :['e',        '\\u00E9','\\u00E8','\\u1EBB','\\u1EBD','\\u1EB9'],
    '\\u00EA'  :['\\u00EA',  '\\u1EBF','\\u1EC1','\\u1EC3','\\u1EC5','\\u1EC7'],
    'i'        :['i',        '\\u00ED','\\u00EC','\\u1EC9','\\u0129','\\u1ECB'],
    'o'        :['o',        '\\u00F3','\\u00F2','\\u1ECF','\\u00F5','\\u1ECD'],
    '\\u00F4'  :['\\u00F4',  '\\u1ED1','\\u1ED3','\\u1ED5','\\u1ED7','\\u1ED9'],
    '\\u01A1'  :['\\u01A1',  '\\u1EDB','\\u1EDD','\\u1EDF','\\u1EE1','\\u1EE3'],
    'u'        :['u',        '\\u00FA','\\u00F9','\\u1EE7','\\u0169','\\u1EE5'],
    '\\u01B0'  :['\\u01B0',  '\\u1EE9','\\u1EEB','\\u1EED','\\u1EEF','\\u1EF1'],
    'y'        :['y',        '\\u00FD','\\u1EF3','\\u1EF7','\\u1EF9','\\u1EF5']
  };

  var VI = {};
  (function(){
    for (var b in TONE_MAP) {
      var a = TONE_MAP[b];
      for (var t = 0; t < a.length; t++) VI[a[t]] = {b:b, t:t};
    }
  })();

  function vi(c) { return VI[c] || null; }

  function modVowel(oldCh, newBase) {
    var v = vi(oldCh);
    var t = v ? v.t : 0;
    return TONE_MAP[newBase] ? TONE_MAP[newBase][t] : newBase;
  }

  function strip(word) {
    var t=0, w='';
    for (var i=0; i<word.length; i++) {
      var v=vi(word[i]);
      if(v){ if(v.t>0) t=v.t; w+=v.b; } else w+=word[i];
    }
    return {w:w, t:t};
  }

  // Cải tiến: tonePos() theo quy tắc vị trí thanh chuẩn tiếng Việt
  // Ưu tiên: â,ê,ô,ơ,ư,ă (nguyên âm có dấu phụ) trước a,e,i,o,u,y
  // Với vần có nhiều nguyên âm: ưu tiên nguyên âm đứng trước âm cuối
  // Ví dụ: uyên → đặt thanh vào ê; uya → đặt vào y; ươi → đặt vào ơ
  var VOWEL_PRIORITY = {
    '\\u00E2':2,'\\u00EA':2,'\\u00F4':2,
    '\\u01A1':2,'\\u01B0':2,'\\u0103':2,
    'a':1,'e':1,'i':1,'o':1,'u':1,'y':1
  };

  function tonePos(word) {
    // Tìm tất cả vị trí nguyên âm
    var vowelPositions = [];
    for (var i=0; i<word.length; i++) {
      var v = vi(word[i]);
      var base = v ? v.b : word[i];
      if (VOWEL_PRIORITY[base] !== undefined) {
        vowelPositions.push({ idx: i, base: base, pri: VOWEL_PRIORITY[base] });
      }
    }
    if (vowelPositions.length === 0) return -1;
    if (vowelPositions.length === 1) return vowelPositions[0].idx;

    // Nếu có nguyên âm có dấu phụ (priority 2), ưu tiên nó
    var high = vowelPositions.filter(function(p){ return p.pri === 2; });
    if (high.length > 0) return high[0].idx;

    // Với vần thuần (a/e/i/o/u/y): áp dụng quy tắc âm tiết mở/đóng
    // Nếu nguyên âm cuối KHÔNG có phụ âm sau → đặt thanh ở nguyên âm cuối nhóm
    // Nếu có phụ âm cuối (âm tiết đóng) → đặt thanh ở nguyên âm đầu nhóm
    var lastVowelIdx = vowelPositions[vowelPositions.length - 1].idx;
    var hasConsonantAfter = lastVowelIdx < word.length - 1;
    if (hasConsonantAfter) {
      // Âm tiết đóng: đặt ở nguyên âm đầu nhóm
      return vowelPositions[0].idx;
    } else {
      // Âm tiết mở: đặt ở nguyên âm kế cuối nếu có 2+ nguyên âm, cuối nếu chỉ có 1
      if (vowelPositions.length >= 2) {
        return vowelPositions[vowelPositions.length - 2].idx;
      }
      return vowelPositions[vowelPositions.length - 1].idx;
    }
  }

  function telex(word, key) {
    var last  = word.length > 0 ? word[word.length-1] : '';
    var lv    = vi(last);
    var lBase = lv ? lv.b : last;

    if (key in TONE_KEYS) {
      var newT = TONE_KEYS[key];
      var s = strip(word);
      var pos = tonePos(s.w);
      if (pos < 0) return null;
      var applyT = (s.t === newT) ? 0 : newT;
      var vb = vi(s.w[pos]) ? vi(s.w[pos]).b : s.w[pos];
      var nc = TONE_MAP[vb] ? TONE_MAP[vb][applyT] : s.w[pos];
      return s.w.slice(0,pos) + nc + s.w.slice(pos+1);
    }

    if (key === 'd') {
      if (last === 'd')        return word.slice(0,-1) + '\\u0111';
      if (last === '\\u0111')  return word.slice(0,-1) + 'd';
      return null;
    }

    if (key === 'a' && lBase === 'a') {
      return word.slice(0,-1) + modVowel(last, (lv && lv.b==='\\u00E2') ? 'a' : '\\u00E2');
    }
    if (key === 'e' && lBase === 'e') {
      return word.slice(0,-1) + modVowel(last, (lv && lv.b==='\\u00EA') ? 'e' : '\\u00EA');
    }
    if (key === 'o' && lBase === 'o') {
      return word.slice(0,-1) + modVowel(last, (lv && lv.b==='\\u00F4') ? 'o' : '\\u00F4');
    }

    if (key === 'w') {
      if (word.length>=2 && lBase==='o') {
        var prev=word[word.length-2]; var pv=vi(prev);
        if (pv && pv.b==='u') return word.slice(0,-2) + modVowel(prev,'\\u01B0') + last;
      }
      if (lBase==='a')       return word.slice(0,-1)+modVowel(last,'\\u0103');
      if (lBase==='\\u0103') return word.slice(0,-1)+modVowel(last,'a');
      if (lBase==='o')       return word.slice(0,-1)+modVowel(last,'\\u01A1');
      if (lBase==='\\u01A1') return word.slice(0,-1)+modVowel(last,'o');
      if (lBase==='u')       return word.slice(0,-1)+modVowel(last,'\\u01B0');
      if (lBase==='\\u01B0') return word.slice(0,-1)+modVowel(last,'u');
      return null;
    }

    return null;
  }

  // Cải tiến: telexReplace dùng Selection/Range API thay execCommand (deprecated)
  function insertTextModern(el, text) {
    if (el.isContentEditable) {
      var sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      var range = sel.getRangeAt(0);
      range.deleteContents();
      var node = document.createTextNode(text);
      range.insertNode(node);
      range.setStartAfter(node);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    } else {
      var val=el.value||'', s=el.selectionStart||0, e=el.selectionEnd||0;
      el.value=val.slice(0,s)+text+val.slice(e);
      el.selectionStart=el.selectionEnd=s+text.length;
    }
  }

  function deleteCharModern(el) {
    if (el.isContentEditable) {
      var sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      var range = sel.getRangeAt(0);
      if (!range.collapsed) {
        range.deleteContents();
      } else if (range.startOffset > 0) {
        range.setStart(range.startContainer, range.startOffset - 1);
        range.deleteContents();
      }
    } else {
      var val2=el.value||'', s2=el.selectionStart||0, e2=el.selectionEnd||0;
      if(s2===e2&&s2>0){ el.value=val2.slice(0,s2-1)+val2.slice(e2); el.selectionStart=el.selectionEnd=s2-1; }
      else if(s2!==e2){ el.value=val2.slice(0,s2)+val2.slice(e2); el.selectionStart=el.selectionEnd=s2; }
    }
  }

  function telexReplace(newWord) {
    if (!activeInput) return;
    var dc = telexWord.length;
    if (activeInput.isContentEditable) {
      // Cải tiến: dùng Selection/Range thay execCommand
      var sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        var range = sel.getRangeAt(0);
        // Xóa dc ký tự trước cursor
        for (var i=0; i<dc; i++) {
          if (range.startOffset > 0) {
            range.setStart(range.startContainer, range.startOffset - 1);
            range.deleteContents();
          }
        }
        var node = document.createTextNode(newWord);
        range.insertNode(node);
        range.setStartAfter(node);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    } else {
      var val=activeInput.value||'', pos=activeInput.selectionStart||0;
      var from=Math.max(0,pos-dc);
      activeInput.value=val.slice(0,from)+newWord+val.slice(pos);
      activeInput.selectionStart=activeInput.selectionEnd=from+newWord.length;
    }
    telexWord=newWord;
  }

  function resetTelex(){ telexWord=''; }

  /* ---- DOM ------------------------------------------------- */
  function ensureDOM() {
    if(!document.body||!document.head) return false;
    if(!document.getElementById('kiosk-vkb-style')){
      var st=document.createElement('style');
      st.id='kiosk-vkb-style';
      st.textContent=
        '#kiosk-vkb-container{position:fixed !important;top:auto !important;bottom:-200vh !important;box-sizing:border-box !important;padding-bottom:env(safe-area-inset-bottom,0px) !important;max-height:100% !important;'+
        'left:0 !important;right:0 !important;margin:0 auto !important;'+
        'width:'+VKB_WIDTH+' !important;height:'+VKB_HEIGHT+' !important;'+
        'container-type:size;background:linear-gradient(180deg,rgba(72,79,92,.70),rgba(50,56,66,.78));'+
        'backdrop-filter:blur(14px) saturate(130%);-webkit-backdrop-filter:blur(14px) saturate(130%);'+
        'border-top:1px solid rgba(255,255,255,.10);z-index:2147483647;'+
        'box-shadow:0 -8px 26px rgba(0,0,0,.40);'+
        'display:flex;flex-direction:column;padding:6px;box-sizing:border-box;'+
        'user-select:none;-webkit-user-select:none;font-family:sans-serif;touch-action:manipulation;border:none;}'+
        '#kiosk-vkb-container:popover-open{display:flex;}'+
        '#kiosk-vkb-container.vkb-visible{bottom:0 !important;}'+
        '@media (orientation:landscape){#kiosk-vkb-container{height:min(300px,56vh) !important;}.vkb-row{gap:clamp(2px,0.5vmin,5px) !important;margin-bottom:0 !important;}.vkb-key{font-size:clamp(18px,3.9vh,32px) !important;line-height:1 !important;}}'+
        '.vkb-row{display:flex;justify-content:center;margin-bottom:0;width:100%;gap:clamp(3px,0.8vmin,6px);flex:1 1 0;min-height:0;}'+
        '.vkb-row:last-child{margin-bottom:0;}'+
        // (25/10/2026) Nen sang hon, phim BO GOC (10px) thay vi 2px, them do noi + hieu ung nhan phim.
        // (25/10/2026) Nen SANG + BAN TRONG SUOT (kinh mo): phim sang, vien sang mong,
        // backdrop-filter lam noi dung phia sau mo di nhung chu van doc duoc.
        '.vkb-key{flex:1 1 0;min-width:0;box-sizing:border-box;background:rgba(126,136,152,.45);color:#f7f9fc;border:none;border-radius:10px;'+
        'font-size:11.5cqh;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;'+
        'box-shadow:0 2px 0 rgba(0,0,0,.28),inset 0 1px 0 rgba(255,255,255,.22);'+
        'text-shadow:0 1px 2px rgba(0,0,0,.35);'+
        'transition:transform .07s ease,filter .1s ease,box-shadow .07s ease;'+
        'will-change:transform;-webkit-tap-highlight-color:transparent;}'+
        '.vkb-key:active,.vkb-key.vkb-pressed{transform:translateY(2px) scale(.95);filter:brightness(1.55);'+
        'background:rgba(168,178,194,.62);'+
        'box-shadow:0 0 0 rgba(0,0,0,0),inset 0 2px 7px rgba(0,0,0,.45);}'+
        '.vkb-key-layout{background:rgba(96,138,178,.50);color:#eef4fb;font-size:9cqh;}'+
        '.vkb-key-special{background:rgba(104,146,120,.50);color:#eef4fb;font-size:11cqh;}'+
        '.vkb-key-large-icon{font-size:15cqh;}'+
        '.vkb-key-backspace{font-size:18cqh;}'+
        '.vkb-key-hide{background:rgba(196,104,104,.52);color:#fdf0f0;font-size:12.5cqh;}'+
        '.vkb-key-enter{background:rgba(233,84,32,.82);color:#fff;font-size:12.5cqh;'+
        'box-shadow:0 2px 0 rgba(150,52,16,.85),inset 0 1px 0 rgba(255,255,255,.25);}'+
        '.vkb-key-space{flex:3;}.vkb-key-arrow{flex:0.8;}'+
        '.vkb-key-vn{font-size:8.5cqh !important;}'+
        '.vkb-key-vn-on{background:rgba(60,152,74,.62) !important;color:#e6ffe9 !important;}'+
        // (25/10/2026) che do hep cho man doc: phim rong hon, bo goc nho hon
        '#kiosk-vkb-container.vkb-narrow{padding:4px;}'+
        '#kiosk-vkb-container.vkb-narrow .vkb-row{gap:3px;margin-bottom:4px;}'+
        '#kiosk-vkb-container.vkb-narrow .vkb-key{border-radius:7px;}'+
        '#kiosk-vkb-container.vkb-narrow .vkb-key-space{flex:2.6;}'+
        '#kiosk-vkb-container.vkb-narrow .vkb-key-arrow{flex:0.7;}';
      document.head.appendChild(st);
    }
    if(!keyboardContainer){
      keyboardContainer=document.createElement('div');
      keyboardContainer.id='kiosk-vkb-container';
      if(keyboardContainer.popover!==undefined) keyboardContainer.popover='manual';
      renderKeyboard();
    }
    if(!document.body.contains(keyboardContainer)) document.body.appendChild(keyboardContainer);
    return true;
  }

  function renderKeyboard(){
    if(!keyboardContainer) return;
    // Khong dung innerHTML='' — trang co Trusted Types CSP (vd accounts.google.com)
    // chan thang tay gan chuoi vao innerHTML, nem TypeError va lam crash showKeyboard()
    // giua chung (truoc khi kip them class vkb-visible) -> ban phim khong bao gio hien.
    while(keyboardContainer.firstChild) keyboardContainer.removeChild(keyboardContainer.firstChild);
    layouts[currentLayout].forEach(function(row){
      var rd=document.createElement('div');
      rd.className='vkb-row';
      row.forEach(function(key){
        var btn=document.createElement('button');
        btn.className='vkb-key';
        btn.textContent=(key==='Space')?'':key;
        btn.dataset.key=key;
        if(['?123','ABC','=\\u005C<'].includes(key)) btn.classList.add('vkb-key-layout');
        if(['\\u21E7','\\u232B','\\u25C4','\\u25BA','\\u21B9'].includes(key)) btn.classList.add('vkb-key-special');
        if(['\\u21E7','\\u21B9'].includes(key)) btn.classList.add('vkb-key-large-icon');
        if(key==='\\u232B') btn.classList.add('vkb-key-backspace');
        if(key==='\\u25BC') btn.classList.add('vkb-key-hide');
        if(key==='Space')   btn.classList.add('vkb-key-space');
        if(key==='\\u25C4'||key==='\\u25BA') btn.classList.add('vkb-key-arrow');
        if(key==='\\u23CE') btn.classList.add('vkb-key-enter');
        if(key==='\\u21E7'&&isShifted){btn.style.background='#e2e8f0';btn.style.color='#121212';}
        if(key==='VN'){
          btn.classList.add('vkb-key-layout','vkb-key-vn');
          btn.textContent=isVietnamese?'VN\\u2713':'VN';
          if(isVietnamese) btn.classList.add('vkb-key-vn-on');
        }
        rd.appendChild(btn);
      });
      keyboardContainer.appendChild(rd);
    });
  }

  /* ---- Text insertion -------------------------------------- */
  function insertText(text){
    if(!activeInput) return;
    insertTextModern(activeInput, text);
  }

  /* ---- Process key ----------------------------------------- */
  function processKey(key){
    if(!activeInput) return;
    if(typeof activeInput.focus==='function') activeInput.focus();

    switch(key){
      case '\\u25BC': hideKeyboard(); resetTelex(); break;

      case '\\u21E7':
        isShifted=!isShifted; currentLayout=isShifted?'shift':'default'; renderKeyboard(); break;

      case 'VN':
        isVietnamese=!isVietnamese; resetTelex(); renderKeyboard(); break;

      case '?123':
        currentLayout='symbols'; isShifted=false; resetTelex(); renderKeyboard(); break;
      case 'ABC':
        currentLayout='default'; isShifted=false; resetTelex(); renderKeyboard(); break;
      case '=\\u005C<':
        currentLayout='extended'; isShifted=false; resetTelex(); renderKeyboard(); break;

      case '\\u21B9': insertText('\\t'); resetTelex(); break;

      case '\\u232B':
        // Cải tiến: dùng deleteCharModern thay execCommand
        deleteCharModern(activeInput);
        if(telexWord.length>0) telexWord=telexWord.slice(0,-1);
        break;

      case 'Space': insertText(' '); resetTelex(); break;

      case '\\u25C4':
        if(!activeInput.isContentEditable){ var s3=activeInput.selectionStart||0; if(s3>0) activeInput.selectionStart=activeInput.selectionEnd=s3-1; }
        resetTelex(); break;

      case '\\u25BA':
        if(!activeInput.isContentEditable){ var e3=activeInput.selectionEnd||0; if(e3<(activeInput.value||'').length) activeInput.selectionStart=activeInput.selectionEnd=e3+1; }
        resetTelex(); break;

      case '\\u23CE':
        if(activeInput.isContentEditable){
          // Cải tiến: dùng insertParagraph qua execCommand chỉ ở đây vì không có API tương đương
          // (insertParagraph vẫn còn được support tốt trong Chrome)
          document.execCommand('insertParagraph',false,null);
          activeInput.dispatchEvent(new Event('input',{bubbles:true,composed:true}));
        } else if(activeInput.tagName==='TEXTAREA'){
          insertText('\\n');
        } else {
          var ev={key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true,composed:true,cancelable:true};
          activeInput.dispatchEvent(new KeyboardEvent('keydown',ev));
          activeInput.dispatchEvent(new KeyboardEvent('keypress',ev));
          activeInput.dispatchEvent(new KeyboardEvent('keyup',ev));
        }

        // ✅ CHỈ COMMIT Ở ĐÂY
        if (commitOnEnterOnly) {
          commitInput();
        }

        hideKeyboard();
        resetTelex();
        break;

      default:
        if(!key) break;
        var isLetter=/^[a-zA-Z]$/.test(key);
        if(isVietnamese&&(currentLayout==='default'||currentLayout==='shift')&&isLetter){
          var lk=key.toLowerCase();
          var nw=telex(telexWord,lk);
          if(nw!==null){ telexReplace(nw); }
          else { insertText(key); telexWord+=lk; }
        } else {
          if(!isLetter) resetTelex();
          insertText(key);
        }
        if(isShifted&&isLetter){ isShifted=false; currentLayout='default'; renderKeyboard(); }
        break;
    }

    // ❌ KHÔNG gửi event mỗi phím nữa
    if (!commitOnEnterOnly && key!=='\\u23CE'&&key!=='\\u25BC'){
      activeInput.dispatchEvent(new Event('input',{bubbles:true,composed:true}));
      activeInput.dispatchEvent(new Event('change',{bubbles:true,composed:true}));
    }
  }

  /* ---- Show / Hide ----------------------------------------- */
  // (25/10/2026) Man DOC (panel xoay 90/270, vd S3 480x272 -> 272x480) chi con 272px ngang:
  // 10 phim/ hang voi gap 6px thi moi phim chi ~21px. Che do "hep" giam gap/padding de
  // phim rong hon (~24px) va bo goc nho lai cho can doi.
  function applyResponsive(){
    if(!keyboardContainer) return;
    var w = window.innerWidth || 0;
    keyboardContainer.classList.toggle('vkb-narrow', w > 0 && w < 380);
  }

  function showKeyboard(el){
    activeInput=el; renderKeyboard(); applyResponsive();
    // Cải tiến: dùng _shield thay window.__vkbOpeningShield
    _shield.opening=Date.now();
    if(keyboardContainer.showPopover){
      if(keyboardContainer.matches(':popover-open')) keyboardContainer.hidePopover();
      keyboardContainer.showPopover();
    }
    keyboardContainer.classList.add('vkb-visible');
    if(activeInput&&activeInput.scrollIntoView) activeInput.scrollIntoView({behavior:'auto',block:'center'});
  }

  // (01/10/2026) outsideTap = cham RA NGOAI ban phim (khong phai nut an/Enter). Truoc day moi lan an deu bat tam chan
  // 400 ms (chan ca mousedown/mouseup/click cua CHINH cu cham do) va blur o nhap NGAY -> cu cham dau tien sau khi go chu
  // luon mat: bam dong goi y tim kiem YouTube khong an (nguoi dung bao 01/10), YouTube dong danh sach goi y vi o nhap mat
  // focus. Cham ngoai: khong tam chan, blur sau 350 ms (click da toi dong goi y). Nut an/Enter van chan nhu cu (cu cham
  // khong lot xuong trang ben duoi ban phim vua bien mat).
  function hideKeyboard(outsideTap){
    if(!outsideTap) _shield.closing=Date.now(); else _shield.outsideAt=Date.now();
    if(keyboardContainer){
      keyboardContainer.classList.remove('vkb-visible');
      if(keyboardContainer.hidePopover&&keyboardContainer.matches(':popover-open')) keyboardContainer.hidePopover();
    }
    var el=activeInput;
    if(el&&el.blur){
      if(outsideTap) setTimeout(function(){
        var vis=keyboardContainer&&keyboardContainer.classList.contains('vkb-visible');
        if(!vis&&document.activeElement===el) el.blur();
      },350);
      else el.blur();
    }
    activeInput=null; isShifted=false; currentLayout='default';
  }

  /* ---- Input resolver -------------------------------------- */
  var validTypes=['text','email','number','password','search','tel','url'];
  function resolveInput(path){
    for(var i=0;i<path.length;i++){
      var el=path[i]; if(!el||!el.tagName) continue;
      var t=el.tagName.toUpperCase();
      if(t==='INPUT'&&validTypes.includes(el.type)) return el;
      if(t==='TEXTAREA'||el.isContentEditable||(el.classList&&el.classList.contains('cm-content'))) return el;
      if(['HA-TEXTFIELD','HA-SEARCH-INPUT','HA-CODE-EDITOR','HA-SELECTOR-TEXT'].includes(t)){
        var inner=el.shadowRoot?el.shadowRoot.querySelector('input,textarea,[contenteditable="true"],.cm-content'):null;
        if(inner) return inner;
      }
    }
    return null;
  }

  function checkAndShow(e){
    // (01/10/2026) Trang tu focus lai o nhap ngay sau khi nguoi dung cham RA NGOAI (YouTube: cham dong goi y -> 118 ms sau
    // focus lai o tim kiem -> ban phim hien lai va nam tren man hinh ca khi da chuyen trang). Bo qua focus tu dong trong
    // 1 s; cham THANG vao o nhap (click) van mo ban phim.
    if(e.type==='focusin'&&_shield.outsideAt&&(Date.now()-_shield.outsideAt<1000)) return;
    var path=e.composedPath?e.composedPath():[e.target];
    var inp=resolveInput(path);
    if(inp&&ensureDOM()){
      var vis=keyboardContainer&&keyboardContainer.classList.contains('vkb-visible');
      if(activeInput!==inp||!vis) showKeyboard(inp);
    }
  }

  document.addEventListener('focusin',checkAndShow,true);
  document.addEventListener('click',checkAndShow,true);
  // (01/10/2026) Focus roi o nhap sang thu KHONG phai o nhap (trang tu chuyen, nut bam...) -> an ban phim. Cham phim cua
  // ban phim khong lam o nhap mat focus (bi chan o pointerdown/mousedown) nen khong dung toi day.
  function deepActive(){ var a=document.activeElement; while(a&&a.shadowRoot&&a.shadowRoot.activeElement) a=a.shadowRoot.activeElement; return a; }
  document.addEventListener('focusout',function(){
    setTimeout(function(){
      var vis=keyboardContainer&&keyboardContainer.classList.contains('vkb-visible');
      if(!vis) return;
      var a=deepActive();
      if(!a||a===document.body||!resolveInput([a])) hideKeyboard(true);
    },200);
  },true);
  // Shell goi khi hien man hinh cho / chuyen ung dung: khong de ban phim nam de len.
  window.__vkbHide=function(){ var vis=keyboardContainer&&keyboardContainer.classList.contains('vkb-visible'); if(vis) hideKeyboard(true); };

  /* ---- Master event shield --------------------------------- */
  ['pointerdown','pointerup','mousedown','mouseup','click','touchstart','touchend'].forEach(function(ev){
    document.addEventListener(ev,function(e){
      // Cải tiến: dùng _shield thay window.__vkbClosingShield / __vkbOpeningShield / __vkbLastTap
      if(_shield.closing&&(Date.now()-_shield.closing<400)){
        e.preventDefault();e.stopPropagation();e.stopImmediatePropagation();return;
      }
      if(keyboardContainer&&keyboardContainer.classList.contains('vkb-visible')){
        var x=e.clientX,y=e.clientY;
        if(x===undefined&&e.changedTouches&&e.changedTouches.length>0){x=e.changedTouches[0].clientX;y=e.changedTouches[0].clientY;}
        if(x===undefined||y===undefined) return;
        var rect=keyboardContainer.getBoundingClientRect();
        if(y>=rect.top&&y<=rect.bottom&&x>=rect.left&&x<=rect.right){
          e.preventDefault();e.stopPropagation();e.stopImmediatePropagation();
          if(_shield.opening&&(Date.now()-_shield.opening<400)) return;
          if(['pointerdown','touchstart','mousedown','click'].includes(ev)){
            if(_shield.lastTap&&(Date.now()-_shield.lastTap<250)) return;
            _shield.lastTap=Date.now();
            var keys=keyboardContainer.querySelectorAll('.vkb-key'),found=null;
            for(var i=0;i<keys.length;i++){
              var kr=keys[i].getBoundingClientRect();
              if(y>=kr.top&&y<=kr.bottom&&x>=kr.left&&x<=kr.right){found=keys[i];break;}
            }
            if(found){
              var k=found.dataset.key;
              // (25/10/2026) Hieu ung nhan phim: dung class de an theo transform/brightness
              // cua CSS. Truoc day gan background mau xam de len ca phim mau (layout/enter/VN).
              found.classList.add('vkb-pressed');
              setTimeout(function(){found.classList.remove('vkb-pressed');},110);
              processKey(k);
            }
          }
          return;
        }
        if(ev==='pointerdown'){
          var p2=e.composedPath?e.composedPath():[e.target];
          if(!resolveInput(p2)) hideKeyboard(true);
        }
      }
    },true);
  });

  console.log('[VKB] Ready — Telex Vietnamese IME active.');
})();`;

// (23/09/2026, mo rong 26/09/2026 OS-2) KHOA AM THANH THEO TAB.
//
// Kien truc dung CHUNG mot tien trinh Chrome cho ca ba thiet bi -> CHUNG mot sink PulseAudio duy nhat (xem
// AUDIO-FEATURE-PLAN-2026-09-23.md muc 7.2 — da xac minh KHONG co cach nao tach am thanh theo tung
// tab/target tu ben ngoai trang: setSinkId() can HTTPS + cu chi nguoi dung that, CDP hoan toan khong co lenh
// "mute theo target" nao). Voi OS-2 (nhieu tab/thiet bi), rui ro nay TANG THEM mot bac: ngay CA CUNG mot
// thiet bi co loa cung co the co NHIEU tab (YouTube, Radio...) cung phat cung luc va tron tieng.
//
// Giai phap khong doi: ghi de HTMLMediaElement.prototype.muted/volume NGAY TRUOC KHI trang tu chay (Page.
// addScriptToEvaluateOnNewDocument), nhung nay THEO CO `window.__rwvAudioAllowed` (server bat/tat qua
// Runtime.evaluate — xem setTabAudioAllowed) thay vi mot chieu vinh vien. `alwaysMuted` van la CO DINH cho
// thiet bi KHONG khai bao speaker_id (S3): tab cua no khong bao gio duoc phep phat, du active hay khong.
//
// Mac dinh CAM khi vua tiem (an toan — tab moi tao chua duoc active). setTabAudioAllowed() bat/tat song, VA
// handleTabNavigation() khang dinh lai moi lan tab dieu huong that su (chong truong hop lenh bat cho tab MOI
// TAO bi "thua" navigation dang chay do — xem chu thich o setTabAudioAllowed).
//
// (27/09/2026) `passthrough` (tab YouTube TV khi truyen tu dien thoai): KHONG ghi de muted/volume. Giao dien TV cua
// YouTube doc video.muted/volume luc khoi dong (truoc khi server kip bat co) -> tuong TV dang tat tieng/am luong 0
// va giu nguyen trang thai do (panel co hinh, mat tieng); nut am luong tren dien thoai cung khong tac dung vi setter
// bi vo hieu. Tab nay luon o tien canh va duoc tam dung khi roi di (activateTab) nen khong can khoa.
export function buildAudioGuardScript(alwaysMuted: boolean, passthrough = false): string {
  return `(function(){
  window.__rwvAudioGuard = true;
  window.__rwvAudioAllowed = false;
  var ALWAYS_MUTED = ${alwaysMuted}, PASS = ${passthrough} && !${alwaysMuted};
  // (27/09/2026) TAT TIENG THAT. Ban cu chi "noi doi" qua getter muted/volume — am thanh van ra sink PulseAudio
  // chung, nen video tren S3 (khong loa) keu ra loa P4. Nay tab bi khoa thi dat muted GOC cua trinh duyet (setter
  // native) cho moi <audio>/<video> (luc play + khi server doi co), va tam dung AudioContext; mo khoa thi chi go
  // nhung gi CHINH lop nay da tat (trang tu dat muted thi giu nguyen). iframe khac nguon khong doc duoc co cua trang
  // chinh -> chi khoa khi ALWAYS_MUTED (nhu truoc).
  var isTop = window === window.top;
  function blocked(){
    if (ALWAYS_MUTED) return true;
    if (isTop) return !window.__rwvAudioAllowed;
    try { return window.top.__rwvAudioAllowed === false; } catch (e) { return false; }
  }
  try {
    var proto = HTMLMediaElement.prototype;
    var nm = Object.getOwnPropertyDescriptor(proto, 'muted');
    var forced = new WeakSet(), want = new WeakMap(), seen = new Set();
    var apply = function(el){
      try {
        if (blocked()) { if (!nm.get.call(el)) { nm.set.call(el, true); forced.add(el); } }
        else if (PASS && want.has(el)) { nm.set.call(el, want.get(el)); forced.delete(el); }
        else if (forced.has(el)) { nm.set.call(el, false); forced.delete(el); }
      } catch (e) {}
    };
    if (PASS) {
      // Tab YouTube TV (xem tren): trang thay va tu dat muted/volume that (dien thoai chinh am luong duoc).
      Object.defineProperty(proto, 'muted', {
        get: function(){ return want.has(this) ? want.get(this) : (forced.has(this) ? false : nm.get.call(this)); },
        set: function(v){ want.set(this, !!v); apply(this); }, configurable: true
      });
    } else {
      Object.defineProperty(proto, 'muted', {
        get: function(){ return ALWAYS_MUTED || !window.__rwvAudioAllowed; }, set: function(){}, configurable: true
      });
      Object.defineProperty(proto, 'volume', {
        get: function(){ return (ALWAYS_MUTED || !window.__rwvAudioAllowed) ? 0 : 1; }, set: function(){}, configurable: true
      });
    }
    var nplay = proto.play;
    proto.play = function(){ seen.add(this); apply(this); return nplay.apply(this, arguments); };
    document.addEventListener('play', function(e){
      var t = e.target; if (t instanceof HTMLMediaElement) { seen.add(t); apply(t); }
    }, true);
    // Web Audio (chuong cua, tieng bip...): tam dung khi bi khoa.
    var ctxs = [], ctxForced = new WeakSet(), NA = window.AudioContext;
    if (NA) {
      var nresume = NA.prototype.resume;
      var W = function(o){ var c = o === undefined ? new NA() : new NA(o); ctxs.push(c); if (blocked()) { ctxForced.add(c); c.suspend().catch(function(){}); } return c; };
      W.prototype = NA.prototype;
      window.AudioContext = W;
      NA.prototype.resume = function(){ if (blocked()) { ctxForced.add(this); return Promise.resolve(); } return nresume.apply(this, arguments); };
    }
    window.__rwvAudioApply = function(){
      var b = blocked();
      try { document.querySelectorAll('audio,video').forEach(function(m){ seen.add(m); }); } catch (e) {}
      seen.forEach(function(m){ apply(m); if (!m.isConnected && m.paused) seen.delete(m); });
      ctxs.forEach(function(c){
        try {
          if (b && c.state === 'running') { ctxForced.add(c); c.suspend(); }
          else if (!b && ctxForced.has(c)) { ctxForced.delete(c); nresume.call(c); }
        } catch (e) {}
      });
    };
  } catch (e) {}
  // (26/09/2026) Bao server trang nay CO dang phat <audio>/<video> khong — de the "Dang phat" chi hien khi that su
  // phat, va tab Radio/Nhac da dung duoc don nhu tab thuong. Su kien media khong noi bot nhung BAT duoc o pha capture
  // cua document. Gop 300 ms, chi gui khi trang thai DOI.
  var last = null, pend = 0;
  function report(){
    pend = 0;
    var p = false;
    try {
      var ms = document.querySelectorAll('audio,video');
      for (var i = 0; i < ms.length; i++) if (!ms[i].paused && !ms[i].ended) { p = true; break; }
    } catch (e) {}
    if (p === last) return;
    last = p;
    var fn = window[${JSON.stringify(CONTROL_BINDING)}];
    if (typeof fn === 'function') { try { fn(JSON.stringify({ media: p ? 1 : 0 })); } catch (e) {} }
  }
  ['play', 'playing', 'pause', 'ended', 'emptied'].forEach(function(ev){
    document.addEventListener(ev, function(){ if (!pend) pend = setTimeout(report, 300); }, true);
  });
  // Nut "Dung" cua the Dang phat: trang tu dung theo cach cua no (window.rwvStop, vd radio.html huy luon HLS), khong
  // thi tam dung moi the media.
  window.__rwvMediaStop = function(){
    if (typeof window.rwvStop === 'function') { try { window.rwvStop(); return; } catch (e) {} }
    try { document.querySelectorAll('audio,video').forEach(function(m){ try { m.pause(); } catch (e) {} }); } catch (e) {}
  };
})();`;
}

/**
 * Bat/tat am thanh cua MOT tab. Ghi lai `tab.audioAllowed` NGAY (dong bo) roi gui Runtime.evaluate — khong doi ket
 * qua (nhu cac lenh dieu khien khac trong file nay). An toan ke ca khi tab dang dieu huong: neu lenh nay "thua"
 * (chay tren tai lieu cu truoc khi trang moi commit), handleTabNavigation() se khang dinh lai gia tri dung ngay khi
 * trang moi thuc su vao — xem chu thich o buildAudioGuardScript.
 */
function setTabAudioAllowed(tab: Tab, allowed: boolean): void {
  tab.audioAllowed = allowed;
  tab.session.send('Runtime.evaluate', {
    expression: `window.__rwvAudioGuard && (window.__rwvAudioAllowed = ${allowed}, window.__rwvAudioApply && window.__rwvAudioApply());`,
  }).catch(() => { });
}

// (23/09/2026) Launcher: nut xo xuong dropdown chon "ung dung" (Home ve dashboard,
// YouTube; Camera va URL cho san — 24/09/2026 doi nut thanh tab hinh thang dinh mep
// tren, can giua, xem ben duoi). Tiem CUNG CO CHE voi
// ban phim (Page.addScriptToEvaluateOnNewDocument -> ton tai tren MOI trang,
// ke ca sau khi Go Home/doi URL). Rieng cua no, khong phai cua dashboard —
// noi tren cung du dang xem trang nao.
//
// homeUrl la GIA TRI RIENG TUNG THIET BI, thiet bi tu gui len qua tham so
// ket noi ?home= (xem build_ws_uri_ ben firmware) — server khong tu biet
// duoc theo cach nao khac, vi day von la cai dat chi song tren ESP32 ("Home
// URL"). Neu thieu (thiet bi cu chua OTA ban co ?home=), nut Home tu an,
// chi con YouTube.
// (25/09/2026) URL cac ung dung cua menu: xem src/launcherApps.ts (Camera P4 = cam.html?src=p4_panel qua go2rtc,
// Thoi tiet = weather.html...). Am lich dung chung public/lunar.js.
const LUNAR_JS = (() => {
  try { return fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'lunar.js'), 'utf8'); }
  catch (e) { console.warn('[launcher] khong doc duoc lunar.js:', (e as Error).message); return ''; }
})();
// Ten binding CDP ma o "URL" goi ve server (Runtime.addBinding) — xem handleUserEnteredUrl.
const URL_BINDING = '__rwvSetDisplayUrl';

/**
 * (25/09/2026) Nguoi dung go URL o nut mo rong + Enter. Trang web bat ky cung goi duoc binding nay, nen chi nhan
 * http(s) va do dai hop ly (viec toi da no lam duoc = dieu huong, dieu ma location.href vốn da lam duoc).
 * Thiet bi co ?urlset=1 -> gui SetDisplayURL: thiet bi dat "URL hien thi" (HA thay), set_action mo trang qua
 * OpenURL nhu moi lan khac. Thiet bi cu -> server tu mo trang.
 */
function handleUserEnteredUrl(id: string, payload: unknown): void {
  if (typeof payload !== 'string' || payload.length === 0 || payload.length > 1024) return;
  let url: URL;
  try { url = new URL(payload); } catch { return; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  const dev = devices.get(id);
  if (!dev) return;
  if (dev.cfg.urlSet && broadcaster.sendSetDisplayURL(id, url.href)) {
    console.log(`[launcher] ${id}: nguoi dung nhap URL ${url.href} -> gui thiet bi dat "URL hien thi"`);
    return;
  }
  console.log(`[launcher] ${id}: nguoi dung nhap URL ${url.href} -> server tu mo (thiet bi chua ho tro urlset)`);
  navigateToUrl(dev, url.href).catch((e: unknown) => console.warn(`[launcher] ${id}: mo URL that bai:`, e));
}

/** URL co CUNG GOC voi Home URL cua thiet bi hay khong — quyet dinh dieu huong vao tab 'home' hay 'browser'. */
function isHaUrl(dev: DeviceSession, url: string): boolean {
  if (!dev.cfg.homeUrl) return false;
  try { return new URL(url).origin === new URL(dev.cfg.homeUrl).origin; } catch { return false; }
}

/**
 * (26/09/2026 OS-2) DIEM VAO DUY NHAT cho moi lenh "hien URL nay" tu phia thiet bi (OpenURL packet: nut/thuc the
 * "Go Home" VA thuc the "URL hien thi" deu di qua CUNG mot goi tin o tang firmware — khong the phan biet duoc,
 * xem Dashboard OS-Client: docs/server-noi-bo/KE-HOACH-GIAO-DIEN-HE-DIEU-HANH.md muc 4). Phan loai theo GOC: cung goc voi Home URL -> tab 'home'
 * (ghim); khac goc -> tab 'browser'. "Go Home" luon gui dung Home URL nen luon dua tab 'home' VE DUNG home_url,
 * ke ca khi tab do dang o mot trang con khac cua HA — dung yeu cau ban dau cua nut nay.
 */
export function navigateToUrl(dev: DeviceSession, url: string): Promise<void> {
  // (30/09/2026) Dang TRUYEN YouTube TV ma thiet bi vua noi lai (vd P4 qua tai khi phat video 720p, WS nghen roi tu
  // noi lai): firmware tu gui OpenURL (trang chu) ngay khi noi -> truoc day keo man hinh ve HA, video van phat o tab
  // nen, dien thoai van tuong dang truyen nen khong mo lai (log that 30/09 11:42). Bo qua OpenURL trong 8 s sau khi noi
  // lai va hien lai YouTube TV; OpenURL sau do (nguoi dung bam Go Home / tu dong hoa) van chay binh thuong.
  // (30/09/2026) Cung vay ngay sau khi BAT DAU truyen: man dang tat -> server bat den nen -> firmware cu (resume())
  // gui lai OpenURL trang chu (log that 30/09 12:32:46: YouTube TV vua hien da bi keo ve HA trong cung giay).
  const now = Date.now();
  const justReconnected = dev.reconnectedMs !== undefined && now - dev.reconnectedMs < 8_000;
  const justLaunched = dev.castLaunchMs !== undefined && now - dev.castLaunchMs < 6_000;
  if (dev.castUrl && dev.tabs.has('yttv') && (justReconnected || justLaunched)) {
    console.log(`[cast] ${dev.deviceId}: ${justLaunched ? 'vua bat dau truyen' : 'noi lai trong luc truyen'} — bo qua OpenURL ${url.slice(0, 60)}, giu YouTube TV`);
    return dev.tabOps.run(async () => { await activateTab(dev, 'yttv'); requestFullFrameFor(dev); });
  }
  return dev.tabOps.run(() => navigateToUrlNow(dev, url));
}

async function navigateToUrlNow(dev: DeviceSession, url: string): Promise<void> {
  if (devices.get(dev.deviceId) !== dev) return;  // phien da bi xoa trong luc lenh nay xep hang
  noteActivity(dev, 'mo URL');
  // (26/09/2026) URL thuoc mot ung dung trong menu (vd youtu.be -> YouTube) vao DUNG tab ung dung do.
  // Thu tu: ung dung khop (ke ca ung dung nam tren HA nhu Nang luong) -> cung goc HA (tab 'home') -> Trinh duyet.
  const appKey = appKeyForUrl(url, listAllApps(dev.cfg.homeUrl).filter((a) => !a.hidden && a.id !== 'home'))
    ?? (isHaUrl(dev, url) ? 'home' : null);
  const spec = appKey && appKey !== 'home' ? resolveAppSpec(dev, appKey) : null;
  // (14/10/2026) URL cu cua ung dung NOI BO (firmware gui lai URL cuoi khi noi lai, vd media.html thieu ?dev=) -> URL hien tai.
  if (spec?.url) url = ghostUrlFor(url, spec.url) ?? spec.url;
  const key = appKey === 'home' ? 'home' : spec ? appKey! : 'browser';
  let tab = dev.tabs.get(key);
  let navigated = false;
  if (!tab) {
    tab = key === 'home' ? await createTab(dev, key, 'ha', true, 'Home Assistant')
      : spec ? await createTab(dev, key, spec.kind, false, spec.label)
      : await createTab(dev, key, 'browser', false, 'Chrome');
    if (devices.get(dev.deviceId) !== dev) { closeTab(dev, key, 'phien thiet bi da bi xoa'); return; }
    // Bat screencast TRUOC (tren trang trang, an toan) roi moi dieu huong cheo nguon — xem createTab().
    await activateTab(dev, key);
    await navigateTab(dev, tab, url);
    navigated = true;
  } else {
    // (30/09/2026) KICH HOAT TRUOC roi moi dieu huong, ca voi tab da ton tai. Truoc day dieu huong tab NEN truoc ->
    // activateTab bat screencast dung luc trang dang doi goc -> "Not attached to an active page" (log that 30/09 khi HA
    // mo camera cho ca 3 man cung luc), screencast KHONG chay ma van danh dau da bat -> man hinh dung hinh.
    await activateTab(dev, key);
    if (tab.url !== url) {
      await navigateTab(dev, tab, url);
      navigated = true;
    }
  }
  // (25/09/2026, giu nguyen tu ban OS-1) Trang TINH khong navigate lai (URL trung) sau khi thiet bi mat ket noi roi
  // noi lai van can duoc VE LAI: "nudge" ep Chrome phat mot khung moi. Da navigate that thi Chrome tu ve lai, khong
  // can nudge them.
  if (!navigated) await nudgeRepaintAsync(dev.cdp).catch(() => { });
  requestFullFrameFor(dev);
  evictIfNeeded(dev);
}

// (25/09/2026) Thanh truot trong menu goi window.__rwvControl(JSON). Chi nhan dung hai truong, gia tri 0..100 (trang
// web bat ky cung goi duoc binding nay: viec toi da no lam duoc la doi do sang/am luong cua chinh man hinh nay).
const CONTROL_BINDING = '__rwvControl';

function handleMenuControl(id: string, payload: unknown, from?: Tab): void {
  // Trang Cai dat gui duoc gia tri dai hon (o nhap URL toi 255 ky tu); moi trang khac van gioi han 200.
  // Man hinh chinh gui ca bo cuc (keo tha, thu muc) -> 8000.
  const maxLen = from?.kind === 'settings' ? 2000 : from?.kind === 'system' ? 8000 : 200;
  if (typeof payload !== 'string' || payload.length > maxLen) return;
  let msg: any;
  try { msg = JSON.parse(payload); } catch { return; }
  const dev = devices.get(id);
  if (!dev) return;
  if (msg?.hello) { pushDeviceStateToPage(dev); return; }
  // (26/09/2026 OS-4) Trang Cai dat. CHI nhan tu tab ung dung Cai dat (trang web bat ky cung goi duoc binding nay).
  if (msg?.settings != null) {
    if (from && from.kind === 'settings' && dev.tabs.get(from.key) === from) {
      handleSettings(dev, from, msg).catch((e: unknown) => console.warn(`[settings] ${id}:`, e));
    }
    return;
  }
  // (27/09/2026) Vuot trai/phai tren man hinh cho dang hien anh -> anh sau/truoc (hen lai gio doi anh tu dau).
  if (msg?.saver === 'next' || msg?.saver === 'prev') {
    dev.saverPhotoAt = Date.now();
    saverPhotoStep(dev, msg.saver === 'next' ? 1 : -1, true).catch(() => { });
    return;
  }
  // (27/09/2026) Nut / the "Tro ly": bat dau (hoac dung neu dang nghe) / dung.
  if (msg?.assist != null) {
    if (dev.cfg.voice && dev.cfg.devControl) broadcaster.sendDeviceControl(id, ControlField.Assist, Number(msg.assist) ? 1 : 0);
    return;
  }
  // (27/09/2026 OS-3) Bo cuc man hinh chinh sau khi keo tha. CHI tu tab he thong dang o /os/home.
  if (msg?.home !== undefined) {
    if (from && from.kind === 'system' && dev.tabs.get(from.key) === from) {
      saveHomeLayout(msg.home);
      console.log(`[home] ${id}: luu bo cuc man hinh chinh${msg.home == null ? ' (dat lai mac dinh)' : ''}`);
      applyHomeLayout(dev).catch(() => { });
    }
    return;
  }
  // (30/09/2026) Hang "Phat hien nguoi" trong thanh trang thai: {ps:'get'} khi mo thanh, {ps:'set', v:'<lua chon>'}.
  if (msg?.ps === 'get') { refreshPresenceSel(dev, 5000).catch(() => { }); return; }
  if (msg?.ps === 'set' && typeof msg.v === 'string') { setPresenceSel(dev, msg.v).catch(() => { }); return; }
  // (26/09/2026 OS-5) Thong bao: mo (cham the), xoa mot, xoa het; bat/tat Khong lam phien.
  if (msg?.ntOpen != null) { openNotice(dev, Number(msg.ntOpen)); return; }
  if (msg?.ntDel != null) { noticesOf(id).remove(Number(msg.ntDel)); pushDeviceStateToPage(dev); return; }
  // (01/10/2026) Mo thanh keo xuong (thay danh sach) = da xem thong bao thuong; tin nhan chi "da xem" khi doc trong Tin nhan.
  if (msg?.ntSeen) { if (noticesOf(id).markSeen('nt')) pushDeviceStateToPage(dev); return; }
  if (msg?.ntClear) { noticesOf(id).clear(); pushDeviceStateToPage(dev); return; }
  // (01/10/2026) Am thanh: am luong Thong bao / Bao thuc (Shell, Cai dat), phat thu, tat / bao lai bao thuc.
  if (msg?.f === 'alert' || msg?.f === 'alarm') {
    soundPrefs.set(id, { [msg.f]: Number(msg.v) });
    syncSoundToDevice(dev); pushDeviceStateToPage(dev); return;
  }
  if (msg?.sndTest === 'alert' || msg?.sndTest === 'alarm') {
    if (canPlay(dev)) playSound(dev, msg.sndTest === 'alert' ? Sound.TestNotify : Sound.TestAlarm);
    else evalShell(dev, `S.chime && S.chime(${msg.sndTest === 'alarm'})`);
    return;
  }
  if (typeof msg?.alarmStop === 'string') { alarms.stop(msg.alarmStop); return; }
  if (typeof msg?.alarmSnooze === 'string') { alarms.snooze(msg.alarmSnooze); return; }
  if (msg?.f === 'dnd') { setDnd(id, Number(msg?.v) === 1); for (const d of devices.values()) if (d.deviceId === id) pushDeviceStateToPage(d); return; }
  // (26/09/2026 OS-5) Nguoi dung cham tat man hinh cho.
  if (msg?.wake) { dev.locked = false; setSaver(dev, false); dev.lastTouchMs = Date.now(); return; }
  // (07/10/2026) Man hinh khoa: vuot len = mo khoa; cham = chi sang lai 15 s (khong mo).
  if (msg?.unlock) {
    dev.locked = false; setSaver(dev, false); dev.lastTouchMs = Date.now();
    console.log(`[saver] ${id}: mo khoa (vuot len)`);
    return;
  }
  if (msg?.lockTap) { dev.lastTouchMs = Date.now(); wakeBrightWhileLocked(dev); return; }
  // (26/09/2026) Trang cua MOT tab bao dang phat / da dung (buildAudioGuardScript). Chi tin tab con thuoc thiet bi.
  if (msg?.media != null) {
    if (from && dev.tabs.get(from.key) === from) onTabMedia(dev, from, !!msg.media);
    return;
  }
  // (26/09/2026 OS-3) Man hinh "Gan day": mo (chup anh tab dang hien truoc), dong mot ung dung, dong tat ca.
  if (msg?.recents) { showRecents(dev, true).catch(() => { }); return; }
  if (typeof msg?.close === 'string' || msg?.closeAll) {
    const keys = msg.closeAll ? [...dev.tabs.keys()] : [msg.close as string];
    dev.tabOps.run(async () => {
      if (msg.closeAll) dev.closedRecents?.clear(); else dev.closedRecents?.delete(msg.close as string);
      for (const k of keys) {
        const t = dev.tabs.get(k);
        if (t && !t.pinned && k !== dev.activeTabKey) closeTab(dev, k, 'nguoi dung dong o Gan day');
      }
      pushDeviceStateToPage(dev);
      await showRecents(dev, false);
    }).catch(() => { });
    return;
  }
  // Nut "Dung" cua the Dang phat trong thanh trang thai.
  if (typeof msg?.stop === 'string') {
    const tab = dev.tabs.get(msg.stop);
    if (tab) {
      tab.session.send('Runtime.evaluate', { expression: 'window.__rwvMediaStop && window.__rwvMediaStop();' }).catch(() => { });
      console.log(`[app] ${id}: dung phat nen tab "${tab.key}"`);
    }
    return;
  }
  if (msg?.timer) { handleTimer(dev, msg.timer); return; }
  // (26/09/2026 OS-2) Shell goi {app:"<id>"} khi nguoi dung cham mot ung dung (luoi Home cua OS, dock, thanh
  // truot mep tren) — mo/kich hoat dung TAB cua ung dung do, xem openApp().
  if (typeof msg?.app === 'string' && msg.app.length <= 40) {
    openApp(dev, msg.app).catch((e: unknown) => console.warn(`[app] ${id}: mo "${msg.app}" that bai:`, e));
    return;
  }
  const v = Number(msg?.v);
  if (!Number.isFinite(v) || v < 0 || v > 100) return;
  const FIELDS: Record<string, ControlField> = {
    b: ControlField.Brightness, v: ControlField.Volume,
    ns: ControlField.NoSleep, mu: ControlField.Mute, aec: ControlField.Aec,
  };
  const field = typeof msg?.f === 'string' ? FIELDS[msg.f] : undefined;
  if (field == null || !dev.cfg.devControl) return;
  broadcaster.sendDeviceControl(id, field, field >= ControlField.NoSleep ? (v ? 1 : 0) : v);
}

// (25/09/2026) HEN GIO: timer.html goi {timer:{sec,label}} / {timer:{cancel:1}}. Het gio: danh thuc man hinh (bat den
// nen qua DeviceControl), roi trang dang mo hien bao thuc toan man hinh + chuong (am thanh trang -> loa P4).
function handleTimer(dev: DeviceSession, t: any): void {
  if (dev.timer) { clearTimeout(dev.timer.handle); dev.timer = undefined; }
  const sec = Math.round(Number(t?.sec));
  if (!t?.cancel && Number.isFinite(sec) && sec >= 1 && sec <= 24 * 3600) {
    const label = typeof t?.label === 'string' ? t.label.slice(0, 40) : '';
    const handle = setTimeout(() => fireTimer(dev), sec * 1000);
    dev.timer = { endsAt: Date.now() + sec * 1000, label, handle };
    console.log(`[timer] ${dev.deviceId}: hen ${sec} s${label ? ` (${label})` : ''}`);
  }
  pushDeviceStateToPage(dev);
}

function fireTimer(dev: DeviceSession): void {
  const label = dev.timer?.label || '';
  dev.timer = undefined;
  console.log(`[timer] ${dev.deviceId}: HET GIO${label ? ` (${label})` : ''}`);
  pushDeviceStateToPage(dev);
  // (01/10/2026) Dung chung co che reo cua Bao thuc (am Bao thuc, Khong lam phien, tat tren man hinh).
  alarms.ringTimer(dev.deviceId, label);
}

// ── (26/09/2026 OS-5) THONG BAO + KHONG LAM PHIEN ─────────────────────────────────────────────────────────────────
// Lich su va Khong lam phien giu theo deviceId (khong theo phien) — thiet bi noi lai / bi don khi ranh van con.
const noticeStores = new Map<string, NoticeStore>();
// (01/10/2026) Luu thong bao (kem trang thai da xem) ra /data: cap nhat / khoi dong lai addon khong lam mat "chuong" chua xem.
const NOTICES_FILE = process.env.NOTICES_FILE || path.join(fs.existsSync('/data') ? '/data' : path.join(process.cwd(), 'data'), 'rwv-notices.json');
let noticeSaveT: NodeJS.Timeout | null = null;
function saveNoticesSoon(): void {
  if (noticeSaveT) return;
  noticeSaveT = setTimeout(() => {
    noticeSaveT = null;
    const o: Record<string, unknown> = {};
    for (const [id, s] of noticeStores) o[id] = s.dump();
    fs.promises.writeFile(NOTICES_FILE, JSON.stringify(o)).catch(() => { });
  }, 1000);
}
let savedNotices: Record<string, { next?: number; items?: Notice[] }> = {};
try { savedNotices = JSON.parse(fs.readFileSync(NOTICES_FILE, 'utf8')); } catch { /* chua co */ }
function noticesOf(id: string): NoticeStore {
  let s = noticeStores.get(id);
  if (!s) { s = new NoticeStore(); s.restore(savedNotices[id]); s.onChange = saveNoticesSoon; noticeStores.set(id, s); }
  return s;
}

// (01/10/2026) Tin nhan (src/chat.ts) cho biet so tin CHUA DOC cua tung man hinh (theo cuoc tro chuyen). Bao "tin nhan" cua
// mot cuoc tro chuyen tu mat khi man hinh do da doc het (mo cuoc tro chuyen trong ung dung Tin nhan) hoac cuoc do bi xoa.
type ChatUnread = (deviceId: string) => { total: number; byConv: Record<string, number> };
let chatUnread: ChatUnread = () => ({ total: 0, byConv: {} });
export function setChatUnreadProvider(fn: ChatUnread): void { chatUnread = fn; }
/** Goi sau moi thay doi cua Tin nhan: don bao tin nhan da doc + cap nhat so dem (man hinh cho, chuong, bieu tuong). */
export function chatChanged(): void {
  for (const dev of devices.values()) {
    const u = chatUnread(dev.deviceId);
    noticesOf(dev.deviceId).removeWhere((n) => n.app === 'chat' && !!n.arg && !(u.byConv[n.arg] > 0));
    pushDeviceStateToPage(dev);
  }
}
// (09/10/2026) Anh camera trong thong bao: qua server (/go2rtc -> go2rtc cua Frigate), khong gia dinh cong 1984 mo ra may chu.
const GO2RTC_FOR_PAGES = `${LOCAL_ORIGIN}/go2rtc`;
// Khong lam phien: ghi ra /data (ben qua cap nhat addon). Loi ghi chi mat tinh ben, khong anh huong chay.
const DND_FILE = process.env.DND_FILE || (fs.existsSync('/data') ? '/data/rwv-dnd.json' : '');
const dnd: Record<string, boolean> = (() => {
  try { return DND_FILE ? JSON.parse(fs.readFileSync(DND_FILE, 'utf8')) : {}; } catch { return {}; }
})();
function dndOf(id: string): boolean { return dnd[id] === true; }
function setDnd(id: string, on: boolean): void {
  dnd[id] = on;
  console.log(`[notify] ${id}: Khong lam phien ${on ? 'BAT' : 'TAT'}`);
  if (DND_FILE) fs.promises.writeFile(DND_FILE, JSON.stringify(dnd)).catch(() => { });
  const dev = devices.get(id);
  if (dev) syncSoundToDevice(dev);
}

// ── (01/10/2026) AM THANH KIEU DIEN THOAI (src/sound.ts) ─────────────────────────────────────────────────────────────
/** Firmware tu phat am (?snd=1) VA co loa. */
function canPlay(dev: DeviceSession): boolean { return !!dev.cfg.sound && !!dev.cfg.audioEnabled; }
function playSound(dev: DeviceSession, s: Sound): void {
  if (canPlay(dev)) broadcaster.sendDeviceControl(dev.deviceId, ControlField.PlaySound, s);
}
/** Gui am luong Thong bao / Bao thuc + Khong lam phien xuong firmware (luc ket noi va khi doi). */
export function syncSoundToDevice(dev: DeviceSession): void {
  if (!dev.cfg.sound) return;
  const p = soundPrefs.get(dev.deviceId);
  broadcaster.sendDeviceControl(dev.deviceId, ControlField.AlertVolume, p.alert);
  broadcaster.sendDeviceControl(dev.deviceId, ControlField.AlarmVolume, p.alarm);
  broadcaster.sendDeviceControl(dev.deviceId, ControlField.Dnd, dndOf(dev.deviceId) ? 1 : 0);
}
function evalShell(dev: DeviceSession, js: string): void {
  dev.cdp.send('Runtime.evaluate', { expression: `window.__rwvShell && (function(S){ ${js} })(window.__rwvShell)` }).catch(() => { });
}
function ringingForShell(r: Ringing) {
  return { id: r.id, l: r.label, t: r.time, sz: r.snooze, tm: r.timer };
}

// Bao thuc / Hen gio (src/alarms.ts): reo = danh thuc man hinh + man hinh bao thuc + am Bao thuc (firmware) hoac chuong
// WebAudio cu (firmware khong ?snd). Khong lam phien: im lang, KHONG danh thuc (van hien man hinh bao thuc).
alarms.hooks = {
  tz: () => anyTzOffset(),
  screens: () => [...devices.values()].filter((d) => broadcaster.getClientCount(d.deviceId) > 0).map((d) => d.deviceId),
  ring(r) {
    for (const id of r.devices) {
      const dev = devices.get(id);
      if (!dev) continue;
      const quiet = dndOf(id);
      const screenOff = dev.devState ? !dev.devState.backlightOn : false;
      if (!quiet) {
        if (dev.cfg.devControl) broadcaster.sendDeviceControl(id, ControlField.Brightness, userBrightness(dev));
        dev.lastTouchMs = Date.now(); setSaver(dev, false);
      }
      playSound(dev, Sound.Alarm);
      const beep = !canPlay(dev) && !quiet;
      const show = () => evalShell(dev, `S.alarm(${JSON.stringify(r.label)}, ${JSON.stringify({ ...ringingForShell(r), beep })})`);
      if (!quiet && screenOff) setTimeout(show, 1500); else show();
    }
  },
  stop(r) {
    for (const id of r.devices) {
      const dev = devices.get(id);
      if (!dev) continue;
      playSound(dev, Sound.AlarmStop);
      evalShell(dev, `S.alarmClose && S.alarmClose(${JSON.stringify(r.id)})`);
    }
  },
  missed(r) {
    for (const id of r.devices) postNotify({ device: id, title: r.timer ? 'Hẹn giờ đã hết (không ai tắt)' : `Báo thức ${r.time} bị lỡ`, message: r.label || '', priority: 'normal', app: r.timer ? 'timer' : 'alarm' });
  },
  changed() { for (const d of devices.values()) pushDeviceStateToPage(d); },
};
/** Gon cho Shell: id, tieu de, noi dung, uu tien, thoi diem, anh, co hanh dong khi cham khong. */
function noticeForShell(n: Notice) {
  // (14/06/2026) `str` = luong MJPEG (tu tham so `camera:`), `pst` = anh tinh du phong. Shell ve <img src=str>
  // (multipart) -> video truc tiep; truoc day chi co `img` (mot khung, khong tu cap nhat).
  return { id: n.id, t: n.title, m: n.message, p: n.priority, ts: n.ts, img: n.image ?? null, vid: n.video ?? null, aud: n.audio ?? null,
    str: n.stream ?? null, pst: n.poster ?? null, dur: n.duration ?? null, act: !!(n.app || n.url),
    s: !!n.seen, k: noticeKind(n), ...(n.missed ? { mc: 1 } : {}) };
}

/**
 * POST /notify (index.ts). Tra ve danh sach man hinh da nhan. `device` = 'all' (moi man hinh dang ket noi) hoac mot
 * deviceId cu the (van luu vao lich su du man hinh do chua ket noi).
 */
export function postNotify(body: NotifyRequest): { ok: boolean; error?: string; devices?: string[] } {
  const r = parseNotify(body, GO2RTC_FOR_PAGES);
  if (!r.ok) return { ok: false, error: r.error };
  const targets = r.device === 'all' ? [...devices.keys()] : [r.device];
  for (const id of targets) {
    // (22/11/2026) Moi man nhan luong MJPEG SCALE dung do phan giai cua no: do that go2rtc tra 1,6 khung/giay
    // o 1920x1080 nhung 12,0 khung/giay khi them w/h = kich thuoc man (P4 1024x600, S3 480x272/480x480/800x480).
    const dsz = devices.get(id);
    const scaled = scaleNoticeMedia(r.notice, dsz?.cfg.width, dsz?.cfg.height);
    const n = noticesOf(id).add(scaled);
    const dev = devices.get(id);
    console.log(`[notify] ${id}: "${n.title || n.message}" (${n.priority})`);
    if (!dev) continue;
    const quiet = dndOf(id);
    pushDeviceStateToPage(dev);
    if (!shouldPopup(n, quiet)) continue;
    const wake = shouldWake(n, quiet);
    const screenOff = dev.devState ? !dev.devState.backlightOn : false;
    if (wake && dev.cfg.devControl) broadcaster.sendDeviceControl(id, ControlField.Brightness, userBrightness(dev));
    // (19/10/2026) Thong bao URGENT: mo khoa man hinh (tat che do cho) de thay ngay tin nhan.
    if (n.priority === 'urgent' && dev.cfg.devControl) {
      broadcaster.sendDeviceControl(id, ControlField.Saver, 0);
      broadcaster.sendDeviceControl(id, ControlField.Brightness, userBrightness(dev));
    }
    // (16/10/2026) Cuoc goi nho khi dang man hinh cho / khoa: GIU man hinh cho — the "Cuộc gọi nhỡ" hien ngay tren do
    // (Shell, st.nt), khong bat the noi.
    const keepSaver = !!n.missed && dev.saverOn;
    if (wake && dev.locked && dev.saverOn) { dev.lastTouchMs = Date.now(); wakeBrightWhileLocked(dev); }  // (07/10/2026) giu khoa
    else if (wake && !keepSaver) { dev.lastTouchMs = Date.now(); setSaver(dev, false); }
    if (keepSaver) continue;
    // Man hinh dang tat: doi den nen bat + remote_webview resume (~0,5 s) roi moi hien, de khung do toi duoc man hinh.
    // (01/10/2026) Firmware tu phat am (?snd=1): am theo loai (tin nhan / uu tien / canh bao khan) voi am luong Thong bao
    // hoac Bao thuc — khong qua luong am thanh trang (Im lang chi tat media). Khong lam phien: khong keu gi.
    const snd = soundForNotice(n);
    const webChime = !canPlay(dev) && wake && !quiet;
    if (canPlay(dev) && snd != null && !quiet) playSound(dev, snd);
    const show = () => dev.cdp.send('Runtime.evaluate', {
      expression: `window.__rwvShell && window.__rwvShell.notify && window.__rwvShell.notify(${JSON.stringify(noticeForShell(n))}, ${webChime})`,
    }).catch(() => { });
    if (wake && screenOff) setTimeout(show, 1500); else show();
  }
  return { ok: true, devices: targets };
}

// ── (26/09/2026 OS-4) CAI DAT TREN PANEL ─────────────────────────────────────────────────────────────────────────────
const SERVER_VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version as string; }
  catch { return '?'; }
})();

function panelDefaults() { return { saverPhotos: SCREENSAVER_PHOTOS, morning: MORNING_DEFAULT, saverIdleS: SCREENSAVER_IDLE_S, cast: CAST_DEFAULT }; }

async function pushSettings(dev: DeviceSession, tab: Tab, note?: { ok: boolean; msg: string }): Promise<void> {
  const r = await getSettingsView(dev.deviceId);
  const m = metrics.snapshot().devices.find((d: any) => d.id === dev.deviceId) as any;
  const server = {
    version: SERVER_VERSION, screens: devices.size, id: dev.deviceId, w: dev.cfg.width, h: dev.cfg.height,
    rotation: dev.cfg.rotation ?? 0, tabs: dev.tabs.size,
    decodeMs: m?.recentMedianDecodeMs ?? null, kbps: m?.recentBytesPerSec != null ? Math.round(m.recentBytesPerSec / 1024) : null,
    heap: m?.deviceHeapFree ?? null,
  };
  await tab.session.send('Runtime.evaluate', {
    expression: `window.__rwvSettings && window.__rwvSettings(${JSON.stringify({ ...r, server, panel: panelPrefs.items(dev.deviceId, panelDefaults(), GPHOTOS_ALBUM), note: note ?? null })})`,
  }).catch(() => { });
}

async function handleSettings(dev: DeviceSession, tab: Tab, msg: any): Promise<void> {
  if (msg.settings === 'get') return pushSettings(dev, tab);
  // (08/10/2026) Doi Wi-Fi: quet mang / ket noi mang moi qua dich vu ESPHome cua CHINH man hinh nay (KHONG ghi mat khau vao
  // log). Firmware tu thu 30 s, khong vao duoc hoac khong thay may chu thi quay ve mang cu; ket qua o cam bien "Đổi Wi-Fi".
  // (08/10/2026) Mat khau luong camera (nguoi dung cuoi dat trong Cai dat) — KHONG ghi mat khau vao log.
  if (msg.settings === 'camauth') {
    const r = await getSettingsView(dev.deviceId);
    if (!r.ok) return pushSettings(dev, tab);
    const plan = planCamAuth(r.view, msg.enabled, msg.user, msg.password);
    if (typeof plan === 'string') {
      console.warn(`[settings] ${dev.deviceId}: tu choi mat khau camera: ${plan}`);
      const M: Record<string, string> = { 'ten dang nhap khong hop le': 'Tên đăng nhập 1–32 ký tự (chữ, số, . _ @ -).',
        'mat khau phai 4-64 ky tu': 'Mật khẩu phải từ 4 đến 64 ký tự.', 'can mat khau': 'Nhập mật khẩu để bật.' };
      return pushSettings(dev, tab, { ok: false, msg: M[plan] ?? 'Không đổi được mật khẩu camera.' });
    }
    const ok = await callService(plan).catch(() => false);
    console.log(`[settings] ${dev.deviceId}: mat khau luong camera ${msg.enabled ? `BAT (ten "${String(msg.user).slice(0, 32)}")` : 'tat'} -> ${ok ? 'OK' : 'LOI'}`);
    setTimeout(() => { pushSettings(dev, tab, ok ? undefined : { ok: false, msg: 'Home Assistant không nhận lệnh (firmware chưa cập nhật?).' }).catch(() => { }); }, 1500);
    return;
  }
  if (msg.settings === 'wifi') {
    const r = await getSettingsView(dev.deviceId);
    if (!r.ok) return pushSettings(dev, tab);
    const plan = planWifi(r.view, msg.op, msg.ssid, msg.password);
    if (typeof plan === 'string') {
      console.warn(`[settings] ${dev.deviceId}: tu choi doi Wi-Fi: ${plan}`);
      return pushSettings(dev, tab, { ok: false, msg: plan === 'mat khau phai 8-63 ky tu' ? 'Mật khẩu Wi-Fi phải từ 8 đến 63 ký tự.' : 'Không đổi được Wi-Fi.' });
    }
    const ok = await callService(plan).catch(() => false);
    console.log(`[settings] ${dev.deviceId}: Wi-Fi ${msg.op === 'scan' ? 'quet mang' : `doi sang "${String(msg.ssid).slice(0, 32)}"`} -> ${ok ? 'OK' : 'LOI'}`);
    if (!ok) return pushSettings(dev, tab, { ok: false, msg: 'Home Assistant không nhận lệnh (firmware chưa cập nhật?).' });
    // Do that S3 08/10: quet mat ~6,5 s (13 kenh, ve kenh dang dung giua cac kenh) roi moi len HA -> doc lai sau 9 s.
    setTimeout(() => { pushSettings(dev, tab).catch(() => { }); }, msg.op === 'scan' ? 9000 : 1500);
    return;
  }
  if (msg.settings !== 'set' || typeof msg.id !== 'string') return;
  const res = await applySetting(dev, msg.id, msg.v);
  const note = res.ok ? undefined : { ok: false, msg: res.msg ?? 'Không đổi được cài đặt này.' };
  // Muc cua addon: doc lai ngay. Thuc the HA: doi thiet bi ESPHome ap dung + HA cap nhat trang thai roi moi doc lai.
  if (msg.id.startsWith('rwv.')) return pushSettings(dev, tab, note);
  setTimeout(() => { pushSettings(dev, tab, note).catch(() => { }); }, 600);
}

/** (16/10/2026) Doi MOT cai dat cua man (muc addon "rwv.*" hoac thuc the HA cua thiet bi) — dung chung cho ung dung Cai
 *  dat tren man va trang Dashboard → Màn hình (src/screenCtl.ts). */
async function applySetting(dev: DeviceSession, sid: string, v: unknown): Promise<{ ok: boolean; msg?: string }> {
  // (27/09/2026) Muc cua addon (id "rwv.*"): server tu luu, khong qua HA.
  if (sid.startsWith('rwv.')) {
    const ok = panelPrefs.set(dev.deviceId, sid, v);
    console.log(`[settings] ${dev.deviceId}: ${sid} = ${JSON.stringify(v)} ${ok ? 'OK' : 'TU CHOI'}`);
    if (ok && sid === 'rwv.saver_photos') {
      dev.saverPhotoAt = 0;
      if (!v) { dev.saverPhoto = null; showSaverPhoto(dev, null); }
      // (01/10/2026, nguoi dung yeu cau) Khung anh chi co y nghia khi man con sang: bat anh -> bat "No Sleep" (Màn hình
      // chờ), tat anh -> tat. Chi tac dong LUC GAT; sau do van doi rieng duoc. Qua HA nen chay ca firmware S3 (khong co
      // on_set_no_sleep).
      setNoSleepViaHa(dev, !!v).catch(() => { });
      setSaverPhotosSwitch(dev, !!v).catch(() => { });
    }
    // Doi nguon / album / kieu hien thi: ap dung ngay o lan doi anh ke tiep; album moi -> tai danh sach ngay.
    if (ok && sid === 'rwv.quality') {
      // (21/10/2026) Ap dung ngay, khong can noi lai WS / khoi dong lai man.
      const q0 = panelPrefs.qualityPct(dev.deviceId);
      const q = q0 && q0 > 0 ? q0 : undefined;   // 0 = tự động
      dev.qualityOverride = q;
      dev.lastAppliedQuality = undefined;
      if (q != null) {
        dev.processor.setTuning({ jpegQuality: q });
        dev.lastAppliedQuality = q;
        metrics.onAdaptiveChange(dev.deviceId, q, dev.tunedMinFrameIntervalMs ?? dev.cfg.minFrameInterval, 'nguoi dung dat');
        console.log(`[quality] ${dev.deviceId}: dat q=${q} (trang Dashboard)`);
        // (27/10/2026) Ap dung NGAY cho duong screencast dang chay (truoc day chi doi processor -> khung van la q cu).
        const qTab = dev.tabs.get(dev.activeTabKey);
        if (qTab?.screencastOn) setScreencastQuality(dev, qTab, q, 'nguoi dung dat');
      } else {
        console.log(`[quality] ${dev.deviceId}: TU DONG (bo muc dat tay)`);
      }
    }
    if (ok && (sid === 'rwv.gphotos_url' || sid === 'rwv.photo_source')) {
      dev.saverNav = undefined;
      albumItems(panelPrefs.albumUrl(GPHOTOS_ALBUM)).then((l) => console.log(`[photos] album Google Photos: ${l.length} anh`)).catch(() => { });
    }
    return ok ? { ok: true } : { ok: false, msg: 'Không đổi được cài đặt này.' };
  }
  const r = await getSettingsView(dev.deviceId);
  if (!r.ok) return { ok: false, msg: r.error };
  const plan = planSet(r.view, sid, v);
  if (typeof plan === 'string') {
    console.warn(`[settings] ${dev.deviceId}: tu choi ${sid}: ${plan}`);
    return { ok: false, msg: 'Không đổi được cài đặt này.' };
  }
  const ok = await callService(plan).catch(() => false);
  console.log(`[settings] ${dev.deviceId}: ${plan.domain}.${plan.service} ${sid} -> ${ok ? 'OK' : 'LOI'}`);
  return ok ? { ok: true } : { ok: false, msg: 'Home Assistant không nhận thay đổi.' };
}

/** (01/10/2026) Gat cong tac HA "Ảnh màn hình chờ" cua thiet bi cho khop Cai dat (khong co cong tac -> bo qua). */
async function setSaverPhotosSwitch(dev: DeviceSession, on: boolean): Promise<void> {
  dev.photoSwSeen = on;
  const r = await getSettingsView(dev.deviceId);
  if (!r.ok) return;
  const it = r.view.items.find((i) => i.kind === 'switch' && isSaverPhotosSwitchId(i.id) && !i.unavailable);
  if (!it || it.on === on) return;
  const ok = await callService({ domain: 'switch', service: on ? 'turn_on' : 'turn_off', data: { entity_id: it.id } }).catch(() => false);
  console.log(`[settings] ${dev.deviceId}: cong tac ${it.id} -> ${on ? 'bat' : 'tat'} ${ok ? 'OK' : 'LOI'}`);
}

/**
 * (01/10/2026) Dong bo HA -> Cai dat: nguoi dung gat "Ảnh màn hình chờ" tren HA -> ap vao tuy chon man hinh (nhu gat o
 * Cai dat, ke ca bat/tat "Màn hình chờ"). Lan dau thay cong tac: Cai dat dang co la goc, day sang HA. Moi 10 s, MOT lan doc
 * /states cho moi man hinh. Thiet bi chua co cong tac (firmware cu) -> bo qua.
 */
let photoSyncAt = 0;
async function syncSaverPhotoSwitches(): Promise<void> {
  if (!haReady() || Date.now() - photoSyncAt < 10_000 || devices.size === 0) return;
  photoSyncAt = Date.now();
  const [reg, states] = await Promise.all([getRegistry(), getStates()]);
  const byId = new Map(states.map((s) => [s.entity_id, s]));
  for (const dev of devices.values()) {
    const mac = macFromDeviceId(dev.deviceId);
    const hd = mac ? findDeviceByMac(reg.devices, mac) : undefined;
    if (!hd) continue;
    const ent = reg.entities.find((e) => e.device_id === hd.id && !e.disabled_by && isSaverPhotosSwitchId(e.entity_id));
    const st = ent ? byId.get(ent.entity_id) : undefined;
    if (!ent || !st || (st.state !== 'on' && st.state !== 'off')) continue;
    const haOn = st.state === 'on';
    const prefOn = panelPrefs.saverPhotos(dev.deviceId, SCREENSAVER_PHOTOS);
    if (dev.photoSwSeen === undefined) {
      dev.photoSwSeen = prefOn;
      if (haOn !== prefOn) setSaverPhotosSwitch(dev, prefOn).catch(() => { });
      continue;
    }
    if (haOn === dev.photoSwSeen) continue;
    dev.photoSwSeen = haOn;
    if (haOn === prefOn) continue;
    const ok = panelPrefs.set(dev.deviceId, 'rwv.saver_photos', haOn);
    console.log(`[settings] ${dev.deviceId}: HA ${ent.entity_id} = ${haOn ? 'bat' : 'tat'} -> anh man hinh cho ${ok ? 'OK' : 'TU CHOI'}`);
    if (!ok) continue;
    dev.saverPhotoAt = 0;
    if (!haOn) { dev.saverPhoto = null; showSaverPhoto(dev, null); }
    setNoSleepViaHa(dev, haOn).catch(() => { });
  }
}

async function setNoSleepViaHa(dev: DeviceSession, on: boolean): Promise<void> {
  const r = await getSettingsView(dev.deviceId);
  if (!r.ok) return;
  const it = findNoSleepSwitch(r.view);
  if (!it || it.on === on) return;
  const plan = planSet(r.view, it.id, on);
  if (typeof plan === 'string') return;
  const ok = await callService(plan).catch(() => false);
  console.log(`[settings] ${dev.deviceId}: anh man hinh cho ${on ? 'bat' : 'tat'} -> No Sleep ${on ? 'bat' : 'tat'} (${it.id}) ${ok ? 'OK' : 'LOI'}`);
}

// (30/09/2026) Doc lai select "Nguon phat hien nguoi" tu HA (moi lan mo thanh trang thai, toi da moi `minAgeMs`).
async function refreshPresenceSel(dev: DeviceSession, minAgeMs: number): Promise<void> {
  if (dev.presenceSel && Date.now() - dev.presenceSel.at < minAgeMs) return;
  const r = await getSettingsView(dev.deviceId);
  if (!r.ok) return;
  const it = findPresenceSelect(r.view);
  const next = it ? { id: it.id, v: it.value, o: it.options ?? [], at: Date.now() } : null;
  const changed = JSON.stringify(next && { ...next, at: 0 }) !== JSON.stringify(dev.presenceSel && { ...dev.presenceSel, at: 0 });
  dev.presenceSel = next;
  if (changed) pushDeviceStateToPage(dev);
}

async function setPresenceSel(dev: DeviceSession, v: string): Promise<void> {
  const r = await getSettingsView(dev.deviceId);
  if (!r.ok) return;
  const it = findPresenceSelect(r.view);
  if (!it) return;
  const plan = planSet(r.view, it.id, v);
  if (typeof plan === 'string') { console.warn(`[presence] ${dev.deviceId}: tu choi "${v}": ${plan}`); return; }
  const ok = await callService(plan).catch(() => false);
  console.log(`[presence] ${dev.deviceId}: nguon phat hien nguoi = "${v}" -> ${ok ? 'OK' : 'LOI'}`);
  if (ok && dev.presenceSel) { dev.presenceSel = { ...dev.presenceSel, v, at: Date.now() }; }
  pushDeviceStateToPage(dev);
  setTimeout(() => { refreshPresenceSel(dev, 0).catch(() => { }); }, 1500);
}

/** Cham the thong bao: mo ung dung / URL kem theo, bo khoi lich su. */
function openNotice(dev: DeviceSession, id: number): void {
  const n = noticesOf(dev.deviceId).get(id);
  if (!n) return;
  noticesOf(dev.deviceId).remove(id);
  pushDeviceStateToPage(dev);
  if (n.app && n.arg) noticeArgHook?.(dev.deviceId, n.app, n.arg);
  if (n.app) openApp(dev, n.app).catch(() => { });
  else if (n.url) navigateToUrl(dev, n.url).catch(() => { });
}

// (01/10/2026) Cham thong bao co tham so (Tin nhan: id cuoc tro chuyen) -> ung dung tu mo dung muc (src/chat.ts).
let noticeArgHook: ((deviceId: string, app: string, arg: string) => void) | null = null;
export function setNoticeArgHook(fn: (deviceId: string, app: string, arg: string) => void): void { noticeArgHook = fn; }

/** (01/10/2026) Man hinh dang ket noi — cho Tin nhan (ten lay tu HA o index.ts). */
export function connectedScreens(): { id: string; w: number; h: number; cam: boolean; sd: boolean; spk: boolean; mic: boolean }[] {
  return [...devices.values()].filter((d) => broadcaster.getClientCount(d.deviceId) > 0)
    .map((d) => ({ id: d.deviceId, w: d.cfg.width, h: d.cfg.height, cam: d.cfg.camPort > 0, sd: d.cfg.camPort > 0 || d.cfg.sdPort > 0, spk: !!d.cfg.audioEnabled, mic: !!d.cfg.micCall }));
}

/**
 * (13/10/2026) Trang Dashboard (the IPTV): nut "phat tren man" — mo 1 URL tren cac man da chon.
 * `urlOf(deviceId)` tra URL RIENG cho tung man (trang iptv.html can ?dev=<id> de nho kenh xem cuoi theo man).
 * Chi gui cho man DANG ket noi (khong co client thi navigateToUrl vo nghia). Tra ve danh sach man da gui.
 */
export function castUrlToDevices(ids: string[], urlOf: (deviceId: string) => string): { ok: boolean; sent: string[]; error?: string } {
  const sent: string[] = [];
  for (const id of ids) {
    const dev = devices.get(id);
    if (!dev || broadcaster.getClientCount(id) === 0) continue;
    const url = urlOf(id);
    if (!/^https?:\/\//i.test(url) || url.length > 2048) continue;
    navigateToUrl(dev, url).catch((e: unknown) => console.warn(`[cast] ${id}: mo URL that bai:`, e));
    sent.push(id);
  }
  return sent.length ? { ok: true, sent } : { ok: false, sent, error: 'khong co man hinh nao dang ket noi' };
}
/** (16/10/2026) Tab IPTV cua man (ung dung 'iptv' hoac trang iptv.html mo qua "Phát trên màn"). */
function iptvTabOf(dev: DeviceSession): Tab | undefined {
  return dev.tabs.get('iptv') ?? [...dev.tabs.values()].find((t) => t.kind === 'iptv' || /\/iptv\.html/.test(t.url));
}
/** (16/10/2026) Trang thai IPTV tung man cho trang Dashboard → IPTV: mo?, dang hien?, dang phat? */
export function iptvStatus(deviceId: string): { open: boolean; active: boolean; playing: boolean } {
  const dev = devices.get(deviceId), t = dev && iptvTabOf(dev);
  if (!dev || !t) return { open: false, active: false, playing: false };
  return { open: true, active: dev.activeTabKey === t.key, playing: t.mediaPlaying };
}
/** (16/10/2026) Trang Dashboard → IPTV: 'home' = ve man chinh (IPTV vao nen, ngung phat); 'stop' = ve man chinh + DONG tab IPTV. */
export async function iptvControl(deviceId: string, act: 'stop' | 'home'): Promise<boolean> {
  const dev = devices.get(deviceId);
  if (!dev) return false;
  const t = iptvTabOf(dev);
  if (!t) { if (act === 'home') await openApp(dev, 'home'); return act === 'home'; }
  if (dev.activeTabKey === t.key) await openApp(dev, 'home');
  if (act === 'stop') closeTab(dev, t.key, 'dung IPTV tu trang Dashboard');
  console.log(`[iptv] ${deviceId}: ${act === 'stop' ? 'dung IPTV' : 've man chinh'} (trang Dashboard)`);
  return true;
}

/** Ung dung `key` dang la tab hien tren man hinh (va den nen dang bat). */
/** (02/10/2026) Man hinh dang phat video/am thanh — Quan ly file tam dung day tep len the de video khong giat. */
export function isMediaPlaying(deviceId: string): boolean {
  return devices.get(deviceId)?.mediaSent === true;
}

export function isAppShowing(deviceId: string, key: string): boolean {
  const d = devices.get(deviceId);
  return !!d && d.activeTabKey === key && (d.devState ? d.devState.backlightOn : true);
}

/**
 * (01/10/2026) Nguoi dung DANG XEM ung dung `key` tren man hinh nay: dang hien, KHONG bi man hinh cho de len, va co CHAM
 * that (lastInputMs — khong tinh danh thuc do thong bao) trong `withinMs`. Tin nhan: nguoi dung bao mo Tin nhan, man
 * hinh cho de len -> tin moi khong thong bao (truoc day chi xet tab + den nen).
 */
export function isUserViewing(deviceId: string, key: string, withinMs = 120_000): boolean {
  const d = devices.get(deviceId);
  return !!d && isAppShowing(deviceId, key) && !d.saverOn && d.lastInputMs != null && Date.now() - d.lastInputMs < withinMs;
}

onWeatherMiniUpdate(() => { for (const d of devices.values()) pushDeviceStateToPage(d); });

/** Thiet bi bao DeviceState -> luu lai, dua vao trang dang mo. */
export function onDeviceStatePacket(dev: DeviceSession, buf: Buffer): void {
  const st = parseDeviceStatePacket(buf);
  if (!st) return;
  const wasOff = dev.devState ? !dev.devState.backlightOn : false;
  dev.devState = { ...st, receivedAt: Date.now() };
  if (!dev.lockDim) {
    const p = lockBrightLoad(dev.deviceId);
    if (p != null) {
      dev.lockDim = { prev: p };
      // (16/10/2026) Addon vua khoi dong lai giua luc man dang giam sang (man khoa / cho) nhung phien moi KHONG o man hinh
      // cho -> tra lai do sang ngay. Truoc day man cu sang 5% toi lan man hinh cho ke tiep (do that P4 sau cap nhat addon).
      if (!dev.saverOn) restoreBright(dev);
    }
  }
  if (wasOff && st.backlightOn) noteActivity(dev, 'den nen vua bat');
  pushDeviceStateToPage(dev);
}

/**
 * Dua trang thai thiet bi vao launcher cua trang dang mo. Gio: gui DO LECH so voi dong ho server (skewMs) + mui gio
 * cua thiet bi -> trang tu tinh gio THIET BI moi giay ma khong can thiet bi gui lien tuc.
 */
function pushDeviceStateToPage(dev: DeviceSession): void {
  const s = dev.devState;
  const payload = {
    b: s?.brightness ?? null, v: s?.volume ?? null, on: s?.backlightOn ?? false, ctl: !!s && !!dev.cfg.devControl,
    tv: !!s?.timeValid, skewMs: s?.timeValid ? s.epoch * 1000 - s.receivedAt : 0, tz: s?.tzOffsetMin ?? 0,
    tg: s?.toggles ?? null,
    wx: getWeatherMini(),
    tm: dev.timer ? { endsAt: dev.timer.endsAt, label: dev.timer.label } : null,
    np: nowPlaying(dev.tabs.values(), dev.activeTabKey),
    nt: noticesOf(dev.deviceId).list(8).map(noticeForShell),
    // (01/10/2026) So CHUA XEM rieng man hinh nay: cu = tin nhan chua doc, nu = thong bao thuong chua xem.
    cu: chatUnread(dev.deviceId).total,
    nu: noticesOf(dev.deviceId).unseen('nt'),
    // (01/10/2026) Am thanh kieu dien thoai: snd = firmware tu phat am (co 3 loai am luong); sv = am luong Thong bao /
    // Bao thuc (%); al = bao thuc ke tiep cua man hinh nay; rg = dang reo (Shell hien lai man hinh bao thuc neu trang tai lai).
    snd: canPlay(dev),
    sv: soundPrefs.get(dev.deviceId),
    al: (() => { const nx = alarms.next(Date.now(), anyTzOffset(), dev.deviceId); return nx ? { t: nx.time, at: nx.at, l: nx.label } : null; })(),
    rg: (() => { const r = alarms.ringingOn(dev.deviceId); return r ? ringingForShell(r) : null; })(),
    dnd: dndOf(dev.deviceId),
    va: !!dev.cfg.voice && !!dev.cfg.devControl,
    pr: dev.presence ?? null,
    ps: dev.presenceSel ? { v: dev.presenceSel.v, o: dev.presenceSel.o } : null,
    // (08/10/2026) Widget man hinh khoa / cho (src/lockWidgets.ts): so lieu tho, Shell tu viet chu theo gio thiet bi.
    lw: lockWidgetsFor(dev.deviceId, panelPrefs.lockWidgets(dev.deviceId)),
    // (08/10/2026) Pin ben trai, mang ben phai dong ho.
    sb: dev.sb ? { nw: dev.sb.nw, bt: dev.sb.bt, ...(dev.sb.ch ? { ch: dev.sb.ch } : {}) } : null,
  };
  if (dev.presenceSel === undefined) { dev.presenceSel = null; refreshPresenceSel(dev, 0).catch(() => { }); }
  dev.cdp.send('Runtime.evaluate', {
    expression: `(window.__rwvShell ? window.__rwvShell.state : window.__rwvDeviceState || function(){})(${JSON.stringify(payload)})`,
  }).catch(() => { });
}

/**
 * Dang ky lai script launcher (ap dung tu lan dieu huong ke tiep) VA thay ngay tren trang dang mo. Dung khi homeUrl
 * doi hoac khi nguoi dung luu cau hinh menu (trang "Menu panel").
 */
async function reloadLauncherTab(device: DeviceSession, tab: Tab): Promise<boolean> {
  // (30/09/2026) Trang dong bang khong chay Runtime.evaluate (lenh treo cho toi khi bo dong bang) -> bo tam, nap, dong lai.
  const wasFrozen = !!tab.frozen;
  await thawTab(tab);
  try {
    // (26/09/2026 OS-2) launcherScriptId gio la CUA TUNG TAB (moi tab la mot session/target rieng) — xem
    // reloadAllLaunchers() ben duoi, goi ham nay cho MOI tab dang mo cua thiet bi.
    // (01/10/2026) "Script not found" (ma script cu da mat — vd renderer vua chet/noi lai) truoc day lam HUY ca lan nap
    // lai (log that 01/10). Bo qua loi go script cu, van dang ky script moi.
    if (tab.launcherScriptId) {
      await tab.session.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: tab.launcherScriptId }).catch(() => { });
    }
    const src = buildLauncherScript(device.cfg.homeUrl, device.cfg);
    const { identifier } = await tab.session.send('Page.addScriptToEvaluateOnNewDocument', { source: src });
    tab.launcherScriptId = identifier;
    // Don Shell CU tren trang DANG MO cua tab nay roi chay lai (script moi chi tu ap dung tu lan navigate ke tiep).
    await tab.session.send('Runtime.evaluate', {
      expression:
        `(function(){` +
        `document.querySelectorAll('rwv-shell').forEach(function(x){x.remove();});` +
        `window.__launcherInitialized=false; window.__rwvShell=undefined;` +
        `})();` + src,
    });
    if (wasFrozen) freezeTab(device, tab);
    return true;
  } catch (e) {
    console.warn(`[device] ⚠️ Khong nap lai duoc Shell cho ${device.deviceId} (tab "${tab.key}"):`, e);
    return false;
  }
}

function homeLayoutFor(homeUrl: string | undefined, hasCamera = true, hasSd = hasCamera): HomeLayout {
  return resolveLayout(getLauncherConfig().home, buildLauncherApps(homeUrl, hasCamera, hasSd).map((a) => a.id));
}

/**
 * (27/09/2026 OS-3) Bo cuc vua doi: ap cho MOI man hinh. Tab he thong (man hinh chinh) ve lai ngay; moi tab thay
 * script tiem (trong do co __RWV_CFG) de lan tai trang sau khong quay ve bo cuc cu. `except` = man hinh vua keo tha
 * (no da tu ve dung), van thay script nhung khong ve lai.
 */
async function applyHomeLayout(except?: DeviceSession): Promise<void> {
  for (const dev of devices.values()) {
    const src = buildLauncherScript(dev.cfg.homeUrl, dev.cfg);
    const layout = JSON.stringify(homeLayoutFor(dev.cfg.homeUrl, dev.cfg.camPort > 0, dev.cfg.camPort > 0 || dev.cfg.sdPort > 0));
    for (const tab of dev.tabs.values()) {
      try {
        if (tab.launcherScriptId) await tab.session.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: tab.launcherScriptId });
        tab.launcherScriptId = (await tab.session.send('Page.addScriptToEvaluateOnNewDocument', { source: src })).identifier;
        if (tab.kind === 'system' && dev !== except) {
          // (30/09/2026) Tab dang tam dung (nen): evaluate se treo -> bo tam, ve lai, dung lai.
          const wasFrozen = !!tab.frozen;
          await thawTab(tab);
          await tab.session.send('Runtime.evaluate', { expression: `window.__rwvShell && window.__rwvShell.layout && window.__rwvShell.layout(${layout})` });
          if (wasFrozen) freezeTab(dev, tab);
        }
      } catch { /* tab dang dong */ }
    }
  }
}

async function reloadLauncher(device: DeviceSession): Promise<boolean> {
  let ok = true;
  for (const tab of device.tabs.values()) {
    if (!(await reloadLauncherTab(device, tab))) ok = false;
  }
  return ok;
}

/** (25/09/2026) Sau khi luu cau hinh menu: nap lai launcher tren moi man hinh. */
export async function reloadAllLaunchers(): Promise<number> {
  let n = 0;
  for (const dev of devices.values()) if (await reloadLauncher(dev)) n++;
  return n;
}

/** homeUrl cua mot thiet bi dang ket noi (de trang cau hinh hien du ung dung HA). */
export function anyHomeUrl(): string | undefined {
  for (const dev of devices.values()) if (dev.cfg.homeUrl) return dev.cfg.homeUrl;
  return undefined;
}

/**
 * (25/09/2026) Muc chuyen dong cua Shell theo man hinh: moi khung dong la bang thong WiFi toi panel.
 *   full = ESP32-P4 1024x600 (~28 khung/s, giai ma phan cung): thanh keo theo ngon, truot trang.
 *   reduced = S3 480x480 (giai ma phan mem ~63 ms): mo/dong nhay thang.  minimal = S3 480x272.
 */
function shellMotion(cfg: DeviceConfig | undefined): 'full' | 'reduced' | 'minimal' {
  if (!cfg) return 'full';
  if (cfg.fbBands || cfg.width >= 800) return 'full';
  return Math.min(cfg.width, cfg.height) <= 300 ? 'minimal' : 'reduced';
}

/**
 * (25/09/2026) Script tiem vao MOI trang cua panel: am lich + cau hinh + SHELL (giao dien he thong, src/shell/,
 * dong goi bang esbuild thanh dist/shell.bundle.js). Thay launcher popup cu (chuoi JS ~500 dong trong file nay).
 */
export function buildLauncherScript(homeUrl: string | undefined, devCfg?: DeviceConfig): string {
  const hasCamera = !devCfg || devCfg.camPort > 0;
  const hasSd = hasCamera || (devCfg?.sdPort ?? 0) > 0;   // (09/10/2026) S3 co the nho: Thu vien + Quan ly file
  const cfg = {
    apps: buildLauncherApps(homeUrl, hasCamera, hasSd),
    home: homeLayoutFor(homeUrl, hasCamera, hasSd),
    groups: Object.entries(GROUP_TITLES),
    motion: shellMotion(devCfg),
    urls: {
      osHome: LAUNCHER_OS_HOME_URL, ha: homeUrl || '', weather: LAUNCHER_WEATHER_URL, timer: LAUNCHER_TIMER_URL,
      cams: LAUNCHER_CAMS_URL,
    },
    bindings: { url: URL_BINDING, control: CONTROL_BINDING },
  };
  return `${LUNAR_JS}\n;window.__RWV_CFG = ${JSON.stringify(cfg)};\n${loadShellJs()}`;
}

let shellJsCache: string | null = null;
/** dist/shell.bundle.js (npm run build). Chua co (chay test/dev tu src) -> dong goi tai cho bang esbuild. */
function loadShellJs(): string {
  if (shellJsCache != null) return shellJsCache;
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const p of [path.join(here, 'shell.bundle.js'), path.join(here, '..', 'dist', 'shell.bundle.js')]) {
    try { shellJsCache = fs.readFileSync(p, 'utf8'); return shellJsCache; } catch { /* thu duong khac */ }
  }
  try {
    const esbuild = createRequire(import.meta.url)('esbuild');
    const out = esbuild.buildSync({
      entryPoints: [path.join(here, 'shell', 'main.ts')], bundle: true, format: 'iife', target: 'chrome120', write: false,
    });
    shellJsCache = out.outputFiles[0].text as string;
  } catch (e) {
    console.error('[shell] khong co dist/shell.bundle.js va khong dong goi duoc:', (e as Error).message);
    shellJsCache = '';
  }
  return shellJsCache!;
}

/** (26/09/2026 OS-2) Ve Home cua OS: mo/kich hoat tab '__system' (ghim — tao lan dau thi giu luon, khong tai lai
 * nhung lan sau). Goi tu cu chi vuot len tu mep duoi (inputRouter.ts) va nut/bieu tuong "Ung dung" trong Shell. */
export function goOsHome(dev: DeviceSession): void {
  // (27/10/2026) Đang ở tab hệ thống thì openApp() → activateTab() RETURN SỚM (không gửi gì xuống Shell),
  // nên lớp "Gần đây" / bảng điều khiển còn nguyên trên màn. Bảo Shell tự đóng chúng lại.
  if (dev.activeTabKey === '__system') {
    dev.cdp.send('Runtime.evaluate', {
      expression: 'window.__rwvShell && window.__rwvShell.home && window.__rwvShell.home()',
    }).catch(() => { });
    return;
  }
  openApp(dev, '__system').catch((e: unknown) => console.warn(`[shell] ${dev.deviceId}: ve Home that bai:`, e));
}

/**
 * (26/09/2026 OS-3) "Quay lai" (cu chi vuot tu mep trai/phai): ve muc truoc trong lich su cua TAB dang hien — gom ca
 * chuyen trang trong dashboard HA (history.pushState). Het lich su (dang o trang dau cua ung dung) -> ve man hinh chinh,
 * nhu Android. O chinh man hinh chinh thi khong lam gi.
 */
export function goBack(dev: DeviceSession): void {
  dev.tabOps.run(async () => {
    if (devices.get(dev.deviceId) !== dev) return;
    const tab = dev.tabs.get(dev.activeTabKey);
    if (!tab || tab.key === '__system') return;
    // (01/10/2026) YouTube TV chi nghe phim remote: dang trong video / tim kiem... (hash khac "#/") -> phim Back (Escape,
    // do that: tu #/watch ve #/); dang o trang chu YouTube TV -> ra man hinh chinh nhu ung dung tren dien thoai.
    if (tab.kind === 'yttv') {
      const r = await tab.session.send('Runtime.evaluate', { expression: 'location.hash', returnByValue: true }).catch(() => null) as
        { result?: { value?: unknown } } | null;
      const hash = typeof r?.result?.value === 'string' ? r.result.value : '';
      if (hash && hash !== '#/' && hash !== '#') {
        const ev = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 };
        await tab.session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...ev });
        await tab.session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...ev });
        console.log(`[app] ${dev.deviceId}: quay lai trong YouTube TV (${hash.slice(0, 30)})`);
        return;
      }
      await openAppNow(dev, '__system');
      return;
    }
    const h = await tab.session.send('Page.getNavigationHistory') as { currentIndex: number; entries: { id: number; url: string }[] };
    const prev = h.currentIndex > 0 ? h.entries[h.currentIndex - 1] : undefined;
    // Muc 'about:blank' dau lich su la trang trang luc tao tab (createTab), khong phai trang nguoi dung da xem.
    if (prev && prev.url && prev.url !== 'about:blank') {
      await tab.session.send('Page.navigateToHistoryEntry', { entryId: prev.id });
      console.log(`[app] ${dev.deviceId}: quay lai ${prev.url} (tab "${tab.key}")`);
    } else {
      await openAppNow(dev, '__system');
    }
  }).catch((e: unknown) => console.warn(`[app] ${dev.deviceId}: quay lai that bai:`, e));
}

// (26/09/2026 OS-2) So tab KHONG GHIM toi da moi thiet bi (Home Assistant + man hinh chinh luon duoc GHIM, khong
// tinh vao day). Tab dang active hoac dang phat am thanh nen (radio/nhac) khong bao gio bi don. Moi tab la mot tien
// trinh renderer Chromium song rieng — RAM addon da do thuc te ~1,1 GB/3 man hinh o che do MOT tab; gia tri nay giu
// muc tang RAM trong tam kiem soat khi mo them ung dung. Chinh qua bien moi truong neu may chu du RAM.
/** (09/10/2026) Quyen + vi tri (nha trong HA) cho mot tab. Loi (Chrome cu / chua co vi tri) -> bo qua. */
async function grantGeolocation(root: CDPRoot, session: CDPSession): Promise<void> {
  try {
    await root.send('Browser.grantPermissions', { permissions: ['geolocation'] });
    const l = haLocationCached() ?? await getHaLocation();
    if (l) await session.send('Emulation.setGeolocationOverride', { latitude: l.lat, longitude: l.lon, accuracy: 50 });
  } catch { /* bo qua */ }
}
/** (09/10/2026) Trang mo dau cua ung dung Chrome. */
const BROWSER_START_URL = process.env.BROWSER_START_URL || 'https://www.google.com/';
const MAX_APP_TABS = Math.max(0, parseInt(process.env.MAX_APP_TABS ?? '2', 10) || 2);

/** Ung dung nguoi dung co the "mo" tu Shell (khong ke Home Assistant/man hinh chinh, xu ly rieng o day). */
function resolveAppSpec(dev: DeviceSession, key: string): { kind: string; label: string; url: string; pinned: boolean } | null {
  if (key === '__system') return { kind: 'system', label: 'Màn hình chính', url: LAUNCHER_OS_HOME_URL, pinned: true };
  if (key === 'home') return dev.cfg.homeUrl ? { kind: 'ha', label: 'Home Assistant', url: dev.cfg.homeUrl, pinned: true } : null;
  if (key === '__doorbell') return dev.doorbell ? { kind: 'doorbell', label: 'Chuông cửa', url: dev.doorbell.url, pinned: false } : null;
  if (key === 'yttv') return { kind: 'yttv', label: 'YouTube TV', url: dev.castUrl ?? YT_TV_URL, pinned: false };
  // (09/10/2026) Ung dung Chrome = tab 'browser' (cung tab nhan URL ngoai ung dung): co roi thi chuyen sang, chua co -> Google.
  if (key === 'browser') {
    const a = listAllApps(dev.cfg.homeUrl).find((x) => x.id === 'browser');
    return a && !a.hidden ? { kind: 'browser', label: a.label, url: BROWSER_START_URL, pinned: false } : null;
  }
  const app = listAllApps(dev.cfg.homeUrl).find((a) => a.id === key && !a.hidden);
  if (!app || !app.url) return null;
  // (01/10/2026) Tin nhan can biet DANG chay tren man hinh nao (src/chat.ts nhan dien bang ?dev=). (07/10/2026) + IPTV:
  // nho kenh xem cuoi rieng tung man hinh.
  // (09/10/2026) + Camera / Thu vien / Quan ly file: nha nhieu P4 — trang gui ?rwvdev de dung camera CUA man nay (camProxy).
  // (14/10/2026) + Media: the nho CUA man nay, bai dang nghe nho theo man, an loa cua chinh man trong "Phát trên".
  if (key === 'chat' || key === 'alarm' || key === 'iptv' || key === 'camera' || key === 'gallery' || key === 'files' || key === 'media' || key === 'call' || key === 'doorlog') {
    // (24/10/2026) Camera: truyen goc xoay xuong trang de xoay noi dung video cho dung chieu
    // (khung anh da duoc server xoay; video la luong ngang co dinh nen phai bu -rot trong trang).
    const q = app.url.includes('?') ? '&' : '?';
    const extra = (key === 'camera' || key === 'gallery' || key === 'call') ? `rot=${dev.cfg.rotation ?? 0}` : '';
    return { kind: app.baseKind, label: app.label,
             url: app.url + q + 'dev=' + encodeURIComponent(dev.deviceId) + (extra ? '&' + extra : ''), pinned: false };
  }
  // baseKind, KHONG phai kind: nguoi dung doi bieu tuong o "Menu panel" thi kind thanh 'mdi' -> Radio/Nhac mat phat
  // nen, YouTube/TikTok khong tu dung khi roi tab (activateTab dua vao loai ung dung goc).
  return { kind: app.baseKind, label: app.label, url: app.url, pinned: false };
}

/**
 * (26/09/2026 OS-2) Mo mot ung dung: neu tab da co thi CHUYEN SANG NGAY (khong tai lai — tab van "am" trong luc
 * khong active), chua co thi tao roi chuyen sang. Goi tu Shell (thanh truot/nut/luoi ung dung goi CONTROL_BINDING
 * {app:key} — xem handleMenuControl) va tu goOsHome().
 */
function openApp(dev: DeviceSession, key: string): Promise<void> {
  return dev.tabOps.run(() => openAppNow(dev, key));
}

async function openAppNow(dev: DeviceSession, key: string): Promise<void> {
  if (devices.get(dev.deviceId) !== dev) return;  // phien da bi xoa trong luc lenh nay xep hang
  noteActivity(dev, `mo ung dung ${key}`);
  let tab = dev.tabs.get(key);
  if (!tab) {
    const ghost = dev.closedRecents?.get(key);
    const spec = resolveAppSpec(dev, key);
    if (!spec) {
      // Tab "Trinh duyet" da dong vi RAM: mo lai dung URL cu qua duong URL thuong.
      if (ghost?.url) { dev.closedRecents!.delete(key); return navigateToUrlNow(dev, ghost.url); }
      console.warn(`[app] ${dev.deviceId}: khong biet ung dung "${key}"`); return;
    }
    tab = await createTab(dev, key, spec.kind, spec.pinned, spec.label);
    if (devices.get(dev.deviceId) !== dev) { closeTab(dev, key, 'phien thiet bi da bi xoa'); return; }
    // Bat screencast TRUOC (tren trang trang, an toan) roi moi dieu huong cheo nguon — xem createTab().
    await activateTab(dev, key);
    await navigateTab(dev, tab, ghostUrlFor(ghost?.url, spec.url) ?? spec.url);
  } else {
    await activateTab(dev, key);
    // (24/10/2026) Camera/Thu vien/Goi: goc xoay co the doi sau khi tab da mo -> nap lai URL de cap nhat ?rot=
    const spec2 = resolveAppSpec(dev, key);
    if (spec2 && (key === 'camera' || key === 'gallery' || key === 'call') && tab.url !== spec2.url) {
      await navigateTab(dev, tab, spec2.url);
    }
  }
  evictIfNeeded(dev);
}

/**
 * (26/09/2026 OS-2) Don tab CU NHAT khong ghim/khong active/khong dang phat am thanh nen, cho toi khi ve duoi
 * MAX_APP_TABS hoac het ung vien (co the tam vuot han muc neu tat ca tab con lai deu duoc mien don — chap nhan
 * duoc, uu tien khong lam gian doan am thanh dang phat hon la giu dung han muc tuyet doi).
 */
function evictIfNeeded(dev: DeviceSession): void {
  const b = currentTabBudget();
  for (const key of pickEvictions(dev.tabs.values(), dev.activeTabKey, b.maxAppTabs)) {
    retireTab(dev, key, b.low ? 'qua so tab toi da (may chu thieu RAM)' : 'qua so tab toi da');
  }
}

// (30/09/2026) NGAN SACH RAM MAY CHU. Do 30/09: may HASS 10 GB, swap da dung ~2,9/3,3 GB (Frigate 2,4 GB + addon 1,7 GB);
// tab nen bi tam dung JS (2.9.65) het ton CPU nhung van giu nguyen RAM renderer. Them:
//   - tab nen khong dung qua IDLE_TAB_CLOSE_MIN phut (mac dinh 5, truoc 01/10 la 20; 0 = tat) -> DONG HAN, van con trong "Gan day"
//     (anh + URL cu, cham = mo lai dung trang) — xem pickIdleCloses (tabPolicy.ts);
//   - MemAvailable < LOW_MEM_MB (mac dinh 600) -> chi giu 1 ung dung nen, dong tab nhan roi sau 2 phut (tabBudget).
// So lieu RAM/swap may chu nam trong /metrics (host).
const IDLE_TAB_CLOSE_MS = Math.max(0, Number(process.env.IDLE_TAB_CLOSE_MIN ?? '5') || 0) * 60_000;
const LOW_MEM_MB = Math.max(0, Number(process.env.LOW_MEM_MB ?? '600') || 0);
let hostMemCache: { at: number; v: ReturnType<typeof parseMeminfo> } = { at: 0, v: null };

/** (30/09/2026) Bo dem duong di cua khung theo thiet bi — cho /metrics (pipeline). */
export function pipelineStats(): Record<string, Record<string, unknown>> {
  const o: Record<string, Record<string, unknown>> = {};
  for (const d of devices.values()) {
    o[d.deviceId] = { passthrough: d.passthroughFrames, fit: d.fitFrames ?? 0, half: d.halfFrames, slow: d.slowFrames ?? 0,
      slowWhy: d.slowWhy ?? null, scQuality: d.tabs.get(d.activeTabKey)?.scQuality ?? null };
  }
  return o;
}

/** RAM/swap may chu (doc /proc/meminfo, cache 5 s). Container addon thay dung so lieu cua may HASS. */
export function hostMem(): ReturnType<typeof parseMeminfo> {
  const now = Date.now();
  if (now - hostMemCache.at > 5_000) {
    let v: ReturnType<typeof parseMeminfo> = null;
    try { v = parseMeminfo(fs.readFileSync('/proc/meminfo', 'utf8')); } catch { /* khong phai Linux */ }
    hostMemCache = { at: now, v };
  }
  return hostMemCache.v;
}

function currentTabBudget(): ReturnType<typeof tabBudget> {
  return tabBudget(hostMem()?.availMb ?? null, LOW_MEM_MB, MAX_APP_TABS, IDLE_TAB_CLOSE_MS);
}

/** Dong tab de tiet kiem RAM nhung GIU the trong "Gan day" (anh thu nho + URL) de mo lai dung cho cu. */
function retireTab(dev: DeviceSession, key: string, reason: string): void {
  const tab = dev.tabs.get(key);
  if (!tab) return;
  if (!tab.pinned && tab.kind !== 'yttv' && tab.kind !== 'doorbell' && !isCameraTab(tab)) {
    const g = (dev.closedRecents ??= new Map());
    g.set(key, { label: tab.label, thumb: tab.thumb, url: tab.url, lastUsed: tab.lastUsed });
    // Giu toi da 6 the cu nhat da dong.
    for (const k of [...g.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed).slice(0, Math.max(0, g.size - 6)).map((e) => e[0])) g.delete(k);
  }
  closeTab(dev, key, reason);
}

/** Moi 5 s (screensaverTick): dong tab nen nhan roi qua han (xem IDLE_TAB_CLOSE_MS / tabBudget). */
function closeIdleTabs(dev: DeviceSession, now: number): void {
  const b = currentTabBudget();
  if (pickIdleCloses(dev.tabs.values(), dev.activeTabKey, now, b.idleMs).length === 0) return;
  dev.tabOps.run(async () => {
    const keys = pickIdleCloses(dev.tabs.values(), dev.activeTabKey, Date.now(), b.idleMs);
    const mins = Math.round(b.idleMs / 60_000);
    for (const k of keys) retireTab(dev, k, `khong dung qua ${mins} phut${b.low ? ', may chu thieu RAM' : ''}`);
    if (keys.length) { pushDeviceStateToPage(dev); await showRecents(dev, false); }
  }).catch(() => { });
}

/**
 * (26/09/2026 OS-3) Chup anh thu nho cua MOT tab (JPEG ~320 px ngang, ~10 KB) cho man hinh "Gan day". Goi luc tab
 * sap roi man hinh (activateTab) — luc do trang con dang dung dung trang thai nguoi dung vua thay. Toi da 1,5 s.
 */
async function captureThumb(dev: DeviceSession, tab: Tab): Promise<void> {
  // (27/10/2026) FIX 'hinh bi co nho sau khi bam Gan day': truoc day chup bang
  //   Page.captureScreenshot({ clip:{..., scale: 320/width} })
  // Tren Chromium headless, captureScreenshot co clip.scale lam surface/screencast lech kich thuoc: cac khung
  // screencast sau do ra dung 320x188 (dung bang ti le 320/1024) va panel ve anh nho vao goc trai khung day.
  // Thinh thoai moi bi (tuy luc capture chen vao nhip screencast) — dung khop voi bao cao "thinh thoang".
  // Nay: thu nho TU KHUNG VUA GUI bang sharp (khong dung CDP), chi khi khong co khung moi dung captureScreenshot
  // TOAN KHUNG (khong clip/scale) — dung cach the dieu khien van lam moi 55 ms ma khong gay loi.
  try {
    if (dev.lastFrameB64) {
      const b = await sharp(Buffer.from(dev.lastFrameB64, 'base64'))
        .resize(320, null, { withoutEnlargement: true }).jpeg({ quality: 60 }).toBuffer();
      tab.thumb = 'data:image/jpeg;base64,' + b.toString('base64');
      return;
    }
  } catch { /* roi ve cach cu */ }
  try {
    const r = await Promise.race([
      tab.session.send('Page.captureScreenshot', { format: 'jpeg', quality: 60 }) as Promise<{ data: string }>,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('het gio')), 1500)),
    ]);
    if (r?.data) tab.thumb = 'data:image/jpeg;base64,' + r.data;
  } catch { /* giu anh cu (neu co) */ }
}

/**
 * (26/09/2026) Thiet bi xin ve lai mot vung (da tu ve vong tron phan hoi cham de len): ep gui lai cac o do o khung ke
 * tiep, bo qua loc "khung trung khung truoc", va nudge de Chrome phat mot khung moi ngay ca khi trang dung yen.
 */
export function repaintRect(dev: DeviceSession, x: number, y: number, w: number, h: number): void {
  dev.processor.invalidateRect(x, y, w, h);
  dev.prevFrameHash = -1;
  nudgeRepaintAsync(dev.cdp).catch(() => { });
}

/**
 * (27/09/2026) Su kien tu thiet bi. Tro ly giong noi: dua trang thai + chu vao Shell cua tab dang hien (the tro ly),
 * dong thoi tat man hinh cho — nguoi dung dang noi chuyen voi panel. Co nguoi: luu lai (Shell/metrics); viec bat den
 * nen do firmware tu lam (khong phu thuoc mang).
 */
export function onDeviceEvent(dev: DeviceSession, kind: number, value: number, text: string): void {
  if (kind === DeviceEventKind.Voice) {
    const s = Math.min(4, value);
    dev.voice = { s, t: text, at: Date.now() };
    if (s !== VoiceState.Idle) noteActivity(dev, 'tro ly giong noi');
    const names = ['xong', 'dang nghe', 'dang xu ly', 'tra loi', 'loi'];
    console.log(`[voice] ${dev.deviceId}: ${names[s]}${text ? ` "${text.slice(0, 120)}"` : ''}`);
    dev.cdp.send('Runtime.evaluate', {
      expression: `window.__rwvShell && window.__rwvShell.voice && window.__rwvShell.voice(${JSON.stringify({ s, t: text })})`,
    }).catch(() => { });
    return;
  }
  if (kind === DeviceEventKind.Presence) {
    const on = value !== 0;
    if (dev.presence?.on === on) return;
    dev.presence = { on, at: Date.now() };
    console.log(`[presence] ${dev.deviceId}: ${on ? 'CO nguoi' : 'khong con nguoi'}`);
    pushDeviceStateToPage(dev);
    if (on) maybeMorning(dev);
    // (07/10/2026) Dang KHOA (nguoi dung chon "chi sang man, giu khoa"): co nguoi -> sang ve muc nguoi dung va giu suot luc
    // con nguoi (dimForSaver bo qua); het nguoi -> 15 s sau toi lai. P4 fw-2026.10.06 nhan Saver = 2 nen khong ve trang chu.
    if (dev.locked && dev.saverOn && dev.lockDim) {
      if (on) wakeBrightWhileLocked(dev); else scheduleLockDim(dev);
    }
    return;
  }
  if (kind === DeviceEventKind.Button) physicalButton(dev, value, text === 'long' ? 'long' : 'click');
}

/**
 * (16/10/2026) NUT BAM VAT LY (S3 480x272, 3 nut ben hong). Firmware gui DeviceEvent Button (1 trai / 2 giua / 3 phai; "click" | "long"):
 *   GIUA nhan = Home (firmware tu xu ly) · GIUA giu >= 2 s = mo ung dung Frigate (firmware gui "long")
 *   TRAI / PHAI = bai (kenh) TRUOC / SAU cua trinh phat dang chay — Radio: kenh truoc / sau, YouTube / nhac: phim media Track Previous / Next.
 * Man hinh cho / khoa: nhan dau chi danh thuc, khong thuc hien lenh; dang do chuong: bo qua; khong co trinh phat: trai / phai bo qua.
 */
export function physicalButton(dev: DeviceSession, button: number, press: 'click' | 'long' = 'click'): void {
  const id = dev.deviceId;
  console.log(`[nut] ${id}: ${['', 'trai', 'giua', 'phai'][button] ?? button}${press === 'long' ? ' (giu)' : ''}`);
  if (dev.doorbell || alarms.ringingOn(id)) return;
  dev.lastTouchMs = Date.now();
  if (dev.saverOn) { if (dev.locked) wakeBrightWhileLocked(dev); else setSaver(dev, false); return; }
  if (button === 2) {
    if (press === 'long') {
      // Giu Home: vao THANG Frigate, uu tien hon ban phim ao dang mo / o nhap dang chon cua trang hien tai (dong truoc roi moi chuyen).
      dev.cdp.send('Runtime.evaluate', {
        expression: '(function(){ try { window.__vkbHide && window.__vkbHide(); var a = document.activeElement; if (a && a.blur) a.blur(); } catch (e) {} })()',
      }).catch(() => { });
      openApp(dev, 'cams').catch((e: unknown) => console.warn(`[nut] ${id}: mo Frigate that bai:`, e));
    }
    return;
  }
  if (press === 'long' || (button !== 1 && button !== 3)) return;
  const t = [...dev.tabs.values()].find((x) => x.mediaPlaying && x.key === dev.activeTabKey) ?? [...dev.tabs.values()].find((x) => x.mediaPlaying);
  if (!t) return;
  skipTrack(t, button === 1 ? 'prev' : 'next').catch(() => { });
  console.log(`[nut] ${id}: ${button === 1 ? 'bai truoc' : 'bai sau'} (tab "${t.key}")`);
}

/** Bai / kenh truoc-sau cua tab: ham trang tu dinh nghia (radio.html: rwvPrev / rwvNext), khong co thi phim media cua Chromium. */
async function skipTrack(t: Tab, cmd: 'prev' | 'next'): Promise<void> {
  if (await pageHook(t, cmd === 'next' ? 'rwvNext' : 'rwvPrev')) return;
  const k = MEDIA_KEYS[cmd];
  for (const type of ['rawKeyDown', 'keyUp'] as const) {
    await t.session.send('Input.dispatchKeyEvent', { type, key: k.key, code: k.key, windowsVirtualKeyCode: k.code, nativeVirtualKeyCode: k.code }).catch(() => { });
  }
}

// ── (27/09/2026) CHUONG CUA: sang man hinh, camera cong toan man hinh, Mo cong / Dong, het gio quay ve ─────────────
export function postDoorbell(body: unknown): { ok: boolean; error?: string; id?: string; devices?: string[] } {
  const p = parseDoorbell(body);
  if (!p.ok) return { ok: false, error: p.error };
  const b = p.bell;
  const id = Date.now().toString(36);
  const targets = b.device === 'all' ? [...devices.values()] : [devices.get(b.device)].filter((d): d is DeviceSession => !!d);
  for (const dev of targets) {
    const url = `${LOCAL_ORIGIN}/doorbell.html?cam=${encodeURIComponent(b.camera)}&title=${encodeURIComponent(b.title)}` +
      `&id=${id}&u=${b.unlock ? 1 : 0}&t=${b.timeoutS}&mode=${b.mode}` + (canPlay(dev) || dndOf(dev.deviceId) ? '&quiet=1' : '');
    const prevKey = dev.doorbell?.prevKey ?? (dev.activeTabKey === '__doorbell' ? 'home' : dev.activeTabKey);
    const saver = dev.doorbell?.saver ?? (dev.saverOn || !!dev.locked);
    if (dev.doorbell) clearTimeout(dev.doorbell.timer);
    dev.doorbell = { id, url, prevKey, unlock: b.unlock, saver, timer: setTimeout(() => endDoorbell(dev, id, 'het gio'), b.timeoutS * 1000) };
    // Sang man hinh (nhu thong bao khan) roi mo trang chuong; da co tab chuong (bam lien tiep) thi tai lai trang moi.
    if (dev.cfg.devControl) broadcaster.sendDeviceControl(dev.deviceId, ControlField.Brightness, userBrightness(dev));
    noteActivity(dev, 'chuong cua');
    // (01/10/2026) Chuong cua = loai Thong bao: firmware tu phat "ding-dong" (Khong lam phien -> im); trang khong keu nua.
    if (canPlay(dev)) playSound(dev, Sound.Doorbell);
    dev.tabOps.run(async () => {
      const t = dev.tabs.get('__doorbell');
      if (t) { await activateTab(dev, '__doorbell'); await navigateTab(dev, t, url); }
      else await openAppNow(dev, '__doorbell');
      showBellOverLock(dev);
    }).catch((e) => console.warn(`[doorbell] ${dev.deviceId}:`, (e as Error).message));
    console.log(`[doorbell] ${dev.deviceId}: chuong cua (${b.camera}${b.unlock ? ', mo cong = ' + b.unlock : ''}), ${b.timeoutS} s`);
  }
  return { ok: true, id, devices: targets.map((d) => d.deviceId) };
}

/**
 * (14/10/2026) CHUONG CONG (ESP32-S3, src/door.ts): do chuong tren cac man (moi man co dieu khien) bang trang door.html
 * (hinh cong qua WS, Nghe / Mo cong / Tu choi). Dung chung co che tab '__doorbell' cua postDoorbell: sang man hinh,
 * "ding-dong" (Khong lam phien -> im), het gio quay ve ung dung truoc.
 */
export function ringDoorPanels(door: string, name: string, timeoutS: number, only?: string[], doorTalk = true): { id: string; devices: string[] } {
  const id = Date.now().toString(36);
  const targets = [...devices.values()].filter((d) => d.cfg.devControl && broadcaster.getClientCount(d.deviceId) > 0 && (!only || only.includes(d.deviceId)));
  for (const dev of targets) {
    const url = `${LOCAL_ORIGIN}/door.html?door=${encodeURIComponent(door)}&name=${encodeURIComponent(name)}&id=${id}` +
      `&dev=${encodeURIComponent(dev.deviceId)}&t=${timeoutS}&talk=${dev.cfg.micCall ? 1 : 0}&da=${doorTalk ? 1 : 0}`;
    // (14/10/2026) Trang tu phat nhac chuong (/ringtone/door — tep trong media HA); khong co tep thi dung "ding-dong" firmware.
    openRingPage(dev, id, url, timeoutS, 'chuong cong', !ringtoneExists('door'));
  }
  console.log(`[door] ${door}: do chuong tren ${targets.map((d) => d.deviceId).join(', ') || '(khong man nao)'}`);
  return { id, devices: targets.map((d) => d.deviceId) };
}

/**
 * (14/10/2026) Mo mot trang "do chuong" (chuong cong, cuoc goi video den) tren man `dev`: sang man hinh, am chuong, trang
 * hien DE LEN man khoa (giu khoa), het `timeoutS` (0 = khong tu dong) tu dong lai va quay ve ung dung truoc.
 * Dung chung o '__doorbell' (moi man mot trang do chuong). Tra false neu man khong ton tai / khong ket noi.
 */
export function openRingPage(devOrId: DeviceSession | string, id: string, url: string, timeoutS: number, why: string, chime = true): boolean {
  const dev = typeof devOrId === 'string' ? devices.get(devOrId) : devOrId;
  if (!dev || broadcaster.getClientCount(dev.deviceId) === 0) return false;
  const prevKey = dev.doorbell?.prevKey ?? (dev.activeTabKey === '__doorbell' ? 'home' : dev.activeTabKey);
  const saver = dev.doorbell?.saver ?? (dev.saverOn || !!dev.locked);
  if (dev.doorbell) clearTimeout(dev.doorbell.timer);
  const timer = timeoutS > 0 ? setTimeout(() => endDoorbell(dev, id, 'het gio'), timeoutS * 1000) : setTimeout(() => { }, 0);
  dev.doorbell = { id, url, prevKey, unlock: null, saver, timer };
  if (dev.cfg.devControl) broadcaster.sendDeviceControl(dev.deviceId, ControlField.Brightness, userBrightness(dev));
  noteActivity(dev, why);
  if (chime && canPlay(dev)) playSound(dev, Sound.Doorbell);
  dev.tabOps.run(async () => {
    const t = dev.tabs.get('__doorbell');
    if (t) { await activateTab(dev, '__doorbell'); await navigateTab(dev, t, url); }
    else await openAppNow(dev, '__doorbell');
    showBellOverLock(dev);
  }).catch((e) => console.warn(`[ring] ${dev.deviceId}:`, (e as Error).message));
  return true;
}

/** (14/10/2026) Man `keep` da nghe: dong chuong tren moi man khac cung lan bam; man nay giu trang (bo hen gio). */
export function answerDoorbell(id: string, keep: string): boolean {
  let ok = false;
  for (const dev of devices.values()) {
    if (dev.doorbell?.id !== id) continue;
    if (dev.deviceId === keep) { clearTimeout(dev.doorbell.timer); ok = true; } else endDoorbell(dev, id, 'man khac da nghe');
  }
  return ok;
}

/**
 * (14/10/2026) Trang chuong hien DE LEN man hinh cho / khoa (truoc day lop khoa che mat trang chuong — khong thay hinh, khong
 * bam Nghe duoc). Giu dev.locked: het chuong, vong man hinh cho tu hien lai man khoa (screensaverTick bo qua khi co chuong).
 */
function showBellOverLock(dev: DeviceSession): void {
  if (dev.saverOn) { setSaver(dev, false); console.log(`[saver] ${dev.deviceId}: an man hinh ${dev.locked ? 'khoa' : 'cho'} de hien chuong`); }
  dev.cdp.send('Runtime.evaluate', { expression: 'window.__rwvShell && window.__rwvShell.screensaver && window.__rwvShell.screensaver(false)' }).catch(() => { });
}

/** Dong man hinh chuong (id lan bam do) tren MOT man hinh: quay ve ung dung truoc, dong tab chuong. */
function endDoorbell(dev: DeviceSession, id: string, why: string): void {
  const d = dev.doorbell;
  if (!d || d.id !== id) return;
  clearTimeout(d.timer);
  dev.doorbell = undefined;
  // (14/10/2026) Dang khoa truoc chuong: quay ve ung dung truoc KHONG duoc mo khoa (openAppNow -> noteActivity mo khoa).
  const wasLocked = dev.locked;
  dev.tabOps.run(async () => {
    if (dev.activeTabKey === '__doorbell') await openAppNow(dev, dev.tabs.has(d.prevKey) || d.prevKey === 'home' || d.prevKey === '__system' ? d.prevKey : '__system');
    if (wasLocked && !dev.locked) { dev.locked = true; console.log(`[saver] ${dev.deviceId}: khoa lai sau chuong`); }
    closeTab(dev, '__doorbell', why);
    // (16/10/2026) Dang MAN HINH CHO (khong khoa) truoc chuong: truoc day ve trang HA va doi het thoi gian ranh moi hien lai
    // (do that S3 480x272: tu choi -> o trang HA). Nay hien lai NGAY nhu man khoa.
    const tab = dev.tabs.get(dev.activeTabKey);
    if (d.saver && !dev.saverOn && tab && !dev.doorbell && broadcaster.getClientCount(dev.deviceId) > 0) {
      showSaver(dev, tab);
    }
  }).catch(() => { });
}

/** Trang chuong: nguoi dung bam Dong (hoac da mo cong) -> dong tren MOI man hinh cung lan bam (da co nguoi tra loi). */
export function closeDoorbell(id: string): boolean {
  let n = 0;
  for (const dev of devices.values()) if (dev.doorbell?.id === id) { endDoorbell(dev, id, 'nguoi dung dong'); n++; }
  return n > 0;
}

/** Trang chuong: nut Mo cong -> chay dung thuc the HA da khai trong POST /doorbell (khong nhan thuc the tu trang). */
export async function unlockDoorbell(id: string): Promise<{ ok: boolean; error?: string }> {
  const dev = [...devices.values()].find((d) => d.doorbell?.id === id);
  const entity = dev?.doorbell?.unlock;
  if (!entity) return { ok: false, error: 'Không có lệnh mở cổng.' };
  const ok = await callService(unlockCall(entity)).catch(() => false);
  console.log(`[doorbell] mo cong ${entity}: ${ok ? 'OK' : 'LOI'}`);
  return ok ? { ok } : { ok, error: 'Home Assistant không thực hiện được.' };
}

// ── (27/09/2026) TRUYEN YOUTUBE TU DIEN THOAI (DIAL, src/dial.ts): moi panel bat "Nhan truyen YouTube" la mot "TV"
// trong nut truyen cua app YouTube. Truyen -> sang man hinh, mo youtube.com/tv?pairingCode=... (UA Smart TV); ngat ->
// quay ve ung dung truoc.
export const YT_TV_URL = process.env.YT_TV_URL || 'https://www.youtube.com/tv';
const YT_TV_UA = process.env.YT_TV_UA ||
  'Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.0) AppleWebKit/537.36 (KHTML, like Gecko) 85.0.4183.93/6.0 TV Safari/537.36';
const CAST_DEFAULT = !['0', 'false'].includes(process.env.CAST_ENABLED ?? '');

/**
 * (27/09/2026) GIOI HAN VIDEO CHO TAB YOUTUBE TV. Giao dien TV chon chat luong cho TV (VP9/AV1, 1080p+, 60 hinh/giay)
 * — Chrome cua addon giai ma bang CPU nen rat nang, panel bi giat. Chi bao ho tro H.264 (nhu tien ich h264ify), cao
 * toi da `maxH` va `maxFps` hinh/giay: qua MediaSource.isTypeSupported, canPlayType va navigator.mediaCapabilities
 * (YouTube hoi ca ba; kieu Cobalt gan them width/height/framerate vao chuoi type).
 */
export function buildTvCodecScript(maxH: number, maxFps: number): string {
  return `(function(){
  var MAXH = ${maxH}, MAXF = ${maxFps};
  function bad(t, h, f){
    t = String(t || '').toLowerCase();
    if (/vp0?9|vp8|av01|av1|hev1|hvc1/.test(t)) return true;
    var mh = /height=(\\d+)/.exec(t), mf = /framerate=([\\d.]+)/.exec(t);
    if (mh) h = Number(mh[1]); if (mf) f = Number(mf[1]);
    return (h && h > MAXH) || (f && f > MAXF + 1);
  }
  try {
    ['MediaSource', 'ManagedMediaSource', 'WebKitMediaSource'].forEach(function(n){
      var M = window[n]; if (!M || !M.isTypeSupported) return;
      var o = M.isTypeSupported.bind(M);
      M.isTypeSupported = function(t){ return bad(t) ? false : o(t); };
    });
    var cp = HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType = function(t){ return bad(t) ? '' : cp.call(this, t); };
    var mc = navigator.mediaCapabilities;
    if (mc && mc.decodingInfo) {
      var od = mc.decodingInfo.bind(mc);
      mc.decodingInfo = function(c){
        var v = c && c.video;
        if (v && bad(v.contentType, v.height, v.framerate)) return Promise.resolve({ supported: false, smooth: false, powerEfficient: false });
        return od(c);
      };
    }
  } catch (e) {}
})();`;
}
const YT_TV_MAX_H = Number(process.env.YT_TV_MAX_HEIGHT) || 720;
const YT_TV_MAX_FPS = Number(process.env.YT_TV_MAX_FPS) || 30;
const YT_H264 = !['0', 'false'].includes(process.env.YT_H264 ?? '');
const YT_MAX_H = Number(process.env.YT_MAX_HEIGHT) || 720;
const YT_MAX_FPS = Number(process.env.YT_MAX_FPS) || 30;

export const dialHooks: DialHooks = {
  devices: () => [...devices.values()]
    .filter((d) => broadcaster.getClientCount(d.deviceId) > 0 && panelPrefs.cast(d.deviceId, CAST_DEFAULT))
    .map((d) => ({ id: d.deviceId, name: panelPrefs.castName(d.deviceId) })),
  running: (id) => !!devices.get(id)?.tabs.has('yttv'),
  launch(id, url) {
    const dev = devices.get(id);
    if (!dev) return;
    if (dev.activeTabKey !== 'yttv') dev.castPrev = dev.activeTabKey;
    dev.castUrl = url;
    dev.castLaunchMs = Date.now();
    if (dev.cfg.devControl) broadcaster.sendDeviceControl(id, ControlField.Brightness, userBrightness(dev));
    noteActivity(dev, 'truyen YouTube');
    dev.tabOps.run(async () => {
      const t = dev.tabs.get('yttv');
      if (t) { await activateTab(dev, 'yttv'); t.url = ''; await navigateTab(dev, t, url); }
      else await openAppNow(dev, 'yttv');
    }).catch((e) => console.warn(`[cast] ${id}:`, (e as Error).message));
  },
  stop(id) {
    const dev = devices.get(id);
    if (!dev || !dev.tabs.has('yttv')) return;
    const prev = dev.castPrev && dev.castPrev !== 'yttv' ? dev.castPrev : 'home';
    dev.castUrl = undefined;
    dev.tabOps.run(async () => {
      if (dev.activeTabKey === 'yttv') await openAppNow(dev, dev.tabs.has(prev) || prev === 'home' || prev === '__system' ? prev : '__system');
      closeTab(dev, 'yttv', 'dien thoai ngat truyen');
    }).catch(() => { });
  },
};

// ── (27/09/2026) CHAO BUOI SANG: lan dau camera thay nguoi trong khung gio sang (moi ngay, moi man hinh mot lan) -> mo
// ung dung "Hom nay" (thoi tiet, lich, viec, ghi chu) va doc tom tat qua loa cua panel (tts.speak, neu HA co TTS).
const off = (v: string | undefined) => v === '0' || v === 'false';
const MORNING_WINDOW = parseWindow(process.env.MORNING_WINDOW || '06:00-09:30');
/** Tuy chon addon morning_briefing — mac dinh cho man hinh chua chinh o Cai dat. */
const MORNING_DEFAULT = !off(process.env.MORNING_BRIEFING);
// (27/09/2026) Nguoi dung: chua muon loi chao bang am thanh -> mac dinh TAT, chi hien chu (bat: morning_tts: true).
const MORNING_TTS = process.env.MORNING_TTS === 'true' || process.env.MORNING_TTS === '1';

function maybeMorning(dev: DeviceSession): void {
  const tz = dev.devState?.tzOffsetMin ?? 420;
  const c = deviceClock(Date.now(), tz);
  if (!panelPrefs.morning(dev.deviceId, MORNING_DEFAULT)) return;
  if (!shouldGreet({ ...c, window: MORNING_WINDOW, lastDate: dev.morningDate ?? null })) return;
  dev.morningDate = c.date;
  console.log(`[morning] ${dev.deviceId}: chao buoi sang (${c.date})`);
  openApp(dev, 'today').catch(() => { });
  if (!MORNING_TTS) return;
  getToday(tz).then((v) => speakOnPanel(dev.deviceId, v.briefing)).then((err) => {
    console.log(`[morning] ${dev.deviceId}: ${err ? 'khong doc duoc: ' + err : 'da doc loi chao'}`);
  }).catch((e) => console.warn(`[morning] ${dev.deviceId}:`, (e as Error).message));
}

/** Mui gio cua mot man hinh dang ket noi (trang "Hom nay" khong biet minh o thiet bi nao). Mac dinh +7. */
export function anyTzOffset(): number {
  for (const d of devices.values()) if (d.devState) return d.devState.tzOffsetMin;
  return 420;
}

/** (26/09/2026) Mo man hinh "Gan day" — tu cu chi vuot-len-roi-giu o mep duoi (inputRouter.ts). */
export function openRecents(dev: DeviceSession): void {
  showRecents(dev, true).catch(() => { });
}

/** Dua danh sach "Gan day" vao Shell cua tab dang hien. open=false: chi cap nhat neu man hinh Gan day DANG mo. */
async function showRecents(dev: DeviceSession, open: boolean): Promise<void> {
  const active = dev.tabs.get(dev.activeTabKey);
  if (open && active) await captureThumb(dev, active);
  const ghosts = [...(dev.closedRecents ?? new Map()).entries()].filter(([k]) => !dev.tabs.has(k))
    .map(([k, g]) => ({ key: k, label: g.label, pinned: false, lastUsed: g.lastUsed, thumb: g.thumb }));
  const list = recentsList([...dev.tabs.values(), ...ghosts], dev.activeTabKey);
  await dev.cdp.send('Runtime.evaluate', {
    expression: `window.__rwvShell && window.__rwvShell.recents && window.__rwvShell.recents(${JSON.stringify(list)}, ${open})`,
  }).catch(() => { });
}

/** (26/09/2026) Trang cua tab bao bat dau/ngung phat. Doi trang thai -> cap nhat the "Dang phat" tren man hinh. */
function onTabMedia(dev: DeviceSession, tab: Tab, playing: boolean): void {
  const changed = tab.mediaPlaying !== playing || !tab.mediaKnown;
  if (tab.mediaPlaying && !playing) tab.mediaStoppedMs = Date.now();
  tab.mediaPlaying = playing;
  tab.mediaKnown = true;
  if (!changed) return;
  if (tab.backgroundAudio) console.log(`[app] ${dev.deviceId}: tab "${tab.key}" ${playing ? 'dang phat' : 'da dung phat'}`);
  // (30/09/2026) Radio/nhac o NEN vua ngung phat -> khong con ly do chay ngam: dong bang.
  if (!playing && dev.activeTabKey !== tab.key) freezeTab(dev, tab);
  if (playing && dev.activeTabKey === tab.key) noteActivity(dev, 'bat dau phat video/am thanh');
  // (27/09/2026) "Tieu diem am thanh" nhu dien thoai: mot tab cua man hinh bat dau phat -> dung moi tab KHAC dang phat
  // (vd Radio phat nen roi truyen YouTube -> truoc day hai tieng chong nhau).
  if (playing) {
    for (const other of dev.tabs.values()) {
      if (other === tab || !other.mediaPlaying) continue;
      other.session.send('Runtime.evaluate', { expression: 'window.__rwvMediaStop && window.__rwvMediaStop();' }).catch(() => { });
      console.log(`[app] ${dev.deviceId}: tab "${tab.key}" phat -> dung tab "${other.key}" (tranh chong tieng)`);
    }
  }
  // (27/09/2026) Chan doan truyen YouTube: trang thai am thanh THAT cua trinh phat (log addon).
  if (playing && tab.kind === 'yttv') {
    tab.session.send('Runtime.evaluate', { returnByValue: true, expression:
      "Array.prototype.map.call(document.querySelectorAll('audio,video'),function(m){return m.tagName+' muted='+m.muted+' vol='+m.volume+' paused='+m.paused}).join('; ')" })
      .then((r) => console.log(`[cast] ${dev.deviceId}: dang phat — ${(r as { result?: { value?: string } })?.result?.value || 'khong thay the media'}`))
      .catch(() => { });
  }
  syncMediaPlaying(dev);
  pushDeviceStateToPage(dev);
}

// (30/09/2026) DONG BANG TAB NEN. Do that 30/09: addon 8 tab, 3 tab cam.html giai ma luong camera lien tuc o nen, CPU
// addon 25-50% luc KHONG ai xem gi, may HASS con 182 MB RAM + 2,75 GB swap -> video giat.
// Cach lam: TAM DUNG JavaScript cua tab nen bang debugger (Debugger.pause) — tab khong chay timer/xu ly websocket/ve
// lai DOM; quay lai = Debugger.resume, TUC THI (khong tai lai). DA THU va LOAI: Page.setWebLifecycleState 'frozen'
// (Chromium bo qua voi trang dang "hien thi" — headless coi MOI tab la hien thi; do: timer van chay du 30/30 lan) va
// Emulation.setCPUThrottlingRate (khong tac dung trong headless). Do tren Chromium: 80 vong viec/4 s -> 1 khi tam dung.
// Video do trang dang phat KHONG thuoc JS (luong media rieng) -> YouTube/TikTok/TV van duoc pause rieng khi roi tab,
// tab camera dong han (isCameraTab). Ngoai le: tab dang phat nhac/radio nen, YouTube TV (giu ket noi voi dien thoai).
// FREEZE_BG_TABS=0 de tat.
const FREEZE_BG_TABS = !['0', 'false'].includes(process.env.FREEZE_BG_TABS ?? '');

/** Tab camera (luong go2rtc giai ma lien tuc): DONG HAN khi roi thay vi de ngam — mo lai chi mat ~1 s. */
function isCameraTab(t: Tab): boolean {
  return !t.pinned && (t.kind === 'camera' || t.kind === 'cams' || /\/cams?\.html(\?|$)/.test(t.url));
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`Chrome khong tra loi sau ${ms} ms`)), ms))]);
}

// (14/10/2026) Danh dau media DANG PHAT bi dung boi dong bang (data-rwv-fz) de phat lai neu tab duoc dua len hien GIUA chuoi.
const PAUSE_ALL_MEDIA_JS = "document.querySelectorAll('video,audio').forEach(function(m){try{if(!m.paused)m.setAttribute('data-rwv-fz','1');m.pause();}catch(e){}});";
const RESUME_FROZEN_MEDIA_JS = "document.querySelectorAll('[data-rwv-fz]').forEach(function(m){try{m.removeAttribute('data-rwv-fz');var p=m.play();if(p&&p.catch)p.catch(function(){});}catch(e){}});";

function freezeTab(dev: DeviceSession, tab: Tab): void {
  if (!FREEZE_BG_TABS || dev.activeTabKey === tab.key || !dev.tabs.has(tab.key)) return;
  // (14/10/2026) Ghi ly do BO QUA (truoc day im lang) — do that: tab IPTV roi di khong bao gio bi dong bang, video phat ngam.
  if (tab.frozen) { console.log(`[app] ${dev.deviceId}: bo qua dong bang "${tab.key}": co frozen dang bat`); return; }
  if (tab.kind === 'yttv' || (tab.backgroundAudio && tab.mediaPlaying)) return;
  tab.frozen = true;
  // (01/10/2026) Debugger.pause chi dung JAVASCRIPT — bo giai ma <video>/<audio> cua Chrome VAN CHAY (truoc day chi
  // YouTube/TikTok duoc dung video khi roi tab: trang web khac co video van phat ngam). Dung MOI media truoc khi dong
  // bang. Tab radio/nhac dang phat nen khong bao gio toi day (dieu kien o tren).
  // (01/10/2026) Moi buoc co han 3 s: Chrome khong tra loi -> truoc day ca chuoi treo IM LANG, tab o lai "frozen" nhung
  // JS + video van chay ngam (do that: tab YouTube P4 phat nen toi khi bi dong sau 5 phut, khong mot dong log).
  // (14/10/2026) KIEM LAI o MOI buoc: tab co the duoc dua len HIEN giua chuoi (do that 14/10: phat IPTV len S3 -> "chuyen sang
  // tab iptv" roi "dong bang tab nen iptv" -> video IPTV bi dung, man khoa). Khi do huy dong bang + phat lai media vua dung.
  const stillBg = () => tab.frozen && dev.activeTabKey !== tab.key && dev.tabs.get(tab.key) === tab;
  withTimeout(tab.session.send('Runtime.evaluate', { expression: PAUSE_ALL_MEDIA_JS }), 3000).catch(() => { })
    // Debugger.enable ngay truoc khi dung (khong de bat thuong truc: moi script trang nap se ban su kien ve server).
    .then(() => stillBg() ? withTimeout(tab.session.send('Debugger.enable', {}), 3000) : undefined)
    .then(() => stillBg() ? withTimeout(tab.session.send('Debugger.pause'), 3000) : undefined)
    .then(async () => {
      if (stillBg()) { console.log(`[app] ${dev.deviceId}: dong bang tab nen "${tab.key}"`); return; }
      if (dev.tabs.get(tab.key) !== tab) return;   // tab da dong
      tab.frozen = false;
      await tab.session.send('Debugger.resume').catch(() => { });
      await tab.session.send('Debugger.disable').catch(() => { });
      if (dev.activeTabKey === tab.key) {
        await withTimeout(tab.session.send('Runtime.evaluate', { expression: RESUME_FROZEN_MEDIA_JS }), 3000).catch(() => { });
        console.log(`[app] ${dev.deviceId}: huy dong bang "${tab.key}" (tab vua duoc dua len hien)`);
      }
      // (14/10/2026) Bi go giua chung boi duong khac (cap nhat bo cuc / Shell) — ghi lai de do (lan dau roi tab IPTV vua tao
      // khong bi dong bang, chua ro duong nao).
      else console.log(`[app] ${dev.deviceId}: dong bang "${tab.key}" bi go giua chung (tab van o nen)`);
    })
    .catch((e: unknown) => {
      tab.frozen = false;
      // (14/10/2026) Tab vua bi dong (qua so tab / don nen) trong luc dong bang -> "Session with given id not found": vo hai, khong log.
      if (dev.tabs.get(tab.key) !== tab || /Session with given id not found/.test(String((e as Error)?.message ?? e))) return;
      console.warn(`[app] ${dev.deviceId}: khong dong bang duoc "${tab.key}":`, e);
    });
}

/** Bo dong bang TRUOC moi thao tac can trang chay (hien, dieu huong, nap lai Shell). Runtime.evaluate tren trang dang
 * tam dung se TREO toi khi resume — moi cho goi evaluate vao tab co the dang nen deu phai qua day truoc. */
async function thawTab(tab: Tab): Promise<void> {
  if (!tab.frozen) return;
  tab.frozen = false;
  await tab.session.send('Debugger.resume').catch(() => { });
  await tab.session.send('Debugger.disable').catch(() => { });
}

function closeTab(dev: DeviceSession, key: string, reason = 'qua so tab toi da'): void {
  const tab = dev.tabs.get(key);
  if (!tab) return;
  dev.tabs.delete(key);
  const root = getRoot() as unknown as CDPRoot;
  tab.session.send('Page.stopScreencast').catch(() => { });
  root?.send('Target.closeTarget', { targetId: tab.targetId }).catch(() => { });
  console.log(`[app] ${dev.deviceId}: dong tab "${key}" (${tab.kind}, ${reason})`);
  syncMediaPlaying(dev);
}

/**
 * (26/09/2026 OS-2) Tao MOT tab (Chromium target + session) moi cho thiet bi: tiem day du cac script he thong
 * (khoa am thanh, ban phim ao, Shell) va dang ky moi listener CDP CUA RIENG TAB NAY — screencastFrame/frameNavigated
 * chi anh huong toi `dev` (bo dem khung, URL hien tai...) khi `dev.activeTabKey === key` (xem cac closure ben duoi),
 * nen nhieu tab song song khong dam vao nhau. Luon KET THUC bang Page.navigate toi `url` (tru 'about:blank').
 */
/**
 * (26/09/2026 OS-2, sua sau khi phat hien loi tren thiet bi that) KHONG dieu huong o day. Chi tao target/session,
 * tiem script, chuan bi viewport/codec/UA tren trang 'about:blank' ON DINH. Ban goc mot-tab CHUA TUNG dieu huong
 * truoc khi bat screencast — luon Page.startScreencast() TREN TRANG TRANG roi moi Page.navigate() sau (xem
 * activateTab() + navigateTab()). Dao nguoc thu tu (dieu huong CHEO NGUON GOC — vd ve dashboard HA — TRUOC khi
 * bat screencast) gay loi CDP that "Not attached to an active page": dieu huong cheo nguon co the khien Chrome
 * doi tien trinh renderer (site isolation) dung luc phien CDP dang gan (flatten) vao muc tieu do.
 */
async function createTab(dev: DeviceSession, key: string, kind: string, pinned: boolean, label: string): Promise<Tab> {
  const root = getRoot() as unknown as CDPRoot;
  if (!root) throw new Error('CDP not ready');

  dev.closedRecents?.delete(key);
  const { targetId } = await root.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await root.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
  const session = root.session(sessionId);

  await session.send('Page.enable');

  // (23/09/2026, xem buildAudioGuardScript) Tiem TRUOC bat ky script nao khac va truoc lan dieu huong dau tien.
  await session.send('Page.addScriptToEvaluateOnNewDocument', { source: buildAudioGuardScript(!dev.cfg.audioEnabled, kind === 'yttv') });
  if (kind === 'yttv') await session.send('Page.addScriptToEvaluateOnNewDocument', { source: buildTvCodecScript(YT_TV_MAX_H, YT_TV_MAX_FPS) });
  // (30/09/2026) YouTube THUONG (va YouTube Music) cung chi H.264: khong ep thi YouTube gui AV1 (Dav1d giai ma bang
  // CPU — nang nhat); Chrome headless khong co giai ma phan cung (da thu GPU/VA-API 30/09: 0 codec phan cung).
  // YT_H264=0 de tat.
  else if (YT_H264 && (kind === 'youtube' || kind === 'music')) {
    await session.send('Page.addScriptToEvaluateOnNewDocument', { source: buildTvCodecScript(YT_MAX_H, YT_MAX_FPS) });
  }
  await session.send('Page.addScriptToEvaluateOnNewDocument', { source: KIOSK_KEYBOARD_SCRIPT });
  // (09/10/2026) VI TRI cho trang web (Google Maps "Vị trí của bạn" / diem khoi hanh): Chrome tren may chu khong co GPS va chua
  // duoc cap quyen -> trang bao loi. Cap quyen vi tri + dat vi tri = NHA trong Home Assistant (Cai dat -> Khu vuc).
  await grantGeolocation(root, session);
  // (09/10/2026) Tab trinh duyet (ung dung Chrome): Shell ve thanh cong cu kieu Chrome (src/shell/browserBar.ts).
  if (kind === 'browser') await session.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__RWV_BROWSER=1;' });
  const { identifier: launcherScriptId } = await session.send(
    'Page.addScriptToEvaluateOnNewDocument', { source: buildLauncherScript(dev.cfg.homeUrl, dev.cfg) }
  );

  const tab: Tab = {
    key, kind, label, url: '', targetId, session, pinned,
    screencastOn: false,
    // Radio/Nhac: duoc phep tiep tuc keu KHI KHONG active (the "Dang phat" trong thanh trang thai dung duoc).
    // (14/10/2026) + Media (nhac tu thu muc HA / the nho) — nghe tiep khi sang ung dung khac.
    backgroundAudio: kind === 'radio' || kind === 'music' || kind === 'media',
    audioAllowed: false, mediaPlaying: false, mediaKnown: false, lastUsed: Date.now(), launcherScriptId,
  };
  dev.tabs.set(key, tab);

  try {
    await session.send('Runtime.enable');
    await session.send('Runtime.addBinding', { name: URL_BINDING });
    await session.send('Runtime.addBinding', { name: CONTROL_BINDING });
    session.on('Runtime.bindingCalled', (evt: any) => {
      if (evt?.name === URL_BINDING) handleUserEnteredUrl(dev.deviceId, evt.payload);
      else if (evt?.name === CONTROL_BINDING) handleMenuControl(dev.deviceId, evt.payload, tab);
    });
    // Moi trang moi cua TAB NAY: neu dang la tab active, dua lai trang thai thiet bi vao Shell.
    session.on('Page.domContentEventFired', () => {
      const d = devices.get(dev.deviceId);
      if (d && d.activeTabKey === key) pushDeviceStateToPage(d);
    });
  } catch (e) {
    console.warn(`[device] ⚠️ Khong dang ky duoc binding cho tab "${key}" (${dev.deviceId}):`, e);
  }

  // (23/10/2026) YouTube TV: viewport 1920x1080 (chuan TV) de youtube.com/tv render day man.
  // Khung se duoc resize ve kich thuoc man o flushPending().
  const vpW = kind === 'yttv' ? 1920 : dev.cfg.width;
  const vpH = kind === 'yttv' ? 1080 : dev.cfg.height;
  const vpOk = await setupStableViewport(session, vpW, vpH);
  tab.vw = vpW; tab.vh = vpH;
  if (!vpOk) console.warn(`[device] ⚠️ Viewport mismatch ${vpW}x${vpH} (tab "${key}")`);

  await verifyCodecSupport(session);

  try {
    // (27/09/2026) Tab YouTube TV: User-Agent Smart TV (khong co thi youtube.com/tv chuyen ve trang may tinh).
    const realUA = kind === 'yttv' ? YT_TV_UA : await getRealChromeUserAgentAsync(session);
    if (realUA) {
      await session.send('Emulation.setUserAgentOverride', { userAgent: realUA, platform: 'Linux x86_64' });
    }
  } catch { }

  session.on('Page.screencastFrame', (evt: any) => {
    session.send('Page.screencastFrameAck', { sessionId: evt.sessionId }).catch(() => { });
    // (26/09/2026 OS-2) Tab NEN (khong active) khong con Page.startScreencast bat (activateTab() da tat khi rời) —
    // nhung ve chan cho chac (vd goi dang bay trong hang doi CDP luc vua chuyen tab).
    if (dev.activeTabKey !== key) return;
    if (broadcaster.getClientCount(dev.deviceId) === 0) return;
    dev.lastActive = Date.now();
    // (27/10/2026) LUOI AN TOAN: khung screencast nho hon han man hinh (vd 320x188 sau mot lan capture co clip.scale)
    // -> KHONG gui khung do; khoi phuc viewport va xin khung day du. Chi ap khi khong o che do nua do phan giai.
    const md = (evt.metadata || {}) as { width?: number; height?: number };
    if (!dev.halfOn && !dev.cfg.rotation && md.width && md.height
        && (md.width < dev.cfg.width * 0.75 || md.height < dev.cfg.height * 0.75)) {
      const t = Date.now();
      if (!dev.vpFixAt || t - dev.vpFixAt > 3000) {
        dev.vpFixAt = t;
        console.warn(`[frame] ${dev.deviceId}: khung ${md.width}x${md.height} < ${dev.cfg.width}x${dev.cfg.height} -> khoi phuc viewport`);
        setupStableViewport(session, dev.cfg.width, dev.cfg.height).catch(() => { });
        requestFullFrameFor(dev);
      }
      return;
    }
    dev.lastFrameB64 = evt.data;
    dev.pendingB64 = evt.data;
    const now = Date.now();
    const since = dev.lastProcessedMs ? (now - dev.lastProcessedMs) : Infinity;
    if (!dev.throttleTimer) {
      const interacting = INTERACTION_BOOST_MS > 0
        && dev.lastInputMs != null
        && (now - dev.lastInputMs) < INTERACTION_BOOST_MS;
      const effInterval = interacting
        ? dev.cfg.minFrameInterval
        : (dev.tunedMinFrameIntervalMs ?? dev.cfg.minFrameInterval);
      const delay = Math.max(0, effInterval - (Number.isFinite(since) ? since : 0));
      dev.throttleTimer = setTimeout(() => flushPending(dev), delay);
    }
  });

  session.on('Page.frameNavigated', (evt: any) => {
    if (evt?.frame?.parentId) return;
    // Tai lieu moi: moi <audio>/<video> cua trang cu da mat -> khong con phat, trang moi se tu bao lai neu phat.
    if (tab.mediaKnown && tab.mediaPlaying) onTabMedia(dev, tab, false);
    if (dev.activeTabKey === key) setSaver(dev, false);  // tai lieu moi: Shell moi, khong con man hinh cho
    tab.mediaKnown = false;
    handleTabNavigation(dev, tab, evt?.frame?.url);
  });
  session.on('Page.navigatedWithinDocument', (evt: any) => {
    handleTabNavigation(dev, tab, evt?.url);
  });
  // (01/10/2026) RENDERER CHET: do that 01/10 — may chu het RAM, OOM killer cua kernel giet tien trinh Chrome chua trang
  // dashboard HA (dung chung cho ca 3 man) -> ca 3 man DEN 42 phut, server khong biet (tab van "con", khong khung nao,
  // cham bao "Failed to dispatch touch event"). Nay nghe su kien crash cua tung tab va tu nap lai.
  session.on('Inspector.targetCrashed', () => { onTabCrashed(dev, tab).catch(() => { }); });
  session.send('Inspector.enable').catch(() => { });

  return tab;
}

async function onTabCrashed(dev: DeviceSession, tab: Tab): Promise<void> {
  if (devices.get(dev.deviceId) !== dev || dev.tabs.get(tab.key) !== tab) return;
  const active = dev.activeTabKey === tab.key;
  const mem = hostMem();
  console.warn(`[app] ${dev.deviceId}: renderer cua tab "${tab.key}" CHET (may chu con ${mem?.availMb ?? '?'} MB RAM, swap ` +
    `${mem?.swapUsedMb ?? '?'}/${mem?.swapTotalMb ?? '?'} MB) -> nap lai${active ? ' + bat lai screencast' : ''}`);
  tab.frozen = false;            // debugger da mat cung renderer
  tab.screencastOn = false;
  tab.mediaPlaying = false;
  tab.mediaKnown = false;
  await tab.session.send('Page.reload', {}).catch((e: unknown) => console.warn(`[app] ${dev.deviceId}: nap lai tab "${tab.key}" loi:`, e));
  if (dev.activeTabKey !== tab.key) {
    if (!active) setTimeout(() => freezeTab(dev, tab), 5000);  // tab nen: chay lai roi dong bang nhu cu
    return;
  }
  // (27/10/2026) GIU nguong 128 KB: ha xuong 64 KB tung lam panel nho roi vao duong TAT (Chrome day khung 60 fps)
  // -> qua tai, nhip tut ve 200 ms / 5 fps. Chi uu tien chat luong nguoi dung dat.
  const canPassthrough = PASSTHROUGH_MIN_FPS > 0 && dev.cfg.maxBytesPerMessage >= 131072;
  const q = dev.qualityOverride ?? (canPassthrough ? dev.cfg.jpegQuality : SCREENCAST_JPEG_QUALITY);
  for (let attempt = 1; attempt <= 6 && !tab.screencastOn && dev.activeTabKey === tab.key; attempt++) {
    await new Promise((r) => setTimeout(r, 500 * attempt));
    try {
      await tab.session.send('Page.stopScreencast').catch(() => { });
      await tab.session.send('Page.startScreencast', {
        format: 'jpeg', quality: q, maxWidth: dev.cfg.width, maxHeight: dev.cfg.height, everyNthFrame: dev.cfg.everyNthFrame,
      });
      tab.screencastOn = true;
      tab.scQuality = q;
    } catch (e) {
      if (attempt === 6) console.warn(`[app] ${dev.deviceId}: khong bat lai duoc screencast sau crash:`, e);
    }
  }
  requestFullFrameFor(dev);
}

/**
 * Dieu huong MOT TAB toi `url` — chi goi SAU KHI tab da active (Page.startScreencast dang chay), tru phi tab
 * dang o NEN (khong active, khong ai xem — an toan du dieu huong cheo nguon luc do, xem createTab()). Bo qua neu
 * tab da o dung URL nay roi.
 */
async function navigateTab(dev: DeviceSession, tab: Tab, url: string): Promise<void> {
  if (!url || url === 'about:blank' || tab.url === url) return;
  await thawTab(tab);
  await tab.session.send('Page.navigate', { url }).catch((e: unknown) =>
    console.warn(`[device] ${dev.deviceId}: dieu huong tab "${tab.key}" (${url}) that bai:`, e));
  tab.url = url; // lac quan — handleTabNavigation() se xac nhan/sua lai khi Page.frameNavigated thuc su toi
}

/**
 * (18/09/2026, mo rong OS-2) DONG BO URL HAI CHIEU — theo TUNG TAB.
 *
 * Truoc day URL chi di MOT CHIEU (HA -> thiet bi). Khi nguoi dung tu cham chuyen tab tren dashboard, server khong
 * theo doi gi ca, nen thiet bi va HA deu giu gia tri cu. Phai bat CA HAI su kien Page.frameNavigated (dieu huong
 * day du) va Page.navigatedWithinDocument (dashboard HA la ung dung MOT TRANG, chuyen tab chi doi URL bang
 * history.pushState) — chi bat frameNavigated se bo sot truong hop thuong gap nhat.
 *
 * `tab.url` luon duoc cap nhat (moi tab tu theo doi URL cua chinh no, ke ca khi dang o nen); `dev.url`/"URL hien
 * tai" cua man hinh CHI doi khi day la tab DANG ACTIVE — tab nen dieu huong (vd HA tu lam moi ngam) khong duoc lam
 * "URL hien tai" nhay sang thu nguoi dung khong he thay tren man hinh.
 */
function handleTabNavigation(dev: DeviceSession, tab: Tab, url: string | undefined): void {
  if (!url || url === 'about:blank') return;
  // (26/09/2026, bat duoc boi thu tich hop) KHONG thoat som khi `tab.url === url`: navigateTab() da gan tab.url LAC
  // QUAN truoc khi Chromium bao dieu huong xong, nen dieu huong toi DUNG URL da xin (truong hop thuong gap nhat — vd
  // luc ket noi, Go Home) truoc day bi bo qua o day -> thiet bi khong nhan CurrentURL, va lenh khang dinh am thanh ben
  // duoi cung khong chay. Chong lap dua vao `dev.url` (nhu ban goc mot-tab), khong dua vao `tab.url`.
  tab.url = url;
  // Khang dinh lai trang thai am thanh MOI LAN tab nay thuc su vao mot tai lieu moi — xem buildAudioGuardScript:
  // day la cho tu sua neu lenh setTabAudioAllowed() luc kich hoat da "thua" chinh navigation nay.
  tab.session.send('Runtime.evaluate', {
    expression: `window.__rwvAudioGuard && (window.__rwvAudioAllowed = ${tab.audioAllowed}, window.__rwvAudioApply && window.__rwvAudioApply());`,
  }).catch(() => { });
  if (dev.activeTabKey !== tab.key || dev.url === url) return;
  noteActivity(dev, 'trang dieu huong');
  dev.url = url;
  broadcaster.sendCurrentURL(dev.deviceId, url);
  metrics.onNavigate(dev.deviceId, url);
  console.log(`[device] ${dev.deviceId}: URL doi thanh ${url} (tab "${tab.key}")`);
}

/**
 * (26/09/2026 OS-2) Chuyen tab ACTIVE cua thiet bi: dung screencast + tat tieng (tru khi dang phat nen)
 * + tam dung video tren tab CU; bat tieng + bat screencast tren tab MOI + ep gui lai khung day du. `dev.cdp` luon
 * duoc gan lai de MOI cho khac trong file (dispatch cham, self-test, VIDEO_PROBE...) tu dong noi dung tab active
 * ma khong can biet gi ve co che nhieu tab. Khong lam gi neu key da la tab active (goi lai an toan, vd luc chuyen
 * doi nhanh hoac ket noi lai voi cung tab).
 */
async function activateTab(dev: DeviceSession, key: string): Promise<void> {
  const next = dev.tabs.get(key);
  if (!next) return;
  if (dev.activeTabKey === key) { next.lastUsed = Date.now(); return; }

  const prev = dev.tabs.get(dev.activeTabKey);
  let thumbThenFreeze: Promise<void> | null = null;
  if (prev) {
    prev.lastUsed = Date.now();  // "dung lan cuoi" = luc ROI tab (don tab / dong tab nhan roi tinh tu day)
    // YouTube/TikTok: DUNG video khi roi tab, tranh tieng ngam tiep tuc chay ngam voi tab khac.
    if (prev.kind === 'youtube' || prev.kind === 'tiktok' || prev.kind === 'yttv') {
      prev.session.send('Runtime.evaluate', {
        expression: "document.querySelectorAll('video').forEach(function(v){try{v.pause();}catch(e){}});",
      }).catch(() => { });
    }
    setTabAudioAllowed(prev, prev.backgroundAudio);
    noteActivity(dev, 'chuyen tab', prev);  // go man hinh cho khoi tab CU (quay lai sau khong con thay no)
    if (isCameraTab(prev)) {
      closeTab(dev, prev.key, 'roi tab camera');
    } else {
      // anh cho "Gan day" — truoc khi tat screencast, khong cho; XONG moi dong bang (trang dong bang khong chup duoc).
      // (15/10/2026) Dong bang SAU khi da doi activeTabKey (cuoi ham): truoc day chup anh xong truoc khi tab moi mo bang xong
      // -> freezeTab thay tab cu "van dang hien" va thoat IM LANG -> video IPTV phat ngam mai (do 15/10 tren S3).
      thumbThenFreeze = captureThumb(dev, prev);
    }
    if (prev.screencastOn) {
      prev.session.send('Page.stopScreencast').catch(() => { });
      prev.screencastOn = false;
    }
  }

  await thawTab(next);
  dev.activeTabKey = key;
  dev.cdp = next.session;
  if (thumbThenFreeze && prev) { const p = prev; void thumbThenFreeze.finally(() => freezeTab(dev, p)); }
  setSaver(dev, false);  // man hinh cho nam trong Shell cua tab CU
  // (15/10/2026) Chrome headless KHONG phat visibilitychange khi doi tab -> bao trang biet minh vua duoc dua len lai
  // (vd Thu vien doc lai the: anh/video moi, tep da bi xoa). Khong cho — trang khong nghe thi vo hai.
  if (prev && prev !== next)
    next.session.send('Runtime.evaluate', { expression: "document.dispatchEvent(new Event('rwv-show'))" }).catch(() => { });
  next.lastUsed = Math.max(Date.now(), (prev?.lastUsed ?? 0) + 1);  // luon moi hon tab vua roi (cung mili-giay)
  setTabAudioAllowed(next, true);

  if (!next.screencastOn) {
    const canPassthrough = PASSTHROUGH_MIN_FPS > 0 && dev.cfg.maxBytesPerMessage >= 131072;
    const screencastQuality = canPassthrough ? dev.cfg.jpegQuality : SCREENCAST_JPEG_QUALITY;
    // (30/09/2026) Thu lai: dieu huong doi goc (tien trinh dung trang doi) co the lam lenh nay tra "Not attached to an
    // active page" trong mot khoang ngan. Chi danh dau screencastOn khi THAT SU bat duoc — truoc day danh dau bat ke,
    // tab khong bao gio phat khung cho toi lan chuyen tab sau (man hinh dung hinh).
    for (let attempt = 1; attempt <= 4 && !next.screencastOn; attempt++) {
      try {
        await next.session.send('Page.startScreencast', {
          format: 'jpeg', quality: screencastQuality, maxWidth: dev.cfg.width, maxHeight: dev.cfg.height,
          everyNthFrame: dev.cfg.everyNthFrame,
        });
        next.screencastOn = true;
        next.scQuality = screencastQuality;
        if (attempt > 1) console.log(`[device] ${dev.deviceId}: bat screencast tab "${key}" thanh cong o lan thu ${attempt}`);
      } catch (e) {
        if (attempt === 4) console.warn(`[device] ${dev.deviceId}: khong bat duoc screencast tab "${key}" sau 4 lan:`, e);
        else await new Promise((r) => setTimeout(r, 250 * attempt));
      }
    }
  }
  if (next.url) {
    dev.url = next.url;
    broadcaster.sendCurrentURL(dev.deviceId, next.url);
  }
  requestFullFrameFor(dev);
  pushDeviceStateToPage(dev);
  syncMediaPlaying(dev);
  console.log(`[app] ${dev.deviceId}: chuyen sang tab "${key}" (${next.kind})`);
}

// ============================================
// HELPER: Setup viewport
// ============================================
async function setupStableViewport(
  session: CDPSession, width: number, height: number, maxRetries = 3
): Promise<boolean> {
  console.log(`[Viewport] Setting up ${width}x${height}`);
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await session.send('Emulation.setDeviceMetricsOverride', {
        width, height, deviceScaleFactor: 1, mobile: false,
        screenWidth: width, screenHeight: height, positionX: 0, positionY: 0
      });
      await session.send('Emulation.setFocusEmulationEnabled', { enabled: true });
      try { await session.send('Emulation.setLocaleOverride', { locale: BROWSER_LOCALE }); } catch { }
      if (PREFERS_REDUCED_MOTION) {
        await session.send('Emulation.setEmulatedMedia', {
          media: 'screen', features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
        });
      }
      await new Promise(r => setTimeout(r, 300));
      const res = await session.send('Runtime.evaluate', {
        expression: `({width:window.innerWidth,height:window.innerHeight})`, returnByValue: true
      }) as { result?: { value?: { width: number; height: number } } };
      const sz = res.result?.value;
      if (sz) {
        console.log(`[Viewport] Attempt ${attempt}: got ${sz.width}x${sz.height}`);
        if (sz.width === width && sz.height === height) { console.log(`[Viewport] ✓`); return true; }
      }
      if (attempt < maxRetries) await new Promise(r => setTimeout(r, 500));
    } catch (e) {
      if (attempt === maxRetries) throw e;
      await new Promise(r => setTimeout(r, 500));
    }
  }
  console.warn(`[Viewport] ⚠️ Failed after ${maxRetries} attempts`);
  return false;
}

// ============================================
// HELPER: Codec check (once)
// ============================================
async function verifyCodecSupport(session: CDPSession): Promise<void> {
  if (_codecVerified) return;
  try {
    const r = await session.send('Runtime.evaluate', {
      expression: `(()=>{const v=document.createElement('video');return{h264:v.canPlayType('video/mp4;codecs="avc1.42E01E"')};})()`,
      returnByValue: true
    }) as { result?: { value?: { h264: string } } };
    const s = r.result?.value;
    if (s) {
      if (!s.h264) console.warn('⚠️  H.264 not supported — install google-chrome-stable');
      else console.log('✅ H.264 supported');
    }
    _codecVerified = true;
  } catch { }
}

// (23/09/2026 v2) UA that cua Chrome trong che do --headless=new van chua
// nguyen chu "HeadlessChrome/x.x.x.x" — con la dau hieu automation RO RANG
// hon ca viec UA bi lech phien ban (thu da bo o commit truoc, xem CHANGELOG
// V2.9.7). Khong the bo qua Emulation.setUserAgentOverride hoan toan; phai
// LAY DUNG UA THAT qua Browser.getVersion() (khong hardcode nhu ban cu —
// hardcode la nguon goc cua loi lech phien ban da sua) roi chi thay the
// "HeadlessChrome" -> "Chrome", giu nguyen moi phan con lai (bao gom so
// phien ban that) de luon tu khop moi lan Chrome trong image duoc cap nhat.
// Cache lai vi UA khong doi trong suot vong doi tien trinh Chrome.
let _cachedRealUA: string | null = null;
async function getRealChromeUserAgentAsync(session: CDPSession): Promise<string | null> {
  if (_cachedRealUA) return _cachedRealUA;
  try {
    const r = await session.send('Browser.getVersion', {}) as { userAgent?: string };
    if (r.userAgent) {
      _cachedRealUA = r.userAgent.replace('HeadlessChrome', 'Chrome');
    }
  } catch { }
  return _cachedRealUA;
}

// ============================================
// MAIN
// ============================================
export async function ensureDeviceAsync(id: string, cfg: DeviceConfig): Promise<DeviceSession> {
  const root = getRoot() as unknown as CDPRoot;
  if (!root) throw new Error("CDP not ready");

  // Cải tiến: giới hạn số device đồng thời
  if (!devices.has(id) && devices.size >= MAX_DEVICES) {
    throw new Error(
      `[device] Max device limit reached (${MAX_DEVICES}). ` +
      `Set MAX_DEVICES env var to increase. Current devices: ${[...devices.keys()].join(', ')}`
    );
  }

  let device = devices.get(id);
  if (device) {
    if (deviceConfigsEqual(device.cfg, cfg)) {
      device.lastActive = Date.now();
      device.reconnectedMs = Date.now();
      device.mediaSent = undefined;
      device.saverSent = undefined;  // (30/09/2026) thiet bi vua noi lai: gui lai 'dang phat media' o nhip toi
      // (01/10/2026) Thiet bi vua noi lai (co the da khoi dong lai): bo trang thai "co nguoi" cu — firmware chi bao khi DOI,
      // giu lai "co nguoi" cua phien truoc thi man hinh cho khong bao gio hien. Con nguoi -> firmware bao lai khi thay.
      device.presence = undefined;
      requestFullFrameFor(device);

      // (25/09/2026) Thiet bi NOI LAI (khoi dong lai / OTA / watchdog WS): moi "nghen" ghi nhan TRUOC do la cua socket
      // CU (server van day du lieu vao socket da chet, ton dong toi 1,6 MB) — khong noi gi ve duong truyen. Do that sau
      // mot lan P4 khoi dong lai: nguong tranh nghen (probeFloorMs) ket o ~400 ms, moi 35 s chi hoi 17 ms -> YouTube
      // 2,8 fps hang chuc phut. Xoa nguong do, bat dau lai tu nhip an toan; bo dieu tiet se rut dan nhu binh thuong.
      const st = adaptiveStates.get(id);
      if (st) {
        st.probeFloorMs = undefined;
        st.probeBlocked = 0;
        st.goodStreak = 0;
        st.minFrameIntervalMs = Math.min(st.minFrameIntervalMs, Math.max(cfg.minFrameInterval, SAFE_START_INTERVAL_MS));
        device.tunedMinFrameIntervalMs = st.minFrameIntervalMs;
      }
      // (01/10/2026) Dinh ton dong + uoc luong bang thong cung la cua socket CU. Do that: P4 noi lai 01:46:32, nhip ke tiep
      // (01:46:34) doc dinh 1,66 MB cua socket da chet -> ghi lai nguong tranh nghen 300 ms -> YouTube 7,7 fps, moi 35 s
      // moi nhich 17 ms (~5 phut moi toi nhip binh thuong) sau MOI lan khoi dong lai / OTA.
      device.backlogSkipPeak = 0;
      device.netHalfUntilMs = undefined;
      linkEstimates.delete(id);

      // (24/09/2026) halfScale / audioEnabled cung KHONG nam trong deviceConfigsEqual() (co dinh theo
      // firmware) -> nhanh nay tu giu gia tri cua LAN KET NOI DAU. Do that: server khoi dong lai truoc khi P4
      // OTA xong, phien duoc tao boi firmware CU (khong co half=1); firmware moi noi lai roi vao day va
      // halfScale ket o false vinh vien. Cung loai loi voi homeUrl ben duoi. Hai co nay khong can dung lai
      // gi (khong script/target nao phu thuoc) nen chi can gan lai.
      if (device.cfg.halfScale !== cfg.halfScale || device.cfg.halfVideo !== cfg.halfVideo || device.cfg.camPort !== cfg.camPort || device.cfg.sdPort !== cfg.sdPort || device.cfg.audioEnabled !== cfg.audioEnabled || device.cfg.sound !== cfg.sound ||
          device.cfg.urlSet !== cfg.urlSet || device.cfg.fbBands !== cfg.fbBands ||
          device.cfg.devControl !== cfg.devControl || device.cfg.voice !== cfg.voice || device.cfg.micCall !== cfg.micCall) {
        console.log(`[device] ${id}: cap nhat co firmware half=${cfg.halfScale}${cfg.halfVideo ? "(video)" : ""} cam=${cfg.camPort} audio=${cfg.audioEnabled} urlset=${cfg.urlSet} fb=${cfg.fbBands}`);
        const camChanged = device.cfg.camPort !== cfg.camPort || device.cfg.sdPort !== cfg.sdPort;
        device.cfg = { ...device.cfg, halfScale: cfg.halfScale, halfVideo: cfg.halfVideo, camPort: cfg.camPort, sdPort: cfg.sdPort, sound: cfg.sound, audioEnabled: cfg.audioEnabled, urlSet: cfg.urlSet,
                       fbBands: cfg.fbBands, devControl: cfg.devControl, voice: cfg.voice, micCall: cfg.micCall };
        device.processor.setBandSplit(cfg.fbBands);
        // (01/10/2026) Firmware moi co / het ung dung Camera: dung lai launcher (hien / an bieu tuong Camera).
        if (camChanged) reloadAllLaunchers().catch(() => { });
      }

      // (23/09/2026 v3) homeUrl KHONG nam trong deviceConfigsEqual() (co y —
      // xem config.ts) nen nhanh nay khong tu cap nhat no. Ket qua that do tren
      // may that: nut "Home" trong dropdown launcher bi ket vinh vien voi gia
      // tri cua LAN KET NOI DAU TIEN (thuong rong do dua tren firmware —
      // xem CHANGELOG V2.9.5), moi lan noi lai sau do (vd tu reconnect_ws()
      // firmware vua goi) deu roi vao day va bi bo qua. Phai tu tay go +
      // dang ky lai script KHI homeUrl thuc su doi, dong thoi ap dung NGAY
      // cho trang dang mo (khong doi navigate/reload moi thay).
      if (cfg.homeUrl !== device.cfg.homeUrl) {
        const oldHomeUrl = device.cfg.homeUrl;
        device.cfg = cfg;
        reloadLauncher(device).then(ok => {
          if (ok) console.log(`[device] ✓ Launcher cap nhat homeUrl cho ${id}: "${oldHomeUrl || '(rong)'}" -> "${cfg.homeUrl}"`);
        });
      }

      return device;
    }
    console.log(`[device] Reconfiguring ${id}`);
    await deleteDeviceAsync(device);
  }

  // (26/09/2026 OS-2) TAO TAB DAU TIEN — Home Assistant (ghim) neu thiet bi da bao ?home=, khong thi tab 'browser'
  // (se duoc navigateToUrl() dua ve dung tab ngay khi OpenURL dau tien toi — xem index.ts pendingOpenURLs). Phai tao
  // XONG (co session that) roi moi dua vao `devices`: cac noi khac (dispatch cham, self-test...) doc `dev.cdp` ma
  // khong kiem tra null, giong bat bien cua ban goc mot-tab (session luon san sang truoc khi thiet bi "hien dien").
  const processor = new FrameProcessor({
    tileSize: cfg.tileSize,
    fullframeTileCount: cfg.fullFrameTileCount,
    fullframeAreaThreshold: cfg.fullFrameAreaThreshold,
    jpegQuality: cfg.jpegQuality,
    fullFrameEvery: cfg.fullFrameEvery,
    maxBytesPerMessage: cfg.maxBytesPerMessage,
    bandSplit: cfg.fbBands,
  });

  metrics.setConfig(id, cfg);
  const newDevice: DeviceSession = {
    id: '', deviceId: id, cdp: undefined as unknown as CDPSession, cfg,
    url: '', lastActive: Date.now(), frameId: 0, prevFrameHash: 0,
    processor, selfTestRunner: new SelfTestRunner(broadcaster),
    pendingB64: undefined, throttleTimer: undefined, lastProcessedMs: undefined,
    lastBacklogLogMs: undefined,
    tunedMinFrameIntervalMs: Math.max(cfg.minFrameInterval, SAFE_START_INTERVAL_MS),
    // (21/10/2026) Nho chat luong nguoi dung da dat (luu trong /data/rwv-panel-prefs.json).
    qualityOverride: panelPrefs.qualityPct(id) || undefined,   // 0 = tu dong
    lastInputMs: undefined,
    consecutiveFrameErrors: 0, // Cải tiến: tracking lỗi liên tiếp
    recentFrameMs: [], passthroughFrames: 0, passthroughOn: false,
    halfOn: false, halfFrames: 0, forceSharp: false,
    tabs: new Map<string, Tab>(), activeTabKey: '', tabOps: new SerialQueue(),
    lastTouchMs: Date.now(), saverOn: false,
  };

  const initialKey = cfg.homeUrl ? 'home' : 'browser';
  const initialTab = await createTab(newDevice, initialKey, cfg.homeUrl ? 'ha' : 'browser', !!cfg.homeUrl,
    cfg.homeUrl ? 'Home Assistant' : 'Chrome');
  newDevice.id = initialTab.targetId;
  newDevice.cdp = initialTab.session;
  devices.set(id, newDevice);
  // activateTab() tu lam: bat screencast TRUOC (tren trang trang, an toan — xem createTab()), cho phep am thanh
  // (neu thiet bi co loa), ep gui khung day du. Dieu huong toi homeUrl chi sau khi screencast da chay.
  await activateTab(newDevice, initialKey);
  if (cfg.homeUrl) await navigateTab(newDevice, initialTab, cfg.homeUrl);

  // (24/09/2026) Xem markInteraction: gui lai khung video cuoi o do phan giai day du ngay lap tuc.
  newDevice.sharpenNow = () => {
    const dev = newDevice;
    if (!dev.lastVideoB64 || dev.pendingB64) return;
    if (dev.sharpTimer) { clearTimeout(dev.sharpTimer); dev.sharpTimer = undefined; }
    dev.forceSharp = true;
    dev.pendingB64 = dev.lastVideoB64;
    dev.lastVideoB64 = undefined;
    dev.prevFrameHash = -1;
    if (!dev.throttleTimer) dev.throttleTimer = setTimeout(() => flushPending(dev), 0);
  };

  console.log(`[device] ✓ Device ${id} ready (${cfg.width}x${cfg.height}) [${devices.size}/${MAX_DEVICES} slots used]`);
  return newDevice;
}

// (26/09/2026 OS-2) Tach khoi ensureDeviceAsync() thanh HAM CAP MODULE, nhan `dev` lam tham so thay vi dong ("moi
// tab moi thiet bi mot ham") — moi tab (createTab()) chi can goi flushPending(dev), khong can tu dinh nghia lai
// toan bo duong ong nen anh. Duong ong giai ma/nen/gui NGUYEN VEN nhu ban mot-tab: no thuoc ve THIET BI (cai gi
// dang duoc GUI toi man hinh), khong thuoc ve tab nguon — chi NGUON (session nao dang active) doi khi chuyen tab.
async function flushPending(dev: DeviceSession): Promise<void> {
    dev.throttleTimer = undefined;
    // (23/09/2026) MOT KHUNG MOT LUC — xem `flushInFlight`. Khong BO khung o
    // day: `pendingB64` luon giu khung MOI NHAT, nen hen lai mot nhip ngan la
    // khung ke tiep van la khung moi nhat tai thoi diem do.
    if (dev.flushInFlight) {
      if (!dev.throttleTimer) dev.throttleTimer = setTimeout(() => flushPending(dev), 10);
      return;
    }
    dev.flushInFlight = true;
    // (17/09/2026) SUA LOI DIEU NHIP: danh moc NGAY KHI BAT DAU, khong doi den
    // `finally`. Truoc day `throttleTimer` duoc xoa o dau ham nhung
    // `lastProcessedMs` chi cap nhat o CUOI — sau ~200ms encode. Trong khoang
    // trong do, khung screencast moi den se thay throttleTimer rong VA `since`
    // da lon hon nhip -> delay = 0 -> chay ngay. Nhip thuc te co lai con bang
    // thoi gian encode thay vi effInterval.
    // Do that: adaptive dat mfi=400 (le ra 2.5fps) nhung server van gui 3.93fps.
    // (25/09/2026) `finally` KHONG con ghi de moc nay — nhip tinh tu luc BAT DAU khung truoc (xem finally).
    dev.lastProcessedMs = Date.now();

    try {
      const b64 = dev.pendingB64;
      dev.pendingB64 = undefined;
      if (!b64) return;

      // (17/09/2026) ÁP LỰC NGƯỢC — bỏ khung khi thiết bị chưa tiêu hoá kịp.
      //
      // PHẢI chặn Ở ĐÂY, TRƯỚC processFrameAsync(). Nếu bỏ khung ở tầng
      // broadcaster thì FrameProcessor đã tính sai phân xong và coi như thiết bị
      // ĐÃ NHẬN các tile đó; vứt đi = vùng ảnh ấy hỏng vĩnh viễn cho tới full-frame
      // kế tiếp. Bỏ ở đây thì nền so sánh giữ nguyên, khung sau vẫn diff đúng.
      //
      // Bỏ nguyên khung (không bỏ một phần) để không bao giờ sinh khung rách.
      const backlog = broadcaster.backlogBytes(dev.deviceId);
      const highWater = tuning().wsHighWaterBytes ?? WS_HIGH_WATER_BYTES;
      // (01/10/2026) NGHEN -> NUA DO PHAN GIAI (chi thiet bi half=1: P4). Do that 01/10 sang: YouTube thuong khung day du
      // ~42 KB, WiFi P4 yeu di -> ton dong 200 -> 934 KB, ping P4 2 s, WebSocket roi/noi lai, dung hinh ~40 s moi lan.
      // Ton dong qua NUA nguong bo khung -> gui khung nua (1/4 byte) toi NET_HALF_HOLD_MS sau lan nghen cuoi. Van chi ap
      // khi dang co video (dieu kien <video>/dien tich ben duoi). S3 (half=2) da luon nua khi phat video: khong doi.
      if (NET_HALF_HOLD_MS > 0 && dev.cfg.halfScale && !dev.cfg.halfVideo && backlog > highWater / 2) {
        const nowNet = Date.now();
        const hold = tuning().netHalfHoldMs ?? NET_HALF_HOLD_MS;
        if (dev.netHalfUntilMs === undefined || nowNet >= dev.netHalfUntilMs) {
          dev.netHalfStartMs = nowNet;
          console.log(`[half] ${dev.deviceId}: duong truyen nghen (ton dong ${backlog}B) -> cho phep khung nua ${hold / 1000} s`);
        }
        dev.netHalfUntilMs = nowNet + hold;
      }
      if (backlog > highWater) {
        metrics.onFrameSkipped(dev.deviceId);
        dev.backlogSkipPeak = Math.max(dev.backlogSkipPeak ?? 0, backlog);
        dev.lastProcessedMs = Date.now();
        if (Date.now() - (dev.lastBacklogLogMs ?? 0) > 5000) {
          dev.lastBacklogLogMs = Date.now();
          console.warn(`[device] ${dev.deviceId}: bo khung, ton dong socket ${backlog}B > ${highWater}B`);
        }
        return;
      }

      // Cải tiến: xử lý JPEG thay PNG
      // Với format jpeg, Chrome gửi JPEG data trực tiếp.
      // sharp vẫn được dùng để rotation (nếu có) và decode sang raw RGBA cho FrameProcessor.
      // Nếu KHÔNG có rotation: giảm 1 bước decode (bỏ qua ensureAlpha vẫn hoạt động với JPEG).
      let imgBuf = Buffer.from(b64, 'base64');
      // (23/10/2026) Tab co viewport khac man (yttv 1920x1080) -> thu nho ve kich thuoc man truoc khi xu ly.
      const at = dev.tabs.get(dev.activeTabKey);
      if (at?.vw && at.vh && (at.vw !== dev.cfg.width || at.vh !== dev.cfg.height)) {
        imgBuf = await sharp(imgBuf).resize(dev.cfg.width, dev.cfg.height, { fit: 'fill' }).jpeg({ quality: 92, chromaSubsampling: '4:2:0' }).toBuffer();
      }
      const h32 = hash32(imgBuf);
      if (dev.prevFrameHash === h32) {
        metrics.onFrameSkipped(dev.deviceId);
        dev.lastProcessedMs = Date.now();
        return;
      }
      dev.prevFrameHash = h32;

      // ════════════════════════════════════════════════════════════════════
      // (16/09/2026) ĐƯỜNG TẮT: CHUYỂN THẲNG JPEG CỦA CHROME
      // ────────────────────────────────────────────────────────────────────
      // Đường thường nén JPEG HAI LẦN: Chrome đã encode JPEG, ta giải nén ra
      // RGBA rồi encode lại. Vừa tốn CPU cả hai đầu vừa mất chất lượng thế hệ
      // thứ hai. (Lưu ý: `encodeMs` trong /metrics đo SAU bước sharp decode,
      // nên chi phí giải nén trước đó chưa từng được tính.)
      //
      // Khi đang phát VIDEO thì gần như khung nào cũng đổi toàn bộ, tức kiểu gì
      // cũng gửi full-frame. Lúc đó ảnh của Chrome dùng được ngay — chuyển
      // thẳng, bỏ cả decode lẫn encode.
      //
      // Nhận biết "đang phát video" bằng NHỊP ĐẾN của screencast, không phải
      // bằng kết quả của FrameProcessor: muốn biết kết quả đó thì đã phải giải
      // nén rồi (bài toán con gà - quả trứng). Chrome chỉ phát khi trang vẽ lại
      // nên nhịp cao = nội dung động.
      //
      // QUAN TRỌNG: mỗi lần đi đường tắt, bảng băm tile trong FrameProcessor
      // không được cập nhật -> phải requestFullFrame() để khung kế tiếp đi
      // đường thường dựng lại nền so sánh cho đúng, nếu không sẽ sinh khung
      // rách khi quay về chế độ vi sai.
      const nowMs = Date.now();
      const sharpRefresh = dev.forceSharp;
      dev.forceSharp = false;
      if (!sharpRefresh) dev.recentFrameMs.push(nowMs);
      if (dev.recentFrameMs.length > PASSTHROUGH_RATE_WINDOW) dev.recentFrameMs.shift();
      let fps = 0;
      if (dev.recentFrameMs.length >= PASSTHROUGH_RATE_WINDOW) {
        const span = nowMs - dev.recentFrameMs[0];
        if (span > 0) fps = (dev.recentFrameMs.length - 1) * 1000 / span;
      }
      if (!sharpRefresh) videoScreencastQuality(dev, fps, nowMs);

      // ══════════════════════════════════════════════════════════════════
      // (24/09/2026) KHUNG VIDEO NUA DO PHAN GIAI (thiet bi bao ?half=1 — P4)
      // ──────────────────────────────────────────────────────────────────
      // Do that tren P4 phat YouTube: 6-7 fps. Mang tho du (tai TCP 2 MB/s), nhung
      // moi khung 50-86 KB ton ~50 ms xu ly tren thiet bi (giai ma + chep 1,2 MB)
      // va phai chia 2-3 goi WS (vuot cap 32 KB -> ca passthrough ben duoi cung
      // khong bao gio kich hoat). O 512x300: ~1/4 byte (vua 1 goi), giai ma 1/4 so
      // diem anh; thiet bi phong x2 bang PPA phan cung. sharp thu nho JPEG theo he
      // so 2 bang shrink-on-load (libjpeg giai ma thang o 1/2) nen re.
      //
      // Chi ap khi nhip den cao (video). Video dung ~SHARP_REFRESH_MS khong co khung
      // moi -> gui lai khung cuoi o do phan giai DAY DU (duong thuong) cho net lai.
      // Hysteresis: bat khi nhip >= HALF_ON_FPS, chi tat khi < HALF_OFF_FPS. Do that lan dau voi mot nguong 8 fps:
      // nhip den lai do chinh server dieu tiet (~8 fps) nen bat/tat lien tuc quanh nguong.
      const netHalf = dev.netHalfUntilMs !== undefined && nowMs < dev.netHalfUntilMs;
      // (26/10/2026) TAM TAT half-scale: thinh thoang panel S3 ve anh nhu co 1/4 (co chuong hop lech giua
      // khung half + co halfScale). Bang thong LAN du, uu tien dung hinh.
      // (26/10/2026) Man RAT NHO (<=480x272): KHONG dung half-scale. Gui nua do phan giai (240x136) roi phong len
      // lam YouTube mo han; khung 480x272 chi ~130k pixel nen gui full van nhe.
      const smallScreen = dev.cfg.width <= 480 && dev.cfg.height <= 272;
      const HALF_ENABLED = !smallScreen;
      let halfWanted = HALF_ENABLED && (dev.halfOn ? fps >= HALF_OFF_FPS : fps >= HALF_ON_FPS);
      // (30/09/2026) Thiet bi half=2 (S3): KHONG xet nhip. Do that 30/09: S3 giai ma cham -> server gian nhip con ~2,5 fps
      // = dung nguong HALF_ON_FPS -> nua do phan giai bat/tat lien tuc, xen khung day du 24-65 KB (5,6 fps). Chi con
      // dieu kien <video> dang phat / phan lon man hinh doi (ben duoi, giu HALF_SUSTAIN_MS).
      if (dev.cfg.halfVideo) halfWanted = true;
      // Dang nghen thi bo dieu tiet da gian nhip (fps den thap) — khong de nguong fps chan che do cuu.
      if (netHalf) halfWanted = true;
      // (30/09/2026) Nua do phan giai: toan cuc (HALF_SCALE_VIDEO=1), hoac rieng tab YouTube TV khi nguon <= YT_TV_HALF_MAX_H.
      // (07/10/2026) + ung dung IPTV: cung la TV toan man hinh. Do that P4 (VTV1 1080p50): khung day du ~100 KB o q40 ->
      // duong truyen nghen, dieu tiet xuong 2,5 fps; ap cung chinh sach khung qua to -> nua do phan giai nhu YouTube TV.
      const activeKind = dev.tabs.get(dev.activeTabKey)?.kind;
      // Tat rieng cho IPTV (do A/B 07/10 khi mang P4 da khoe): /data/rwv-tuning.json {"iptvHalf": false} — nong, khong khoi dong lai.
      const tvTab = YT_TV_HALF_MAX_H > 0 && (activeKind === 'yttv' || (activeKind === 'iptv' && tuning().iptvHalf !== false));
      const halfProbe = dev.cfg.halfScale && (HALF_SCALE_VIDEO || tvTab || dev.cfg.halfVideo || netHalf);
      // (30/09/2026) Them: khung day du QUA TO (> 2 lan goi) cung gui nua do phan giai. Do that: truyen YouTube TV nguon
      // 720p -> anh Chrome 80-93 KB (q90), van 59 KB o q40 -> P4 giai ma ~120 ms/khung, WS nghen 2,2 MB roi noi lai.
      // GIU 10 s: khung 720p dao dong quanh nguong -> truoc day bat/tat tung khung (do 30/09, 2.9.77: ~190 khung day du
      // lon xen giua, 20 fps, loa vap 68 lan) — moi lan tat lai phai gui ca khung net.
      if (tvTab && imgBuf.length > 2 * (dev.cfg.maxBytesPerMessage - FRAME_HEADER_BYTES - TILE_HEADER_BYTES)) dev.tvBigMs = nowMs;
      const tooBigFull = tvTab && dev.tvBigMs !== undefined && nowMs - dev.tvBigMs < 10_000;
      let halfSend = halfProbe && (HALF_SCALE_VIDEO || dev.cfg.halfVideo || netHalf || tooBigFull ||
        (dev.videoSrcH != null && dev.videoSrcH > 0 && dev.videoSrcH <= YT_TV_HALF_MAX_H));
      // (24/09/2026) NHIP CAO CHUA DU: mot tab dashboard co anh dong NHO cung lam Chrome phat khung lien tuc ->
      // ca man hinh bi gui nua do phan giai, giao dien mo han (nguoi dung bao ngay). Phai co PHAN LON man hinh
      // doi moi la video: so anh thu nho xam 64x38 (sharp giai ma thang o kich thuoc nho — re) voi khung truoc.
      if (halfWanted && halfProbe && !sharpRefresh) {
        const thumb = await sharp(imgBuf).resize(64, 38, { fit: 'fill' }).greyscale().raw().toBuffer();
        let changed = 0;
        if (dev.prevThumb && dev.prevThumb.length === thumb.length) {
          for (let i = 0; i < thumb.length; i++) if (Math.abs(thumb[i] - dev.prevThumb[i]) > 10) changed++;
        }
        dev.prevThumb = thumb;
        const pct = changed / thumb.length;
        // Hoi Chrome o nen (khong cho) — dung ket qua gan nhat; qua cu (> 3 nhip hoi) thi coi nhu khong co.
        if (!dev.videoProbeBusy && (dev.videoProbeMs === undefined || nowMs - dev.videoProbeMs >= VIDEO_PROBE_MS)) {
          dev.videoProbeBusy = true;
          dev.cdp.send('Runtime.evaluate', { expression: VIDEO_PROBE_JS, returnByValue: true })
            .then((r) => {
              const v = (r as { result?: { value?: { a?: number; h?: number } } }).result?.value;
              dev.videoElArea = typeof v?.a === 'number' ? v.a : 0;
              dev.videoSrcH = typeof v?.h === 'number' ? v.h : 0;
            })
            .catch(() => { dev.videoElArea = 0; dev.videoSrcH = 0; })
            .finally(() => { dev.videoProbeMs = Date.now(); dev.videoProbeBusy = false; });
        }
        const videoEl = dev.videoProbeMs !== undefined && nowMs - dev.videoProbeMs < VIDEO_PROBE_MS * 3 &&
          (dev.videoElArea ?? 0) >= HALF_VIDEO_EL_AREA;
        const qualifies = videoEl || pct > (dev.halfOn ? HALF_KEEP_AREA : HALF_ON_AREA);
        if (qualifies) dev.halfLastQualifyMs = nowMs;
        // (24/09/2026) Chuyen tab = MOT dot thay doi lon ngan (hieu ung vai khung), khong phai video. Truoc day no du
        // dieu kien -> ca man hinh nua do phan giai, giu 3 s, lam net sau 0,7 s -> mo 1-2 s moi lan chuyen tab (nguoi
        // dung bao). Nay phai thoa LIEN TUC it nhat HALF_SUSTAIN_MS moi bat.
        if (!qualifies) dev.halfStreakStartMs = undefined;
        else if (dev.halfStreakStartMs === undefined) dev.halfStreakStartMs = nowMs;
        const sustained = dev.halfStreakStartMs !== undefined && nowMs - dev.halfStreakStartMs >= HALF_SUSTAIN_MS;
        // GIU che do video HALF_HOLD_MS sau khung thoa cuoi: video nguoi noi co canh gan nhu tinh (dien tich doi
        // nho) -> truoc day tat/bat lien tuc, MOI lan tat server phai gui lai ca khung net 125-144 KB -> giat.
        halfWanted = (dev.halfOn ? qualifies : sustained) ||
          (dev.halfOn && dev.halfLastQualifyMs !== undefined && nowMs - dev.halfLastQualifyMs < HALF_HOLD_MS);
        // Dang THAO TAC (vua cham man hinh) -> luon gui NET: nguoi dung dang nhin giao dien de bam tiep.
        if (dev.lastInputMs !== undefined && nowMs - dev.lastInputMs < HALF_AFTER_TOUCH_MS) {
          halfWanted = false;
          dev.halfStreakStartMs = undefined;
        }
      } else {
        dev.prevThumb = undefined;
      }
      // (22/10/2026) Sunton 800x480 (S3, giai ma JPEG phan mem 45-79 ms/khung -> 2,5-7 fps):
      // voi thiet bi bat half_scale_video (half=2) ma van dang gui khung day du, EP nua khung
      // khi DANG PHAT VIDEO (tab YouTube/YouTube TV/IPTV hoac co <video> chiem man hinh).
      // UI tinh van gui khung day du nen chu/giao dien van net. Firmware phong x2 (PPA o P4,
      // phan mem o S3) — xem remote_webview.cpp:236.
      const VIDEO_TAB_KINDS = new Set(['youtube', 'yttv', 'iptv', 'media', 'music', 'tiktok', 'vtvgo', 'phim']);
      if (dev.cfg.halfVideo && !dev.cfg.rotation) {
        if (VIDEO_TAB_KINDS.has(activeKind ?? '') || (dev.videoElArea ?? 0) >= HALF_VIDEO_EL_AREA) {
          halfSend = true;
          halfWanted = true;
        } else if (!netHalf) {
          // UI tinh: LUON khung day du de chu/net (truoc day bat/tat xen ke -> chu mo tung luc).
          halfWanted = false;
        }
      }
      if (!sharpRefresh && halfSend && halfWanted && !dev.cfg.rotation) {
        const capBytes = dev.cfg.maxBytesPerMessage - FRAME_HEADER_BYTES - TILE_HEADER_BYTES;
        const fullW = dev.cfg.width, fullH = dev.cfg.height;
        const halfW = Math.ceil(fullW / 2), halfH = Math.ceil(fullH / 2);
        let halfJpeg: Buffer | undefined;
        // (22/10/2026) Sunton: video khong can net tung diem -> tran q40 (tuning videoQCap) giup giam byte/khung
        // va thoi gian giai ma; bo dieu tiet van tu do ha/giu chat luong cho khung TINH (UI).
        const videoQCap = tuning().videoQCap ?? 40;
        const baseQ = Math.min(dev.processor.tuning.jpegQuality, videoQCap);
        for (const factor of [1, 0.75, 0.55]) {
          const q = Math.max(20, Math.round(baseQ * factor));
          const b = await sharp(imgBuf).resize(halfW, halfH).jpeg({ quality: q, chromaSubsampling: '4:2:0' }).toBuffer();
          if (b.length <= capBytes) { halfJpeg = b; break; }
        }
        if (halfJpeg) {
          const out = {
            rects: [{ x: 0, y: 0, w: fullW, h: fullH, data: halfJpeg }],
            isFullFrame: true,
            encoding: Encoding.JPEG,
            halfScale: true,
          };
          requestFullFrameFor(dev);  // khung duong thuong ke tiep dung lai nen so sanh
          dev.halfFrames++;
          if (!dev.halfOn) {
            dev.halfOn = true;
            console.log(`[half] ${dev.deviceId}: bat (nhip ${fps.toFixed(1)} fps, <video> ${((dev.videoElArea ?? 0) * 100).toFixed(0)}% man hinh, ${imgBuf.length} -> ${halfJpeg.length} B/khung)`);
          }
          metrics.onFrameEncoded(dev.deviceId, out, dev.processor.stats, 0);
          dev.frameId = (dev.frameId + 1) >>> 0;
          broadcaster.sendFrameChunked(dev.deviceId, out, dev.frameId, dev.cfg.maxBytesPerMessage);
          dev.consecutiveFrameErrors = 0;
          dev.lastProcessedMs = Date.now();
          // Hen lam net: moi khung video moi dat lai dong ho.
          dev.lastVideoB64 = b64;
          if (dev.sharpTimer) clearTimeout(dev.sharpTimer);
          dev.sharpTimer = setTimeout(() => {
            dev.sharpTimer = undefined;
            if (devices.get(dev.deviceId) !== dev || dev.pendingB64 || !dev.lastVideoB64) return;
            dev.forceSharp = true;
            dev.pendingB64 = dev.lastVideoB64;
            dev.lastVideoB64 = undefined;
            dev.prevFrameHash = -1;
            if (!dev.throttleTimer) dev.throttleTimer = setTimeout(() => flushPending(dev), 0);
          }, SHARP_REFRESH_MS);
          return;
        }
      }
      if (dev.halfOn) {
        dev.halfOn = false;
        // (26/10/2026) FIX 'co 1/4': khi chuyen half -> full phai EP gui mot khung DAY DU va xoa moc so sanh,
        // neu khong panel con giu anh nen nua kich thuoc -> ve anh nua co vao khung day (thinh thoang moi thay).
        requestFullFrameFor(dev);
        dev.forceSharp = true;
        dev.prevFrameHash = -1;
        console.log(`[half] ${dev.deviceId}: tat (nhip ${fps.toFixed(1)} fps${sharpRefresh ? ', lam net' : ''}) -> ep khung day du`);
      }
      // ══════════════════════════════════════════════════════════════════

      const why = (dev.slowWhy ??= { fps: 0, big: 0, dims: 0, sharp: 0, lastBytes: 0, lastW: 0, lastH: 0 });
      why.lastBytes = imgBuf.length;
      let slowReason: 'fps' | 'big' | 'dims' | 'sharp' = sharpRefresh ? 'sharp' : 'fps';
      if (fps >= PASSTHROUGH_MIN_FPS && !dev.cfg.rotation) {
        slowReason = 'big';
        const capBytes = dev.cfg.maxBytesPerMessage - FRAME_HEADER_BYTES - TILE_HEADER_BYTES;
        // (30/09/2026) NEN LAI CHO VUA. Do 30/09 (P4, YouTube, Chrome nen q40): khung Chrome TB ~28 KB, rat nhieu khung
        // vuot tran ~32 KB -> roi ve duong thuong (giai nen ca khung ra RGBA, so sanh o, nen lai tung o) — ho so CPU:
        // processFrameAsync la ham ton nhat, duong tat bat/tat lien tuc. Khung hoi vuot (<= 2x tran): nen lai MOT lan ca
        // khung o chat luong thap dan cho toi khi vua mot goi — mot lan giai nen + mot lan nen, khong RGBA/so sanh o.
        // Tat nong: "passthroughFit": false trong /data/rwv-tuning.json.
        let passBuf: Buffer | undefined = imgBuf.length <= capBytes ? imgBuf : undefined;
        let fitted = false;
        if (!passBuf && imgBuf.length <= capBytes * 2 && tuning().passthroughFit !== false) {
          for (const factor of [0.85, 0.7, 0.55]) {
            const q = Math.max(20, Math.round(dev.processor.tuning.jpegQuality * factor));
            const b = await sharp(imgBuf).jpeg({ quality: q, chromaSubsampling: '4:2:0' }).toBuffer();
            if (b.length <= capBytes) { passBuf = b; fitted = true; break; }
          }
        }
        if (passBuf) {
          // metadata() chỉ đọc header JPEG (không giải nén pixel) nên rất rẻ.
          const meta = await sharp(imgBuf).metadata();
          why.lastW = meta.width ?? 0; why.lastH = meta.height ?? 0;
          slowReason = 'dims';
          if (meta.width === dev.cfg.width && meta.height === dev.cfg.height) {
            if (fitted) dev.fitFrames = (dev.fitFrames ?? 0) + 1;
            dev.lowqBigRun = 0;
            const out = {
              rects: [{ x: 0, y: 0, w: meta.width, h: meta.height, data: passBuf }],
              isFullFrame: true,
              encoding: Encoding.JPEG,
            };
            requestFullFrameFor(dev);
            dev.passthroughFrames++;
            if (!dev.passthroughOn) {
              dev.passthroughOn = true;
              console.log(`[passthrough] ${dev.deviceId}: bật (nhịp ${fps.toFixed(1)} fps, ${imgBuf.length} B/khung)`);
            }
            metrics.onFrameEncoded(dev.deviceId, out, dev.processor.stats, 0);
            dev.frameId = (dev.frameId + 1) >>> 0;
            broadcaster.sendFrameChunked(dev.deviceId, out, dev.frameId, dev.cfg.maxBytesPerMessage);
            dev.consecutiveFrameErrors = 0;
            dev.lastProcessedMs = Date.now();
            return;
          }
        }
      }
      if (dev.passthroughOn) {
        dev.passthroughOn = false;
        console.log(`[passthrough] ${dev.deviceId}: tắt (nhịp ${fps.toFixed(1)} fps) — quay về đường thường`);
      }
      // ════════════════════════════════════════════════════════════════════

      dev.slowFrames = (dev.slowFrames ?? 0) + 1;
      why[slowReason]++;
      // (30/09/2026) Ha chat luong KHONG giup: trang xem YouTube thuong (video chi mot phan man hinh, con lai chu/anh)
      // o q40 van ~54 KB (do: q90 129 KB) -> khong bao gio vua goi; duong cham (chi gui o doi) moi la dung, con chu thi
      // mo them. 15 khung lien tiep nhu vay -> tra ve chat luong tinh, 5 phut khong thu lai.
      const actTab = dev.tabs.get(dev.activeTabKey);
      if (slowReason === 'big' && actTab && actTab.scQuality === dev.cfg.jpegQuality
          && dev.cfg.maxBytesPerMessage < 131072 && SCREENCAST_JPEG_QUALITY !== dev.cfg.jpegQuality) {
        dev.lowqBigRun = (dev.lowqBigRun ?? 0) + 1;
        if (dev.lowqBigRun >= 15) {
          dev.lowqBigRun = 0;
          if (dev.lowqTimer) { clearTimeout(dev.lowqTimer); dev.lowqTimer = undefined; }
          dev.lowqBackoffUntil = Date.now() + 5 * 60_000;
          setScreencastQuality(dev, actTab, SCREENCAST_JPEG_QUALITY, `van qua to o q${dev.cfg.jpegQuality} (${Math.round(imgBuf.length / 1024)} KB) — video khong phu man hinh`);
          requestFullFrameFor(dev);
        }
      } else if (slowReason !== 'big') {
        dev.lowqBigRun = 0;
      }
      let img = sharp(imgBuf);
      if (dev.cfg.rotation) img = img.rotate(dev.cfg.rotation);
      const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const _tEnc = Date.now();
      const out = await dev.processor.processFrameAsync({ data, width: info.width, height: info.height });
      metrics.onFrameEncoded(dev.deviceId, out, dev.processor.stats, Date.now() - _tEnc);
      if (out.rects.length > 0) {
        dev.frameId = (dev.frameId + 1) >>> 0;
        broadcaster.sendFrameChunked(dev.deviceId, out, dev.frameId, dev.cfg.maxBytesPerMessage);
      }

      // Cải tiến: reset bộ đếm lỗi sau frame thành công
      dev.consecutiveFrameErrors = 0;

    } catch (e) {
      // Cải tiến: đếm lỗi liên tiếp và tự restart device khi vượt ngưỡng
      dev.consecutiveFrameErrors++;
      metrics.onFrameError(dev.deviceId, (e as Error).message);
      console.warn(
        `[device] Frame error ${dev.deviceId} (${dev.consecutiveFrameErrors}/${MAX_CONSECUTIVE_FRAME_ERRORS}): ` +
        `${(e as Error).message}`
      );
      if (dev.consecutiveFrameErrors >= MAX_CONSECUTIVE_FRAME_ERRORS) {
        console.error(
          `[device] Too many consecutive frame errors on ${dev.deviceId}, scheduling device restart...`
        );
        dev.consecutiveFrameErrors = 0;
        // Restart bất đồng bộ — không block pipeline hiện tại
        setImmediate(async () => {
          try {
            const currentDev = devices.get(dev.deviceId);
            if (currentDev) {
              console.log(`[device] Restarting device ${dev.deviceId} after repeated errors`);
              await deleteDeviceAsync(currentDev);
              await ensureDeviceAsync(dev.deviceId, dev.cfg);
            }
          } catch (restartErr) {
            console.error(`[device] Restart failed for ${dev.deviceId}:`, (restartErr as Error).message);
          }
        });
      }
    } finally {
      // (25/09/2026) KHONG ghi de lastProcessedMs o day nua: truoc day nhip tinh tu luc XONG khung truoc, tuc chu ky
      // thuc = nhip + thoi gian xu ly (do do phan giai day du: 66 ms + ~35-40 ms giai nen/nen -> ~10 fps thay vi 15).
      // Moc da danh o DAU ham (xem tren) -> chu ky = max(nhip, thoi gian xu ly). Van MOT khung mot luc (flushInFlight).
      dev.flushInFlight = false;
    }}

export async function cleanupIdleAsync(ttlMs = 5 * 60_000) {
  if (_cleanupRunning) return;
  _cleanupRunning = true;
  try {
    const now = Date.now();
    const stale = Array.from(devices.values())
      .filter(d => now - d.lastActive > ttlMs).map(d => d.deviceId);
    if (stale.length > 0) {
      console.log(`[device] Cleaning up ${stale.length} idle device(s): ${stale.join(', ')}`);
    }
    for (const id of stale) {
      const dev = devices.get(id);
      if (dev) await deleteDeviceAsync(dev).catch(() => { });
    }
  } finally { _cleanupRunning = false; }
}

// (15/09/2026) BẢO HIỂM LÀM MỚI MÀN HÌNH: định kỳ ép gửi 1 full-frame cho mỗi thiết bị.
// Ca thực tế đã gặp: server khởi động lại / trang bị đen -> thiết bị giữ ảnh cũ (màn hình
// trắng chỉ sáng đèn nền) mà KHÔNG có frame mới để tự sửa. Ép full-frame định kỳ bảo đảm
// màn hình luôn được vẽ lại (chi phí ~10-25KB mỗi 60s, không đáng kể).
export function refreshDisplaysTick(): void {
  // (17/09/2026) 60s -> 5 phut.
  //
  // Day la BAO HIEM chong "man hinh giu anh cu", khong phai co che chinh. Nhung
  // moi lan chay la mot full-frame (~50KB) cho MOI thiet bi — o nhip 60s thi do
  // la mot cu soc tai deu dan moi phut, va no chinh la thu lam cac phep do dao
  // dong trong suot buoi dieu tra.
  //
  // Ban goc cua strange-v KHONG co co che nay. Gio da co cac tuyen phong thu
  // khac (ap luc nguoc, vong dieu tiet, full_frame_every cua chinh
  // FrameProcessor), nen bao hiem nay chi can chay thua thot.
  // Dat CCR_REFRESH_MS=0 de tat han.
  const ms = Number(process.env.CCR_REFRESH_MS ?? 300_000);
  if (!ms) return;
  for (const d of devices.values()) {
    try { requestFullFrameFor(d); } catch { /* bỏ qua */ }
  }
}

// (14/09/2026) GĐ3: vòng điều khiển thích nghi cho TỪNG thiết bị.
// Chạy định kỳ; đọc số đo thật (decode mới nhất do thiết bị báo, bytes/s) rồi chỉnh
// quality/nhịp. Tắt bằng biến môi trường CCR_ADAPTIVE=0.
const adaptiveStates = new Map<string, AdaptiveState>();
// (24/09/2026) Uoc luong duong truyen theo thiet bi, cap nhat moi tick (5s). Xem adaptive.ts.
const linkEstimates = new Map<string, LinkEstimate>();

/** (17/09/2026) Danh dau thiet bi vua nhan su kien cham — xem lastInputMs. */
export function markInteraction(deviceId: string): void {
  const d = devices.get(deviceId);
  if (!d) return;
  d.lastInputMs = Date.now();
  d.lastTouchMs = d.lastInputMs;
  // (07/10/2026) Dang KHOA: cham khong go (Shell chi mo khi vuot len) — chi sang lai man hinh.
  if (d.locked && d.saverOn) wakeBrightWhileLocked(d);
  else setSaver(d, false);  // Shell tu go man hinh cho khi duoc cham (cham do bi "nuot", khong toi trang)
  // (24/09/2026) Cham luc man hinh dang o nua do phan giai: lam net NGAY, khong doi khung moi / hen gio 0,7 s.
  if (d.halfOn && d.sharpenNow) d.sharpenNow();
}

/**
 * (26/09/2026, sua loi 2.9.52) HOAT DONG KHONG QUA CHAM cung dat lai moc man hinh cho va go no ngay: mo URL tu HA /
 * nut Go Home, mo-chuyen ung dung, den nen vua bat lai, trang bat dau phat video, trang tu dieu huong. Truoc day chi
 * cu cham moi tinh -> mo video tu HA thi 5 s sau man hinh cho phu len tab moi (video chua kip phat), Go Home toi
 * dung URL cu (khong tai lai) thi man hinh cho cu nam nguyen. Go o CA tab dang hien lan (neu co) tab `alsoTab`.
 */
function noteActivity(dev: DeviceSession, why: string, alsoTab?: Tab): void {
  dev.lastTouchMs = Date.now();
  // (07/10/2026) Dang KHOA: den nen bat lai, trang tu dieu huong / tu phat, chuong cua (ke ca luc vao / ra tab chuong) KHONG
  // mo khoa — nhu dien thoai. Con lai (mo URL tu HA, mo ung dung, truyen YouTube, tro ly) la y muon nguoi dung -> mo khoa.
  if (dev.locked && (LOCK_KEEP.has(why) || !!dev.doorbell || alsoTab?.key === '__doorbell')) {
    if (dev.saverOn) wakeBrightWhileLocked(dev);
    return;
  }
  if (dev.locked) { dev.locked = false; console.log(`[saver] ${dev.deviceId}: mo khoa (${why})`); }
  const expr = 'window.__rwvShell && window.__rwvShell.screensaver && window.__rwvShell.screensaver(false)';
  if (alsoTab && alsoTab.session !== dev.cdp) alsoTab.session.send('Runtime.evaluate', { expression: expr }).catch(() => { });
  if (!dev.saverOn) return;
  setSaver(dev, false);
  dev.cdp.send('Runtime.evaluate', { expression: expr }).catch(() => { });
  console.log(`[saver] ${dev.deviceId}: tat man hinh cho (${why})`);
}

/**
 * (26/09/2026 OS-5) Goi moi 5 s (index.ts): thiet bi nao khong cham du lau (SCREENSAVER_IDLE_S), tab dang hien khong
 * phat video/camera va den nen dang sang -> hien man hinh cho tren Shell cua tab do.
 */
/**
 * (30/09/2026) Man hinh co DANG PHAT video/am thanh khong (tab dang hien, hoac tab nhac/radio phat nen) -> bao thiet bi
 * (ControlField.Media) khi DOI. P4 dung de tam dung tu danh thuc + AEC trong luc phat (AEC chay lien tuc khi loa keu,
 * ~21% mot loi) — nguoi dung chon 30/09: giu tro ly giong noi nhung khong de no tranh CPU voi video.
 */
/**
 * (30/09/2026) Doi trang thai man hinh cho + bao thiet bi (ControlField.Saver) NGAY khi doi: P4 chi phat hien khuon
 * mat khi man tat HOAC dang man hinh cho, thay mat luc dang man hinh cho thi ve trang chu (yeu cau nguoi dung). Bao tre
 * co the lam P4 ve trang chu nham ngay sau khi nguoi dung vua cham tat man hinh cho.
 */
function setSaver(dev: DeviceSession, on: boolean): void {
  dev.saverOn = on;
  if (!on) restoreBright(dev);
  syncSaver(dev);
}

// ── (07/10/2026) MAN HINH KHOA / CHO: do sang rieng ──────────────────────────────────────────────────────────────────
const LOCK_KEEP = new Set(['den nen vua bat', 'trang dieu huong', 'bat dau phat video/am thanh', 'chuong cua', 'chuong cong', 'cuoc goi den']);
const LOCK_BRIGHT_FILE = process.env.LOCK_BRIGHT_FILE ||
  path.join(fs.existsSync('/data') ? '/data' : path.join(process.cwd(), 'data'), 'rwv-lock-bright.json');
function lockBrightAll(): Record<string, number> {
  try { const j = JSON.parse(fs.readFileSync(LOCK_BRIGHT_FILE, 'utf8')); return j && typeof j === 'object' ? j : {}; } catch { return {}; }
}
function lockBrightLoad(id: string): number | null { const v = lockBrightAll()[id]; return typeof v === 'number' ? v : null; }
/** Luu do sang NGUOI DUNG (null = xoa) — addon khoi dong lai giua luc giam sang van tra lai dung. */
function lockBrightSave(id: string, v: number | null): void {
  const all = lockBrightAll();
  if (v == null) delete all[id]; else all[id] = v;
  try { fs.mkdirSync(path.dirname(LOCK_BRIGHT_FILE), { recursive: true }); fs.writeFileSync(LOCK_BRIGHT_FILE, JSON.stringify(all)); } catch { /* bo qua */ }
}
/** Do sang nguoi dung dang dung (khong phai muc da giam khi khoa). */
function userBrightness(dev: DeviceSession): number { return dev.lockDim?.prev ?? dev.devState?.brightness ?? 100; }
/** Vao man hinh khoa / cho: giam ve "Độ sáng khi khóa" (neu dat va thap hon muc dang dung). */
function dimForSaver(dev: DeviceSession): void {
  const pct = panelPrefs.lockBrightness(dev.deviceId);
  const cur = dev.devState?.brightness;
  if (!pct || !dev.cfg.devControl || cur == null) return;
  if (!dev.lockDim) {
    if (cur <= pct) return;
    dev.lockDim = { prev: cur };
    lockBrightSave(dev.deviceId, cur);
  }
  clearTimeout(dev.lockWakeTimer); dev.lockWakeTimer = undefined;
  if (dev.locked && dev.presence?.on === true) return;  // (07/10/2026) con nguoi truoc man: giu sang, het nguoi moi toi
  broadcaster.sendDeviceControl(dev.deviceId, ControlField.Brightness, pct);
}
/** Ra khoi man hinh khoa / cho: tra lai do sang nguoi dung. */
function restoreBright(dev: DeviceSession): void {
  clearTimeout(dev.lockWakeTimer); dev.lockWakeTimer = undefined;
  if (!dev.lockDim) return;
  const prev = dev.lockDim.prev;
  dev.lockDim = null;
  lockBrightSave(dev.deviceId, null);
  if (dev.cfg.devControl) broadcaster.sendDeviceControl(dev.deviceId, ControlField.Brightness, prev);
}
/** Cham / thong bao / den nen bat lai LUC KHOA: sang lai 15 s roi toi lai (van khoa). */
function wakeBrightWhileLocked(dev: DeviceSession): void {
  if (!dev.lockDim || !dev.cfg.devControl) return;
  broadcaster.sendDeviceControl(dev.deviceId, ControlField.Brightness, dev.lockDim.prev);
  scheduleLockDim(dev);
}
/** Hen 15 s nua toi lai ve "Độ sáng khi khóa" (van khoa; con nguoi truoc man thi dimForSaver bo qua). */
function scheduleLockDim(dev: DeviceSession): void {
  clearTimeout(dev.lockWakeTimer);
  dev.lockWakeTimer = setTimeout(() => {
    dev.lockWakeTimer = undefined;
    if (dev.saverOn && dev.lockDim) dimForSaver(dev);
  }, 15_000);
}
/** Tham so man hinh khoa / cho cho Shell (screensaver({...})). */
function saverOptsJs(dev: DeviceSession): string {
  return JSON.stringify({ lock: !!dev.locked, clock: panelPrefs.clockSize(dev.deviceId), wx: panelPrefs.wxDetail(dev.deviceId) });
}

function syncSaver(dev: DeviceSession, force = false): void {
  // (07/10/2026) 0 = tat, 1 = man hinh cho, 2 = man hinh KHOA: P4 fw-2026.10.06 thay nguoi luc khoa chi sang man (khong ve
  // trang chu); firmware cu coi 2 nhu 1.
  const v = dev.saverOn ? (dev.locked ? 2 : 1) : 0;
  if (!force && dev.saverSent === v) return;
  dev.saverSent = v;
  if (dev.cfg.devControl) broadcaster.sendDeviceControl(dev.deviceId, ControlField.Saver, v);
}

function syncMediaPlaying(dev: DeviceSession, force = false): void {
  let playing = false;
  for (const t of dev.tabs.values()) if (t.mediaPlaying && (t.key === dev.activeTabKey || t.backgroundAudio)) playing = true;
  if (!force && dev.mediaSent === playing) return;
  dev.mediaSent = playing;
  if (dev.cfg.devControl) broadcaster.sendDeviceControl(dev.deviceId, ControlField.Media, playing ? 1 : 0);
}

let lwRefreshBusy = false;
let sbRefreshBusy = false;
/** (08/10/2026) Doc lai pin + mang + nguon cua tung man (toi da moi 10 s); doi thi day xuong trang. */
async function refreshStatusIcons(now: number): Promise<void> {
  for (const d of [...devices.values()]) {
    if (d.sb && now - d.sb.at < 10_000) continue;  // (16/10/2026) 30 -> 10 s: cam / rut nguon hien nhanh (pin tu phat hien)
    const r = await getStatusIcons(d.deviceId).catch(() => null);
    if (!r) { d.sb = { nw: d.sb?.nw ?? null, bt: d.sb?.bt ?? null, ...(d.sb?.ch ? { ch: d.sb.ch } : {}), at: now }; continue; }
    const changed = !d.sb || JSON.stringify([d.sb.nw, d.sb.bt, d.sb.ch]) !== JSON.stringify([r.nw, r.bt, r.ch]);
    d.sb = { ...r, at: now };
    if (changed) pushDeviceStateToPage(d);
  }
}
/**
 * (16/10/2026) CHI thuc the "Nguồn điện" moi 2 s (index.ts): cam / rut sac -> bieu tuong pin doi trong ~3-5 s (firmware phat
 * len HA ngay khi doi). Pin % / mang van theo vong 10 s cua refreshStatusIcons.
 */
let pwBusy = false;
export function powerTick(): void {
  if (pwBusy) return;
  const list = [...devices.values()].filter((d) => d.sb?.pwId);
  if (!list.length) return;
  pwBusy = true;
  Promise.all(list.map(async (d) => {
    const ch = await getPowerState(d.sb!.pwId!);
    if (ch === null || !d.sb || ch === d.sb.ch) return;
    d.sb = { ...d.sb, ...(ch ? { ch } : {}), ...(ch === 'none' ? { bt: null } : {}) };
    if (!ch) delete d.sb.ch;
    console.log(`[pin] ${d.deviceId}: nguon -> ${ch ?? '?'}`);
    pushDeviceStateToPage(d);
  })).catch(() => { }).finally(() => { pwBusy = false; });
}

export function screensaverTick(): void {
  const now = Date.now();
  // Moi 5 s: dong bo lai trang thai phat (tu sua neu mot goi bi mat khi thiet bi vua noi lai).
  for (const d of devices.values()) syncMediaPlaying(d);
  for (const d of devices.values()) syncSaver(d);
  for (const d of devices.values()) closeIdleTabs(d, now);
  syncSaverPhotoSwitches().catch(() => { });
  if (!sbRefreshBusy) { sbRefreshBusy = true; refreshStatusIcons(now).catch(() => { }).finally(() => { sbRefreshBusy = false; }); }
  // (08/10/2026) Widget man hinh khoa: lam moi so lieu (thuong xuyen khi co man dang khoa / cho, con lai 5 phut/lan); doi
  // thi day lai trang thai cho cac man dang hien lop khoa.
  if (!lwRefreshBusy) {
    lwRefreshBusy = true;
    refreshLockWidgets([...devices.values()].some((d) => d.saverOn), anyTzOffset())
      .then((changed) => { if (changed) for (const d of devices.values()) if (d.saverOn) pushDeviceStateToPage(d); })
      .catch(() => { }).finally(() => { lwRefreshBusy = false; });
  }
  for (const d of devices.values()) {
    const tab = d.tabs.get(d.activeTabKey);
    if (!tab || broadcaster.getClientCount(d.deviceId) === 0) continue;
    // (01/10/2026) Bao thuc / hen gio dang reo: khong che man hinh bao thuc (do that: khung anh de len, khong thay nut Tat).
    if (alarms.ringingOn(d.deviceId)) continue;
    // (14/10/2026) Chuong cua / chuong cong dang mo: KHONG hien man hinh cho / khoa de len (trang chuong hien DE LEN man
    // khoa nhu cuoc goi den tren dien thoai — van giu khoa; het chuong vong nay tu hien lai man khoa).
    if (d.doorbell) continue;
    // (07/10/2026) TU LANH: server tuong dang man hinh cho / khoa ma LOP PHU khong con tren trang (trang tu nap lai, Shell
    // bo qua lenh, bao thuc / tro ly go...) -> 30 s hoi trang mot lan, mat thi ve lai. Do that P4 07/10 14:51: log
    // "hien man hinh khoa" nhung trang khong co lop khoa — ket o trang HA (sang 10%) hon 3 gio, cham chi lam sang man.
    if (d.saverOn && !d.saverCheckBusy && now - (d.saverCheckAt ?? 0) > 30_000 && tab.key !== '__doorbell') {
      d.saverCheckAt = now; d.saverCheckBusy = true;
      const sess = d.cdp;
      withTimeout(sess.send('Runtime.evaluate', { expression: '!!window.__rwvSaverOn', returnByValue: true }) as Promise<{ result?: { value?: unknown } }>, 1500)
        .then((r) => {
          if (r?.result?.value !== false || !d.saverOn || d.cdp !== sess || devices.get(d.deviceId) !== d) return;
          console.log(`[saver] ${d.deviceId}: lop ${d.locked ? 'man hinh khoa' : 'man hinh cho'} khong con tren trang — ve lai`);
          d.saverPhotoAt = 0;
          sess.send('Runtime.evaluate', {
            expression: `window.__rwvShell && window.__rwvShell.screensaver && window.__rwvShell.screensaver(${saverOptsJs(d)})`,
          }).catch(() => { });
        })
        .catch(() => { })
        .finally(() => { d.saverCheckBusy = false; });
    }
    // (07/10/2026) Dang KHOA (vd vua xong bao thuc / chuong cua / thong bao): hien lai lop khoa ngay, bo qua thoi gian cho
    // va cam bien co nguoi — van nhuong video dang phat, bao thuc, den nen tat.
    const locked = !!d.locked;
    if (!shouldShowSaver({
      // (27/09/2026) Khung anh da la man hinh cho — khong phu dong ho len.
      now, lastTouchMs: d.lastTouchMs, idleMs: locked ? 1 : panelPrefs.saverIdleS(d.deviceId, SCREENSAVER_IDLE_S) * 1000, mediaPlaying: tab.mediaPlaying || tab.kind === 'photos' ||
        // (30/09/2026) Dang truyen tu dien thoai: giua hai video giao dien TV dung yen, nguoi dung cam dien thoai
        // (khong cham panel) -> truoc day man hinh cho hien de len YouTube TV (log that).
        (tab.kind === 'yttv' && !!d.castUrl),
      mediaStoppedMs: tab.mediaStoppedMs,
      backlightOn: d.devState ? d.devState.backlightOn : null, shown: d.saverOn,
      presenceOn: !locked && d.presence?.on === true, presenceOffMs: !locked && d.presence && !d.presence.on ? d.presence.at : undefined,
    })) continue;
    // (01/10/2026) KHONG BAO GIO ve de len video dang chay: hoi THANG trang (khong chi dua vao su kien phat/dung trang
    // tu bao — YouTube bao "tam dung" thoang qua khi nap dem). Dang chay -> coi nhu vua dung, dem lai thoi gian ranh.
    // Hoi loi / qua 1,5 s -> bo qua lan nay (than trong: thu lai sau 5 s).
    if (d.saverProbeBusy) continue;
    d.saverProbeBusy = true;
    const sess = d.cdp;
    const touchAt = d.lastTouchMs;
    Promise.race([
      sess.send('Runtime.evaluate', { expression: SAVER_MEDIA_PROBE_JS, returnByValue: true }) as Promise<{ result?: { value?: unknown } }>,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('het gio')), 1500)),
    ]).then((r) => {
      // Trong luc hoi (toi da 1,5 s) nguoi dung vua cham / doi tab / man hinh noi lai -> khong hien.
      if (d.saverOn || d.cdp !== sess || d.activeTabKey !== tab.key || devices.get(d.deviceId) !== d || d.lastTouchMs !== touchAt) return;
      if (r?.result?.value === true) {
        tab.mediaStoppedMs = Date.now();
        console.log(`[saver] ${d.deviceId}: khong hien man hinh cho — tab "${tab.key}" van dang phat`);
        return;
      }
      showSaver(d, tab);
    }).catch(() => { }).finally(() => { d.saverProbeBusy = false; });
  }
  for (const d of devices.values()) if (d.saverOn) saverPhotoTick(d, now);
}

function showSaver(d: DeviceSession, tab: Tab): void {
  if (panelPrefs.lockMode(d.deviceId)) d.locked = true;
  setSaver(d, true);
  dimForSaver(d);
  d.saverPhotoAt = 0;
  d.cdp.send('Runtime.evaluate', {
    expression: `window.__rwvShell && window.__rwvShell.screensaver && window.__rwvShell.screensaver(${saverOptsJs(d)})`,
  }).catch(() => { });
  console.log(`[saver] ${d.deviceId}: hien ${d.locked ? 'man hinh khoa' : 'man hinh cho'} (tab "${tab.key}")`);
  pushDeviceStateToPage(d);  // (08/10/2026) widget man khoa moi nhat (st.lw)
}

/** Co <video>/<audio> nao DANG CHAY that su (khong dung, chua het, du du lieu de phat). */
const SAVER_MEDIA_PROBE_JS = `(() => { for (const m of document.querySelectorAll('video,audio')) {
  if (!m.paused && !m.ended && m.readyState >= 2) return true; } return false; })()`;

/**
 * (27/09/2026) Man hinh cho dang khung anh: moi phut mot anh gia dinh (thu nho dung kich thuoc man hinh o server), dong
 * ho de len goc. Ban dem (22h-6h theo gio thiet bi): khong anh — chi dong ho tong am toi.
 */
function saverPhotoTick(d: DeviceSession, now: number): void {
  const fs_ = panelPrefs.frame(d.deviceId, GPHOTOS_ALBUM);
  if (!panelPrefs.saverPhotos(d.deviceId, SCREENSAVER_PHOTOS) || now - (d.saverPhotoAt ?? 0) < fs_.intervalS * 1000) return;
  d.saverPhotoAt = now;
  saverPhotoStep(d, 1, false).catch(() => { });
}

/**
 * (27/09/2026) KHUNG ANH SO: anh ke tiep / truoc (vuot trai/phai tren man hinh cho) theo cai dat cua man hinh nay
 * (nguon, thu tu, hieu ung, kieu hien thi, dong ho, chu thich — ung dung Cai dat, nhom "Khung ảnh").
 */
async function saverPhotoStep(d: DeviceSession, dir: 1 | -1, manual: boolean): Promise<void> {
  const f = panelPrefs.frame(d.deviceId, GPHOTOS_ALBUM);
  // (22/10/2026) Khoang dem theo cai dat cua tung man hinh (truoc day cung 22h-6h cho moi man).
  const ng = panelPrefs.night(d.deviceId);
  const night = nightNow(deviceHour(Date.now(), d.devState?.tzOffsetMin ?? 420), ng.from, ng.to);
  if (night && !manual) { if (d.saverPhoto) { d.saverPhoto = null; showSaverPhoto(d, null); } return; }
  const album = f.source === 'folder' ? [] : await albumItems(f.album);
  const list = sourceList(listPhotos().files, album, f.source);
  const nav = (d.saverNav ??= { hist: [], idx: -1 });
  const r = step(nav, list, dir, f.order);
  if (!r) { if (d.saverPhoto) { d.saverPhoto = null; showSaverPhoto(d, null); } return; }
  d.saverPhoto = refKey(r);
  const cap = f.info ? await caption(listPhotos().dir, r) : '';
  showSaverPhoto(d, { url: photoUrl(LOCAL_ORIGIN, r, d.cfg.width, d.cfg.height, f.fit), cap, fx: f.effect, dir, clock: f.clock });
}

type SaverPhotoMsg = { url: string; cap: string; fx: string; dir: number; clock: boolean };
function showSaverPhoto(d: DeviceSession, o: SaverPhotoMsg | null): void {
  d.cdp.send('Runtime.evaluate', {
    expression: `window.__rwvShell && window.__rwvShell.saverPhoto && window.__rwvShell.saverPhoto(${JSON.stringify(o)})`,
  }).catch(() => { });
}

export function runAdaptiveTick(): void {
  const tun = tuning();
  if (process.env.CCR_ADAPTIVE === '0' || tun.adaptive === false) {
    // Thu nghiem: tat dieu tiet, tuy chon ep nhip co dinh cho moi thiet bi (xem tuning.ts).
    if (tun.fixedIntervalMs) for (const d of devices.values()) d.tunedMinFrameIntervalMs = tun.fixedIntervalMs;
    return;
  }
  const now = Date.now();
  const snap = metrics.snapshot();
  for (const m of snap.devices) {
    const device = devices.get(m.id);
    if (!device || !m.decodeSamples) continue;
    let st = adaptiveStates.get(m.id);
    if (!st) {
      st = initialAdaptiveState(device.cfg.jpegQuality, device.cfg.minFrameInterval, now);
      // Bat dau o muc an toan, nhung baseIntervalMs giu nguyen tran thiet bi
      // yeu cau -> nhanh hoi phuc van co duong rut ve tran do.
      st.minFrameIntervalMs = device.tunedMinFrameIntervalMs ?? st.minFrameIntervalMs;
      adaptiveStates.set(m.id, st);
    }
    // (25/09/2026) Thiet bi giai ma thang vao framebuffer (?fb=1, P4): nhan va giai ma chay SONG SONG, khung day du
    // ~60 KB, P4 xu ly ~20-25 ms/khung. Mac dinh cu (ngan sach = 0,5 x nhip, ton dong 96 KB, gian x2) dat cho khung
    // ~20 KB va thiet bi giai ma tuan tu -> giu P4 o ~7 fps. Do that (docs muc 24): 1,3 / 192 KB / x1,5 + nguong
    // khung day du 0,8 (YAML) -> YouTube DU do phan giai 24 fps. File tinh chinh van ghi de duoc.
    // (25/09/2026 chieu) Chay thu 10 phut: nghen o ~1 MB/s la THOANG QUA (WiFi chap chon) nhung buoc gian toi thieu
    // 50 ms day 33 -> 83 ms roi mat 45-60 s moi hoi -> TB chi ~17 fps. Buoc 17 ms (33 -> 50), hoi sau 1 mau tot, cho 5 s.
    // (30/09/2026) Ca thiet bi half=2 (S3): khung video nua ~7-10 KB, S3 xu ly ~28 ms (do that) nhung ho so mac dinh (buoc
    // 50 ms, 2 mau tot, ton dong 96 KB) giu S3 o 250-400 ms/khung (3 fps) sau mot dot khung net luc mo trang.
    const fbProfile = device.cfg.fbBands || device.cfg.halfVideo
      ? { decodeBudgetRatio: 1.3, maxBacklogBytes: 196_608, intervalBackoffFactor: 1.5,
          intervalStepMs: 17, goodStreakNeeded: 1, cooldownMs: 5_000 } : {};
    // (26/10/2026) Panel RAT NHO (<=480x272): ghim chat luong dung bang cfg.jpegQuality. Truoc day bo dieu chinh
    // khong nhan duoc mau decode (dec=0) nen dung mai o san 40 -> YouTube mo, tang q trong YAML vo ich.
    const pinQuality = (device.cfg.width ?? 0) <= 480 && (device.cfg.height ?? 0) <= 272;
    if (!(device as unknown as Record<string, unknown>).__dimLogged) {
      (device as unknown as Record<string, unknown>).__dimLogged = true;
      console.log(`[cfg] ${device.deviceId}: w=${device.cfg.width} h=${device.cfg.height} mfi=${device.cfg.minFrameInterval} maxBytes=${device.cfg.maxBytesPerMessage} halfVideo=${device.cfg.halfVideo} pin=${pinQuality}`);
    }
    const cfgA = {
      ...DEFAULT_ADAPTIVE_CFG, maxQuality: device.cfg.jpegQuality,
      ...(pinQuality ? { minQuality: device.cfg.jpegQuality } : {}), ...fbProfile,
      // (26/10/2026) Panel nho: tran nhi 100 ms (>=10 fps). Bo dieu chinh dang ghim 150-200 ms du decode chi 55 ms,
      // trong khi link chi ~80 KB/s -> phi 2-3 lan nang luc. Giu 100 ms de con du dia cho nghen bat ngo.
      ...(pinQuality ? { maxIntervalMs: 100 } : {}),
      ...(tun.maxBacklogBytes !== undefined ? { maxBacklogBytes: tun.maxBacklogBytes } : {}),
      ...(tun.decodeBudgetRatio !== undefined ? { decodeBudgetRatio: tun.decodeBudgetRatio } : {}),
      ...(tun.intervalBackoffFactor !== undefined ? { intervalBackoffFactor: tun.intervalBackoffFactor } : {}),
      ...(tun.probeFloorTtlMs !== undefined ? { probeFloorTtlMs: tun.probeFloorTtlMs } : {}),
    };
    const bytesPerSec = m.uptimeSec > 0 ? m.bytesSent / m.uptimeSec : 0;
    const counters = broadcaster.linkCounters(m.id);
    let link = linkEstimates.get(m.id);
    if (counters) {
      link = updateLinkEstimate(link, counters.sent, counters.backlog, m.framesSent, now);
      linkEstimates.set(m.id, link);
      metrics.onLinkEstimate(m.id, link.capacityBytesPerSec ?? null, link.recentBytesPerSec ?? null,
        link.recentFrameBytes ?? null);
    }
    const res = decideAdaptive(
      {
        // ══════════════════════════════════════════════════════════════════
        // (23/09/2026) TRUNG VI thay cho LON NHAT.
        //
        // Do that tren P4 dang phat YouTube, doc thang tu log thiet bi:
        //     frame 5987..6006: 29, 33, 30, 33, 32, 30, 31, 30, 30, 29 ms
        // Deu dan quanh 30ms. Nhung /metrics cung luc do bao
        // recentMaxDecodeMs = 81, va bo dieu tiet ghi ly do:
        //     "decode 713.0ms > ngan sach 200ms -> giam quality con 40"
        // — mot GAI NHIEU 713ms (dieu huong trang / WiFi tre mot nhip) da
        // quyet dinh so phan cua ca he.
        //
        // Lay LON NHAT cua 6 mau nghia la: mot gai duy nhat khoa hanh vi
        // trong 30 giay (6 mau x 5s), ma chieu ha tai chi tre 5 giay nen
        // trong 30 giay do no phat duoc TOI SAU LAN tu cung mot gai. Ket qua
        // do duoc: quality tut ve san 40 va nhip gian ra 400ms (2,5fps) trong
        // khi thiet bi that su chi ban 30ms/khung — tuc dang ranh ba phan tu
        // thoi gian.
        //
        // Trung vi giu nguyen y do ban dau ("dung tai HIEN TAI, khong phai
        // trung binh tu luc ket noi") nhung mien nhiem voi mot mau lac loai.
        // Van con recentMaxDecodeMs trong /metrics de con nguoi nhin thay gai.
        decodeMs: m.recentMedianDecodeMs ?? m.avgDecodeMs ?? null,
        bytesPerSec,
        frameErrors: m.frameErrors,
        heapFree: m.deviceHeapFree ?? null,
        // Ton dong hien tai HOAC dinh ton dong luc phai bo khung giua hai tick (lay gia tri lon hon), roi dat lai.
        // (15/10/2026) Vua bat khung nua vi nghen (tuning halfGraceMs): khong gian nhip vi ton dong — khung nua tu xa.
        backlogBytes: ((tun.halfGraceMs ?? HALF_GRACE_MS) && device.netHalfStartMs !== undefined && now - device.netHalfStartMs < (tun.halfGraceMs ?? HALF_GRACE_MS))
          ? 0 : Math.max(broadcaster.backlogBytes(m.id), device.backlogSkipPeak ?? 0),
        capacityBytesPerSec: link?.capacityBytesPerSec ?? null,
        recentBytesPerSec: link?.recentBytesPerSec ?? null,
        recentFrameBytes: link?.recentFrameBytes ?? null,
      },
      st,
      cfgA,
      now
    );
    device.backlogSkipPeak = 0;
    // (26/10/2026) Panel nho: nang chat luong NGAY trong state (bo dieu chinh khoi tao o san 40 va chi ha duoc,
    // khong tu len vi khong co mau decode) -> Youtube van mo du YAML dat q65.
    if (pinQuality && res.state.quality < device.cfg.jpegQuality) {
      res.state.quality = device.cfg.jpegQuality;
    }
    // (27/10/2026) Panel nho: bo dieu tiet KHONG nhan duoc mau decode cua panel nay (khong co dong [adaptive] nao)
    // nen sau moi lan khoi dong lai no ket o 200 ms du decode chi ~52 ms -> 5 fps. Khi bo dieu tiet DUNG YEN
    // (khong tu thay doi) thi ep nhip 100 ms; con khi no chu dong giam toc (changed=true, co nghen) thi ton trong.
    const smallIntervalMs = Math.max(60, parseInt(process.env.SMALL_PANEL_INTERVAL_MS ?? '80', 10) || 80);
    // (27/10/2026) EP cung (khong chi khi dung yen): do lai cho thay bo dieu tiet tu noi 75 -> 100 lam fps tut,
    // trong khi decode 56 ms van duoi 80% ngan sach. Nghen that thi backlog se lo ra qua fps/backlogBytes.
    if (pinQuality && res.state.minFrameIntervalMs > smallIntervalMs) {
      res.state.minFrameIntervalMs = smallIntervalMs;
      res.changed = true;
      res.reason = `panel nho: ep nhip ${smallIntervalMs} ms (bo dieu tiet dung yen)`;
    }
    if (device.qualityOverride != null) {
      // (21/10/2026) Nguoi dung dat chat luong -> KHOA chat luong, nhung NHIP KHUNG van de bo dieu tiet
      // lo (nghen thi gian nhip, het nghen thi rut lai) — truoc day bo qua ca vong nen nhip bi dung im.
      const qo = device.qualityOverride;
      adaptiveStates.set(m.id, { ...res.state, quality: qo });
      if (device.lastAppliedQuality !== qo) {
        device.lastAppliedQuality = qo;
        device.processor.setTuning({ jpegQuality: qo });
        metrics.onAdaptiveChange(m.id, qo, res.state.minFrameIntervalMs, 'nguoi dung dat');
        console.log(`[quality] ${m.id}: nguoi dung dat q=${qo}`);
      }
      if (device.tunedMinFrameIntervalMs !== res.state.minFrameIntervalMs) {
        device.tunedMinFrameIntervalMs = res.state.minFrameIntervalMs;
        metrics.onAdaptiveChange(m.id, qo, res.state.minFrameIntervalMs, res.reason);
        console.log(`[adaptive] ${m.id}: ${res.reason} (chat luong giu q=${qo})`);
      }
      continue;
    }
    adaptiveStates.set(m.id, res.state);
    if (!res.changed) continue;
    device.processor.setTuning({ jpegQuality: res.state.quality });
    device.tunedMinFrameIntervalMs = res.state.minFrameIntervalMs;
    metrics.onAdaptiveChange(m.id, res.state.quality, res.state.minFrameIntervalMs, res.reason);
    console.log(`[adaptive] ${m.id}: ${res.reason}`);
  }
}

// (13/10/2026) TRO GIUP YOUTUBE tren tab DANG HIEN (moi 1,5 s; chi khi tab la YouTube / YouTube TV). Truoc day da co o
// 2.9.130 nhung bi hoan tac cung 2.9.130 (ly do hoan tac la phan Wi-Fi, khong phai phan nay).
//  - Tu bo qua quang cao (tuy chon "Tự bỏ qua quảng cáo YouTube"): bam "Bo qua" neu co, va tua quang cao toi cuoi —
//    do that 09/10 gap quang cao KHONG co nut va dai toi 159 s; .click() khong an voi mot so mau nut.
//  - YouTube TV hoi chon tai khoan (tuy chon "YouTube TV: chế độ khách"): CHAM THAT (CDP Input.dispatchMouseEvent) vao
//    "Xem ở chế độ khách" vi YouTube TV dieu khien bang phim, .click() khong an (do that 09/10).
function ytHelperJs(skip: boolean, guest: boolean): string {
  return `(()=>{const o={};const h=location.hostname;if(!/(^|\\.)youtube\\.com$/.test(h))return o;
const ad=!!(document.querySelector('.ad-showing,.ad-interrupting')||document.querySelector('.ytp-ad-player-overlay'));
const v=document.querySelector('video');
if(${skip}&&ad&&v&&isFinite(v.duration)&&v.duration>0.5&&v.currentTime<v.duration-0.3){v.currentTime=v.duration-0.1;o.seek=1}
if(${skip}&&ad){for(const b of document.querySelectorAll('.ytp-ad-skip-button,.ytp-ad-skip-button-modern,.ytp-skip-ad-button,.ytm-skip-ad-button,.ytp-ad-overlay-close-button')){try{b.click();o.skip=1}catch(e){}}}
if(${guest}&&location.pathname.indexOf('/tv')===0){const g=[...document.querySelectorAll('ytlr-button-renderer')].find(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&/ch\u1ebf \u0111\u1ed9 kh\u00e1ch|guest/i.test(e.textContent||'')});
if(g){const r=g.getBoundingClientRect();o.guest=[Math.round(r.x+r.width/2),Math.round(r.y+r.height/2)]}}return o})()`;
}
const ytLast = new Map<string, number>();
// (14/10/2026) Chong chong luot + gioi han thoi gian: tab YouTube treo thi Runtime.evaluate khong tra loi -> truoc day moi
// 1,5 s lai them mot loi goi cho mai (ro bo nho, che khuat loi khac).
let ytBusy = false;
const ytTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('het gio')), ms))]);
async function ytHelperTick(): Promise<void> {
  if (ytBusy) return;
  ytBusy = true;
  try { await ytHelperTickInner(); } finally { ytBusy = false; }
}
async function ytHelperTickInner(): Promise<void> {
  for (const dev of devices.values()) {
    const tab = dev.tabs.get(dev.activeTabKey);
    if (!tab) continue;
    if (!/youtube\.com/.test(tab.url || '') && tab.kind !== 'yttv') continue;
    const skip = panelPrefs.ytSkipAds(dev.deviceId), guest = panelPrefs.ytTvGuest(dev.deviceId);
    if (!skip && !guest) continue;
    try {
      const r = await ytTimeout(tab.session.send('Runtime.evaluate', {
        expression: ytHelperJs(skip, guest), returnByValue: true,
      }), 3000) as { result?: { value?: { seek?: number; skip?: number; guest?: [number, number] } } };
      const o = r?.result?.value ?? {};
      if (o.guest) {
        const [x, y] = o.guest;
        const base = { x, y, button: 'left' as const, clickCount: 1 };
        await tab.session.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base, buttons: 1 });
        await tab.session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, buttons: 0 });
      }
      if ((o.seek || o.skip || o.guest) && Date.now() - (ytLast.get(dev.deviceId) ?? 0) > 20_000) {
        ytLast.set(dev.deviceId, Date.now());
        console.log(`[youtube] ${dev.deviceId}: ${o.guest ? 'chon che do khach' : 'bo qua quang cao'}`);
      }
    } catch { /* tab dang tai / dong */ }
  }
}
setInterval(() => { ytHelperTick().catch(() => { }); }, 1500).unref?.();

// (14/09/2026) GD2: dinh ky xin MOI thiet bi bao so lieu decode (FrameStats).
// Thiet bi chi tra loi khi duoc hoi, nen khong hoi thi khong co so lieu de do.
export function requestStatsFromDevices(): void {
  for (const d of devices.values()) {
    try { broadcaster.requestFrameStats(d.deviceId); } catch { /* bo qua */ }
  }
}

async function deleteDeviceAsync(device: DeviceSession) {
  const root = getRoot() as unknown as CDPRoot;
  if (!devices.delete(device.deviceId)) return;
  metrics.removeDevice(device.deviceId);
  // (17/09/2026) Phai xoa CA trang thai thich nghi. Truoc day Map nay khong bao
  // gio duoc don, nen phien moi cua cung mot thiet bi thua ke trang thai "da
  // kich san" cua phien cu -> decideAdaptive tra changed=false -> khong gia tri
  // nao duoc ap vao cfg moi. Vong dieu khien im lang trong khi thiet bi chay
  // full tai (quan sat that: log bao da gian nhip len 400ms, nhung /metrics van
  // bao minFrameInterval=100 va adaptiveChanges=0).
  adaptiveStates.delete(device.deviceId);
  if (device.sharpTimer) { clearTimeout(device.sharpTimer); device.sharpTimer = undefined; }
  if (device.timer) { clearTimeout(device.timer.handle); device.timer = undefined; }
  // linkEstimates co y GIU LAI: bang thong la cua duong truyen WiFi, khong cua phien.
  // updateLinkEstimate tu dat lai moc khi thay bo dem socket moi quay ve 0.
  if (device.throttleTimer) clearTimeout(device.throttleTimer);
  // (26/09/2026 OS-2) Dong TAT CA tab cua thiet bi (khong chi tab active) — moi tab la mot Chromium target rieng.
  for (const tab of device.tabs.values()) {
    try { await tab.session.send("Page.stopScreencast").catch(() => { }); } catch { }
    try { await root?.send("Target.closeTarget", { targetId: tab.targetId }); } catch { }
  }
  device.tabs.clear();
  console.log(`[device] Device ${device.deviceId} deleted [${devices.size}/${MAX_DEVICES} slots used]`);
}

// ── (16/10/2026) TRANG DASHBOARD → "MÀN HÌNH": trang thai + dieu khien TUNG man tu xa (src/screenCtl.ts, public/screens.html) ──
// Khong can cham man: do sang / am luong / Khong lam phien / man hinh cho-khoa / ung dung dang hien / trinh phat / thong bao /
// moi cai dat (addon + thuc the HA cua thiet bi, dung chung applySetting voi ung dung Cai dat tren man).

/** Tom tat 1 man (the rut gon tren trang chu Dashboard + dau trang chi tiet). */
function screenSummary(dev: DeviceSession) {
  const s = dev.devState, t = dev.tabs.get(dev.activeTabKey), nts = noticesOf(dev.deviceId);
  const recent = nts.list(50);
  return {
    id: dev.deviceId, w: dev.cfg.width, h: dev.cfg.height, online: broadcaster.getClientCount(dev.deviceId) > 0,
    on: s ? s.backlightOn : null, ctl: !!s && !!dev.cfg.devControl,
    // Do sang NGUOI DUNG (khi man khoa dang giam sang thi la muc se tra lai luc mo) + co dang giam sang khong.
    b: s ? userBrightness(dev) : null, dim: !!dev.lockDim, v: s?.volume ?? null, tg: s?.toggles ?? null,
    saver: dev.saverOn, locked: !!dev.locked,
    app: t ? { k: t.key, l: t.label, kind: t.kind } : null,
    np: [...dev.tabs.values()].filter((x) => x.mediaPlaying).map((x) => ({ k: x.key, l: x.label, active: x.key === dev.activeTabKey })),
    nw: dev.sb?.nw ?? null, bt: dev.sb?.bt ?? null, ch: dev.sb?.ch ?? null,
    nu: nts.unseen('nt'), cu: chatUnread(dev.deviceId).total, mc: recent.filter((n) => n.missed && !n.seen).length,
    dnd: dndOf(dev.deviceId), ring: !!dev.doorbell || !!alarms.ringingOn(dev.deviceId),
    pr: dev.presence ? dev.presence.on : null, touch: dev.lastTouchMs || null,
    ip: broadcaster.clientIp(dev.deviceId),
  };
}

export function screensOverview(): ReturnType<typeof screenSummary>[] {
  return [...devices.values()].map(screenSummary);
}

/** Chi tiet 1 man. null = server khong biet man nay. */
export function screenDetail(id: string) {
  const dev = devices.get(id);
  if (!dev) return null;
  const m = metrics.snapshot().devices.find((d) => d.id === id);
  const hasCamera = dev.cfg.camPort > 0, hasSd = hasCamera || dev.cfg.sdPort > 0;
  const nx = alarms.next(Date.now(), anyTzOffset(), id);
  return {
    ...screenSummary(dev),
    cap: { cam: hasCamera, sd: hasSd, spk: !!dev.cfg.audioEnabled, mic: !!dev.cfg.micCall, snd: canPlay(dev), voice: !!dev.cfg.voice,
      rot: dev.cfg.rotation ?? 0 },
    tabs: [...dev.tabs.values()].sort((a, b) => b.lastUsed - a.lastUsed).map((t) => ({
      k: t.key, l: t.label, kind: t.kind, active: t.key === dev.activeTabKey, playing: t.mediaPlaying, pinned: t.pinned, used: t.lastUsed,
    })),
    apps: buildLauncherApps(dev.cfg.homeUrl, hasCamera, hasSd).map((a) => ({ id: a.id, l: a.label, c: a.color, kind: a.kind, p: a.path ?? null })),
    sv: canPlay(dev) ? soundPrefs.get(id) : null,
    tm: dev.timer ? { endsAt: dev.timer.endsAt, label: dev.timer.label } : null,
    al: nx ? { t: nx.time, at: nx.at, l: nx.label } : null,
    nt: noticesOf(id).list(30).map(noticeForShell),
    perf: m ? { up: m.uptimeSec, kbps: m.recentBytesPerSec != null ? Math.round(m.recentBytesPerSec / 1024) : null,
      dec: m.recentMedianDecodeMs, heap: m.deviceHeapFree, psram: m.devicePsramFree, q: m.appliedQuality, frames: m.framesSent } : null,
  };
}

/** Anh man dang hien (tab dang hien + lop Shell: man hinh cho / khoa / thong bao). JPEG; null = man khong ket noi. */
/**
 * (27/10/2026) CHAN DOAN: so lieu viewport THAT cua tab dang hien (dung khi hinh bi co nho bat thuong).
 * Tra ve innerWidth/innerHeight, devicePixelRatio, zoom, kich thuoc <html>, URL, so tab.
 */
export async function screenDebug(id: string): Promise<Record<string, unknown> | null> {
  const dev = devices.get(id);
  if (!dev) return null;
  const tab = dev.tabs.get(dev.activeTabKey);
  const expr = `(() => {
    const de = document.documentElement;
    return {
      url: location.href, title: document.title,
      iw: innerWidth, ih: innerHeight, dpr: devicePixelRatio,
      cw: de.clientWidth, ch: de.clientHeight,
      zoom: getComputedStyle(de).zoom, bodyZoom: getComputedStyle(document.body).zoom,
      vvScale: (window.visualViewport && visualViewport.scale) || null,
      scrollW: de.scrollWidth, scrollH: de.scrollHeight
    };
  })()`;
  const r = await dev.cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true })
    .catch((e: unknown) => ({ __err: (e as Error).message })) as { result?: { value?: unknown }; __err?: string };
  return {
    device: id,
    cfg: { w: dev.cfg.width, h: dev.cfg.height, halfScale: dev.cfg.halfScale, halfVideo: dev.cfg.halfVideo },
    activeTab: dev.activeTabKey,
    tabVw: tab ? (tab as unknown as { vw?: number }).vw : null,
    tabVh: tab ? (tab as unknown as { vh?: number }).vh : null,
    page: r.__err ? { error: r.__err } : r.result?.value,
  };
}

export async function screenShot(id: string): Promise<Buffer | null> {
  const dev = devices.get(id);
  if (!dev || broadcaster.getClientCount(id) === 0) return null;
  const r = await withTimeout(dev.cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 60 }) as Promise<{ data: string }>, 4000);
  return Buffer.from(r.data, 'base64');
}

/**
 * (21/10/2026) Cham/vuot tu trang Control (Dashboard) — gui thang xuong tab Chromium cua man.
 * x,y theo khung hinh dang thay (pixel cua anh chup), cung he voi cfg.width/height khi rotation = 0.
 *
 * (23/10/2026) KHONG ap mapPointForRotation: anh xem truoc (control/frame = Page.captureScreenshot) la
 * Chrome CHUA xoay, nen toa do cham cung phai gui NGUYEN VAN (khong xoay). Truoc day xoay them mot lan
 * -> man xoay 180 bi "cheo": cham Frigate mo Tin tuc, cham Phong mo YouTube TV.
 */
// (23/10/2026) Tab YouTube TV chi dieu huong bang PHIM MUI TEN (giao dien TV). Panel that da duoc
// inputRouter._tvGesture doi vuot -> phim; Control thi chua. Luu moc vuot theo tung thiet bi.
const tvTouchStart = new Map<string, { x0: number; y0: number; x: number; y: number }>();

// (26/10/2026) Moi lenh Input.dispatchTouchEvent ton ~26 ms tren CUNG kenh CDP voi Page.captureScreenshot.
// Gui 60 move/giay (16 ms) = 1,5 s CDP moi giay -> lenh chup khung khong chen vao duoc => hinh DUNG YEN
// trong luc giu tay keo (dung trieu chung nguoi dung bao tren Chrome Android, SSE). Gio: dang gui move thi
// BO QUA move tiep theo (chi gui vi tri moi nhat khi kenh ranh) -> khong mat cam giac keo, nhuong CDP cho khung.
const moveInFlight = new Set<string>();

export async function screenTouch(id: string, kind: 'down' | 'move' | 'up', x: number, y: number): Promise<string | null> {
  if (kind === 'move') {
    if (moveInFlight.has(id)) return null;   // dang gui -> bo qua diem nay
    moveInFlight.add(id);
  }
  try {
    return await screenTouchInner(id, kind, x, y);
  } finally {
    if (kind === 'move') moveInFlight.delete(id);
  }
}

async function screenTouchInner(id: string, kind: 'down' | 'move' | 'up', x: number, y: number): Promise<string | null> {
  const dev = devices.get(id);
  if (!dev) return 'Không có màn hình này.';
  const tvTab = dev.tabs.get(dev.activeTabKey)?.kind === 'yttv';
  if (tvTab) {
    if (kind === 'down') {
      tvTouchStart.set(id, { x0: x, y0: y, x, y });
    } else if (kind === 'move') {
      const t = tvTouchStart.get(id);
      if (t) {
        t.x = x; t.y = y;
        // (26/10/2026) youtube.com/tv chi nhan PHIM MUI TEN; truoc day chi doi o 'up' -> giu tay keo khong
        // thay gi, nha tay moi nhay (nguoi dung bao tren 480x480/480x272). Nay cu vuot qua 40px la ban phim
        // ngay trong luc keo, va lay moc moi -> dieu huong live nhu tren panel that.
        const dx = x - t.x0, dy = y - t.y0, TH = 40;
        if (Math.abs(dx) >= TH || Math.abs(dy) >= TH) {
          // Cung quy uoc voi tvSwipeKeys(): keo sang trai -> ArrowRight, keo len -> ArrowDown.
          const key = Math.abs(dx) >= Math.abs(dy)
            ? (dx < 0 ? 'ArrowRight' : 'ArrowLeft')
            : (dy < 0 ? 'ArrowDown' : 'ArrowUp');
          const code = TV_KEY_CODE[key];
          const ev = { key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code };
          void dev.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...ev }).catch(() => { });
          void dev.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...ev }).catch(() => { });
          t.x0 = x; t.y0 = y;
        }
      }
    }
  }
  const points = [{ x, y, radiusX: 1, radiusY: 1, force: 1, id: 1 }];
  // (26/10/2026) youtube.com/tv: CHI gui phim mui ten. Truoc day van ban ca chuoi cham tho (touchStart/Move/End)
  // ROI them phim -> trang nhan 2 nguon su kien cung luc => 'loan, khong nhay, sai' (nguoi dung bao tren 800x480).
  // (26/10/2026) LUON ban cham tho: 2.9.247 chan o tab YouTube TV -> panel MAT CAM UNG hoan toan.
  // Giu nguyen nhu ban on dinh; phan phim mui ten chi la BO SUNG (xem nhanh tvTab ben duoi).
  try {
    if (kind === 'down') await dev.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points });
    else if (kind === 'move') await dev.cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points });
    else await dev.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } catch (e) {
    return `Không gửi được thao tác: ${(e as Error).message}`;
  }
  // (23/10/2026) YouTube TV: tha tay sau cu vuot -> phim mui ten (nhu _tvGesture cua panel that).
  if (tvTab && kind === 'up') {
    const t = tvTouchStart.get(id);
    tvTouchStart.delete(id);
    if (t) {
      for (const key of tvSwipeKeys(t.x - t.x0, t.y - t.y0)) {
        const code = TV_KEY_CODE[key];
        const ev = { key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code };
        dev.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...ev }).catch(() => { });
        dev.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...ev }).catch(() => { });
        await new Promise((r) => setTimeout(r, 70));
      }
    }
  }
  return null;
}

/** (21/10/2026) Phien thiet bi theo id — cho lop HTTP/WebSocket ben ngoai (trang Control). */
export function getDeviceSession(id: string): DeviceSession | undefined { return devices.get(id); }

/** (21/10/2026) 3 phim dieu huong tu trang Control: home / back / recents (nhu phim Android). */
export async function screenKey(id: string, key: string): Promise<string | null> {
  const dev = devices.get(id);
  if (!dev) return 'Không có màn hình này.';
  if (dev.saverOn) { dev.locked = false; setSaver(dev, false); }
  dev.lastTouchMs = Date.now();
  if (key === 'home') goOsHome(dev);
  else if (key === 'back') goBack(dev);
  else if (key === 'recents') openRecents(dev);
  else if (key === 'unlock') { /* da mo khoa o tren (dev.saverOn) — chi do man hinh cho */ }
  else return 'Phím không hợp lệ.';
  return null;
}

/** Tim <video>/<audio> "chinh" cua trang: cai dang chay, khong thi cai dai nhat. */
const PICK_MEDIA_JS = `const ms = [...document.querySelectorAll('video,audio')];
  const m = ms.find((x) => !x.paused && !x.ended) || ms.slice().sort((a, b) => (b.duration || 0) - (a.duration || 0))[0];`;
const MEDIA_INFO_JS = `(() => { try { ${PICK_MEDIA_JS}
  if (!m) return null;
  const md = navigator.mediaSession && navigator.mediaSession.metadata;
  return { p: !m.paused && !m.ended, t: Math.round(m.currentTime || 0), d: Number.isFinite(m.duration) ? Math.round(m.duration) : null,
    vid: m.tagName === 'VIDEO', ti: (md && md.title) || document.title || '', ar: (md && md.artist) || '',
    art: (md && md.artwork && md.artwork[0] && md.artwork[0].src) || '' };
} catch (e) { return null; } })()`;

/** Trinh phat cua cac tab co media (tab dang hien + tab dang phat nen). */
export async function screenMedia(id: string): Promise<{ k: string; l: string; active: boolean; m: unknown }[]> {
  const dev = devices.get(id);
  if (!dev) return [];
  const tabs = [...dev.tabs.values()].filter((t) => t.key === dev.activeTabKey || t.mediaPlaying);
  const out = await Promise.all(tabs.map(async (t) => {
    const r = await withTimeout(t.session.send('Runtime.evaluate', { expression: MEDIA_INFO_JS, returnByValue: true }) as Promise<{ result?: { value?: unknown } }>, 1500)
      .catch(() => null);
    const m = r?.result?.value as { p?: boolean; t?: number } | null | undefined;
    // Tab dang hien: chi tinh la trinh phat khi DANG phat / da phat / la ung dung nghe nhin (khong tinh video nho cua the HA).
    // Radio / IPTV la luong truc tiep: thoi luong HLS chi la cua so dem -> khong hien thanh tien do.
    if (m && (t.kind === 'radio' || t.kind === 'iptv')) (m as { d?: number | null }).d = null;
    const keep = !!m && (t.mediaPlaying || !!m.p || (m.t ?? 0) > 0 || MEDIA_APP_KINDS.has(t.kind));
    return { k: t.key, l: t.label, active: t.key === dev.activeTabKey, m: keep ? m : null };
  }));
  return out.filter((x) => x.m);
}

const MEDIA_APP_KINDS = new Set(['youtube', 'yttv', 'music', 'radio', 'iptv', 'media', 'tiktok', 'vtvgo']);
const MEDIA_KEYS: Record<string, { key: string; code: number }> = {
  next: { key: 'MediaTrackNext', code: 176 }, prev: { key: 'MediaTrackPrevious', code: 177 },
};

/** Goi window.<fn>() cua trang neu co (ham trang tu dinh nghia cho trinh phat). true = da goi. */
async function pageHook(t: Tab, fn: string): Promise<boolean> {
  if (!fn) return false;
  const r = await t.session.send('Runtime.evaluate', { expression: `typeof window.${fn} === 'function' ? (window.${fn}(), true) : false`, returnByValue: true })
    .catch(() => null) as { result?: { value?: unknown } } | null;
  return r?.result?.value === true;
}

/** Lenh tu trang Dashboard → Màn hình. null = da lam; chuoi = loi (tieng Viet, hien cho nguoi dung). */
export async function screenAct(id: string, b: any): Promise<string | null> {
  const dev = devices.get(id);
  if (!dev) return 'Server không biết màn hình này.';
  const online = broadcaster.getClientCount(id) > 0;
  const act = String(b?.act ?? '');
  const num = (x: unknown, lo: number, hi: number): number | null => {
    const n = Math.round(Number(x));
    return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
  };
  const tabOf = (k: unknown): Tab | undefined => (typeof k === 'string' && k ? dev.tabs.get(k) : dev.tabs.get(dev.activeTabKey));
  const tag = `[man] ${id}:`;
  if (!online && !['dnd', 'snd', 'ntClear', 'ntDel', 'ntSeen'].includes(act)) return 'Màn hình đang mất kết nối.';
  switch (act) {
    // ── Hien thi & am thanh (ghi thang xuong firmware, nhu thanh truot trong menu man) ──
    case 'b': case 'v': case 'mu': case 'ns': case 'aec': {
      if (!dev.cfg.devControl) return 'Màn hình này không bật điều khiển trực tiếp (devControl).';
      const v = num(b.v, 0, 100);
      if (v == null) return 'Giá trị không hợp lệ.';
      const F: Record<string, ControlField> = { b: ControlField.Brightness, v: ControlField.Volume, mu: ControlField.Mute, ns: ControlField.NoSleep, aec: ControlField.Aec };
      if (act === 'b' && dev.lockDim) {
        // Man khoa / cho dang giam sang: doi muc se tra lai khi mo; man dang sang (vua cham) thi doi luon.
        dev.lockDim.prev = v; lockBrightSave(id, v);
        if (dev.lockWakeTimer) broadcaster.sendDeviceControl(id, ControlField.Brightness, v);
      } else {
        broadcaster.sendDeviceControl(id, F[act], act === 'b' || act === 'v' ? v : (v ? 1 : 0));
      }
      console.log(`${tag} ${act} = ${v} (trang Dashboard)`);
      return null;
    }
    case 'snd': {
      if (!canPlay(dev)) return 'Màn hình này không có âm thông báo / báo thức.';
      const k = b.k === 'alarm' ? 'alarm' : b.k === 'alert' ? 'alert' : null, v = num(b.v, 0, 100);
      if (!k || v == null) return 'Giá trị không hợp lệ.';
      soundPrefs.set(id, { [k]: v });
      syncSoundToDevice(dev); pushDeviceStateToPage(dev);
      return null;
    }
    case 'dnd':
      setDnd(id, !!b.v); pushDeviceStateToPage(dev);
      return null;
    // ── Man hinh ──
    case 'wake':
      dev.locked = false; setSaver(dev, false); dev.lastTouchMs = Date.now();
      console.log(`${tag} mo man hinh (trang Dashboard)`);
      return null;
    case 'saver': case 'lock': {
      const t = dev.tabs.get(dev.activeTabKey);
      if (!t) return 'Màn hình chưa có trang nào.';
      if (dev.doorbell || alarms.ringingOn(id)) return 'Màn hình đang đổ chuông — để sau.';
      if (act === 'lock') dev.locked = true;
      if (dev.saverOn) { dev.saverOn = false; }
      showSaver(dev, t);
      return null;
    }
    // ── Ung dung ──
    case 'app': {
      if (typeof b.app !== 'string' || b.app.length > 40) return 'Thiếu ứng dụng.';
      if (dev.saverOn) { dev.locked = false; setSaver(dev, false); }
      dev.lastTouchMs = Date.now();
      await openApp(dev, b.app);
      return null;
    }
    case 'tab': {
      const t = tabOf(b.k);
      if (!t) return 'Ứng dụng này đã đóng.';
      if (dev.saverOn) { dev.locked = false; setSaver(dev, false); }
      dev.lastTouchMs = Date.now();
      await dev.tabOps.run(() => activateTab(dev, t.key));
      return null;
    }
    case 'close': {
      const t = tabOf(b.k);
      if (!t) return null;
      if (t.pinned) return 'Ứng dụng ghim (trang chủ) không đóng được.';
      await dev.tabOps.run(async () => {
        if (t.key === dev.activeTabKey) await openAppNow(dev, 'home');
        closeTab(dev, t.key, 'dong tu trang Dashboard');
      });
      pushDeviceStateToPage(dev);
      return null;
    }
    case 'reload': {
      const t = tabOf(b.k);
      if (!t) return 'Không có trang để tải lại.';
      await t.session.send('Page.reload', { ignoreCache: false }).catch(() => { });
      console.log(`${tag} tai lai tab "${t.key}" (trang Dashboard)`);
      return null;
    }
    case 'url': {
      const u = String(b.url ?? '').trim();
      if (!/^https?:\/\/\S{3,500}$/i.test(u)) return 'Địa chỉ web phải bắt đầu bằng http:// hoặc https://';
      if (dev.saverOn) { dev.locked = false; setSaver(dev, false); }
      dev.lastTouchMs = Date.now();
      await navigateToUrl(dev, u);
      return null;
    }
    // ── Trinh phat (tab dang hien hoac tab phat nen `k`) ──
    case 'media': {
      const t = tabOf(b.k), cmd = String(b.cmd ?? '');
      if (!t) return 'Không có trình phát.';
      if (cmd === 'stop') {
        await t.session.send('Runtime.evaluate', { expression: 'window.__rwvMediaStop && window.__rwvMediaStop();' }).catch(() => { });
      } else if (await pageHook(t, cmd === 'play' ? 'rwvResume' : cmd === 'next' ? 'rwvNext' : cmd === 'prev' ? 'rwvPrev' : '')) {
        // Trang tu lo (vd radio.html: phat tiep kenh cuoi, doi kenh) — xem public/radio.html.
      } else if (MEDIA_KEYS[cmd]) {
        const k = MEDIA_KEYS[cmd];
        for (const type of ['rawKeyDown', 'keyUp'] as const) {
          await t.session.send('Input.dispatchKeyEvent', { type, key: k.key, code: k.key, windowsVirtualKeyCode: k.code, nativeVirtualKeyCode: k.code }).catch(() => { });
        }
      } else if (['play', 'pause', 'back', 'fwd'].includes(cmd)) {
        const body = cmd === 'play' ? 'm.play().catch(() => {});' : cmd === 'pause' ? 'm.pause();'
          : cmd === 'back' ? 'm.currentTime = Math.max(0, m.currentTime - 10);' : 'm.currentTime = m.currentTime + 10;';
        const r = await t.session.send('Runtime.evaluate', { expression: `(() => { ${PICK_MEDIA_JS} if (!m) return false; ${body} return true; })()`, returnByValue: true })
          .catch(() => null) as { result?: { value?: unknown } } | null;
        if (r?.result?.value !== true) return 'Trang này không có trình phát điều khiển được.';
      } else return 'Lệnh không hợp lệ.';
      console.log(`${tag} trinh phat "${t.key}": ${cmd} (trang Dashboard)`);
      return null;
    }
    // ── Thong bao ──
    case 'ntClear': noticesOf(id).clear(); pushDeviceStateToPage(dev); return null;
    case 'ntDel': { const n = num(b.n, 0, Number.MAX_SAFE_INTEGER); if (n != null) noticesOf(id).remove(n); pushDeviceStateToPage(dev); return null; }
    case 'ntSeen': noticesOf(id).markSeen('all'); pushDeviceStateToPage(dev); return null;
    case 'notify': {
      const r = postNotify({ device: id, title: b.title, message: b.message, priority: b.priority === 'high' ? 'high' : 'normal' });
      return r.ok ? null : (r.error ?? 'Không gửi được thông báo.');
    }
    case 'say': {
      const msg = String(b.message ?? '').trim().slice(0, 300);
      if (!msg) return 'Nhập nội dung cần đọc.';
      const err = await speakOnPanel(id, msg);
      return err ? `Không đọc được: ${err}.` : null;
    }
    default: return 'Lệnh không hợp lệ.';
  }
}

/** Cai dat cua man: thuc the HA cua thiet bi + muc addon (giong ung dung Cai dat tren man). */
export async function screenSettings(id: string) {
  const dev = devices.get(id);
  if (!dev) return null;
  const r = await getSettingsView(id);
  return { ...r, panel: panelPrefs.items(id, panelDefaults(), GPHOTOS_ALBUM) };
}
export async function screenSettingSet(id: string, sid: string, v: unknown): Promise<{ ok: boolean; msg?: string }> {
  const dev = devices.get(id);
  if (!dev) return { ok: false, msg: 'Server không biết màn hình này.' };
  return applySetting(dev, sid, v);
}
