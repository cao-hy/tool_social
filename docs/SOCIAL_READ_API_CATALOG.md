# Tổng hợp API đọc dữ liệu social

Ngày đối chiếu: **2026-10-26**. Phạm vi: TikTok, Facebook, Instagram, Pinterest và YouTube cho SocialHub Manager.

Danh mục tập trung vào profile, bài đăng, media, comment, số liệu hiệu suất và tìm kiếm. Các sản phẩm quảng cáo, tin nhắn, livestream và nghiên cứu được chỉ ra riêng để chọn đúng API khi mở rộng. Đây không phải danh sách mọi endpoint thương mại, thanh toán hay quản trị của năm công ty.

**API có endpoint không đồng nghĩa ứng dụng hiện tại đã được cấp quyền sử dụng.** Dữ liệu công khai, dữ liệu tài khoản đã kết nối và dữ liệu nghiên cứu có cơ chế truy cập khác nhau.

## Cách đọc trạng thái

| Nhãn     | Ý nghĩa                                                                              |
| -------- | ------------------------------------------------------------------------------------ |
| **DOC**  | Đã đọc tài liệu chính thức trong lần đối chiếu này; chưa gọi bằng credential thật.   |
| **CODE** | Có lời gọi tương ứng trong source hiện tại; không chứng minh đã tích hợp thành công. |
| **REF**  | Đường dẫn tham khảo cần kiểm tra tiếp về phiên bản, quyền và điều kiện sử dụng.      |

