# SocialHub Manager — Architecture

> Tài liệu kiến trúc kỹ thuật. Đối tượng đọc: developer tham gia dự án.
> Xem thêm: `PROJECT_PLAN.md` (bối cảnh & quyết định), `SECURITY.md`, `SOCIAL_API_CAPABILITIES.md`.
> Cập nhật: 2026-07-27.

---

## 1. Nguyên tắc kiến trúc

| #   | Nguyên tắc                                             | Hệ quả cụ thể                                                                                               |
| --- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| P1  | **Dependency rule một chiều**                          | `apps` → `packages`. `packages` **không bao giờ** import từ `apps`. `platform-adapters` không import `db`.  |
| P2  | **Adapter là biên giới cứng**                          | Không có `if (platform === 'facebook')` ở bất kỳ đâu ngoài `packages/platform-adapters` và bảng capability. |
| P3  | **Mọi I/O ra ngoài đều bất đồng bộ và retry được**     | Không gọi API nền tảng trực tiếp trong HTTP request handler.                                                |
| P4  | **Giới hạn là dữ liệu, không phải comment trong code** | Capability matrix là object TypeScript, được API trả xuống UI và được test kiểm chứng.                      |
| P5  | **Tenant isolation ở tầng thấp nhất có thể**           | Mọi query nghiệp vụ đi qua repository nhận `workspaceId` bắt buộc.                                          |
| P6  | **Không tin dữ liệu ngoài**                            | Mọi response từ platform API đều đi qua Zod schema trước khi vào domain.                                    |
| P7  | **Trạng thái hiển thị phải trung thực**                | Không bao giờ render `0` cho dữ liệu chưa sync hoặc không được hỗ trợ.                                      |

---

## 2. Sơ đồ hệ thống

```
┌─────────────────────────────────────────────────────────────────────┐
│                            CLIENT                                    │
│  Browser (desktop-first, responsive)                                 │
└───────────────────────────┬─────────────────────────────────────────┘
                            │ HTTPS
┌───────────────────────────▼─────────────────────────────────────────┐
│  apps/web — Next.js 15 (App Router)                                  │
│  • Server Components fetch dữ liệu (forward session cookie)          │
│  • TanStack Query cho client state                                   │
│  • Auth.js: đăng nhập, quản lý session                               │
│  • KHÔNG chứa business logic, KHÔNG bao giờ thấy access token       │
└───────────────────────────┬─────────────────────────────────────────┘
                            │ REST /api/v1 (cookie session, CSRF token)
┌───────────────────────────▼─────────────────────────────────────────┐
│  apps/api — NestJS 11 + Fastify                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ Global: Helmet · CORS · RateLimit · RequestId · Zod pipe       │  │
│  │         AuthGuard → WorkspaceGuard → RoleGuard                  │  │
│  │         ResponseInterceptor · AuditInterceptor · ErrorFilter    │  │
│  └────────────────────────────────────────────────────────────────┘  │
│  Modules: auth · users · workspaces · members · social-accounts      │
│           oauth · media · posts · calendar · comments · analytics    │
│           notifications · audit · webhooks · health                  │
└────────┬──────────────────────────────────────┬─────────────────────┘
         │ enqueue                              │ Prisma
┌────────▼──────────────┐          ┌────────────▼────────────────────┐
│ Redis 7               │          │ PostgreSQL 16                   │
│ • BullMQ queues       │          │ • 22 model                      │
│ • Job locks           │          │ • Mọi bảng nghiệp vụ có          │
│ • Rate limit counters │          │   workspaceId                   │
│ • OAuth state (TTL)   │          │ • Soft delete cho dữ liệu chính │
└────────┬──────────────┘          └────────────▲────────────────────┘
         │ consume                               │ Prisma
┌────────▼───────────────────────────────────────┴────────────────────┐
│  apps/worker — NestJS standalone                                     │
│  10 processor · graceful shutdown · scheduler (repeatable jobs)      │
└───────────────────────────┬─────────────────────────────────────────┘
                            │ packages/platform-adapters
┌───────────────────────────▼─────────────────────────────────────────┐
│  SocialPlatformAdapter                                               │
│  Facebook │ Instagram │ Pinterest │ YouTube │ TikTok                  │
│  mỗi adapter: HttpClient · TokenProvider · Validator · ErrorMapper   │
│               RateLimiter · ResponseMapper · Logger                  │
└─────────────────────────────────────────────────────────────────────┘
                            │
                  ┌─────────▼──────────┐
                  │ S3-compatible      │  R2 / S3 (prod) · MinIO (local)
                  │ signed upload URL  │
                  └────────────────────┘
```

