# SocialHub Manager — Project Plan (Lead Agent Output)

> Tài liệu này là output bắt buộc của Lead Agent theo `prompt.txt` §20.
> Trạng thái: **Phase 0 — Discovery hoàn tất**. Chưa viết code nghiệp vụ.
> Cập nhật lần cuối: 2026-07-27.

---

## 1. Tóm tắt cách hiểu dự án

SocialHub Manager là một **web application quản lý tập trung nhiều tài khoản mạng xã hội** (Facebook Page, Instagram Business, Pinterest Business, YouTube Channel, TikTok Business) cho các team marketing/agency.

Hệ thống giải quyết 4 nhóm bài toán:

| Nhóm           | Nội dung                                                                                                                                                       |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Publishing** | Soạn 1 nội dung → publish/schedule ra nhiều nền tảng, mỗi nền tảng có caption/định dạng riêng, có draft, preview, validation theo luật riêng của từng nền tảng |
| **Engagement** | Gom comment từ nhiều nền tảng về một inbox thống nhất, trả lời, gán việc, tag, ghi chú nội bộ, theo dõi trạng thái xử lý                                       |
| **Analytics**  | Đồng bộ metric (views, likes, comments, shares, reach, impressions, follower) theo snapshot, dựng dashboard so sánh theo thời gian / nền tảng / tài khoản      |
| **Governance** | Multi-workspace, RBAC 5 vai trò, audit log, notification, quản lý vòng đời token OAuth                                                                         |

**Bản chất kỹ thuật của hệ thống**: đây **không phải** một CRUD app. Đây là một **integration platform**. Phần khó nhất và rủi ro nhất nằm ở:

1. **Tính bất đối xứng giữa các nền tảng** — mỗi nền tảng có model dữ liệu, giới hạn, quyền, chu kỳ review app hoàn toàn khác nhau. Không tồn tại "mẫu số chung" thực sự; unified schema luôn là một phép chiếu có mất mát (lossy projection).
2. **Tính bất định của hệ thống ngoài** — token hết hạn, user gỡ quyền, rate limit, API downtime, thay đổi breaking từ platform. Mọi thao tác ra ngoài đều phải coi là _có thể thất bại và phải retry được một cách idempotent_.
3. **Tính bất đồng bộ** — publish, sync, webhook đều là background job. UI chỉ phản ánh _trạng thái đã biết gần nhất_, không phải sự thật tuyệt đối.

Ba điểm trên quyết định toàn bộ kiến trúc bên dưới.

**Ràng buộc đạo đức/pháp lý (bắt buộc, không thương lượng)**: chỉ dùng API chính thức; không scrape; không giả lập hành vi người dùng; không auto-like/share/comment khi API không cho phép. Hệ quả kiến trúc: **những gì API không hỗ trợ thì hệ thống phải hiển thị rõ là "không hỗ trợ", tuyệt đối không lấp bằng workaround.**

---

## 2. Những chức năng có thể bị giới hạn bởi API

Đây là danh sách **rủi ro cần xác minh**, không phải kết luận. Chi tiết và checklist xác minh nằm ở `docs/SOCIAL_API_CAPABILITIES.md`.

### 2.1 Nhóm rủi ro CAO — có thể phải bỏ khỏi phạm vi

| Chức năng trong prompt            | Rủi ro         | Ghi chú                                                                                                                                                                                                                                                                                  |
| --------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Like / reaction chủ động**      | Rất cao        | Prompt §1 liệt kê "Like hoặc reaction" như một mục quản lý. Cần phân biệt rõ: **đọc số lượng reaction** (khả thi) vs **thực hiện hành động like** (hầu hết nền tảng không mở API cho việc này, và §3 cấm auto-like nếu API không cho phép). **Quyết định thiết kế: chỉ đọc, không ghi.** |
| **Share chủ động**                | Rất cao        | Tương tự — "share" được xử lý như **metric đọc**, không phải hành động ghi.                                                                                                                                                                                                              |
| **Xóa / ẩn comment**              | Cao            | Không đồng đều giữa các nền tảng. Interface đã đánh dấu `deleteComment?` / `hideComment?` là optional — đúng hướng.                                                                                                                                                                      |
| **Trả lời comment qua API**       | Trung bình–cao | Khác nhau theo nền tảng và theo loại nội dung. Phải khai báo qua capability matrix ở runtime, không hard-code trong UI.                                                                                                                                                                  |
| **Xóa bài đã đăng trên nền tảng** | Trung bình     | `deletePost?` là optional trong interface — giữ nguyên.                                                                                                                                                                                                                                  |

### 2.2 Nhóm rủi ro về _quyền truy cập_ (không phải kỹ thuật)

Đây là rủi ro lớn nhất về **tiến độ**, không phải về code:

- Mọi nền tảng đều yêu cầu **app review / business verification** để dùng scope production. Thời gian duyệt là biến ngoài tầm kiểm soát của team (có thể vài ngày đến vài tuần, có thể bị từ chối).
- Một số scope chỉ cấp cho tài khoản **Business/Creator**, không cấp cho tài khoản cá nhân.
- Một số nền tảng giới hạn số lượng tài khoản test ở chế độ development.

**Hệ quả roadmap**: quá trình xin quyền phải chạy **song song** với development ngay từ Phase 0, không đợi đến khi code xong. Xem `docs/ROADMAP.md` §Track B.

### 2.3 Nhóm rủi ro về _độ trễ và độ phủ dữ liệu analytics_

- Metric của nhiều nền tảng có **độ trễ** (không realtime), có thể là dữ liệu tổng hợp theo ngày.
- Một số metric chỉ có ở cấp tài khoản, không có ở cấp bài đăng — hoặc ngược lại.
- Một số metric có **cửa sổ thời gian giới hạn** (chỉ truy vấn được N ngày gần nhất).
- Định nghĩa "reach", "impression", "engagement" **không đồng nhất giữa các nền tảng** — cộng gộp chúng lại thành một con số tổng là sai về mặt phân tích.

**Hệ quả thiết kế (bắt buộc theo prompt §8 Module 8)**: mọi số liệu trên UI phải mang một trong bốn nhãn nguồn gốc:

