# Social API Capability Matrix

> **Trạng thái: CHƯA XÁC MINH — tất cả các ô.**
>
> Theo `prompt.txt` §7 và §21: _"Không được điền dựa trên phỏng đoán. Hãy đánh dấu rõ các mục cần kiểm tra trong tài liệu API chính thức."_
>
> Tài liệu này **cố tình** không chứa kết luận nào về khả năng của các nền tảng. Nó chứa:
>
> 1. Ma trận với mọi ô ở trạng thái `🔎` (cần xác minh),
> 2. **Checklist xác minh cụ thể** cho từng nền tảng — đọc gì, tìm gì, trả lời câu hỏi nào,
> 3. Quy trình cập nhật ô từ `🔎` sang trạng thái đã kết luận.
>
> Cập nhật: 2026-07-27 · Người phụ trách: chưa phân công (xem `PROJECT_PLAN.md` §13 Q1)

---

## 0. Vì sao tài liệu này quan trọng hơn nó có vẻ

Ma trận này **không phải tài liệu tham khảo**. Nó là **đầu vào trực tiếp của code**:

- Nó được mã hóa thành `packages/platform-adapters/src/capabilities/matrix.ts`.
- API `/api/v1/platforms/capabilities` trả nó xuống frontend.
- Frontend dùng nó để **ẩn/disable** nút, không phải để hiện lỗi sau khi người dùng đã bấm.
- Test tự động kiểm tra: adapter cài đặt method nào thì capability tương ứng phải là `SUPPORTED`, và ngược lại.

Điền sai một ô ở đây = hứa với người dùng một tính năng không tồn tại, hoặc ẩn mất một tính năng có thật.

---

## 1. Chú giải trạng thái

| Ký hiệu | Ý nghĩa                                    | Điều kiện để dùng ký hiệu này                                                                                                                               |
| :-----: | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
|   ✅    | **SUPPORTED** — API chính thức hỗ trợ      | Đã đọc tài liệu chính thức **và** ghi lại URL + ngày. Lý tưởng: đã gọi thử thành công trên sandbox.                                                         |
|   ❌    | **UNSUPPORTED** — API không hỗ trợ         | Đã xác nhận tài liệu **không** có endpoint tương ứng, hoặc tài liệu ghi rõ là không hỗ trợ.                                                                 |
|   ⚠️    | **CONDITIONAL** — có điều kiện             | Hỗ trợ nhưng kèm ràng buộc (loại nội dung, loại tài khoản, scope đặc biệt, cần app review, chỉ với nội dung do app tạo ra…). **Bắt buộc ghi rõ điều kiện.** |
|   🔎    | **UNVERIFIED** — chưa xác minh             | Trạng thái mặc định. Trong code tương ứng `CapabilityState.UNVERIFIED`.                                                                                     |
|   🚫    | **OUT OF SCOPE** — bị chính sách dự án cấm | Không xác minh vì `prompt.txt` §3 cấm (auto like/share/comment).                                                                                            |

**Quy tắc**: một ô chỉ rời khỏi `🔎` khi có **URL tài liệu chính thức + ngày kiểm chứng + tên người kiểm chứng**. Không chấp nhận "tôi nhớ là…", blog post, câu trả lời StackOverflow, hay output của mô hình ngôn ngữ.

---

## 2. Ma trận tổng hợp — Publishing

