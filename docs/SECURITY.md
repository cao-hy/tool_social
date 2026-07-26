# SocialHub Manager — Security Model

> Mô hình bảo mật của hệ thống. Đối tượng: developer + reviewer.
> Cập nhật: 2026-07-27.

---

## 1. Tài sản cần bảo vệ (xếp theo mức độ nghiêm trọng nếu bị lộ)

| #   | Tài sản                                                    |       Mức       | Hậu quả nếu bị lộ                                                                                                                            |
| --- | ---------------------------------------------------------- | :-------------: | -------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | **Access/refresh token của nền tảng**                      | 🔴 Nghiêm trọng | Kẻ tấn công đăng bài, xóa nội dung, đọc dữ liệu riêng tư **trên tài khoản thật của khách hàng**. Đây là tài sản giá trị nhất trong hệ thống. |
| A2  | `ENCRYPTION_KEY` (khóa mã hóa token)                       | 🔴 Nghiêm trọng | Giải mã toàn bộ A1.                                                                                                                          |
| A3  | Session cookie người dùng                                  |     🟠 Cao      | Chiếm quyền tài khoản trong hệ thống.                                                                                                        |
| A4  | Password hash                                              |     🟠 Cao      | Tấn công offline, credential stuffing sang dịch vụ khác.                                                                                     |
| A5  | OAuth client secret của app                                |     🟠 Cao      | Mạo danh ứng dụng.                                                                                                                           |
| A6  | Dữ liệu nghiệp vụ workspace (bài đăng, comment, analytics) |  🟡 Trung bình  | Rò rỉ dữ liệu kinh doanh của khách hàng.                                                                                                     |
| A7  | Webhook signing secret                                     |  🟡 Trung bình  | Bơm sự kiện giả vào hệ thống.                                                                                                                |
| A8  | Media asset                                                |  🟡 Trung bình  | Rò rỉ nội dung chưa công bố.                                                                                                                 |

---

## 2. Mã hóa token (A1) — chi tiết triển khai

### 2.1 Yêu cầu

- Thuật toán: **AES-256-GCM** (authenticated encryption — vừa mã hóa vừa chống sửa đổi).
- IV **ngẫu nhiên 12 byte cho mỗi lần mã hóa**, không bao giờ tái sử dụng.
- Auth tag 16 byte, lưu kèm.
- Khóa **không nằm trong database**, đến từ biến môi trường / secret manager.
- Có **key versioning** để rotate khóa mà không cần dừng hệ thống.

### 2.2 Định dạng lưu trữ

```
v1:<base64(iv)>:<base64(authTag)>:<base64(ciphertext)>
 │
 └── version của khóa → tra trong keyring để chọn đúng khóa giải mã
```

Trường `SocialToken.encryptionKeyVersion` lưu song song để truy vấn/kiểm kê nhanh mà không cần parse chuỗi.

### 2.3 Quy tắc bất di bất dịch

| #   | Quy tắc                                                                                                                                              |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Token **không bao giờ** rời khỏi `apps/api` và `apps/worker`. Không có endpoint nào trả token cho client, kể cả dạng che một phần.                   |
| 2   | Token **không bao giờ** xuất hiện trong log. Pino redaction bắt buộc; ngoài ra `PlatformError.raw` phải đi qua hàm `redact()` trước khi lưu.         |
| 3   | Token **không bao giờ** vào Sentry — `beforeSend` lọc.                                                                                               |
| 4   | Token **không bao giờ** nằm trong URL query string (URL bị log ở mọi tầng proxy).                                                                    |
| 5   | Giải mã ở phạm vi hẹp nhất có thể: chỉ ngay trước khi gọi API, không giữ trong biến dài hạn hay cache.                                               |
| 6   | Mọi lần đọc token đều ghi `AuditLog` (actor, socialAccountId, mục đích).                                                                             |
| 7   | Ngắt kết nối tài khoản → **thu hồi token ở nền tảng** (nếu API hỗ trợ) rồi mới xóa bản ghi. Xóa mà không thu hồi để lại token còn hiệu lực trôi nổi. |