```ts
type MetricSource =
  | 'PLATFORM_API' // lấy trực tiếp từ API nền tảng
  | 'DERIVED' // hệ thống tự tính (vd: engagement rate)
  | 'UNSUPPORTED' // nền tảng không cung cấp → hiển thị "—", không hiển thị 0
  | 'NOT_SYNCED'; // chưa đồng bộ → hiển thị skeleton/"chưa có dữ liệu"
```

> **Nguyên tắc bất di bất dịch: `UNSUPPORTED` và `NOT_SYNCED` không bao giờ được render thành số `0`.** Đây là lỗi phổ biến nhất của các công cụ cùng loại và nó làm sai lệch quyết định của người dùng.

### 2.4 Chức năng "Lên lịch đăng"

Cần phân biệt hai cơ chế:

- **Native scheduling**: gửi bài kèm thời gian đăng, nền tảng tự đăng.
- **System-side scheduling**: hệ thống giữ bài, đến giờ thì worker gọi API publish ngay.

Hệ thống sẽ **mặc định dùng system-side scheduling** cho mọi nền tảng (nhất quán, kiểm soát được retry, hủy được, hoạt động giống nhau ở mọi adapter). Native scheduling chỉ dùng nếu có lý do rõ ràng và sẽ được ghi nhận vào capability matrix.

---

## 3. Đề xuất MVP

### 3.1 Nguyên tắc chọn MVP

MVP phải **chứng minh được kiến trúc**, không phải chứng minh được số lượng tính năng. Cụ thể: MVP thành công khi **một adapter hoàn chỉnh chạy end-to-end qua queue**, vì khi đó adapter thứ hai chỉ còn là công việc tuyến tính.

### 3.2 Phạm vi MVP (in-scope)

| #   | Hạng mục                                                          | Ghi chú                                 |
| --- | ----------------------------------------------------------------- | --------------------------------------- |
| 1   | Auth: đăng ký, đăng nhập, đăng xuất, quên mật khẩu, Google login  | Session HTTP-only cookie                |
| 2   | Workspace (1 user → N workspace)                                  | Auto-tạo workspace mặc định khi đăng ký |
| 3   | RBAC 5 vai trò: Owner/Admin/Editor/Analyst/Viewer                 | Enforce ở tầng service, không chỉ ở UI  |
| 4   | Kết nối **1 nền tảng đầu tiên** qua OAuth                         | Token mã hóa AES-256-GCM                |
| 5   | Media upload lên S3-compatible qua signed URL                     | Validate MIME + size + dimension        |
| 6   | Composer: tạo draft, caption theo nền tảng, validation, preview   |                                         |
| 7   | Publish ngay + lên lịch                                           | Qua queue `publish-post`                |
| 8   | Trạng thái bài đăng 8 state + trạng thái riêng từng platform post | Bao gồm `PARTIALLY_PUBLISHED`           |
| 9   | Danh sách bài đăng: search/filter/sort/paginate/detail/retry      |                                         |
| 10  | Đồng bộ metric cơ bản qua job định kỳ + snapshot                  | Có nhãn `MetricSource`                  |
| 11  | Comment inbox cơ bản (đọc + trả lời **nếu** API hỗ trợ)           | Gated bằng capability matrix            |
| 12  | Dashboard cơ bản                                                  |                                         |
| 13  | Audit log                                                         |                                         |
| 14  | Queue + retry + backoff + dead-letter                             |                                         |
| 15  | Health/readiness endpoint + structured log                        |                                         |

### 3.3 Ngoài phạm vi MVP (deferred — có chủ đích)

Two-factor auth · Dark mode · Drag-and-drop calendar · Campaign · Template trả lời nhanh · Comment tag/assignment nâng cao · Xuất CSV · Best posting times · Load testing · 4 nền tảng còn lại.

> Lý do defer "Best posting times": đây là tính năng phái sinh từ dữ liệu lịch sử — cần ít nhất vài tuần dữ liệu thật mới có ý nghĩa. Làm sớm sẽ chỉ ra kết quả vô nghĩa.

### 3.4 Chọn nền tảng đầu tiên

Tiêu chí chọn (theo thứ tự ưu tiên):

1. Tài liệu API rõ ràng, ổn định.
2. Hỗ trợ đầy đủ nhất cả 3 nhóm: publish + comment + metric (để adapter mẫu chạm hết mọi phương thức của interface).
3. Thời gian và độ khó xin app review thấp nhất.
4. Team **đã có sẵn** tài khoản business/test để phát triển.

**Quyết định này chưa chốt** — phụ thuộc kết quả xác minh ở `docs/SOCIAL_API_CAPABILITIES.md` và câu trả lời của stakeholder (§13 Q1, Q2). Kiến trúc adapter được thiết kế để việc chọn nền tảng nào trước **không ảnh hưởng** tới phần còn lại của hệ thống.

---

## 4. Kiến trúc hệ thống

Chi tiết đầy đủ: `docs/ARCHITECTURE.md`. Tóm tắt:

```
                         ┌──────────────────────────┐
   Browser  ──HTTPS──►   │  apps/web (Next.js)      │
                         │  SSR + React Query       │
                         └───────────┬──────────────┘
                                     │ REST /api/v1 (cookie session)
                         ┌───────────▼──────────────┐
                         │  apps/api (NestJS)       │
                         │  Auth · RBAC · CRUD      │
                         │  OAuth callback          │
                         │  Webhook receiver        │
                         └──┬──────────────┬────────┘
                            │ enqueue      │ read/write
                  ┌─────────▼───────┐  ┌───▼──────────────┐
                  │ Redis (BullMQ)  │  │ PostgreSQL       │
                  └─────────┬───────┘  │ (Prisma)         │
                            │ consume  └───▲──────────────┘
                         ┌──▼──────────────┴────────┐
                         │  apps/worker (NestJS)    │
                         │  10 queue processors     │
                         └───────────┬──────────────┘
                                     │ packages/platform-adapters
                         ┌───────────▼──────────────┐
                         │  Facebook · Instagram    │
                         │  Pinterest · YouTube     │
                         │  TikTok  (official APIs) │
                         └──────────────────────────┘
                                     ▲
                         S3-compatible storage (R2/S3/MinIO)
```

### 4.1 Bốn quyết định kiến trúc cốt lõi

