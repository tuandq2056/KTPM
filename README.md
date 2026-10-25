# KTPM – API Gateway lab

Hệ thống gồm 2 service (User, Order) + API Gateway (nginx), minh hoạ 5 pattern:

| Yêu cầu | Pattern | Cài đặt |
|---|---|---|
| Định tuyến `/users`, `/orders` | Routing | `gateway/nginx.conf` (`location` + `upstream`) |
| JWT + giới hạn 10 req/s tại gateway | Offloading | `auth_request` → `bff /auth/verify`; `limit_req rate=10r/s` |
| `/dashboard` gộp user + đơn hàng | Aggregation | `services/bff` gọi song song 2 service |
| Upload avatar bằng pre-signed URL 5 phút | Valet Key | `services/user` ký URL, client PUT thẳng lên MinIO |
| Đo độ trễ gateway vs gọi thẳng | – | `scripts/bench.js` |

```
client ──► nginx :8088 ──┬─ /auth/login ─► user-service
           (rate limit)  ├─ /users/*    ─► user-service ──(ký URL)──► MinIO
           (auth_request ├─ /orders     ─► order-service
            ► bff)       └─ /dashboard  ─► bff ─► user-service + order-service
client ──────────── PUT pre-signed URL ───────────────────────────► MinIO :9000
```

## Chạy

```bash
docker compose up -d --build
./scripts/smoke.sh          # kiểm tra 5 yêu cầu
node scripts/bench.js 3000 10   # đo độ trễ
```

Cổng: gateway `8088` (có rate limit), `8089` (cùng cấu hình nhưng **không** rate limit, chỉ để benchmark),
MinIO S3 `9000`, console `127.0.0.1:9001`. Đổi bằng `GATEWAY_PORT`, `GATEWAY_BENCH_PORT`.
User có sẵn: `alice/alice123`, `bob/bob123`.

```bash
TOKEN=$(curl -s -X POST localhost:8088/auth/login -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"alice123"}' | jq -r .token)
curl -H "Authorization: Bearer $TOKEN" localhost:8088/dashboard
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"contentType":"image/png"}' localhost:8088/users/me/avatar-url   # -> uploadUrl (hết hạn sau 300s)
```

## Quyết định thiết kế

- **Verify JWT ở gateway, service tin `X-User-Id`.** nginx OSS không tự verify JWT nên dùng `auth_request` gọi `bff`. Gateway luôn ghi đè `X-User-Id`, client không giả mạo được. Đổi lại, `user-service`/`order-service` **không được public** ra ngoài (compose chỉ publish chúng ở `127.0.0.1` để benchmark).
- **JWT:** HS256, ghim `algorithms` (chặn `alg: none`), hết hạn 1 giờ.
- **Rate limit** theo IP, `burst=5 nodelay`, trả `429`. Chạy trước bước xác thực nên request vượt mức bị chặn rẻ.
- **Dashboard:** gọi song song, `timeout 2s`; một service lỗi thì trả `206` kèm dữ liệu một phần, cả hai lỗi thì `502`.
- **Valet Key:** URL chỉ cho `PUT` đúng một object key `"<userId>/<uuid>.<ext>"` (không ghi đè được ảnh người khác), hết hạn sau 300 giây. Chỉ nhận `png/jpeg/webp` ở bước cấp URL (MinIO không ép `Content-Type` của presigned PUT, nên đây chưa phải rào chắn cứng). Sau khi upload, client gọi `POST /users/me/avatar` để service `statObject` xác nhận rồi mới lưu.
- **Host trong chữ ký:** URL được ký bằng `MINIO_PUBLIC_HOST:9000` (mặc định `localhost`) chứ không phải `minio:9000`, vì client không phân giải được tên container. Chạy từ máy khác thì đặt `MINIO_PUBLIC_HOST`.
- **nginx:** `proxy_set_header` không kế thừa xuống location nếu location tự khai báo cái riêng, nên `gateway/proxy.conf` được `include` trong từng location để giữ keepalive tới upstream.

## Kết quả đo độ trễ (3000 request, concurrency 10, máy dev, 1 service `GET /orders`)

| | p50 | p95 | p99 |
|---|---|---|---|
| Gọi thẳng order-service | ~2.6 ms | ~6.5 ms | ~11 ms |
| Qua gateway (JWT + nginx) | ~7.7 ms | ~12 ms | ~15 ms |

Gateway thêm ~5 ms p50, phần lớn do hop `auth_request` sang `bff` (Node). Có thể giảm bằng cache kết quả verify ngắn hạn. Số liệu từ một máy, cùng CPU với bộ sinh tải, chỉ để so sánh tương đối.

## Giới hạn đã biết (bài lab)

- Dữ liệu in-memory, mật khẩu plaintext, secret mặc định `dev-secret-change-me`: **không dùng cho production**.
- Image MinIO dùng `cgr.dev/chainguard/minio` vì `minio/minio` không còn trên Docker Hub.
- Chưa có TLS; pre-signed URL đi qua HTTP trong môi trường local.
