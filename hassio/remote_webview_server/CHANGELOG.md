## Sắp tới (chưa bump version)
- **Chống RÚ (howling) khi gọi điện thoại ↔ P4 bằng HALF-DUPLEX THÍCH NGHI (voice switch) phía server**
  (`src/audioDuplex.ts` mới). Đo + nghe trên thiết bị: tiếng từ điện thoại xuống loa P4 **nhỏ, không nhạy**; tăng âm
  lượng loa P4 thì **rú**. Nguyên nhân: **vòng lặp âm học** loa P4 → mic điện thoại → về P4 (và chiều ngược lại
  P4 → mic P4 → về điện thoại); AEC của trình duyệt chỉ giảm được một phần, và AGC (+gain) lại chính là khuếch đại
  vòng đó. Nay server đo **năng lượng RMS 2 chiều cho từng cuộc gọi**:
  `up` = điện thoại → P4 (PCM đi ra loa màn, `sendToSpeaker()`), `down` = P4 → điện thoại (mic màn, `onMicFrame()`),
  rồi:
  - `up` > **−34 dBFS** và hơn `down` ≥ **6 dB** ⇒ **giảm `down` 20 dB** (chặn vòng P4 → mic P4 → về điện thoại:
    người gọi không còn nghe lại chính giọng mình);
  - `down` > **−34 dBFS** và hơn `up` ≥ **6 dB** ⇒ **giảm `up` 12 dB** (chặn vòng loa P4 → mic điện thoại → về loa
    P4 — đây là vòng gây rú khi âm lượng lớn);
  - cả hai < **−60 dBFS** ⇒ **không sửa một mẫu nào**; chuyển trạng thái **mềm**: attack **10 ms** / release
    **250 ms**, gain được **nội suy từng mẫu** trong khung nên không có bước nhảy ở biên khung (không nghe tiếng
    “cụp”). Chiều nào không có khung mới quá **500 ms** thì coi như im lặng (điện thoại tắt mic/mất mạng không làm
    màn bị câm vĩnh viễn). Trạng thái **riêng từng cuộc gọi**, xoá khi kết thúc.
  - **Không đổi độ dài gói** (vào bao nhiêu byte ra bấy nhiêu) và **không đụng nhánh web ↔ web** (điện thoại ↔ điện
    thoại vẫn nguyên byte).
  - **Kèm tăng độ nhạy**: khi half-duplex bật, AGC cho phép **mục tiêu −14 dBFS** (trước −16) và **gain tối đa
    +24 dB** (trước +12) — đã chặn được vòng lặp nên có thể to hơn mà không rú. Tắt half-duplex ⇒ AGC trở lại
    −16 dBFS / +12 dB để A/B công bằng.
  - Tắt để A/B bằng **`CCR_CALL_HALFDUPLEX=0`** (mặc định `1` = bật; log khởi động
    `[audio] halfduplex=on thr=-34dBFS duck=down20/up12dB attack=10ms release=250ms`), kèm dòng chẩn đoán
    `[duplex] <dev> up=…dBFS down=…dBFS giảm down …dB`. Add-on có thêm tuỳ chọn **`call_halfduplex`** (mặc định
    `true`) trong Cấu hình, `run.sh` xuất thành `CCR_CALL_HALFDUPLEX`; `POST /call/test/play` trả thêm
    `halfduplex` và log `[test] play ... halfduplex=1`.
  - Test: `src/audioDuplex.test.ts` (16 test: (a) chỉ `up` → `down` −20 dB và `up` nguyên byte; (b) chỉ `down` →
    `up` −12 dB; (c) cả hai im lặng → không đổi; (d) attack/release mượt + nội suy từng mẫu; (e) env tắt →
    passthrough y nguyên byte; (f) độ dài gói 320/640/642 byte không đổi; ngưỡng −34/6 dB, “cũ” 500 ms, trạng thái
    riêng từng cuộc gọi). Sửa 2 test `src/audioAgc.test.ts` + 2 test `src/testAudio.test.ts` đang kỳ vọng mục tiêu
    −26 dBFS cũ (nay đọc thẳng hằng số `AGC_TARGET_DBFS` / `AGC_MAX_GAIN_DB`).
- **Sửa “49 KB/s thay vì 32 KB/s”: có một ĐƯỜNG GỬI AUDIO THỨ HAI vào cùng một loa** (`src/audioOut.ts` mới). Bằng
  chứng đo trên P4 (2.9.321, mixer 1 kênh, 16 kHz mono): `POST /call/test/play` → **1617 gói / 30 s** (lẽ ra 1500 =
  50 gói/s) và **1.472.640 B / 30 s = 49 KB/s** (lẽ ra 32 KB/s), trong khi bộ đếm nhịp đã đúng 1 gói/20 ms.
  Nguồn gửi dư là **`src/audioCapture.ts` `drainTick()`**: tiếng Chrome/PulseAudio (1280 B/40 ms = 32 KB/s) gửi
  **thẳng** `broadcaster.sendAudioFrame()` cho mọi màn đã đăng ký và **chỉ** bị chặn bởi `callHold` — mà `callHold`
  chỉ được đặt trong `startCall()`, còn bài đo phát tệp mẫu **không mở call record** ⇒ cùng một loa nhận 2 luồng.
  Nay **mọi PCM xuống loa đi qua MỘT cổng duy nhất** `sendPanelAudio(dev, frame, src)` (`src/audioOut.ts`):
  nguồn `speaker` (tiếng người + `POST /call/test/play`, qua bộ đếm nhịp), `device` (trang thử `/call/ws`),
  `loop` (`POST /call/test/loop`), `web` (Chrome/PulseAudio). `web` bị **từ chối** khi màn đang giữ loa cho tiếng
  người (`holdVoice()` từ `startCall()`/`playTestAudio()`, đếm tham chiếu) hoặc vừa nhận tiếng người ≤ 250 ms.
  `sendToDevice()` **không còn tự chia gói rồi gửi ngay**: nó đưa PCM qua đúng bộ đếm nhịp và đúng định dạng gói
  của `sendToSpeaker()` (mono → [8 kHz] → [stereo]) nên không còn “1 khung vào → 2 gói ra”. `onMicFrame()`
  **không gửi mic của một màn về chính loa của nó** (chặn self-link ⇒ không echo).
  Thêm bộ đếm theo nguồn, log **mỗi 5 s**: `[audiosrc] speaker=<n> device=<n> loop=<n> web=<n> kb/s=<...>`.
  Đo lại trên loopback bằng script mới `scripts/measure-audiosrc.mjs` (`--old` = hành vi trước khi sửa):
  trước **746 gói / 63,6 KB/s / 74,6 gói/s** (có cả gói 642 B và 1282 B = 2 luồng) → sau **500 gói / 32,1 KB/s /
  49,9 gói/s, chỉ một cỡ gói 642 B, nguồn thứ hai bị chặn 246/246 khung**.
- Test: `src/audioSources.test.ts` — (a) 1 khung PCM vào → đúng 1 gói ra; (b) 50 khung trong 1 s → 50 gói / 32.000 B;
  (c) `/call/test/play` 10 s → 500 gói / 320.000 B = 32 KB/s; (d) nguồn thứ hai (`web`) bị từ chối trong lúc phát và
  trong cuộc gọi (`web=0`, `blocked>0`); (e) self-link không echo; (f) định dạng dòng `[audiosrc]`.
- **Sửa “nghe đứt quãng” trên loa P4: gửi STEREO (L = R) 1280 B/20 ms** (`src/audioStereo.ts`). Bằng chứng đo được
  trên thiết bị: server gửi PCM **mono** 640 B (20 ms), nhưng log P4 cho thấy `Mixer Source Speaker ... num_channels: 2`,
  “loa từ chối 201920–292800 B / 30 s”, “rơi ở hàng đợi 53–98 gói” ⇒ ring buffer loa **luôn đầy và bị vứt bớt**: 640 B
  mono chỉ tương đương **10 ms stereo** nên phần “tiêu thụ” nhanh gấp đôi phần “đổ vào” ⇒ tràn ⇒ đứt quãng.
  Nay `sendToSpeaker()` nhân đôi mỗi mẫu s16le sang 2 kênh **sau AGC, trước bộ đếm nhịp** (`src/callBridge.ts`):
  **640 B mono vào → 1280 B stereo ra**, vẫn **20 ms/gói** (bộ đếm nhịp `src/audioPacer.ts` nhận `frameBytes` cấu hình
  được: 640 cho web / 1280 cho màn, nhịp 20 ms không đổi — không gửi nhanh gấp đôi).
  Đo mức `[audio] in/out` **giữ nguyên ý nghĩa** (dBFS tính trên mono trước khi nhân đôi) để so được với các lần trước.
  Nhánh **điện thoại ↔ điện thoại giữ mono** như cũ (không đi qua `sendToSpeaker`).
  Tắt để A/B bằng **`CCR_CALL_STEREO=0`** (mặc định `1` = bật; log khởi động `[audio] stereo=on frame=1280B/20ms`,
  tắt: `[audio] stereo=off frame=640B/20ms`). Add-on có thêm tuỳ chọn **`call_stereo`** (mặc định `true`).
  Bài đo `POST /call/test/play` cũng gửi 1280 B/20 ms (cùng hàm) và trả thêm `stereo`/`frameBytes`,
  log `[test] play ... stereo=1 frame=1280 ...` để đối chiếu với log của P4.
- Test: `src/audioStereo.test.ts` (dài ×2, L = R, mẫu âm/dương, mẫu biên −32768, buffer lẻ, env A/B, log khởi động),
  `src/audioPacer.test.ts` (frameBytes = 1280: 1 gói/20 ms, 5 khung → 0/20/40/60/80 ms, không burst),
  `src/callTestAudio.test.ts` (tích hợp: 1 khung mono 640 B → gói 1280 B; `CCR_CALL_STEREO=0` → 640 B).
- **Tiếng gọi từ điện thoại xuống loa P4 to và đều hơn**: thêm **AGC + limiter** cho nhánh PCM điện thoại → màn
  (`src/audioAgc.ts`, gọi từ `sendToSpeaker`): mỗi khung 20 ms được đưa về **−18 dBFS** (attack 5 ms, release 200 ms,
  gain trong **[−6 dB, +24 dB]**), sau đó **limiter mềm −1 dBFS** để không rách tiếng khi nói to. Khung im lặng
  (< −60 dBFS) **không** bị khuếch đại (không ù nền phòng). Không thêm độ trễ, không đổi kích thước gói 640 byte.
  Chỉ áp cho nhánh xuống màn — gọi **điện thoại ↔ điện thoại** giữ nguyên (đang tốt).
  Tắt để A/B bằng biến môi trường **`CCR_CALL_AGC=0`** (mặc định `1` = bật; log khởi động `[audio] agc=on target=-18dBFS`).
  Add-on có thêm tuỳ chọn **`call_agc`** (mặc định `true`) trong Cấu hình, `run.sh` xuất thành `CCR_CALL_AGC`.
- **Trang gọi chống alias khi hạ mẫu xuống 16 kHz** (`public/call-web.html`): tạo `AudioContext` ngay ở **16 kHz** để
  trình duyệt tự resample (worklet thấy `r = 1`, không hạ mẫu), và nếu trình duyệt bỏ qua lựa chọn đó thì chèn
  **2 tầng BiquadFilter lowpass 7 kHz** (Butterworth bậc 4) trước worklet. Nhờ vậy tiếng gió/thổi hơi nhẹ vào mic
  không còn bị gập tần số thành tiếng “xoẹt” rất to. Khung 320 mẫu / 20 ms và giao thức `[0x01][PCM]` giữ nguyên.
- Test: `src/audioAgc.test.ts` (im lặng, khung nhỏ/khung lớn, attack/release, giới hạn gain, limiter −1 dBFS, tắt env
  → passthrough y nguyên byte, khung 20 ms vào 640 byte ra 640 byte).

## V2.9.318
- Thêm tuỳ chọn **`call_rate8k`**: hạ mẫu 16 kHz → **8 kHz** (lọc Butterworth bậc 6, chống alias) cho luồng tiếng
  xuống màn, để khớp tốc độ tiêu thụ thực tế của P4 (đo được ~16 KB/s). Dùng để kiểm chứng giả thuyết I2S chạy 8 kHz.

## V2.9.317
- **Gửi PCM stereo (L=R) xuống màn**: mixer của P4 chạy 2 kênh nên trước đây nhận mono 640 B bị lệch tốc độ
  ⇒ tràn buffer ⇒ vứt mẫu ⇒ nghe đứt quãng (`loa tu choi` 200–290 KB/30 s). Nay gửi 1280 B/20 ms, nhịp không đổi.
  A/B bằng option **`call_stereo`** (mặc định bật).

## V2.9.316
- Đóng gói **`test-audio/`** vào image (3 file WAV mẫu) để `POST /call/test/play` và `GET /call/test/files` hoạt động;
  `file=speech-like` tự thêm `.wav`. Đây là công cụ đo đường phát của màn bằng tín hiệu cố định.

## V2.9.315
- **Nhịp gửi đều 20 ms/khung** xuống loa màn (audio pacer, trần hàng đợi 100 ms + trần `bufferedAmount`) — sửa lỗi
  “giật cục, hụt hơi” do server dồn khung theo nhịp điện thoại rồi làm tràn ring buffer 250 ms của loa.
- Thêm **EQ cho giọng nói** (high-pass 120 Hz + presence +4 dB @1,5 kHz) bật/tắt bằng `CCR_CALL_EQ`.
- Thêm **bộ phát thử nghiệm**: `POST /call/test/play?dev=&file=&loop=&agc=&eq=` với 3 file WAV mẫu cố định
  (`speech-like`, `tone-1k`, `noise`) để đo khách quan đường phát của P4.

## V2.9.314
- **Đo mức âm thanh thật** của luồng điện thoại → màn: log `[audio] dev=… in=/out=/peak=/gain=/frames=` mỗi 2 giây
  trong cuộc gọi, để phân biệt “mic gửi nhỏ” với “đường phát của màn”.
- Trang gọi: công tắc **“Xử lý âm thanh của trình duyệt (AEC/NS/AGC)”** (mặc định bật) và `?raw=1` để A/B.

## V2.9.313
- **Âm thanh điện thoại → P4 rõ hơn**: thêm **AGC + limiter** cho luồng tiếng xuống màn (mục tiêu −18 dBFS,
  attack 5 ms / release 200 ms, gain −6…+24 dB, limiter −1 dBFS) — trước đây PCM gửi thô nên nói vừa bị chìm dưới
  nền phòng. Bật/tắt bằng option add-on **`call_agc`** (mặc định bật) để A/B.
- Trang gọi: **chống alias** khi hạ mẫu (AudioContext 16 kHz hoặc lọc lowpass 7 kHz) → giảm nhiễu nền, tăng độ rõ.

## V2.9.312
- Trang **Cuộc gọi**: khối “Chuông trên điện thoại” được chuyển vào **hộp thoại Cài đặt** (bánh răng), không còn
  đè lên thanh tab Nhật ký / Thiết bị khi mở trong Home Assistant.

## V2.9.311
- **Nhật ký cuộc gọi 2 chiều**: mỗi cuộc chỉ lưu **một bản ghi** rồi chiếu theo thiết bị đang xem, nên máy nhận
  thấy đúng **gọi đến** (nhỡ/đã nghe kèm thời lượng) và máy gọi thấy **gọi đi**. Trước đây điện thoại không thấy
  mục gọi đến vì bản ghi gắn với id phiên web. Tự gộp dữ liệu cũ khi khởi động; giới hạn nay là **200 cuộc**.

## V2.9.310
- **Điện thoại ↔ điện thoại có tiếng**: PCM 16 kHz được định tuyến giữa hai phiên web (`audioPeerOf`), chịu được
  phiên vừa bị thay/join.
- **Tab Nhật ký trên màn P4** (trước chỉ có trên trang web), bấm một dòng để gọi lại.
- **Xoá nhật ký**: `POST /calls/log/clear?self=` + nút “Xoá nhật ký” (có xác nhận) trên cả hai giao diện.

## V2.9.309
- **Nhật ký cuộc gọi**: lưu 200 cuộc gần nhất (`/data/rwv-call-log.json`) với hướng gọi, thiết bị, thời điểm,
  thời lượng, trạng thái (đã nói / nhỡ / từ chối / huỷ / lỗi); API `GET /calls/log?self=&limit=`.
- Trang **Cuộc gọi** có 2 tab **Nhật ký / Thiết bị**, bấm một dòng để gọi lại; app “Gọi” đổi tên thành **“Cuộc gọi”**.
- App Android: nút URL thành **bong bóng bánh răng kéo được** (nhớ vị trí), màn Cài đặt thiết kế lại theo trang Kết nối.

## V2.9.308
- **Add-on tự phục vụ HTTPS (port 18443) với chứng chỉ tự ký** → app Android có secure context cho micro/camera mà
  **không cần ingress của Home Assistant** (trước đây phải mở add-on từ sidebar HA một lần mới tạo được phiên).
  Điện thoại chỉ cần `https://<ip-LAN>:18443`. HTTP 18080 giữ nguyên cho các màn ESP32.

## V2.9.307
- **Sửa lỗi báo thức hiện nhầm màn**: `GET /alarm/list?dev=<id>` nay chỉ trả báo thức của màn đó + báo thức "Mọi màn
  hình". Trước đây mở Báo thức của P4 lại thấy cả báo thức tạo trên màn 480×272.
- App Android: **ký release** (keystore riêng, SHA-256 `3F:80:86:9D…`), icon đủ 5 mật độ (APK nhỏ hơn ~25%),
  thêm `android/scripts/smoke-test.sh` kiểm thử on-device.

## V2.9.306
- **Trình duyệt là thiết bị gọi được, ổn định**: mỗi trình duyệt có id bền trong `localStorage` và gửi `{type:'hello'}`
  khi kết nối, nên mở lại tab / rớt mạng **không sinh thêm thiết bị** và **không đổi id**. Hai tab cùng máy: tab cũ
  nhận `replaced` và ngừng giành phiên.
- Nhãn rõ ràng: `Samsung · Chrome`, `iPhone · Safari`, `Máy tính · trình duyệt`…; danh bạ sắp xếp
  **Màn hình → Điện thoại → Trình duyệt**, có chấm xanh online.
- Bỏ quy tắc ẩn phiên mobile ở 2.9.305 (giữ đúng ý: trình duyệt vẫn hiện và gọi được từ P4).

## V2.9.305
- **Ẩn mục "Dashboard · điện thoại" khỏi danh bạ**: khi đã có thiết bị điện thoại đăng ký thường trú, phiên trình duyệt
  mobile (mở tab Dashboard trên chính máy đó) không còn hiện thành một thiết bị riêng. Trình duyệt máy tính vẫn hiện.

## V2.9.304
- **Danh bạ gọi ổn định**: các phiên trình duyệt trùng tên ("Dashboard · điện thoại") được gộp thành một mục thay vì
  mỗi lần mở tab lại hiện thêm thiết bị. Phiên trình duyệt vốn là tạm (mở tab là có, đóng tab là mất) nên trước đây
  danh sách nhấp nháy.

## V2.9.303
- **Kết thúc cuộc gọi luôn đóng màn hình**: bấm Kết thúc/Từ chối ở bất kỳ bên nào đều đóng ngay tại máy đó và gửi
  `ended` cho mọi phiên còn giữ cuộc gọi (kể cả phiên web đã nối lại sau khi rớt WS — thêm `{type:'resume'}` và
  ân hạn 6 giây). Trước đây bên gọi đi bị treo ở "Đang gọi" khi bên kia từ chối.
- **Nhạc chuông không bị cắt**: thông báo cuộc gọi chỉ đăng lại mỗi **30 giây** (trước 4 giây) nên bản nhạc dài phát
  trọn vẹn.

## V2.9.302
- **Một ô địa chỉ duy nhất** trong app: nhập domain → dùng ingress HTTPS cho cả trang lẫn API (kèm cookie HA);
  nhập IP LAN → dùng `http://<ip>:18080` (cảnh báo mất micro/camera).
- **P4 nhận được hình từ điện thoại** trong cuộc gọi: khung video `0x02` từ trang gọi được chuyển tiếp xuống màn.
- App gửi cookie HA cho `/app/answer`, `/app/decline`, `/app/hangup` (trước đây 401 khi dùng ingress).
- Sửa lỗi KDoc trong `WebTargetResolver` làm hỏng build Android; thêm 7 test cho luồng một ô.

## V2.9.301
- **Vào thẳng cuộc gọi khi bấm Nghe (GĐ 3)**: trang `call-web.html` nhận `?call=<id>` → gắn phiên web làm đầu cuối
  tiếng của điện thoại (WS PCM 16 kHz), màn "đang gọi" có tên người gọi, đồng hồ, nút **Kết thúc**; đối phương cúp →
  tự về danh bạ. Thêm `POST /app/hangup` và `{type:'join'}` trong WS cuộc gọi.

## V2.9.300
- **Chống trùng thiết bị nhận cuộc gọi**: app gửi `deviceKey` (ANDROID_ID, được băm) + `model`; server gộp các bản ghi
  cùng thiết bị về bản ghi cũ nhất và trả id chuẩn. File cũ tự dọn khi đọc.
- **Quản lý thiết bị**: thêm `POST /app/rename` và `POST /app/remove`; trang Cuộc gọi có nút **sửa tên** và **xoá**
  cho từng điện thoại.

## V2.9.299
- Trang **Cuộc gọi**: khối "Chuông trên điện thoại" không còn dùng lớp modal nên **không đè lên danh sách thiết bị**
  nữa (trước đây che mất các thiết bị gọi được).
- App Android: tách **2 địa chỉ** — "Trang điều khiển (https)" cho WebView (để có quyền micro/camera) và
  "Máy chủ API (LAN)" cho đăng ký/nhận cuộc gọi; tự dò ingress `/api/hassio_ingress/<token>/`.

## V2.9.298
- **Mở trực tiếp các trang trong app Android**: cho phép request cùng origin từ trình duyệt trong LAN
  (`isLocalBrowser`) với `/ha/*`, `/photos/*`, quản lý file, nhật ký chuông cổng, chat — trước đây các trang này
  báo "Chỉ dùng được từ trang Dashboard trong Home Assistant".
- App: chuông dùng **âm thanh kênh thông báo** (kênh `incoming_call_v3`, importance cao, bypass DND, rung dài),
  app không tự phát nhạc chuông riêng nữa; nút URL dịch sang trái để không đè nút cài đặt của trang.

## V2.9.297
- **Khắc phục build lỗi 2.9.296**: image 2.9.296 bị hỏng tệp `node_modules/ical.js/dist/ical.js` (SyntaxError khi khởi
  động). Không đổi mã nguồn — build lại sạch để thay image lỗi.

## V2.9.296
- **Cài đặt một chạm cho app Android**: thêm `GET /app/ping` (có CORS, chấp nhận mọi tiền tố proxy) để app tự
  dò ra add-on. Người dùng chỉ cần nhập **IP hoặc domain của Home Assistant** — app tự thử 4–5 địa chỉ, tự đăng ký
  thiết bị và mở trang điều khiển.
- App: màn đầu rút gọn còn 1 ô “Địa chỉ Home Assistant” + nút **Kết nối**; có tiến trình dò, thông báo lỗi kèm
  danh sách đã thử; giữ nguyên toàn bộ chức năng nghe/gọi.

## V2.9.295
- **Nhận cuộc gọi trên app Android (GĐ 2)**: API `/app/register`, `/app/list`, `/app/incoming`, `/app/answer`,
  `/app/decline`; điện thoại đã đăng ký trở thành **thiết bị gọi được thường trú** (hiện trong danh bạ của P4 với nhãn
  "· Điện thoại"). Gọi tới điện thoại mà không ai nhận trong 30 giây → ghi **cuộc gọi nhỡ** như chuông cổng.
  Không đổi luồng P4 ↔ call-web cũ. Thêm 50 test (357 tổng).

## V2.9.294
- **Web Push (bước 1)**: sinh VAPID, API `/push/*`, service worker `sw.js`, và nút **Bật chuông trên điện thoại**
  trong trang Cuộc gọi. Điện thoại sẽ reo khi có cuộc gọi kể cả khi tab đã đóng (chỉ chuông + thông báo,
  KHÔNG tự nhấc máy — người dùng chọn Nghe hoặc Từ chối).

## V2.9.293
- Đồng bộ lại CHANGELOG trong add-on (các mục 2.9.288 → 2.9.292 bị thiếu do lỗi chèn chuỗi khi phát hành).
  Không thay đổi mã nguồn.

## V2.9.292
- Dọn log chẩn đoán `[notify] … dur=…` (thêm tạm ở 2.9.288).

## V2.9.291
- Thông báo camera: chữ đổi sang **xanh nõn chuối** (tiêu đề `#bef264`, nội dung `#d9f99d`) cho dễ đọc trên ảnh.

## V2.9.290
- Thông báo camera: chữ (tiêu đề + nội dung) chuyển lên **phía trên** ảnh để không chồng lên watermark giờ của camera.

## V2.9.289
- **Thông báo có camera vẫn hiện chữ**: trước đây chế độ toàn màn ẩn cả tiêu đề/nội dung, chỉ còn hình. Nay chữ phủ ở
  đáy ảnh (nền gradient), chỉ ẩn icon và hàng nút.

## V2.9.288
- Thêm log chẩn đoán `duration` nhận được ở `/notify` (tạm thời, đã bỏ ở 2.9.292) để tìm nguyên nhân "đặt 20 giây
  nhưng chỉ hiện 10 giây".

## V2.9.287
- **Không cho màn hình chờ bật lên khi đang hiện thông báo** (camera/ảnh): trước đây saver bật sau ~10 giây, che mất
  thông báo và làm cảm giác "thời gian hiển thị bị ngắn dù đặt 18–30 giây". Nay thông báo giữ đủ `duration` rồi mới
  tính tiếp trạng thái khoá/mở.

## V2.9.286
- Sửa mục "thông báo camera khi màn đang khoá": cờ khoá được ghi nhớ **trước khi** gỡ màn hình chờ (2.9.285 ghi sau nên
  luôn = false → kết thúc thông báo lại về màn hình chính). Nay khoá lại đúng như trước khi có thông báo.

## V2.9.285
- Ảnh nền: thêm mốc **5 giây** và **10 giây** cho thời gian chuyển ảnh.
- Hiệu ứng chuyển ảnh **chậm hơn, dễ thấy**: 1,4–1,8 giây (trước 0,65–0,8 giây).
- **Thông báo có camera trả lại đúng trạng thái khoá**: trước khi hiện thông báo màn đang khoá → khoá lại khi kết thúc;
  đang mở khoá → về màn hình chính (không tự khoá).

## V2.9.284
- **Hiệu ứng ảnh nền áp dụng đúng lựa chọn**: trước đây shell ép `fx = none` khi panel ở mức chuyển động thấp, nên
  đặt hiệu ứng trong Cài đặt không có tác dụng. Nay hiệu ứng người dùng chọn được tôn trọng; chỉ khi chưa chọn mới
  mặc định `fade` (motion full) hoặc `none` (màn yếu).
- **Thêm 3 hiệu ứng**: `Xoay vào/ra` (rotate + scale), `Rơi từ trên` (drop), `Lật 3D` (flip).

## V2.9.283
- **Sửa gốc lỗi sọc ảnh nền, giữ nguyên hiệu ứng**: lớp ảnh nền nay vẽ bằng thẻ `<img>` (`object-fit: cover`) thay vì
  `background-image`. Chrome headless raster sai lớp background khi ảnh lớn + scale; thẻ `<img>` không bị.
  Nhờ vậy **khôi phục hiệu ứng trượt / thu phóng / mờ dần** (đã bỏ ở 2.9.282).
- **Thêm 2 hiệu ứng mới**: `Mờ ảo (blur)` và `Chậm (Ken Burns)` — chọn trong Cài đặt → Ảnh → Hiệu ứng.

## V2.9.282
- **Sửa lỗi sọc dọc trên ảnh nền màn hình chờ**: lớp `.sv-ph` bị Chrome headless raster sai khi có
  `transform`/`transition` (hiệu ứng trượt/thu phóng) + ảnh scale lớn. Nay lớp ảnh vẽ **tĩnh** (bỏ transform/
  transition, `will-change: auto`). Ảnh vẫn phủ kín màn (`center/cover`), chỉ mất hiệu ứng chuyển.

## V2.9.281
- **Thông báo có camera/ảnh phủ toàn màn hình**: thẻ thông báo mang media nay dùng kích thước đầy màn (100% × 100%)
  thay vì `min(760px, 100%)` + `max-height: 42vh`; ảnh giữ đúng tỉ lệ (`object-fit: contain`), nền đen lấp phần dư,
  nên đúng ở mọi kích thước và mọi góc xoay.

## V2.9.280
- Trang chủ: IP hiện **ngay sau "Wi-Fi" / "Cáp"**, bỏ icon cáp gây hiểu nhầm khi màn đang dùng Wi-Fi.

## V2.9.279
- Trang chủ: thẻ **Chuông cửa** cũng hiện IP (server đã có sẵn `ip` từ lúc camera cổng kết nối).

## V2.9.278
- Sửa lỗi build 2.9.277 (đặt sai vị trí hàm `clientIp` trong lớp Broadcaster) — bản này thay thế 2.9.277.

## V2.9.277
- **Trang chủ Dashboard hiển thị IP từng màn hình** — lấy từ socket WebSocket đang kết nối, không phụ thuộc cảm biến firmware.

## V2.9.276
- Bàn phím màn ngang: chữ to thêm — `clamp(18px, 3.9vh, 32px)`.

## V2.9.275
- **Bàn phím màn ngang: chữ to hơn** — cỡ chữ phím đổi từ `2.4vmin` (nhỏ vì vmin = chiều cao thấp) sang
  `clamp(15px, 3.4vh, 28px)`, `line-height: 1`.

## V2.9.274
- **Bàn phím ở màn ngang**: tăng chiều cao phím (`min(300px, 56vh)`), các hàng sát nhau hơn (giảm gap), cỡ chữ theo vmin
  để phím cân đối giữa cao và rộng.

## V2.9.273
- **Bàn phím ảo: sửa hàng phím cuối bị che và phím không đều.** Chiều cao `min(196px, 50vh)` + `margin-bottom` từng hàng
  làm 5 hàng vượt khung trên màn thấp (480×272) và khi xoay 90/270. Nay: cao tối đa `min(196px, 62vh)` và `max-height:100%`,
  hàng `flex:1 1 0; min-height:0`, gap co theo `vmin`, phím `flex:1 1 0; min-width:0`, thêm safe-area cho đáy.

## V2.9.272
- **Đổi tên image GHCR**: `ghcr.io/minhquanghp86/darboardos-server` → **`dashboardos-server`** (theo tên repo mới).
  Slug add-on không đổi nên cập nhật bình thường, không mất dữ liệu.

## V2.9.271
- **Đổi tên sự kiện HA**: `darboard_doorbell` → **`dashboard_doorbell`**, `darboard_chat_message` →
  **`dashboard_chat_message`**. (Automation dùng tên cũ cần sửa trigger.)
- Nhận diện thực thể "máy chủ" của panel theo mẫu `_ha_<tên>_server` (đổi tên hiển thị không còn làm hỏng mục cài đặt).
- Dọn toàn bộ chữ "darboard" còn lại trong mã nguồn và tài liệu (chỉ giữ tên repo GitHub + image GHCR vì không đổi được).

## V2.9.270
- **Sửa quyền `/iptv/*` cho tích hợp HA**: add-on chạy `host_network` nên HA core gọi tới bằng IP LAN của máy HA
  (vd `192.168.10.2`), không phải `172.30.32.x` → trước đó bị 403. Nay cho cả LAN/Tailscale như các API khác
  (`/screens/*`, `/alarm/*`).

## V2.9.269
- **IPTV cast gọi được từ tích hợp HA**: `/iptv/*` trước chỉ cho `172.30.32.2` (ingress), nay cho cả dải
  supervisor `172.30.32.0/24` — HA core gọi từ `172.30.32.1` nên trước đó bị 403 khi dùng `dashboard_os.cast_iptv`.

## V2.9.268
- **Đổi tên hiển thị: "Darboard" → "Dashboard"** (sửa lỗi chính tả). Áp dụng cho toàn bộ giao diện, tài liệu, log và
  tên add-on: **"Dashboard OS Server"**, tiêu đề thanh bên **"Dashboard"**, tích hợp HA **"Dashboard OS"**.
- **Giữ nguyên các định danh đang dùng thật** (đổi sẽ hỏng automation/thiết bị): slug add-on `remote_webview_server`,
  image `ghcr.io/minhquanghp86/darboardos-server`, tên repo GitHub `DarboardOS-Server`, domain tích hợp
  `dashboard_os`, các sự kiện HA `dashboard_doorbell` / `dashboard_chat_message`, `rest_command.dashboard_hien_camera`,
  `dashboard_ring`, component ESPHome `dashboard_door` và tên thực thể `…_ha_dashboard_server`.
- `TRADEMARKS.md` giữ nguyên (là tuyên bố nhãn hiệu, trích dẫn tên gốc).

## V2.9.267
- **Nút "Màn hình chính" nay đóng "Gần đây"**: khi đang ở tab hệ thống, `goOsHome()` gọi `activateTab()` và hàm này
  return sớm (tab đã active) nên không gửi gì xuống Shell → lớp "Gần đây"/bảng điều khiển vẫn nằm trên màn.
  Nay server gọi `window.__rwvShell.home()` (đóng cả hai lớp) khi tab đích đã là tab hệ thống.

## V2.9.266
- **Sửa lỗi "hình bị co nhỏ" sau khi bấm Gần đây rồi Màn hình chính.** Ảnh thu nhỏ cho thẻ "Gần đây" trước đây chụp bằng
  `Page.captureScreenshot({clip:{..., scale: 320/width}})`; trên Chromium headless lệnh này làm surface/screencast
  lệch kích thước, các khung sau đó ra đúng cỡ thumbnail (320×188 với màn 1024×600 — tỉ lệ 0,3125) nên panel vẽ
  ảnh nhỏ vào góc khung đầy. Chỉ xảy ra khi lệnh chụp chen đúng nhịp screencast → **thỉnh thoảng**, ở mọi màn.
  Nay: thu nhỏ **từ khung vừa gửi** bằng sharp, không dùng CDP; nếu chưa có khung thì chụp toàn khung (không clip).
- **Lưới an toàn:** khung screencast có kích thước < 75% màn hình (khi không ở chế độ nửa phân giải) bị bỏ qua,
  tự khôi phục viewport và xin khung đầy đủ.

## V2.9.265
- Thêm `GET /screens/dbg?id=<man>` (LAN): trả viewport THẬT của tab đang hiện (`innerWidth/innerHeight`, DPR, zoom,
  kích thước `<html>`, URL) để chẩn đoán lỗi hình bị co nhỏ.

## V2.9.264
- Trang Báo thức: dòng "Báo thức chung" hết bị tô màu link (thêm `color: inherit; text-decoration: none`).

## V2.9.263
- **Sửa trang Báo thức khi mở qua tên miền/HA ingress**: trang gọi `/screens/list` và `/alarm/list` bằng đường dẫn
  tuyệt đối nên khi URL có tiền tố `/api/hassio_ingress/<token>/` sẽ trỏ ra gốc domain → 404, danh sách màn hình
  rỗng ("Chưa có màn hình nào kết nối"). Nay dùng đường dẫn **tương đối** (như `screens.html`).
- Trang chọn màn có thêm khối **"Báo thức chung (mọi màn hình)"** để thấy ngay các báo thức đặt cho tất cả màn.

## V2.9.262
- **Sửa bố cục trang Báo thức trên Dashboard**: tên màn và dòng trạng thái bị chồng lên nhau (span inline) → nay
  mỗi dòng một hàng, badge số báo thức không đè lên tên.

## V2.9.261
- **Ứng dụng "Báo thức" trên Dashboard** (`public/alarm-ctl.html`): có mặt trong lưới ứng dụng ở trang chủ.
  Bước 1 chọn màn hình → mở đúng trình Báo thức của màn đó (`alarm.html?dev=<id>`), báo thức mới mặc định reo
  trên màn vừa chọn. Thẻ mỗi màn hiện số báo thức đang bật và giờ reo kế tiếp.
- Dùng chung dữ liệu với ứng dụng Báo thức trên các màn hình (`/data/rwv-alarms.json`), nên thêm/sửa/xoá ở đâu
  cũng đồng bộ.
- API `/alarm/*` mở cho **LAN/Tailscale và HA ingress** (trước chỉ 127.0.0.1) để trang trên điện thoại dùng được.