**QĐ-1 — Tách `api` và `worker` thành hai process riêng.**
Publish một video có thể mất vài phút. HTTP request không được giữ kết nối lâu như vậy. Worker scale độc lập theo tải job, api scale theo tải request. Worker chết không làm sập API.

**QĐ-2 — Mọi lời gọi ra nền tảng đều đi qua queue, không gọi trực tiếp từ HTTP request.**
Kể cả "đăng ngay" cũng là `enqueue(publish-post)` rồi trả `202 Accepted`. Điều này cho retry, backoff, rate-limit và idempotency miễn phí ở một chỗ duy nhất thay vì rải rác khắp controller.
_Ngoại lệ có kiểm soát_: OAuth token exchange (đồng bộ theo bản chất) và các thao tác đọc nhẹ do người dùng chủ động kích hoạt.

**QĐ-3 — Adapter là biên giới cứng (hard boundary).**
`packages/platform-adapters` **không** import Prisma, **không** import NestJS, **không** biết gì về HTTP request. Nó nhận credential + input đã chuẩn hóa, trả về dữ liệu đã chuẩn hóa hoặc `PlatformError` đã chuẩn hóa. Hệ quả: adapter test được bằng unit test với HTTP mock, không cần database.

**QĐ-4 — Capability matrix là _dữ liệu runtime_, không phải tài liệu.**

```ts
// packages/shared/src/capabilities.ts
export const CAPABILITIES: Record<Platform, PlatformCapabilities> = { ... }
```

API trả capability xuống client; UI **ẩn/disable** nút "Trả lời" nếu `capabilities.replyToComment === false`. Nhờ vậy, giới hạn API được thể hiện nhất quán ở cả backend, frontend và test — thay vì mỗi nơi tự đoán.

### 4.2 Luồng publish (đường đi quan trọng nhất)

```
User bấm "Publish"
  → API: validate DTO + RBAC + platform rules
  → DB: ContentPost(QUEUED) + N × PlatformPost(QUEUED)   [1 transaction]
  → Enqueue N job `publish-post` (jobId = platformPostId → idempotent)
  → HTTP 202 Accepted
  ...
Worker nhận job
  → Acquire lock (Redis, key = platformPostId)
  → PlatformPost → PROCESSING
  → Lấy token → giải mã → refresh nếu sắp hết hạn
  → adapter.publishPost(input)
     ├─ OK    → PlatformPost(PUBLISHED) + lưu platformPostId ngoại
     └─ Lỗi   → phân loại PlatformError
                 ├─ RETRYABLE (5xx, network, rate limit) → throw → BullMQ backoff
                 └─ FATAL (token invalid, nội dung vi phạm) → FAILED + notification
  → Tính lại trạng thái ContentPost:
       all PUBLISHED → PUBLISHED
       mixed         → PARTIALLY_PUBLISHED
       all FAILED    → FAILED
  → Audit log + notification
```

---

## 5. Lựa chọn tech stack

### 5.1 Backend: **Phương án B — NestJS** ✅

Prompt yêu cầu đánh giá và giải thích. Đây là phân tích:

| Tiêu chí                                                       | Phương án A (Next.js API Routes)                                                                                  | Phương án B (NestJS)                                                      |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **Background worker chạy lâu**                                 | ❌ Next.js không có mô hình worker thường trú. Phải dựng thêm process Node riêng → mất luôn ưu thế "một codebase" | ✅ Worker là NestJS standalone app, dùng chung DI/service/adapter với API |
| **DI cho 5 adapter + strategy pattern**                        | ❌ Phải tự dựng, dễ thành singleton toàn cục khó test                                                             | ✅ DI container sẵn có, mock adapter trong test rất sạch                  |
| **Cấu trúc module hóa quy mô lớn**                             | ⚠️ Dựa vào quy ước thư mục, dễ trôi                                                                               | ✅ Module/Provider/Guard/Interceptor là ràng buộc kiến trúc thật          |
| **Cross-cutting: RBAC guard, audit interceptor, error filter** | ⚠️ Lặp lại ở từng route handler hoặc middleware thủ công                                                          | ✅ Guard/Interceptor/Filter áp dụng khai báo, không lặp                   |
| **Webhook cần response cực nhanh**                             | ⚠️ Cold start trên serverless là rủi ro thật                                                                      | ✅ Process thường trú, không cold start                                   |
| **Kết nối DB**                                                 | ❌ Serverless + Prisma → cần connection pooler                                                                    | ✅ Pool ổn định trong process dài hạn                                     |
| **Deploy lên Vercel**                                          | ✅ Đơn giản nhất                                                                                                  | ⚠️ Cần VPS/Railway/Fly.io cho api + worker                                |
| **Tốc độ khởi động ban đầu**                                   | ✅ Nhanh hơn                                                                                                      | ⚠️ Nhiều boilerplate hơn                                                  |

**Kết luận**: Phương án A thắng ở tốc độ khởi đầu, nhưng thua ở đúng ba thứ mà hệ thống này _chính là_: worker thường trú, nhiều integration, và cross-cutting concern (RBAC + audit + error normalization). Chọn A đồng nghĩa với việc **chắc chắn phải tách worker ra sau này** — tức là trả chi phí migration muộn thay vì trả chi phí boilerplate sớm. Chọn **B**.

> **Lưu ý**: Next.js vẫn được dùng cho `apps/web`, nhưng chỉ ở vai trò UI + BFF nhẹ (server component fetch dữ liệu, forward cookie). Toàn bộ business logic nằm ở NestJS.

### 5.2 Stack chốt