---

## 3. Vì sao tách 3 process

| Process  | Đặc tính tải                               | Scale theo              | Chết thì sao                                   |
| -------- | ------------------------------------------ | ----------------------- | ---------------------------------------------- |
| `web`    | Nhiều request ngắn, CPU nhẹ                | Số người dùng đồng thời | UI down, dữ liệu an toàn                       |
| `api`    | Request ngắn + webhook burst               | Số request/s            | UI mất dữ liệu, worker vẫn chạy tiếp           |
| `worker` | Job dài (upload video vài phút), I/O-bound | Số job tồn đọng         | Job đang chạy được retry; API vẫn nhận request |

Nếu gộp `api` + `worker`: một job upload video 5 phút chiếm event loop sẽ làm tăng latency của mọi request HTTP, và mỗi lần deploy sẽ giết job đang chạy giữa chừng.

---

## 4. Kiến trúc bên trong `apps/api`

Mô hình phân tầng (Clean Architecture rút gọn, thực dụng):

```
Controller   ← HTTP, DTO validation, không có business logic
    ↓
Service      ← business logic, transaction boundary, quyết định enqueue
    ↓
Repository   ← truy cập dữ liệu, LUÔN nhận workspaceId
    ↓
Prisma
```

Adapter được inject vào Service qua `PlatformAdapterFactory`, không được inject vào Controller.

```
apps/api/src/
├─ main.ts
├─ app.module.ts
├─ common/
│  ├─ guards/        auth.guard.ts · workspace.guard.ts · role.guard.ts
│  ├─ interceptors/  response.interceptor.ts · audit.interceptor.ts · logging.interceptor.ts
│  ├─ filters/       all-exceptions.filter.ts
│  ├─ pipes/         zod-validation.pipe.ts
│  ├─ decorators/    @CurrentUser · @CurrentWorkspace · @RequireRole · @Audit
│  └─ errors/        app-error.ts · error-codes.ts
└─ modules/
   ├─ auth/  users/  workspaces/  members/
   ├─ social-accounts/  oauth/
   ├─ media/  posts/  calendar/
   ├─ comments/  analytics/  notifications/
   ├─ audit/  webhooks/  queue/  health/
```

Mỗi module: `*.module.ts` · `*.controller.ts` · `*.service.ts` · `*.repository.ts` · `dto/` · `*.spec.ts`.

---

## 5. Kiến trúc `packages/platform-adapters`

### 5.1 Interface (mở rộng từ prompt §6)

```ts
export interface SocialPlatformAdapter {
  readonly platform: Platform;
  readonly capabilities: PlatformCapabilities;

  // OAuth
  buildAuthorizationUrl(input: AuthUrlInput): string;
  exchangeCodeForToken(code: string, redirectUri: string): Promise<TokenSet>;
  refreshToken(refreshToken: string): Promise<TokenSet>;
  revokeToken?(token: string): Promise<void>;

  // Account
  getAccountProfile(ctx: AdapterContext): Promise<SocialAccountProfile>;
  getAccountMetrics?(ctx: AdapterContext, range: DateRange): Promise<AccountMetrics>;

  // Publish
  validatePost(input: PublishPostInput): ValidationResult; // đồng bộ, không gọi mạng
  publishPost(ctx: AdapterContext, input: PublishPostInput): Promise<PublishResult>;
  deletePost?(ctx: AdapterContext, externalPostId: string): Promise<void>;

  // Read
  getPosts(ctx: AdapterContext, params: SyncPostsParams): Promise<Paginated<PlatformPost>>;
  getPostMetrics(ctx: AdapterContext, externalPostId: string): Promise<PostMetrics>;

  // Comments
  getComments(ctx: AdapterContext, params: SyncCommentsParams): Promise<Paginated<PlatformComment>>;
  replyToComment?(ctx: AdapterContext, commentId: string, message: string): Promise<CommentReplyResult>;
  deleteComment?(ctx: AdapterContext, commentId: string): Promise<void>;
  hideComment?(ctx: AdapterContext, commentId: string, hidden: boolean): Promise<void>;

  // Webhook
  verifyWebhookSignature?(raw: Buffer, headers: Record<string, string>): boolean;
  parseWebhookEvent?(payload: unknown): NormalizedWebhookEvent[];
}
```