## V2.9.260
- **Panel nhỏ: ép cứng nhịp 80 ms** (bỏ điều kiện "chỉ khi bộ điều tiết đứng yên"). Đo: decode 56 ms vẫn dưới 80%
  ngân sách ở 80 ms; trước đó bộ điều tiết tự nới 75 → 100 ms làm fps tụt.

## V2.9.259
- **Panel nhỏ: nhịp ép 85 → 75 ms** (thử nghiệm, ~13 fps lý thuyết).

## V2.9.258
- **Panel nhỏ: nhịp ép 100 → 85 ms** (≈11.8 fps) — decode thực đo 55 ms nên vẫn dưới 65% công suất.

## V2.9.257
- **Nhịp panel nhỏ điều chỉnh được qua `SMALL_PANEL_INTERVAL_MS`** (mặc định 100 ms) để thử nghiệm 85/75 ms.

## V2.9.256
- **Panel nhỏ không còn kẹt 200 ms sau khi khởi động lại.** Bộ điều tiết không nhận được mẫu decode của panel
  480×272 (không có dòng `[adaptive]` nào), nên sau restart nó đứng yên ở 200 ms dù decode chỉ ~52 ms → 5 fps.
  Nay: khi bộ điều tiết **đứng yên** (`changed=false`) mà nhịp > 100 ms thì ép về 100 ms; khi nó chủ động giảm tốc
  (có nghẽn thật) thì vẫn tôn trọng.

## V2.9.255
- **Trả ngưỡng passthrough về 128 KB.** 2.9.253 hạ xuống 64 KB làm panel 480×272 rơi vào đường tắt (Chrome đẩy
  khung theo nhịp render ~60 fps) → panel quá tải, nhịp tự giãn về 200 ms và fps sụt 9.8 → 5.0. Giữ nguyên phần
  "chất lượng UI đi tới encoder" (2.9.253) nhưng không đổi ngưỡng passthrough.

## V2.9.254
- **Sàn hồi phục nhịp khung không được vượt trần cấu hình.** `recoverFloorOf()` trước đây bỏ qua `maxIntervalMs`,
  nên sau MỘT lần nghẽn ở 200 ms panel nhỏ (trần 100 ms) kẹt vĩnh viễn ở 200 ms → 5 fps dù decode chỉ 55 ms.
  Nay `Math.min(cfg.maxIntervalMs, floor)` → nhịp luôn về ≤100 ms sau hồi phục.

## V2.9.253
- **Chất lượng đặt trong UI giờ đi tới encoder thật.** Trước đây đường video (`videoScreencastQuality`) luôn dùng
  hằng số 90 (vì panel 480×272 khai gói 64 KB < ngưỡng 128 KB) và bỏ qua `qualityOverride` → đặt q40/q50/q60 đều
  cho khung ~18 KB như nhau. Nay:
  - `effectiveJpegQuality()` = `qualityOverride ?? cfg.jpegQuality`, dùng cho cả khung tĩnh lẫn video;
  - ngưỡng passthrough hạ 128 KB → **64 KB** (panel nhỏ vẫn đủ);
  - đổi chất lượng trong Dashboard UI áp **ngay** vào screencast đang chạy (không cần tải lại trang).

## V2.9.252
- **Panel nhỏ: chặn trần nhịp khung 100 ms (≥10 fps).** Đo thực tế: decode chỉ 55 ms nhưng bộ điều chỉnh ghim nhịp
  150-200 ms (dùng 28% ngân sách) → 5-6.7 fps. Nay với panel ≤480×272 đặt `maxIntervalMs: 100`.
  Kèm log `[cfg]` một lần/thiết bị để xác nhận `width/height` thật (nghi vấn điều kiện nhận diện panel nhỏ).

## V2.9.251
- **Sửa tiếp việc panel nhỏ kẹt q40.** 2.9.250 chỉ đặt `minQuality` nhưng state của bộ điều chỉnh đã khởi tạo sẵn ở
  sàn 40 và chỉ có thể hạ, nên không bao giờ vươn lên. Nay nâng thẳng trong state:
  `if (pinQuality && quality < cfg.jpegQuality) quality = cfg.jpegQuality` → panel ≤480×272 phát đúng q65.

## V2.9.250
- **Panel ≤480×272: ghim chất lượng đúng `jpeg_quality` (hết kẹt q40).** Bộ điều chỉnh không nhận được mẫu decode
  (`recentMedianDecodeMs = 0`) nên đứng nguyên ở sàn `minQuality = 40`, khiến YouTube mờ dù YAML đặt q70/q80.
  Nay với màn rất nhỏ, `minQuality = maxQuality = cfg.jpegQuality` → luôn phát đúng chất lượng đã cấu hình.
  Panel 480×272 đặt `jpeg_quality: 65` (cân bằng nét / fps).

## V2.9.249
- **480×272: tắt half-scale để ảnh nét hơn.** Màn nhỏ đang nhận khung **nửa độ phân giải** (240×136) rồi phóng lên
  → YouTube rất mờ. Nay panel ≤480×272 luôn nhận khung **đủ 480×272** (diện tích nhỏ nên băng thông vẫn nhẹ).
  Các panel khác giữ nguyên half-scale.

## V2.9.248
- **Trả lại cảm ứng (2.9.247 chặn nhầm) + sửa chiều phím YouTube TV.** 2.9.247 bỏ chuỗi chạm thô ở tab `yttv` nên
  panel **mất cảm ứng hoàn toàn**; nay luôn bắn chạm thô như bản ổn định, phím mũi tên chỉ là bổ sung.
  Đồng thời sửa chiều phím live cho **đúng quy ước `tvSwipeKeys()`**: kéo sang trái → `ArrowRight`, kéo lên →
  `ArrowDown` (bản 2.9.242 đang ngược nên điều hướng sai/loạn).

## V2.9.247
- **YouTube TV (800×480): hết "loạn" khi chạm/vuốt.** Trước đây với tab `yttv` server vẫn bắn **chuỗi chạm thô**
  (touchStart/Move/End) **rồi** thêm phím mũi tên → trang nhận 2 nguồn sự kiện cùng lúc nên nhảy sai/không nhạy.
  Nay tab YouTube TV **chỉ gửi phím mũi tên**; chạm không di chuyển thì gửi 1 tap ngắn để vẫn chọn được mục.

## V2.9.246
- **Sửa tận gốc lỗi "co 1/4" + bật lại half-scale.** 2.9.245 chỉ tắt tạm half-scale (giảm byte/khung khi phát video,
  tắt hẳn sẽ hại fps S3). Nguyên nhân thật: khi chuyển **half → full**, server không ép gửi lại khung đầy đủ, panel
  còn giữ ảnh nền nửa kích thước nên vẽ ảnh nửa cỡ vào khung đầy. Nay ở nhánh tắt half có
  `requestFullFrameFor(dev) + forceSharp + prevFrameHash = -1` → khung kế tiếp là ảnh đầy đủ, hết lệch cờ.
  Half-scale bật lại như cũ.

## V2.9.245
- **Tắt tạm chế độ half-scale**: panel S3 (đặc biệt 800×480) thỉnh thoảng vẽ ảnh như **co 1/4**. Nguyên nhân là
  khung nửa kích thước (`halfScale: true`) lệch cờ so với khung đầy. Băng thông LAN còn dư nên tắt hẳn chế độ này
  (`HALF_ENABLED = false`) để ưu tiên hiển thị đúng; có thể bật lại khi tìm ra đúng chỗ lệch cờ.

## V2.9.244
- **Mọi cử chỉ kéo đều theo tay trên tất cả panel (kể cả màn hình khoá).** Bỏ hết các chốt `CFG.motion === 'full'`
  vốn chỉ bật kéo-live cho P4: (1) thẻ ứng dụng ở màn hình Gần đây, (2) bong bóng "Quay lại" khi vuốt mép,
  (3) thanh vuốt lên (Màn hình chính / Gần đây), (4) **màn hình khoá** (kéo lên để mở khoá). Các hiệu ứng *chuyển
  trang* (animation) vẫn giữ nguyên theo mức motion để không nặng máy.

## V2.9.243
- **Màn hình chính: kéo theo tay trên panel S3.** Pager chỉ cập nhật vị trí khi `ctx.motion === 'full'`; các panel
  S3 đặt motion thấp nên **không vẽ theo tay**, chỉ nhảy khi nhả (đo thật: 480×480 đổi khung tại 245 ms, 480×272 tại
  240 ms, trong khi cú kéo chỉ 211–215 ms; P4 đổi tại 64/135/211 ms). Nay luôn cập nhật transform mỗi `pointermove`,
  không phụ thuộc motion.

## V2.9.242
- **Điều khiển YouTube TV: phím mũi tên phát ngay khi kéo.** Giao diện youtube.com/tv chỉ nhận phím mũi tên, và
  trước đây server chỉ đổi cú vuốt thành phím **khi nhả tay** (`kind === 'up'`) → trên các panel đang ở tab YouTube TV
  (480×480, 480×272) giữ tay kéo không thấy gì, nhả tay mới nhảy. Nay cứ vuốt quá **40 px** là bắn phím tương ứng
  ngay trong lúc kéo và lấy mốc mới → điều hướng live như panel thật. `up` vẫn xử lý phần dư cuối cùng.

## V2.9.241
- **Bỏ hẳn việc bỏ qua chụp khung khi đang thao tác.** 2.9.240 cho SSE dùng chung `latestFrame`, nhưng trong
  `pumpLive` vẫn còn `if (inputBusy) continue` → **không chụp khung nào** trong lúc giữ tay kéo, mà SSE lại đọc
  đúng buffer đó ⇒ hình trên thẻ đứng yên tới khi nhả (màn hình thật vẫn chạy vì dùng screencast push). Nay luôn
  chụp; việc chống nghẽn đã do cơ chế gộp `move` (2.9.239) đảm nhiệm.

## V2.9.240
- **Trả lại "1 vòng chụp/thiết bị" cho cả đường SSE** (đọc code 2.9.207/2.9.212: bản cũ dùng chung một vòng chụp,
  chia khung cho mọi người xem; 2.9.214 khi chuyển sang SSE lại tạo **một vòng `captureScreenshot` riêng cho từng
  kết nối**). Mỗi vòng chiếm kênh CDP ~65 ms, tranh với `Input.dispatchTouchEvent` (~26 ms) → giữ tay kéo là hình
  đứng yên. Nay SSE đăng ký vào vòng chụp chung (`pumpLive`) và chỉ đọc `latestFrame`, không gọi CDP nữa; nhịp gửi
  cố định 60 ms (~16 fps) không phụ thuộc thời gian chụp.

## V2.9.239
- **Sửa hình đứng yên khi giữ tay kéo (thẻ Điều khiển).** Mỗi lệnh `Input.dispatchTouchEvent` tốn ~26 ms và dùng
  **cùng kênh CDP** với `Page.captureScreenshot`. Gửi 60 move/giây = 1,5 s CDP mỗi giây → lệnh chụp khung không chen
  vào được, nên trong lúc giữ tay hình đứng yên tới khi nhả. Nay khi một lệnh `move` đang chạy thì các điểm kế tiếp
  **được bỏ qua** (chỉ gửi vị trí mới nhất khi kênh rảnh) → nhường CDP cho khung hình, cảm giác kéo vẫn liền.

## V2.9.238
- **Thẻ Điều khiển: chặn Chrome Android "cướp" cử chỉ kéo.** `#touch` nay có `touch-action:none` +
  `overscroll-behavior:none`, và `pointerdown/pointermove` gọi `preventDefault()` — trước đây trình duyệt có thể
  hiểu cú kéo dọc là **cuộn trang** rồi phát `pointercancel`, nên giữ tay kéo không có tác dụng.

## V2.9.237
- **Sửa treo hình trên Chrome Android ở thẻ Điều khiển.** Khi WebSocket rớt, trang rơi về **MJPEG**; Chrome Android
  **không phát** `multipart/x-mixed-replace` trong `<img>` (chỉ hiện 1 khung → header báo `MJPEG 0/0 fps · DỪNG`).
  Nay fallback chuyển sang **SSE** (EventSource chạy tốt trên Android), MJPEG chỉ dùng khi mở bằng `?mjpeg`.

## V2.9.236
- **Sửa: giữ tay trên màn hình thì hình đứng yên.** Bản 2.9.231 ưu tiên băng thông bằng cách **tạm dừng luồng khung**
  ~3 fps trong lúc có thao tác; khi kéo liên tục, `inputBusy` được gia hạn mãi nên hình chỉ cập nhật sau khi **nhả tay**
  (người dùng báo đúng hiện tượng này). Nay chỉ nghỉ 30 ms/khung khi đang thao tác → vẫn ~15-20 fps, kéo thấy hình
  chạy theo tay. Input đã đi qua WebSocket (kênh riêng, tin nhỏ) nên không cần nhường băng thông nữa.

## V2.9.235
- **Điều khiển: input đi qua WebSocket (giống màn hình thật).** Panel thật gửi `TouchType` qua WS
  (`remote_webview.ws_send_touch_event_`) nên độ trễ chỉ là WiFi; thẻ Điều khiển trước đây lại gửi từng điểm
  bằng HTTP POST. Nay khi trang có WS, mỗi điểm chạm/vuốt được gửi thẳng qua WS (server bơm vào Chromium ngay) →
  LAN/Tailscale gần như tức thì. Không có WS (qua tên miền) thì vẫn gộp đoạn 60 ms như 2.9.234.
- **Tự chuyển sang LAN/Tailscale:** `GET /control/ping` trả IP LAN của HA; trang mở bằng tên miền (HTTP) sẽ
  probe `http://<lan>:18080/control/ping`, tới được thì tự chuyển sang IP để dùng WebSocket. Trang HTTPS thì
  trình duyệt chặn probe (mixed content) nên giữ nguyên tên miền.

## V2.9.234
- **Kéo/vuốt live theo từng đoạn 60 ms.** Đo thật: mỗi lệnh `Input.dispatchTouchEvent` tốn ~26 ms ở server
  (p90 33 ms) + ~200 ms RTT qua tên miền công khai. Bản 2.9.233 gửi 1 POST mỗi điểm (~60 request/giây) →
  dồn hàng, kéo bị giật; bản 2.9.232 lại gộp tới lúc nhả tay → mất cảm giác kéo. Nay: `down` gửi ngay, các
  điểm dồn lại gửi mỗi 60 ms (~16 request/giây, mỗi request nhiều điểm), `up` gửi ngay → vẫn thấy phản hồi
  trong lúc kéo, ít request hơn 4 lần. `/control/gesture` nhận `start`/`end` để phát lại đúng thứ tự.

## V2.9.233
- **Trả lại điều khiển LIVE từng điểm** (như 2.9.224): bản 2.9.232 gộp cả cử chỉ vào 1 POST nên chỉ gửi khi
  **nhả tay** → kéo/vuốt không thấy phản hồi trong lúc đang giữ (người dùng báo mất cảm giác thao tác thật).
  Nay gửi `down` → `move` (tiết chế 16 ms ≈ 60 điểm/giây) → `up` ngay lập tức, không chờ phản hồi. Giữ nguyên
  phần ưu tiên băng thông: trong lúc có thao tác, luồng khung hạ xuống ~3 fps nên lệnh điều khiển không bị nghẽn.

## V2.9.232
- **Sửa điều khiển cảm ứng bị trễ nặng trên tên miền công khai.** Mỗi điểm chạm trước đây là 1 POST riêng
  (một cú vuốt = down + ~9 move + up = **11 lượt qua mạng**; qua Cloudflare ~150-250 ms/lượt → cú vuốt mất
  1,5-2 s nên vuốt mở khoá/trong app gần như không ăn). Nay trang gom cả cử chỉ thành **1 POST** `/control/gesture`
  (kèm toạ độ + mốc thời gian), server phát lại từng điểm theo nhịp thật (trần 600 ms/điểm để long-press vẫn ăn).
  Giữ nguyên `/control/input` cho tương thích. Nhịp khung vẫn hạ ~3 fps trong lúc có thao tác (2.9.231).

## V2.9.231
- **Thẻ Điều khiển: ưu tiên thao tác chạm/vuốt.** Mỗi khung JPEG 19-53 KB (base64 +33%) nên ở 15-25 fps luồng
  stream chiếm 0,5-1,4 MB/s; trên ingress/WiFi các POST `/control/input` bị nghẽn phía sau → **vuốt không ăn,
  không mở khoá được màn hình, thao tác gần như vô tác dụng**. Nay trong ~800 ms sau mỗi lệnh chạm/vuốt,
  luồng khung hạ xuống ~3 fps để lệnh điều khiển đi trước. Đồng thời `SCALE 0.75 → 0.65` (khung nhỏ ~35% byte).

## V2.9.230
- **Thẻ Điều khiển mượt hơn**: bỏ khoảng nghỉ cố định 55 ms giữa 2 khung (`FRAME_GAP_MS`). Đo thật: `captureScreenshot`
  tốn 50-68 ms (Chromium software render; P4 đang phát YouTube) nên nhịp chỉ còn **8-10 fps**; bỏ gap → **~14.7 fps (P4)**,
  **~19 fps (S3)**. Thêm chặn tồn đọng `bufferedAmount > 1 MB` cho kênh WebSocket (SSE/MJPEG đã có `writableLength`).

## V2.9.229
- **Bàn phím ảo: sáng hơn, bo góc, có hiệu ứng bấm, nền kính mờ.** (1) Bớt tối: nền tối gần đen -> xám xanh sáng,
  phím sáng hơn, chữ trắng có đổ bóng nhẹ. (2) Phím bo góc 10px (trước 2px vuông), bỏ viền cứng, thêm bóng nổi.
  (3) Hiệu ứng bấm: phím lún + sáng lên (`translateY(2px) scale(.95)` + `brightness(1.55)`) thay cho việc đổi nền xám
  (trước đây đổi nền làm mất màu phím Enter/VN/layout). (4) Nền bán trong suốt + `backdrop-filter` blur 14px.
  (5) Màn thấp: chiều cao `min(196px, 50vh)` (480x272 trước chiếm 72% màn hình, nay 50%). (6) Màn dọc (panel xoay
  90/270, vd 272x480): chế độ hẹp giảm gap/padding -> phím 21px -> 24px.

## V2.9.228
- **App Camera theo góc xoay panel (90/270)**: video preview xoay bù `-rot` (hết nghiêng), thanh nút chuyển xuống
  **đáy màn hình** với bố cục `Ảnh/Video — nút chụp (giữa) — Thư viện (phải)`. Trang nhận `?rot=` từ server;
  mở lại app sau khi đổi góc xoay sẽ tự nạp URL mới.

## V2.9.225
- **Vuốt điều hướng YouTube TV trên tab Điều khiển** (giống panel thật): giao diện youtube.com/tv chỉ nhận **phím
  mũi tên**, nên khi thả tay sau cú vuốt, server chuyển hướng/distance thành `ArrowUp/Down/Left/Right` (như
  `_tvGesture` của panel thật). Đã test: vuốt trên P4 → 56% khung hình đổi (menu chuyển).

## V2.9.224
- **Sửa "chạm 1 lần thành chạm giữ"**: bỏ xếp hàng đợi tuần tự (mỗi lệnh chờ lệnh trước ~100-250 ms qua
  Cloudflare làm `touchEnd` bị đẩy xa `touchStart`). Nay gửi **ngay, không chờ** theo thứ tự phát (như bản
  2.9.199), chỉ tiết chế `move` 33 ms để không lũ request.

## V2.9.223
- **Điều hướng vuốt ổn định trên mọi màn** (P4 và các màn khác): đưa cả `down` (touchStart) vào cùng hàng đợi
  thứ tự với `move`/`up` — trước đây `down` gửi ngoài hàng đợi, có thể tới sau `move` khiến Chrome bỏ vuốt.

## V2.9.222
- **YouTube TV hiển thị đầy màn hình**: nguyên nhân menu youtube.com/tv (giao diện ytlr) co nhỏ là do viewport
  cũ 800×480/1280×720 — trang chỉ render đầy ở **1920×1080**. Nay tab YouTube TV dùng viewport 1920×1080 rồi
  **thu nhỏ về đúng kích thước màn** trước khi gửi (menu lẫn video đều đầy; fps giữ nguyên ~16 trên Sunton).

## V2.9.221
- **Vuốt nhanh trên màn 480×480 hết bị "nuốt"**: trước đây `touchEnd` (up) gửi ngay trong khi các `touchMove`
  còn đang gộp/bay → Chrome nhận touchEnd trước touchMove nên vuốt nhanh thành chạm. Nay dùng **hàng đợi thứ tự**
  `down → move(gộp) → up`; move vẫn gộp vị trí mới nhất để không lũ request.

## V2.9.220
- **Khôi phục vuốt/điều hướng ngang-dọc** ở tab Điều khiển (mất từ 2.9.215). Thay vì bỏ sự kiện move khi
  đang gửi (làm vuốt thành chạm), giờ **gộp move**: luôn gửi vị trí mới nhất, tối đa 1 request đang bay →
  đường vuốt mượt mà không gây lũ request (nguyên nhân 429).

## V2.9.219
- **Sửa cảm ứng sai trên màn hình xoay 180°** ở tab Điều khiển: trước đây toạ độ chạm bị xoay thêm một lần
  (ảnh xem trước là Chrome chưa xoay nhưng lại áp `mapPointForRotation`) → chạm Frigate mở Tin tức, chạm Phòng
  mở YouTube TV. Nay gửi toạ độ nguyên vẹn.

## V2.9.218
- **Điều khiển: giảm nốt treo khung** — nâng timeout chụp khung lên 1200 ms + lùi nhẹ 150 ms khi bỏ khung
  (trước 700 ms dễ bỏ nhầm khung khi CDP chậm thoáng qua). Watchdog trang nâng lên 2 s cho khớp.

## V2.9.217
- **Điều khiển: hết treo khung (`0/0 · DUNG`)** — lệnh chụp khung CDP có thể treo khi thiết bị đang phát video nặng,
  làm vòng SSE/WS đứng im. Nay **timeout 700 ms** (bỏ khung treo, vòng vẫn chạy) + trang có **watchdog 1,5 s**
  tự ngắt và nối lại nếu luồng im lặng. Đo khi P4 đang phát YouTube: **17,4 fps / 30 s, 0 khe > 1,5 s**.

## V2.9.216
- **Điều khiển: nút "Mở khoá" + tự mở khoá khi vào trang.** Màn hình khóa (nền trắng ban ngày) che tab
  YouTube/ứng dụng nên nhìn như "trắng màn" — giờ trang Điều khiển tự gửi `unlock` lúc mở, và có nút Mở khoá.

## V2.9.215
- **Điều khiển: chạm tin cậy** — `down`/`up` giờ **retry tới 2 lần** (timeout 4 s, nháy đỏ khi lỗi),
  còn `move` tiết chế **60 ms** và bỏ qua nếu đang gửi — tránh lũ ~60 req/s làm Cloudflare/ingress giới hạn
  rồi kéo theo cả `down`/`up` bị rớt (hiện tượng "bấm không ăn vài giây một lần").

## V2.9.214
- **Điều khiển qua Cloudflare/tên miền: dùng SSE (text/event-stream)** — kênh duy nhất Cloudflare stream ổn định
  (MJPEG bị đệm, WebSocket bị đóng sau vài khung, polling bị 429). Mỗi khung = 1 dòng base64 JPEG, ~14 fps.
- Vào bằng IP LAN/Tailscale vẫn dùng WebSocket (~18 fps).

## V2.9.213
- **Điều khiển (WS): heartbeat hai chiều** — client gửi `p` mỗi 2 s, server `ping` mỗi 3 s để proxy
  (HA ingress / Cloudflare) không đóng kết nối WebSocket khi chỉ truyền một chiều khung hình.

## V2.9.212
- **Điều khiển: quay lại đúng cách của 2.9.199 (bản chạy tốt)** — qua HA ingress / tên miền dùng **MJPEG trực tiếp**
  (`<img>` tự cập nhật), không dùng WebSocket (bị ingress đóng sau vài khung) và không polling đều (bị 429).
  MJPEG đứt thì thử lại MJPEG 1 lần rồi mới rơi xuống chụp từng ảnh.
- Vào bằng **IP LAN/Tailscale** thì vẫn dùng WebSocket (~18 fps) và nút Điều khiển tự mở cổng `:18080`
  (add-on chạy host network nên cổng này đã sẵn sàng, không cần publish).

## V2.9.211
- **Điều khiển qua tên miền (Cloudflare/ingress)**: bỏ hẳn WS và MJPEG (proxy cắt luồng: *Cannot write to closing
  transport*), dùng **polling 250 ms** + tự lùi khi 429. Nút Điều khiển **chỉ chuyển sang cổng 18080 khi đang vào
  bằng IP** (LAN/Tailscale); vào bằng tên miền thì giữ nguyên đường dẫn — trước đó bị timeout vì `:18080` không ra ngoài.
- Nhãn chẩn đoán `nhận/vẽ fps` + `· ĐỨNG n s`, lỗi kèm header để biết ai trả 429.
- Sửa: trang HTML được cache trong RAM lúc khởi động nên bản vá không có hiệu lực tới khi restart add-on.

## V2.9.210
- **Điều khiển: mở cổng trực tiếp 18080** (LAN/Tailscale). Nguyên nhân gốc: qua HA ingress, WebSocket bị đóng
  sau vài khung, MJPEG bị đệm → trang phải polling liên tục và **bị 429**. Mở thẳng cổng thì WS chạy ~18 fps.
  - Add-on công bố `18080/tcp` ra host; nút **Điều khiển** trên Dashboard tự mở `http://<ip-ha>:18080/control.html?dev=…`.
  - API control + screens cho phép nguồn từ mạng nội bộ (10/172.16-31/192.168).
- Điều khiển khi vẫn qua ingress: giãn nhịp polling và **tự lùi khi gặp 429** (tối đa 3 s) thay vì dồn dập.

## V2.9.209
- **Điều khiển: chẩn đoán + tự chọn đường truyền.** Nhãn giờ hiện **`nhận/vẽ` fps** (vd `MJPEG 18/17 fps`);
  nếu quá 1,5 s không vẽ được khung nào sẽ hiện đỏ **`· ĐỨNG 3s`**.
- Qua **HA ingress** trang dùng **MJPEG ngay** (đo thật: WebSocket qua ingress chỉ sống vài khung, MJPEG chạy
  ~18 fps liên tục); WS vẫn dùng khi mở trực tiếp. WS đứt 2 lần hoặc sống < 5 s → tự chuyển MJPEG.
- MJPEG chống ứ: bỏ khung khi bộ đệm > 1 MB (mạng điện thoại chậm không làm trễ tích luỹ).

## V2.9.208
- **Khoảng giờ ban đêm cấu hình được, theo TỪNG màn hình**: màn hình chờ trong khoảng này chỉ hiện đồng hồ,
  không hiện ảnh (mặc định 22:00 → 06:00 như trước, giờ địa phương của thiết bị). Có ở cả **Dashboard → cài đặt
  từng màn** (nhóm *Hình nền & Khung ảnh*) và **ứng dụng Cài đặt trên chính màn hình**.
  - "Đêm: tắt ảnh từ" / "Đêm: tắt ảnh đến" (0–23 giờ, vắt qua nửa đêm được), chọn **"Cả ngày (tắt đêm)"** để luôn có ảnh.
- Sửa: mục *Chất lượng hình ảnh* thiếu nhóm trong ứng dụng Cài đặt kiểu iOS (nay nằm ở *Màn hình & Độ sáng → Hình ảnh*).

## V2.9.207
- **Sửa lỗi tab Điều khiển đứng hình sau vài giây** (mọi màn): WebSocket bị đóng giữa chừng mà trang chỉ
  chuyển sang MJPEG khi *chưa* có khung nào → đang xem thì đứng im, thao tác như không được nhận.
  Nay trang có **watchdog 1,5 s** + **tự nối lại** (giữ khung cuối trong lúc nối).
- Server: **một vòng chụp khung cho mỗi thiết bị, chia cho mọi người xem** (trước đây mỗi tab mở một vòng
  riêng, mở 2 tab là tranh CPU và tụt nhịp). Đo: 2 client cùng 18 fps, độ trễ chạm 7–10 ms.

## V2.9.206
- **Sunton 800×480 (S3): fps khi phát video 4 → 16,5–17,4** — thiết bị `half_scale_video` được ép **nửa khung
  (400×240) khi tab YouTube / YouTube TV / IPTV đang phát**, UI tĩnh vẫn gửi khung đầy đủ 800×480 (nét).
  Trước đây nửa khung bật/tắt xen kẽ vì phụ thuộc ngưỡng fps mà S3 không bao giờ đạt.
- Thêm trần chất lượng khi phát video: `{"videoQCap": 40}` trong `/data/rwv-tuning.json` (mặc định 40).
- `/metrics` thêm **`backlogBytes`** (ứ đọng khung) và **`audioPackets`** (số gói âm thanh) để đo sức khỏe.
- Đo A/B `esp_new_jpeg` (không đổi fps, tốn thêm RAM) → không dùng.

## V2.9.205
- Chất lượng đặt tay: **khoá chất lượng nhưng nhịp khung vẫn để bộ điều tiết tự lo** (nghẽn thì giãn nhịp,
  hết nghẽn thì rút lại) — trước đó bỏ qua cả vòng điều tiết nên nhịp đứng im, dễ giật khi mạng yếu.

## V2.9.204
- Sửa lỗi: đổi **Chất lượng hình ảnh** trong Cài đặt báo "Không đổi được cài đặt" — trang gửi **nhãn chữ**
  ("60%", "Tự động") còn server đọc như số. Giờ nhận cả nhãn và số.

## V2.9.203
- Cài đặt **Chất lượng hình ảnh**: thêm lựa chọn **"Tự động"** (giá trị 0) — bỏ mức đặt tay, trả lại bộ điều tiết
  thích nghi (server tự cân theo băng thông và thời gian giải mã).

## V2.9.202
- Dashboard → **Cài đặt từng màn hình**: thêm nhóm **"Chất lượng hình ảnh"** ở trên cùng (trước "Màn hình & Độ sáng"),
  chọn 20–90%. Đổi là áp dụng **ngay** phía server (không nối lại WebSocket, không tải lại trang), lưu vào
  `rwv-panel-prefs.json` nên nhớ sau khi khởi động lại. Khi người dùng đặt mức, bộ điều tiết tự động *không* ghi đè.

## V2.9.201
- Dashboard → Trang chủ: thẻ rút gọn mỗi màn có thêm nút **Điều khiển** (icon màn hình, góc phải) — mở thẳng
  tab điều khiển của màn đó, không cần vào trang Màn hình.

## V2.9.200
- Control: ưu tiên **WebSocket** (nhanh nhất, đi qua ingress HA), tự chuyển MJPEG rồi mới tới chụp ảnh nếu
  không nhận được khung. Nhãn đầu trang hiện rõ `WS` / `MJPEG` / `HTTP`.

## V2.9.199
- Control: khung hình chuyển sang **MJPEG** (`GET /control/stream`) — trình duyệt tự vẽ từng khung, không
  cần WebSocket nên qua ingress HA ổn định: **~17 fps** (trước 3–4 fps). Vẫn giữ `GET /control/frame`
  làm dự phòng khi MJPEG không nhận được khung sau 5 giây. Nhãn trên đầu trang hiện rõ `MJPEG`/`HTTP`.

## V2.9.198
- Control: khung hình mượt hơn nhờ **CDP screencast qua WebSocket** (tới ~14 fps thay vì ~4 fps khi chụp
  từng ảnh; vẫn tự quay lại cách chụp ảnh nếu WebSocket lỗi).
- Control: thêm **3 phím điều hướng** dưới cùng — Trở lại / Màn hình chính / Gần đây (như phím Android),
  để không phải vuốt từ mép (trùng cử chỉ vuốt của điện thoại). Khung hình thu nhỏ chừa lề, không chạm mép.

## V2.9.197
- Dashboard → Màn hình: thêm nút **"Điều khiển"** trong thẻ *Thao tác nhanh*. Mở tab điều khiển riêng:
  xem màn hình liên tục (~5 fps, thay cho ảnh xem trước 4 giây) và **chạm / vuốt / kéo-thả** trực tiếp
  lên khung hình — thao tác được gửi xuống đúng tab Chromium của màn hình. Kèm nút "Màn hình chính",
  "Đánh thức", "Tải lại", "Tạm dừng". Bản đầu cho ESP32-P4, các màn khác dùng cùng một trang theo `?dev=`.

## V2.9.196
- Dashboard → IPTV: thêm nút **"Mặc định"** cạnh "Tải lại kênh" (bấm 2 lần để xác nhận) — khôi phục 5 danh sách
  mặc định + 8 kênh yêu thích. Trước đó nút này chỉ có trong app IPTV trên panel.

## V2.9.195
- IPTV: nút **"Mặc định"** trong màn hình Danh sách kênh + `POST /iptv/reset` — khôi phục 5 danh sách mặc định
  và 8 kênh yêu thích (bấm 2 lần để xác nhận, giữ nguyên lịch sử "Gần đây").

## V2.9.194
- IPTV: **5 danh sách mặc định** có sẵn khi cài add-on lần đầu (VMTTV 538 kênh bật sẵn, TV tổng hợp, Viettel,
  Sport quốc tế, iptv-org VN) + 8 kênh yêu thích mặc định. File `/data/rwv-iptv.json` vẫn được ưu tiên nếu đã có.

## V2.9.193
- Mở rộng dải mép cả 4 phía (~1,6 lần): trên 30 px, dưới 38 px, trái/phải 34 px (tỉ lệ theo màn hình) — dễ vuốt hơn khi có vỏ nhựa.
- Thanh trạng thái **bám theo ngón tay** cả khi kéo xuống lẫn kéo lên (thu lại theo tay), mọi chế độ chuyển động.

## V2.9.192
- Tắt **overscroll history navigation** của Chromium (`--overscroll-history-navigation=0`,
  `--disable-features=...OverscrollHistoryNavigation`): hết hiện tượng vuốt ngang trong vùng mép làm trang
  nhảy về `about:blank` (màn hình trắng chỉ còn thanh trạng thái) trên mọi app và mọi panel.

## V2.9.191
- `duration: 0` = **không tự thu gọn** thông báo; chạm vào màn hình (nền hoặc thẻ) để đóng.

## V2.9.190
- `POST /notify` nhận thêm `duration` (giây, 1–600): thời gian hiển thị thông báo trước khi thu gọn (mặc định 10 s).
- `GET /devices`: danh sách màn hình đang kết nối (bỏ qua chuông cửa) để tích hợp Home Assistant dựng dropdown tự động.

## V2.9.189
- **Thông báo có ảnh / video / âm thanh** qua `POST /notify` (thêm `video`, `audio`; `image` nhận cả đường dẫn nội bộ):
  - `POST /notify/upload` nhận file media (tối đa 64 MB), `GET /notify/media/<tên>` trả lại file cho panel.
  - Overlay `urgent` và thẻ thông báo phát `<video>` / `<audio>` (tự phát, có điều khiển).
- **Custom component `custom_components/dashboard_os/`** (thư mục trong repo): đăng ký `notify.dashboard_os` cho Home Assistant.
  Nhận `message`, `title` và `data: {priority, device, image, video, audio, app, url, camera}`; file local hoặc URL
  được tự động tải lên add-on trước khi gửi.

## V2.9.188
- **Thông báo ưu tiên cao `priority: "urgent"`** (dùng từ automation Home Assistant):
  - **Mở khoá** màn hình (tắt chế độ chờ) và **bật đèn nền** ngay.
  - **Phủ toàn màn hình** đè lên ứng dụng đang chạy, kể cả khi màn hình đang khoá: tiêu đề + nội dung + ảnh (nếu có) cỡ lớn.
  - Sau **6 giây** (hoặc khi bấm) tự **thu gọn** thành thông báo nhỏ như hiện tại; vẫn lưu trong lịch sử thông báo.
  - Không phụ thuộc DND; vẫn gửi qua `POST /notify` (thêm `"priority": "urgent"`).
- `urgent` có nút **Mở** (mở app/URL đính kèm) và **Đóng**.

## V2.9.187
- **Watchdog luồng camera**: `av_stream`/encoder của panel có thể treo lúc chạy (camera vẫn chụp ảnh nhưng H.264 ra 0 byte).
  Khi đó Frigate mất nguồn ghi và app Camera trên panel mất hình xem trước — cả hai dùng chung một luồng qua `/cam/live`.
  - Nếu cùng một màn hình mất luồng **3 lần trong 3 phút**, add-on tự bấm nút **Khởi động lại** của panel qua Home Assistant
    (nghỉ 10 phút giữa hai lần để tránh vòng lặp).
  - Log: `[cam-live] <id>: N lan mat luong trong 180s -> khoi dong lai panel`.