| Chức năng                                    | Facebook Page | Instagram Business | Pinterest Business | YouTube | TikTok Business |
| -------------------------------------------- | :-----------: | :----------------: | :----------------: | :-----: | :-------------: |
| Đăng text-only                               |      🔎       |         🔎         |         🔎         |   🔎    |       🔎        |
| Đăng 1 ảnh                                   |      🔎       |         🔎         |         🔎         |   🔎    |       🔎        |
| Đăng nhiều ảnh (carousel/album)              |      🔎       |         🔎         |         🔎         |   🔎    |       🔎        |
| Đăng video                                   |      🔎       |         🔎         |         🔎         |   🔎    |       🔎        |
| Đăng video dạng ngắn (Reels/Shorts)          |      🔎       |         🔎         |         🔎         |   🔎    |       🔎        |
| Đăng kèm link                                |      🔎       |         🔎         |         🔎         |   🔎    |       🔎        |
| Đặt thumbnail tùy chọn                       |      🔎       |         🔎         |         🔎         |   🔎    |       🔎        |
| Đặt title                                    |      🔎       |         🔎         |         🔎         |   🔎    |       🔎        |
| Đặt description                              |      🔎       |         🔎         |         🔎         |   🔎    |       🔎        |
| Hashtag                                      |      🔎       |         🔎         |         🔎         |   🔎    |       🔎        |
| **Native scheduling** (nền tảng tự đăng sau) |      🔎       |         🔎         |         🔎         |   🔎    |       🔎        |
| Sửa bài đã đăng                              |      🔎       |         🔎         |         🔎         |   🔎    |       🔎        |
| Xóa bài đã đăng                              |      🔎       |         🔎         |         🔎         |   🔎    |       🔎        |

> **Lưu ý về "Lên lịch"**: hệ thống mặc định dùng _system-side scheduling_ (worker giữ bài và publish đúng giờ) cho **mọi** nền tảng — xem `PROJECT_PLAN.md` §2.4. Vì vậy hàng "Native scheduling" ở trên **không chặn** tính năng lên lịch; nó chỉ quyết định có tối ưu thêm hay không.

---

## 3. Ma trận tổng hợp — Comments

| Chức năng                                     | Facebook Page | Instagram Business | Pinterest Business | YouTube | TikTok Business |
| --------------------------------------------- | :-----------: | :----------------: | :----------------: | :-----: | :-------------: |
| Đọc comment của bài đăng                      |      🔎       |         🔎         |         🔎         |   🔎    |       🔎        |
| Đọc comment lồng nhau (reply của reply)       |      🔎       |         🔎         |         🔎         |   🔎    |       🔎        |
| Đọc thông tin tác giả comment                 |      🔎       |         🔎         |         🔎         |   🔎    |       🔎        |
| Trả lời comment                               |      🔎       |         🔎         |         🔎         |   🔎    |       🔎        |
| Ẩn comment                                    |      🔎       |         🔎         |         🔎         |   🔎    |       🔎        |
| Xóa comment                                   |      🔎       |         🔎         |         🔎         |   🔎    |       🔎        |
| Webhook khi có comment mới                    |      🔎       |         🔎         |         🔎         |   🔎    |       🔎        |
| Đọc comment của bài **không do app này đăng** |      🔎       |         🔎         |         🔎         |   🔎    |       🔎        |

> Hàng cuối cùng thường bị bỏ sót nhưng **cực kỳ quan trọng**: nhiều nền tảng chỉ cho app truy cập nội dung do chính app đó tạo ra. Nếu vậy, comment inbox sẽ **không** thấy được bài đăng cũ hoặc bài đăng thủ công — một giới hạn phải nói rõ với người dùng ngay từ onboarding.

---

## 4. Ma trận tổng hợp — Metrics & Insights