**Khác biệt so với interface gốc trong prompt và lý do:**

| Thay đổi                                                                         | Lý do                                                                                      |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `connectAccount()` → tách thành `buildAuthorizationUrl` + `exchangeCodeForToken` | OAuth là luồng 2 bước qua trình duyệt, không thể gói trong một hàm `Promise<void>`         |
| `refreshToken()` nhận tham số và trả `TokenSet`                                  | Adapter **không được** giữ state hay đụng DB (P2). Việc lưu token là của service.          |
| Mọi hàm nhận `AdapterContext`                                                    | Chứa `accessToken`, `externalAccountId`, `correlationId`, `logger` — thay cho state nội bộ |
| Thêm `validatePost` đồng bộ                                                      | Cho phép UI validate trước khi submit mà không tốn quota API                               |
| Thêm `capabilities`                                                              | Nguồn sự thật duy nhất về giới hạn nền tảng (P4)                                           |
| `getPosts`/`getComments` trả `Paginated<T>`                                      | Sync cần cursor; trả mảng phẳng sẽ mất khả năng phân trang                                 |

### 5.2 Cấu trúc mỗi adapter

```
packages/platform-adapters/src/
├─ core/
│  ├─ types.ts               # unified types (Platform, TokenSet, PublishResult...)
│  ├─ adapter.interface.ts
│  ├─ platform-error.ts      # PlatformError + phân loại retryable/fatal
│  ├─ http-client.ts         # fetch wrapper: timeout, retry, correlation-id, redact log
│  ├─ rate-limiter.ts
│  └─ registry.ts            # AdapterRegistry (platform → adapter)
├─ capabilities/
│  └─ matrix.ts              # ⚠️ khởi tạo với UNVERIFIED, không đoán
├─ facebook/  instagram/  pinterest/  youtube/  tiktok/
│     ├─ <name>.adapter.ts
│     ├─ <name>.client.ts     # gọi HTTP thô
│     ├─ <name>.mapper.ts     # platform response → unified schema
│     ├─ <name>.validator.ts  # luật riêng: ký tự, tỉ lệ ảnh, định dạng...
│     ├─ <name>.errors.ts     # mã lỗi platform → PlatformError
│     ├─ schemas.ts           # Zod schema cho response (P6)
│     └─ __tests__/           # test với HTTP fixture, không cần mạng
```

### 5.3 Mô hình lỗi thống nhất

```ts
export type PlatformErrorKind =
  | 'AUTH_INVALID' // token hỏng/bị thu hồi   → fatal, cần user kết nối lại
  | 'AUTH_EXPIRED' // token hết hạn            → retryable sau khi refresh
  | 'PERMISSION_DENIED' // thiếu scope              → fatal, cần app review/scope
  | 'RATE_LIMITED' // quota                    → retryable, tôn trọng Retry-After
  | 'VALIDATION' // nội dung không hợp lệ     → fatal
  | 'NOT_FOUND' // bài/comment đã bị xóa    → fatal
  | 'CAPABILITY_UNSUPPORTED' // nền tảng không hỗ trợ  → fatal, không bao giờ retry
  | 'PLATFORM_ERROR' // 5xx phía nền tảng        → retryable
  | 'NETWORK' // timeout/DNS              → retryable
  | 'UNKNOWN'; //                          → retryable có giới hạn

export class PlatformError extends Error {
  constructor(
    readonly kind: PlatformErrorKind,
    readonly platform: Platform,
    message: string,
    readonly opts: {
      retryable: boolean;
      retryAfterMs?: number;
      httpStatus?: number;
      platformCode?: string; // mã lỗi gốc — giữ lại để debug
      raw?: unknown; // đã redact secret
    },
  ) {
    super(message);
  }
}
```

> Quy tắc: **worker chỉ `throw` khi `retryable === true`.** Lỗi fatal được ghi nhận, cập nhật trạng thái, tạo notification, rồi job kết thúc bình thường. Retry một lỗi "nội dung vi phạm chính sách" 5 lần chỉ tốn quota và làm nhiễu alert.

### 5.4 Capability matrix ở tầng code

```ts
export type CapabilityState = 'SUPPORTED' | 'UNSUPPORTED' | 'CONDITIONAL' | 'UNVERIFIED';

export interface Capability {
  state: CapabilityState;
  /** Điều kiện áp dụng khi state = CONDITIONAL (vd: chỉ với video, cần scope X) */
  condition?: string;
  /** URL tài liệu chính thức đã dùng để kết luận */
  source?: string;
  /** Ngày kiểm chứng — nếu quá cũ, CI cảnh báo */
  verifiedAt?: string;
}
```