| Tầng        | Lựa chọn                                                                                                     | Lý do ngắn                                                                                                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Monorepo    | **npm workspaces** + Turborepo                                                                               | ⚠️ Prompt/thị trường thường dùng pnpm, nhưng **pnpm không có sẵn trên máy dev hiện tại** (đã kiểm tra). npm workspaces (npm 10.9.2) đủ dùng và không thêm phụ thuộc cài đặt. Có thể đổi sang pnpm sau bằng 1 commit. |
| Frontend    | Next.js 15 (App Router) · React 19 · TypeScript · Tailwind CSS v4 · shadcn/ui · TanStack Query v5 · Recharts | Theo prompt                                                                                                                                                                                                          |
| Backend     | NestJS 11 · TypeScript strict · Fastify adapter                                                              | Fastify nhanh hơn Express, quan trọng cho webhook                                                                                                                                                                    |
| Validation  | **Zod** (dùng chung cả FE lẫn BE qua `packages/shared`)                                                      | Một schema, dùng ở cả hai đầu → không lệch định nghĩa                                                                                                                                                                |
| ORM         | Prisma 6 + PostgreSQL 16                                                                                     | Theo prompt                                                                                                                                                                                                          |
| Queue       | BullMQ + Redis 7                                                                                             | Theo prompt                                                                                                                                                                                                          |
| Auth        | Auth.js (NextAuth v5) ở `web` + xác thực session ở `api`                                                     | Xem chi tiết `ARCHITECTURE.md` §Auth                                                                                                                                                                                 |
| Storage     | S3-compatible SDK (`@aws-sdk/client-s3`) → R2 / S3 / MinIO local                                             | Một interface, ba backend                                                                                                                                                                                            |
| Log         | Pino (structured JSON) + request-id correlation                                                              |                                                                                                                                                                                                                      |
| Test        | Vitest (unit/integration) · Supertest (API) · Playwright (E2E) · MSW/nock (mock platform API)                |                                                                                                                                                                                                                      |
| Lint/Format | ESLint 9 flat config · Prettier 3 · Husky · lint-staged · commitlint                                         |                                                                                                                                                                                                                      |
| CI          | GitHub Actions                                                                                               |                                                                                                                                                                                                                      |
| Monitoring  | Sentry (chuẩn bị cấu trúc) · Bull Board · `/health` `/ready`                                                 |                                                                                                                                                                                                                      |

---

## 6. Cấu trúc thư mục

```
D:\TOOL_SOCIAL\
├─ apps/
│  ├─ web/                      # Next.js — UI
│  ├─ api/                      # NestJS — HTTP API, OAuth, webhook
│  └─ worker/                   # NestJS standalone — BullMQ processors
├─ packages/
│  ├─ shared/                   # types, zod DTO, PostStatus, capability matrix, API envelope
│  ├─ db/                       # Prisma schema, migrations, seed, PrismaService
│  ├─ platform-adapters/        # SocialPlatformAdapter + 5 adapter (không phụ thuộc Nest/Prisma)
│  ├─ config/                   # env validation (zod), typed config
│  ├─ security/                 # token encryption, hashing, webhook signature verify
│  ├─ eslint-config/            # shared ESLint flat config
│  └─ tsconfig/                 # shared tsconfig base
├─ docker/
│  ├─ docker-compose.yml        # postgres · redis · minio
│  ├─ api.Dockerfile
│  ├─ worker.Dockerfile
│  └─ web.Dockerfile
├─ docs/
│  ├─ PROJECT_PLAN.md           # ← tài liệu này
│  ├─ ARCHITECTURE.md
│  ├─ SOCIAL_API_CAPABILITIES.md
│  ├─ SECURITY.md
│  ├─ ROADMAP.md
│  └─ PROGRESS.md               # nhật ký tiến độ theo format §22
├─ .github/workflows/ci.yml
├─ .env.example
├─ package.json                 # npm workspaces root
├─ turbo.json
└─ README.md
```

Chi tiết cấu trúc bên trong từng app: `docs/ARCHITECTURE.md` §5.

---

## 7. Database schema sơ bộ

22 model theo prompt §8. Schema đầy đủ sẽ nằm ở `packages/db/prisma/schema.prisma`. Tóm tắt quan hệ:

```
User ─┬─< Account (OAuth login provider)
      ├─< Session
      ├─< WorkspaceMember >─ Workspace
      └─< AuditLog

Workspace ─┬─< WorkspaceMember  (role: OWNER|ADMIN|EDITOR|ANALYST|VIEWER)
           ├─< SocialAccount
           ├─< ContentPost
           ├─< MediaAsset
           ├─< Notification
           └─< AuditLog

SocialAccount ─┬─ SocialToken (1-1, access+refresh đã mã hóa)
               ├─< PlatformPost
               ├─< Comment
               └─< MetricSnapshot        (snapshot cấp tài khoản: follower...)

ContentPost ─┬─< PlatformPost            (1 content → N platform)
             ├─< PostSchedule
             └─< MediaAsset (M-N qua ContentPostMedia)

PlatformPost ─┬─ PostMetric              (1-1, số liệu mới nhất — để list/sort nhanh)
              ├─< MetricSnapshot         (1-N, chuỗi thời gian — để vẽ chart)
              └─< Comment

Comment ─┬─< CommentReply
         ├─< CommentAssignment >─ WorkspaceMember
         ├─< CommentTag
         └─ Comment (self-relation: parentId cho comment lồng nhau)

WebhookEvent · BackgroundJob · ApiRequestLog   (bảng vận hành, độc lập)
```

### Ghi chú thiết kế quan trọng

1. **`PostMetric` vs `MetricSnapshot` là có chủ đích, không trùng lặp.**
   `PostMetric` = trạng thái _mới nhất_ (1-1, để list bài đăng sort theo views mà không cần aggregate).
   `MetricSnapshot` = chuỗi thời gian (1-N, append-only, để vẽ biểu đồ tăng trưởng). Gộp hai bảng này sẽ khiến truy vấn danh sách bài đăng phải quét toàn bộ lịch sử.

2. **Mọi bảng dữ liệu nghiệp vụ đều mang `workspaceId`** (kể cả khi có thể suy ra qua join). Đây là điều kiện tiên quyết để enforce tenant isolation ở một chỗ duy nhất và để bật Postgres RLS về sau nếu cần.

3. **`SocialToken` tách khỏi `SocialAccount`** để có thể áp quyền đọc chặt hơn, log riêng, và rotate khóa mã hóa mà không đụng bảng chính. Trường `encryptionKeyVersion` phục vụ secret rotation (§SECURITY).

4. **`MetricSource` được lưu cùng mỗi metric**, không suy diễn ở tầng hiển thị.

5. **Xóa mềm (`deletedAt`)** cho `ContentPost`, `SocialAccount`, `MediaAsset` — xóa cứng làm mất audit trail.

---

## 8. API endpoint list