| Chỉ số                                               | Facebook Page | Instagram Business | Pinterest Business | YouTube | TikTok Business |
| ---------------------------------------------------- | :-----------: | :----------------: | :----------------: | :-----: | :-------------: |
| Views (cấp bài đăng)                                 |      🔎       |         🔎         |         🔎         |   🔎    |       🔎        |
| Likes / reactions (cấp bài đăng)                     |      🔎       |         🔎         |         🔎         |   🔎    |       🔎        |
| Số comment (cấp bài đăng)                            |      🔎       |         🔎         |         🔎         |   🔎    |       🔎        |
| Shares (cấp bài đăng)                                |      🔎       |         🔎         |         🔎         |   🔎    |       🔎        |
| Reach (cấp bài đăng)                                 |      🔎       |         🔎         |         🔎         |   🔎    |       🔎        |
| Impressions (cấp bài đăng)                           |      🔎       |         🔎         |         🔎         |   🔎    |       🔎        |
| Engagement (cấp bài đăng)                            |      🔎       |         🔎         |         🔎         |   🔎    |       🔎        |
| Saves / bookmarks                                    |      🔎       |         🔎         |         🔎         |   🔎    |       🔎        |
| Follower count (hiện tại)                            |      🔎       |         🔎         |         🔎         |   🔎    |       🔎        |
| Follower growth (chuỗi thời gian)                    |      🔎       |         🔎         |         🔎         |   🔎    |       🔎        |
| Reach/impressions cấp tài khoản                      |      🔎       |         🔎         |         🔎         |   🔎    |       🔎        |
| Nhân khẩu học người theo dõi                         |      🔎       |         🔎         |         🔎         |   🔎    |       🔎        |
| Dữ liệu theo giờ (cho "best posting time")           |      🔎       |         🔎         |         🔎         |   🔎    |       🔎        |
| **Độ trễ dữ liệu** (bao lâu mới có số)               |      🔎       |         🔎         |         🔎         |   🔎    |       🔎        |
| **Cửa sổ lịch sử** (truy vấn được bao xa về quá khứ) |      🔎       |         🔎         |         🔎         |   🔎    |       🔎        |

> ⚠️ **Cảnh báo phân tích, không phải kỹ thuật**: "reach", "impression", "engagement" có **định nghĩa khác nhau ở mỗi nền tảng**. Ngay cả khi cả 5 ô đều `✅`, việc cộng chúng thành một con số "Tổng reach" là **sai về mặt phương pháp**. Dashboard phải mặc định hiển thị **tách theo nền tảng**; nếu có số tổng thì phải kèm chú thích rõ ràng.

---

## 5. Ma trận tổng hợp — Hành động bị chính sách dự án loại trừ

| Chức năng                          | Tất cả nền tảng | Lý do                                                                                                                             |
| ---------------------------------- | :-------------: | --------------------------------------------------------------------------------------------------------------------------------- |
| Tự động **like** nội dung          |       🚫        | `prompt.txt` §3: không auto-like nếu API không cho phép. Kể cả khi có API, đây là hành vi tương tác giả — không đưa vào sản phẩm. |
| Tự động **share** nội dung         |       🚫        | Như trên.                                                                                                                         |
| Tự động **comment** hàng loạt      |       🚫        | Như trên. Trả lời comment **do người dùng chủ động soạn** thì được phép (§3 hàng 4).                                              |
| Scrape HTML / API không chính thức |       🚫        | `prompt.txt` §3.                                                                                                                  |
| Tự động follow/unfollow            |       🚫        | Hành vi bot.                                                                                                                      |

**Diễn giải cho code**: `likes`, `shares`, `reactions` chỉ tồn tại trong hệ thống dưới dạng **metric đọc** (`PostMetric.likes`, `PostMetric.shares`). Interface `SocialPlatformAdapter` **không có** và **sẽ không có** method `likePost()` hay `sharePost()`.

---

## 6. Ma trận tổng hợp — OAuth & vòng đời token

| Hạng mục                                | Facebook | Instagram | Pinterest | YouTube | TikTok |
| --------------------------------------- | :------: | :-------: | :-------: | :-----: | :----: |
| OAuth 2.0 authorization code flow       |    🔎    |    🔎     |    🔎     |   🔎    |   🔎   |
| Refresh token                           |    🔎    |    🔎     |    🔎     |   🔎    |   🔎   |
| Thời hạn access token                   |    🔎    |    🔎     |    🔎     |   🔎    |   🔎   |
| Thời hạn refresh token                  |    🔎    |    🔎     |    🔎     |   🔎    |   🔎   |
| Endpoint thu hồi token                  |    🔎    |    🔎     |    🔎     |   🔎    |   🔎   |
| Cần **app review** cho scope production |    🔎    |    🔎     |    🔎     |   🔎    |   🔎   |
| Cần **business verification**           |    🔎    |    🔎     |    🔎     |   🔎    |   🔎   |
| Có sandbox/dev mode để phát triển       |    🔎    |    🔎     |    🔎     |   🔎    |   🔎   |
| Giới hạn số tài khoản test ở dev mode   |    🔎    |    🔎     |    🔎     |   🔎    |   🔎   |
| Rate limit: cơ chế & hạn mức            |    🔎    |    🔎     |    🔎     |   🔎    |   🔎   |
| Header/field báo quota còn lại          |    🔎    |    🔎     |    🔎     |   🔎    |   🔎   |