`UNVERIFIED` là giá trị **mặc định**. API `/platforms/capabilities` trả bảng này xuống UI; UI disable nút và hiển thị tooltip giải thích khi capability không phải `SUPPORTED`.

Test bắt buộc: nếu một adapter cài đặt `replyToComment` nhưng capability của nó là `UNSUPPORTED` (hoặc ngược lại) → **test fail**. Điều này ngăn code và tài liệu trôi khỏi nhau.

---

## 6. Luồng dữ liệu chính

### 6.1 Kết nối tài khoản (OAuth)

```
UI  GET /social-accounts/oauth/:platform/authorize
      → api: tạo state ngẫu nhiên, lưu Redis (TTL 10′, kèm workspaceId + userId)
      → trả authorizationUrl
UI  redirect người dùng sang nền tảng
Nền tảng redirect về GET /oauth/:platform/callback?code&state
      → api: verify state (dùng 1 lần, xóa ngay)
      → adapter.exchangeCodeForToken(code)
      → adapter.getAccountProfile()
      → mã hóa token (AES-256-GCM) → lưu SocialToken
      → tạo/cập nhật SocialAccount (status = CONNECTED)
      → AuditLog(SOCIAL_ACCOUNT_CONNECTED)
      → enqueue sync-posts, sync-account-metrics
      → redirect về UI kèm kết quả
```

Token **không bao giờ** đi qua frontend. Callback nằm ở `api`, không ở `web`.

### 6.2 Publish nhiều nền tảng

Xem `PROJECT_PLAN.md` §4.2. Điểm then chốt:

- Một `ContentPost` → N `PlatformPost`, mỗi cái có trạng thái **độc lập**.
- Trạng thái `ContentPost` được **tính lại** từ các `PlatformPost` con sau mỗi lần job kết thúc, trong transaction:

```ts
function deriveContentPostStatus(children: PlatformPostStatus[]): PostStatus {
  if (children.every((s) => s === 'PUBLISHED')) return 'PUBLISHED';
  if (children.every((s) => s === 'FAILED')) return 'FAILED';
  if (children.some((s) => s === 'PUBLISHED')) return 'PARTIALLY_PUBLISHED';
  if (children.some((s) => s === 'PROCESSING')) return 'PROCESSING';
  return 'QUEUED';
}
```

- Retry chỉ tác động lên `PlatformPost` thất bại, **không** đăng lại những cái đã thành công. Đây là lý do phải tách trạng thái theo từng platform post.

### 6.3 Webhook

```
POST /webhooks/:platform
  1. Đọc raw body (bắt buộc — signature tính trên raw, không phải JSON đã parse)
  2. Verify signature → sai thì 401, KHÔNG log payload
  3. INSERT WebhookEvent (platform, externalEventId) — unique constraint chống replay
     • conflict → trả 200 ngay (đã xử lý rồi)
  4. enqueue process-webhook { webhookEventId }
  5. return 200  ← toàn bộ bước trên phải xong trong vài chục ms
```

Business logic **không** nằm trong controller (prompt §11). Nền tảng sẽ retry hoặc vô hiệu hóa webhook nếu endpoint chậm.

### 6.4 Đồng bộ metric

```
cron → sync-post-metrics (mỗi giờ)
  → chọn PlatformPost cần sync (published gần đây được ưu tiên cao hơn: bài mới thay đổi nhanh hơn bài cũ)
  → adapter.getPostMetrics()
  → UPSERT PostMetric (giá trị mới nhất)
  → INSERT MetricSnapshot (chuỗi thời gian, append-only, có capturedAt)
  → metric nền tảng không trả về → lưu source = UNSUPPORTED, KHÔNG lưu 0
```

---

## 7. API convention

### 7.1 Envelope thống nhất

```jsonc
// Thành công
{ "success": true, "data": { }, "meta": { "requestId": "…", "page": 1, "total": 100 } }

// Lỗi
{ "success": false,
  "error": { "code": "CAPABILITY_UNSUPPORTED",
             "message": "Nền tảng này không hỗ trợ xóa comment qua API.",
             "details": { "platform": "youtube", "capability": "deleteComment" } },
  "meta": { "requestId": "…" } }
```