Toàn bộ dưới prefix `/api/v1`. Envelope thống nhất — xem `ARCHITECTURE.md` §7.

<details open>
<summary><b>Auth &amp; User</b></summary>

| Method     | Path                                          | Mô tả                            |
| ---------- | --------------------------------------------- | -------------------------------- |
| POST       | `/auth/register`                              | Đăng ký email/password           |
| POST       | `/auth/login`                                 | Đăng nhập → set HTTP-only cookie |
| POST       | `/auth/logout`                                | Hủy session                      |
| POST       | `/auth/forgot-password`                       | Gửi email reset                  |
| POST       | `/auth/reset-password`                        | Đặt lại mật khẩu bằng token      |
| GET        | `/auth/google` · `/auth/google/callback`      | Google OAuth login               |
| GET        | `/auth/session`                               | Session hiện tại                 |
| GET/PATCH  | `/users/me`                                   | Hồ sơ cá nhân                    |
| POST       | `/users/me/change-password`                   | Đổi mật khẩu                     |
| GET/DELETE | `/users/me/sessions` `/users/me/sessions/:id` | Quản lý phiên đăng nhập          |

</details>

<details open>
<summary><b>Workspace &amp; Team</b></summary>

| Method           | Path                                 | Quyền tối thiểu        |
| ---------------- | ------------------------------------ | ---------------------- |
| GET/POST         | `/workspaces`                        | authenticated          |
| GET/PATCH/DELETE | `/workspaces/:id`                    | VIEWER / ADMIN / OWNER |
| GET              | `/workspaces/:id/members`            | VIEWER                 |
| POST             | `/workspaces/:id/invitations`        | ADMIN                  |
| POST             | `/invitations/:token/accept`         | authenticated          |
| PATCH/DELETE     | `/workspaces/:id/members/:memberId`  | ADMIN                  |
| POST             | `/workspaces/:id/transfer-ownership` | OWNER                  |

</details>

<details open>
<summary><b>Social Accounts</b></summary>

| Method | Path                                                         | Ghi chú                         |
| ------ | ------------------------------------------------------------ | ------------------------------- |
| GET    | `/workspaces/:wid/social-accounts`                           |                                 |
| GET    | `/workspaces/:wid/social-accounts/oauth/:platform/authorize` | trả URL + state (CSRF)          |
| GET    | `/oauth/:platform/callback`                                  | endpoint public, verify `state` |
| GET    | `/workspaces/:wid/social-accounts/:id`                       |                                 |
| POST   | `/workspaces/:wid/social-accounts/:id/refresh-token`         | thủ công                        |
| POST   | `/workspaces/:wid/social-accounts/:id/sync`                  | kích hoạt sync ngay             |
| DELETE | `/workspaces/:wid/social-accounts/:id`                       | ngắt kết nối + thu hồi token    |
| GET    | `/platforms/capabilities`                                    | **capability matrix cho UI**    |

</details>

<details open>
<summary><b>Media · Posts · Calendar</b></summary>

| Method           | Path                                                     | Ghi chú                                    |
| ---------------- | -------------------------------------------------------- | ------------------------------------------ |
| POST             | `/workspaces/:wid/media/upload-url`                      | signed URL, không proxy file qua API       |
| POST             | `/workspaces/:wid/media/:id/complete`                    | xác nhận upload + validate                 |
| GET/DELETE       | `/workspaces/:wid/media` `/media/:id`                    |                                            |
| GET/POST         | `/workspaces/:wid/posts`                                 | list (search/filter/sort/page) · tạo draft |
| GET/PATCH/DELETE | `/workspaces/:wid/posts/:id`                             |                                            |
| POST             | `/workspaces/:wid/posts/:id/publish`                     | → 202 Accepted                             |
| POST             | `/workspaces/:wid/posts/:id/schedule`                    |                                            |
| POST             | `/workspaces/:wid/posts/:id/cancel-schedule`             |                                            |
| POST             | `/workspaces/:wid/posts/:id/duplicate`                   |                                            |
| POST             | `/workspaces/:wid/posts/:id/validate`                    | dry-run validation theo nền tảng           |
| POST             | `/workspaces/:wid/posts/:id/platform-posts/:ppid/retry`  |                                            |
| POST             | `/workspaces/:wid/posts/:id/platform-posts/:ppid/sync`   |                                            |
| DELETE           | `/workspaces/:wid/posts/:id/platform-posts/:ppid/remote` | xóa trên nền tảng (nếu hỗ trợ)             |
| GET              | `/workspaces/:wid/posts/export`                          | CSV                                        |
| GET              | `/workspaces/:wid/calendar`                              | `?view=month                               | week | day&from&to` |
| PATCH            | `/workspaces/:wid/calendar/:postId/reschedule`           | drag & drop                                |

</details>

<details open>
<summary><b>Comments · Analytics · Notifications · Audit · Ops</b></summary>

| Method      | Path                                                                 | Ghi chú                                                      |
| ----------- | -------------------------------------------------------------------- | ------------------------------------------------------------ |
| GET         | `/workspaces/:wid/comments`                                          | filter: platform, account, post, unanswered, keyword, status |
| GET         | `/workspaces/:wid/comments/:id`                                      |                                                              |
| POST        | `/workspaces/:wid/comments/:id/reply`                                | **403 CAPABILITY_UNSUPPORTED** nếu nền tảng không hỗ trợ     |
| POST        | `/workspaces/:wid/comments/:id/hide` · `/unhide`                     | optional capability                                          |
| DELETE      | `/workspaces/:wid/comments/:id/remote`                               | optional capability                                          |
| PATCH       | `/workspaces/:wid/comments/:id/status`                               | open · pending · resolved                                    |
| POST/DELETE | `/workspaces/:wid/comments/:id/assign`                               |                                                              |
| POST/DELETE | `/workspaces/:wid/comments/:id/tags`                                 |                                                              |
| POST        | `/workspaces/:wid/comments/:id/notes`                                | ghi chú nội bộ                                               |
| GET/POST    | `/workspaces/:wid/reply-templates`                                   |                                                              |
| GET         | `/workspaces/:wid/analytics/overview`                                |                                                              |
| GET         | `/workspaces/:wid/analytics/timeseries`                              |                                                              |
| GET         | `/workspaces/:wid/analytics/by-platform` · `/by-account`             |                                                              |
| GET         | `/workspaces/:wid/analytics/top-posts`                               |                                                              |
| GET         | `/workspaces/:wid/analytics/follower-growth`                         |                                                              |
| GET         | `/workspaces/:wid/analytics/best-posting-times`                      | phase sau                                                    |
| GET/PATCH   | `/notifications` `/notifications/:id/read` `/notifications/read-all` |                                                              |
| GET         | `/workspaces/:wid/audit-logs`                                        | ADMIN+                                                       |
| POST        | `/webhooks/:platform`                                                | public, verify signature, trả 200 ngay                       |
| GET         | `/health` · `/ready` · `/metrics`                                    | không auth (chỉ nội bộ)                                      |