Hàng cuối quan trọng cho `ApiRequestLog` và rate limiter: nếu nền tảng trả về quota còn lại, worker có thể chủ động giảm tốc trước khi bị chặn thay vì đợi lỗi 429.

---

## 7. Ràng buộc media cần tra cứu (đầu vào cho validator)

Mỗi ô sau là **một con số cụ thể** cần điền, không phải có/không. Đây là đầu vào trực tiếp cho `<platform>.validator.ts`.

| Ràng buộc                                                       | FB  | IG  | Pinterest | YouTube | TikTok |
| --------------------------------------------------------------- | :-: | :-: | :-------: | :-----: | :----: |
| Giới hạn ký tự caption/description                              | 🔎  | 🔎  |    🔎     |   🔎    |   🔎   |
| Giới hạn ký tự title                                            | 🔎  | 🔎  |    🔎     |   🔎    |   🔎   |
| Số hashtag tối đa                                               | 🔎  | 🔎  |    🔎     |   🔎    |   🔎   |
| Định dạng ảnh cho phép                                          | 🔎  | 🔎  |    🔎     |   🔎    |   🔎   |
| Kích thước ảnh tối đa (MB)                                      | 🔎  | 🔎  |    🔎     |   🔎    |   🔎   |
| Tỉ lệ khung ảnh cho phép                                        | 🔎  | 🔎  |    🔎     |   🔎    |   🔎   |
| Độ phân giải ảnh tối thiểu/tối đa                               | 🔎  | 🔎  |    🔎     |   🔎    |   🔎   |
| Số ảnh tối đa mỗi bài                                           | 🔎  | 🔎  |    🔎     |   🔎    |   🔎   |
| Định dạng video cho phép                                        | 🔎  | 🔎  |    🔎     |   🔎    |   🔎   |
| Codec video/audio yêu cầu                                       | 🔎  | 🔎  |    🔎     |   🔎    |   🔎   |
| Kích thước video tối đa (MB/GB)                                 | 🔎  | 🔎  |    🔎     |   🔎    |   🔎   |
| Thời lượng video min/max                                        | 🔎  | 🔎  |    🔎     |   🔎    |   🔎   |
| Tỉ lệ khung video cho phép                                      | 🔎  | 🔎  |    🔎     |   🔎    |   🔎   |
| Cơ chế upload (URL công khai / multipart / resumable / chunked) | 🔎  | 🔎  |    🔎     |   🔎    |   🔎   |
| Trường bắt buộc khi publish                                     | 🔎  | 🔎  |    🔎     |   🔎    |   🔎   |

> **"Cơ chế upload" là hàng có ảnh hưởng kiến trúc lớn nhất trong bảng này.** Nếu một nền tảng yêu cầu media phải nằm ở **URL công khai truy cập được**, thì bucket private + signed URL sẽ không đủ — cần thêm cơ chế phát hành URL công khai tạm thời với TTL ngắn. Nếu nền tảng dùng **resumable/chunked upload**, worker phải hỗ trợ upload nhiều phần và tiếp tục được sau khi lỗi. Phải xác minh hàng này **trước** khi code `packages/platform-adapters` và module `media`.

---

## 8. Checklist xác minh theo nền tảng

Với mỗi nền tảng, người phụ trách phải trả lời **toàn bộ** câu hỏi bên dưới, kèm URL trang tài liệu và ngày truy cập.

### 8.1 Facebook Pages

**Điểm vào tài liệu chính thức** (kiểm tra lại vì Meta tái cấu trúc docs thường xuyên):

