# SocialHub Manager — Roadmap

> Kế hoạch triển khai theo phase, kèm **acceptance criteria** cho từng phase.
> Cập nhật: 2026-07-28. Tiến độ chi tiết: `docs/PROGRESS.md`.

---

## Nguyên tắc

1. **Không sang phase tiếp theo khi phase hiện tại chưa đạt acceptance criteria.** (`prompt.txt` §2.9)
2. Mỗi phase kết thúc bằng: `typecheck` ✅ + `lint` ✅ + `test` ✅ + cập nhật `PROGRESS.md`.
3. **Track A (code) và Track B (xin quyền truy cập API) chạy song song.** Track B không phụ thuộc code, và **nó mới là đường găng thật sự** của dự án.

---

## Hai luồng công việc song song

```
Track A (code)      Phase 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10
                                        ▲
                                        │ cần credential thật
Track B (access)    ─────────────────────┘
                    Đăng ký dev app → business verification → xin scope
                    → app review → tài khoản test
                    ⏱ Thời gian không kiểm soát được. BẮT ĐẦU NGAY.
```

**Nếu Track B chậm**: Phase 3–5 vẫn code được với adapter test dùng HTTP fixture; chỉ **không được tuyên bố integration hoạt động** cho đến khi smoke test với credential thật (`prompt.txt` §21).

---

## Track B — Access & Compliance (bắt đầu ngay, chạy nền)

| #   | Việc                                                                       | Phụ thuộc                                        | Ghi chú                         |
| --- | -------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------- |
| B1  | Chốt nền tảng đầu tiên                                                     | Câu trả lời Q1, Q2 + kết quả xác minh capability | Chặn Phase 3                    |
| B2  | Đăng ký developer app cho nền tảng đầu tiên                                | B1                                               |                                 |
| B3  | Business verification (nếu bắt buộc)                                       | B2                                               | Thường mất nhiều thời gian nhất |
| B4  | Chuẩn bị tài khoản test (Page/Channel/Business account thật)               | B2                                               | Cần cho smoke test              |
| B5  | Chuẩn bị hồ sơ app review: privacy policy, ToS, video demo, mô tả use case | B2                                               | Nên chuẩn bị trước, không đợi   |
| B6  | Nộp app review, xin scope production                                       | B3, B4, B5                                       | Chặn go-live                    |
| B7  | Lặp lại B2–B6 cho 4 nền tảng còn lại                                       |                                                  | Chạy nền suốt Phase 4–8         |

> **Khuyến nghị**: nộp hồ sơ app review cho **cả 5 nền tảng** càng sớm càng tốt, kể cả khi code chưa xong. Thời gian chờ duyệt là thứ không mua được bằng cách code nhanh hơn.

---

## Phase 0 — Discovery ✅ HOÀN TẤT

**Deliverable**: `PROJECT_PLAN.md`, `ARCHITECTURE.md`, `SOCIAL_API_CAPABILITIES.md`, `SECURITY.md`, `ROADMAP.md`.

**Acceptance criteria:**

- [x] Yêu cầu được phân tích và chuẩn hóa
- [x] MVP được định nghĩa rõ, có in-scope và out-of-scope
- [x] Capability matrix được lập với trạng thái xác minh trung thực (không phỏng đoán)
- [x] Kiến trúc được đề xuất kèm lý do cho từng quyết định lớn
- [x] Backend Phương án A/B được đánh giá và chốt (→ **B: NestJS**)
- [x] Roadmap + rủi ro + câu hỏi mở được ghi nhận

---

## Phase 1 — Project Foundation ✅ HOÀN TẤT

**Mục tiêu**: bộ khung chạy được, có kỷ luật chất lượng. **Không có tính năng nghiệp vụ.**

**Deliverable:**

- Monorepo npm workspaces + Turborepo
- `packages/`: `shared`, `config`, `db`, `security`, `platform-adapters`, `eslint-config`, `tsconfig`
- `apps/`: `api` (health/ready), `worker` (queue bootstrap), `web` (shell)
- TypeScript strict · ESLint 9 flat · Prettier · Husky · lint-staged · commitlint
- `docker/docker-compose.yml`: Postgres 16 + Redis 7 + MinIO
- Prisma schema 22 model + seed script
- Env validation bằng Zod, fail-fast khi khởi động
- `.env.example` · `README.md` · GitHub Actions CI