- Đồng bộ `package.json` / `package-lock.json` = 2.9.187.

## V2.9.186
- **Đổi tên hiển thị** add-on và kho: "Remote WebView Server" → **"Dashboard OS Server"** (slug `remote_webview_server` giữ nguyên,
  dữ liệu add-on không đổi). Kho GitHub mới: `minhquanghp86/DarboardOS-Server`
  (kho cũ `HA-Dashboard-Server` đã ngừng dùng).
- Đồng bộ `package.json` / `package-lock.json` = 2.9.186.

## V2.9.185
- **Sửa lỗi tab "Tin nhắn" trong sidebar HA**: ảnh/video bị co bẹp dần khi có nhiều tin (điện thoại bẹp thành "2 vạch",
  máy tính bị cắt thành dải ngang).
  - **Gốc rễ**: `.msgs` (danh sách tin) là flex-column nhưng thiếu `flex-shrink: 0`, nên khi nội dung vượt chiều cao thì
    flex **nén item** thay vì để khung cuộn. Tin chữ không co được (có `line-height`), còn ảnh/media co được nên bẹp dần.
  - **Sửa**: `.bub { flex: 0 0 auto }` + `.msgs > * { flex: 0 0 auto }` → khung cuộn, ảnh giữ nguyên kích thước.
  - Kèm: đặt sẵn `width`/`height` gốc của media (từ `w`/`h`) để trình duyệt biết tỷ lệ ngay khi ảnh chưa tải xong; bỏ
    `loading="lazy"` (iframe sidebar không kích hoạt lazy-load); khung media rộng `min(560px, 100vw - 24px)` +
    `object-fit: contain` (không cắt ảnh).
  - **2.9.176 → 2.9.184 là các bước thử trung gian** (đầu tiên sửa nhầm `chat.html`, rồi chỉnh dần `launcher-config.html`);
    **2.9.185 mới là bản đúng gốc**. `chat.html` (app "Tin nhắn" trên màn P4) đã **hoàn nguyên** về bản gốc — app trên P4
    vốn không bị lỗi này.
- Đồng bộ phiên bản: `package.json` / `package-lock.json` lên **2.9.185** (trước đó lệch ở 2.9.175 làm đỏ `src/version.test.ts`).
- Rà soát lại tài liệu (README.md, DOCS.md): phiên bản + tag firmware, tên/mặc định ứng dụng trong menu, bảng giao thức
  WebSocket (thêm `MicFrame` loại 13), bảng tuỳ chọn add-on, bảng cổng (56790 là TCP), tham số kết nối, danh sách tệp
  `/data`, `NET_HALF_HOLD_MS` (60 s), vị trí chuông cổng (trang chủ Dashboard), số lượng test.

## V2.9.175
- **Chuông cửa hiện ở TRANG CHÍNH Dashboard** (sửa lại vị trí của 2.9.174 — KHÔNG đặt trong app "Màn hình"):
  - Dòng tổng thành "**N màn hình đang kết nối & M Chuông cửa.**"; phần chuông chỉ xuất hiện khi hệ thống **đã từng** có chuông.
  - Thẻ chuông nằm cùng các thẻ màn, lưới **2 cột** (3 màn + 1 chuông = 2 hàng, căn đều, vừa màn hình).
  - Chuông **đã từng kết nối** vẫn hiện thẻ khi đang offline (lưu id/tên/IP vào `/data/rwv-door.json`, khoá `known`).
  - Thẻ: tên + trạng thái, camera cổng, nói chuyện 2 chiều, số cuộc nhỡ, ngày bấm gần nhất; chạm thẻ → nhật ký chuông.
  - Bỏ thẻ chuông khỏi trang "Màn hình" (đã thêm nhầm ở 2.9.174); `GET /screens/list` vẫn trả `doors` để trang chủ dùng.

## V2.9.174
- **Dashboard → "Màn hình": chuông cổng là một thiết bị của hệ thống** (hiển thị cùng các màn): `GET /screens/list` trả thêm
  `doors`; trang hiện thẻ chuông với **ID để chép** (`esp32-<MAC>` — dùng cho automation Home Assistant), IP, cổng
  MJPEG/ảnh, có mic/loa hay không, các màn được đổ chuông, trạng thái (trực tuyến / đang đổ chuông / đang nói chuyện),
  thống kê **nhật ký 30 ngày** (nhỡ / đã nghe / từ chối) + lần bấm gần nhất, **xem trước trực tiếp** (dùng chung một kết
  nối camera với Frigate/trang chuông) và lối mở nhật ký.

## V2.9.173
- **Hình chuông cổng cho Frigate / Home Assistant qua HTTP** (MJPEG): `GET http://172.30.32.1:18080/door/video/<ID chuông>`
  — chỉ nhận từ mạng nội bộ, **dùng chung một kết nối** với trang chuông trên màn hình (`/call/video`). Nhờ vậy camera
  ESPHome (chỉ phục vụ **1 luồng**) không bị tranh chấp khi vừa có người bấm chuông vừa chạy Frigate detect/record.
  Cấu hình Frigate: `ffmpeg.inputs.path: http://172.30.32.1:18080/door/video/<ID chuông>` (xem DOCS).
- **`POST /doorbell` thêm `mode`** (`mse` mặc định, hoặc `mjpeg`): camera cổng là ESPHome MJPEG
  (`esp32_camera_web_server`) thì đặt `mjpeg` — màn hình hiện hình ngay, không bắt go2rtc chạy ffmpeg chuyển H.264.
- Người xem vào giữa luồng MJPEG của chuông nhận ngay **khung hình cuối** (không phải chờ khung kế tiếp).

## V2.9.172
- Ứng dụng **Màn hình** → chi tiết một màn: hiện **ID màn hình** (`esp32-<mac>`), chạm để chép — dùng cho trường `device` của
  `POST /doorbell` / automation Home Assistant (trước đây phải tự dò).
- Sửa tài liệu (DOCS): ví dụ "hiện camera khi có người" nay dùng `rest_command` + `/doorbell`; ví dụ cũ đặt "URL hiển thị" bằng địa chỉ LAN
  không còn chạy (trình duyệt của màn nằm trong add-on, địa chỉ LAN bị chặn).

## V2.9.171
- Cài đặt chuông cổng: **chọn một hoặc nhiều màn bất kỳ** để đổ chuông — kể cả màn **không có loa / camera** (vẫn hiện trang chuông, xem hình
  và mở cổng; chỉ không nói chuyện được). Trước đây danh sách chỉ liệt kê màn có loa hoặc camera (thực tế chỉ P4). Màn đã chọn nhưng
  đang ngoại tuyến vẫn hiện (đánh dấu) để bỏ chọn; các màn chọn đều ngoại tuyến thì đổ chuông mọi màn đang kết nối. Không chọn = mọi màn.
- Sửa: màn hình chờ **S3 480×480** (và màn nhỏ khác) khi có thẻ "Cuộc gọi nhỡ" + hai hàng năng lượng + thời tiết + camera: nội dung cao hơn
  màn nên đồng hồ bị đẩy lên mất gần một nửa — nay thu nhỏ cả khối cho vừa màn (không phóng to; khung ảnh nền không đổi).

## V2.9.170
- Sửa: nút **‹ Trang chủ** ở Màn hình / Chuông cổng / Gọi làm trình duyệt **tải về tệp "Tải xuống" 2 byte** và không về được trang chủ
  (liên kết `./` trỏ vào gốc ingress, nơi chỉ trả "ok"). Nay trỏ `launcher-config.html`; gốc ingress cũng trả trang chủ.
- Sửa: ảnh / video trong cuộc trò chuyện **Tin nhắn** bị co nhỏ (140–300 px) — khung dùng chiều rộng theo phần trăm của khung co theo nội
  dung, ảnh tải chậm chưa có kích thước → về 0. Nay chiều rộng xác định (tối đa 380 px) và có chiều cao tối thiểu.
- Bảo mật: chuỗi token Telegram giả trong bài kiểm tích hợp ghép lúc chạy (GitHub secret scanning báo nhầm). Token thật trong lịch sử cũ
  (Telegram, Google) đã được thu hồi và xác minh vô hiệu.

## V2.9.169
- Mới: **thông báo Telegram** — chuông cổng nhỡ, chuông cổng bị từ chối, mỗi lần bấm chuông (kèm ảnh khách) và cuộc gọi video nhỡ, có
  thời gian + tên chuông / người gọi. Add-on gửi thẳng Telegram Bot API (không cần tích hợp Telegram của HA). Cài trong Dashboard → Gọi → ⚙:
  token bot, chat ID (nút **Tìm chat ID**), chọn sự kiện, **Gửi thử**. Token không trả về trang, không ghi log; lỗi tạm thời thử lại.

## V2.9.168
- Nút giữa (Home) giữ ≥ 2 s: vào thẳng Frigate, **đóng bàn phím ảo / bỏ chọn ô nhập** của trang đang mở trước khi chuyển (không còn
  bàn phím nằm lại).

## V2.9.167
- Mới: **nút bấm vật lý** màn S3 480×272 (firmware `fw-2026.10.23`): nút trái / phải = bài (kênh) trước / sau của trình phát đang
  chạy, giữ nút giữa ≥ 2 s = mở ứng dụng Frigate (nút giữa nhấn = về Home như trước). Thay chế độ xem camera cũ bằng go2rtc.
  Sự kiện `DeviceEvent` loại `Button` (4); thử tích hợp `buttons.itest.ts`.

## V2.9.166
- Bảo mật: nâng **ws** 8.22 (sửa lỗ hổng cạn bộ nhớ / lộ bộ nhớ chưa khởi tạo của máy chủ WebSocket) và **sharp** 0.35.5
  (libvips, libheif, librsvg có lỗ hổng đã công bố — ảnh người dùng tải lên Tin nhắn / khung ảnh đi qua sharp). `npm audit`:
  0 lỗ hổng ở phần chạy thật.
- Kiểm thử: sửa 4 bài tích hợp bị cũ (màn hình chờ, khung ảnh, cài đặt) và thêm bài kiểm cho ứng dụng **Màn hình**
  (`screens.itest.ts`). Nay toàn bộ bài tích hợp đạt.

## V2.9.165
- Màn hình / trang chủ Dashboard: mọi màn đang hiện màn hình chờ đều ghi **"Màn hình chờ"**; việc có khóa hay không là thông tin
  phụ riêng ("Có khóa · vuốt lên để mở" / "Không khóa · chạm để mở"). Trước đây màn bật "Khóa màn hình" hiện "Đã khóa" còn màn tắt
  hiện "Màn hình chờ" dù cả hai đang ở cùng một màn hình chờ.

## V2.9.164
- Giấy phép (không đổi chức năng): giữ Apache-2.0 + MIT nhưng siết chặt — mọi file mã nguồn có tiêu đề SPDX (kiểm bằng
  `npm run check:spdx`); ảnh Docker kèm `LICENSE`, `NOTICE`, `THIRD-PARTY-NOTICES.md` trong `/licenses` và nhãn giấy phép;
  `NOTICE` viết lại đầy đủ; thêm `THIRD-PARTY-NOTICES.md` (22 thư viện kèm toàn văn giấy phép, sinh bằng `npm run licenses`),
  `TRADEMARKS.md` (tên / logo "Dashboard" không cấp phép cho bản fork), `CONTRIBUTING.md`.
- Ghi rõ **âm lịch** (`public/lunar.js`, thuật toán của Hồ Ngọc Đức) chỉ được dùng **cá nhân, phi thương mại**, không thuộc Apache-2.0.

## V2.9.163
- Màn hình / trang chủ Dashboard: màn không lắp pin (P4) hiện **Cắm nguồn · không lắp pin** (trước đây không hiện gì về
  nguồn); màn có pin hiện thêm trạng thái "sạc" / "cắm nguồn" cạnh %.

## V2.9.162
- Màn hình → Ứng dụng: chạm biểu tượng trong "Mở ứng dụng" giờ hỏi xác nhận ("Mở … ?") trước khi mở trên màn — tránh chạm
  nhầm làm đổi màn người khác đang dùng.

## V2.9.161
- Mới: ứng dụng **Màn hình** trên trang Dashboard — điều khiển và cài đặt từng màn từ xa, không cần chạm vào màn. Ảnh màn
  đang hiển thị; 5 nhóm Tổng quan / Điều khiển / Ứng dụng / Thông báo / Cài đặt: trạng thái (mạng, pin, độ sáng, âm lượng,
  ứng dụng, thông báo, cuộc gọi nhỡ, có người), đánh thức / màn hình chờ / khóa / về màn chính / về HA / tải lại / khởi động
  lại, độ sáng, âm lượng phát / thông báo / báo thức, Không làm phiền, trình phát (phát, tạm dừng, ±10 s, kênh trước / sau,
  dừng — cả ứng dụng phát nền), mở / đóng ứng dụng, mở trang web, gửi thông báo, đọc to, mọi cài đặt của màn.
- Trang chủ Dashboard: thẻ rút gọn từng màn ở đầu trang (chạm để mở chi tiết).
- Cài đặt chuông cổng: thời gian đổ chuông chọn nhanh 5/10/20/30/50/70/90/100 s hoặc nhập số giây (5–300); mở khóa cổng
  chọn nhanh hoặc nhập (1–120 s).
- Radio: điều khiển từ xa phát tiếp kênh cuối, chuyển kênh trước / sau; tên kênh hiện ở trình phát.
- Sửa: sau khi add-on khởi động lại (cập nhật), màn đang dùng bị kẹt ở "Độ sáng khi khóa" (vd P4 5%) tới lần màn hình chờ
  kế tiếp — nay trả lại độ sáng ngay.

## V2.9.160
- Sửa: ứng dụng **Chuông cổng** trên màn hẹp — S3 480×480: dải lọc (Tất cả / Nhỡ / …) đè lên tiêu đề, chữ "Lưu 30 ngày"
  bị bẻ dọc; nay tiêu đề một hàng, dải lọc xuống hàng riêng. S3 480×272: gọn một hàng (dải lọc cuộn ngang). Ảnh thu nhỏ
  hẹp: ngày giờ và nhãn không gãy dòng.

## V2.9.159
- Chuông cổng (trang Dashboard): "‹ Trang chủ" + biểu tượng + tên nằm trên hàng tiêu đề như các mục khác (trước nổi đè lên
  tiêu đề và lên tiêu đề ảnh đang xem); ảnh thu nhỏ có thêm ngày / tháng ("16/10 07:10").
- Gọi: thanh trên "‹ Trang chủ" + biểu tượng + "Cuộc gọi"; nút cài đặt chuông cổng thành biểu tượng bánh răng.

## V2.9.158
- IPTV (trang Dashboard): hàng thẻ trạng thái từng màn hình ở đầu trang — Đang phát (kênh gì) / Đang mở / IPTV chạy nền /
  Không phát — kèm nút **Dừng** (đóng IPTV trên màn, về màn chính) và **Màn chính** (IPTV vào nền). Tự làm mới 3 s. Trước:
  phát lên màn rồi không dừng được từ trang này.

## V2.9.157
- Trang Dashboard — thiết kế lại, giai đoạn 2:
  - Màn khóa: ô "Xem trước màn khóa" (6 chỉ số đúng như trên màn, số liệu trực tiếp); cảm biến năng lượng thành danh sách gọn
    theo đúng thứ tự 6 chỉ số (biểu tượng, tên cảm biến, giá trị) — bấm một dòng để đổi cảm biến.
  - Menu ứng dụng: ô "Xem trước menu trên màn" (lưới biểu tượng theo nhóm, chỉ ứng dụng đang bật; bấm để sửa); nút Sửa thành
    biểu tượng bút chì.
  - Chuông cổng / Gọi: nút "‹ Trang chủ" không đè tiêu đề. Tiêu đề thẻ không còn xuống dòng chồng lên nút trên điện thoại.
- IPTV: "Tải lại kênh" (và bật / tắt / thêm danh sách) nay làm mới cả lưới kênh — trước chỉ cập nhật số đếm ở phần danh sách.
- Menu ứng dụng không tải được: hiện lý do.

## V2.9.156
- Trang Dashboard (thanh bên Home Assistant) — THIẾT KẾ LẠI, giai đoạn 1:
  - Trang chủ dạng biểu tượng ứng dụng như điện thoại (Tin nhắn có huy hiệu số tin chưa đọc, IPTV, Quản lý file, Màn khóa,
    Chuông cổng, Gọi, Menu ứng dụng) + danh sách màn hình đang kết nối. Mỗi ứng dụng có nút "‹ Trang chủ" ở thanh trên.
  - IPTV: ô tìm kênh luôn ở trên; chip Yêu thích / Gần đây / Tất cả / từng danh sách + chọn nhóm; lưới thẻ kênh (logo, ngôi
    sao yêu thích); chạm thẻ = chọn màn để phát hoặc "Xem trong trình duyệt". Quản lý danh sách M3U chỉ mở khi bấm
    "Danh sách kênh". Mới: "Gần đây" — kênh phát từ Dashboard và kênh xem trên màn.
- Quản lý file: chỉ liệt kê màn ĐANG có thẻ nhớ (trước: cả màn đã rút thẻ); màn đang xem vừa rút thẻ thì tự chuyển sang màn
  còn thẻ; chỉ một màn thì ghi tên màn cạnh "Thẻ SD".

## V2.9.155
- Cắm / rút sạc hiện trên thanh trạng thái nhanh hơn: thực thể "Nguồn điện" đọc riêng mỗi 2 s (pin % / mạng vẫn 10 s). Cùng
  firmware mới (battery_monitor.h: nhận cắm / rút trong ~2–3 s, phát lên HA ngay) — tổng ~3–5 s.

## V2.9.154
- Pin / nguồn kiểu điện thoại trên thanh trạng thái (giọt nước trên cùng + góc phải màn hình chờ): đang sạc = pin xanh lá có
  tia sét; cắm nguồn, đã đầy = pin xanh lá + phích cắm; đang dùng pin = pin thường (đỏ khi ≤ 20 %); không có pin = chỉ
  phích cắm (không còn báo % ảo). Đọc thực thể "Nguồn điện" của firmware (YAML mẫu P4 / S3 480×272 kèm battery_monitor.h —
  tự phát hiện có pin, cắm / rút nguồn). Màn chưa có thực thể này: hiển thị như cũ.
- Pin / mạng / nguồn đọc lại mỗi 10 s (trước 30 s).

## V2.9.153
- Màn hình chờ / khoá (cả 3 màn): góc trên bên phải có thanh trạng thái kiểu điện thoại — tin nhắn / thông báo / báo thức
  (biểu tượng + số, chạm để mở), mạng (Wi-Fi theo vạch hoặc cáp), pin của màn (nếu có). Chip "N thông báo" giữa màn bỏ đi.
- Sự kiện camera Frigate trên màn hình chờ: hỏi Frigate mỗi 4 s khi có màn đang chờ / khoá (trước 20 s) — hiện trong ~5 s.
- S3 480×272: thẻ thời tiết lên sát dưới thanh trạng thái, bên dưới hiện dòng camera / lịch (trước bị ẩn).
- Thẻ "Cuộc gọi nhỡ" giãn hết bề ngang cột (màn vuông).

## V2.9.152
- Màn hình chờ / khoá trên màn NGANG (P4): dòng camera / lịch chuyển sang cột phải, ngay dưới thẻ thời tiết (trước chen dưới
  dải năng lượng bên trái — cột trái quá cao, cột phải trống); có chỗ nên hiện tối đa 4 sự kiện lịch. Màn vuông (S3 480×480)
  giữ thứ tự cũ; S3 480×272 không đổi.

## V2.9.151
- Màn hình chờ / khoá: dải năng lượng nay có 6 chỉ số, xếp lưới 3 × 2 — PV hôm nay · Công suất PV · Tải hôm nay · Tiêu thụ
  lưới · Tiêu thụ tải · Pin % (đang sạc / xả bao nhiêu). Thiếu cảm biến nào thì bỏ ô đó.
- Trang Dashboard → Màn khoá: thêm ô chọn cảm biến "Điện tải hôm nay" (kWh, tự về 0 lúc nửa đêm — vd Hòa lưới hôm nay).
- Màn ngang có thẻ "Cuộc gọi nhỡ": đồng hồ nhỏ lại để không bị cắt mép trên (P4).

## V2.9.150
- Sửa: màn đang ở MÀN HÌNH CHỜ (không khoá) — bấm Từ chối / hết chuông cổng thì về trang Home Assistant và phải chờ hết thời
  gian rảnh mới hiện lại màn hình chờ (gặp trên S3 480×272). Nay hiện lại màn hình chờ ngay, như màn khoá.
- Mới: CUỘC GỌI NHỠ (chuông cổng hoặc gọi giữa các màn) hiện thẻ đỏ lớn "Cuộc gọi nhỡ" trên màn hình chờ / khoá, kèm ảnh
  khách ở cổng; màn hình chờ KHÔNG bị tắt nữa. Chạm thẻ = mở Nhật ký chuông / Gọi đúng cuộc gọi đó (màn khoá: sau khi vuốt
  mở). Thẻ mất khi đã xem (chạm thẻ hoặc mở thanh thông báo), tự ẩn sau 12 giờ.
- Sửa: màn hình chờ trên màn ngang thấp (S3 480×272) có ảnh nền + thẻ thời tiết — dải năng lượng (mặt trời / pin / tiêu thụ)
  đè lên thẻ thời tiết. Nay cột trái co theo chỗ còn lại, ba ô năng lượng chia đều.

## V2.9.149
- Sửa: giờ của tệp trên thẻ nhớ lệch +7 giờ (vd tệp chép lúc 18:02 hiện "Thứ sáu 16/10 01:02") ở Thư viện / Tệp trên màn
  và Quản lý file trên trang Dashboard. Firmware trả giờ của tệp theo giờ địa phương; trang trước đây đổi múi giờ thêm một
  lần. Ảnh/video quay bằng Camera P4 không bị (giờ lấy từ tên tệp). Đã thử với thẻ nhớ trên S3 480×480.

## V2.9.148
- YouTube toàn màn hình trên P4 bớt tụt fps: khi đường truyền nghẽn, máy chủ giữ khung nửa độ phân giải 60 s (trước 15 s)
  và KHÔNG giãn nhịp trong 8 s đầu (khung nửa đã giảm 4 lần dung lượng, tự xả được tồn đọng; giãn nhịp thì mất ~50 s
  mới hồi). Đo A/B xen kẽ 3+3 lượt 150 s trên P4 cáp: trước 8/3/0 mẫu dưới 22 fps, thấp nhất 16–19 fps; sau 0/0/0, thấp
  nhất 28–30 fps (ngoài quảng cáo). Chỉ màn có khung nửa khi nghẽn (P4); S3 không đổi. Chỉnh nóng: `netHalfHoldMs`,
  `halfGraceMs` trong `/data/rwv-tuning.json`.

## V2.9.147
- Sửa tiếp 2.9.146: Chrome trên máy chủ không báo "trang hiện lại" khi đổi ứng dụng, nên Thư viện không biết để đọc lại
  thẻ. Nay máy chủ báo trang mỗi lần ứng dụng được mở lại: Thư viện đọc lại thẻ (thấy ngay ảnh/video vừa chụp ở Camera),
  tệp đang xem đã bị xoá thì đóng trình xem. Đã thử trên P4.

## V2.9.146
- Sửa: Thư viện để trình xem video mở, rồi tệp bị xoá (ở trang Dashboard hoặc nơi khác) — mở lại ứng dụng thấy video báo
  lỗi "Format error" và đứng im. Nay khi mở lại, Thư viện đọc lại thẻ: tệp không còn thì đóng trình xem, về lưới và báo
  "Tệp đã bị xoá".
- Firmware mới nhất: **fw-2026.10.19** (P4: thêm ~18 KB RAM trong, đáy RAM khi quay 14–22 KB → 36 KB).

## V2.9.145
- Sửa: rời một ứng dụng đang phát video (vd IPTV) để sang ứng dụng khác đôi khi KHÔNG đóng băng tab cũ — video tiếp tục
  phát ngầm trong máy chủ (tốn CPU). Nguyên nhân: tab cũ được đóng băng trước khi chuyển tab xong. Đo trên S3: 3/3 lần
  đóng băng đúng (trước: video vẫn chạy).

## V2.9.144
- Xoá thư mục trên thẻ nhớ (Quản lý file trên trang Dashboard, ứng dụng Tệp trên màn): gửi xác nhận `dir=1` sau khi người
  dùng đã đồng ý — firmware **fw-2026.10.17** trở lên từ chối xoá thư mục nếu thiếu xác nhận (chốt an toàn chống xoá nhầm
  cả thư mục). Firmware cũ bỏ qua tham số này.

## V2.9.143
- Màn hình khoá / màn hình chờ: tạm dừng hoạt ảnh của trang bên dưới (SVG kể cả `<svg>` lồng, CSS / Web Animations),
  mở khoá thì chạy lại. Trước đây trang có hoạt ảnh (vd thẻ dòng điện mặt trời) khiến màn KHOÁ vẫn nhận ~29 khung/giây
  (~670 KB/s, màn liên tục giải mã); nay 0 khung/giây khi khoá (đo trên P4).

## V2.9.142
- Hướng dẫn (trang Tài liệu của addon): mục **"Liên lạc: chuông cổng và gọi video"** — chuông cổng, nhật ký, gọi video,
  nhạc chuông, sự kiện `dashboard_doorbell`, tự đổ chuông từ automation (`rest_command` → `/door/ring`).
- `/door/ring` nhận thêm yêu cầu từ mạng nội bộ Home Assistant (addon khác, vd Node-RED).

## V2.9.141
- **Liên lạc (cần firmware fw-2026.10.16):**
  - **Chuông cổng ESP32-S3 CAM** (component `dashboard_door`): bấm chuông → các màn đổ chuông (nhạc chuông
    `media/audio/chuong-cua.mp3`), màn hình chuông kiểu màn chuông hình chuyên dụng: hình cổng trực tiếp, **Nói chuyện**
    (tiếng hai chiều), **Mở khóa cổng** (chạm 2 lần), Chụp ảnh, Từ chối. Hiện đè lên màn khóa, khóa lại sau chuông.
    Không ai nghe → thông báo "Cuộc gọi nhỡ ở cổng" kèm ảnh. Sự kiện HA `dashboard_doorbell`.
  - **Nhật ký chuông cổng** (ứng dụng "Chuông cổng" + tab trong Dashboard): ảnh mỗi lần bấm chuông, Nhỡ / Đã nghe /
    Từ chối / Ảnh chụp, giữ 30 ngày, chọn + xóa; chạm thông báo gọi nhỡ mở đúng ảnh.
  - **Gọi video kiểu điện thoại** giữa các màn có camera + mic và tab **"Gọi"** trong Dashboard (trình duyệt, HTTPS):
    cuộc gọi đến đè lên màn khóa (nhạc chuông `media/audio/zalo.mp3`), tắt mic / camera, máy bận, gọi nhỡ.
  - Cài đặt chuông cổng trong tab "Gọi": màn đổ chuông, thời gian đổ chuông, thời gian mở cổng.
  - Luồng camera P4 dùng chung cho Frigate + cuộc gọi (một kết nối tới P4); mọi luồng qua WebSocket (dùng được qua
    Cloudflare Tunnel, không cần TURN).
- Ứng dụng Media: tên thẻ nguồn xuống dòng trên màn hẹp.

## V2.9.140
- Sửa: màn nối lại máy chủ mở lại địa chỉ CŨ mà firmware nhớ (vd `media.html` thiếu nhận diện màn) — ứng dụng nội bộ nay
  luôn mở đúng địa chỉ hiện tại (giữ nguyên tham số khi cùng trang và cùng màn, vd Thư viện mở từ Camera).

## V2.9.139
- **Ứng dụng Media mới** (thay trang Media tiếng Anh của Home Assistant):
  - Nguồn: thư mục media của HA và thẻ nhớ của màn (bỏ thư mục DCIM — đã có Thư viện). Nguồn đã có ứng dụng riêng
    (Camera, Frigate, Radio, Ảnh…) ẩn mặc định, bật lại bằng "Mọi nguồn". Lọc Tất cả / Nhạc / Video / Ảnh.
  - Nhạc: "Phát tất cả" / "Trộn bài", hàng đợi cả thư mục, lặp lại (cả danh sách / một bài), thanh "Đang phát" thu nhỏ
    và trình phát đầy đủ, âm lượng loa của màn. **Phát nền** khi sang ứng dụng khác (thẻ "Đang phát" trên thanh trạng
    thái). **Nhớ bài và vị trí** đang nghe theo từng màn — mở lại là nghe tiếp.
  - Video toàn màn hình (tua, ±10 s, nhớ vị trí từng video). Ảnh: vuốt trước / sau, chạm đúp phóng to, trình chiếu.
  - **Phát trên loa trong nhà**: chọn loa / TV trong Home Assistant (ẩn loa của chính màn). Loa không nhận tệp
    (vd Android TV Remote) thì báo sau 12 s. Tệp trên thẻ nhớ chỉ phát tại màn.
- Sửa: mở lại một ứng dụng nội bộ đã bị đóng (thiếu RAM / khởi động lại) không còn quay về địa chỉ CŨ của ứng dụng
  (vd Media cũ của HA, thiếu nhận diện màn).
- GitHub Actions tiết kiệm phút: ảnh Docker chỉ dựng khi phát hành (main / tag); kiểm thử chỉ chạy tay. Ảnh thử dựng
  cục bộ: `scripts/anh-thu-cuc-bo.sh`.

## V2.9.138
- **IPTV: danh sách kênh mở bằng nút "Danh sách"** trên thanh trên — chạm màn hình chỉ hiện các nút như trước; bấm
  "Danh sách" mới hiện danh sách kênh bên trái, bấm lại để đóng (các nút tự ẩn thì danh sách đóng theo). Màn hẹp:
  nút chỉ có biểu tượng.

## V2.9.137
- **Âm lượng ngay trên trình phát**: trình xem video (Thư viện / Quản lý file) và trình phát IPTV có cụm **[−] 25% [+]**
  chỉnh âm lượng loa của màn (bước 5%, giống thanh âm lượng trên bảng điều khiển). Màn không có loa (S3) thì ẩn.
- **IPTV: chạm màn hình hiện danh sách kênh dọc bên trái** (số, logo, tên; kênh đang xem tô màu và nằm giữa) — chạm kênh
  để chuyển, cuộn để tìm. Danh sách theo nhóm / kết quả tìm đang chọn. Vẫn giữ nút kênh trước/sau, yêu thích, quay lại.

## V2.9.136
- **Sửa: ứng dụng Camera trên màn kẹt "Đang mở camera…"** (từ 2.9.134) — trang gọi một hàm của `ui.js` nhưng không nạp
  `ui.js`, cả trang dừng (xem trước, thẻ SD, nút chụp/quay đều chết). Nay hiện hình ngay. Nút Thư viện trong app Camera
  mở đúng thẻ của màn đó.
- Đi kèm firmware fw-2026.10.15: **quay video 10 fps** (trước 5 fps) — cảm biến chỉ tăng nhịp khi đang quay.

## V2.9.135
- **Sửa: phát IPTV lên màn (thẻ IPTV trang Dashboard) có lúc đứng hình rồi màn tự khoá** — server đang "đóng băng" tab IPTV
  ở nền đúng lúc tab được đưa lên hiển thị, nên video bị dừng. Nay mỗi bước đóng băng kiểm lại; tab vừa hiện thì huỷ
  đóng băng và phát lại. Đo S3: 4/4 lần phát lại đều chạy (trước: 2/3 lượt đứng hình).
- Trợ giúp YouTube có giới hạn thời gian + không chồng lượt (tab YouTube treo không còn dồn lời gọi).
- Bớt log nhiễu khi đóng băng tab vừa bị đóng.
- (Thử nghiệm, mặc định TẮT) bộ điều tiết Wi-Fi: `probeFloorTtlMs` trong `/data/rwv-tuning.json` cho ngưỡng tránh nghẽn do
  mạng tự hết hạn — chưa đủ số đo để bật mặc định.

## V2.9.134
- **Trang hệ thống của panel dùng đường dẫn tương đối theo `location`** — `ui.css` / `ui.js` / `icons.js` / `lunar.js` và mọi
  lời gọi máy chủ (`/api/...`, `/ha/...`, `/frigate/...`, `/alarm/...`, `/cam.html`, `/go2rtc/`, …) nay tự gắn gốc của trang
  (`ui.js` bọc `window.fetch` + thêm hàm `window.rwvRel`; `camera.html`, `cam.html`, `doorbell.html` tự gắn gốc). Nhờ vậy mở
  các trang này trong tab Trình duyệt từ trang Dashboard (đường dẫn ingress `/api/hassio_ingress/<token>/`) không còn
  **trắng trang / không tải được dữ liệu** — cùng họ lỗi đã sửa cho `iptv.html` ở 2.9.133. Trên panel (gốc `/`) hành vi
  không đổi; đã kiểm chứng trên máy thật (S3 480×480: trang Tệp hiển thị đúng thẻ SD + dữ liệu).

## V2.9.133
- **Thẻ IPTV (trang Dashboard) có danh sách kênh + 2 nút cho mỗi kênh** (trước đây thẻ chỉ quản lý danh sách M3U):
  - **Phát trên màn hình** (icon *cast*): hiện danh sách màn đang kết nối để chọn **một màn** hoặc **Tất cả màn hình** →
    máy chủ tự mở ứng dụng IPTV của màn đó và phát kênh (`iptv.html?dev=<id>&play=<kênh>`), log
    `[iptv] phat "<kênh>" tren N man: …`. Màn không kết nối thì báo rõ, không gửi.
  - **Phát trong trình duyệt** (icon *play*): mở trang phát `iptv.html?play=<kênh>` ở tab mới để xem ngay trên máy tính.
  - Thêm ô **chọn danh sách** + **ô tìm kênh**; hiện 200 kênh mỗi lần, có nút “Hiện thêm”.
- Trang phát `iptv.html` nay dùng **đường dẫn tương đối theo `location`** (`ui.css`, `ui.js`, `icons.js`, mọi API `/iptv/...`,
  thư viện `/vendor/...`) và **đoạn phim trong playlist HLS được viết lại thành tương đối** (`p?...`) — nhờ vậy trang phát
  chạy được cả khi mở trong tab Trình duyệt từ trang Dashboard (đường dẫn ingress `/api/hassio_ingress/<token>/`). Trước đây
  mở ở tab mới thì trắng trang, hoặc kẹt ở “Đang mở …” với kênh HLS.
- Proxy luồng `/iptv/p` và `/iptv/probe` nay chấp nhận cả **trang Dashboard (ingress — đã xác thực Home Assistant)**, vẫn
  **bắt buộc mã phiên**, để nút “Phát trong trình duyệt” xem được cả kênh cần header Referer/User-Agent.

## V2.9.132
- **Trợ giúp YouTube (khôi phục + cải tiến từ 2.9.130, phần Wi-Fi vẫn để nguyên đã hoàn tác):** trên tab YouTube / YouTube TV
  đang hiện, server kiểm mỗi 1,5 s và **tự bỏ qua quảng cáo** (bấm “Bỏ qua” nếu có, đồng thời tua quảng cáo tới cuối cho
  quảng cáo không có nút) và **tự chọn “Xem ở chế độ khách”** trên YouTube TV khi hỏi tài khoản (chạm thật qua CDP).
- Hai tuỳ chọn mới trong **Cài đặt → YouTube** cho từng màn hình, **mặc định BẬT**: “Tự bỏ qua quảng cáo YouTube”,
  “YouTube TV: chế độ khách”. Tắt được riêng từng màn hình.

## V2.9.131
- **Trả về như 2.9.129** (bỏ thay đổi của 2.9.130: bộ điều tiết Wi-Fi, trợ giúp YouTube) — đo cuối 09/10 chưa ổn định, sẽ điều tra lại.

## V2.9.129
- **Màn S3 có thẻ nhớ** (firmware fw-2026.10.12, component `sd_files`, `sd_card_api_port`): màn hiện **Thư viện** và
  **Quản lý file**, đính kèm ảnh / video từ thẻ trong Tin nhắn (không có nút chụp — màn không có camera), thẻ của S3 có
  trong ô chọn màn ở thẻ Quản lý file và IPTV. Không hiện ứng dụng Camera.
- Màn mặc định (IPTV `sd:/…`, Quản lý file lần đầu) luôn là màn có camera, dù màn chỉ có thẻ kết nối trước.
- Thư viện: thẻ không có thư mục `/DCIM` thì xem ảnh / video ở gốc thẻ.