- Pages API: `https://developers.facebook.com/docs/pages-api/`
- Graph API reference: `https://developers.facebook.com/docs/graph-api/`
- Permissions reference: `https://developers.facebook.com/docs/permissions/`
- Webhooks: `https://developers.facebook.com/docs/graph-api/webhooks/`
- App review: `https://developers.facebook.com/docs/app-review/`

**Câu hỏi cần trả lời:**

1. Phiên bản Graph API mới nhất là gì? Lịch deprecate của phiên bản đang dùng? _(quyết định giá trị pin trong config)_
2. Danh sách **chính xác** scope cần cho: đăng bài, đọc bài, đọc/trả lời comment, đọc insights? Scope nào cần app review?
3. Page access token lấy thế nào từ user access token? Thời hạn? Có loại token không hết hạn không, điều kiện là gì?
4. Endpoint publish ảnh, publish video, publish Reels — khác nhau ra sao?
5. Có tham số scheduled publish native không? Ràng buộc thời gian tối thiểu/tối đa?
6. Endpoint đọc comment, trả lời comment, ẩn comment, xóa comment — cái nào tồn tại?
7. App có đọc được comment của bài **không do app đăng** không?
8. Insights nào có ở cấp post, cấp page? Tên metric chính xác? Độ trễ? Cửa sổ lịch sử?
9. Webhook: field nào subscribe được (feed, comment…)? Xác thực chữ ký bằng header nào, thuật toán gì?
10. Rate limit: theo app hay theo page? Header nào cho biết quota còn lại?
11. Business verification có bắt buộc không cho các scope trên?

### 8.2 Instagram Business

**Điểm vào tài liệu chính thức:**

- Instagram Platform: `https://developers.facebook.com/docs/instagram-platform/`
- Content publishing: `https://developers.facebook.com/docs/instagram-platform/content-publishing`
- Insights: `https://developers.facebook.com/docs/instagram-platform/insights`

**Câu hỏi cần trả lời:**

1. Có mấy con đường tích hợp (qua Facebook Login vs Instagram Login trực tiếp)? Khác nhau về khả năng ra sao? Chọn cái nào?
2. Yêu cầu loại tài khoản: Business, Creator, hay cả hai? Có bắt buộc liên kết với Facebook Page không?
3. Quy trình publish gồm mấy bước (tạo media container → publish)? Có giới hạn số bài publish trong 24h không?
4. Ảnh/video phải cung cấp bằng **URL công khai** hay upload trực tiếp? _(→ ảnh hưởng thiết kế storage, xem §7)_
5. Carousel: hỗ trợ không, tối đa bao nhiêu item?
6. Reels: endpoint riêng? Ràng buộc thời lượng/tỉ lệ?
7. Đọc comment, trả lời comment, ẩn comment, xóa comment — cái nào có?
8. Metric cấp media và cấp account: tên chính xác? Có phân biệt reach/impressions không? Metric nào đã bị deprecate?
9. Webhook cho comment/mention: có không? Subscribe thế nào?
10. Rate limit tính theo cái gì?

### 8.3 Pinterest Business

**Điểm vào tài liệu chính thức:**

- API v5: `https://developers.pinterest.com/docs/api/v5/`
- Getting started / app review: `https://developers.pinterest.com/docs/getting-started/`

**Câu hỏi cần trả lời:**

1. Phiên bản API hiện hành? v5 còn là mới nhất không?
2. Scope cần cho: tạo pin, đọc pin, đọc analytics, đọc/ghi comment?
3. Tạo Pin: bắt buộc phải có board? Ảnh cung cấp bằng URL hay upload? Ràng buộc kích thước/tỉ lệ?
4. Video Pin: hỗ trợ không? Cơ chế upload (có phải đăng ký media rồi upload không)? Thời lượng cho phép?
5. Pinterest có khái niệm "comment" trên Pin không, và **có API cho nó không**? _(nếu không → comment inbox không áp dụng cho Pinterest, phải nói rõ trên UI)_
6. Analytics: metric nào có (impression, save, pin click, outbound click)? Độ trễ? Cửa sổ lịch sử?
7. Native scheduling có hỗ trợ không?
8. Có webhook không? _(nếu không → chỉ polling)_
9. Rate limit và app review: quy trình, thời gian dự kiến, có cần business account đã xác minh không?