### 2.4 Chiến lược rotate khóa (A2)

```
1. Tạo khóa mới → thêm vào keyring dưới version mới (v2), đặt làm khóa mã hóa mặc định.
2. Khóa cũ (v1) VẪN nằm trong keyring để giải mã dữ liệu cũ.
3. Chạy job re-encrypt theo lô: đọc → giải mã bằng v1 → mã hóa lại bằng v2 → ghi.
4. Khi không còn bản ghi nào ở v1 (kiểm tra bằng encryptionKeyVersion) → gỡ v1 khỏi keyring.
```

Định dạng biến môi trường hỗ trợ nhiều khóa: `ENCRYPTION_KEYS=v1:<base64-32byte>,v2:<base64-32byte>` + `ENCRYPTION_ACTIVE_KEY=v2`.

**Rotate định kỳ**: 12 tháng/lần, hoặc **ngay lập tức** khi nghi ngờ lộ khóa.

---

## 3. Xác thực & phiên (A3, A4)

| Hạng mục             | Quy định                                                                                                                     |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Hash mật khẩu        | **Argon2id** (ưu tiên) hoặc bcrypt cost ≥ 12. Không bao giờ MD5/SHA-1/SHA-256 trần.                                          |
| Chính sách mật khẩu  | Tối thiểu 12 ký tự; kiểm tra chống mật khẩu phổ biến. **Không** ép đổi mật khẩu định kỳ (phản tác dụng theo hướng dẫn NIST). |
| Cookie phiên         | `HttpOnly` · `Secure` (production) · `SameSite=Lax` · `Path=/` · có thời hạn                                                 |
| Chiến lược phiên     | **Database session** (không phải JWT) → thu hồi được ngay lập tức                                                            |
| Thời hạn phiên       | 30 ngày trượt, tối đa tuyệt đối 90 ngày                                                                                      |
| Sau khi đăng nhập    | Tạo session ID mới (chống session fixation)                                                                                  |
| Đổi mật khẩu         | **Hủy toàn bộ phiên khác** của người dùng đó                                                                                 |
| Reset password token | Ngẫu nhiên ≥256 bit, **lưu dạng hash**, dùng 1 lần, hết hạn sau 1 giờ                                                        |
| Chống dò tài khoản   | `/auth/forgot-password` và `/auth/login` trả thông báo **không phân biệt** email tồn tại hay không                           |
| Rate limit đăng nhập | Theo IP **và** theo email; backoff lũy tiến sau các lần thất bại                                                             |
| 2FA                  | Phase sau (TOTP). Schema dự trù sẵn trường để tránh migration lớn.                                                           |

---

## 4. Phân quyền & cách ly tenant (A6)

**Đây là loại lỗ hổng dễ mắc nhất trong ứng dụng multi-tenant** (OWASP: Broken Access Control — hạng mục số 1). Phòng thủ nhiều lớp:

| Lớp             | Cơ chế                                                                                                                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| L1 — Guard      | `AuthGuard` → `WorkspaceGuard` (user có là member của `:wid`?) → `RoleGuard` (`@RequireRole`)                                                                                                          |
| L2 — Repository | Mọi method của repository nghiệp vụ **bắt buộc** nhận `workspaceId` và đưa vào `where`. Ràng buộc bằng kiểu dữ liệu, không phải bằng kỷ luật.                                                          |
| L3 — Service    | Kiểm tra quy tắc nghiệp vụ: không xóa Owner cuối cùng; Admin không tự nâng mình lên Owner; không gán comment cho người ngoài workspace.                                                                |
| L4 — ID         | Dùng **CUID/UUID**, không dùng số tự tăng → không đoán được ID của tenant khác.                                                                                                                        |
| L5 — Test       | **Test riêng cho từng endpoint**: user của workspace A truy cập tài nguyên của workspace B → phải nhận `404` (không phải `403`, để không lộ sự tồn tại của tài nguyên). Đây là luồng E2E #14 bắt buộc. |
| L6 — (dự phòng) | Postgres Row-Level Security — schema đã sẵn sàng, bật khi cần mức đảm bảo cao hơn.                                                                                                                     |