## V2.9.128
- **Quản lý file (trang Dashboard) chọn được màn hình:** nhà có từ 2 màn có thẻ nhớ thì đầu thẻ Quản lý file có ô chọn
  màn; xem / tải lên / đổi tên / xoá đều làm trên thẻ của màn đã chọn. Màn đã chọn đang tắt thì báo rõ, không ghi nhầm
  sang thẻ màn khác. Danh sách “Tải lên” ghi tên màn đích.
- **IPTV:** hộp “Chọn trên thẻ nhớ…” cũng chọn được màn; danh sách trên thẻ màn khác lưu dạng `sd@<màn>:/…`
  (dạng cũ `sd:/…` vẫn chạy như trước). Trang IPTV trên màn hình duyệt thẻ nhớ của chính màn đó.
- Tên màn hình (Tin nhắn, Báo thức, Quản lý file) có ngay sau khi add-on khởi động, không phải chờ 5 phút.

## V2.9.127
- **Nhà có nhiều màn có camera:** ứng dụng Camera, Thư viện, Quản lý file trên màn hình và Tin nhắn (gửi ảnh từ thẻ nhớ,
  chụp nhanh, ghi âm) dùng camera / thẻ nhớ **của chính màn đang dùng** (trước đây luôn màn có camera đầu tiên).
- **Bảo mật LAN:** toạ độ nhà (`/weather-location`) và danh sách camera (`/cams/list`) chỉ trả cho trình duyệt của add-on,
  máy khác trong mạng không đọc được nữa.

## V2.9.126
- **Ứng dụng Chrome** (thay "Trình duyệt"): logo Chrome, mở lại trang đang xem hoặc Google; thanh công cụ kiểu Chrome ở
  đáy màn hình — lùi / tiến / tải lại / ô địa chỉ (chạm để gõ địa chỉ hoặc từ khoá tìm Google) / trang chủ / thu gọn.
- **Google Maps:** các trang web được cấp quyền vị trí, vị trí = nhà trong Home Assistant (Cài đặt → Khu vực) → "Vị trí
  của bạn" / điểm khởi hành dùng được. Ứng dụng Google Maps mở giao diện đầy đủ (có nút Đường đi), căn giữa nhà, lớp giao thông.

## V2.9.125
- **Sửa địa chỉ ứng dụng web có sẵn** trong Dashboard → Menu panel (ô "Địa chỉ web"): YouTube, Tin tức, Solar… Để trống =
  mặc định; "Khôi phục mặc định" bỏ địa chỉ riêng. Trang hệ thống của add-on và Home Assistant (ô riêng) không đổi.
- **Solar** là ứng dụng chung, địa chỉ mặc định trống — chưa nhập thì mở trang hướng dẫn.
- **Sửa lỗi:** cấu hình Menu panel (ứng dụng ẩn, thứ tự, ứng dụng tự thêm, tên / biểu tượng đã sửa, bố cục màn hình
  chính) bị bỏ qua sau mỗi lần add-on khởi động lại cho tới khi bấm Lưu.

## V2.9.124
### Dùng được ở nhà khác (không còn gắn với hệ thống của tác giả)
- **Lịch không phụ thuộc Home Assistant:** màn hình khóa và trang "Hôm nay" lấy lịch của HA (nếu có) và **lịch Google /
  tệp .ics** — dán "Địa chỉ bí mật ở định dạng iCal" trong trang Dashboard → Màn khóa → Lịch (sự kiện lặp lại, múi giờ).
- **Camera không cần mở cổng go2rtc 1984:** các trang camera, lưới Frigate, ảnh trong thông báo đi qua add-on (`/go2rtc/`),
  add-on tự tìm go2rtc của Frigate. Ứng dụng Camera tự nhận luồng của chính màn hình (không gắn tên `p4_panel`).
- Ẩn ứng dụng "Frigate" / "Sự kiện camera" khi nhà không có Frigate. Bản đồ không còn gắn một vị trí cố định.

## V2.9.123
- **Bỏ** việc addon tự "Cấu hình lại" tích hợp ESPHome trong Home Assistant khi màn hình đổi IP (có ở 2.9.122): addon không
  sửa cấu hình tích hợp / addon khác. Đổi Cáp ↔ Wi-Fi làm IP đổi thì người dùng tự cập nhật địa chỉ trong HA (Cài đặt →
  Thiết bị & Dịch vụ → ESPHome → ⋮ → Cấu hình lại) nếu HA không tự nhận.

## V2.9.122
### Chọn mạng Cáp / Wi-Fi (P4 có cổng RJ45, cần firmware có "Mạng sử dụng")
- Cài đặt → Wi-Fi & Mạng: khối **Kết nối** kiểu laptop — Cáp mạng / Wi-Fi, dấu tích ở đường đang dùng, chạm để đổi. Cũng
  chọn được từ Home Assistant (select "Mạng sử dụng").
- Đổi đường làm IP màn hình đổi (hai cổng khác MAC): server **tự sửa địa chỉ thiết bị trong Home Assistant** (Cấu hình lại
  ESPHome) ~15 s sau khi màn hình nối lại từ IP mới; dự phòng khi HA báo mất kết nối > 60 s.
- **Luồng camera cho Frigate qua server:** `http://172.30.32.1:18080/cam/live/<id màn hình>` luôn tới IP hiện tại của màn
  hình — Frigate không mất camera khi đổi Cáp ↔ Wi-Fi. Chỉ nhận từ mạng nội bộ của Home Assistant.

## V2.9.121
- Đồng hồ trên cùng mọi trang: **pin bên trái** (mức đầy theo % còn lại, đỏ khi ≤ 20%), **mạng bên phải** (Wi-Fi 3 vạch
  theo cường độ sóng, hoặc biểu tượng cáp mạng khi dùng cổng RJ45). Màn không có cảm biến pin chỉ hiện mạng.

## V2.9.120
- Cài đặt → Wi-Fi & Mạng: thêm hàng **Kênh & chuẩn kết nối** (kênh, chuẩn Wi-Fi, cường độ, công suất phát — cần firmware P4
  mới có cảm biến "Liên kết Wi-Fi"), giúp nhận ra nhiễu cùng kênh khi video chậm.

## V2.9.119
### Mật khẩu luồng camera (P4)
- Cài đặt → Camera & Phát hiện → **Mật khẩu luồng camera**: bật / tắt, tên đăng nhập, đổi mật khẩu ngay trên màn hình
  (cần firmware fw-2026.10.07). Áp dụng cho luồng `:8080/live` và ứng dụng Camera / thẻ nhớ; máy chủ Home Assistant
  (Dashboard, Frigate cài trên HA) không cần mật khẩu.

### Sửa lỗi
- **Vuốt từ mép**: gói "nhấc tay" của firmware mang toạ độ (0,0) nên vuốt mép phải / từ dưới lên (màn xoay 180°) và mép
  trái (màn không xoay) luôn bị huỷ — nay dùng vị trí di chuyển cuối.
- **Màn hình khóa**: tắt cử chỉ mép khi đang khóa — vuốt lên từ dưới là mở khóa; vuốt mép không còn vượt qua lớp khóa.
- Widget màn khóa nhận đúng camera của chính panel sau khi đổi IP (đọc nguồn go2rtc đang chạy).

## V2.9.118
### Đổi Wi-Fi ngay trên màn hình
- Cài đặt → Wi-Fi & Mạng kiểu iPhone: mạng đang dùng (vạch sóng, dấu ✓), danh sách mạng xung quanh (tự quét khi mở
  trang, không làm rớt mạng), "Mạng khác…" cho mạng ẩn, trang nhập mật khẩu (bàn phím ảo, "Hiện mật khẩu").
- An toàn: màn hình thử mạng mới trong ~40 giây; không vào được, hoặc vào được nhưng không thấy máy chủ Dashboard, thì tự
  quay lại mạng đang dùng. Mạng mới chỉ được lưu khi đã chạy được; mất điện giữa chừng thì khởi động lại vẫn ở mạng cũ.
- Thông tin đầy đủ: tên mạng, BSSID, IP, MAC, DNS, cường độ sóng; Chẩn đoán thêm thời gian chạy; Giới thiệu thêm tên
  ESPHome.
- Cần firmware có hành động `wifi_scan` / `wifi_connect` (xem ví dụ YAML trong repo client, tệp `wifi_ui.h`); firmware cũ
  thì trang chỉ hiện thông tin.

## V2.9.117
### Cài đặt thiết kế lại kiểu iOS
- Màn ngang (7 inch) chia đôi như iPad: danh sách mục bên trái, nội dung bên phải. Màn vuông (4 inch) kiểu iPhone: danh
  sách → trang con, vuốt mép để quay lại.
- Gom thành các mục rõ ràng, mỗi mục một icon màu: Wi-Fi & Mạng, Âm thanh, Màn hình & Độ sáng, Màn hình khóa, Hình nền &
  Khung ảnh, Trợ lý giọng nói, Camera & Phát hiện, Truyền YouTube, Màn hình chính, Pin, Chẩn đoán, Giới thiệu. Tên tiếng
  Việt dễ hiểu, có chú thích; bỏ các mục trùng.
- Công tắc, thanh trượt, nút phân đoạn, trang chọn có dấu ✓, trang sửa chữ (Huỷ / Lưu), hộp xác nhận khởi động lại.
- "Không làm phiền" bật / tắt ngay trên danh sách.

### Sửa lỗi
- Vuốt từ mép (quay lại / về màn hình chính) nhạy hơn: dải mép rộng hơn và nhận cả cú vuốt "lao vào từ viền" (chip cảm
  ứng báo điểm đầu muộn). Trước đây mép trái màn 7 inch, mép phải và mép dưới màn 4 inch xoay 180° gần như không ăn.

## V2.9.116
### Widget trên màn hình khóa
- Dưới đồng hồ: **năng lượng** (công suất mặt trời + sản lượng hôm nay, % pin đang sạc / xả, tiêu thụ, lưới), **lịch 3 ngày
  tới** (lịch tự sinh mỗi ngày như âm lịch được bỏ qua) và **lần camera phát hiện gần nhất** trong 1 giờ (đang diễn ra thì
  hiện đỏ; camera của chính panel được bỏ qua).
- Bật / tắt từng loại trên mỗi panel: Cài đặt → Màn hình khóa. Không có số liệu thì widget tự ẩn.
- Chọn cảm biến năng lượng ở trang Dashboard → thẻ mới **Màn khóa** (gợi ý cảm biến, xem giá trị ngay, đảo dấu pin / lưới).
  Chưa chọn thì lấy theo trang Năng lượng của Home Assistant.
- Số liệu vẽ lại cùng lúc đổi phút (không tốn thêm khung hình); màn vuông và khi có ảnh nền thì gọn hơn.

## V2.9.115
### Sự kiện camera (Frigate)
- Menu → Nhà → **Sự kiện camera**: các lần Frigate phát hiện người / xe / vật nuôi, xếp theo ngày — ảnh thu nhỏ, độ tin
  cậy, camera, giờ, thời lượng. Lọc theo camera, tự cập nhật 30 giây. Chạm để xem ảnh chụp lớn, **xem clip**, vuốt ngang
  sang sự kiện trước / sau.
- Tự tìm Frigate qua tích hợp Frigate trong Home Assistant (không cần cấu hình). Ảnh / clip chỉ phục vụ cho màn hình.

## V2.9.114
### Lịch vạn niên
- Ứng dụng Lịch → **Lịch vạn niên**. Lịch ngày chi tiết: ngày hoàng đạo / hắc đạo (12 thần trực nhật), **giờ hoàng đạo**,
  tiết khí, trực, ngũ hành nạp âm, tuổi xung, giờ mặt trời mọc / lặn theo vị trí nhà trong Home Assistant, đếm ngược Tết,
  một câu tục ngữ mỗi ngày.
- Lưới tháng: số âm ngay dưới số dương, chấm vàng = ngày hoàng đạo, tên tiết khí ở ngày bắt đầu, mùng 1 và Rằm tô màu.
  Vuốt ngang trên lưới để đổi tháng, trên lịch ngày để đổi ngày.
- Màn vuông (S3): chạm một ngày để mở lịch ngày toàn màn hình.

### Sửa lỗi
- Màn hình khóa / chờ đôi khi không hiện (máy chủ tưởng đã hiện, màn hình đứng ở trang HA, chạm chỉ làm sáng): máy chủ
  nay 30 giây kiểm một lần, mất lớp khóa thì tự vẽ lại; Shell không còn bỏ qua khi chưa nhận giờ của thiết bị.
- Ước lượng băng thông đường truyền không còn tăng vô hạn khi lâu không nghẽn (trần 20 MB/s).

## V2.9.113
### IPTV: kênh đổi khoá tự lấy khoá mới
- Kênh mã hoá ClearKey (TV360, VTVPrime…) mà nguồn vừa đổi khoá: ứng dụng tự tải lại danh sách (lấy khoá mới nếu tác
  giả danh sách đã cập nhật) rồi thử lại một lần, không báo lỗi ngay. Cũng tự qua được lỗi khoá thoáng qua khi nguồn
  chèn đoạn mã hoá khác.
- Chỉnh nóng mới `/data/rwv-tuning.json` → `{"iptvHalf": false}`: IPTV gửi khung đầy đủ (nét hơn) thay vì nửa khung
  khi khung quá lớn — dùng khi mạng tới màn hình khoẻ. Mặc định giữ như YouTube TV.

## V2.9.112
### Hình mượt lại nhanh sau khi mạng hết nghẽn
- Khi đường truyền tới màn hình từng nghẽn (WiFi kém, đặt sát nguồn nhiễu…), bộ điều tiết nhớ "ngưỡng tránh nghẽn" rất
  lâu — đo P4 07/10: mạng đã khoẻ mà video vẫn ~3 khung/giây nhiều phút. Nay có số đo rõ ràng đường truyền khoẻ (không
  tồn đọng, dùng < 25% băng thông) thì bỏ ngưỡng cũ: mượt lại trong khoảng 1 phút thay vì ~5 phút.

## V2.9.111
### Ứng dụng IPTV (mới)
- Menu → Giải trí → **IPTV**: xem kênh từ danh sách M3U của bạn. Kênh xếp theo nhóm, tìm theo tên (không cần gõ dấu),
  kênh yêu thích (☆), "Xem tiếp" kênh cuối. Đang xem: chạm hiện thông tin kênh, **vuốt lên / xuống** để đổi kênh.
- **Quản lý danh sách ngay trong ứng dụng** (nút danh sách ở góc trên, như app IPTV thật): thêm bằng **đường link** hoặc
  **tệp .m3u trên thẻ nhớ**, bật / tắt, sửa, xoá, cập nhật. Cũng làm được ở trang **Dashboard → IPTV** trong Home Assistant.
- Phát được HLS (m3u8), MPEG-TS / FLV qua HTTP, mp4, **DASH và kênh mã hoá ClearKey** (TV360, VTVPrime… trong các danh
  sách VN); dùng được User-Agent / Referer riêng của từng kênh. Không phát được: DRM Widevine / PlayReady.
- Máy chủ chuyển tiếp luồng (không vướng CORS); rời ứng dụng là ngắt luồng, quay lại thì phát tiếp kênh đang xem.
- Kênh 1080p (VTV…) gửi khung **nửa độ phân giải** khi khung đầy đủ quá lớn (như YouTube TV) — đo P4: khung đầy đủ
  ~100 KB làm đường truyền nghẽn còn 2,5 fps. Kênh nhiều mức chất lượng tự chọn ≤ 720p.
- Kênh ClearKey có khoá đã cũ (nguồn đổi khoá) báo rõ "cần danh sách mới" thay vì lỗi chung.

## V2.9.110
### Màn hình khóa: có người thì sáng màn, vẫn giữ khóa (P4)
- P4 thấy người khi đang khóa: màn sáng lại đúng độ sáng đang dùng và giữ sáng suốt lúc còn người; người đi khỏi 15 giây
  thì tối lại. Không còn tự về trang chủ — vuốt lên để mở (cần firmware **fw-2026.10.06**; firmware cũ vẫn chạy như trước).

## V2.9.109
### Màn hình khóa kiểu điện thoại
- Cài đặt → nhóm mới **Màn hình khóa**: bật *Khóa màn hình*, *Khóa / màn hình chờ sau* (thêm 30 giây, 15 và 30 phút),
  *Độ sáng khi khóa*, *Cỡ đồng hồ* (Vừa / Lớn / Rất lớn), *Thời tiết chi tiết*, *Hiện ảnh nền*, *Đổi ảnh sau*.
- Khi khóa: **vuốt lên từ nửa dưới** để mở; chạm chỉ hiện gợi ý và làm sáng màn 15 giây. Bấm chip tin nhắn / thông báo thì
  mở sau khi vuốt. Báo thức, chuông cửa, thông báo vẫn hiện đè lên, xong lại khóa.
- Độ sáng khi khóa: giảm về mức chọn, mở khóa thì trả lại đúng độ sáng đang dùng (nhớ cả khi addon khởi động lại).
- Đồng hồ to hơn; thẻ thời tiết chi tiết: cảm giác như, độ ẩm, gió, khả năng mưa, cao/thấp trong ngày, chất lượng không
  khí (AQI), 6 giờ tới. Màn ngang: đồng hồ trái, thời tiết phải; màn vuông xếp dọc.

## V2.9.108
### Tiếng không còn bị ngắt quãng khi xem video trên màn P4
- Khi phát video, nhân Linux của máy chủ giữ sẵn tới ~370 KB dữ liệu hình chờ gửi cho màn hình (đo thật 07/10) mà máy chủ
  không thấy, nên vẫn đẩy thêm hình; gói tiếng phải xếp sau và tới màn hình trễ 0,4–0,9 s → loa bị ngắt, rồi bị dồn.
- Máy chủ giờ cộng cả phần nhân đang giữ (đọc `/proc/net/tcp6`) vào "tồn đọng", nên bỏ khung / giãn nhịp kịp lúc.
- Tắt nhanh nếu cần: thêm `"kernelBacklog": false` vào `/data/rwv-tuning.json` (không cần khởi động lại).

## V2.9.107
### Tự ngắt kết nối khi màn hình ngừng đọc dữ liệu

- Sự cố P4 đứng không phản hồi chạm (02/10): màn hình ngừng đọc WebSocket, trong khi máy chủ vẫn gửi âm thanh không giới hạn
  (dồn tới 17 MB RAM) và không bao giờ cắt kết nối chết.
- Nay máy chủ **ngắt kết nối** của màn hình có dữ liệu ứ đọng mà **không byte nào rời máy chủ trong 30 giây**; màn hình tự
  nối lại. Ghi log `[broadcaster] … socket ket …`. Đổi ngưỡng bằng biến môi trường `CCR_WS_STALL_MS` (mili giây).
- Âm thanh bị bỏ khi dữ liệu ứ đọng của socket vượt 512 KB (`CCR_WS_AUDIO_HIGH_WATER`); khung video vẫn theo ngưỡng cũ.

## V2.9.106
### Cài addon từ ảnh dựng sẵn, bản sao lưu nhỏ thêm ~1,1 GB

- Addon nay **tải ảnh dựng sẵn** từ ghcr thay vì tự dựng trên máy Home Assistant. Supervisor đưa ảnh Docker của add-on
  tự dựng vào **mỗi** bản sao lưu (~1,1 GB sau nén); ảnh tải về thì không. Bản sao lưu của addon còn vài chục MB.
- Cập nhật cũng nhanh hơn: chỉ tải ảnh, không dựng lại trên máy. Chức năng, cấu hình, dữ liệu giữ nguyên.

## V2.9.105
### Bản sao lưu Home Assistant nhỏ hơn ~1,6 GB

- Bản sao lưu của addon không còn chứa **bộ đệm** của Chrome (bộ đệm trang, bộ đệm mã JavaScript, bộ đệm GPU, mô hình
  tải về) và bộ đệm MP4 / tệp tải lên tạm của Quản lý file — đều tự tạo lại. Hồ sơ Chrome thật (đăng nhập các trang,
  Local Storage, IndexedDB, Service Worker) vẫn được sao lưu như cũ.
- Khôi phục từ bản sao lưu: lần đầu mở mỗi trang tải chậm hơn một chút (tải lại từ mạng), sau đó như bình thường.

## V2.9.104
### Quản lý file (thẻ SD của P4) trên trang Dashboard

- Thẻ mới **Quản lý file** trên trang Dashboard (thanh bên Home Assistant): duyệt thẻ SD của màn hình có camera (P4),
  xem ảnh / phát video ngay trên trang, **tải về**, **tải lên** (từ điện thoại / máy tính), **đổi tên**, **tạo thư mục**,
  **xoá** (chọn nhiều), thanh dung lượng. Dùng được cả khi ở ngoài nhà (qua đăng nhập HA).
- **Tải về dạng MP4**: video quay là .mkv (iPhone không phát được) — máy chủ chép nguyên hình, đổi tiếng sang AAC
  (vài giây), tệp gốc trên thẻ giữ nguyên. Xem trước video .mkv trên trang cũng dùng bản MP4 này.
- **Tối ưu video cho màn hình** khi tải lên: máy chủ đổi sang MP4 720p H.264 + AAC (≤ 3 Mbps) trước khi chép vào thẻ —
  phát mượt trên P4, nhận cả video HEVC của điện thoại. Tệp lên máy chủ trước rồi chép dần vào thẻ; màn hình đang phát
  video thì tạm dừng chép. Cần firmware P4 có `/sd/put`, `/sd/mv`, `/sd/mkdir` (cam_app, từ `fw-2026.10.02`).
- Ứng dụng **Tệp** trên màn hình đổi tên thành **Quản lý file**.

## V2.9.103
### Tin nhắn: màn hình chờ đè lên thì tin mới vẫn thông báo

- **Sửa:** mở sẵn ứng dụng Tin nhắn, một lúc sau màn hình chờ hiện đè lên — tin mới đến không có chuông / thẻ thông báo
  (server coi là "đang xem") và trang tự đánh dấu đã đọc. Nay "đang xem" = Tin nhắn đang hiện **và** không có màn hình
  chờ **và** có người chạm màn hình trong 2 phút gần đây. Không thì vẫn chuông + thẻ thông báo như ở ứng dụng khác, tin
  giữ "chưa đọc" (chấm, thẻ trên màn hình chờ) tới khi chạm vào màn hình.

## V2.9.102
### Sửa: nút "Sửa" trong Cài đặt không có tác dụng

- Cài đặt › Màn hình › **Tên khi truyền**: bấm **Sửa** không hiện ô nhập (cả 3 màn hình). Trang có chốt "đang sửa thì
  không vẽ lại" để không mất chữ đang gõ, nhưng chính lần vẽ khi bấm Sửa cũng bị chặn. Nay bấm Sửa hiện ô nhập + Lưu/Huỷ.

## V2.9.101
### Còn người trước màn hình thì không vào màn hình chờ

- **Sửa:** cảm biến phát hiện người (P4) bật màn hình / thoát màn hình chờ, nhưng người vẫn đứng đó (cảm biến vẫn báo có
  người) thì sau *Màn hình chờ sau* (mặc định 2 phút) màn hình chờ vẫn phủ lên — server chỉ đếm từ lần chạm cuối. Nay:
  còn người thì giữ nguyên trang hiện tại; chỉ khi cảm biến báo **trống** đủ thời gian rảnh mới hiện màn hình chờ.
- Màn hình nối lại thì bỏ trạng thái "có người" cũ (tránh kẹt không bao giờ vào màn hình chờ).

## V2.9.100
### Dock không còn nút "Gần đây"

- Bỏ nút **Gần đây** cố định ở cuối dock (theo người dùng) — dock chỉ còn 6 ứng dụng. Màn hình Gần đây vẫn mở bằng
  **vuốt lên từ mép dưới rồi giữ** hoặc nút **Gần đây** trên thanh kéo xuống.
- **Sửa: thời tiết ở màn hình chính biến mất** sau khi addon khởi động lại nếu Open-Meteo lỗi tạm (503) — trước đây phải
  đợi 15 phút mới thử lại. Nay lỗi thì thử lại sau 1 phút, và lưu số liệu cuối (`/data/rwv-weather-mini.json`) để
  khởi động lại hiện ngay (nếu chưa quá 3 giờ).

## V2.9.99
### Dock 6 ứng dụng, bỏ ứng dụng Cảnh

- **Dock** (thanh ứng dụng nhanh cuối màn hình chính) tối đa 6, mặc định: Home Assistant, Camera (màn có camera), YouTube,
  Tin nhắn, NhacCuaTui, Google Maps. Vẫn kéo thả để đổi được.
- **Bỏ hẳn ứng dụng Cảnh** (theo người dùng): khỏi menu, màn hình chính, thanh kéo xuống; gỡ luôn API `/ha/scenes`,
  `/ha/run` (máy trong LAN không còn chạy scene/script qua addon).

## V2.9.98
### YouTube TV: vuốt để di chuyển

- Giao diện YouTube TV chỉ nghe phím remote nên trước đây chỉ chạm (chọn video, ô tìm kiếm) có tác dụng, vuốt bị bỏ qua.
  Nay vuốt trên YouTube TV = phím mũi tên như remote, hướng tự nhiên như điện thoại: vuốt lên → xuống hàng dưới, vuốt
  sang trái → video bên phải; vuốt dài đi nhiều bước. Chạm vẫn như cũ. YouTube thường / YouTube Music không đổi.
- **Quay lại** (vuốt từ mép / nút quay lại) trên YouTube TV = phím Back của remote: đang xem video, tìm kiếm… → về màn
  trước trong YouTube TV; đang ở trang chủ YouTube TV → ra màn hình chính.

## V2.9.97
### Tiếng cho video quay + mục "Luồng camera" trong Cài đặt (P4)

- Video quay bằng ứng dụng Camera **có tiếng** (micro đã khử vọng của panel; tắt được).
- **Cài đặt › Luồng camera** (mục mới): *Tiếng luồng camera* — thêm tiếng vào luồng camera gửi Frigate / go2rtc (mặc
  định TẮT; đang phát video trên màn này thì tạm không lấy tiếng để giữ độ mượt; đổi lúc Frigate đang xem thì luồng tự
  kết nối lại) và *Tiếng khi quay video* (mặc định BẬT).
- Cần firmware `fw-2026.10.01f` (micro đếm người dùng: tự đánh thức, trợ lý, tin nhắn thoại, luồng camera dùng chung
  micro mà không tắt của nhau).

## V2.9.96
### Định dạng thẻ SD ngay trên màn hình (P4)

- Thẻ microSD trên 32 GB bán ra thường là **exFAT** — panel không đọc được. Nay ứng dụng **Tệp** / **Thư viện** nhận ra
  "thẻ có nhưng chưa đúng định dạng" và có nút **Định dạng thẻ (FAT32)** (hỏi lại trước khi xoá, hiện tiến độ; thẻ 64 GB
  ~10–60 giây) — không cần máy tính. Tệp: nút *Định dạng* ở thư mục gốc để định dạng lại thẻ đang dùng.
- Cần firmware `fw-2026.10.01e`.

## V2.9.95
### Âm thanh kiểu điện thoại, ứng dụng Báo thức, tin nhắn thoại

- **Ba loại âm lượng** (P4 — cần firmware `fw-2026.10.01d`):
  - *Media*: YouTube, nhạc, radio, video, tin nhắn thoại… (thanh âm lượng sẵn có);
  - *Thông báo*: chuông tin nhắn / thông báo, chuông cửa, lời đọc của HA, trợ lý;
  - *Báo thức*: báo thức, hết giờ Hẹn giờ, cảnh báo khẩn (tối thiểu 20%).
  Chuông do chính panel phát (tệp âm nhúng trong firmware) — không còn đi qua âm thanh trang web, nên **Im lặng** (nút
  cũ "Tắt tiếng") **chỉ tắt media**, chuông vẫn kêu; đang phát nhạc thì nhạc tự nhỏ đi khi có chuông / TTS.
  **Không làm phiền** = im lặng hoàn toàn (thông báo, báo thức, cảnh báo khẩn, lời đọc của HA) — màn hình vẫn hiện.
  Điều chỉnh ở thanh kéo xuống (nút ⌄ cạnh thanh âm lượng) và **Cài đặt › Âm thanh** (có nút phát thử) — đồng bộ.
- **Báo thức** (ứng dụng mới, mọi màn hình): lặp theo thứ hoặc một lần, nhãn, báo lại 5–30 phút, chọn màn hình reo (màn
  này / mọi màn / chọn). Reo đúng giờ kể cả khi màn tắt; Tắt / Báo lại trên một màn là cả nhóm ngừng; 5 phút không ai tắt
  -> thông báo "bị lỡ". Báo thức kế tiếp hiện ở thanh kéo xuống và màn hình chờ. Hẹn giờ dùng chung cơ chế này.
- **Tin nhắn thoại**: nhấn giữ 🎤 để ghi, thả ra để gửi, vuốt lên (panel) / kéo ra ngoài (thanh bên) để huỷ, tối đa 60 s.
  Panel P4 ghi bằng micro đã khử vọng (`fw-2026.10.01d` — sửa luôn lỗi micro P4 đọc toàn 0 khiến tự đánh thức / trợ lý
  không nghe được); thanh bên HA ghi bằng micro trình duyệt (cần mở HA bằng https).
  Màn không loa (S3) hiện tin nhưng không phát.

## V2.9.94
### Tin nhắn nội bộ, Thư viện + Tệp (thẻ SD của P4), trang thanh bên "Dashboard"

- **Tin nhắn** (mọi màn hình): nhắn qua lại giữa trang **Dashboard** trên thanh bên Home Assistant và các panel — chữ, ảnh,
  video. Mỗi cuộc trò chuyện gồm Home Assistant + các màn hình đã chọn (hoặc "Mọi màn hình"). Trên panel: danh sách
  cuộc trò chuyện, tạo mới / xoá (giữ ngón tay hoặc nút thùng rác), trang nhắn tin kiểu điện thoại, trả lời nhanh;
  màn có camera (P4) gửi được ảnh chụp ngay hoặc ảnh/video từ thẻ SD. Tin mới: màn hình sáng lên + thẻ thông báo,
  chạm vào mở đúng cuộc trò chuyện. Màn hình gửi tin -> sự kiện HA `dashboard_chat_message` (tự động hoá báo về điện thoại…).
- **Ảnh đại diện**: mỗi người nhà nhắn từ Home Assistant hiện ảnh trong tài khoản HA của mình (ảnh của thực thể *person*;
  chưa đặt ảnh -> chữ cái đầu trên nền màu riêng), màn hình hiện biểu tượng màn hình; tin gom nhóm theo người gửi như ứng
  dụng chat. Trên trang thanh bên, tin của người nhà KHÁC (cùng dùng HA) nằm bên trái kèm ảnh. Thẻ thông báo trên panel
  hiện ảnh người gửi.
- **Đã xem riêng từng màn hình**: thông báo đến làm màn sáng + hiện thẻ nhưng CHƯA tính là đã xem. Chuông (chấm trên nút
  kéo) và dòng **"2 tin nhắn · 1 thông báo"** trên **màn hình chờ** còn cho tới khi có người xem trên CHÍNH màn đó: chạm
  thẻ, mở thanh kéo xuống (thông báo thường), đọc cuộc trò chuyện trong Tin nhắn (tin nhắn). Màn khác chưa xem vẫn còn
  chuông. Chạm "tin nhắn" trên màn hình chờ mở thẳng Tin nhắn. Biểu tượng Tin nhắn có huy hiệu số tin chưa đọc. Nhiều
  tin cùng cuộc trò chuyện gộp một thông báo ("3 tin mới · …"). Thông báo + trạng thái đã xem lưu qua cập nhật addon.
- **Trang thanh bên** đổi tên "Menu panel" -> **Dashboard**, hai thẻ: *Tin nhắn* (mặc định) và *Menu ứng dụng* (như cũ).
  Gửi ảnh/video bằng nút ghim, kéo thả hoặc dán; ảnh tự thu nhỏ (≤ 2048 px), video ≤ 200 MB tải lên từng đoạn có tiến độ.
- **Thư viện** (P4): ảnh/video trong DCIM theo ngày, lọc Ảnh/Video, xem ảnh (vuốt, chạm đúp phóng to), trình phát video
  (tua, ±10 s), chọn nhiều để xoá. Nút thư viện trong ứng dụng Camera mở thẳng vào đây.
- **Tệp** (P4): duyệt toàn bộ thẻ SD (tên tiếng Việt), sắp xếp Tên/Ngày/Cỡ, xem ảnh/video/văn bản, xoá tệp hoặc thư mục.
- Cần firmware P4 `fw-2026.10.01d`: API thẻ SD mới, ảnh thu nhỏ khi chụp/quay, video quay có độ dài +
  mục lục (tua được), và sửa lỗi ESPHome tắt VFS thư mục khiến thẻ SD không đọc được thư mục.

## V2.9.93
### Ứng dụng Camera (P4), Frigate, Google Maps, YouTube Music; sửa màn hình chờ S3

- **Camera** (chỉ màn có camera — P4, firmware `fw-2026.10.01c`): xem trực tiếp, chụp ảnh 1920×1080, quay video `.mkv` lưu
  thẻ SD của panel, thư viện xem/xoá. Chưa cắm thẻ: vẫn chụp, ảnh chỉ xem tạm. Lệnh đi qua `/api/cam/*` (chỉ nhận từ chính
  panel, chuyển tới đúng IP của màn đã báo `?cam=`). Màn không có camera (S3): không hiện ứng dụng/nút Camera.
- **Frigate** (trước là "Camera nhà", logo Frigate lấy từ chính add-on Frigate). Thanh trạng thái: nút **Camera** (P4) +
  **Frigate**.
- **Google Maps** (trước là "Giao thông", biểu tượng Google Maps), **YouTube Music** (trước là "Nhạc").
- Màn hình chờ S3 480×480 không hiện khi bật "Màn hình chờ": firmware S3 báo sai trạng thái đèn nền — sửa ở YAML S3
  (`fw-2026.10.01c`); server không đổi.
- Gồm cả 2.9.92 (tự nạp lại tab khi renderer chết).

## V2.9.92
### Sửa: cả 3 màn đen khi máy chủ hết RAM (P4 + S3)

