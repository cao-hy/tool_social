# SocialHub Manager

Hệ thống quản lý tập trung nhiều tài khoản mạng xã hội: **Facebook Page · Instagram Business · Pinterest Business · YouTube · TikTok Business**.

Quản lý bài đăng, lịch đăng, draft, comment, và phân tích hiệu suất nội dung — trên một giao diện duy nhất, **chỉ dùng API chính thức của từng nền tảng**.

---

## ⚠️ Trạng thái dự án

|                     |                                                          |
| ------------------- | -------------------------------------------------------- |
| **Phase hiện tại**  | **1 — Project Foundation** ✅                            |
| Kết nối nền tảng    | ❌ Chưa có. Xem [lý do](#vì-sao-chưa-có-integration-nào) |
| Capability matrix   | 🔎 0/5 nền tảng được xác minh                            |
| Sẵn sàng production | ❌ Không                                                 |

Đây là **bộ khung dự án**, chưa phải sản phẩm dùng được. Phase 1 dựng nền móng kỹ thuật; tính năng nghiệp vụ bắt đầu từ Phase 2. Lộ trình đầy đủ: [`docs/ROADMAP.md`](docs/ROADMAP.md).

---

## Bắt đầu nhanh

**Yêu cầu**: Node.js ≥ 20.11 · npm ≥ 10 · Docker (cho Postgres/Redis/MinIO) · Git

```bash
# 1. Cài dependency
npm install

# 2. Tạo file môi trường
cp .env.example .env

# 3. Sinh khóa mã hóa token và dán vào .env (thay giá trị placeholder)
node -e "console.log('ENCRYPTION_KEYS=v1:' + require('crypto').randomBytes(32).toString('base64'))"

# 4. Dựng hạ tầng local
npm run docker:up

# 5. Tạo schema database và seed dữ liệu dev
npm run db:generate
npm run db:migrate
npm run db:seed

# 6. Kiểm tra mọi thứ chạy được
npm run verify        # typecheck + lint + test

# 7. Chạy dev
npm run dev
```

| Dịch vụ           | URL                                                        |
| ----------------- | ---------------------------------------------------------- |
| Web               | http://localhost:3000                                      |
| API               | http://localhost:4000                                      |
| API health        | http://localhost:4000/health · http://localhost:4000/ready |
| Capability matrix | http://localhost:4000/api/v1/platforms/capabilities        |
| Worker health     | http://localhost:4001/health                               |
| MinIO console     | http://localhost:9001 (`minioadmin` / `minioadmin`)        |

---

## Vì sao chưa có integration nào

Đây là lựa chọn có chủ đích, không phải việc còn dang dở.

`prompt.txt` §7 và §21 quy định: **không được điền capability matrix dựa trên phỏng đoán**, và **không được tuyên bố integration hoạt động khi chưa kiểm thử với credential thật**.

Vì vậy [`docs/SOCIAL_API_CAPABILITIES.md`](docs/SOCIAL_API_CAPABILITIES.md) hiện có **toàn bộ ô ở trạng thái `🔎 CẦN XÁC MINH`**, kèm checklist 10 câu hỏi cụ thể cho từng nền tảng và link tài liệu API chính thức. Một ô chỉ rời khỏi trạng thái đó khi có **URL tài liệu + ngày kiểm chứng + tên người kiểm chứng**.

Hệ quả trong sản phẩm: `GET /api/v1/platforms/capabilities` trả về ma trận này, và UI **ẩn mọi tính năng chưa được xác minh**. Hệ thống không hứa những gì chưa ai kiểm chứng.

**Việc cần làm tiếp theo** không phải là code, mà là đọc tài liệu API và đăng ký developer app — xem [`docs/ROADMAP.md`](docs/ROADMAP.md) §Track B. Thời gian duyệt ứng dụng là đường găng thật sự của dự án.

---

## Cấu trúc

```
apps/
  web/        Next.js 15 · React 19 · Tailwind v4 · TanStack Query · Recharts
  api/        NestJS 11 + Fastify — HTTP API, OAuth callback, webhook
  worker/     NestJS standalone — 10 BullMQ processor
packages/
  shared/             Types, PostStatus, capability types, API envelope, RBAC
  config/             Validate biến môi trường bằng Zod, fail-fast lúc khởi động
  security/           Mã hóa token AES-256-GCM, chữ ký webhook, chống SSRF, PKCE
  db/                 Prisma schema (22 model), seed, helper cách ly tenant
  platform-adapters/  Interface adapter, mô hình lỗi, capability matrix
docker/       docker-compose (Postgres · Redis · MinIO) + Dockerfile production
docs/         Kế hoạch, kiến trúc, capability matrix, bảo mật, roadmap, tiến độ
```

**Quy tắc phụ thuộc**: `apps` → `packages`, không bao giờ ngược lại. `platform-adapters` không import Prisma và không import NestJS — ràng buộc này được **ESLint thực thi**, không chỉ là quy ước.

---

## Lệnh thường dùng

| Lệnh                                | Tác dụng                                        |
| ----------------------------------- | ----------------------------------------------- |
| `npm run dev`                       | Chạy cả 3 app ở chế độ dev                      |
| `npm run verify`                    | typecheck + lint + test — chạy trước mỗi commit |
| `npm run typecheck`                 | TypeScript strict mode, toàn bộ workspace       |
| `npm run lint`                      | ESLint 9                                        |
| `npm run test`                      | Vitest                                          |
| `npm run build`                     | Build tất cả                                    |
| `npm run format`                    | Prettier                                        |
| `npm run db:migrate`                | Tạo và áp dụng migration                        |
| `npm run db:studio`                 | Mở Prisma Studio                                |
| `npm run db:seed`                   | Seed dữ liệu local                              |
| `npm run docker:up` / `docker:down` | Bật/tắt hạ tầng local                           |

---

## Tài liệu

| File                                                                 | Nội dung                                                                          |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| [`docs/PROJECT_PLAN.md`](docs/PROJECT_PLAN.md)                       | Phân tích yêu cầu, MVP, chọn tech stack (kèm lý do), API list, rủi ro, câu hỏi mở |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)                       | Kiến trúc, luồng dữ liệu, thiết kế adapter, RBAC, test, monitoring                |
| [`docs/SOCIAL_API_CAPABILITIES.md`](docs/SOCIAL_API_CAPABILITIES.md) | **Capability matrix + checklist xác minh cho từng nền tảng**                      |
| [`docs/SECURITY.md`](docs/SECURITY.md)                               | Mã hóa token, cách ly tenant, OAuth, webhook, upload, audit log                   |
| [`docs/ROADMAP.md`](docs/ROADMAP.md)                                 | 11 phase kèm acceptance criteria, và Track B (xin quyền API)                      |
| [`docs/PROGRESS.md`](docs/PROGRESS.md)                               | Nhật ký tiến độ                                                                   |