### Chống leo thang đặc quyền

- Vai trò **không** được truyền từ client trong bất kỳ request nào — luôn đọc từ `WorkspaceMember` trong DB.
- Admin không thể tự đổi vai trò của chính mình.
- Chuyển quyền sở hữu là thao tác riêng, chỉ Owner thực hiện, có audit log và (khuyến nghị) xác nhận qua email.

---

## 5. Bảo mật OAuth

| Rủi ro                                  | Biện pháp                                                                                                       |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| CSRF trong luồng OAuth                  | Tham số `state` ngẫu nhiên ≥256 bit, lưu Redis với TTL 10′, **dùng một lần**, gắn với `userId` + `workspaceId`  |
| Authorization code interception         | Dùng **PKCE** với mọi nền tảng hỗ trợ                                                                           |
| Open redirect                           | `redirect_uri` chỉ được chọn từ **danh sách trắng cố định** trong config, không bao giờ lấy từ input người dùng |
| Rò rỉ code qua Referer                  | Callback xử lý xong redirect ngay, không render trang có tài nguyên ngoài                                       |
| Người dùng nối tài khoản của người khác | Callback kiểm tra session hiện tại khớp với `userId` đã lưu trong `state`                                       |
| Token trả về frontend                   | **Không bao giờ.** Callback nằm ở `api`, không ở `web`.                                                         |

---

## 6. Bảo mật webhook (A7)

```
1. Đọc RAW body (Fastify: bật rawBody cho route webhook).
   → Signature tính trên byte thô. JSON.parse rồi stringify lại sẽ làm sai chữ ký.
2. Verify HMAC bằng timing-safe comparison (crypto.timingSafeEqual).
   → So sánh bằng === bị tấn công phân tích thời gian.
3. Kiểm tra timestamp trong khoảng cho phép (±5 phút) nếu nền tảng cung cấp → chống replay.
4. Unique constraint (platform, externalEventId) → chống xử lý trùng.
5. Sai chữ ký → 401, KHÔNG log payload (có thể chứa dữ liệu do kẻ tấn công điều khiển).
6. Giới hạn kích thước body.
7. Trả 200 nhanh, đẩy xử lý vào queue.
```

Webhook secret khác nhau cho mỗi nền tảng, lưu trong env, không hard-code.

---

## 7. Xử lý đầu vào & upload (A8)

### 7.1 Validation

- **Zod** cho mọi DTO ở biên (HTTP body, query, param, webhook payload, **và response từ platform API**).
- Nguyên tắc allowlist: chỉ nhận field đã khai báo; `strict()` để từ chối field lạ.
- Giới hạn kích thước: JSON body, độ dài chuỗi, số phần tử mảng, độ sâu lồng nhau.

### 7.2 Upload media

| Bước                          | Kiểm tra                                                                                                                                |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Xin signed URL             | Kiểm tra quyền, quota workspace, kiểm tra `contentType` khai báo thuộc allowlist                                                        |
| 2. Client upload thẳng lên S3 | File **không đi qua** API server → không tốn băng thông/RAM server                                                                      |
| 3. Xác nhận hoàn tất          | **Đọc magic bytes để xác định MIME thật**, không tin `Content-Type` do client khai. Kiểm tra kích thước thật, độ phân giải, thời lượng. |
| 4. Chuẩn hóa                  | **Strip EXIF** (chứa GPS, thông tin thiết bị — rò rỉ quyền riêng tư). Tạo thumbnail ở worker.                                           |
| 5. Lưu trữ                    | Bucket **private**, tên file ngẫu nhiên (không dùng tên do người dùng đặt), truy cập qua signed URL TTL ngắn                            |

Allowlist định dạng: chỉ ảnh/video, **không bao giờ** SVG (chứa script → XSS), không HTML, không file thực thi.

### 7.3 XSS