Một mục có thể mang cả DOC và CODE. Với Meta, một số trang developer trả HTTP 429; các mục chỉ dựa trên source hoặc tài liệu cũ được giữ ở CODE/REF. Collection do [Meta phát hành trên Postman](https://www.postman.com/meta/) được dùng bổ sung ở nơi có nội dung truy cập được.

Tài liệu này bổ sung cho [capability matrix](SOCIAL_API_CAPABILITIES.md). Việc bật tính năng vẫn theo `packages/platform-adapters/src/capabilities/matrix.ts` và điều kiện runtime.

## Chọn API theo loại dữ liệu

| Nền tảng  | API chính cho tài khoản đã kết nối | Nội dung comment                                                  | Analytics riêng của chủ tài khoản                        | Đọc tài khoản khác                                                     |
| --------- | ---------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------- |
| TikTok    | Display API                        | Display không cung cấp nội dung comment                           | Display có bộ đếm video; analytics sâu cần sản phẩm khác | Display không phải API tìm kiếm toàn TikTok                            |
| Facebook  | Pages API và Graph API             | Trên tài nguyên Page mà app có quyền                              | Page/Post Insights, quyền riêng                          | Quyền đọc Page quản lý không tự mở quyền đọc mọi Page                  |
| Instagram | Instagram API                      | Media mà app được phép quản lý                                    | User/Media Insights                                      | Facebook Login có một số khả năng discovery cho tài khoản Professional |
| Pinterest | API v5                             | Chưa có API đọc nội dung comment được xác nhận trong danh mục này | Pin/User analytics theo quyền tài nguyên                 | Search thông thường chủ yếu trên tài nguyên của người dùng             |
| YouTube   | Data API v3                        | Comment công khai nếu khả dụng                                    | Analytics API và Reporting API cần OAuth                 | API key dùng được cho nhiều tài nguyên công khai                       |

Các giới hạn TikTok được mô tả trong [Display overview](https://developers.tiktok.com/doc/display-api-overview/); Instagram trong [collection chính thức](https://www.postman.com/meta/instagram/folder/u4g5a2a/instagram-api-with-facebook-login); Pinterest trong [Search API](https://github.com/pinterest/pinterest-python-generated-api-client/blob/main/docs/SearchApi.md); YouTube trong [Data API reference](https://developers.google.com/youtube/v3/docs/). Phần Facebook dưới đây phân biệt rõ CODE và REF.

## TikTok

### Display API

Base URL: `https://open.tiktokapis.com`. Header: `Authorization: Bearer <user_access_token>`.

| Method | Endpoint                      | Dữ liệu                                                      | Quyền               | Trạng thái                             |
| ------ | ----------------------------- | ------------------------------------------------------------ | ------------------- | -------------------------------------- |
| GET    | `/v2/user/info/?fields=...`   | ID, tên hiển thị, avatar                                     | `user.info.basic`   | DOC + CODE                             |
| GET    | Cùng endpoint user info       | Username, bio, profile link, verified                        | `user.info.profile` | DOC; client chưa yêu cầu các field này |
| GET    | Cùng endpoint user info       | Follower, following, tổng like nhận được, số video công khai | `user.info.stats`   | DOC; client chưa yêu cầu các field này |
| POST   | `/v2/video/list/?fields=...`  | Danh sách video công khai của người cấp quyền                | `video.list`        | DOC + CODE                             |
| POST   | `/v2/video/query/?fields=...` | Chi tiết video theo ID, thuộc người cấp quyền                | `video.list`        | DOC + CODE                             |

Nguồn: [User info và scope cho từng field](https://developers.tiktok.com/doc/tiktok-api-v2-get-user-info/), [List videos](https://developers.tiktok.com/doc/tiktok-api-v2-video-list/), [Query videos](https://developers.tiktok.com/doc/tiktok-api-v2-video-query/).

Các field video hữu ích: `id`, `title`, `video_description`, `create_time`, `duration`, `height`, `width`, `cover_image_url`, `share_url`, `embed_link`, `like_count`, `comment_count`, `share_count`, `view_count`. Bộ đếm comment không chứa nội dung comment. [Video Object](https://developers.tiktok.com/doc/tiktok-api-v2-video-object/).

List dùng `cursor`, `max_count` và trả `has_more`; mỗi trang tối đa 20 video. Query nhận tối đa 20 ID/lần. Hai endpoint dùng POST dù chỉ đọc dữ liệu. [List](https://developers.tiktok.com/doc/tiktok-api-v2-video-list/), [Query](https://developers.tiktok.com/doc/tiktok-api-v2-video-query/).

Hạn mức mặc định công bố: 600 request/phút cho từng endpoint user info, video list và video query, tính theo cửa sổ trượt; vượt ngưỡng trả 429. [Rate limits](https://developers.tiktok.com/doc/tiktok-api-v2-rate-limit/).

### Research API và các sản phẩm khác

| Method | Endpoint hoặc sản phẩm             | Mục đích                                                                      | Điều kiện                             |
| ------ | ---------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------- |
| POST   | `/v2/research/video/query/`        | Truy vấn video công khai bằng bộ lọc                                          | Research project được duyệt; DOC      |
| POST   | `/v2/research/user/info/`          | Thông tin tài khoản công khai phục vụ nghiên cứu                              | Research client; DOC                  |
| POST   | `/v2/research/video/comment/list/` | Nội dung comment hoặc reply                                                   | `research.data.basic`; DOC            |
| —      | TikTok API for Business            | Kiểm tra sản phẩm Accounts/organic và báo cáo quảng cáo khi cần analytics sâu | Luồng cấp quyền riêng; REF            |
| —      | Data Portability API               | Xuất dữ liệu theo sự cho phép của người dùng                                  | Điều kiện sản phẩm/khu vực riêng; REF |

Research client khác token Display; không mặc định dùng quyền nghiên cứu cho dashboard thương mại. Nguồn: [Research getting started](https://developers.tiktok.com/doc/research-api-get-started/), [Research comments](https://developers.tiktok.com/doc/research-api-specs-query-video-comments/). Điểm vào các sản phẩm cần kiểm tra tiếp: [API for Business](https://business-api.tiktok.com/portal/docs), [Data Portability](https://developers.tiktok.com/products/data-portability-api/).

Trong dự án: [TikTok client](../packages/platform-adapters/src/tiktok/tiktok.client.ts), [TikTok adapter](../packages/platform-adapters/src/tiktok/tiktok.adapter.ts). Đã có `getAccountProfile`, `getAccountMetrics`, `getPosts`, `getPostMetrics`; chưa có `getComments`.

**Thiếu để đọc follower:** danh sách scope mặc định mới có `user.info.basic`, `video.list` cùng quyền đăng. `getUserInfo()` cũng chỉ yêu cầu field cơ bản. Phải xin `user.info.stats` và thêm field tương ứng; chỉ thêm scope sẽ chưa đủ. Trang User Info đang có thông báo migration, cần đọc trước khi triển khai.

## Facebook

Base URL trong code: `https://graph.facebook.com/{version}`. Pin version theo cấu hình app; không suy ra version đang dùng từ ví dụ trong docs.

### Endpoint đang có trong client

Các dòng sau là **CODE**. Đường dẫn được kiểm tra từ [Facebook client](../packages/platform-adapters/src/facebook/facebook.client.ts); cần mở lại reference Meta và gọi thử theo version cấu hình trước khi xác nhận production.

| Method | Endpoint                     | Dữ liệu đang yêu cầu                                                  | Token và quyền cần kiểm tra                                       |
| ------ | ---------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------- |
| GET    | `/me/accounts`               | Page được quản lý, ID, tên, tasks, Page token                         | User token; `pages_show_list`                                     |
| GET    | `/me`                        | Profile Page: ID, tên, username, link, `fan_count`, ảnh               | Page token; quyền đọc Page                                        |
| GET    | `/{page_id}/published_posts` | Bài Page đã xuất bản, message, thời gian, attachment, permalink       | Page token; `pages_read_engagement`                               |
| GET    | `/{post_id}`                 | Tổng reactions, comment, shares                                       | Page token; `pages_read_engagement`                               |
| GET    | `/{post_id}/comments`        | Nội dung, thời gian, tác giả khi được trả, parent, like count, hidden | Page token; kiểm tra thêm `pages_read_user_content` theo nội dung |
| GET    | `/{post_id}/insights`        | Metric cấp bài mà version/object cho phép                             | Page token; kiểm tra `read_insights` và quyền Page                |
| GET    | `/me/insights`               | Metric cấp Page, period `day` trong client                            | Page token; kiểm tra `read_insights` và quyền Page                |

Field expansion hiện dùng cho tổng tương tác là `reactions.limit(0).summary(true)`, `comments.limit(0).summary(true)`, `shares`. Không suy ra danh sách đầy đủ người tương tác từ các tổng này.

Tài liệu cần đối chiếu tiếp: [Pages posts](https://developers.facebook.com/docs/pages-api/posts/), [Page reference](https://developers.facebook.com/docs/graph-api/reference/page/), [Comment reference](https://developers.facebook.com/docs/graph-api/reference/comment/), [Insights](https://developers.facebook.com/docs/graph-api/reference/insights/), [Permissions](https://developers.facebook.com/docs/permissions/). Luồng lấy danh sách Page/token cũng xuất hiện trong [collection Meta](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api?entity=request-23987686-db99ce99-bf76-475c-8b76-718576c11cae).

### Các nhóm đọc cần kiểm tra khi mở rộng

| Endpoint hoặc API                                                 | Dữ liệu                                                        | Trạng thái                              |
| ----------------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------- |
| `GET /{page_id}/feed`                                             | Feed Page; cần phân biệt bài Page và nội dung người dùng       | REF                                     |
| `GET /{comment_id}/comments`                                      | Reply của một comment                                          | REF; chưa có hàm đọc riêng trong client |
| `GET /{page_id}/photos`, `/{page_id}/albums`, `/{page_id}/videos` | Kho media Page                                                 | REF                                     |
| Page Public Content Access và Page Public Metadata Access         | Truy cập một số dữ liệu Page ngoài tập tài nguyên đang quản lý | REF; cần xét duyệt phù hợp              |
| User Graph API với `user_posts`, `user_photos`                    | Dữ liệu người dùng đã cấp quyền, theo giới hạn sản phẩm        | REF; ngoài adapter Page hiện tại        |

Không coi quyền Page là quyền đọc toàn Facebook, profile cá nhân hoặc group. Cần xem điều kiện từng feature trong [App Review](https://developers.facebook.com/docs/app-review/) và [Pages API](https://developers.facebook.com/docs/pages-api/).

Trong [Facebook adapter](../packages/platform-adapters/src/facebook/facebook.adapter.ts) đã có profile, account metrics, posts, post metrics và comments. Danh sách OAuth mặc định chưa có `read_insights`, trong khi client gọi Insights: cần xác minh quyền thực tế đã được cấp. `fan_count` cũng cần được phân biệt với follower count khi thiết kế dashboard.

## Instagram

### Hai luồng đăng nhập

| Luồng                              | Tài khoản                               | Scope đọc cần xem                                                                                                                        | Dự án hiện tại  |
| ---------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| Instagram API with Facebook Login  | Business/Creator liên kết Facebook Page | `instagram_basic`, `pages_show_list`, `pages_read_engagement`; thêm `instagram_manage_comments`, `instagram_manage_insights` theo tác vụ | Đang dùng       |
| Instagram API with Instagram Login | Instagram Professional                  | `instagram_business_basic`, `instagram_business_manage_comments`; quyền Insights cần đối chiếu riêng theo version                        | Chưa triển khai |

Không trộn token và namespace scope giữa hai luồng. Phạm vi Facebook Login và các quyền cơ bản được mô tả trong [collection chính thức Meta](https://www.postman.com/meta/instagram/folder/u4g5a2a/instagram-api-with-facebook-login). Các quyền Insights ở bảng trên được ghi nhận từ code; [reference Instagram Login](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/) cần kiểm tra tiếp do hạn chế truy cập docs trong lần đối chiếu này.

### Endpoint trong luồng Facebook Login

Base URL hiện tại: `https://graph.facebook.com/{version}`. Các endpoint dưới đây là **CODE** từ [Instagram client](../packages/platform-adapters/src/instagram/instagram.client.ts).

| Method | Endpoint                                             | Dữ liệu                                                                         |
| ------ | ---------------------------------------------------- | ------------------------------------------------------------------------------- |
| GET    | `/me/accounts?fields=instagram_business_account,...` | Tìm IG account liên kết Page                                                    |
| GET    | `/{ig_user_id}?fields=...`                           | Profile, username, tên, ảnh, follower count                                     |
| GET    | `/{ig_user_id}/media`                                | Danh sách media và bộ đếm cơ bản                                                |
| GET    | `/{ig_media_id}`                                     | Caption, media type/URL, thumbnail, permalink, timestamp, likes, comments count |
| GET    | `/{ig_media_id}/insights`                            | Metric riêng của media theo loại nội dung                                       |
| GET    | `/{ig_user_id}/insights`                             | Metric cấp tài khoản                                                            |
| GET    | `/{ig_media_id}/comments`                            | Nội dung comment, username, thời gian, like count, hidden                       |
| GET    | `/pages/search?q=...&fields=id,name,location`        | Tìm địa điểm từ Facebook Pages cho luồng gắn vị trí                             |

Không phải mọi field đều hiện diện trên mọi loại media. Media URL cũng không bảo đảm tồn tại vĩnh viễn. Tham khảo [Instagram Platform](https://developers.facebook.com/docs/instagram-platform/) và [Insights](https://developers.facebook.com/docs/instagram-platform/insights/); cần xác minh lại danh sách metric chính xác với app version.

### Discovery và các cạnh đọc chưa có trong client

Các mẫu sau là **REF**, dùng để xác định phần cần bổ sung; chưa được xác nhận quyền/phiên bản trong lần này.

| Method | Mẫu truy vấn                                                      | Mục đích                                                  |
| ------ | ----------------------------------------------------------------- | --------------------------------------------------------- |
| GET    | `/{ig_media_id}/children`                                         | Các item trong carousel                                   |
| GET    | `/{ig_user_id}/stories`                                           | Story đang khả dụng                                       |
| GET    | `/{ig_comment_id}/replies`                                        | Reply của comment                                         |
| GET    | `/{ig_user_id}?fields=business_discovery.username(USERNAME){...}` | Metadata/media của Professional account khác khi đủ quyền |
| GET    | `/ig_hashtag_search?user_id=...&q=...`                            | Tra hashtag trong luồng hỗ trợ                            |
| GET    | `/{hashtag_id}/recent_media` hoặc `/top_media`                    | Media theo hashtag khi feature cho phép                   |
| GET    | `/{ig_user_id}/tags` và trường mentions tương ứng                 | Nội dung tag/mention theo quyền                           |

Collection [Facebook Login](https://www.postman.com/meta/instagram/folder/u4g5a2a/instagram-api-with-facebook-login) xác nhận nhóm khả năng hashtag, mentions và metadata tài khoản Professional khác; chữ ký chi tiết cần kiểm tra trong [Business Discovery reference](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login/business-discovery/). Không có bảo đảm truy vấn mọi tài khoản cá nhân hoặc toàn bộ dữ liệu của đối thủ.

Trong [Instagram adapter](../packages/platform-adapters/src/instagram/instagram.adapter.ts) đã có profile, posts, comments và account/post metrics. Danh sách metric hiện chứa cả `impressions`, `plays`, `video_views`, `views`: cần chia theo version, loại media và period thay vì mặc định mọi metric còn hiệu lực. Client hiện chưa đọc reply bằng GET riêng.

## Pinterest

Base URL: `https://api.pinterest.com/v5`. Header: `Authorization: Bearer <access_token>`.

### Profile và tài nguyên nội dung

| Method | Endpoint                                        | Dữ liệu                                                | Scope đọc chính                          | Trạng thái          |
| ------ | ----------------------------------------------- | ------------------------------------------------------ | ---------------------------------------- | ------------------- |
| GET    | `/user_account`                                 | Profile và các trường count được phép                  | `user_accounts:read`                     | DOC + CODE          |
| GET    | `/boards`                                       | Boards của operation user và group boards được chia sẻ | `boards:read`                            | DOC + CODE          |
| GET    | `/boards/{board_id}`                            | Chi tiết board                                         | `boards:read`                            | DOC + CODE ở client |
| GET    | `/boards/{board_id}/sections`                   | Sections                                               | `boards:read`                            | DOC + CODE          |
| GET    | `/boards/{board_id}/pins`                       | Pins trên board                                        | `boards:read`, `pins:read` theo endpoint | DOC + CODE          |
| GET    | `/boards/{board_id}/sections/{section_id}/pins` | Pins trong section                                     | Quyền đọc board/Pin                      | DOC + CODE ở client |
| GET    | `/pins`                                         | Danh sách Pins của operation user                      | `pins:read`                              | DOC + CODE          |
| GET    | `/pins/{pin_id}`                                | Pin, media metadata, link, mô tả                       | `pins:read` và quyền tài nguyên          | DOC + CODE          |

Nguồn: [User account](https://developers.pinterest.com/docs/api/v5/user_account-get/), [Boards API chính thức](https://github.com/pinterest/pinterest-python-generated-api-client/blob/main/docs/BoardsApi.md), [Pins API chính thức](https://github.com/pinterest/pinterest-python-generated-api-client/blob/main/docs/PinsApi.md). Secret boards/Pins cần scope secret tương ứng; xem [Authorization và scopes](https://developers.pinterest.com/docs/getting-started/set-up-authentication-and-authorization/).

### Analytics và tìm kiếm

| Method | Endpoint                                 | Dữ liệu                                              | Trạng thái                                 |
| ------ | ---------------------------------------- | ---------------------------------------------------- | ------------------------------------------ |
| GET    | `/pins/{pin_id}/analytics`               | Impression, save, click và metric hợp lệ theo format | DOC + CODE                                 |
| GET    | `/pins/analytics`                        | Analytics nhiều Pins                                 | DOC; beta/restricted, chưa có trong client |
| GET    | `/user_account/analytics`                | Analytics tài khoản                                  | DOC; chưa có trong adapter                 |
| GET    | `/user_account/analytics/top_pins`       | Pins hiệu suất cao                                   | DOC; chưa có trong client                  |
| GET    | `/user_account/analytics/top_video_pins` | Video Pins hiệu suất cao                             | DOC; chưa có trong client                  |
| GET    | `/search/pins`, `/search/boards`         | Tìm trong tài nguyên của operation user              | DOC; chưa có trong client                  |
| GET    | `/search/partner/pins`                   | Tìm Pins qua feature partner                         | DOC; beta, không mở cho mọi app            |

Nguồn: [Pin analytics và điều kiện sở hữu](https://github.com/pinterest/pinterest-python-generated-api-client/blob/main/docs/PinsApi.md), [User account analytics](https://github.com/pinterest/pinterest-python-generated-api-client/blob/main/docs/UserAccountApi.md), [Search API](https://github.com/pinterest/pinterest-python-generated-api-client/blob/main/docs/SearchApi.md).

Nhóm đọc khác gồm `/user_account/followers`, `/user_account/following`, `/user_account/following/boards`, `/user_account/businesses`, `/user_account/websites`; xem [Manage user accounts](https://developers.pinterest.com/docs/work-with-organic-content-and-users/manage-user-accounts/) và [UserAccount API](https://github.com/pinterest/pinterest-python-generated-api-client/blob/main/docs/UserAccountApi.md). Chúng chưa được đưa vào adapter chung.

Analytics cần `start_date`, `end_date` và metric phù hợp. Quyền tài nguyên có thể đi qua Business Access. Không suy ra analytics của mọi Pin từ một Pin ID công khai. Phân trang dùng `bookmark`/`page_size`. Rate limit thay đổi theo nhóm endpoint và access tier; đọc `x-ratelimit-*` và xử lý 429. [Rate limits](https://developers.pinterest.com/docs/reference/rate-limits/), [Access tiers](https://developers.pinterest.com/docs/key-concepts/access-tiers/).

Trong dự án: [Pinterest client](../packages/platform-adapters/src/pinterest/pinterest.client.ts), [Pinterest adapter](../packages/platform-adapters/src/pinterest/pinterest.adapter.ts). Đã có profile, boards/sections, posts và Pin metrics. **Chưa có `getAccountMetrics` và `getComments`** trong adapter. `video_url` có thể là tính năng hạn chế; xem [Pinterest FAQ](https://developers.pinterest.com/docs/faqs/faqs/).

## YouTube

### Data API v3

Base URL: `https://www.googleapis.com/youtube/v3`. Nhiều dữ liệu public dùng API key; dữ liệu riêng và tham số như `mine=true` cần OAuth. [Quy tắc xác thực](https://developers.google.com/youtube/v3/docs/).

| Method | Endpoint và tham số chính                                                      | Dữ liệu                                  | Trạng thái trong dự án                    |
| ------ | ------------------------------------------------------------------------------ | ---------------------------------------- | ----------------------------------------- |
| GET    | `/channels?part=snippet,statistics,contentDetails&id=...` hoặc `forHandle=...` | Profile kênh, thống kê, uploads playlist | DOC; client hiện dùng `mine=true`         |
| GET    | `/playlistItems?part=snippet,contentDetails&playlistId=...`                    | Các video trong playlist, gồm uploads    | DOC + CODE; part trong client có thể khác |
| GET    | `/videos?part=snippet,statistics,contentDetails&id=...`                        | Metadata và bộ đếm video                 | DOC + CODE với các part đang dùng         |
| GET    | `/commentThreads?part=snippet,replies&videoId=...`                             | Top-level comment và một phần replies    | DOC + CODE                                |
| GET    | `/comments?part=snippet&parentId=...`                                          | Các reply của một comment                | DOC; chưa có hàm GET riêng trong client   |
| GET    | `/search?part=snippet&type=video&q=...`                                        | Tìm kiếm video/kênh/playlist theo type   | DOC; chưa có trong client                 |

Nguồn: [Channels list](https://developers.google.com/youtube/v3/docs/channels/list), [Data API resource index](https://developers.google.com/youtube/v3/docs/), [Videos list](https://developers.google.com/youtube/v3/docs/videos/list), [Comments guide](https://developers.google.com/youtube/v3/guides/implementation/comments), [Search list](https://developers.google.com/youtube/v3/docs/search/list).

Để lấy video của kênh: đọc `contentDetails.relatedPlaylists.uploads`, duyệt playlistItems, rồi lấy video theo ID. Dùng `pageToken`/`nextPageToken`. Không coi replies nhúng trong một commentThread là đầy đủ; cần duyệt `/comments` riêng. [Channels resource](https://developers.google.com/youtube/v3/docs/channels), [CommentThreads resource](https://developers.google.com/youtube/v3/docs/commentThreads).

Các nhóm đọc mở rộng:

| Endpoint                                                | Dữ liệu và điều kiện                                             | Trạng thái                            |
| ------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------- |
| `/playlists`, `/channelSections`, `/activities`         | Playlist, bố cục kênh và activity theo phạm vi API               | DOC từ resource index; chưa có client |
| `/subscriptions`                                        | Subscription theo quyền và chế độ công khai                      | DOC; chưa có client                   |
| `/captions`                                             | Metadata caption tracks; yêu cầu OAuth phù hợp                   | DOC; chưa có client                   |
| `/captions/{caption_id}`                                | Download caption qua method riêng, yêu cầu quyền với video       | REF; không phải API transcript tùy ý  |
| `/liveBroadcasts`, `/liveStreams`, `/liveChat/messages` | Broadcast, stream, live chat theo quyền và trạng thái phiên live | DOC từ Live reference; chưa có client |

Nguồn: [Data API resource index](https://developers.google.com/youtube/v3/docs/), [Subscriptions list](https://developers.google.com/youtube/v3/docs/subscriptions/list), [Captions list](https://developers.google.com/youtube/v3/docs/captions/list), [Live API reference](https://developers.google.com/youtube/v3/live/docs/). `captions.list` trả danh sách track, không trả trực tiếp transcript.

### Analytics và Reporting

| API              | Endpoint                                                     | Dữ liệu                                           | Quyền và trạng thái                                      |
| ---------------- | ------------------------------------------------------------ | ------------------------------------------------- | -------------------------------------------------------- |
| Analytics API v2 | `GET https://youtubeanalytics.googleapis.com/v2/reports`     | Báo cáo theo thời gian, metric, dimension, filter | OAuth của chủ kênh; DOC + CODE                           |
| Reporting API v1 | `GET https://youtubereporting.googleapis.com/v1/reportTypes` | Loại báo cáo bulk                                 | DOC từ reporting workflow; chưa có client                |
| Reporting API v1 | `GET .../v1/jobs` và `GET .../v1/jobs/{job_id}/reports`      | Job, report, download URL                         | DOC từ reporting workflow; cần tạo job trước nếu chưa có |

Analytics cần `ids`, `startDate`, `endDate`, `metrics`; thêm dimensions/filters phù hợp từng loại báo cáo. Scope thường dùng là `youtube.readonly` và `yt-analytics.readonly`; doanh thu cần `yt-analytics-monetary.readonly` và điều kiện tài khoản. [Reports query](https://developers.google.com/youtube/analytics/reference/reports/query).

Reporting tải báo cáo CSV định kỳ; không mặc định trả dữ liệu lịch sử đầy đủ ngay khi mới kết nối. [Bulk reporting workflow](https://developers.google.com/youtube/reporting/v1/reports/).

Trong dự án: [YouTube client](../packages/platform-adapters/src/youtube/youtube.client.ts), [YouTube adapter](../packages/platform-adapters/src/youtube/youtube.adapter.ts). Có profile, account metrics, uploads, post metrics, comments và Analytics reports. Scope mặc định đã gồm `youtube.readonly` và `yt-analytics.readonly`; dữ liệu public của kênh bất kỳ vẫn cần bổ sung luồng client riêng.

**Reply chưa bảo đảm đầy đủ:** adapter hiện chỉ lấy replies nhúng trong `commentThreads`. Các lời gọi `/comments` hiện có trong client phục vụ ghi/sửa/xóa; chưa có GET `comments.list` để duyệt hết replies.

Quota cần đối chiếu theo từng method và quota bucket trong Google Cloud. Trang Search hiện mô tả bucket Search Queries riêng; không hard-code quy tắc quota từ hướng dẫn cũ. [Search quota](https://developers.google.com/youtube/v3/docs/search/list). Public subscriber count có thể bị làm tròn hoặc ẩn; số video kênh là số video public. [Channels statistics](https://developers.google.com/youtube/v3/docs/channels).

## API đọc dữ liệu của backend SocialHub

Prefix: **`/api/v1`**. Các endpoint workspace dùng session cookie, kiểm tra membership và quyền; không nhận social access token từ frontend. Đường dẫn dưới đây đã có controller, chưa phải bằng chứng sync thành công với tài khoản thật.

### Đọc dữ liệu đã lưu

Đặt `W = /api/v1/workspaces/{workspaceId}` trong bảng dưới đây.

| Method | Đường dẫn                        | Nội dung và tham số                                                                                        |
| ------ | -------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| GET    | `/api/v1/platforms/capabilities` | Capability runtime theo nền tảng                                                                           |
| GET    | `W/social-accounts`              | Tài khoản social đã kết nối                                                                                |
| GET    | `W/posts`                        | Bài trong DB; filter `platform`, `socialAccountId`, `status`, `q`, `dateFrom`, `dateTo`, `cursor`, `limit` |
| GET    | `W/posts/{postId}`               | Chi tiết bài trong DB                                                                                      |
| GET    | `W/comments`                     | Comment trong DB; filter `platform`, `socialAccountId`, `status`, `assignedToId`, `tagId`, `q`, `limit`    |
| GET    | `W/comments/{commentId}`         | Chi tiết comment                                                                                           |
| GET    | `W/analytics`                    | Dashboard; `from`, `to` dạng YYYY-MM-DD, `platform`, `socialAccountId`                                     |
| GET    | `W/jobs/status?ids=...`          | Trạng thái background jobs; tối đa 100 ID phân cách bằng dấu phẩy                                          |
| GET    | `W/jobs/activity`                | Hoạt động job; `limit`, `includeCompleted`                                                                 |

`GET /analytics` trả `generatedAt`, `range`, `summary`, `byPlatform`, `timeSeries`, `posts`, `followerGrowth` từ DB. Nó không tự gọi trực tiếp cả năm nền tảng khi tải dashboard.

### Yêu cầu đồng bộ và đọc trực tiếp phục vụ thao tác

| Method | Đường dẫn                                                                 | Input hoặc tác dụng                                                       |
| ------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| POST   | `W/social-accounts/{accountId}/sync-posts`                                | Đưa yêu cầu import bài ngoài vào queue                                    |
| POST   | `W/comments/sync`                                                         | Body: `socialAccountId`, optional `platformPostId`, `since`               |
| POST   | `W/analytics/sync`                                                        | Body: optional `platformPostIds` tối đa 50, `platform`, `socialAccountId` |
| POST   | `W/social-accounts/{socialAccountId}/test`                                | Kiểm tra kết nối tài khoản                                                |
| GET    | `W/social-accounts/{socialAccountId}/pinterest/boards`                    | Đọc boards từ Pinterest                                                   |
| GET    | `W/social-accounts/{socialAccountId}/pinterest/boards/{boardId}/sections` | Đọc sections                                                              |
| GET    | `W/social-accounts/{socialAccountId}/instagram/locations?q=...`           | Tìm địa điểm phục vụ composer                                             |
| POST   | `W/social-accounts/{socialAccountId}/tiktok/creator-info`                 | Đọc thông tin creator phục vụ đăng; không phải analytics                  |

Luồng sử dụng: kết nối OAuth → enqueue sync posts → theo dõi job → sync comments/analytics → đọc dữ liệu từ DB. POST sync trả thông tin xếp hàng; chỉ coi dữ liệu đã cập nhật sau khi job hoàn tất.

Giới hạn xử lý hiện tại trong source: comment sync không chỉ định bài chỉ chọn tối đa 25 bài; analytics sync tự chọn tối đa 50 bài và 50 tài khoản mỗi lần; danh sách bài trong dashboard analytics lấy tối đa 500 bài. Vì vậy một lần gọi sync/dashboard không đồng nghĩa đã đọc toàn bộ lịch sử. Cần phân trang hoặc chia lượt khi mở rộng độ phủ.

Nguồn trong repository: [Social accounts controller](../apps/api/src/modules/social-accounts/social-accounts.controller.ts), [Posts controller](../apps/api/src/modules/posts/posts.controller.ts), [Comments controller](../apps/api/src/modules/comments/comments.controller.ts), [Analytics controller](../apps/api/src/modules/analytics/analytics.controller.ts), [Analytics service](../apps/api/src/modules/analytics/analytics.service.ts), [Jobs controller](../apps/api/src/modules/jobs/jobs.controller.ts), [Auth guard](../apps/api/src/common/guards/auth.guard.ts).

## Phần cần làm để hoàn thiện khả năng đọc

| Ưu tiên | Hạng mục                                                  | Kết quả cần đạt                                                                                             |
| ------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| P0      | Kiểm chứng credential và quyền thực tế trên cả 5 nền tảng | Ghi endpoint/version/scope, tài khoản test, ngày test và kết quả đã che thông tin nhạy cảm                  |
| P0      | TikTok profile/stats                                      | Thêm scope và field đúng; phân biệt thiếu quyền với số 0                                                    |
| P0      | Facebook Insights                                         | Kiểm tra `read_insights`, Page tasks và metric theo version                                                 |
| P0      | Instagram Insights                                        | Chọn metric theo media type, version, period; kiểm tra mapping thay vì coi views và impressions tương đương |
| P1      | Pinterest account analytics                               | Bổ sung `getAccountMetrics` và mapping theo quyền tài nguyên                                                |
| P1      | Đọc đầy đủ replies                                        | Bổ sung GET comments.list cho YouTube; đánh giá phân trang reply riêng cho FB/IG                            |
| P1      | Phân trang và đồng bộ tăng dần                            | Duyệt cursor tới hết, lưu checkpoint, tránh bỏ sót bài/comment                                              |
| P1      | Chuẩn hóa metric                                          | Lưu tên gốc, nguồn API, thời gian đo, khoảng báo cáo, đơn vị; dữ liệu không có giữ null/status              |
| P2      | Discovery/public content                                  | Tách use case theo dõi đối thủ khỏi dữ liệu tài khoản kết nối; kiểm tra quyền riêng                         |
| P2      | Bổ sung scope chỉ đọc                                     | Tách cấu hình đọc khỏi scope publish cho tính năng chỉ cần thống kê                                         |

Đây là backlog từ việc đối chiếu source và danh mục API, chưa phải các thay đổi đã triển khai.

## Các họ API mở rộng cần khảo sát riêng

| Nhu cầu                                   | Sản phẩm cần xem                                                                                                                                                                                                                | Phạm vi trong dự án                                            |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Facebook/Instagram ads, chi phí, ROAS     | [Meta Marketing API](https://developers.facebook.com/docs/marketing-apis/)                                                                                                                                                      | Ngoài adapter organic hiện tại; REF                            |
| Facebook/Instagram inbox                  | [Conversations API do Meta công bố](https://www.postman.com/meta/messenger-platform-api/folder/22794852-255610cd-47f5-4f4d-b3fa-71aec360be9a)                                                                                   | Quyền messaging và Advanced Access riêng; DOC, chưa triển khai |
| TikTok Business và ads analytics          | [TikTok API for Business](https://business-api.tiktok.com/portal/docs)                                                                                                                                                          | App/product và quyền riêng; REF                                |
| TikTok nghiên cứu công khai               | [Research API](https://developers.tiktok.com/doc/research-api-get-started/)                                                                                                                                                     | Research project riêng; DOC, chưa triển khai                   |
| Pinterest ads, audience, trends, catalogs | [Pinterest analytics overview](https://developers.pinterest.com/docs/analytics-and-reports/analytics-overview/), [API description chính thức](https://github.com/pinterest/api-description)                                     | Cần khảo sát scope/access từng nhóm; REF                       |
| YouTube live, doanh thu và bulk export    | [Live API](https://developers.google.com/youtube/v3/live/docs/), [Analytics](https://developers.google.com/youtube/analytics/reference/reports/query), [Reporting](https://developers.google.com/youtube/reporting/v1/reports/) | Quyền và mô hình dữ liệu riêng; các nhóm đã nêu ở phần YouTube |

Không có một token hoặc endpoint chung của nhà cung cấp để đọc toàn bộ dữ liệu trên cả năm nền tảng. Lớp adapter của SocialHub là nơi thống nhất giao diện; quyền truy cập và ý nghĩa metric vẫn thuộc từng nền tảng.