</details>

---

## 9. Queue và worker design

| Queue                  | Trigger            | Concurrency | Retry                    | Idempotency key             |
| ---------------------- | ------------------ | ----------- | ------------------------ | --------------------------- |
| `publish-post`         | API / scheduler    | 5           | 5 × exp backoff (5s→80s) | `platformPostId`            |
| `sync-posts`           | cron 30′           | 3           | 3                        | `socialAccountId:cursor`    |
| `sync-comments`        | cron 10′ · webhook | 5           | 3                        | `platformPostId:since`      |
| `sync-post-metrics`    | cron 1h            | 5           | 3                        | `platformPostId:date`       |
| `sync-account-metrics` | cron 6h            | 3           | 3                        | `socialAccountId:date`      |
| `refresh-social-token` | cron 15′           | 3           | 3                        | `socialAccountId:expiresAt` |
| `process-webhook`      | webhook controller | 10          | 5                        | `webhookEventId`            |
| `retry-failed-post`    | user / cron        | 3           | 1                        | `platformPostId:attempt`    |
| `generate-thumbnail`   | media upload       | 3           | 3                        | `mediaAssetId`              |
| `cleanup-unused-media` | cron hằng ngày     | 1           | 1                        | `date`                      |

### Cơ chế bắt buộc cho mọi job

- **Idempotency**: BullMQ `jobId` = idempotency key ở trên → enqueue trùng bị chặn ở tầng queue.
- **Job locking**: Redis lock (`SET NX PX`) quanh tài nguyên bị mutate, cho trường hợp job đã ra khỏi queue nhưng chạy đồng thời.
- **Phân loại lỗi**: `PlatformError` phân hai nhánh `retryable` / `fatal`. Chỉ `retryable` mới `throw` để BullMQ retry; `fatal` được ghi nhận và kết thúc job **thành công** (tránh retry vô ích 5 lần với lỗi "nội dung vi phạm chính sách").
- **Rate limit**: BullMQ rate limiter theo group key = `platform:socialAccountId`. Khi nhận tín hiệu rate-limit từ API → `Worker.rateLimit()` + `RateLimitError` (delay theo `Retry-After` nếu có).
- **Dead-letter**: hết retry → chuyển bản ghi sang `BackgroundJob(status=DEAD)` + notification cho ADMIN.
- **Structured logging**: mọi log job mang `jobId`, `queue`, `workspaceId`, `socialAccountId`, `attempt`, `durationMs`, `correlationId`.
- **Graceful shutdown**: nhận SIGTERM → ngừng nhận job mới → chờ job đang chạy xong (timeout 30s) → thoát. Bắt buộc, nếu không mỗi lần deploy sẽ làm hỏng job đang publish.

---

## 10. Capability matrix cần xác minh

Bảng đầy đủ + checklist xác minh + link tài liệu chính thức: **`docs/SOCIAL_API_CAPABILITIES.md`**.

> ⚠️ **Theo prompt §7 và §21, tất cả ô trong bảng hiện đang ở trạng thái `🔎 CẦN XÁC MINH`.**
> Tôi **không** điền dựa trên phỏng đoán hay trí nhớ về tài liệu API. Mỗi ô đi kèm: tài liệu cần đọc, endpoint/scope cần tra, và câu hỏi cụ thể cần trả lời. Chỉ khi có người đọc tài liệu chính thức (hoặc chạy thử với credential thật) thì ô đó mới được chuyển sang `✅ CÓ` / `❌ KHÔNG` / `⚠️ CÓ ĐIỀU KIỆN`, **kèm URL + ngày kiểm chứng**.

---

## 11. Roadmap theo phase

Chi tiết + acceptance criteria từng phase: **`docs/ROADMAP.md`**. Tóm tắt:

| Phase | Nội dung                                                     | Trạng thái      |
| ----- | ------------------------------------------------------------ | --------------- |
| 0     | Discovery · MVP · capability matrix · architecture           | ✅ **Hoàn tất** |
| 1     | Project Foundation (monorepo, TS, lint, docker, env, CI)     | 🔄 **Đang làm** |
| 2     | Auth · Workspace · RBAC · Audit log                          | ⏳              |
| 3     | OAuth framework · token encryption · nền tảng đầu tiên       | ⏳              |
| 4     | Content Composer · media · validation · preview · scheduling | ⏳              |
| 5     | Publishing queue · worker · retry · partial publish          | ⏳              |
| 6     | Posts management                                             | ⏳              |
| 7     | Comments inbox                                               | ⏳              |
| 8     | Analytics                                                    | ⏳              |
| 9     | 4 nền tảng còn lại                                           | ⏳              |
| 10    | Hardening · monitoring · deployment                          | ⏳              |

**Track B (chạy song song, bắt đầu ngay từ Phase 0)**: đăng ký developer app, business verification, xin scope, chuẩn bị tài khoản test. Đây là **đường găng thật sự** của dự án — không phải code.

---

## 12. Danh sách rủi ro