- React escape mặc định; **cấm** `dangerouslySetInnerHTML` với nội dung do người dùng/nền tảng cung cấp.
- Nội dung comment lấy từ nền tảng được coi là **không tin cậy** — render dạng text thuần.
- Content-Security-Policy chặt (xem §9).

### 7.4 SQL injection

Prisma dùng parameterized query. `$queryRaw` chỉ được dùng khi thật sự cần và **bắt buộc** dùng tagged template (`$queryRaw\`...\``), không bao giờ nối chuỗi. Mọi PR có `$queryRawUnsafe` phải được Lead review riêng.

### 7.5 SSRF

Điểm rủi ro: bất cứ nơi nào hệ thống fetch một URL do người dùng cung cấp (ví dụ import media từ URL, hoặc nếu adapter cần URL công khai).

Biện pháp:

- Chỉ cho phép scheme `https`.
- **Chặn IP nội bộ**: `127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16` (metadata endpoint của cloud), `::1`, IPv6 ULA.
- Resolve DNS **trước**, kiểm tra IP đích, và chống DNS rebinding (kiểm tra lại IP tại thời điểm kết nối).
- Không tự động follow redirect, hoặc follow có giới hạn và kiểm tra lại IP ở mỗi chặng.
- Timeout ngắn, giới hạn kích thước response.

---

## 8. Rate limiting

| Phạm vi                         | Giới hạn (khởi điểm, điều chỉnh theo dữ liệu thật) |
| ------------------------------- | -------------------------------------------------- |
| Toàn cục theo IP                | 100 req/phút                                       |
| `/auth/login`, `/auth/register` | 5 req/phút/IP + backoff theo email                 |
| `/auth/forgot-password`         | 3 req/giờ/email                                    |
| Xin signed upload URL           | 30 req/phút/user                                   |
| Publish                         | 20 req/phút/workspace                              |
| Webhook                         | Cao hơn (nền tảng gửi burst), nhưng có trần        |

Lưu counter trong Redis để có hiệu lực trên nhiều instance. Trả `Retry-After` header.

**Rate limit hướng ra ngoài** (bảo vệ quota của nền tảng, không phải bảo vệ mình): xem `ARCHITECTURE.md` §queue.

---

## 9. Security headers