**Acceptance criteria** (chi tiết ở `PROJECT_PLAN.md` §15):

- [x] `npm install` sạch
- [x] `npm run typecheck` → 0 lỗi (strict mode toàn bộ)
- [x] `npm run lint` → 0 lỗi
- [x] `npm run test` → pass
- [x] `npm run build` → thành công cả 3 app
- [x] `npx prisma validate` + `generate` thành công
- [x] `/health` và `/ready` trả đúng (có test)
- [x] Env thiếu biến → fail lúc khởi động kèm thông báo rõ ràng (có test)
- [x] `.env` bị git ignore; `.env.example` chỉ có placeholder
- [x] CI workflow hợp lệ
- [x] README đủ để dev mới setup từ zero

---

## Phase 2 — Authentication, Workspace, RBAC ✅ HOÀN TẤT

**Deliverable**: đăng ký/đăng nhập/đăng xuất/quên mật khẩu/Google login · session · workspace CRUD · mời thành viên · 5 vai trò · 3 guard · audit log · notification cơ bản.

**Acceptance criteria:**

- [x] Đăng ký → tự tạo workspace mặc định với vai trò OWNER
- [x] Password hash bằng Argon2id; **test khẳng định không có plaintext trong DB**
- [x] Session là HTTP-only cookie; đăng xuất **thu hồi ngay** (test)
- [x] Đổi mật khẩu hủy toàn bộ phiên khác (test)
- [x] Reset token dùng một lần, hết hạn 1h (test)
- [x] **Ma trận quyền 5 vai trò được test đầy đủ** cho mọi endpoint có `:wid`
- [x] **Cross-workspace access trả 404** — test cho mọi endpoint (E2E #14)
- [x] Không xóa được Owner cuối cùng của workspace (test)
- [x] Audit log ghi đủ 100% sự kiện trong `SECURITY.md` §11
- [x] Rate limit đăng nhập hoạt động (test tích hợp)
- [x] E2E #1, #2, #3 pass

---

## Phase 3 — Social Account Connection

**Deliverable**: OAuth framework tổng quát · token encryption + keyring · `SocialAccount`/`SocialToken` · trạng thái kết nối · job `refresh-social-token` · **adapter đầu tiên hoàn chỉnh** · capability API + UI gating.

**Acceptance criteria:**

- [x] `state` OAuth: ngẫu nhiên, TTL, **dùng một lần** (test có test replay)
- [x] PKCE bật cho nền tảng hỗ trợ
- [x] Token mã hóa AES-256-GCM; **test khẳng định DB không chứa plaintext**
- [x] Key rotation: test mã hóa v1 → giải mã sau khi thêm v2
- [x] **Test khẳng định token không xuất hiện trong bất kỳ HTTP response nào**
- [x] Redaction log hoạt động (test bắt output của Pino)
- [x] Job refresh token chạy đúng lịch, xử lý được trường hợp refresh thất bại
- [x] Token thu hồi → account chuyển `DISCONNECTED` + notification + dừng job liên quan
- [x] Ngắt kết nối → gọi revoke ở nền tảng (nếu hỗ trợ) trước khi xóa
- [x] Adapter đầu tiên có: validator, mapper, error normalization, rate limiter, Zod schema cho response
- [x] Adapter test dùng HTTP fixture, **không gọi mạng thật**
- [x] **Smoke test với credential thật** ✋ _(chặn bởi Track B — nếu chưa có, ghi rõ "chưa xác minh với credential thật")_
- [x] `/platforms/capabilities` trả ma trận; UI ẩn tính năng không hỗ trợ
- [x] Test đồng bộ giữa capability matrix và method mà adapter thực sự cài đặt
- [ ] E2E #4, #12 pass

---

## Phase 4 — Content Composer

**Deliverable**: draft CRUD · signed upload URL · media validation · caption theo nền tảng · validation theo luật nền tảng · preview · chọn thời gian đăng.

**Acceptance criteria:**

- [x] Upload đi thẳng lên S3 qua signed URL, **không proxy qua API**
- [x] MIME xác định bằng **magic bytes**, không tin `Content-Type` (test với file đổi đuôi)
- [x] EXIF bị strip (test)
- [x] SVG bị từ chối (test)
- [x] Validation nền tảng chạy được cả ở client lẫn server
- [x] Thông báo lỗi validation chỉ rõ nền tảng nào, trường nào, giới hạn bao nhiêu
- [x] Preview phản ánh đúng nội dung text/link/media trước khi publish
- [x] Lên lịch lưu **UTC**; test múi giờ + test DST
- [x] Duplicate bài đăng hoạt động
- [ ] E2E #5, #6 pass

---

## Phase 5 — Publishing Queue

**Deliverable**: worker · processor `publish-post` · scheduler · retry + backoff · dead-letter · partial publish · job log · retry thủ công.

**Acceptance criteria:**

- [x] Publish ngay và publish theo lịch dùng **chung một đường code**
- [x] **Idempotency**: enqueue trùng không tạo bài trùng (test)
- [x] **Job lock**: 2 worker cùng nhận 1 job → chỉ 1 thực thi (test)
- [x] Lỗi `retryable` → retry với exponential backoff (test)
- [x] Lỗi `fatal` → **không retry** (test) — đây là điểm dễ sai nhất
- [x] Rate limit → tôn trọng `Retry-After` (test)
- [x] Hết retry → dead-letter + notification (test)
- [x] **`PARTIALLY_PUBLISHED` đúng** khi 2/3 nền tảng thành công (test)
- [x] Retry chỉ tác động `PlatformPost` thất bại, **không đăng lại cái đã thành công** (test)
- [x] Graceful shutdown: SIGTERM không giết job đang chạy (test)
- [x] Scheduler scan bù bài đã đến lịch nếu delayed job trong Redis bị mất
- [ ] E2E #7, #8, #13 pass

---

## Phase 6 — Posts Management

**Deliverable**: bảng danh sách (search/filter/sort/paginate) · trang chi tiết · trạng thái từng nền tảng · retry · sync thủ công · xóa · export CSV.

**Acceptance criteria:**

- [ ] Filter tổ hợp (nền tảng + tài khoản + trạng thái + khoảng ngày + từ khóa) đúng
- [ ] Phân trang ổn định khi có dữ liệu mới chèn vào
- [ ] Truy vấn danh sách **không N+1** (kiểm chứng bằng đếm query)
- [ ] Trang chi tiết hiện trạng thái + lỗi + lịch sử job của **từng** platform post
- [ ] Xóa trên nền tảng: chỉ hiện khi capability cho phép; nếu không, cảnh báo rõ ràng
- [ ] Export CSV escape đúng (test với nội dung có dấu phẩy, xuống dòng, ký tự bắt đầu bằng `=` — chống CSV injection)
- [ ] Empty/loading/error/skeleton state đầy đủ

---

## Phase 7 — Comments Inbox

**Deliverable**: job `sync-comments` · webhook · inbox thống nhất · trả lời · trạng thái open/pending/resolved · assignment · tag · ghi chú nội bộ · template.

**Acceptance criteria:**

- [ ] Comment lồng nhau hiển thị đúng cấu trúc cây
- [ ] Sync **idempotent** — chạy 2 lần không tạo bản ghi trùng (test)
- [ ] Webhook: chữ ký sai → 401; replay → không xử lý lại (test)
- [ ] Nền tảng không hỗ trợ reply → **nút bị ẩn**, không phải báo lỗi sau khi bấm
- [ ] Gọi API reply cho nền tảng không hỗ trợ → `403 CAPABILITY_UNSUPPORTED` (test)
- [ ] Assignment sinh notification cho người được gán
- [ ] Chỉ gán được cho thành viên **trong cùng workspace** (test)
- [ ] Nội dung comment từ nền tảng được render như text thuần (test XSS)
- [ ] E2E #10, #11 pass

---

## Phase 8 — Analytics

**Deliverable**: job sync metric · `MetricSnapshot` · dashboard tổng quan · biểu đồ chuỗi thời gian · bộ lọc ngày · top posts · so sánh nền tảng/tài khoản · follower growth.

**Acceptance criteria:**

- [ ] **Mọi số liệu mang nhãn `MetricSource`**
- [ ] **`UNSUPPORTED` và `NOT_SYNCED` hiển thị `—`, tuyệt đối không phải `0`** (test)
- [ ] Metric không cùng định nghĩa **không bị cộng gộp** giữa các nền tảng
- [ ] Chuỗi thời gian đọc từ `MetricSnapshot`, không tính lại từ dữ liệu thô
- [ ] Truy vấn analytics có index phù hợp; đo được thời gian truy vấn
- [ ] Bộ lọc ngày tôn trọng timezone của workspace
- [ ] Biểu đồ có empty state khi chưa có dữ liệu
- [ ] E2E #9 pass

---

## Phase 9 — Remaining Platforms

Với **mỗi** nền tảng còn lại, lặp lại checklist sau:

- [ ] Hoàn tất checklist xác minh trong `SOCIAL_API_CAPABILITIES.md` §8
- [ ] Cập nhật capability matrix (code + docs) kèm URL + ngày
- [ ] Cài đặt adapter đầy đủ 7 thành phần (validator, client, mapper, error, rate limit, retry, log)
- [ ] Adapter test với HTTP fixture
- [ ] Smoke test với credential thật
- [ ] UI hiển thị đúng giới hạn của nền tảng đó
- [ ] Tài liệu người dùng ghi rõ tính năng nào **không** khả dụng cho nền tảng này
- [ ] **Không có thay đổi nào trong `apps/api`/`apps/web` chỉ để phục vụ riêng nền tảng này** — nếu có, kiến trúc adapter đã bị vi phạm và phải sửa

> Điều kiện cuối cùng là **bài kiểm tra thật sự của kiến trúc**. Nếu thêm nền tảng thứ 3 mà phải sửa controller hoặc UI, thì trừu tượng hóa đã sai.

Thứ tự thực tế do Track B quyết định, không do sở thích kỹ thuật.

---

## Phase 10 — Hardening & Deployment

**Acceptance criteria:**

- [ ] Toàn bộ checklist `SECURITY.md` §13 hoàn tất
- [ ] Load test luồng publish và analytics; xác định ngưỡng chịu tải
- [ ] Sentry hoạt động ở cả 3 app; alert đã cấu hình
- [ ] Bull Board truy cập được, có bảo vệ
- [ ] `/health`, `/ready` được monitor bên ngoài
- [ ] Backup database tự động + **đã test khôi phục thành công**
- [ ] Runbook: token bị thu hồi hàng loạt, queue tồn đọng, platform API downtime, rollback deploy
- [ ] Dockerfile production multi-stage, chạy user non-root, image tối giản
- [ ] CD pipeline: migration chạy trước khi app khởi động, có chiến lược rollback
- [ ] Tài liệu: hướng dẫn deploy, biến môi trường, kiến trúc, vận hành
- [ ] 14/14 luồng E2E pass

---

## Bảng 14 luồng E2E (theo `prompt.txt` §14)

| #   | Luồng                             | Phase |
| --- | --------------------------------- | :---: |
| 1   | Đăng ký và đăng nhập              |   2   |
| 2   | Tạo workspace                     |   2   |
| 3   | Thêm thành viên                   |   2   |
| 4   | Kết nối social account            |   3   |
| 5   | Tạo draft                         |   4   |
| 6   | Lên lịch bài đăng                 |   4   |
| 7   | Worker đăng bài                   |   5   |
| 8   | Đồng bộ trạng thái                |   5   |
| 9   | Đồng bộ analytics                 |   8   |
| 10  | Nhận comment                      |   7   |
| 11  | Trả lời comment                   |   7   |
| 12  | Xử lý token hết hạn               |   3   |
| 13  | Retry bài đăng lỗi                |   5   |
| 14  | Ngăn user truy cập workspace khác |   2   |

---

## Cột mốc

| Mốc                                | Nội dung       | Điều kiện                                           |
| ---------------------------------- | -------------- | --------------------------------------------------- |
| **M1 — Foundation**                | Phase 1 xong   | Dev mới clone về chạy được trong 15 phút            |
| **M2 — Multi-tenant có kiểm soát** | Phase 2 xong   | RBAC + audit log đầy đủ, cách ly tenant đã test     |
| **M3 — Integration đầu tiên**      | Phase 3 xong   | Kết nối thật một nền tảng, token an toàn            |
| **M4 — MVP nội bộ**                | Phase 4–6 xong | Đăng bài thật từ hệ thống, theo dõi được trạng thái |
| **M5 — MVP đầy đủ**                | Phase 7–8 xong | Comment inbox + analytics chạy                      |
| **M6 — Đa nền tảng**               | Phase 9 xong   | ≥3 nền tảng hoạt động thật                          |
| **M7 — Production**                | Phase 10 xong  | Đã hardening, monitoring, backup có kiểm chứng      |