| #   | Rủi ro                                                         | Mức       | Ảnh hưởng                                 | Giảm thiểu                                                                                                                                               |
| --- | -------------------------------------------------------------- | --------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | **App review bị từ chối / kéo dài**                            | 🔴 Cao    | Chặn toàn bộ integration                  | Bắt đầu Track B ngay Phase 0; dùng sandbox/dev mode để phát triển; kiến trúc adapter cho phép đổi thứ tự nền tảng không tốn chi phí                      |
| R2  | **Không đủ quyền cho một số chức năng** (reply/delete comment) | 🔴 Cao    | Mất tính năng đã hứa với người dùng       | Capability matrix runtime; UI ẩn tính năng thay vì báo lỗi; ghi rõ giới hạn trong tài liệu người dùng                                                    |
| R3  | **Platform thay đổi API / deprecate version**                  | 🟠 TB-Cao | Vỡ integration đang chạy                  | Pin API version trong config; contract test chạy theo lịch trên sandbox; alert khi tỉ lệ lỗi tăng                                                        |
| R4  | **Rate limit ở quy mô nhiều workspace**                        | 🟠 TB-Cao | Sync chậm, publish trễ giờ                | Rate limiter theo account; ưu tiên `publish-post` > `sync-*`; backoff tôn trọng `Retry-After`; cache metric                                              |
| R5  | **Rò rỉ token**                                                | 🔴 Cao    | Sự cố bảo mật nghiêm trọng                | AES-256-GCM at-rest, khóa ngoài DB, key versioning; token **không bao giờ** ra tới frontend; loại token khỏi log bằng redaction; audit mọi lần đọc token |
| R6  | **Rò rỉ dữ liệu chéo workspace**                               | 🔴 Cao    | Vi phạm dữ liệu                           | `workspaceId` bắt buộc ở mọi query; guard tập trung; **test riêng cho từng endpoint** (E2E #14); cân nhắc RLS                                            |
| R7  | **Chi phí lưu trữ media tăng không kiểm soát**                 | 🟡 TB     | Chi phí                                   | Quota theo workspace; job `cleanup-unused-media`; lifecycle rule trên bucket                                                                             |
| R8  | **Metric không đồng nhất giữa các nền tảng bị cộng gộp sai**   | 🟠 TB-Cao | Người dùng ra quyết định sai              | `MetricSource` bắt buộc; không cộng gộp cross-platform những metric có định nghĩa khác nhau; chú thích rõ trên UI                                        |
| R9  | **Publish trùng (double post)**                                | 🟠 TB-Cao | Sự cố nhìn thấy được với khách hàng       | `jobId` idempotent + job lock + kiểm tra trạng thái trước khi gọi API + lưu `externalPostId`                                                             |
| R10 | **Múi giờ sai khi lên lịch**                                   | 🟡 TB     | Đăng sai giờ                              | Lưu UTC trong DB; workspace có timezone; xử lý DST ở tầng hiển thị; test riêng cho DST                                                                   |
| R11 | **Webhook giả mạo hoặc replay**                                | 🟠 TB-Cao | Dữ liệu bẩn / tấn công                    | Verify signature bắt buộc; unique constraint trên `(platform, externalEventId)`; kiểm tra timestamp                                                      |
| R12 | **Không có Docker trên máy dev hiện tại**                      | 🟡 TB     | Không chạy được Postgres/Redis local ngay | Đã ghi nhận; xem §13 Q7. Compose file vẫn được viết đầy đủ; CI dùng service container nên không bị chặn                                                  |
| R13 | **Video upload lớn / xử lý lâu**                               | 🟡 TB     | Timeout, tốn tài nguyên                   | Upload trực tiếp lên S3 qua signed URL; worker riêng cho media; giới hạn kích thước theo capability nền tảng                                             |
| R14 | **Prisma migration xung đột khi nhiều người làm song song**    | 🟢 Thấp   | Ma sát dev                                | Quy ước: 1 migration/PR; CI kiểm tra drift                                                                                                               |

---

## 13. Danh sách câu hỏi còn thiếu

> Những câu này ảnh hưởng trực tiếp tới Phase 2–3. **Phase 1 không bị chặn bởi chúng** — vì vậy tôi sẽ tiến hành Phase 1 và hỏi song song.

| #   | Câu hỏi                                                                    | Ảnh hưởng                                                 | Giả định tạm thời nếu không có câu trả lời                                    |
| --- | -------------------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Q1  | Đã có developer app / business account trên nền tảng nào chưa?             | Chọn nền tảng đầu tiên                                    | Giả định **chưa có gì** → Track B bắt đầu từ số 0                             |
| Q2  | Nền tảng nào **quan trọng nhất về mặt kinh doanh**?                        | Thứ tự Phase 9                                            | Giả định thứ tự theo độ rõ ràng của API                                       |
| Q3  | Quy mô dự kiến: bao nhiêu workspace / social account / bài đăng mỗi tháng? | Sizing hạ tầng, chiến lược rate limit                     | Giả định quy mô nhỏ: <50 workspace, <500 account                              |
| Q4  | Đây là sản phẩm nội bộ hay SaaS bán cho khách?                             | Ảnh hưởng billing, onboarding, mức độ khắt khe compliance | Giả định **nội bộ / SaaS giai đoạn đầu**, chưa có billing                     |
| Q5  | Storage: dùng Cloudflare R2, AWS S3 hay MinIO self-host?                   | Cấu hình + chi phí                                        | Giả định **R2** cho production, **MinIO** cho local                           |
| Q6  | Deploy target thật: Railway / Render / Fly.io / VPS?                       | Dockerfile + CD                                           | Giả định **Docker trên VPS**, web trên Vercel                                 |
| Q7  | Máy dev có cài được Docker Desktop không?                                  | Chạy Postgres/Redis local                                 | Giả định **có thể cài**; nếu không → dùng Postgres/Redis cloud free tier      |
| Q8  | Ngôn ngữ UI: tiếng Việt, tiếng Anh, hay đa ngôn ngữ?                       | i18n từ đầu hay không                                     | Giả định **tiếng Anh** cho UI, tài liệu tiếng Việt. i18n-ready nhưng chưa bật |
| Q9  | Yêu cầu tuân thủ đặc biệt (GDPR, lưu trữ dữ liệu tại VN)?                  | Vị trí hạ tầng, chính sách xóa dữ liệu                    | Giả định **không có yêu cầu đặc biệt** ở MVP                                  |
| Q10 | Email provider cho reset password / notification?                          | Phase 2                                                   | Giả định **Resend** hoặc SMTP, cấu hình được                                  |

---

## 14. Kế hoạch phân công sub-agent

Prompt §16 mô tả 7 vai trò chuyên môn. Chúng được triển khai như **7 luồng trách nhiệm có ranh giới rõ ràng** trong cùng một codebase, mỗi luồng có định nghĩa hoàn thành riêng và cổng review của Lead trước khi merge.

> **Ghi chú vận hành**: trong phiên làm việc hiện tại, các luồng này được Lead Agent thực thi tuần tự (session hiện tại không được phép tự spawn sub-agent). Ranh giới trách nhiệm vẫn được giữ nguyên vì nó phục vụ chất lượng kiến trúc — không phải chỉ để chia việc.

| Agent                        | Phạm vi sở hữu (đường dẫn)                                      | Deliverable                                                              | Phase chính | Không được đụng vào             |
| ---------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------- | ------------------------------- |
| **A1 · Product/Requirement** | `docs/`                                                         | PROJECT_PLAN, capability matrix, acceptance criteria                     | 0           | code                            |
| **A2 · Solution Architect**  | `docs/ARCHITECTURE.md`, `packages/shared`, `packages/db/prisma` | Architecture, schema, API contract, queue/webhook design, security model | 0–1         | UI                              |
| **A3 · Backend**             | `apps/api/src/modules/*`, `apps/worker/src`                     | Auth, workspace, RBAC, API, queue, worker, webhook, logging              | 2, 5, 6     | `platform-adapters/*` internals |
| **A4 · Social Integration**  | `packages/platform-adapters`                                    | Adapter architecture, OAuth, 5 integration                               | 3, 7, 9     | DB schema, UI                   |
| **A5 · Frontend**            | `apps/web`                                                      | Toàn bộ UI                                                               | 4, 6, 7, 8  | backend logic                   |
| **A6 · QA/Security**         | `**/*.spec.ts`, `e2e/`, `docs/SECURITY.md`                      | Test plan, automated test, security review                               | mọi phase   | production code (chỉ báo cáo)   |
| **A7 · DevOps**              | `docker/`, `.github/`, `packages/config`                        | Docker, CI/CD, env, monitoring, backup                                   | 1, 10       | business logic                  |

### Quy tắc merge của Lead Agent (áp dụng cho mọi luồng)

Một thay đổi chỉ được merge khi thỏa **toàn bộ**:

1. ✅ `npm run typecheck` — 0 lỗi, không có `@ts-ignore` mới
2. ✅ `npm run lint` — 0 lỗi, không có `eslint-disable` mới không kèm giải thích
3. ✅ `npm run test` — pass, không giảm coverage của module liên quan
4. ✅ Không có `any` mới nếu không có comment giải thích
5. ✅ Không có secret/credential trong code
6. ✅ Không có mock data lọt vào production flow
7. ✅ Tôn trọng ranh giới sở hữu ở bảng trên (adapter không import Prisma, UI không gọi platform API…)
8. ✅ Thay đổi lớn có ghi lý do trong `docs/PROGRESS.md`

---

## 15. Tiêu chí hoàn thành của Phase 1

Phase 1 = **Project Foundation**. Không có tính năng nghiệp vụ nào. Định nghĩa hoàn thành:

| #   | Tiêu chí                                                                                                  | Cách kiểm chứng                                                |
| --- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 1   | Monorepo khởi tạo, `npm install` chạy sạch từ thư mục gốc                                                 | `npm install`                                                  |
| 2   | Git repository đã init, `.gitignore` chặn `.env`, `node_modules`, build output                            | `git status` không thấy file nhạy cảm                          |
| 3   | TypeScript **strict mode** bật ở mọi package, không lỗi                                                   | `npm run typecheck` → 0 lỗi                                    |
| 4   | ESLint 9 flat config + Prettier hoạt động ở mọi package                                                   | `npm run lint` → 0 lỗi                                         |
| 5   | Husky + lint-staged + commitlint hoạt động                                                                | commit thử với message sai → bị chặn                           |
| 6   | `docker/docker-compose.yml` định nghĩa Postgres 16 + Redis 7 + MinIO, có healthcheck                      | file tồn tại và hợp lệ (`docker compose config` khi có Docker) |
| 7   | **Environment validation**: thiếu/sai biến môi trường → app fail ngay lúc khởi động kèm thông báo rõ ràng | unit test cho env schema                                       |
| 8   | `.env.example` đầy đủ, chỉ chứa **placeholder**, không có secret thật                                     | review thủ công                                                |
| 9   | Prisma schema 22 model hợp lệ, client generate được                                                       | `npx prisma validate` + `npx prisma generate`                  |
| 10  | `apps/api` khởi động được, `/health` và `/ready` trả đúng                                                 | integration test (Supertest)                                   |
| 11  | `apps/worker` bootstrap được, kết nối queue, graceful shutdown                                            | unit test + chạy thử                                           |
| 12  | `apps/web` build được, render trang shell                                                                 | `npm run build -w apps/web`                                    |
| 13  | `packages/shared` export types + `PostStatus` + capability types + API envelope, có test                  | `npm run test`                                                 |
| 14  | CI GitHub Actions chạy: install → typecheck → lint → test → build                                         | file workflow hợp lệ                                           |
| 15  | `README.md` đủ để một dev mới setup từ zero                                                               | review thủ công                                                |

**Phase 1 KHÔNG bao gồm**: bất kỳ endpoint nghiệp vụ nào, UI thật, adapter thật, migration đã chạy trên DB thật.

---

## Phụ lục A — Những gì tôi cố tình KHÔNG làm ở giai đoạn này

Ghi lại để tránh hiểu nhầm là thiếu sót:

1. **Không điền capability matrix bằng trí nhớ.** Prompt §7 cấm phỏng đoán. Ma trận để trạng thái "cần xác minh" kèm checklist là _đúng yêu cầu_, không phải làm dở.
2. **Không tạo credential giả hay .env có giá trị thật.** Chỉ có `.env.example` với placeholder (§21).
3. **Không viết adapter thật ở Phase 1.** Viết adapter trước khi xác minh capability là lãng phí và dễ sai.
4. **Không tuyên bố integration hoạt động khi chưa có credential thật để test** (§21).
5. **Không chạy `docker compose up`** — Docker chưa được cài trên máy này (đã kiểm tra). Sẽ ghi rõ ở phần blocked.