| Header                      | Giá trị                                                                                                         |
| --------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains; preload`                                                                  |
| `Content-Security-Policy`   | `default-src 'self'` + allowlist tối thiểu cho ảnh (CDN media) và Sentry. **Không** `unsafe-inline` cho script. |
| `X-Content-Type-Options`    | `nosniff`                                                                                                       |
| `X-Frame-Options`           | `DENY` (kèm `frame-ancestors 'none'` trong CSP)                                                                 |
| `Referrer-Policy`           | `strict-origin-when-cross-origin`                                                                               |
| `Permissions-Policy`        | tắt camera, microphone, geolocation, payment                                                                    |
| `X-Powered-By`              | **gỡ bỏ**                                                                                                       |

Áp dụng bằng Helmet ở `api` và header config ở `web`.

**CSRF**: cookie `SameSite=Lax` là lớp một; thêm CSRF token (double-submit) cho các request thay đổi trạng thái là lớp hai. CORS chỉ cho phép origin của `web`, `credentials: true`, allowlist cố định — không bao giờ phản chiếu `Origin` từ request.

---

## 10. Quản lý secret

| Quy tắc                              |                                                                               |
| ------------------------------------ | ----------------------------------------------------------------------------- |
| Không commit `.env`                  | `.gitignore` chặn; `.env.example` chỉ có placeholder                          |
| Không hard-code secret trong source  | CI chạy secret scanning (gitleaks)                                            |
| Secret ở production                  | Từ secret manager của nền tảng deploy, không phải file                        |
| Secret khác nhau theo môi trường     | dev / staging / production không dùng chung                                   |
| Rotate                               | Định kỳ, và ngay khi có người rời team                                        |
| Không log secret                     | Pino redaction + review thủ công                                              |
| Không đưa secret vào bundle frontend | Chỉ biến `NEXT_PUBLIC_*` mới lộ ra client — review kỹ mọi biến có tiền tố này |

---

## 11. Audit log

### Sự kiện bắt buộc ghi

`USER_LOGIN` · `USER_LOGIN_FAILED` · `USER_LOGOUT` · `PASSWORD_CHANGED` · `PASSWORD_RESET_REQUESTED` · `SOCIAL_ACCOUNT_CONNECTED` · `SOCIAL_ACCOUNT_DISCONNECTED` · `SOCIAL_TOKEN_REFRESHED` · `SOCIAL_TOKEN_ACCESSED` · `POST_CREATED` · `POST_UPDATED` · `POST_DELETED` · `POST_PUBLISHED` · `POST_SCHEDULED` · `COMMENT_REPLIED` · `COMMENT_DELETED` · `COMMENT_HIDDEN` · `MEMBER_INVITED` · `MEMBER_REMOVED` · `ROLE_CHANGED` · `OWNERSHIP_TRANSFERRED` · `WORKSPACE_SETTINGS_CHANGED` · `PERMISSION_DENIED`

### Cấu trúc bản ghi

```ts
{
  id, workspaceId, actorUserId, actorIp, actorUserAgent,
  action, resourceType, resourceId,
  before?: Json,      // đã lọc trường nhạy cảm
  after?: Json,       // đã lọc trường nhạy cảm
  metadata?: Json,
  requestId, createdAt
}
```

### Quy tắc

- **Append-only.** Không có endpoint sửa/xóa audit log.
- **Không chứa secret.** `before`/`after` đi qua hàm lọc trường nhạy cảm.
- Giữ tối thiểu **1 năm**.
- Ghi audit **không được** làm hỏng nghiệp vụ: nếu ghi log lỗi thì báo lỗi ra hệ thống giám sát, không rollback transaction nghiệp vụ.

---

## 12. Xử lý sự cố token & tài khoản

| Tình huống                        | Phản ứng                                                                                                                                  |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Token sắp hết hạn (<24h)          | Job `refresh-social-token` tự refresh; nếu không refresh được → notification "cần kết nối lại"                                            |
| Token bị thu hồi (`AUTH_INVALID`) | `SocialAccount.status = DISCONNECTED` + lưu `lastErrorMessage` + notification cho ADMIN + **dừng mọi job liên quan** (không retry vô ích) |
| Refresh thất bại nhiều lần        | Đánh dấu `NEEDS_RECONNECT`, hiện banner trong UI                                                                                          |
| Rate limited                      | Backoff theo `Retry-After`; nếu kéo dài → notification                                                                                    |
| Nghi ngờ lộ token                 | Quy trình: thu hồi token ở nền tảng → xóa bản ghi → rotate `ENCRYPTION_KEY` → thông báo khách hàng → rà audit log                         |

---

## 13. Checklist review bảo mật (dùng ở Phase 10 và mỗi PR lớn)

- [ ] Không có secret trong source hay lịch sử git (gitleaks)
- [ ] Không có token/password/cookie trong log (kiểm tra thủ công output log)
- [ ] Mọi endpoint đều có guard phù hợp — **không sót endpoint nào không auth ngoài danh sách public đã duyệt**
- [ ] Test cross-workspace access cho **mọi** endpoint có `:wid`
- [ ] Test ma trận 5 vai trò cho mọi endpoint nhạy cảm
- [ ] Webhook: test chữ ký sai, chữ ký thiếu, replay, body quá lớn
- [ ] Upload: test file sai MIME (đổi đuôi), file quá lớn, SVG, file rỗng
- [ ] SSRF: test URL trỏ về `127.0.0.1`, `169.254.169.254`, DNS rebinding
- [ ] Rate limit hoạt động thật (test tích hợp, không chỉ đọc code)
- [ ] Security headers có mặt trên response thật
- [ ] Dependency audit: `npm audit`, không có lỗ hổng High/Critical chưa xử lý
- [ ] Không có `$queryRawUnsafe`
- [ ] Không có `dangerouslySetInnerHTML` với dữ liệu không tin cậy
- [ ] Backup database đã test **khôi phục** (backup chưa test khôi phục = không có backup)