### 8.4 YouTube

**Điểm vào tài liệu chính thức:**

- Data API v3: `https://developers.google.com/youtube/v3/docs`
- Analytics & Reporting API: `https://developers.google.com/youtube/analytics`
- Quota: `https://developers.google.com/youtube/v3/getting-started#quota`
- OAuth scopes: `https://developers.google.com/identity/protocols/oauth2/scopes#youtube`

**Câu hỏi cần trả lời:**

1. **Quota**: hạn mức mặc định mỗi ngày là bao nhiêu đơn vị? Chi phí đơn vị của `videos.insert`, `videos.list`, `commentThreads.list`, `comments.insert`? _(YouTube tính quota theo đơn vị chứ không theo số request — đây là khác biệt lớn so với các nền tảng khác và phải được mô hình hóa riêng trong rate limiter)_
2. Xin tăng quota bằng cách nào? Mất bao lâu?
3. Upload video: cơ chế resumable upload hoạt động ra sao? Giới hạn kích thước? _(→ worker phải hỗ trợ)_
4. Đặt thumbnail tùy chọn: cần điều kiện gì với kênh?
5. Video mới upload có bị giới hạn chế độ riêng tư khi app chưa được verify không?
6. Shorts: có endpoint riêng hay chỉ là video ngắn theo tỉ lệ dọc?
7. `publishAt` (native scheduling) hoạt động với điều kiện nào?
8. Đọc comment, trả lời comment, xóa comment, kiểm duyệt comment — endpoint nào có?
9. Analytics: dùng Data API hay Analytics API? Metric nào có ở cấp video? Độ trễ? Cửa sổ lịch sử?
10. Google OAuth verification: scope nào là "sensitive"/"restricted"? Có cần security assessment không, chi phí và thời gian?

### 8.5 TikTok Business

**Điểm vào tài liệu chính thức:**

- Developer portal: `https://developers.tiktok.com/`
- Content Posting API: `https://developers.tiktok.com/doc/content-posting-api-get-started/`
- Display API: `https://developers.tiktok.com/doc/display-api-get-started/`

**Câu hỏi cần trả lời:**

1. Phân biệt các API: Content Posting API, Display API, Business API — cái nào cần cho use case nào? Điều kiện truy cập từng cái?
2. Scope cần cho: đăng video, đọc video, đọc metric, đọc comment?
3. Publish video: cơ chế upload (chunked? từ URL?)? Có bước "khởi tạo" trước không? Ràng buộc kích thước/thời lượng/tỉ lệ?
4. Có chế độ "direct post" (đăng thẳng) hay chỉ "upload to inbox" (đẩy vào hộp nháp, người dùng phải mở app hoàn tất)? _(**Nếu chỉ có upload-to-inbox thì tính năng "đăng theo lịch tự động" cho TikTok là bất khả thi** — đây là câu hỏi quan trọng nhất của mục này và phải trả lời trước khi hứa hẹn với người dùng)_
5. Đăng ảnh (photo post): có hỗ trợ không?
6. Đọc comment: API nào? Trả lời comment: có không?
7. Metric cấp video và cấp tài khoản: có gì? Độ trễ?
8. Có webhook không?
9. App review: quy trình, thời gian, có yêu cầu URL demo/video demo không?
10. Có yêu cầu hiển thị nhãn/UX bắt buộc trong app của bên thứ ba không (một số nền tảng bắt buộc điều này và **có thể ảnh hưởng thiết kế UI**)?

**Kết luận đã xác minh 2026-07-30:**