### 7.2 Mã lỗi

`VALIDATION_ERROR` · `UNAUTHENTICATED` · `FORBIDDEN` · `NOT_FOUND` · `CONFLICT` · `RATE_LIMITED` · `CAPABILITY_UNSUPPORTED` · `PLATFORM_ERROR` · `TOKEN_EXPIRED` · `ACCOUNT_DISCONNECTED` · `INTERNAL_ERROR`

### 7.3 Quy ước khác

- Async operation → `202 Accepted` + trạng thái để client poll (hoặc subscribe sau này).
- Phân trang: cursor-based cho danh sách lớn (comment, post), offset cho bảng nhỏ.
- Mọi response có `X-Request-Id` để đối chiếu log.
- Version qua path (`/api/v1`), không qua header.

---

## 8. Auth & phân quyền

### 8.1 Session

- Auth.js ở `apps/web` xử lý đăng nhập (email/password + Google).
- Session token đặt trong **HTTP-only, Secure, SameSite=Lax** cookie.
- `apps/api` xác thực bằng cách tra session trong Postgres (`Session` table — database session strategy, không phải JWT).
  _Lý do chọn database session thay vì JWT_: cần **thu hồi ngay lập tức** khi user đăng xuất hoặc bị gỡ khỏi workspace. JWT không revoke được nếu không có thêm blacklist — tức là lại cần database lookup, mất hết ưu thế.

### 8.2 Ba lớp guard (chạy theo thứ tự)

```
AuthGuard        → có session hợp lệ? → gắn req.user
WorkspaceGuard   → user có phải member của :wid? → gắn req.membership
RoleGuard        → membership.role đủ cho @RequireRole?
```

### 8.3 Ma trận quyền

| Hành động                           | Owner | Admin | Editor | Analyst | Viewer |
| ----------------------------------- | :---: | :---: | :----: | :-----: | :----: |
| Xem dashboard/posts/comments        |  ✅   |  ✅   |   ✅   |   ✅    |   ✅   |
| Xem analytics                       |  ✅   |  ✅   |   ✅   |   ✅    |   ✅   |
| Tạo/sửa draft                       |  ✅   |  ✅   |   ✅   |   ❌    |   ❌   |
| Publish / schedule                  |  ✅   |  ✅   |   ✅   |   ❌    |   ❌   |
| Trả lời comment                     |  ✅   |  ✅   |   ✅   |   ❌    |   ❌   |
| Gán comment cho thành viên          |  ✅   |  ✅   |   ✅   |   ❌    |   ❌   |
| Kết nối/ngắt social account         |  ✅   |  ✅   |   ❌   |   ❌    |   ❌   |
| Mời/xóa thành viên                  |  ✅   |  ✅   |   ❌   |   ❌    |   ❌   |
| Đổi vai trò thành viên              |  ✅   |  ✅¹  |   ❌   |   ❌    |   ❌   |
| Xem audit log                       |  ✅   |  ✅   |   ❌   |   ❌    |   ❌   |
| Đổi cấu hình workspace              |  ✅   |  ✅   |   ❌   |   ❌    |   ❌   |
| Xóa workspace / chuyển quyền sở hữu |  ✅   |  ❌   |   ❌   |   ❌    |   ❌   |

¹ Admin không được đặt vai trò OWNER cho ai và không được hạ cấp Owner.

> **Enforce ở tầng service, không chỉ ở guard.** Guard bảo vệ endpoint; service bảo vệ nghiệp vụ (ví dụ: không cho xóa Owner cuối cùng của workspace).

---

## 9. Chiến lược test

| Tầng        | Công cụ                                               | Phạm vi                                                                       | Chạy ở đâu              |
| ----------- | ----------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------- |
| Unit        | Vitest                                                | pure function, validator, mapper, error classifier, `deriveContentPostStatus` | mọi commit              |
| Adapter     | Vitest + nock/MSW                                     | mỗi adapter với **HTTP fixture ghi lại từ tài liệu**, không gọi mạng thật     | mọi commit              |
| Integration | Vitest + Testcontainers (hoặc service container ở CI) | repository + service với Postgres/Redis thật                                  | mọi PR                  |
| API         | Supertest                                             | endpoint + guard + envelope + mã lỗi                                          | mọi PR                  |
| Permission  | Vitest                                                | **ma trận đầy đủ**: 5 vai trò × mọi endpoint nhạy cảm + cross-workspace       | mọi PR                  |
| Queue       | Vitest + Redis                                        | retry, backoff, idempotency, dead-letter                                      | mọi PR                  |
| Webhook     | Supertest                                             | signature hợp lệ/sai/replay                                                   | mọi PR                  |
| E2E         | Playwright                                            | 14 luồng ở prompt §14                                                         | nightly + trước release |

