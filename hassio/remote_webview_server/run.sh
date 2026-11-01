#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Copyright (c) 2026 minhquanghp86
# Licensed under the Apache License, Version 2.0 (see LICENSE).
set -euo pipefail

OPTIONS_FILE="/data/options.json"

# (23/09/2026) SUA LOI THU HAI: ban goc dung `jq` de doc options.json, nhung
# image nay KHONG CAI jq (kiem tra truc tiep: `command -v jq` -> khong thay).
# Neu giu jq thi script se crash ngay o dong dau tien vi `set -e`, bien mot
# loi "option khong duoc ap dung" thanh loi nghiem trong hon "addon khong
# khoi dong duoc". Dung `node` thay the — chac chan co san vi day chinh la
# runtime cua app.
get_opt() {
  local key="$1" default="$2"
  if [ -f "$OPTIONS_FILE" ]; then
    node -e '
      const fs = require("fs");
      const key = process.argv[1], def = process.argv[2];
      try {
        const o = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
        const v = o[key];
        process.stdout.write(v === undefined || v === null ? def : String(v));
      } catch { process.stdout.write(def); }
    ' "$key" "$default" "$OPTIONS_FILE"
  else
    printf '%s' "$default"
  fi
}

# (23/09/2026) SUA LOI: file nay truoc day CHI export BROWSER_LOCALE. Moi
# option con lai duoc khai bao trong config.yaml (hien tren giao dien HA,
# nguoi dung chinh duoc) nhung KHONG BAO GIO den duoc app — server chi doc
# qua process.env.<TEN_HOA> (xem src/config.ts, src/index.ts, src/browser.ts),
# ma khong ai export cac bien do o day. Hau qua: doi jpeg_quality/tile_size/...
# tren giao dien addon khong lam gi ca, va USER_DATA_DIR luon la gia tri
# Dockerfile bake san (/pw-data, KHONG BEN qua update addon) du option
# user_data_dir da duoc doi.
#
# Sua: export DAY DU, dung ten bien ma tung file da doc that (doi chieu
# truc tiep voi env.get()/process.env. trong src/*.ts, khong doan).
export BROWSER_LOCALE="$(get_opt browser_locale "en-US")"
export TILE_SIZE="$(get_opt tile_size "32")"
export FULL_FRAME_TILE_COUNT="$(get_opt full_frame_tile_count "4")"
export FULL_FRAME_AREA_THRESHOLD="$(get_opt full_frame_area_threshold "0.5")"
export FULL_FRAME_EVERY="$(get_opt full_frame_every "50")"
export EVERY_NTH_FRAME="$(get_opt every_nth_frame "1")"
export MIN_FRAME_INTERVAL_MS="$(get_opt min_frame_interval_ms "80")"
export JPEG_QUALITY="$(get_opt jpeg_quality "85")"
export MAX_BYTES_PER_MESSAGE="$(get_opt max_bytes_per_message "61440")"
export WS_PORT="$(get_opt ws_port "8081")"
export DEBUG_PORT="$(get_opt debug_port "9221")"
export HEALTH_PORT="$(get_opt health_port "18080")"
# (21/11/2026) GD13 — HTTPS TU KY (src/tls.ts): app Android can secure context de WebView cap micro/camera ma khong
# phai qua ingress HA. 0 = tat. Chung chi sinh mot lan trong /data/tls (ben qua update add-on).
export HTTPS_PORT="$(get_opt https_port "18443")"
export PREFERS_REDUCED_MOTION="$(get_opt prefers_reduced_motion "false")"
export SCREENSAVER_IDLE_S="$(get_opt screensaver_idle_s "120")"
# (27/09/2026) Man hinh cho khung anh; chao buoi sang (camera thay nguoi -> "Hom nay" + doc qua loa panel).
export SCREENSAVER_PHOTOS="$(get_opt screensaver_photos "true")"
export MORNING_BRIEFING="$(get_opt morning_briefing "true")"
export MORNING_WINDOW="$(get_opt morning_window "06:00-09:30")"
export MORNING_TTS="$(get_opt morning_tts "false")"
# (27/09/2026) Truyen YouTube tu dien thoai (DIAL: SSDP UDP 1900 + HTTP dial_port)
export CAST_ENABLED="$(get_opt cast_enabled "true")"
export DIAL_PORT="$(get_opt dial_port "56790")"
# (31/10/2026) AGC + limiter cho tieng DIEN THOAI -> LOA MAN (src/audioAgc.ts). 'false' -> tat (A/B).
export CCR_CALL_AGC="$(get_opt call_agc "true")"
# (06/12/2026) MONO -> STEREO (L = R) cho nhanh xuong LOA MAN (src/audioStereo.ts): mixer P4 khai 2 kenh nen goi
# phai la 1280 B = 20 ms stereo. 'false' -> gui mono 640 B nhu cu (A/B).
export CCR_CALL_STEREO="$(get_opt call_stereo "true")"
export CCR_CALL_RATE8K="$(get_opt call_rate8k "false")"
# (27/09/2026) Link album Google Photos chia se cho khung anh (chinh duoc ca o Cai dat tren man hinh).
export GPHOTOS_ALBUM="$(get_opt gphotos_album "")"
export USER_DATA_DIR="$(get_opt user_data_dir "/data/pw-data")"

# (25/09/2026) Proxy Chrome DevTools ra LAN (tat mac dinh) — truoc day 2 tuy chon nay co tren giao dien nhung KHONG
# duoc dung o dau ca. Nay src/debugProxy.ts doc chung.
export EXPOSE_DEBUG_PROXY="$(get_opt expose_debug_proxy "false")"
export DEBUG_PROXY_PORT="$(get_opt debug_proxy_port "9222")"

echo "[remote-webview] user_data_dir=${USER_DATA_DIR}"

# Dam bao thu muc profile ton tai truoc khi Chrome/Playwright dung toi —
# quan trong nhat khi tro vao /data (mount ben) lan dau, thu muc con chua co.
mkdir -p "${USER_DATA_DIR}"

# Đảm bảo Playwright sử dụng Chrome
export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

# Verify Chrome
if [ -f /usr/bin/google-chrome-stable ]; then
  echo "[remote-webview] Google Chrome: $(/usr/bin/google-chrome-stable --version)"
else
  echo "[WARNING] Google Chrome not found, H.264 may not work!"
fi

exec node dist/index.js