- Video: có cả Direct Post (`/v2/post/publish/video/init/`, scope `video.publish`) và Upload to Inbox (`/v2/post/publish/inbox/video/init/`, scope `video.upload`). Cả hai hỗ trợ `FILE_UPLOAD` chunked, nên video có thể lấy bytes từ storage private/local của hệ thống.
- Photo: hỗ trợ qua `/v2/post/publish/content/init/` với `media_type=PHOTO`, nhưng chỉ nhận `PULL_FROM_URL`. Vì vậy ảnh phải có URL HTTPS public và domain/prefix phải verify trong TikTok Developer Portal.
- Status/cancel: trạng thái publish đọc bằng `/v2/post/publish/status/fetch/`; cancel dùng `/v2/post/publish/cancel/` best-effort cho task chưa vào final state.
- Display API: `/v2/video/list/` và `/v2/video/query/` dùng scope `video.list` để đọc video/metric cơ bản (`view_count`, `like_count`, `comment_count`, `share_count`). Scope này bật bằng `TIKTOK_ENABLE_VIDEO_LIST_SCOPE=true` sau khi app đã được cấp quyền, vì app chưa được cấp quyền sẽ fail OAuth nếu request mặc định.
- Comment inbox/reply organic: chưa có trong public Content Posting/Display API; không bật UI cho TikTok comments/replies trong adapter hiện tại.

---

## 9. Quy trình cập nhật ma trận

```
1. Người phụ trách đọc tài liệu chính thức, trả lời checklist §8.
2. Điền vào bảng §2–§7:  ✅ / ❌ / ⚠️  + ghi chú điều kiện.
3. Thêm dòng vào §10 (nhật ký xác minh): ngày · nền tảng · mục · kết luận · URL · người kiểm chứng.
4. Cập nhật packages/platform-adapters/src/capabilities/matrix.ts cho khớp.
5. Chạy test: npm run test -w packages/platform-adapters
   → test sẽ FAIL nếu code và ma trận không khớp.
6. Nếu một ô chuyển thành ❌ và tính năng đó đã có trên UI → tạo issue để gỡ/ẩn tính năng.
```

**Quy tắc hết hạn**: ô đã xác minh quá **90 ngày** sẽ được CI cảnh báo (không fail build) để rà lại — API của các nền tảng thay đổi liên tục.

---

## 10. Nhật ký xác minh

| Ngày | Nền tảng | Mục | Kết luận                          | URL nguồn | Người kiểm chứng |
| ---- | -------- | --- | --------------------------------- | --------- | ---------------- |
| —    | —        | —   | _(chưa có mục nào được xác minh)_ | —         | —                |

---

## 11. Ảnh hưởng tới sản phẩm khi một ô là ❌

Bảng này định nghĩa trước cách hệ thống hành xử, để không phải quyết định vội khi phát hiện giới hạn:

| Ô là ❌               | Hành vi hệ thống                                                                                                                                   |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trả lời comment       | Nút "Reply" **ẩn** với nền tảng đó. Inbox vẫn hiển thị comment kèm badge "chỉ đọc" và link mở comment gốc trên nền tảng.                           |
| Xóa/ẩn comment        | Menu hành động không hiện các mục đó.                                                                                                              |
| Đọc comment           | Nền tảng đó **không xuất hiện** trong bộ lọc của Inbox. Trang Inbox hiển thị dòng giải thích nền tảng nào được hỗ trợ.                             |
| Một metric cụ thể     | Ô trong bảng/biểu đồ hiển thị `—` với tooltip "Nền tảng không cung cấp chỉ số này", **không phải `0`**. Metric đó bị loại khỏi mọi phép tính tổng. |
| Xóa bài trên nền tảng | Chỉ cho "xóa khỏi hệ thống", kèm cảnh báo bài vẫn còn trên nền tảng, có link mở bài gốc.                                                           |
| Native scheduling     | Không ảnh hưởng — dùng system-side scheduling.                                                                                                     |
| Direct post (TikTok)  | Tính năng lên lịch cho nền tảng đó bị **vô hiệu hóa hoàn toàn**, kèm giải thích trong UI. Không được giả vờ là có.                                 |
| Webhook               | Chuyển sang polling với tần suất phù hợp; ghi rõ độ trễ dự kiến trong tài liệu người dùng.                                                         |