- Sự cố thật 01/10: máy chủ HASS hết RAM + swap, kernel (OOM killer) giết tiến trình Chrome chứa trang dashboard Home
  Assistant — dùng chung cho cả 3 màn → **cả 3 màn đen 42 phút** (đèn nền vẫn sáng), chạm không ăn ("Failed to dispatch touch
  event"). Server không biết tab đã chết nên không làm gì.
- Nay server nghe sự kiện **renderer chết** của từng tab: tab đang hiện → tải lại trang + bật lại luồng hình ngay; tab nền →
  tải lại rồi đóng băng như cũ. Log ghi rõ RAM/swap máy chủ lúc đó.
- Nạp lại Shell không còn bị huỷ vì lỗi "Script not found" (mã script cũ đã mất sau khi renderer chết).

## V2.9.91
### Thực thể "Ảnh màn hình chờ" và "Màn hình chờ" trên Home Assistant

- Firmware `fw-2026.10.01b` có công tắc **"Ảnh màn hình chờ"** (P4 + 2 S3) và đổi "No Sleep" thành
  **"Màn hình chờ"**. Server đồng bộ hai chiều: gạt trên HA ↔ mục "Màn hình chờ hiện ảnh" trong Cài đặt trên màn hình
  (kèm bật/tắt "Màn hình chờ" như khi gạt ở Cài đặt). Lần đầu thấy công tắc: Cài đặt đang có là gốc.
- Nhận diện công tắc "Màn hình chờ" theo tên mới (vẫn nhận "No Sleep" của firmware cũ). Firmware cũ: không đổi gì.

### Tiện ích web mới (P4 + S3)

- **Giải trí**: VTVgo (phát VTV1 trực tiếp được — lần đầu bấm *Đồng ý* điều khoản), Zing MP3, NhacCuaTui (phát nền như Nhạc).
- **Tiện ích**: Báo Mới, Giá vàng (WebGiá: vàng SJC, tỷ giá, xăng dầu), Xổ số (Minh Ngọc), Giao thông (Google Maps lớp
  giao thông, đổi vị trí bằng `LAUNCHER_TRAFFIC_URL`). Ẩn/đổi chỗ ở trang "Menu panel" như ứng dụng khác.
- Ứng dụng có sẵn giờ có biểu tượng MDI mặc định (tải vào bộ đệm lúc khởi động).

## V2.9.90
### Bàn phím ảo tự ẩn đúng lúc (P4 + S3)

- Người dùng báo 01/10: chạm gợi ý YouTube đã chuyển đúng trang (2.9.89) nhưng **bàn phím vẫn hiện**, cả khi màn hình chờ
  hiện lên. Ghi sự kiện thật: bàn phím ẩn đúng lúc chạm, rồi 118 ms sau YouTube tự focus lại ô tìm kiếm → bàn phím hiện lại;
  trang chuyển xong focus sang nút nhưng bàn phím vẫn nằm đó.
- Sau khi chạm ra ngoài, bỏ qua focus tự động của trang trong 1 s (chạm thẳng vào ô nhập vẫn mở bàn phím).
- Focus rời ô nhập sang thứ không phải ô nhập (trang tự chuyển, nút) → tự ẩn bàn phím.
- Màn hình chờ hiện → ẩn bàn phím.

## V2.9.89
### Bàn phím ảo: chạm ra ngoài không còn bị nuốt; ảnh màn hình chờ kéo theo "Màn hình chờ"; tab nền đóng băng chắc chắn

Áp dụng như nhau cho **P4 và cả hai S3** (chỉ server).

- **Bàn phím ảo**: đang gõ mà chạm ra ngoài (vd **dòng gợi ý tìm kiếm YouTube**) trước đây không có tác dụng — bàn phím
  ẩn và bỏ focus ô nhập ngay (YouTube đóng danh sách gợi ý) rồi chặn mọi sự kiện 400 ms, nuốt luôn cú chạm đó. Nay chạm
  ngoài chỉ ẩn bàn phím, cú chạm đi tiếp; bỏ focus sau 350 ms. Nút ▼/Enter của bàn phím vẫn chặn như cũ.
- **Cài đặt → "Màn hình chờ hiện ảnh"**: bật → tự bật *No Sleep* ("Màn hình chờ", màn luôn sáng để hiện khung ảnh); tắt
  → tự tắt. Chỉ tác động lúc gạt (qua Home Assistant — chạy cả firmware S3).
- **Đóng băng tab nền**: mỗi lệnh gửi Chrome có hạn 3 s — trước đây một lệnh không trả lời làm cả chuỗi treo im lặng,
  tab nền vẫn chạy (log lỗi nay hiện rõ).
- **Sau khi thiết bị nối lại** (khởi động lại / OTA): bỏ đỉnh tồn đọng + ước lượng băng thông của socket cũ. Đo 01/10:
  P4 nối lại, nhịp kế tiếp đọc tồn đọng 1,66 MB của socket đã chết → YouTube 7,7 hình/giây, ~5 phút mới về bình thường.
- Dọn: bỏ file `src/deviceManager.ts.backup` khỏi repo.

## V2.9.88
### Rà soát 01/10

- Màn hình chờ: trong lúc server hỏi trang có video đang chạy (tối đa 1,5 s) mà người dùng vừa chạm → không hiện nữa
  (trước có thể hiện ngay sau cú chạm). P4 + S3.
- Tài liệu: khung nửa độ phân giải theo thiết bị (S3 `half=2`, P4 `half=1` + tự động khi nghẽn), màn hình chờ kiểu điện
  thoại, đóng băng tab dừng mọi media, đóng tab nền sau 5 phút (thiếu RAM 2 phút), YouTube trên S3 ~14 hình/giây.

## V2.9.87
### Màn hình chờ không bao giờ đè lên video; tab nền thật sự dừng và đóng sớm hơn

Áp dụng như nhau cho **P4 và cả hai S3** (chỉ server, không cần nạp firmware). Thay cho cách "chờ 30 s" của 2.9.86.

- **Màn hình chờ như điện thoại**: ngừng phát video cũng tính là "vừa dùng" — thời gian rảnh đếm từ lần chạm cuối HOẶC lúc
  video ngừng (lấy cái muộn hơn). Trước khi vẽ, server **hỏi thẳng trang** có `<video>/<audio>` đang chạy không — đang
  chạy thì không vẽ. Log thật P4 01/10: YouTube báo "tạm dừng" thoáng qua khi nạp đệm → màn hình chờ hiện đè video 3–6 s.
- **Tab nền thật sự dừng**: trước khi đóng băng (dừng JavaScript) server **dừng mọi video/âm thanh** của tab — trước đây
  chỉ YouTube/TikTok; trang web khác có video vẫn phát ngầm vì bộ giải mã của Chrome không phụ thuộc JavaScript. Radio /
  nhạc được phép phát nền: không đổi.
- **Đóng hẳn tab nền** (trả RAM) sau **5 phút** không dùng (trước 20), **2 phút** khi máy chủ thiếu RAM (trước 3). Vẫn còn
  trong "Gần đây". Tuỳ chỉnh: `IDLE_TAB_CLOSE_MIN`.

## V2.9.86
### Sửa: màn hình chờ hiện đè lên video đang phát

- Log thật P4 01/10: YouTube báo "tạm dừng" thoáng qua (nạp đệm, đổi chất lượng) → quá 2 phút không chạm thì màn hình
  chờ hiện ngay, 3–6 s sau tắt, lặp lại mỗi vài phút trong lúc video vẫn chạy.
- Tab phải ngừng phát **liên tục 30 s** mới được hiện màn hình chờ. Áp dụng như nhau cho **P4 và S3** (không phụ thuộc
  firmware).

## V2.9.85
### Sửa: P4 đứng hình khi WiFi yếu lúc xem YouTube

- Log thật 01/10 sáng: YouTube thường trên P4 gửi khung đủ độ phân giải ~42 KB (500–600 KB/s); WiFi P4 yếu đi → tồn đọng
  200 → 934 KB, ping P4 2 s (S3 bình thường), WebSocket rơi/nối lại, đứng hình ~40 s mỗi lần.
- **P4 (`half=1`)**: tồn đọng vượt nửa ngưỡng bỏ khung (~96 KB) → gửi khung **nửa độ phân giải** (¼ byte, P4 phóng ×2 bằng
  PPA) tới 15 s sau lần nghẽn cuối, rồi tự về đủ độ phân giải. Chỉ khi đang có video — dashboard không bao giờ mờ.
  `NET_HALF_HOLD_MS=0` tắt tính năng.
- **S3 (`half=2`)**: không đổi (đã luôn dùng khung nửa khi phát video). Thiết bị không báo `half`: không đổi.

## V2.9.84
### Sửa: S3 kẹt ở 3 khung/giây khi phát YouTube

- Đo 30/09: khung video nửa độ phân giải ~9 KB, S3 xử lý ~28 ms/khung, nhưng bộ điều tiết giữ nhịp 250–400 ms: một đợt
  khung nét lúc mở trang làm tồn đọng > 96 KB → giãn nhịp, rồi hồi phục mỗi bước 50 ms, cần 2 mẫu tốt.
- Thiết bị báo `half=2` (S3) dùng bộ điều tiết nhanh như P4: tồn đọng tới 192 KB, bước 17 ms, hồi sau 1 mẫu tốt, chờ 5 s.

## V2.9.83
### Sửa: S3 bật/tắt nửa độ phân giải liên tục

- Đo 2.9.82 trên S3 480×480: 5,6 khung/giây, khung nửa (~8 KB) xen với khung đầy đủ 24–65 KB. Chế độ nửa chỉ bật khi
  Chrome gửi ≥ 2,5 khung/giây, mà chính S3 giải mã chậm làm server giãn nhịp về ~2,5 → dao động quanh ngưỡng.
- Thiết bị báo `half=2` không còn xét nhịp: có `<video>` đang phát (hoặc phần lớn màn hình đổi, giữ 1 s) là gửi khung nửa.

## V2.9.82
### Mới: YouTube mượt hơn trên hai màn S3

- Đo 30/09 trên S3 480×480: YouTube chỉ **1,9 khung/giây** — S3 giải mã JPEG bằng phần mềm ~60 ms/khung, socket nghẽn
  >200 KB, server phải giãn nhịp tới 350 ms.
- Firmware S3 mới (`fw-2026.09.30j`, `half_scale_video: true`) báo `half=2`: khi phát video server gửi khung **nửa độ
  phân giải** (¼ điểm ảnh) cho **mọi** video, S3 tự nhân đôi điểm ảnh. Dừng ~0,7 s thì server gửi lại khung nét.
- P4 không đổi (vẫn `half=1`: chỉ YouTube TV nguồn ≤ 720p). Firmware cũ / server cũ: không đổi gì (tương thích hai chiều).

## V2.9.81
### Mới: chọn "Phát hiện người" ngay trên thanh trạng thái

- Kéo thanh trạng thái xuống: thêm hàng **Phát hiện người** với các nút *Tắt · Chuyển động · Person · Cả 2* — đổi
  select `Nguồn phát hiện người` của màn hình qua Home Assistant. *Tắt* = tắt hẳn phát hiện người trên chip.
- Chỉ hiện khi màn hình có select này (P4 từ YAML 30/09); hai màn S3 và firmware P4 cũ không thấy gì thay đổi. Không
  đổi giao thức với firmware.

## V2.9.80
### Sửa: truyền YouTube lúc màn hình đang tắt thì màn không hiện video

- Log thật 30/09: màn đang tắt → điện thoại truyền → server bật đèn nền → firmware (`resume()`) gửi lại lệnh mở **trang
  chủ** → YouTube TV vừa hiện đã bị đẩy ra nền, màn hình về HA, video phát ngầm, điện thoại vẫn báo đang truyền.
- Server: trong 6 giây sau khi bắt đầu truyền, lệnh mở trang từ thiết bị bị bỏ qua (giữ YouTube TV). Firmware mới
  (`fw-2026.09.30e`) sửa tận gốc: bật màn hình chỉ xin vẽ lại, không mở lại trang nữa.

## V2.9.79
### Báo màn hình "đang màn hình chờ" cho thiết bị (phát hiện khuôn mặt lúc màn hình chờ)

- Server báo thiết bị khi màn hình chờ (đồng hồ / khung ảnh) hiện hoặc tắt: DeviceControl trường 8 (`Saver`), gửi
  **ngay** khi đổi và nhắc lại mỗi 5 s. Firmware P4 (`on_screensaver`, tag fw-2026.09.30d) dùng để chạy phát hiện
  khuôn mặt cả lúc màn hình chờ; thấy mặt thì về trang chủ. Firmware cũ bỏ qua trường lạ.

## V2.9.78
### YouTube TV 720p: nửa độ phân giải ổn định, không bật/tắt từng khung

- Đo 2.9.77 (truyền 720p thật): P4 hết quá tải (giải mã 17,5 ms, CPU 24%), nhưng khung 720p dao động quanh ngưỡng "quá
  to" nên chế độ nửa độ phân giải bật/tắt liên tục — ~190 khung đầy đủ cỡ lớn xen giữa, 20 fps, loa vấp 68 lần/30 s.
  Nay đã thấy một khung quá to thì giữ nửa độ phân giải 10 giây.

## V2.9.77
### YouTube TV: chọn 720p trên điện thoại không còn làm P4 quá tải và mất hình

- Đo 30/09: truyền YouTube TV rồi chọn **720p** → ảnh toàn màn hình 80–93 KB/khung (vẫn 59 KB ở chất lượng thấp), vượt
  xa gói 32 KB của P4 → P4 giải mã ~120 ms/khung, hàng đợi phình tới 2,2 MB, P4 tự kết nối lại. Nay tab YouTube TV gửi
  khung **nửa độ phân giải** (P4 phóng ×2 bằng phần cứng, ~12 KB/khung) cả khi nguồn ≤ 360p (như trước) lẫn khi khung
  đầy đủ quá to (> 2 lần gói).
- Sau khi P4 kết nối lại, firmware gửi lệnh mở trang chủ → trước đây màn hình về Home Assistant trong khi video vẫn phát
  ngầm, điện thoại tưởng vẫn đang truyền nên không mở lại. Nay trong 8 giây sau khi kết nối lại mà đang truyền, lệnh
  đó bị bỏ qua và YouTube TV hiện lại.

## V2.9.76
### Hạ chất lượng screencast chỉ khi thật sự có ích

- Số liệu 2.9.75 (`slowWhy`) cho thấy: trang xem YouTube thường (video chỉ chiếm một phần màn hình, còn lại chữ và ảnh
  thu nhỏ) ở chất lượng 40 **Chrome vẫn nén ra ~54 KB** (chất lượng 90: 129 KB) — không bao giờ vừa gói 32 KB của P4.
  Với trang kiểu này, đường "chậm" (chỉ gửi các ô thay đổi, ~28 KB) mới là đúng; hạ chất lượng chỉ làm chữ mờ hơn.
- Nay sau khi hạ chất lượng, nếu 15 khung liên tiếp vẫn quá to → trả về 90, không thử lại trong 5 phút. Video phủ gần hết
  màn hình (toàn màn hình, trang nhúng, YouTube TV) vẫn được hưởng đường tắt.

## V2.9.75
### Chẩn đoán: vì sao khung video đi đường chậm

- `/metrics.pipeline.<màn>.slowWhy`: đếm lý do từng khung rơi vào đường chậm (`fps` nhịp thấp, `big` ảnh Chrome quá to,
  `dims` sai kích thước, `sharp` khung làm nét), kèm kích thước/khổ ảnh Chrome gần nhất; `scQuality` = chất lượng
  screencast đang dùng. Đo 30/09 (2.9.74): ở chất lượng 40 vẫn 0 khung đi đường tắt — cần số liệu này để sửa đúng chỗ.

## V2.9.74
### Sửa: hạ chất lượng screencast khi phát video (2.9.72) thật sự hoạt động

- 2.9.72 đổi chất lượng bằng cách gọi lại lệnh bật screencast khi nó đang chạy — Chrome từ chối ("Screencast is already
  active"), nên tính năng chưa từng chạy (đo A/B trên P4: 0 khung đi đường tắt ở cả hai chế độ). Nay dừng rồi bật lại
  screencast với chất lượng mới; lỗi thì giữ chất lượng cũ và tạm ngưng thử 1 phút (không thử lại từng khung).
- Test tích hợp mới: trang có hoạt ảnh → đổi chất lượng xuống, hết hoạt ảnh → về 90, khung vẫn đến.

## V2.9.73
### Sửa: màn hình báo đã kết nối nhưng đứng hình sau khi addon khởi động lại

- Cổng WebSocket mở **trước** khi Chrome khởi động xong (~2,5 s) nhưng bộ xử lý kết nối chỉ được gắn **sau** đó. Màn
  nào kết nối lại đúng khoảng này thì bắt tay thành công nhưng server không bao giờ biết tới nó: màn báo "WS Connected",
  server 0 thiết bị, hình đứng mãi. Gặp thật 30/09 sau lần cập nhật 2.9.72 (cả 3 màn). Nay cổng chỉ mở khi Chrome đã
  sẵn sàng (màn kết nối sớm bị từ chối và tự thử lại).

## V2.9.72
### Video trên P4 đi thẳng từ Chrome, không còn giải nén + nén lại ở server

- Đo 30/09 (bộ đếm mới `/metrics.pipeline`): khi P4 phát YouTube, **100% khung đi đường chậm**, 0 khung đi đường
  tắt. Lý do: màn hình gói nhỏ (P4 32 KB) luôn nhận ảnh Chrome ở chất lượng 90 (60–120 KB/khung), không bao giờ vừa
  một gói. Node tốn ~120% CPU chỉ để giải nén rồi nén lại.
- Nay khi nhịp khung cao liên tục ≥ 1,5 s (đang phát video), Chrome được chuyển sang nén **ở đúng chất lượng của
  màn hình** → khung đi thẳng. Hết video 1,5 s thì trả về chất lượng 90 và vẽ lại khung nét cho giao diện tĩnh.
  Tắt nóng: `"videoLowQ": false` trong `/data/rwv-tuning.json`.

## V2.9.71
### Server bớt CPU khi phát video

- Đo 30/09 (hồ sơ CPU thật lúc P4 phát YouTube): khung JPEG của Chrome trung bình ~28 KB, sát trần 32 KB/gói của P4 —
  khung nào vượt trần phải đi **đường chậm** (giải nén cả khung, so sánh từng ô, nén lại từng ô), đường tắt video
  bật/tắt liên tục. Nay khung vượt trần ít (≤ 2 lần) được **nén lại một lần cả khung** ở chất lượng thấp hơn chút cho
  vừa một gói. Tắt nóng: `"passthroughFit": false` trong `/data/rwv-tuning.json`.
- `/metrics` có thêm `pipeline`: số khung đi đường tắt / nén-cho-vừa / nửa độ phân giải / đường chậm của từng màn.

## V2.9.70
### YouTube thường nhẹ hơn: chỉ nhận video H.264

- Đo 30/09: tab YouTube (và YouTube Music) nhận video **AV1** — Chrome của addon giải mã bằng CPU (không có giải mã
  phần cứng trong chế độ headless, đã thử GPU/VA-API), AV1 là loại nặng nhất. Nay tab YouTube/Nhạc chỉ báo hỗ trợ
  **H.264**, tối đa 720p/30 hình/giây (giống tab YouTube TV từ 2.9.5x). Tắt: `YT_H264=0`; giới hạn: `YT_MAX_HEIGHT`,
  `YT_MAX_FPS`.

## V2.9.69
### Tiết kiệm RAM máy chủ: ứng dụng nền lâu không dùng tự đóng, vẫn còn trong "Gần đây"

- Đo 30/09: máy HASS đã dùng ~2,9/3,3 GB swap (Frigate 2,4 GB, addon 1,7 GB). Tạm dừng tab nền (2.9.65) bớt CPU
  nhưng không bớt RAM. Nay ứng dụng nằm nền **quá 20 phút** thì đóng hẳn (`IDLE_TAB_CLOSE_MIN`); thẻ của nó **vẫn ở
  "Gần đây"** (ảnh thu nhỏ + trang cũ), chạm là mở lại đúng chỗ. Ứng dụng bị đóng vì vượt `MAX_APP_TABS` cũng vậy.
- Máy chủ còn dưới **600 MB** RAM khả dụng (`LOW_MEM_MB`): chỉ giữ 1 ứng dụng nền, đóng ứng dụng nền sau 3 phút.
- `/metrics` có thêm `host`: RAM tổng/khả dụng, swap tổng/đã dùng (MB).
- "Dùng lần cuối" của một ứng dụng nay tính từ lúc **rời** nó (trước: lúc mở) — ứng dụng vừa dùng lâu không bị đóng
  trước ứng dụng chỉ lướt qua.
- Thêm test tích hợp: tab nền được điều hướng **sang gốc khác** rồi hiện ra phải có hình ngay (chặn lớp lỗi "Not
  attached to an active page" đã gặp ở 2.9.48 và 2.9.68); đóng tab nhàn rỗi + mở lại từ "Gần đây".

## V2.9.68
### Sửa màn hình đứng hình khi HA mở URL; màn S3 không còn thanh âm lượng thừa

- Khi Home Assistant mở một URL (vd camera) cho **nhiều màn cùng lúc**, việc bật truyền hình cho tab đôi khi thất bại
  ("Not attached to an active page") mà vẫn bị đánh dấu là đã bật → màn hình đứng hình tới lần chuyển tab sau (log thật
  30/09). Nay: tab đang ở nền được **kích hoạt trước rồi mới điều hướng**, và lệnh bật truyền hình **thử lại** tối đa 4
  lần, chỉ đánh dấu khi thành công thật.
- Thanh trạng thái: thiết bị không có loa (màn S3) **không hiện thanh âm lượng** — thanh độ sáng chiếm cả hàng.
- Hai màn S3 cập nhật firmware mới (component chung với P4): có **giờ** trên nút giữa / màn hình chính và **thanh độ sáng**
  trong thanh trạng thái.

## V2.9.67
### YouTube TV mượt hơn; trợ lý giọng nói không tranh CPU với video

- **YouTube TV** (truyền từ điện thoại) phát toàn màn hình, nguồn thường chỉ 240–360p. Đo 30/09: 22,6 khung/giây,
  ~9 lần/giây phải nén lại khung (vượt trần gói 32 KB của P4), CPU addon ~285%. Nay riêng tab YouTube TV, khi nguồn
  ≤ 360p, server gửi khung **nửa độ phân giải** và P4 phóng ×2 bằng phần cứng — gần như không mất chi tiết, ít hơn ~4
  lần dữ liệu. YouTube thường và ứng dụng khác vẫn đủ độ phân giải. Tắt: `YT_TV_HALF_MAX_H=0`.
- **Báo thiết bị "đang phát media"** (DeviceControl trường 7) khi tab đang hiện hoặc nhạc/radio nền đang phát. Firmware
  P4 (`on_media_playing`) dùng để tạm dừng tự đánh thức + khử vọng (AEC) trong lúc phát. Firmware cũ bỏ qua.

## V2.9.66
### Sửa video tụt còn vài khung/giây hơn một phút sau khi chuyển ứng dụng

- Đo thật trên P4: quay lại YouTube → một cú dồn dữ liệu vài giây → bộ điều tiết giãn nhịp **50 → 400 ms** (2,5
  khung/giây) trong một bước, và ước lượng băng thông WiFi rớt còn 397 KB/s (thực tế đường truyền vừa chạy ổn
  ~860 KB/s). Sau đó chỉ tự nâng 5% mỗi 5 giây → video giật như trình chiếu hơn một phút.
- Nay: mỗi bước giãn nhịp tối đa gấp đôi; một lần đo lúc nghẽn làm ước lượng giảm tối đa 40%; không nghẽn thì tự nâng
  15% mỗi 5 giây (gấp đôi sau ~25 giây). Đường truyền yếu thật thì các lần đo sau vẫn kéo xuống như cũ.

## V2.9.65
### Đóng băng tab nền — sửa cho có tác dụng thật

- Bản 2.9.64 dùng lệnh đóng băng của Chrome (`Page.setWebLifecycleState`) nhưng **Chrome bỏ qua lệnh này** với tab
  "đang hiển thị" — mà ở chế độ chạy ẩn mọi tab đều được coi là hiển thị. Đo lại: tab "đóng băng" vẫn chạy đủ timer.
- Nay tab nền bị **tạm dừng JavaScript** (qua debugger của Chrome): không chạy timer, không xử lý dữ liệu, không vẽ lại.
  Quay lại ứng dụng thì chạy tiếp ngay, không tải lại. Đo trên Chromium: tải giả lập 80 → 1 vòng việc/4 giây.
- Video đang phát không thuộc JavaScript nên YouTube/TikTok/TV vẫn được dừng riêng khi rời, tab camera vẫn đóng hẳn.
- Thêm test tích hợp chứng minh tab nền thật sự dừng và chạy tiếp khi quay lại.

## V2.9.64
### Mượt hơn: tab nền không còn chạy ngầm

- **Đóng băng tab nền**: rời một ứng dụng thì tab của nó ngừng chạy (JavaScript, vẽ, giải mã video) cho tới khi quay
  lại — quay lại vẫn tức thì, không tải lại. Đo 30/09 trước bản này: addon giữ 8 tab, CPU 25–50% ngay cả khi không ai
  xem gì, máy HASS đã phải dùng 2,75 GB swap. Ngoại lệ: tab đang phát nhạc/radio nền, YouTube TV (giữ kết nối với
  điện thoại). Tắt bằng biến môi trường `FREEZE_BG_TABS=0`.
- **Tab camera đóng hẳn khi rời** (Camera P4, Camera nhà, trang xem một camera): luồng go2rtc không còn giải mã ngầm;
  mở lại mất khoảng 1 giây.
- **Màn hình chờ không hiện khi đang truyền YouTube từ điện thoại** (trước đây hiện đè lên giao diện TV giữa hai video).

## V2.9.63
### Truyền YouTube: hết giật, không lọt tiếng sang màn hình khác, chỉnh âm lượng từ điện thoại

- **Hết giật**: giao diện TV của YouTube chọn video cho TV (VP9/AV1, 1080p+, 60 hình/giây) mà Chrome của addon giải
  mã bằng CPU. Tab YouTube TV nay chỉ nhận **H.264, tối đa 720p, 30 hình/giây** (như tiện ích h264ify) — nhẹ hơn
  nhiều, vẫn nét trên màn hình 1024×600. Đổi được bằng biến môi trường `YT_TV_MAX_HEIGHT` / `YT_TV_MAX_FPS`.
- **Tắt tiếng THẬT theo tab** (mọi ứng dụng): lớp khoá âm thanh trước đây chỉ *báo* với trang là đang tắt tiếng, âm
  thanh vẫn ra đường tiếng chung của Chrome → truyền lên **S3 (không loa) thì tiếng lọt ra loa P4**. Nay tab bị khoá
  (màn hình không loa, tab chạy nền không phải Radio/Nhạc) bị tắt tiếng ở mức trình duyệt, kể cả tiếng Web Audio
  (chuông cửa, bíp hẹn giờ). Mở lại tab thì chỉ gỡ đúng phần lớp này đã tắt.
- **Tiêu điểm âm thanh** (như điện thoại): một ứng dụng của màn hình bắt đầu phát thì ứng dụng khác đang phát trên
  cùng màn hình tự dừng — vd Radio/Nhạc đang phát nền rồi truyền YouTube không còn hai tiếng chồng nhau. Ngắt truyền
  thì quay về ứng dụng trước (Radio), bấm phát lại nếu muốn.
- **Âm lượng trên điện thoại** chỉnh được âm lượng của YouTube TV (tab này không còn bị giả trạng thái muted/volume).
- Rời tab YouTube TV (mở ứng dụng khác khi đang truyền) thì video tự tạm dừng, như ứng dụng YouTube.
- Log addon ghi trạng thái âm thanh của trình phát khi bắt đầu truyền (`[cast] … dang phat — VIDEO muted=… vol=…`).

## V2.9.62
### Truyền YouTube từ điện thoại lên màn hình (như Smart TV)

- Mỗi màn hình hiện như **một TV** trong nút **Truyền** của app YouTube / YouTube Music (điện thoại cùng WiFi). Chọn
  → màn hình tự sáng, mở **YouTube TV** (giao diện TV, điều khiển bằng điện thoại: phát/dừng/tua/âm lượng/danh sách
  chờ). Ngắt truyền → đóng YouTube TV, quay về ứng dụng trước.
- Giao thức **DIAL** (SSDP UDP 1900 + HTTP cổng `dial_port`, mặc định 56790) — không phải Chromecast (Google khoá bằng
  chứng chỉ phần cứng), nên chỉ YouTube dùng được.
- **Cài đặt → Màn hình**: **Nhận truyền YouTube** (bật/tắt riêng từng màn hình) và **Tên khi truyền** (mặc định
  "Dashboard" + 4 ký tự cuối mã màn hình).
- Ứng dụng mới **YouTube TV** (nhóm Giải trí): mở tay để *Liên kết với mã TV* khi điện thoại không tự thấy màn hình.
- Tuỳ chọn addon mới: `cast_enabled`, `dial_port`. Server chỉ nhận các tham số an toàn từ điện thoại (mã ghép nối…),
  không cho máy lạ trong LAN điều hướng màn hình tới trang tuỳ ý.

## V2.9.61
### Màn hình chờ thành khung ảnh số: vuốt xem ảnh, hiệu ứng, album Google Photos, cài đặt trên màn hình

- **Vuốt trái / phải** trên màn hình chờ (đang hiện ảnh) = ảnh sau / trước (có lịch sử để lùi lại); **chạm** = thoát
  như cũ. Ứng dụng *Khung ảnh* cũng vuốt được.
- **Cài đặt → nhóm "Khung ảnh"** (riêng từng màn hình): **Đổi ảnh sau** 15 giây / 30 giây / 1 / 2 / 5 phút · **Hiệu ứng
  chuyển** Mờ dần / Trượt (theo hướng vuốt) / Thu phóng / Không · **Kiểu hiển thị** Lấp đầy / **Vừa khung** (giữ trọn
  ảnh, nền là chính ảnh đó làm mờ — như khung ảnh số) · **Thứ tự** Ngẫu nhiên (không lặp ảnh vừa xem) / Theo thứ tự ·
  **Nguồn ảnh** Thư mục / Google Photos / Cả hai · **Hiện đồng hồ** · **Hiện ngày chụp / album** (ngày EXIF + tên
  thư mục con) · **Album Google Photos** (dán link chia sẻ, dùng chung mọi màn hình; hoặc tuỳ chọn addon `gphotos_album`).
- **Album Google Photos chia sẻ**: không cần chép ảnh vào HA — server đọc danh sách ảnh của album (làm mới 30 phút),
  thu nhỏ vừa màn hình. Chỉ tải đúng ảnh thuộc album đã cấu hình. Lưu ý: dùng trang album công khai (Google không còn
  cho ứng dụng đọc thư viện ảnh từ 03/2025) — Google đổi trang thì có thể phải cập nhật addon; album lỗi mạng thì vẫn
  dùng ảnh thư mục.
- Màn hình S3 (giải mã chậm) luôn đổi ảnh không hiệu ứng để tiết kiệm băng thông.
- Gồm cả hai mục của 2.9.60 chưa vào bản trước: **Hiện màn hình chờ sau** và **Chào buổi sáng** riêng từng màn hình.

## V2.9.60
### Sửa: màn hình chờ / Khung ảnh hiện ảnh camera Frigate

- Chưa có thư mục **media/photos** thì 2.9.59 lùi về quét **cả /media** — trúng ảnh chụp phát hiện người của Frigate
  (/media/frigate) và trình chiếu lên màn hình chờ. Nay **chỉ đọc đúng media/photos**; chưa có thư mục thì chỉ hiện
  đồng hồ. Kể cả trong media/photos, các thư mục `frigate`, `clips`, `recordings`, `snapshots`… luôn bị bỏ qua.
- **Cài đặt trên màn hình → nhóm "Màn hình"** — chỉnh **riêng từng màn hình** (server lưu `/data/rwv-panel-prefs.json`;
  chưa chỉnh thì theo tuỳ chọn addon tương ứng):
  - **Hiện màn hình chờ sau**: Tắt / 1 / 2 / 5 / 10 phút (`screensaver_idle_s`).
  - **Màn hình chờ hiện ảnh** (`screensaver_photos`) — tắt thì ảnh biến mất ngay.
  - **Chào buổi sáng** (`morning_briefing`) — vd tắt ở phòng ngủ, giữ ở phòng khách.
- Sửa: mục *Máy chủ (addon)* ở Chẩn đoán hiện sai phiên bản (package.json không được tăng theo addon) — thêm test giữ khớp.

## V2.9.59
### Bốn ứng dụng mới cho ngôi nhà: Phòng, Điều khiển, Việc cần làm, Khung ảnh

- **Phòng** (nhóm Nhà): điều khiển theo **khu vực** của Home Assistant — đèn, công tắc, quạt, rèm, điều hoà, TV/loa.
  Chạm = bật/tắt; chạm giữ đèn → thanh độ sáng; rèm → Mở/Dừng/Đóng; điều hoà → nhiệt độ ± và chế độ. Đầu mỗi phòng:
  nhiệt độ, độ ẩm, số đèn đang bật, cửa đang mở, có người. Không cần cấu hình: gán thiết bị vào khu vực trong HA.
- **Điều khiển** (nhóm Nhà): mọi TV / loa / Chromecast — ảnh bìa, bài đang phát, phát/tạm dừng, bài trước/sau,
  âm lượng, tắt tiếng, bật/tắt. Thiết bị đang phát xếp lên đầu.
- **Việc cần làm** (nhóm Tiện ích): danh sách việc / đi chợ của HA (tích hợp *Danh sách mua sắm*, *Local To-do*,
  Google Tasks…), dùng chung với app HA trên điện thoại. Thêm nhanh bằng chip (Sữa, Trứng, Gạo…) hoặc gõ; chạm để
  đánh dấu xong; xoá mục đã xong (chạm 2 lần).
- **Khung ảnh** (nhóm Giải trí): trình chiếu ảnh gia đình từ thư mục **media/photos** của HA (chỉ thư mục này), thu nhỏ vừa
  màn hình ở server, xoay theo EXIF, đổi ảnh mỗi 30 giây, kèm đồng hồ và ngày âm lịch. Chạm để hiện nút. Đang mở
  Khung ảnh thì màn hình chờ không che lên.
- An toàn: API mới (`/ha/rooms`, `/ha/act`, `/ha/todo`, `/photos/*`) **chỉ nhận từ chính addon** (trình duyệt của
  panel), máy khác trong LAN không điều khiển được; chỉ một danh sách thao tác cố định (không khoá cửa, không báo động).
- Addon được quyền **đọc** thư mục media (`map: media`) — cần khởi động lại addon sau khi cập nhật.
- **Màn hình chờ hiện ảnh**: có ảnh trong media/photos thì màn hình chờ hiện ảnh gia đình (đổi mỗi phút), đồng hồ ở
  góc; ban đêm (22h–6h) chỉ đồng hồ tông tối. Tuỳ chọn `screensaver_photos`.
- **Chào buổi sáng**: lần đầu trong ngày camera thấy người (06:00–09:30, tuỳ chọn `morning_window`) → mở ứng dụng
  mới **Hôm nay** (thời tiết, lịch hôm nay từ mọi calendar của HA, việc cần làm, ghi chú) và đọc tóm tắt qua loa của
  chính màn hình (`tts.speak`, ưu tiên Piper) — đọc **tắt mặc định**, chỉ hiện chữ; bật bằng `morning_tts: true`.
- **Bảng tin gia đình**: ghi chú dạng giấy nhớ dùng chung mọi màn hình; viết trên panel hoặc gửi từ HA / điện thoại
  (`POST /board`), có thẻ thông báo "Ghi chú mới"; ghim / xoá.
- **Chuông cửa**: HA gọi `POST /doorbell {camera, unlock?}` → mọi màn hình sáng lên, camera cổng toàn màn hình, chuông
  kêu, nút **Mở cổng** (chạy đúng script/button/lock đã khai) và **Đóng**; hết giờ tự quay về ứng dụng trước.
- **Solar**: ứng dụng mở trang solar.example.com, **thay cho** ứng dụng *Năng lượng* (trang Energy của HA) — đã bỏ.
- Sửa: Shell không còn chạy trong iframe của trang (thẻ iframe trên dashboard HA từng có thêm nút/thanh thừa bên trong).

## V2.9.58
### Màn hình chính sắp xếp được, thư mục, bố cục S3, trợ lý giọng nói, dò người bằng camera

- **Sắp xếp màn hình chính (OS-3)**: chạm giữ một ứng dụng ~0,5 giây để vào chế độ sắp xếp và kéo nó đi luôn. Kéo sang
  cạnh ứng dụng khác thì đổi chỗ; thả **vào giữa** ứng dụng khác thì tạo **thư mục** (tên tự đặt theo nhóm, chạm chip để
  đổi tên); kéo xuống/ra khỏi dock (tối đa 5); giữ sát mép thì sang trang. Chạm thư mục để mở; kéo ứng dụng ra ngoài
  khung thư mục để lấy ra. **Xong** hoặc chạm chỗ trống để thoát; **Đặt lại** (chạm 2 lần) về mặc định.
  Bố cục lưu ở server (`/data/launcher.json`, khoá `home`), dùng chung cho cả 3 màn hình, màn khác cập nhật ngay.
  Lưu cấu hình ở trang Menu panel **không** xoá bố cục này.
- **Lưới tự tính số hàng** theo chiều cao màn hình: P4 1024×600 được 3 hàng, S3 480×480 được 3 hàng (trước 2), S3
  480×272 được 2 hàng (trước 1; bỏ hàng đồng hồ/thời tiết, đồng hồ vẫn ở thanh kéo xuống) (OS-6).
- **Trợ lý giọng nói** (cần firmware mới, `on_assist` + `voice_assistant`): thẻ ở cuối màn hình hiện *Đang nghe… →
  Đang xử lý… "câu bạn nói" → câu trả lời*; chạm thẻ để dừng/đóng. Nút **Trợ lý** trong thanh kéo xuống (chỉ hiện khi
  firmware hỗ trợ). Trợ lý nghe thì màn hình chờ tắt.
- **Có người trước màn hình** (firmware `camera_motion`): server nhận sự kiện, ghi log `[presence]`.
- Giao thức: gói mới `DeviceEvent = 12` (thiết bị → server), trường `Assist = 6` của `DeviceControl`.

## V2.9.57
### Ứng dụng "Cài đặt" ngay trên màn hình (OS-4)

- Ứng dụng mới **Cài đặt** (menu *Tiện ích*, và lối tắt trong thanh kéo xuống): chỉnh mọi thiết lập của **chính màn hình
  đang cầm** mà không cần mở Home Assistant — đèn nền, Màn hình chờ, Sleep time, âm lượng, xoay màn hình, Home URL,
  địa chỉ server, khởi động lại (chạm hai lần để xác nhận)… cùng mục **Chẩn đoán** (WiFi, tải CPU, bộ nhớ, thời gian
  giải mã, băng thông, phiên bản addon).
- Không cần cấu hình gì: server tìm thiết bị ESPHome trong Home Assistant theo **địa chỉ MAC** của màn hình và lấy mọi
  thực thể của nó — dùng chung cho cả 3 màn hình. Nhóm theo phân loại của HA (Điều khiển / Cấu hình / Chẩn đoán).
- An toàn: chỉ trang Cài đặt mới ghi được, chỉ vào thực thể của chính màn hình đó; nút *Factory reset* không bao giờ
  hiện. Thực thể bị ẩn/tắt trong HA cũng không hiện.

## V2.9.56
### Nút "Luôn sáng" đổi thành "Màn hình chờ"

- Cùng công tắc *No Sleep* của màn hình, nay mang đúng ý nghĩa: **bật** = không tự tắt đèn nền, rảnh thì hiện màn hình
  chờ (đồng hồ lớn, ngày âm dương, thời tiết); **tắt** = tắt đèn nền sau *Sleep time*. Biểu tượng đồng hồ thay cho con mắt.
- Nên đổi luôn tên công tắc trong YAML thiết bị (`name: "Màn hình chờ"`) cho khớp trên Home Assistant.

## V2.9.55
### Sửa: màn hình chờ che mất video / dashboard khi mở từ Home Assistant

- Lỗi từ 2.9.52: màn hình chờ chỉ coi **cú chạm** là "đang dùng". Mở video / "URL hiển thị" / Go Home từ HA thì tab mới
  bị phủ màn hình chờ sau vài giây (video chưa kịp phát), Go Home về đúng trang cũ thì màn hình chờ nằm nguyên.
- Nay mọi thao tác chủ động đều tính là hoạt động và **tắt màn hình chờ ngay** (cả ở tab cũ): mở URL, Go Home, mở /
  chuyển ứng dụng, đèn nền vừa bật lại, trang bắt đầu phát video/âm thanh, trang tự điều hướng. Log ghi
  `[saver] …: tat man hinh cho (<lý do>)`.

## V2.9.54
### Hỗ trợ phản hồi chạm tức thì trên thiết bị

- Firmware mới (tuỳ chọn `touch_feedback: true`, P4) vẽ **vòng tròn tại điểm chạm ngay trên thiết bị**, không chờ
  server (~100–250 ms đi-về). Khi nhấc tay, thiết bị gửi gói mới `RepaintRect` xin server **vẽ lại đúng vùng đó** —
  server ép gửi lại các ô ảnh ở vùng này kể cả khi trang đứng yên, nên vòng tròn tự biến mất.
- **Cập nhật addon này TRƯỚC khi nạp firmware có `touch_feedback`**: server cũ không hiểu gói mới, vòng tròn sẽ đọng lại
  tới khi vùng đó đổi nội dung.

## V2.9.53
### Thông báo từ Home Assistant + Không làm phiền (OS-5)

- **Thông báo lên màn hình**: tự động hoá HA gọi `rest_command` (hướng dẫn trong mục *Thông báo từ Home Assistant*
  của tài liệu addon) → thẻ nổi trượt xuống từ mép trên. Ba mức: thường (tự ẩn), **cao** (bật sáng màn hình + chuông
  ngắn), **khẩn cấp** — chuông cửa, báo cháy (bật sáng + chuông, giữ tới khi chạm). Kèm được **ảnh camera** (tên luồng
  go2rtc); chạm vào thẻ mở ứng dụng/URL kèm theo (vd mở Camera nhà).
- **Danh sách thông báo** trong thanh kéo xuống (chạm để mở, ✕ để xoá, Xoá hết); chấm cam cạnh đồng hồ khi còn
  thông báo.
- **Không làm phiền**: ô mới trong thanh kéo xuống, có trên cả 3 màn hình. Bật thì thông báo thường/cao chỉ vào danh
  sách; khẩn cấp vẫn báo. Nhớ qua khởi động lại addon.
- Màn hình hẹp (480): hàng ô nhanh chỉ còn biểu tượng để vừa một hàng.
- **Sửa bộ điều tiết không lùi nhịp khi WiFi nghẽn** (thấy trong log 2.9.52 trên P4 xem YouTube: "bo khung, ton dong
  socket" liên tục mà nhịp vẫn giữ 33 ms): trước đây nó chỉ đọc lượng tồn đọng đúng lúc kiểm tra (5 s/lần), lúc socket
  vừa xả bớt. Nay nó nhớ mức tồn đọng cao nhất ở các lần phải bỏ khung giữa hai lần kiểm tra → thấy nghẽn thật, giãn
  nhịp cho vừa đường truyền (ít khung bị bỏ, hình đều hơn).

## V2.9.52
### Cử chỉ kiểu điện thoại (Quay lại, giữ để mở Gần đây) + Màn hình chờ

**Màn hình chờ (mới)**
- Không chạm một lúc (mặc định **2 phút**, tuỳ chọn *Màn hình chờ sau (giây)*, 0 = tắt) thì hiện màn hình chờ: đồng
  hồ lớn, ngày dương/âm, thời tiết trên nền đen. Nội dung **dịch chỗ mỗi phút** để chống lưu ảnh; **từ 22h đến 6h
  chuyển tông ấm tối** cho dễ chịu trong phòng ngủ. Chạm vào là tắt (cú chạm đó không bấm nhầm vào trang bên dưới).
- Không hiện khi đang phát video/camera (YouTube, Camera nhà…) hoặc khi màn hình đã tắt đèn nền. Hợp nhất khi bật
  "Luôn sáng": panel thành đồng hồ để bàn thay vì đứng im một trang dashboard.

**Vuốt lên từ mép dưới rồi giữ = Gần đây**
- Vuốt lên qua ngưỡng rồi **giữ yên ~0,35 giây** → mở Gần đây (như điện thoại); vuốt lên rồi thả ngay → Màn hình
  chính như cũ. Khi vuốt có thanh chỉ báo ở mép dưới đi theo ngón tay với gợi ý "Thả: Màn hình chính · Giữ: Gần đây".
- Sửa: chống dội sự kiện di chuyển ngón tay trước đây dùng chung cho mọi màn hình — hai panel được chạm cùng lúc thì
  cử chỉ trên panel này có thể bị giật do panel kia. Nay tách riêng từng màn hình.

**Quay lại**

- **Vuốt từ mép trái hoặc mép phải vào trong** = Quay lại trang trước trong ứng dụng đang mở (kể cả chuyển trang trong
  dashboard Home Assistant, YouTube, tin tức…), như Android. Đang ở trang đầu của ứng dụng thì về màn hình chính.
- Khi vuốt, một bong bóng mũi tên hiện ở mép theo ngón tay (P4) và **đổi màu khi đã đủ xa** — thả tay lúc đó là quay
  lại, thả sớm hơn là huỷ. Chạm nhanh sát mép hoặc kéo dọc sát mép vẫn là thao tác bình thường của trang.
- Dải nhận cử chỉ ở mép rất mỏng (18 px trên màn 1024, 12 px trên màn 480) để không vướng thao tác của trang.

## V2.9.51
### OS-3 bước 1 — màn hình "Gần đây" (đa nhiệm)

- Nút **Gần đây** trong thanh kéo xuống và ở cuối dock của màn hình chính: hiện ảnh chụp từng ứng dụng đang mở (mới
  dùng nhất trước). **Chạm** một thẻ để chuyển sang ứng dụng đó (tức thì, không tải lại); **✕** hoặc **vuốt thẻ lên**
  để đóng ứng dụng; **Đóng tất cả** đóng mọi ứng dụng phụ (Home Assistant luôn giữ). Chạm vùng trống để thoát.
- Ảnh thu nhỏ được chụp lúc rời mỗi ứng dụng (~10 KB/ảnh, không tốn băng thông khi không mở Gần đây).
- **URL từ Home Assistant mở vào đúng ứng dụng**: đặt "URL hiển thị" (hoặc tự động hoá) thành một link YouTube /
  TikTok / trang của ứng dụng trong menu thì nó mở trong đúng ứng dụng đó (tự dừng khi rời đi, hiện đúng tên trong Gần
  đây) thay vì tab "Trình duyệt" chung.
- **Giao diện thống nhất cho các ứng dụng hệ thống** (Thời tiết, Hẹn giờ, Radio, Lịch, Cảnh, Camera nhà): dùng chung
  một bộ màu nền/bề mặt/chữ/bo góc với thanh kéo xuống và màn hình chính (`public/ui.css`), mỗi ứng dụng chỉ giữ một
  màu nhấn riêng — chuyển qua lại giữa các ứng dụng giờ trông như một hệ điều hành. Trang lỗi/trống có biểu tượng,
  giải thích và nút "Thử lại" (`public/ui.js`). Sửa chữ bị ngắt dòng trên màn 480×272 (Hẹn giờ).
- Sửa log bị spam `[Self test] Frame render time: 0ms` mỗi 5 giây khi không chạy self-test, và lỗi sau một lần
  self-test thì trang kết quả bị tải lại mỗi 5 giây.

## V2.9.50
### Sửa hai lỗi OS-2 do bộ thử tích hợp phát hiện + CI

- **Sửa "URL hiện tại" không cập nhật khi mở đúng Home URL** (lỗi từ 2.9.47): lúc kết nối hoặc khi bấm Go Home,
  nếu trang mở ra đúng URL đã xin, server không báo URL về thiết bị (cảm biến "URL hiện tại" trên HA giữ giá trị cũ),
  và bước khẳng định lại quyền phát tiếng sau khi điều hướng cũng bị bỏ qua.
- **Sửa "Frame error" liên tiếp khi mở ứng dụng mới**: khung hình đổi kích thước giữa chừng (tab vừa bật truyền hình)
  làm bộ chia ô tính ra cạnh âm và bỏ khung. Nay tự tạo lại lưới ô và gửi cả khung; log ghi
  `[frame] kich thuoc khung doi AxB -> CxD` mỗi lần như vậy.
- **Bộ thử tích hợp + CI**: server thật + Chromium thật + panel giả chạy trên GitHub Actions cho mỗi PR — hai lỗi
  ngay trên được chính bộ thử này phát hiện.

## V2.9.49
### Thẻ "Đang phát" + sửa hai lỗi của OS-2

- **Thẻ "Đang phát" trong thanh kéo xuống**: khi Radio/Nhạc đang phát nền (bạn đã mở ứng dụng khác), thanh kéo xuống
  hiện một thẻ với nút **Mở** (quay lại ứng dụng đó) và nút **■** (dừng ngay). Trước đây chỉ dừng được bằng cách mở lại
  đúng ứng dụng rồi bấm dừng trong trang. Màn hình thấp (480×272) xếp các thẻ thành một hàng ngang cho vừa màn hình.
- Server nay biết trang **thật sự đang phát** hay không (thay vì coi Radio/Nhạc luôn phát kể từ lúc mở). Radio đã dừng
  được đóng như ứng dụng thường khi vượt `MAX_APP_TABS`, không còn chiếm chỗ mãi.
- **Sửa rò tab Chromium**: hai lệnh mở cùng một ứng dụng sát nhau (chạm đúp biểu tượng, vuốt về màn hình chính lặp
  lại nhanh) có thể tạo HAI tab cho cùng ứng dụng; tab thừa không bao giờ bị đóng, mỗi lần tốn thêm một tiến trình
  Chrome (100–250 MB). Đã tái hiện: 3 cử chỉ về Home sát nhau → 3 tab màn hình chính; nay luôn đúng 1. Các lệnh
  mở/chuyển ứng dụng của một màn hình giờ chạy lần lượt.
- **Sửa ứng dụng bị đổi biểu tượng mất hành vi riêng**: đổi biểu tượng Radio/Nhạc ở trang "Menu panel" làm chúng mất
  khả năng phát nền, đổi biểu tượng YouTube/TikTok làm chúng không tự dừng khi rời ứng dụng.

## V2.9.48
### Sửa lỗi "Not attached to an active page" khi mở/chuyển ứng dụng (OS-2)

- Bản 2.9.47 đôi khi báo lỗi CDP khi mở tab mới, do điều hướng (đổi trang) được gọi TRƯỚC khi bật truyền hình cho
  tab đó — điều hướng sang gốc khác (ví dụ mở dashboard Home Assistant) có thể khiến Chrome đổi tiến trình dựng
  trang đúng lúc, làm mất kết nối tạm thời. Nay tab luôn được bật truyền hình trên trang trắng ổn định trước, rồi
  mới điều hướng — đúng thứ tự bản gốc một-tab đã dùng an toàn từ đầu.

## V2.9.47
### Giai đoạn OS-2 — mỗi ứng dụng một tab Chromium riêng

- **Mở ứng dụng không còn tải lại trang.** Home Assistant, Camera, Cảnh, Thời tiết, Radio… mỗi ứng dụng chạy trong
  một tab Chromium riêng, giữ nguyên trạng thái (cuộn, video đang phát…). Quay lại Home Assistant từ ứng dụng khác
  gần như tức thì thay vì tải lại dashboard 2–4 giây.
- **Radio/Nhạc phát nền:** mở Radio rồi chuyển sang ứng dụng khác, tiếng vẫn tiếp tục — cho tới khi mở lại Radio và
  bấm dừng. YouTube/TikTok thì ngược lại: rời trang là tự dừng phát, tránh tiếng chồng lên ứng dụng khác.
  Do kiến trúc dùng chung một tiến trình Chrome, tại một thời điểm chỉ MỘT tab được phép phát tiếng ra loa; server
  tự khoá/mở âm thanh theo tab đang hiện hoặc được đánh dấu "phát nền".
  - **Chỉ MỘT tab được truyền hình** — tab đang hiện trên màn hình; các tab khác vẫn chạy JavaScript bình thường
    (kể cả phát nhạc) nhưng không tốn công mã hoá/truyền ảnh.
  - Tối đa 2 ứng dụng "phụ" mở cùng lúc mỗi màn hình (Home Assistant và màn hình chính không tính, luôn giữ);
    ứng dụng cũ nhất tự đóng khi mở thêm — trừ khi đang phát nhạc nền hoặc đang hiện. Chỉnh qua biến môi trường
    `MAX_APP_TABS` (mặc định 2, xem DOCS.md mục Nâng cao).
  - "Trang chủ" đổi tên hẳn thành ứng dụng **Home Assistant**; nút/thực thể "Go Home" của ESPHome vẫn luôn đưa tab
    này về đúng Home URL dù đang ở trang con nào của HA.

## V2.9.46
### Đồng hồ ở giữa mép trên chỉ để xem giờ

- Không bấm vào đồng hồ để mở thanh trạng thái nữa: nó nằm đè dải tab của Home Assistant nên bấm tab hay bị bắt nhầm.
  Chạm vào vùng đó giờ đi thẳng xuống trang. Thanh trạng thái chỉ mở bằng **vuốt từ mép trên xuống**.

## V2.9.45
### Giao diện kiểu hệ điều hành — giai đoạn OS-1

- **Kéo từ mép trên xuống** (ở bất kỳ vị trí nào trên mép, trên mọi trang) mở **thanh trạng thái**:
  - giờ, ngày dương/âm lịch, thời tiết, hẹn giờ
  - ô Luôn sáng / Tắt tiếng / Khử vọng
  - thanh trượt độ sáng / âm lượng
  - biểu tượng **Ứng dụng · Home Assistant · Camera · Cảnh**

  Trên P4 thanh chạy theo ngón tay. Chạm nền mờ hoặc vuốt lên thì đóng. Nút đồng hồ ở giữa vẫn như cũ.
- **Vuốt lên từ mép dưới** → **Home của OS**: màn hình chính với đồng hồ lớn, thời tiết, lưới ứng dụng chia trang
  (vuốt ngang), dock (Home Assistant đứng đầu).
- Cử chỉ được nhận diện **ở server**, trước khi chạm tới trình duyệt, nên chạy được trên mọi trang. Chạm nhanh ở mép
  vẫn là chạm của trang.
- "Trang chủ" thành ứng dụng **Home Assistant** (logo HA). Nút / thực thể Go Home của ESPHome vẫn về `home_url`.
- Giao diện hệ thống tách thành mã riêng (`src/shell/`, đóng gói esbuild, Shadow DOM), thay popup cũ (~500 dòng JS
  trong chuỗi). CSS của trang web không còn làm vỡ giao diện (ví dụ font đồng hồ).
- Mức chuyển động theo màn hình: P4 đầy đủ, S3 480×480 giảm, S3 480×272 tối thiểu.

## V2.9.44
### Tài liệu addon, cấu hình gọn hơn

- **Tab Tài liệu** của addon (`DOCS.md`): addon là gì, để làm gì, cần gì, bắt đầu từ đâu, dùng hằng ngày, điều khiển
  từ Home Assistant, tuỳ chọn, cổng, hiệu năng đo thực tế, bảo mật, xử lý sự cố.
- Phần **Cấu hình** có tên và giải thích tiếng Việt cho từng tuỳ chọn (`translations/vi.yaml`, kèm bản tiếng Anh).
- Bỏ `launcher_apps` / `launcher_hide`: menu giờ chỉnh ở trang **Menu panel**.
- `expose_debug_proxy` / `debug_proxy_port` **nay chạy thật**. Trước đây hai tuỳ chọn này có trên giao diện nhưng không
  được dùng ở đâu cả; nay có proxy TCP nối cổng DevTools ra LAN (mặc định tắt).
- Bỏ `aarch64` khỏi danh sách kiến trúc: image chỉ có bản amd64 (Google Chrome cho Linux không có bản ARM), nên máy
  ARM trước đây thấy addon nhưng cài lỗi.
- README viết lại theo hiện trạng dự án; `docker-compose.rwv.yml` dùng đúng image của dự án.

## V2.9.43
### Trang "Menu panel" trên thanh bên Home Assistant: cấu hình menu bằng giao diện

- Addon có trang riêng trên thanh bên HA (ingress, cần đăng nhập HA). Trang liệt kê **mọi ứng dụng** theo nhóm, mỗi
  ứng dụng có:
  - công tắc Hiện/Ẩn (thay `launcher_hide`)
  - nút ↑↓ đổi thứ tự
  - nút Sửa: tên, nhóm, **biểu tượng MDI** (cùng bộ HA dùng, tìm kiếm ~7.000 biểu tượng, có gợi ý sẵn), **màu**
    (bảng 18 màu + bộ chọn màu)
- Thêm hoặc xoá ứng dụng của riêng bạn. Bấm Lưu thì menu trên mọi panel cập nhật ngay.
- Cấu hình lưu tại `/data/launcher.json`, còn nguyên qua các lần cập nhật. Server tải hình SVG của biểu tượng MDI một
  lần (lưu đệm `/data/mdi-cache.json`) rồi chèn vào menu, nên panel không phải tải gì thêm.
- Chỉ lưu được qua trang trong HA; máy khác trong LAN gọi thẳng cổng 18080 thì bị từ chối.
  `launcher_apps` / `launcher_hide` cũ vẫn được áp dụng.

## V2.9.42
### Hoàn thiện menu và các ứng dụng

- Launcher dùng chuỗi font cố định: `system-ui` trong container trỏ tới font đơn cách, nên đồng hồ trên nút và báo
  thức trông như chữ máy đánh ở các trang ứng dụng.
- Hẹn giờ: nút hẹn nhanh ghi "1 phút", "3 phút"…
- Cảnh: khi chưa có scene nào thì có gợi ý cách tạo trong HA.
- Radio: ghi rõ cần ~10 giây để bắt đầu phát. Đo thật: máy chủ VOV giới hạn tải đúng bằng tốc độ phát (256 kbit/s),
  mỗi đoạn 10 giây mất ~10 giây để tải; sau đó phát liên tục.

## V2.9.41
### Menu ứng dụng đầy đủ: thông tin + điều khiển nhanh + 15 ứng dụng chia nhóm

- **Hàng thông tin:** giờ lớn, thứ/ngày dương và âm lịch (thuật toán Hồ Ngọc Đức, `public/lunar.js`), ô hẹn giờ đang
  chạy, ô thời tiết thu gọn cho vị trí nhà (server lấy 15 phút/lần). Chạm ô thời tiết hoặc hẹn giờ để mở ứng dụng.
- **Hàng điều khiển:** hai thanh trượt, cộng 3 nút tròn: Luôn sáng, Tắt tiếng, Khử vọng mic (firmware có
  `on_set_no_sleep` / `on_set_mute` / `on_set_aec`).
- **Ứng dụng chia nhóm:**
  - Nhà: Trang chủ, Camera P4, **Camera nhà**, **Cảnh**, **Năng lượng**
  - Giải trí: YouTube, TikTok, **Nhạc**, **Radio**, **Tin tức**, Media
  - Tiện ích: Thời tiết, **Lịch**, **Hẹn giờ**, Trình duyệt
- **Ứng dụng mới:**
  - Camera nhà: lưới ảnh chụp các camera go2rtc, làm mới lần lượt; chạm để xem trực tiếp.
  - Cảnh: nút chạy scene/script của HA.
  - Lịch: lịch tháng âm dương, can chi, ngày lễ.
  - Radio: VOV1, VOV2, VOV3, VOV5.
  - Hẹn giờ: server giữ giờ nên vẫn reo khi đã chuyển trang. Hết giờ thì bật màn hình, hiện báo thức toàn màn hình
    và phát chuông ra loa P4.
- **Tự thêm/ẩn ứng dụng** trong cấu hình addon: `launcher_apps` (label, url, group, icon, color) và `launcher_hide`
  (theo tên).

## V2.9.40
### Thời tiết: chọn tỉnh, thành phố bằng danh sách thả xuống

- Chạm tên nơi chốn (có mũi tên ▾) để mở danh sách **34 tỉnh, thành phố** (đơn vị hành chính từ 1/7/2025). Ô chứa
  thành phố trực thuộc trung ương đứng đầu, tiếp theo là các tỉnh theo thứ tự ABC, mỗi ô ghi thêm nơi đặt trụ sở
  (toạ độ thời tiết lấy ở đó). Nơi đang xem được tô sáng.
- Dòng đầu "Nhà (Home Assistant)": quay về vị trí nhà. Lựa chọn được ghi nhớ.
- Bỏ ô gõ tìm kiếm (không cần bàn phím ảo).

## V2.9.39
### Thời tiết: dùng vị trí nhà trong Home Assistant

- Thứ tự vị trí: nơi bạn tự chọn → **vị trí nhà trong HA** (Cài đặt → Hệ thống → Chung) → đoán theo IP → Hà Nội.
  Từ HA chỉ lấy toạ độ và tên nhà; dữ liệu thời tiết vẫn từ Open-Meteo.
- Addon cần quyền `homeassistant_api` (thêm trong bản này): server đọc `/api/config` bằng SUPERVISOR_TOKEN của chính
  addon, không cần mật khẩu hay token của người dùng. Endpoint `/weather-location` chỉ ở cổng 18080 (LAN).
- Bảng chọn nơi chốn có nút "Vị trí nhà (Home Assistant)" để bỏ lựa chọn tay. Lời nhắc "vị trí đoán theo mạng"
  chuyển xuống dòng cập nhật, không còn cắt tên nơi chốn.

## V2.9.38
### Thời tiết: đoán vị trí ổn định hơn, ô chỉ số không bị cắt chữ

- Đoán vị trí theo IP thử lần lượt ipwho.is → geojs.io → Hà Nội (đo thật: ipwho.is trả 429 khi gọi nhiều). Vị trí
  đoán hiện "(theo mạng — chạm để chọn)", vì ở Việt Nam đoán theo IP có thể lệch tỉnh. Vị trí đã chọn được ghi nhớ.
- Hướng gió lên nhãn ("Gió Đông Nam"), giờ mọc/lặn gọn một dòng: hết bị cắt "…" ở màn 1024×600.

## V2.9.37
### Menu ứng dụng: đồng hồ, thanh trượt độ sáng/âm lượng, ứng dụng Thời tiết

- Nút giọt nước ở giữa mép trên hiện **đồng hồ HH:MM theo giờ của chính thiết bị** (RTC RX8130 + SNTP trên P4). Thiết
  bị gửi gói `DeviceState` (loại 10) khi kết nối, khi đổi độ sáng/âm lượng và mỗi 30 s. Trang tự đếm giây từ độ lệch
  đồng hồ và múi giờ của thiết bị, chỉ vẽ lại khi đổi phút. Thiết bị cũ (không báo giờ) vẫn hiện mũi tên như trước.
- Đầu popup ứng dụng có **hai thanh trượt kiểu trung tâm điều khiển điện thoại**: độ sáng màn hình và âm lượng video
  web. Kéo → gói `DeviceControl` (loại 9) gửi thẳng, không xếp sau khung hình. Chỉ hiện khi firmware báo `?ctl=1`.
  Tiêu đề popup hiện thứ/ngày theo giờ thiết bị.
- Ứng dụng mới **Thời tiết** (`/weather.html`):
  - Dữ liệu từ web: Open-Meteo, gồm dự báo và chất lượng không khí, không cần khoá API, không lấy từ Home Assistant.
  - Nội dung: hiện tại (nhiệt độ, cảm giác, độ ẩm, gió, UV, AQI/PM2.5, mặt trời), 24 giờ tới, 7 ngày.
  - Vị trí: lần đầu đoán theo IP; chạm tên nơi chốn để tìm và đổi (tìm được địa danh tiếng Việt).

## V2.9.36
### Sửa tiếng "tách tách" khi phát âm thanh trang (YouTube)

- Đo: nguồn Chrome/PulseAudio sạch (tone 1 kHz, 0 chỗ đứt); P4 không bỏ byte nào. Lỗi ở server: bộ hẹn giờ 40 ms
  chạy ~41 ms, mỗi nhịp chỉ gửi MỘT khung → gửi 31,2 KB/s cho nguồn 32 KB/s → bộ đệm đầy, bị cắt ~190 lần/30 s, mỗi
  lần cắt là một tiếng tách. Nay mỗi nhịp gửi mọi khung đã đủ.

## V2.9.35
### Chẩn đoán âm thanh (tiếng tách khi xem YouTube)

- Log `[audio-diag]` mỗi 30 s: số khung âm thanh đã gửi (lẽ ra ~750), số lần/số byte phải CẮT vì bộ đệm đầy, số nhịp
  40 ms bị trễ và trễ lớn nhất, mức bộ đệm lớn nhất.

## V2.9.34
### Popup ứng dụng: nền đục hoàn toàn

- Trên dashboard HA tối, nền popup 97% vẫn để lộ mờ chữ phía sau. Nay nền đục hoàn toàn, lớp phủ tối hơn (55%).

## V2.9.33
### Nút mở rộng thành POPUP ỨNG DỤNG

- Thay dropdown bằng popup chiếm 2/3 màn hình, cách đều 4 cạnh, trên lớp phủ mờ: lưới ứng dụng (icon màu + tên) —
  Trang chủ, YouTube, TikTok, Camera, Trình duyệt (ô nhập URL + bàn phím ảo), Media (trình duyệt media của HA).
  Chạm ra ngoài popup → ẩn; chọn ứng dụng → ẩn rồi mở. Kích thước theo `vmin`: vừa 1024×600, 480×480, 480×272
  (tên dài xuống 2 dòng). Không hiệu ứng động (mỗi khung động phải truyền qua mạng).

## V2.9.32
### Sau khi thiết bị nối lại, điều tiết không còn kẹt ở nhịp thấp

- Lúc thiết bị khởi động lại/OTA, server vẫn đẩy dữ liệu vào socket cũ đã chết → ghi nhận "nghẽn" ở 255–400 ms. Ngưỡng
  tránh nghẽn đó theo sang phiên mới: mỗi 35 s chỉ hồi 17 ms → P4 YouTube 2,8 fps suốt hàng chục phút. Nay khi thiết
  bị nối lại: xoá ngưỡng tránh nghẽn, bắt đầu lại từ nhịp an toàn (≤ 200 ms) và rút dần như bình thường.

## V2.9.31
### P4: hồi nhịp nhanh sau nghẽn thoáng qua

- Chạy thử 10 phút: WiFi chập chờn ở ~1 MB/s làm tồn đọng vượt ngưỡng vài phút một lần; bước giãn tối thiểu 50 ms
  (33 → 83 ms) và hồi chậm (45–60 s) kéo trung bình xuống ~17 fps. Hồ sơ `?fb=1`: bước 17 ms, hồi sau 1 mẫu tốt,
  chờ 5 s.

## V2.9.30
### Điều tiết riêng cho thiết bị giải mã thẳng vào framebuffer (P4): YouTube đủ độ phân giải 24 fps

- Thiết bị `?fb=1`: ngân sách xử lý 1,3 × nhịp (nhận/giải mã song song), tồn đọng cho phép 192 KB, giãn nhịp ×1,5.
  Mặc định cũ (0,5 / 96 KB / ×2) đặt cho khung ~20 KB → giữ P4 ở ~7 fps khi gửi đủ độ phân giải.
- Đo (P4, camera Frigate 5 fps, YouTube trong trang, YAML `full_frame_area_threshold: 0.8`): **24,3 fps đủ độ phân
  giải**, 34 KB/khung, không mất kết nối. (Mốc: 7,2 fps.)

## V2.9.29
### Khung đầy đủ chia dải ngang cho thiết bị giải mã thẳng vào framebuffer (`?fb=1`, P4)

- Thiết bị báo `fb=1` → khung đầy đủ chia thành dải rộng bằng màn hình, cao bội 16 (1024×600: 24 + 4×144) thay cho
  4 phần tư. P4 giải mã từng dải thẳng vào framebuffer màn hình — bỏ bước chép DMA2D 1,2 MB/khung (giảm tải PSRAM,
  thứ làm vòng lặp chính P4 chậm tới 154 ms khi ~20 fps).

## V2.9.28
### Tinh chỉnh lúc chạy qua `/data/rwv-tuning.json` (không cần khởi động lại)

- Mỗi lần `docker restart` để thử một tham số, Supervisor tạo lại container → bản vá nóng mất giữa lượt đo. Nay server
  đọc lại file `/data/rwv-tuning.json` khi file đổi (≤ 2 s): `adaptive`, `fixedIntervalMs`, `maxBacklogBytes`,
  `decodeBudgetRatio`, `intervalBackoffFactor`, `wsHighWaterBytes`, `fullFrameAreaThreshold`. Xoá file = mặc định.
  Xem `src/tuning.ts`.

## V2.9.27
### Độ phân giải đầy đủ (người dùng chọn độ nét cao) + tăng fps

- **Không gửi khung video ½ nữa** (mặc định). Bật lại: biến môi trường `HALF_SCALE_VIDEO=1`. Đã đo: ½ toàn màn 25–28 fps
  nhưng cả màn hình mờ khi phát video; "chỉ vùng video ½" nhấp nháy ở mép vùng — bỏ.
- **Nhịp tính từ lúc BẮT ĐẦU khung trước** (trước: từ lúc XONG) → chu kỳ = max(nhịp, thời gian xử lý) thay vì nhịp +
  thời gian xử lý (~35–40 ms ở độ phân giải đầy đủ).
- **Nén các phần của khung song song** (`Promise.all`, sharp chạy trên nhiều nhân) thay vì lần lượt.

## V2.9.26
### Nút mở rộng: Camera và URL hoạt động; sửa "URL hiện tại" bị kẹt

- **Camera**: mở trang xem camera của P4 (`cam.html?src=p4_panel` của chính server, go2rtc MSE của Frigate cổng
  1984 — người xem thêm dùng chung nguồn đang chạy, không mở thêm kết nối tới P4). Đổi bằng biến môi trường
  `LAUNCHER_CAMERA_URL`. Đo trên P4: video 960×528 chạy sau ~1,5 s, chế độ video nửa độ phân giải tự bật.
- **URL**: ô nhập địa chỉ ở mép trên + bàn phím ảo tự bật; ⏎ (bàn phím ảo) hoặc nút "Mở" → thiết bị báo `?urlset=1`
  thì server gửi gói mới `SetDisplayURL` (loại 8) → thiết bị đặt **"URL hiển thị"** (HA thấy giá trị mới), set_action
  của nó mở trang; thiết bị cũ → server tự mở trang. Tự thêm `https://` (IP LAN/localhost → `http://`), chữ không
  giống địa chỉ → tìm Google, chặn `javascript:`/`file:`. Nút "Mở"/"✕" xử lý ở `pointerdown` vì bàn phím ảo nuốt
  click 400 ms sau khi tự ẩn (đo thật: ✕ không đóng được ô).
- **Sửa "URL hiện tại" trên thiết bị kẹt ở URL cũ**: khi thiết bị yêu cầu mở trang, `inputRouter` gán URL mới trước
  khi `Page.frameNavigated` đến → server tưởng URL không đổi, không gửi CurrentURL. Nay chỉ bộ theo dõi điều hướng
  cập nhật.

## V2.9.25
### Nhận diện video bằng thẻ `<video>` đang phát (chế độ nửa độ phân giải bật lại được với YouTube)

- **Lỗi**: tiêu chí "diện tích thay đổi > 35% giữa hai khung" (thêm ở 2.9.23 để dashboard có ảnh động nhỏ không bị mờ)
  **không bao giờ đạt** với video thật trên trang xem YouTube 1024×600: khung video chỉ chiếm ~39% màn hình, giữa hai
  khung liên tiếp chỉ 0–22% điểm ảnh đổi rõ (cảnh chuyển động chậm), cộng dồn 1 s cũng chỉ 3–39%. Kết quả: video
  gửi ở độ phân giải đầy đủ (~60 KB/khung) → P4 chỉ ~9 fps.
- **Sửa**: server hỏi thẳng Chrome (CDP, chạy nền, mỗi 500 ms, chỉ khi nhịp khung cao và thiết bị bật `half=1`): có
  thẻ `<video>` **đang phát** chiếm ≥ 20% màn hình thì là video. Ảnh động/GIF trên dashboard không phải `<video>`
  nên vẫn nét. Tiêu chí diện tích giữ lại cho video trong iframe. Quy tắc "2 s sau chạm luôn nét" và "kéo dài ≥ 1 s"
  giữ nguyên.
- Đo (P4, camera Frigate 5 fps, video test pAnTNJaVhcs, **đã bỏ qua quảng cáo**): YouTube **25,6 fps** (cùng firmware
  P4 zero-copy + cổng nhường PPA). Lưu ý: số 13,0 fps ở 2.9.24 có thể đã đo lẫn quảng cáo.

## V2.9.24
### Chuyển tab luôn nét; chế độ video bật được ngay sau khởi động

- **Chuyển tab bị mờ 1–2 s** (người dùng báo): hiệu ứng chuyển tab là một đợt thay đổi lớn ngắn → trước đây đủ điều
  kiện "video" → cả màn hình nửa độ phân giải, giữ 3 s. Nay: (1) trong **2 s sau mỗi lần chạm** không bao giờ dùng nửa
  độ phân giải; chạm lúc đang ở chế độ video thì **làm nét ngay** (gửi lại khung cuối ở độ phân giải đầy đủ);
  (2) thay đổi lớn phải **kéo dài liên tục ≥ 1 s** mới coi là video. Thử 6 lần chuyển tab: 0 lần bật nửa độ phân giải.
- Ngưỡng nhịp chế độ video 5/3 → **2,5/1,5 fps**: sau khi thiết bị khởi động lại, server bắt đầu ở nhịp thận trọng
  (< 4 fps) nên không bao giờ đạt 5 fps → không vào chế độ video → thiết bị xử lý chậm → nhịp không tăng (vòng luẩn
  quẩn). Tiêu chí video thật là diện tích thay đổi kéo dài.
- Đo (P4, camera Frigate 5 fps, video nhiều chuyển động): YouTube **13,0 fps**.

## V2.9.23
### Khung video NỬA ĐỘ PHÂN GIẢI cho thiết bị có PPA (ESP32-P4) — YouTube 6–7 → 12,3 fps

Đo thật trên P4 (camera Frigate đang chạy, video nhiều chuyển động): mạng thô dư (tải TCP 2 MB/s), nhưng mỗi khung
YouTube 120–160 KB (Chrome) tốn ~50 ms xử lý trên thiết bị và phải chia nhiều gói.

- **`?half=1`** (thiết bị tự báo — P4 với `half_scale_video: true`): khi đang phát VIDEO, server thu khung Chrome về
  512×300 (sharp shrink-on-load) → ~20 KB, gửi kèm cờ mới **`FLAG_HALF_SCALE` (bit 2)**; x/y/w/h vẫn theo màn hình
  thật, thiết bị phóng ×2 bằng PPA. Thiết bị không báo `half=1` (S3, firmware cũ) không bao giờ nhận cờ này.
- **Nhận diện video**: nhịp khung đến (bật ≥ 5 fps, tắt < 3 fps) **và** phần lớn màn hình đổi (so ảnh thu nhỏ xám
  64×38: bật > 35%, giữ > 20%) — một tab dashboard có ảnh động nhỏ KHÔNG bị gửi mờ (người dùng phát hiện ngay ở bản
  thử đầu). Giữ chế độ video 3 s sau khung thỏa cuối (tránh bật/tắt liên tục, mỗi lần tắt phải gửi lại khung nét
  125–144 KB).
- **Làm nét lại**: video dừng 700 ms không có khung mới → gửi lại khung cuối ở độ phân giải đầy đủ.
- **Sửa lỗi**: cờ firmware (`halfScale`, `audioEnabled`) không nằm trong `deviceConfigsEqual()` nên khi thiết bị nối
  lại với firmware mới, phiên cũ giữ giá trị của lần kết nối đầu — nay luôn cập nhật (cùng loại lỗi `homeUrl`).

## V2.9.22
### Nút launcher hình giọt nước

Theo góp ý người dùng ("bo góc tròn hơn nữa, kiểu hình giọt nước"): thay hình thang bằng **giọt nước treo từ
mép trên** — hai bên bắt đầu tiếp tuyến với mép màn hình rồi cong mềm vào trong, đáy tròn; toàn bộ là các
đoạn Bézier nối tiếp có tiếp tuyến liên tục nên không còn góc nào. Cao 18 px, rộng 96 px, vẫn căn giữa.

## V2.9.21
### Nút launcher thành tab hình thang ở giữa mép trên; thêm mục Camera và URL

- Nút cũ: ô vuông 34×34 ở góc trên-phải. Nay là **tab hình thang** (đáy 96 px dính mép trên, thu hẹp
  xuống, bo góc dưới, cao 16 px) **căn giữa** màn hình — mỏng hơn, rộng hơn. Vẽ bằng SVG path (DOM API,
  không innerHTML — trang có Trusted Types). Vùng chạm trong suốt cao 32 px để vẫn dễ bấm.
- Dropdown mở ra căn giữa ngay dưới tab.
- Hai mục mới **Camera** và **URL** (icon máy ảnh, quả địa cầu), ghi "sắp có" — chỗ cho hai chức năng sau:
  hiển thị camera lên màn hình và nhập URL để truy cập. Hiện bấm vào chỉ đóng dropdown.

## V2.9.20
### Bộ điều tiết biết BĂNG THÔNG — P4 phát YouTube từ 2,5 fps lên trung bình 6,2 fps

Đo thật trên P4 (WiFi qua chip phụ C6): giải mã chỉ 30–40 ms/khung, nhưng socket tồn đọng 270–600 KB lặp
đi lặp lại. Nút thắt là **băng thông**, không phải CPU. Bộ điều tiết cũ chỉ nhìn thời gian giải mã khi hồi
phục, nên nó rút nhịp + **tăng quality** (khung to hơn) → vượt băng thông → tồn đọng → giãn ×2 lên 400 ms
→ hồi phục −50 ms mỗi ~20 s mất vài phút → lặp lại. Log thật:
`rút nhịp về 182ms → tăng quality 50, 55 → tồn đọng 270KB → giãn 364ms`.

**1. Ước lượng đường truyền** (`src/adaptive.ts` `updateLinkEstimate`, `src/broadcaster.ts` `linkCounters`)
Đếm byte đã giao cho từng socket; `đã giao − bufferedAmount` = byte thực sự rời server. Khi socket nghẽn
suốt cửa sổ 5 s, tốc độ đó **chính là băng thông**. Ngoài lúc nghẽn, ước lượng tự nâng 5%/tick (dò như
TCP) — đo thật cùng P4: 230 KB/s lúc WiFi kém, vài phút sau 564 KB/s không nghẽn; không tự nâng thì một lần
đo lúc kém sẽ khoá fps vĩnh viễn.

**2. Sàn nhịp theo băng thông** = khung gần đây / (75% băng thông). Hồi phục không rút dưới sàn; tồn đọng
thì nhảy **thẳng** tới sàn thay vì nhân đôi mù; không tăng quality khi đã dùng ≥75% băng thông.

**3. Hồi phục rút NỬA khoảng cách về sàn** (ít nhất 50 ms) thay vì −50 ms mỗi lần.

**4. `bytesPerSec` theo cửa sổ gần nhất** thay cho trung bình từ lúc kết nối (sau 3 giờ con số đó không
còn nói lên gì). `/metrics` thêm `linkCapacityBytesPerSec`, `recentBytesPerSec`, `recentFrameBytes`.

Đo 5 phút YouTube trên P4: trung bình **6,2 fps** (trước 2,5), 8,4 fps liên tục khi WiFi tốt; lúc nghẽn
lùi 400 ms rồi hồi về 282 ms trong ~1,5 phút theo băng thông đo được; đứng hình lâu nhất 5 s.
*Test mới* (8): đo băng thông chỉ khi nghẽn, tự nâng, giữ qua socket mới, sàn nhịp, nhảy thẳng tới sàn,
hồi phục nửa khoảng cách, không tăng quality khi sát băng thông.

## V2.9.19
### Đo lại toàn bộ tham số server: 73% thời gian mã hoá của server là vô ích

Người dùng yêu cầu rà soát xem cấu hình server đã tối ưu chưa. Thay vì suy đoán, đo bằng chính thư viện
`sharp` của addon, trên ảnh YouTube 1024x600 thật, với đúng cấu hình P4 đang chạy:

| Bước | Kết quả | Thời gian |
|---|---|---|
| Thang chất lượng trên **cả khung** (cap 16 KB) | q70→75.748 B, q53→59.510 B, q39→50.515 B, q25→39.933 B — **không nấc nào vừa** | 67,0 ms |
| ... và `full_frame_tile_count: 1` khiến thang đó chạy **hai lần** mỗi khung | | +67,0 ms |
| Bốn góc phần tư 512x300 (kết quả thực sự được gửi) | 11.411 / 19.713 / 18.885 / 27.925 B | 50,8 ms |
| **Tổng một khung** | | **184,8 ms — trong đó 134,0 ms (73%) vô ích** |

Khớp với `/metrics`: `avgEncodeMs = 146 ms`. Nút thắt là **CPU mã hoá của server**, không phải băng thông.
Ghi chú v15 ("đã chạm trần mạng ~670 KB/s, không phải CPU") là **kết luận sai** — suy ra từ băng thông mà
chưa từng đo thời gian mã hoá.

**1. Bỏ thang chất lượng khi đã biết chắc không vừa cap** (`src/frameProcessor.ts`)
Cả `_processFullFrame` lẫn `_encodeRectFitting` đều chạy thang `[1, 0.75, 0.55, 0.35]` rồi mới chịu chia
nhỏ, và không hề nhớ kết quả lần trước. Nay nhớ đáy thang theo từng cỡ rect; cỡ nào đã biết là không vừa
thì chia nhỏ ngay. Vẫn thử lại mỗi 120 khung (~0,5% chi phí) để tự sửa khi nội dung đổi hẳn
(video → dashboard tĩnh), và xoá sạch khi bộ điều tiết đổi trần chất lượng.
*Test mới*: khung 2 (bỏ thang) phải cho ra **đúng** kết quả như khung 1 (chạy thang) — bản vá chỉ được
bớt thời gian, không được đổi ảnh.

**2. Một khung một lúc** (`src/deviceManager.ts`)
`flushPending` là hàm async không tự loại trừ. Bản vá 17/09 đánh mốc `lastProcessedMs` ngay khi bắt đầu,
nhưng mốc đó chỉ bảo đảm *khoảng cách giữa hai lần bắt đầu*, không bảo đảm lần trước đã xong. Mã hoá
146 ms trong khi nhịp điều tiết 50 ms ⇒ cứ 50 ms lại có thêm một `flushPending` **chạy chồng lên**.
Bằng chứng: `encodeMsTotal = 629 giây` trên `uptime 400 giây` — hơn 100% thời gian tường. Hậu quả kép:
2-3 đường ống sharp tranh CPU, và `processor._prev` (bảng băm tile) bị hai lần chạy cùng sửa ⇒ vi sai
tính sai ⇒ khung rách. Nay có khoá `flushInFlight`; khung mới không bị bỏ vì `pendingB64` luôn giữ khung
mới nhất.

**3. Vòng điều khiển thích nghi đang bay mù** (`src/broadcaster.ts`, `src/index.ts`)
`/metrics` cho thấy P4 chạy 571 giây, server hỏi số liệu ~57 lần, nhưng `decodeSamples = 1`. Tức bộ điều
tiết đã lái nhịp 200 ms → 50 ms dựa trên **duy nhất một mẫu 13 ms đo từ 9 phút trước**. Nguyên nhân: gói
xin số liệu xếp *sau* cả hàng đợi khung hình, nên đúng lúc thiết bị ngộp (chính lúc cần đo nhất) thì nó
đến muộn hoặc không đến. Thứ dùng để *phát hiện* nghẽn lại bị chính sự nghẽn đó làm câm.
- Gói xin số liệu nay gửi **thẳng** trên socket, không qua hàng đợi (chỉ 8 byte).
- Chu kỳ hỏi 10s → **5s**, bằng đúng chu kỳ `runAdaptiveTick`. Để 10s thì mỗi mẫu bị dùng cho hai lần
  quyết định liên tiếp — một lần đo xấu bị phạt hai lần, một lần đo tốt kéo nhịp lên hai nấc mà không có
  bằng chứng mới.

**Phía firmware** (repo client, cùng ngày): gói xin số liệu không vào hàng đợi giải mã nữa mà chỉ đặt cờ
`stats_requested_`; decode task tự trả lời sau mỗi gói. Không hàng đợi, không cấp phát, không bao giờ bị
rớt — đúng cách đã làm cho `AudioFrame` hôm trước.

**4. Điều tiết bằng TRUNG VỊ, không phải giá trị LỚN NHẤT** (`src/metrics.ts`, `src/deviceManager.ts`)
Ngay khi số liệu thật bắt đầu chảy về, lỗi tiếp theo lộ ra. Log của chính thiết bị, 20 khung liên tiếp:
```
frame 5987..6006: 29, 33, 30, 33, 32, 30, 31, 30, 30, 29 ms
```
Đều đặn quanh 30 ms. Nhưng `/metrics` cùng lúc báo `recentMaxDecodeMs = 81`, và bộ điều tiết ghi lý do:
`"decode 713.0ms > ngân sách 200ms → giảm quality còn 40"` — **một gai nhiễu 713 ms đã quyết định số
phận cả hệ**. Lấy lớn nhất của 6 mẫu nghĩa là một gai khoá hành vi suốt 30 giây, mà chiều hạ tải chỉ trễ
5 giây nên trong 30 giây đó nó phạt được tới sáu lần từ cùng một gai. Kết quả đo được: quality tụt về sàn
40, nhịp giãn ra 400 ms (2,5 fps) trong khi thiết bị thật sự chỉ bận 30 ms/khung.
Nay bộ điều tiết ăn **trung vị** của cửa sổ; `recentMaxDecodeMs` vẫn còn trong `/metrics` để người đọc
nhìn thấy gai.

### Kết quả đo trên máy thật (P4, YouTube, mỗi lần một cửa sổ 180 giây)

| Cấu hình | fps | encode/khung | byte/khung | bỏ khung | số lần điều chỉnh |
|---|---|---|---|---|---|
| Trước (2.9.18) | 12,0* | **146,1 ms** | 55 KB | — | — |
| + bỏ thang vô ích, trần q70 | 5,4-6,6 | 20,0 ms | 90 KB | 23-43 | 4-7 |
| + `decodeBudgetRatio` 0,65 (**đã loại**) | 2,88 | 19,7 ms | 84 KB | 43 | 9 (dao động) |
| **+ trần q55 (chốt)** | **9,99** | **19,5 ms** | 65 KB | **0** | **0** |

\* Con số 12 fps cũ **không so sánh được**: lúc đó thiết bị không hề báo số liệu về, server đẩy nhiều hơn
mức thiết bị vẽ kịp nên phần lớn khung bị chính thiết bị vứt — đúng cái người dùng thấy là "lag".

Một lần nữa xác nhận ghi chú có sẵn trong `adaptive.ts`: `decodeBudgetRatio` **không phải "mức dự phòng
thừa"** mà là khoảng cách an toàn tới vùng mất ổn định. Nới ra là hệ dao động ngay.

## V2.9.18
### Chặn âm thanh cho thiết bị không có loa — tránh lẫn tiếng nếu S3 cũng mở YouTube
Người dùng yêu cầu nghiên cứu kỹ giải pháp: nếu sau này panel S3 (chưa khai báo `speaker_id`) cũng mở
YouTube, âm thanh của nó sẽ chảy vào cùng sink PulseAudio với P4 và bị trộn lẫn gửi nhầm sang loa P4 —
nghe được là âm thanh không khớp với hình đang xem.

**Kiểm tra kỹ trước khi chọn hướng**: một kết quả tìm kiếm gợi ý `Emulation.setAudioMuted` — đối chiếu
trực tiếp với JSON spec gốc của Chrome DevTools Protocol (`browser_protocol.json`) xác nhận **lệnh này
không tồn tại** trong toàn bộ giao thức (không riêng domain `Emulation`) — chỉ là kết quả tóm tắt sai
của công cụ tìm kiếm, không dùng. CDP hoàn toàn không có cơ chế "tắt tiếng theo từng target/tab" nào.

**Giải pháp không cần tách tiến trình Chrome**: vì thiết bị không khai báo `speaker_id` không bao giờ
cần *nghe* được gì cả, chỉ cần đảm bảo trang của nó không *tạo ra* âm thanh ở tầng nguồn. Tiêm một script
(cùng cơ chế `Page.addScriptToEvaluateOnNewDocument` đã dùng cho bàn phím/launcher) ghi đè thẳng lên
`HTMLMediaElement.prototype`: `muted` luôn đọc ra `true`, `volume` luôn đọc ra `0`, mọi lần gán đều bị
bỏ qua — áp dụng cho mọi `<video>`/`<audio>` hiện có lẫn sẽ được tạo sau, không cần theo dõi từng phần tử.

**Đã kiểm chứng trên máy thật**: mở tab test, tiêm script, phát video, cố ép bật tiếng bằng mọi cách
(`v.muted = false`, `v.volume = 1.0`, `removeAttribute('muted')`) — video vẫn phát bình thường
(`paused: false`) nhưng `muted`/`volume` đọc lại vẫn luôn là `true`/`0`.

- `src/deviceManager.ts`: `buildAudioMuteScript()` (mới), tiêm cho mọi thiết bị có `cfg.audioEnabled ===
  false`, trước cả script bàn phím

## V2.9.17
### Sửa tiếng "tạch" đều đặn mỗi 2 giây: đổi nguồn bắt âm thanh từ `ffmpeg` sang `parec`
Người dùng báo đã nghe được tiếng nhưng **có tiếng "tạch" lẫn vào đều đặn mỗi ~2 giây**. Lần này **đo
trước khi sửa** — chạy song song hai công cụ trên cùng một nguồn, cùng máy, cửa sổ 8 giây:

| | `ffmpeg` (đang dùng) | `parec` (công cụ gốc PulseAudio) |
|---|---|---|
| Số mảnh dữ liệu / 8s | **2** | 356 |
| Khoảng cách giữa các mảnh | **1994ms, 1995ms** | TB **22ms**, lớn nhất 26ms |
| Kích thước mảnh | 63.900 B | ~742 B |
| Tốc độ thực | 23.959 B/s (**thiếu 25%**) | **31.949 B/s** (= đúng thời gian thực) |

`ffmpeg` chỉ nhả dữ liệu **mỗi ~2 giây một cục lớn**. Không bộ đệm nào cứu được điều đó trừ khi đệm ≥2
giây — mà như vậy thì tiếng đi sau hình 2 giây, còn tệ hơn. Giữa hai cục, ring buffer phía loa cạn kiệt
→ `i2s_audio.speaker` **Stopped** → cục mới tới lại **Starting** → mỗi lần dừng/chạy sinh một transient
nghe đúng thành tiếng "tạch". Đây cũng là lời giải cho chu kỳ ~2.0 giây bám theo suốt quá trình gỡ lỗi.

`parec` là công cụ gốc của PulseAudio cho đúng việc này: xuất PCM thô, không qua tầng muxer/timestamp
nào, `--latency-msec` chỉ định thẳng độ trễ mong muốn. Đã có sẵn trong image (gói `pulseaudio-utils`).

- `src/audioCapture.ts`: `spawn('ffmpeg', ...)` → `spawn('parec', ...)` với `--latency-msec=40`

## V2.9.16
### Tối ưu hiệu năng: bỏ resample trên ESP32 và cắt độ trễ đệm
Người dùng xác nhận **đã có âm thanh** sau V2.9.15, nhưng **cả video lẫn âm thanh đều lag**. Hai nguyên
nhân đo được từ chính cấu hình đang chạy:

1. **Resample liên tục trên ESP32**: loa phần cứng chạy `sample_rate: 44100` trong khi server gửi PCM
   16kHz → resampler phải chuyển đổi 16k→44.1k cho **từng mẫu**, và mixer phải trộn ở 44100 mẫu/giây.
   CPU này lấy trực tiếp từ cùng con chip đang giải mã JPEG 1024×600 → video giật theo. Hạ phần cứng về
   đúng `16000` Hz: đường media thành **pass-through, không resample một mẫu nào**, mixer làm việc trên
   số mẫu ít hơn **2,76 lần**. (TTS vẫn chạy tốt — `announcement_pipeline` có resampler riêng, và 16kHz
   là chuẩn cho tiếng nói.)
2. **Độ trễ đệm chồng nhau**: `buffer_duration: 1000ms` ở loa + ~1s ở jitter buffer phía server = âm
   thanh đi sau hình tới ~2 giây. Hạ xuống 250ms (loa) + ~200ms (server) — vẫn đủ chống giật nhưng độ
   lệch gần như không nhận ra. Vùng ring buffer PSRAM cũng tụt từ 88200B xuống 8000B.

- `src/audioCapture.ts`: `MAX_JITTER_BYTES` ~1s → ~200ms
- Firmware (repo Client): `sample_rate: 44100` → `16000`, `buffer_duration: 1000ms` → `250ms`

## V2.9.15
### NGUYÊN NHÂN GỐC THẬT SỰ của "video chạy nhưng không có tiếng": Playwright tự thêm `--mute-audio`
Phép thử quyết định lẽ ra phải làm từ đầu: đo **nội dung** PCM bắt được thay vì chỉ đếm số byte.
`ffmpeg -af volumedetect` trên `chrome_out.monitor` cho kết quả **`max_volume: -91.0 dB`** — tức là số 0
tuyệt đối (digital silence), kể cả khi video YouTube đang phát thật, không mute, volume 1.

Điều này phủ định mọi "xác nhận" trước đó (ffmpeg ghi ~32KB/s, `pactl` báo sink RUNNING, sink-input
`Corked: no` / `Mute: no` / volume 100%): **null-sink luôn sinh ra byte đều đặn kể cả khi hoàn toàn im
lặng**, nên lưu lượng byte không chứng minh được gì về nội dung.

Soi dòng lệnh thật của tiến trình Chrome đang chạy (`ps aux`) tìm ra thủ phạm: **Playwright tự động
thêm `--mute-audio`** vào tham số khởi chạy mặc định. Chrome tắt tiếng ở tầng trong — mọi hạ tầng phía
sau (sink ảo, ffmpeg, jitter buffer, hàng đợi/task riêng ở firmware, timeout mixer) đều hoạt động đúng
nhưng chỉ chở im lặng.

- `src/browser.ts`: `ignoreDefaultArgs: ['--mute-audio']` — gỡ đúng một cờ này, giữ nguyên các mặc định
  khác của Playwright
- `src/browser.ts`: thêm `--autoplay-policy=no-user-gesture-required` — đã đo được `play()` ném
  `NotAllowedError` khi thiếu cử chỉ người dùng, và trình phát YouTube xử lý lỗi đó bằng cách **tự phát
  lại ở chế độ muted**, một đường dẫn tới im lặng thứ hai cần chặn

**Bài học**: kiểm tra dòng lệnh thật của tiến trình trước khi suy luận qua các tầng phía dưới; và với
audio, luôn đo **biên độ tín hiệu**, không bao giờ dùng "có byte chảy qua" làm bằng chứng có âm thanh.

## V2.9.14
### Sửa lỗi thật, lớp cuối cùng: bộ đệm jitter phía server — gói AudioFrame đến theo từng đợt dồn dập
Sau V2.9.13 (bỏ `-fragment_size`) + tách hàng đợi audio riêng ở firmware (repo Client): xác nhận qua log
ESPHome thật gói ĐÃ tới được thiết bị, nhưng **hàng đợi audio riêng (sâu 30) vẫn tràn** — log ghi liên
tục `"hang doi day (audio), rot goi"` thành từng cụm 6-8 dòng mỗi lần. Nguyên nhân: ffmpeg/PulseAudio
giao dữ liệu cho Node **theo từng đợt lớn cách nhau ~2 giây** (đúng hiện tượng đã đo ở V2.9.11, chỉ khác
là trước đây bị chặn ở tầng khác nên chưa lộ ra đến đây) — server trước đây gửi NGAY khi ffmpeg có dữ
liệu, nghĩa là firmware nhận dồn hàng chục gói trong vài chục mili-giây rồi im lặng ~2s, làm tràn bất kỳ
hàng đợi cỡ nào ở đầu nhận.

**Sửa tận gốc, đúng vị trí kiến trúc**: thêm bộ đệm jitter (jitter buffer) phía server —
`accumulateFromFfmpeg()` chỉ gom dữ liệu vào bộ đệm, **không gửi gì cả**; một nhịp cố định
(`setInterval`, 40ms/lần, độc lập hoàn toàn với lúc ffmpeg thực sự giao dữ liệu) mới cắt đúng 1 khung và
gửi đi. Nhờ vậy thiết bị luôn nhận đúng nhịp ~25 gói/giây đều đặn, bất kể ffmpeg giao dồn hay giao đều —
đây chính là vai trò chuẩn của "jitter buffer" trong mọi hệ thống streaming audio, đáng lẽ nên có ngay
từ đầu thay vì gửi thẳng theo nhịp giao của nguồn.

- `src/audioCapture.ts`: thay `feedChunk()` (gửi ngay) bằng `accumulateFromFfmpeg()` (chỉ gom bộ đệm) +
  `drainTick()` chạy theo `setInterval(40ms)`; giới hạn bộ đệm ở ~1s dữ liệu, cắt bớt phần cũ nhất nếu
  vượt (tránh trễ ngày càng tăng nếu ffmpeg giao nhanh hơn tốc độ phát thực tế)

## V2.9.13
### Sửa lỗi thật: hoàn toàn không nghe được âm thanh video — 2 lớp lỗi chồng lên nhau
Sau khi triển khai `timeout: 5s` cho mixer (phía firmware, repo Client) và tách hàng đợi/task riêng cho
audio (không còn bị video tranh chấp), kiểm chứng lại trên máy thật bằng log ESPHome trực tiếp: **vẫn
0 log Starting/Stopped nào trong khi video đang giải mã liên tục** — nghĩa là gói AudioFrame không hề
tới được thiết bị nữa, không phải lỗi ở firmware.

Soi log server: `-fragment_size 1024` (thêm ở V2.9.11 với giả thuyết SAI về chu kỳ ~2.0s, đã bác bỏ)
khiến ffmpeg spam cảnh báo `"non monotonically increasing dts to muxer"` **hàng chục lần mỗi giây liên
tục** — dấu hiệu rõ ràng của một pipeline ffmpeg đang gặp trục trặc thật, không chỉ là log ồn. Bỏ hẳn
`-fragment_size`, quay về mặc định của PulseAudio cho input `pulse` — không còn dấu hiệu lỗi này.

**An toàn khi bỏ**: PulseAudio mặc định gom dữ liệu thành đợt ~2.0s một lần (đây là hiện tượng đã đo ở
V2.9.11) — nhưng giờ mixer phía firmware đã chịu được khoảng trống tới `timeout: 5s`, dư sức hấp thụ chu
kỳ ~2s tự nhiên này mà không tự ngắt kênh nữa. Không cần `-fragment_size` mà vẫn không bị cắt vụn.

- `src/audioCapture.ts`: bỏ hẳn `-fragment_size 1024`

## V2.9.12
### Dọn log rác + xác định đúng nguyên nhân gốc của lỗi V2.9.11
`-fragment_size 1024` (V2.9.11) hoá ra KHÔNG phải nguyên nhân chính — kiểm chứng lại bằng log ESPHome
thật sau khi triển khai cho thấy chu kỳ Starting/Stopped vẫn đều đặn ~2.0s y hệt trước. Nguyên nhân thật
là timeout mặc định 500ms của từng nguồn trong `speaker: platform: mixer` (component `mixer_speaker.cpp`
của ESPHome) — sửa ở phía firmware (repo Client, `timeout: 5s` cho `media_spk_mixer_input`), không phải
ở server. Nhân tiện dọn `-flush_packets 1` (không có tác dụng với đầu ra `s16le` thô, chỉ gây spam log
cảnh báo "non monotonically increasing dts"). `-fragment_size 1024` vẫn giữ lại (không sai, chỉ không
phải nguyên nhân chính) vì vẫn hợp lý cho độ trễ thấp.

- `src/audioCapture.ts`: bỏ `-flush_packets 1`

## V2.9.11
### Sửa lỗi thật: gần như không nghe được âm thanh video — PulseAudio đệm theo đợt lớn ~2 giây
Người dùng báo: TTS qua Speaker Media Player nghe rõ, nhưng mở YouTube thì không nghe thấy gì. Xác nhận
qua `pactl list sink-inputs`: Chrome **có** phát âm thanh thật vào sink (2 stream, không mute, không
corked). Xác nhận qua log ESPHome trực tiếp trên thiết bị thật (kết nối có giới hạn thời gian, tự ngắt):
chuỗi `resampler_speaker`/`speaker_mixer`/`i2s_audio.speaker` cứ **Starting rồi Stopped lặp lại đều đặn
tuyệt đối mỗi ~2.0 giây** (đo được: 1.2s / 3.1s / 5.1s / 7.1s / 9.1s / 11.1s).

**Nguyên nhân**: không đặt `-fragment_size` cho ffmpeg khi đọc từ `chrome_out.monitor`, nên PulseAudio
tự chọn kích thước đoạn mặc định — trên máy thật, việc này khiến dữ liệu chỉ được giao cho ffmpeg theo
từng đợt lớn cách nhau đúng ~2 giây thay vì gần như liên tục. Ring buffer phía loa ESP32 (88200 byte,
~2.75s ở 16kHz) cạn kiệt giữa hai đợt, khiến `Speaker` component tự dừng — âm thanh thật sự phát ra chỉ
là những mảnh ~0.6-0.8 giây mỗi 2 giây, gần như không nghe ra được là có tiếng.

- `src/audioCapture.ts`: thêm `-fragment_size 1024` (input option, ép PulseAudio giao đoạn nhỏ ~32ms
  thay vì mặc định) và `-flush_packets 1` cho ffmpeg

## V2.9.10
### Sửa lỗi rò rỉ tiến trình ffmpeg khi thiết bị reconnect nhanh
Kiểm chứng trên máy thật ngay sau khi triển khai V2.9.9: `ps aux` bên trong container cho thấy **2 tiến
trình `ffmpeg` cùng chạy** đọc chung `chrome_out.monitor`. Nguyên nhân: `stopCapture()` đặt
`ffmpegProc = null` **ngay** sau khi gọi `.kill()`, không đợi tiến trình thật sự thoát. Khi thiết bị
disconnect/reconnect rất nhanh (đo thật: 309ms — không hiếm, đã thấy nhiều lần trong dự án do
`reconnect_ws()` firmware gọi ở nhiều chỗ), `startCapture()` gọi lại thấy `ffmpegProc == null` nên spawn
tiến trình MỚI trong khi tiến trình CŨ có thể chưa dọn xong — có lúc gây `ffmpeg thoát code=255` (giành
nguồn), có lúc (như lần đo được) cả hai tiến trình cùng sống sót, tiến trình cũ bị rò rỉ vĩnh viễn.

- `src/audioCapture.ts`: không còn null hoá `ffmpegProc` trong `stopCapture()` — chỉ handler `exit`
  (xác nhận tiến trình THẬT SỰ đã kết thúc) mới được phép null hoá và khởi động lại. Thêm cờ `stopping`
  để `startCapture()` biết cần đợi thay vì spawn chồng. Phân biệt thoát chủ động (do chính server
  `kill()` để khởi động lại nhanh, delay 200ms) và thoát ngoài ý muốn (lỗi thật, delay 3s tránh vòng lặp)

## V2.9.9
### Tính năng mới: âm thanh "như điện thoại" — chỉ P4
Bắt âm thanh Chrome đưa ra qua sink PulseAudio ảo (`chrome_out`, xem `docker-entrypoint.sh` mới),
phát lại qua WebSocket cho **đúng P4** — hai panel S3 không bị ảnh hưởng gì (không khai báo `speaker_id`
ở firmware thì không gửi `?audio=1`, server không bao giờ gửi `AudioFrame` cho chúng).

Kiến trúc: một tiến trình Chrome dùng chung như hiện tại (không tách theo thiết bị — đã xác nhận không
cần thiết vì chỉ có một đích duy nhất, xem `AUDIO-FEATURE-PLAN-2026-09-23.md` mục 7.6 ở repo Client),
một tiến trình `ffmpeg` bắt liên tục từ `chrome_out.monitor` (PCM 16-bit/16kHz/mono, không nén — không
cần codec nào chạy trên ESP32), đóng gói thành gói tin WebSocket mới (`AudioFrame`, MsgType=7), gửi
**thẳng** (không qua hàng đợi video) để tránh audio bị kẹt sau backlog ảnh khi mạng tải nặng.

- `docker-entrypoint.sh` (mới): khởi động PulseAudio (`--system`, sink ảo `chrome_out`, socket Unix)
  trước khi chạy lệnh chính — bọc cả đường chạy Docker thuần lẫn addon HA OS (`run.sh`)
  qua cơ chế ENTRYPOINT kế thừa
- `dockerfile`: cài thêm `pulseaudio`/`pulseaudio-utils` ở production stage
- `src/protocol.ts`: `MsgType.AudioFrame = 7`, `buildAudioFramePacket()`
- `src/broadcaster.ts`: `sendAudioFrame()` — gửi trực tiếp, không qua `_drainAsync`/hàng đợi video
- `src/config.ts`: `DeviceConfig.audioEnabled` (từ `?audio=1`, thiết bị tự báo qua firmware, không nằm
  trong `deviceConfigsEqual()` như `homeUrl`)
- `src/audioCapture.ts` (mới): quản lý tiến trình `ffmpeg` bắt audio, đóng khung ~40ms/gói, chỉ chạy khi
  có thiết bị đăng ký nghe (tiết kiệm CPU khi không cần)
- `src/index.ts`: đăng ký/hủy đăng ký nhận audio theo vòng đời kết nối WS mỗi thiết bị

## V2.9.8
### Sửa tiếp V2.9.7: bỏ UA override lộ nguyên chữ "HeadlessChrome"
Kiểm chứng trực tiếp trên máy thật sau khi triển khai V2.9.7 (bỏ hẳn `Emulation.setUserAgentOverride`)
phát hiện ngay vấn đề còn tệ hơn bản cũ: UA thật của Chrome ở chế độ `--headless=new` vẫn chứa nguyên
chữ **"HeadlessChrome/153.0.0.0"** — một trong những dấu hiệu automation lộ liễu và bị kiểm tra sớm
nhất bởi các hệ thống chống bot (khớp chuỗi "Headless" là kiểm tra rẻ và phổ biến). Bỏ override hoàn
toàn hoá ra tệ hơn override sai phiên bản.

Sửa đúng cách: gọi `Browser.getVersion()` để lấy **UA thật** của chính Chrome đang chạy (không hardcode
như bản trước 2.9.6 — đó là nguồn gốc lỗi lệch phiên bản), rồi chỉ thay chuỗi con `"HeadlessChrome"` →
`"Chrome"`, giữ nguyên mọi phần còn lại (kể cả số phiên bản thật). Nhờ vậy UA luôn tự khớp mỗi lần
Chrome trong image được cập nhật, không còn lệch phiên bản NHƯNG cũng không còn lộ "Headless".

- `src/deviceManager.ts`: thêm `getRealChromeUserAgentAsync()` (gọi `Browser.getVersion`, cache lại,
  thay thế chuỗi), áp dụng qua `Emulation.setUserAgentOverride` thay vì bỏ hẳn như V2.9.7

## V2.9.7
### Giảm dấu hiệu tự động hóa khiến Google chặn đăng nhập YouTube
Người dùng báo: khi thử đăng nhập YouTube thật trên panel, Google báo *"Không thể đăng nhập cho bạn.
Trình duyệt hoặc ứng dụng này có thể không an toàn"* — chặn tự động hóa (anti-bot) tiêu chuẩn của
Google, không phải lỗi của dự án theo nghĩa "bug", nhưng có 2 điểm góp phần làm tín hiệu automation rõ
hơn mức cần thiết:

1. **User-Agent bị ép cứng lệch phiên bản thật**: `Emulation.setUserAgentOverride` gán cố định
   `Chrome/120.0.0.0`, trong khi Chrome thật trong image (tự cập nhật liên tục qua apt) đang chạy
   `153.0.8010.36` — lệch 33 phiên bản. Client Hints (`navigator.userAgentData`) và hành vi JS thật
   vẫn báo đúng bản 153, chỉ riêng chuỗi UA nói dối — đây là dấu hiệu automation/scraper khá rõ (người
   dùng thật hầu như luôn chạy bản mới nhất). Không tìm được lý do kỹ thuật nào bắt buộc phải override
   (viewport đã `mobile: false` sẵn) — bỏ hẳn, để Chrome tự báo UA thật, tự khớp mọi lần Chrome trong
   image được cập nhật.
2. **`navigator.webdriver = true`** (xác nhận trực tiếp qua CDP) — tín hiệu automation rõ ràng nhất mà
   các trang chống bot (đăng nhập Google) thường kiểm tra đầu tiên. Thêm cờ khởi chạy Chrome
   `--disable-blink-features=AutomationControlled`.

**Không đảm bảo hết bị chặn**: kiến trúc dự án dựa hoàn toàn vào CDP (screencast, input, script tiêm)
nên không thể loại bỏ hết dấu hiệu automation, và Google còn nhiều tín hiệu chấm điểm rủi ro phía
server (thiết bị/vị trí đăng nhập mới lạ, v.v.) không thể giả mạo từ một addon tự lưu trữ. Nếu sau khi
cập nhật vẫn bị chặn, hướng đáng tin cậy hơn là **chuyển session cookie** từ một lần đăng nhập thật
trên trình duyệt cá nhân của người dùng vào profile Chrome của server, thay vì cố vượt qua chính bước
thử thách đăng nhập.

- `src/deviceManager.ts`: bỏ `Emulation.setUserAgentOverride` cố định
- `src/browser.ts`: thêm `--disable-blink-features=AutomationControlled` vào args khởi chạy Chrome

## V2.9.6
### Nút "Home" trong dropdown launcher vẫn thiếu dù firmware đã gọi `reconnect_ws()`
Sau khi vá race lúc khởi động ở V2.9.5 (firmware gọi `reconnect_ws()` ngay sau `set_home_url()`),
kiểm tra log thật vẫn thấy `[device] ✓ Launcher registered (chua co homeUrl...)` không đổi qua
nhiều lần thiết bị kết nối lại. Nguyên nhân: `homeUrl` **cố tình** không nằm trong
`deviceConfigsEqual()` (để đổi Home URL không phá Chromium target) — nhưng hệ quả là khi thiết bị
kết nối lại với `home=` khác, `ensureDeviceAsync()` thấy cấu hình "giống hệt", trả về session cũ
mà **không hề cập nhật `device.cfg`** — `homeUrl` bị kẹt vĩnh viễn ở giá trị của lần kết nối đầu
tiên (thường rỗng), bất kể firmware gọi `reconnect_ws()` bao nhiêu lần.

- `DeviceSession`: thêm `launcherScriptId` — lưu id của script launcher đã đăng ký qua
  `Page.addScriptToEvaluateOnNewDocument`, để gỡ ra và đăng ký lại được
- `ensureDeviceAsync()`: trong nhánh "cấu hình giống hệt", nếu `homeUrl` đổi thì tự tay
  `Page.removeScriptToEvaluateOnNewDocument` + đăng ký lại script mới (áp dụng cho lần tải trang
  kế tiếp), đồng thời `Runtime.evaluate` dọn nút/dropdown cũ và chạy lại script mới NGAY trên
  trang đang mở (không cần đợi reload) — không đụng đến Chromium target
- `buildLauncherScript()`: gắn `id` cố định cho nút và dropdown (`__rwv_launcher_btn`/
  `__rwv_launcher_panel`) để có chỗ bám mà gỡ khi cập nhật

## V2.9.5
### Sửa bàn phím ảo không hiện trên trang có Trusted Types CSP (vd đăng nhập Google)
Người dùng báo: chạm vào ô nhập trên trang đăng nhập YouTube/Google, bàn phím ảo không hiện lên
(trong khi Dashboard HA vẫn hoạt động bình thường). Điều tra bằng CDP trực tiếp trên trang đăng
nhập thật (`accounts.google.com`, không nhập thông tin đăng nhập) cho thấy `resolveInput()` vẫn
nhận diện đúng ô nhập, `checkAndShow()` vẫn chạy — nhưng `renderKeyboard()` ném `TypeError: Failed
to set the 'innerHTML' property... This document requires 'TrustedHTML' assignment` ngay từ dòng
`keyboardContainer.innerHTML=''`, làm crash `showKeyboard()` **trước khi** kịp thêm class
`vkb-visible` → bàn phím được tạo trong DOM nhưng không bao giờ hiện ra. `accounts.google.com`
bắt buộc Trusted Types (chặn gán chuỗi trực tiếp vào `innerHTML`), khác các trang thường.

- `deviceManager.ts`: `renderKeyboard()` đổi `innerHTML=''` sang vòng lặp
  `removeChild(firstChild)` — API DOM thuần, không bị Trusted Types chặn

### Icon dropdown launcher: chuyển sang SVG đơn sắc + sửa icon Home hay bị thiếu
Hai lỗi người dùng báo cùng lúc:
1. Icon Home/YouTube là emoji màu (🏠/▶️) — đổi sang SVG outline đơn sắc (`currentColor`, nền
   trong suốt), vẽ bằng `createElementNS` **không dùng `innerHTML`** (né đúng lỗi Trusted Types ở
   trên — hộp dropdown có thể hiện trên bất kỳ trang nào, kể cả trang đăng nhập).
2. Icon Home hay biến mất: `on_boot` (firmware) đợi `ws_connected` **rồi mới** gọi
   `set_home_url()` — nghĩa là lần kết nối WebSocket đầu tiên luôn thiếu `?home=` (giá trị còn
   rỗng lúc `build_ws_uri_()` chạy). `set_home_url()` chỉ lưu biến RAM, không tự gửi lại gì cả.
   Sửa ở firmware (repo Client): gọi `reconnect_ws()` ngay sau `set_home_url()` — cả trong
   `on_boot` (áp dụng lần đầu) lẫn `set_action` của `rwv_default_url` (áp dụng khi đổi Home URL
   sau này) — để buộc `build_ws_uri_()` chạy lại với giá trị đã đúng.

### Sửa đèn nền tắt khi đang mở YouTube dù chưa hết thời gian "luôn sáng"
`video_active` gộp chung điều kiện `is_video && is_receiving_frames(5000)` cho cả camera/stream
LẪN YouTube — đúng với camera (cần phát hiện mất kết nối) nhưng sai với YouTube: trang tĩnh (đang
đọc mô tả, lướt danh sách, video tạm dừng) không tạo frame mới liên tục nên `is_receiving_frames`
trả về false, khiến `inactivity_timer` vẫn tắt đèn sau thời gian đặt dù trang YouTube đang mở.

- Firmware (repo Client, cả P4 và S3 480x480): tách `is_youtube` khỏi `is_stream` — YouTube giữ
  đèn sáng **miễn là URL còn khớp `youtube.com`**, không đòi hỏi frame thay đổi liên tục; camera/
  stream vẫn giữ nguyên yêu cầu frame sống (an toàn khi mất kết nối camera)

### Vá lỗ hổng bảo mật phát sinh ngoài dự kiến: mật khẩu WiFi dạng plaintext trên máy thật
Trong lúc đối chiếu file đang chạy thật với repo, phát hiện 2 file YAML trên HASS
(`7inch-jc1060p470c-v2.yaml`, `guition-webview-4848s040.yaml`) đang chứa mật khẩu WiFi + mật khẩu
AP fallback dạng chữ thường (không dùng `!secret`) — khác bản trong repo. Đã thêm khoá
`ap_fallback_password` vào `secrets.yaml` và đổi cả 2 file về `!secret wifi_ssid` /
`!secret wifi_password` / `!secret ap_fallback_password`, khớp quy tắc bảo mật của dự án.

## V2.9.4
### Launcher: nút dropdown Home/YouTube trên góc màn hình
Tiêm thêm một script (cùng cơ chế `Page.addScriptToEvaluateOnNewDocument` đã dùng cho bàn phím
ảo) tạo nút mũi tên góc trên-phải, xổ xuống dropdown chọn "ứng dụng" — hiện tại gồm **Home** (về
`home_url` của thiết bị) và **YouTube** (`m.youtube.com` — bản mobile, phù hợp hơn với hệ thống
chỉ hỗ trợ chạm đơn, chưa có pinch-zoom). Tồn tại trên **mọi trang**, kể cả sau khi chuyển URL.

**`home_url` là cài đặt riêng từng thiết bị** (text "Home URL" trên ESPHome) — server không có
cách nào tự biết giá trị này. Thêm tham số kết nối mới `?home=` (thiết bị tự gửi, mã hoá phần trăm
đúng chuẩn), đọc vào `DeviceConfig.homeUrl` **nhưng cố tình không đưa vào `deviceConfigsEqual()`**
— đổi Home URL không được phép kích "Reconfiguring" phá huỷ Chromium target, đúng bài học đã ghi
ở dòng 49 `deviceManager.ts`.

- `config.ts`: thêm `DeviceConfig.homeUrl`, đọc từ `params.get("home")`
- `deviceManager.ts`: `buildLauncherScript(homeUrl)` — sinh script riêng từng thiết bị, tiêm ngay
  sau script bàn phím
- Firmware (repo Client): `RemoteWebView::home_url_` + `set_home_url()`, gửi qua
  `append_q_str_encoded_()` (percent-encode, không dùng `append_q_str_` cũ vì không an toàn với
  URL thật chứa `&`/`=`)

## V2.9.3
### Sửa lỗi đóng gói addon: `run.sh` chưa bao giờ được gọi
Phát hiện khi điều tra vì sao đổi `user_data_dir` qua giao diện addon không có tác dụng gì:
`docker inspect` cho thấy lệnh chạy thật của container là `[node dist/index.js]` — CMD gốc của
image nền, không phải `run.sh`. File `hassio/remote_webview_server/Dockerfile` trước đây chỉ có
`FROM ${BUILD_FROM}`, không `COPY run.sh` vào image cũng không đổi `CMD`/`ENTRYPOINT` — file này
tồn tại trong repo từ trước nhưng chưa từng được thực thi.

**Hậu quả thật:** mọi tuỳ chọn trên giao diện addon (`tile_size`, `jpeg_quality`,
`max_bytes_per_message`, `user_data_dir`, ...) trừ `browser_locale` không bao giờ được áp dụng, dù
hiện trên UI như đang hoạt động bình thường.

- `Dockerfile`: `COPY run.sh`, `chmod +x`, đổi `CMD` sang chạy nó
- `run.sh`: export đầy đủ các biến môi trường (đối chiếu trực tiếp với `env.get()`/`process.env.`
  trong từng file `src/*.ts`, không đoán tên)
- `run.sh`: đổi `jq` (**không có sẵn trong image** — đã xác minh `command -v jq` thất bại) sang
  `node -e` để đọc `options.json`. Giữ `jq` sẽ khiến addon crash ngay lúc khởi động dưới `set -e`,
  biến một lỗi "tuỳ chọn không có tác dụng" thành lỗi nghiêm trọng hơn nhiều
- `run.sh`: `mkdir -p` trước khi dùng `USER_DATA_DIR` — quan trọng khi lần đầu trỏ vào `/data`
  (mount bền), thư mục con chưa tồn tại
- `config.yaml`: đổi mặc định `user_data_dir` từ `/pw-data` (**không bền**, mất sạch mỗi lần
  container tạo lại — tức mỗi lần cập nhật addon) sang `/data/pw-data` (bền qua update/restart, do
  Supervisor tự cấp riêng cho addon này)

## V2.9.2
### Khung "nhắc vẽ lại" khi đánh thức bị bộ khử trùng lặp vứt bỏ
Triệu chứng người dùng báo: xem camera (chế độ truyền thẳng, nhịp khung cao) → Go Home về dashboard
→ màn ngủ → chạm màn hình → **đèn nền sáng nhưng dashboard không hiện ra**, phải chạm lần hai mới
lên.

`flushPending()` vứt khung ngay từ đầu nếu nó **trùng byte tuyệt đối** với khung trước đó (so
`hash32`) — kiểm tra này chạy **trước cả** nhánh xử lý khung đầy đủ đã yêu cầu. Khung "nhắc vẽ lại"
mà server tự tạo khi thiết bị `resume()` (một `<div>` 2×2px, độ mờ 0,4%, đổi màu — xem
`nudgeRepaintAsync` trong `browser.ts`) sau khi Chrome nén JPEG có xác suất rất cao trùng byte
tuyệt đối với khung tĩnh trước lúc ngủ. Hash trùng → `flushPending` trả về sớm → không bao giờ chạm
tới khung đầy đủ đã đặt sẵn → thiết bị kẹt "đèn sáng, màn trống" cho tới khi người dùng tự chạm thật
(đổi điểm ảnh đủ lớn để không thể trùng hash).

- `deviceManager.ts`: thêm `requestFullFrameFor(dev)` — gọi `processor.requestFullFrame()` **đồng
  thời** vô hiệu hoá `dev.prevFrameHash = -1` (`hash32()` luôn `>>> 0` nên `-1` không bao giờ trùng
  thật)
- Thay thế cả **5 điểm gọi** `requestFullFrame()` trực tiếp trong toàn server (4 trong
  `deviceManager.ts`, 1 trong `inputRouter.ts` — chính là đường mà `resume()` kích hoạt) bằng hàm
  này, đảm bảo khung kế tiếp không bao giờ bị vứt vì lý do trùng byte với khung trước, dù là trùng
  thật hay trùng ngẫu nhiên do khung nhắc quá nhỏ

Xác minh bằng đúng kịch bản thật (camera → Go Home → ngủ → chạm), lặp lại 2 lần: khung hình mới về
sau **53ms**, đèn nền bật sau **412ms** — dashboard sẵn sàng trước khi đèn kịp sáng.

## V2.8.0
### Đồng bộ URL hai chiều — sửa lỗi "Go Home không có tác dụng"
Trước đây URL chỉ đi **một chiều** (HA → thiết bị). Khi người dùng tự chạm chuyển tab trên
dashboard, server không theo dõi gì cả, nên thiết bị và HA đều giữ giá trị cũ.

Hậu quả người dùng gặp: nút **Go Home mất tác dụng**. Nó làm `text.set` với đúng giá trị đang có,
mà ESPHome chỉ kích `set_action` khi giá trị **thay đổi**.

- `protocol.ts`: thêm `MsgType.CurrentURL = 6` + `buildCurrentURLPacket()`
- `broadcaster.ts`: `sendCurrentURL(id, url)`
- `deviceManager.ts`: lắng nghe **cả hai** sự kiện điều hướng:
  - `Page.frameNavigated` — điều hướng đầy đủ (chỉ khung chính, bỏ qua iframe)
  - `Page.navigatedWithinDocument` — **điều hướng trong cùng trang**

Sự kiện thứ hai **không thể thiếu**: dashboard Home Assistant là ứng dụng một trang, chuyển tab
chỉ đổi URL bằng `history.pushState` chứ không tải lại. Chỉ bắt `frameNavigated` sẽ bỏ sót đúng
trường hợp thường gặp nhất.

Cơ chế này **có sẵn trong bản gốc của strange-v**; fork này đã lược mất.

Phía thiết bị cần firmware có `current_url_sensor` (xem repo Client).

## V2.7.9
### Giãn nhịp ép full-frame 60s → 5 phút, và sửa biến môi trường không có tác dụng
`refreshDisplaysTick` là **bảo hiểm** chống "màn hình giữ ảnh cũ", không phải cơ chế chính. Nhưng
mỗi lần chạy là một full-frame (~50KB) cho **mỗi** thiết bị — ở nhịp 60s đó là một cú sốc tải đều
đặn mỗi phút, và nó chính là thứ làm các phép đo dao động trong suốt buổi điều tra. Bản gốc của
strange-v **không có** cơ chế này.

Giờ đã có các tuyến phòng thủ khác (áp lực ngược, vòng điều tiết, `full_frame_every` của chính
FrameProcessor) nên bảo hiểm này chỉ cần chạy thưa thớt.

**Lỗi kèm theo:** `CCR_REFRESH_MS` **chưa bao giờ điều khiển được nhịp** — nó chỉ được đọc bên
trong hàm để làm cờ bật/tắt, còn nhịp thật bị ghi cứng `60_000` ở `index.ts`. Nay biến điều khiển
cả hai; đặt `CCR_REFRESH_MS=0` để tắt hẳn.

## V2.7.8
### Trả tỉ lệ ngân sách decode về 0.5
Đã thử 0.5 → 0.7 rồi trả lại. Với 0.7, đo thật trên tab 5 thẻ camera: fps lên 15.97 nhưng hệ
**dao động** — điểm cân bằng rơi vào vùng 50ms, mà ở đó decode (37ms) chỉ hơn ngân sách (35ms)
một chút, nên chỉ cần dao động nhỏ là lật qua lật lại. Áp lực ngược can thiệp 7 lần/7 phút và
quality kẹt ở sàn 40 — tức **xin thêm chất lượng mà nhận lại ít hơn**.

Ngưỡng tránh nghẽn (2.7.7) đã chặn được dao động đó, nhưng điểm cân bằng ổn định nhất vẫn là
**100ms / 10fps** — đúng bằng với tỉ lệ 0.5. Tức 0.7 không đổi lại được gì mà chỉ đẩy hệ tới sát
mép.

**Bài học:** tỉ lệ này không phải "mức dự phòng thừa" mà là **khoảng cách an toàn** tới vùng mất
ổn định.

Ngưỡng tránh nghẽn vẫn giữ nguyên làm lưới an toàn.

## V2.7.7
### Ngưỡng tránh nghẽn — chặn dao động vô hạn (tương tự `ssthresh` của TCP)
Sau khi nới tỉ lệ ngân sách lên 0.7, đo thật trên tab 5 thẻ camera cho thấy hệ **dao động vô
hạn**:

    50ms  → decode 37ms > ngân sách 35ms → quality 70→60→50→40 → giãn 100ms
    100ms → decode 32ms "rất thấp"       → rút lại về 50ms
    (lặp lại; áp lực ngược can thiệp 7 lần / 7 phút)

**Hai triệu chứng, một nguyên nhân.** Bộ điều tiết **không nhớ** rằng 50ms vừa thất bại nên cứ
lao xuống lại. Và vì hồi phục ưu tiên nhịp trước quality, dao động đó **chiếm hết các lượt hồi
phục** → quality kẹt vĩnh viễn ở sàn 40.

- `AdaptiveState.probeFloorMs` ghi nhớ nhịp vừa gây quá tải.
- Sàn hồi phục = `max(trần thiết bị, probeFloorMs + một bước)`.
- Nới dần: bị chặn `probeRetryAfter` (6) vòng mà vẫn rất thoải mái thì hạ ngưỡng một bước để thử
  lại — không có cơ chế này thì **một lần quá tải nhất thời sẽ khoá fps vĩnh viễn**.

Đã cân nhắc đảo thứ tự hồi phục thành quality-trước, nhưng **không cần**: khi nhịp bị ngưỡng chặn,
lượt hồi phục **tự nhường** cho quality. Nguyên nhân thật là thiếu tính trễ, không phải thứ tự.

## V2.7.6
### Hồi phục nhanh hơn 4 lần sau khi đổi tab
Người dùng phản ánh trực tiếp: sau khi chuyển tab, quality bò từ sàn 40 lên trần 80 mất **~4
phút** — 8 bước, mỗi bước cần 3 mẫu tốt liên tiếp **và** chờ 20 giây.

Nguyên tắc "hồi phục chậm" là đúng, nhưng đã đặt **chậm quá mức cần thiết**. Cơ sở để nới: điều
kiện "thoải mái" vốn đã đòi decode phải dưới **một nửa** ngân sách — tức khi nhánh hồi phục chạy
thì đã có gấp đôi dư địa; bò từng bước nhỏ trong tình huống đó là thừa thận trọng.

- `qualityStepUp` 5 → **10** (8 bước → 4 bước)
- `goodStreakNeeded` 3 → **2**
- `cooldownMs` (chỉ áp cho chiều NÂNG LẠI) 20s → **10s**

Tổng: từ 40 lên 80 còn **~1 phút**. Tính bất đối xứng vẫn giữ nguyên — hạ tải trễ 5s và nhân 2,
nâng lại trễ 10s và cộng dần. Rủi ro dao động vẫn được chặn bởi: vẫn cần mẫu tốt **liên tiếp**, và
vẫn kiểm tra tồn đọng socket.

Test: các khẳng định mã hoá cứng "3 mẫu" và "bước +5" nay **suy ra từ cấu hình**; thêm một test
ràng buộc **số bước** hồi phục từ sàn lên trần (chống hồi quy).

## V2.7.5
### Nới tỉ lệ ngân sách decode 0.5 → 0.7 (fps cao hơn)
Đo thật trên tab 5 thẻ camera: decode 40ms, nên với tỉ lệ 0.5 điểm cân bằng rơi đúng **100ms
(10fps)** — nhanh hơn nữa thì ngân sách (50 → 25ms) không còn đủ. Tỉ lệ **0.7** cho phép ~70ms
(≈14fps) mà vẫn còn **30% dự phòng**.

Đây là **giảm mức dự phòng**, nên chỉ làm sau khi đã có đủ lưới an toàn: áp lực ngược (2.6.0)
phản ứng tức thì, AIMD (2.7.0) lùi nhanh, khởi động thận trọng (2.7.4). Không nên nâng tiếp lên
0.8+ mà không đo lại.

Test: hai khẳng định cũ mã hoá cứng con số 50 (= 100 × 0.5) nay **suy ra từ cấu hình**, để lần
chỉnh sau không làm hỏng test.

## V2.7.4
### Khởi động thận trọng — sửa lỗi thiết bị "mất tích" trên HASS sau mỗi lần khởi động lại
Từ khi `min_frame_interval` đổi vai trò thành **trần fps mong muốn** (33ms = 30fps), mỗi lần
thiết bị **hoặc** server khởi động lại đều bắt đầu ngay ở trần đó và dội 30fps cho tới khi vòng
điều tiết kéo xuống (~55 giây).

Trong khoảng đó `loopTask` của ESPHome bị đói, thiết bị **không phục vụ nổi API** → kết nối HA dồn
đầy 10 khe `max_connections` → thiết bị "mất tích" trên HASS. Đã xảy ra thật.

→ Phiên mới khởi đầu ở `CCR_SAFE_START_MS` (mặc định 200ms = 5fps). Nhánh hồi phục (LIFO) sẽ rút
dần về trần mà thiết bị yêu cầu **khi nó chứng minh được là theo kịp**.

Nguyên tắc: **bắt đầu chậm, tự kiểm chứng rồi mới nhanh lên.** Đối xứng với AIMD ở 2.7.0 (hỏng thì
lùi nhanh) — cộng lại thành một vòng điều khiển an toàn ở cả hai đầu.

## V2.7.3
### Hạ chu kỳ xin số liệu 30s → 10s
Sau khi hạ chu kỳ vòng điều tiết về 5s (2.7.2), chính chu kỳ **xin số liệu decode** trở thành thứ
chặn tốc độ phản ứng: vòng điều khiển chạy 5s/lần nhưng vẫn đọc lại cùng một mẫu decode cũ cho
tới khi có mẫu mới.

Đo thật: hạ tải 7 bước mất **55 giây**, trong khi lý thuyết (tick 5s + trễ 5s) là ~35 giây.

## V2.7.2
### Hạ chu kỳ vòng điều tiết 15s → 5s
Đo thật trên 2.7.1: AIMD hoàn tất 7 bước hạ tải trong **90 giây**, không phải ~25 giây như tính
toán (bước đầu 14:26:56 → bước cuối 14:28:26).

Nguyên nhân: `runAdaptiveTick` chỉ chạy **mỗi 15 giây**, nên chính chu kỳ tick mới là thứ chi
phối — còn `cooldownDownMs` (5s) thêm ở 2.7.0 **gần như không có tác dụng** vì nó ngắn hơn chu kỳ
tick.

→ Hạ tick về 5s để `cooldownDownMs` thực sự có hiệu lực. Nhịp **nâng lại** không bị ảnh hưởng:
vẫn bị `cooldownMs` (20s) giữ chậm như cũ.

## V2.7.1
Giống hệt 2.7.0 về mã nguồn — chỉ tăng số hiệu để HA mời cập nhật lại.

Khi cập nhật lên 2.7.0, addon đã kéo về image `chrome-h264` **chưa kịp build xong**, nên tuy HA
hiển thị 2.7.0 nhưng mã chạy thật vẫn là 2.6.2 (kiểm chứng: `backoffInterval` xuất hiện 0 lần,
`markInteraction` 0 lần trong `/app/dist/`). Vì `config.yaml` đã ghi 2.7.0 và addon cũng đang ở
2.7.0, HA sẽ **không** mời cập nhật lại — nên phải tăng số hiệu.

**Chỉ bấm Update sau khi GitHub Actions đã build xong (xanh).** Số hiệu nằm trong `config.yaml`,
còn mã chạy thật nằm trong image do Actions build ở tag `chrome-h264` — hai thứ này không đồng bộ
với nhau.

## V2.7.0
### AIMD — giảm nhân, tăng cộng
Để dashboard mượt thì trần fps phía thiết bị phải nâng lên (100ms → 33ms, tức 30fps). Nhưng với
bước giãn cộng 50ms như cũ, đi từ 33ms đến 400ms mất **8 bước**; nhân với thời gian trễ là gần
**3 phút** thiết bị bị dội 30fps — đúng vùng đã gây crash.

- Giãn nhịp nay **nhân** `intervalBackoffFactor` (mặc định 2): `83 → 166 → 332 → 400`, **4 bước**.
- Hồi phục vẫn **cộng** từng bước 50ms như cũ.
- Thêm `cooldownDownMs` (5s) tách khỏi `cooldownMs` (20s): **hạ tải phản ứng nhanh, nâng lại
  vẫn từ tốn**.

Đây là nguyên tắc của mọi thuật toán chống nghẽn mạng, và lý do cũng y hệt: hỏng thì phải lùi
nhanh, hồi phục thì phải chậm.

### Ưu tiên độ mượt khi người dùng đang thao tác
Độ mượt chỉ thực sự quan trọng lúc **đang** vuốt/cuộn/bấm; tab camera treo tường thì 2.5fps không
ai để ý.

- Mỗi sự kiện chạm mở một cửa sổ `CCR_INTERACTION_BOOST_MS` (mặc định 2000ms).
- Trong cửa sổ đó server dùng **nhịp gốc** (trần fps thiết bị yêu cầu) thay vì nhịp đã điều tiết,
  hết cửa sổ thì trả về mức đã điều tiết.

## V2.6.2
### Sửa lỗi điều nhịp — nhịp thực tế co lại còn bằng thời gian encode
Đo thật sau 2.6.1: bộ điều tiết đặt `minFrameInterval=400` (lẽ ra 2.5fps) nhưng server vẫn gửi
**3.93fps** — nhanh hơn 57% so với nhịp đã đặt.

`flushPending` xoá `throttleTimer` **ngay đầu hàm**, nhưng `lastProcessedMs` chỉ cập nhật ở
**cuối** — sau ~200ms encode. Trong khoảng trống đó, khung screencast mới đến thấy
`throttleTimer` rỗng **và** `since` đã lớn hơn nhịp → `delay = 0` → chạy ngay. Nhịp thực tế co
lại còn bằng thời gian encode thay vì `effInterval`.

→ Đánh mốc `lastProcessedMs` ngay khi **bắt đầu** xử lý. `finally` vẫn ghi đè bằng thời điểm kết
thúc, nên nhịp vẫn được tính từ lúc xong khung trước — đúng như thiết kế.

## V2.6.1
### Bộ điều khiển thích nghi tự vô hiệu hoá chính nó — sửa hai lỗi
Đo thật trên ESP32-P4 (tab 5 thẻ camera): nhật ký cho thấy vòng điều khiển đã hạ tải tới **kịch
sàn** (quality 70→40, nhịp 100→400ms), nhưng `/metrics` **cùng lúc đó** vẫn báo
`minFrameInterval=100`, `jpegQuality=70`, `adaptiveChanges=0`. Hai lỗi chồng nhau:

**1. Điều tiết ghi đè lên `cfg` — tự phá huỷ phiên thiết bị mỗi lần nối lại.**
`runAdaptiveTick` ghi thẳng vào `device.cfg.minFrameInterval`. Nhưng `cfg` là bản sao **duy nhất**
của "thiết bị yêu cầu gì" (từ tham số URI). Ghi đè nó làm `deviceConfigsEqual()` sai ngay lần nối
lại kế tiếp (cfg=400 vs URI=100) → nhánh `Reconfiguring` → `deleteDeviceAsync()` → **dựng lại cả
target Chromium**. Tức là chính hành động điều tiết tự bảo đảm phiên thiết bị sẽ bị phá huỷ.

→ `cfg` nay **bất biến**; giá trị đã điều tiết nằm ở `tunedMinFrameIntervalMs`.

**2. `adaptiveStates` không bao giờ được dọn.**
Phiên mới của cùng một thiết bị thừa kế trạng thái "đã kịch sàn" của phiên cũ → `decideAdaptive`
trả `changed=false` → **không giá trị nào được áp vào cfg mới**. Thiết bị chạy full tải vĩnh viễn
còn vòng điều khiển thì tưởng mình đã hạ tải xong.

→ `deleteDeviceAsync()` nay xoá luôn trạng thái thích nghi.

## V2.6.0
### Áp lực ngược theo `bufferedAmount` của WebSocket
Server trước đây gửi **vô điều kiện**, không bao giờ nhìn `bufferedAmount`. Thư viện `ws` của
Node đệm **không giới hạn** trong RAM khi phía nhận chậm, nên khi thiết bị không giải mã kịp thì
server vẫn dồn tiếp — thiết bị càng ngộp mà server không hề biết.

Đo thật trên ESP32-P4 với tab 5 thẻ camera: trong **200 giây** thiết bị vứt **1720 gói** vì hàng
đợi decode đầy, chỉ vẽ trọn **1 khung**. Kết nối API của ESPHome cũng bị reset liên tục.

- `broadcaster.backlogBytes(id)` — số byte còn kẹt trong bộ đệm gửi của socket.
- `flushPending` bỏ **nguyên khung** khi tồn đọng vượt ngưỡng (mặc định 192KB, đổi bằng
  `CCR_WS_HIGH_WATER`).
- **Phải chặn TRƯỚC `processFrameAsync()`**: nếu bỏ khung ở tầng broadcaster thì FrameProcessor
  đã tính sai phân xong và coi như thiết bị **đã nhận** các tile đó — vùng ảnh ấy hỏng vĩnh viễn
  cho tới full-frame kế tiếp. Bỏ ở đây thì nền so sánh giữ nguyên, khung sau vẫn diff đúng.
- Bỏ nguyên khung (không bỏ một phần) để không bao giờ sinh khung rách.

### Bộ điều khiển thích nghi dùng được tồn đọng làm tín hiệu
Trước đây vòng điều khiển chỉ dựa vào `decodeMs` do **thiết bị báo về**. Nhưng khi quá tải nặng
thì chính gói `FrameStats` cũng không lọt — tức là **mù đúng lúc cần nhất**.

- Thêm `backlogBytes` vào `AdaptiveSample`, `maxBacklogBytes` vào cấu hình.
- Xét **trước** nhánh "chưa có số đo decode".
- Còn tồn đọng thì **không hồi phục** dù decode nhanh.

### Sửa lỗi bánh cóc — nhịp frame không bao giờ hồi phục
Nhánh hồi phục chỉ nâng lại `quality`, không bao giờ rút ngắn `minFrameIntervalMs`. Hậu quả: tab
nặng ép nhịp 100ms → 400ms, rồi khi chuyển sang tab nhẹ thiết bị **vẫn kẹt ở 2.5fps vĩnh viễn**.

- Thêm `baseIntervalMs` (nhịp gốc thiết bị yêu cầu từ YAML).
- Hồi phục theo thứ tự **ngược** với lúc hạ tải (LIFO): rút nhịp về mức gốc trước, hết mới nâng
  quality. Không bao giờ vượt quá nhịp gốc.

## V2.5.0
### Bỏ nén JPEG hai lần — chuyển thẳng ảnh của Chrome khi đang phát video
Đường cũ nén JPEG **hai lần**: Chrome encode JPEG → `sharp` giải nén ra RGBA → FrameProcessor
encode lại. Tốn CPU cả hai đầu và mất chất lượng thế hệ thứ hai. (Lưu ý: `encodeMs` trong
`/metrics` đo SAU bước `sharp` decode, nên chi phí giải nén trước đó chưa từng được tính.)

Khi đang phát video thì gần như khung nào cũng đổi toàn bộ, tức kiểu gì cũng gửi full-frame —
lúc đó ảnh của Chrome dùng được ngay. Nay server **chuyển thẳng**, bỏ cả decode lẫn encode.

- Nhận biết "đang phát video" bằng **nhịp đến của screencast** (>= `PASSTHROUGH_MIN_FPS`, mặc
  định 8 fps, tính trên 6 khung gần nhất) — không dùng kết quả của FrameProcessor vì muốn biết
  kết quả đó thì đã phải giải nén rồi.
- Điều kiện: nhịp đủ cao · không xoay · kích thước JPEG khớp đúng màn hình (đọc bằng
  `sharp().metadata()`, chỉ đọc header) · vừa `maxBytesPerMessage`.
- Sau mỗi lần đi đường tắt, gọi `requestFullFrame()` để khung kế tiếp đi đường thường dựng lại
  nền so sánh cho đúng (bảng băm tile không được cập nhật khi đi đường tắt).
- Đặt `PASSTHROUGH_MIN_FPS=0` để tắt hẳn.

### Chất lượng screencast chọn theo từng thiết bị
Thiết bị có `maxBytesPerMessage >= 128KB` (đi được đường tắt) nay cho Chrome encode thẳng ở
`jpeg_quality` của chính thiết bị đó, thay vì luôn q90. Vì với chúng ảnh của Chrome CHÍNH LÀ
ảnh gửi đi — để q90 thì khung nặng hơn ~33%, và khi bị chặn băng thông thì fps tụt.

Thiết bị cap nhỏ (S3 32KB) không bao giờ đi được đường tắt nên **giữ nguyên q90**: chúng luôn
phải giải nén rồi nén lại theo tile, hạ nguồn xuống q60 sẽ thành nén hai lần ở q60 = ảnh xấu đi.

### Số đo thật (ESP32-P4 1024x600, trang động toàn khung)
| | Trước | Sau |
|---|---|---|
| fps | 26,42 | **30,29** |
| encode trên server | 18,86 ms | **0,00 ms** |
| byte/frame | 26.073 B | 23.355 B |
| số lần nén JPEG | 2 | **1** |

0 frame bị bỏ · 0 frameErrors · 0 oversizeDropped · 0 qualityFallbacks.

## V2.4.2
### Ép vẽ lại khi thiết bị xin hiển lại trang (chống kẹt ảnh cũ/ảnh đen)
- Trước đây khi URL KHÔNG đổi, server chỉ `requestFullFrame()` — nhưng với trang TĨNH thì
  không có frame nào được sinh ra, nên `requestFullFrame()` vô hiệu và thiết bị vẫn kẹt ảnh
  cũ (màn hình trắng chỉ sáng đèn nền).
- Nay server chèn 1 điểm 2x2px gần như trong suốt và đổi màu -> Chromium buộc phải vẽ lại ->
  screencast sinh frame -> gửi full-frame mới cho thiết bị. Điểm này vô hình với người dùng.

## V2.4.1
### Chống "màn hình trắng" (chỉ sáng đèn nền)
- Ca thực tế: sau khi server restart/update, thiết bị giữ ảnh cũ (hoặc ảnh đen) và không có
  frame mới nào để tự vẽ lại -> màn hình trắng. Nhất là khi lệnh "mở trang" ban đầu bị mất.
- Thêm bảo hiểm phía server: **60s/lan ép gửi 1 full-frame** cho mỗi thiết bị (`CCR_REFRESH_MS`,
  đặt 0 để tắt). Kèm với sửa phía component (tự gửi lại URL khi không nhận frame > 60s) đã nạp
  cho các panel -> màn hình luôn tự khôi phục.

## V2.4.0
### GĐ3.5 - telemetry RAM của thiết bị + phanh an toàn theo heap
- Gói `FrameStats` từ thiết bị nay có thể chứa thêm `heap_free` + `psram_free` (18 byte);
  server VẪN đọc được gói 10 byte của firmware cũ (tương thích ngược).
- `/metrics` thêm `deviceHeapFree`, `devicePsramFree`.
- Bộ điều khiển thích nghi có thêm "phanh": heap nội bộ thiết bị < 25 KB → hạ chất lượng
  (hoặc giãn nhịp) ngay, không chờ decode vượt ngân sách — thà giảm chất lượng còn hơn
  tràn RAM gây reboot.

## V2.3.0
### GĐ3 - vòng điều khiển thích nghi (tự chỉnh theo số đo thật)
- Mỗi thiết bị được tự chỉnh CHẤT LƯỢNG JPEG và NHỊP GỬI FRAME theo thời gian decode mà
  chính thiết bị báo về (FrameStats) + bytes/s:
  - decode vượt ngân sách (nhịp × 0.5) → giảm quality 10 mỗi bước, chạm sàn 40 thì giãn nhịp +50ms;
  - decode rất thấp (dưới nửa ngân sách) và mạng không căng → nâng lại +5 sau 3 mẫu tốt liên tiếp;
  - có thời gian trễ 20s giữa 2 lần chỉnh để tránh dao động.
- Tắt bằng `CCR_ADAPTIVE=0`. Xem trạng thái trong `/metrics`: `avgDecodeMs`, `recentMaxDecodeMs`,
  `appliedQuality`, `appliedMinFrameIntervalMs`, `adaptiveChanges`, `lastAdaptiveReason`.

## V2.2.0
### GĐ2 - giảm chi phí decode trên thiết bị (mượt hơn)
- Full-frame: gửi CẢ KHUNG trong MỘT ảnh JPEG khi vừa giới hạn bytes (thay vì chia 4 mảnh)
  -> thiết bị chỉ decode 1 lần. Không vừa thì tự quay về cách chia mảnh cũ.
- Đo được thời gian decode THẬT của thiết bị: server định kỳ 30s hỏi FrameStats,
  `/metrics` trả thêm `avgDecodeMs` / `lastDecodeMs` cho từng màn.

## V2.1.0
### Sửa lỗi màn hình đỏ (quan trọng)
- Trước đây khi 1 vùng ảnh vượt `max_bytes_per_message`, server thay vùng đó bằng MỘT KHỐI ĐỎ
  toàn khung - gặp nhiều nhất ở panel có `full_frame_tile_count: 1` (JC4827 480x272, JC1060P470 1024x600).
- Nay: tự hạ quality (x1 -> x0.75 -> x0.55 -> x0.35, sàn 20) rồi chia nhỏ vùng ảnh (2x2, đệ quy)
  để vừa giới hạn bytes; cùng đường thì bỏ qua vùng đó (giữ nội dung cũ). KHÔNG bao giờ gửi khối đỏ.
### Thêm
- `GET :18080/metrics`: số liệu thật (fps, bytes, encode ms, số lần hạ quality/chia nhỏ, lỗi, số client).
- Sửa self-test: file `self-test/test1.html` chưa được copy vào image nên tính năng self-test không chạy.

## V2.0.6
### Thêm hỗ trợ bàn phím Tiếng Việt
### Fix lỗi không hiện bàn phím

## V3.0.0
### Fix màn hình trắng khi mới cấp nguồn lần đầu