---

## Nguyên tắc phát triển

Những quy tắc dưới đây được **thực thi bằng test hoặc lint**, không chỉ nằm trong tài liệu:

1. **Chỉ dùng API chính thức.** Không scrape, không giả lập hành vi người dùng. Interface adapter **không có** `likePost()` hay `sharePost()` — like và share chỉ tồn tại dưới dạng **metric đọc**.
2. **Capability là dữ liệu runtime.** Test sẽ fail nếu adapter cài đặt một method mà ma trận nói là không hỗ trợ, hoặc ngược lại.
3. **Không bao giờ hiển thị `0` cho dữ liệu không có.** Nền tảng không hỗ trợ hoặc chưa đồng bộ → hiển thị `—`. Có test riêng cho luật này.
4. **Token không bao giờ rời khỏi backend.** Mã hóa AES-256-GCM at-rest, redact trong log, không có endpoint nào trả token.
5. **Mọi truy vấn nghiệp vụ mang `workspaceId`.** Truy cập chéo workspace trả `404`, không phải `403` — `403` sẽ tiết lộ rằng tài nguyên đó tồn tại.
6. **Lỗi fatal không được retry.** Thử lại lỗi "nội dung vi phạm chính sách" 5 lần chỉ tốn quota và làm nhiễu alert.
7. **Không mock data trong luồng production.** Seed không tạo social account giả — muốn có thì phải kết nối OAuth thật.

---

## Xử lý sự cố

**`Cannot find module '../lightningcss.<platform>.node'`**
npm bỏ sót optional dependency khi lần cài đặt trước bị ngắt giữa chừng (thường do mạng). Chạy `npm install lightningcss --force`, hoặc xóa `node_modules` rồi `npm ci`.

**`Environment variable not found: DATABASE_URL`**
Chưa có file `.env`. Chạy `cp .env.example .env`.

**`ENCRYPTION_ACTIVE_KEY="v1" không có trong ENCRYPTION_KEYS`**
Chưa thay giá trị placeholder trong `.env`. Xem bước 3 của phần Bắt đầu nhanh.

**`prisma migrate` báo không kết nối được database**
Hạ tầng chưa chạy: `npm run docker:up`, đợi healthcheck xanh rồi thử lại.

---

## Giấy phép

UNLICENSED — dự án nội bộ.