**Nguyên tắc test cho integration**: không bao giờ dùng dữ liệu giả để tuyên bố integration hoạt động (prompt §21). Adapter test chứng minh _code xử lý đúng response đã cho_; chỉ **smoke test với credential thật trên sandbox** mới chứng minh integration hoạt động. Hai loại này được đánh dấu tách bạch trong báo cáo.

---

## 10. Observability

| Hạng mục        | Cài đặt                                                                                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Log             | Pino JSON. Trường bắt buộc: `level, time, requestId, userId?, workspaceId?, module, msg`. **Redact**: `authorization`, `cookie`, `accessToken`, `refreshToken`, `password`, `clientSecret` |
| Correlation     | `X-Request-Id` từ HTTP → truyền vào job payload → xuất hiện trong log adapter. Truy vết được một hành động xuyên 3 process.                                                                |
| Error tracking  | Sentry (`@sentry/node` + `@sentry/nextjs`), bật khi có DSN, `beforeSend` lọc PII                                                                                                           |
| Queue dashboard | Bull Board tại `/admin/queues`, chỉ cho ADMIN nội bộ                                                                                                                                       |
| API request log | Bảng `ApiRequestLog`: platform, endpoint, status, duration, rateLimitRemaining → phân tích quota                                                                                           |
| Health          | `/health` (liveness, luôn 200 nếu process sống) · `/ready` (readiness: kiểm tra Postgres + Redis, trả 503 nếu hỏng)                                                                        |
| Alert           | Job failure rate · dead-letter tăng · token sắp hết hạn · account disconnected                                                                                                             |

---

## 11. Cấu hình & môi trường

- Mọi biến môi trường được validate bằng **Zod** ở `packages/config`, chạy **lúc khởi động**. Thiếu biến → process thoát ngay với thông báo liệt kê chính xác biến nào thiếu. Không dùng `process.env` trực tiếp ở bất kỳ đâu ngoài package này.
- Mỗi app có schema riêng (web không cần `ENCRYPTION_KEY`; worker không cần `PORT`).
- `.env.example` chỉ chứa placeholder. `.env` bị `.gitignore` chặn.

---

## 12. Deployment

| Thành phần | Nơi chạy                               | Ghi chú                                            |
| ---------- | -------------------------------------- | -------------------------------------------------- |
| `web`      | Vercel (hoặc Docker)                   | build standalone                                   |
| `api`      | Docker trên VPS/Railway/Fly.io         | cần long-running process                           |
| `worker`   | Docker, scale riêng                    | không mở port public                               |
| PostgreSQL | Managed (Railway/Neon/RDS) hoặc Docker | backup hằng ngày, PITR nếu có                      |
| Redis      | Managed hoặc Docker                    | **bật persistence** — mất Redis = mất job đang chờ |
| Storage    | Cloudflare R2 / S3                     | bucket private, chỉ truy cập qua signed URL        |

Local development: `docker/docker-compose.yml` dựng Postgres + Redis + MinIO. Các app chạy bằng `npm run dev` trên host (nhanh hơn, hot-reload tốt hơn so với chạy trong container).

---

## 13. Những gì kiến trúc này CHƯA giải quyết (nợ kỹ thuật đã biết)

Ghi lại có chủ đích để không bị quên:

1. **Realtime UI** — hiện tại client phải poll trạng thái publish. WebSocket/SSE để Phase sau.
2. **Multi-region** — chưa tính đến. Ảnh hưởng nếu có yêu cầu lưu trú dữ liệu (§13 Q9).
3. **Billing/quota theo gói** — chưa có. Cần nếu chuyển sang mô hình SaaS (§13 Q4).
4. **Postgres RLS** — schema đã sẵn sàng (`workspaceId` ở mọi bảng) nhưng chưa bật. Hiện dựa vào repository layer.
5. **Bulk/CSV import bài đăng** — chưa có.
6. **Approval workflow** (Editor soạn → Admin duyệt → publish) — nhu cầu phổ biến ở agency, chưa nằm trong yêu cầu, nhưng schema nên dự trù trường `approvalStatus` từ sớm để tránh migration đau đớn.
