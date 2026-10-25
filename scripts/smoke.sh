#!/usr/bin/env bash
# Kiem tra nhanh 5 yeu cau cua de. Chay sau `docker compose up -d --build`.
set -u
GW=${GW:-http://localhost:8088}
pass=0; fail=0
check() { # check "mo ta" "gia tri thuc te" "gia tri mong doi"
  if [ "$2" = "$3" ]; then echo "PASS  $1"; pass=$((pass+1)); else echo "FAIL  $1 (got $2, want $3)"; fail=$((fail+1)); fi
}
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

sleep 1  # tranh dung rate limit cua lan chay truoc
TOKEN=$(curl -s -X POST "$GW/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"alice123"}' | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
check "login tra ve token" "$([ -n "$TOKEN" ] && echo yes)" yes
AUTH="Authorization: Bearer $TOKEN"

# 1. Routing
check "routing /users/1"  "$(code -H "$AUTH" "$GW/users/1")" 200
check "routing /orders"   "$(code -H "$AUTH" "$GW/orders")" 200

# 2a. JWT
check "khong token -> 401"      "$(code "$GW/orders")" 401
check "token sai -> 401"        "$(code -H 'Authorization: Bearer abc.def.ghi' "$GW/orders")" 401
check "gia mao X-User-Id bi bo qua (xem user 2 -> 403)" \
  "$(code -H "$AUTH" -H 'X-User-Id: 2' "$GW/users/2")" 403

# 3. Aggregation
sleep 1
DASH=$(curl -s -H "$AUTH" "$GW/dashboard")
check "dashboard co user va 2 don" \
  "$(echo "$DASH" | grep -q '"username":"alice"' && echo "$DASH" | grep -o '"id":"o[0-9]"' | wc -l | tr -d ' ')" 2

# 4. Valet Key
sleep 1
RESP=$(curl -s -X POST "$GW/users/me/avatar-url" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"contentType":"image/png"}')
URL=$(echo "$RESP" | sed -n 's/.*"uploadUrl":"\([^"]*\)".*/\1/p')
KEY=$(echo "$RESP" | sed -n 's/.*"objectKey":"\([^"]*\)".*/\1/p')
check "url het han sau 300s" "$(echo "$URL" | grep -o 'X-Amz-Expires=[0-9]*')" "X-Amz-Expires=300"
printf '\x89PNG\r\n\x1a\n' > /tmp/ktpm-avatar.png
check "PUT thang len MinIO bang pre-signed URL" "$(code -X PUT --data-binary @/tmp/ktpm-avatar.png "$URL")" 200
sleep 1
check "xac nhan avatar" "$(code -X POST "$GW/users/me/avatar" -H "$AUTH" -H 'Content-Type: application/json' -d "{\"objectKey\":\"$KEY\"}")" 200
check "PUT sai chu ky -> 403" "$(code -X PUT --data-binary @/tmp/ktpm-avatar.png "${URL%X-Amz-Signature=*}X-Amz-Signature=deadbeef")" 403

# 2b. Rate limit: 30 request lien tiep, phai co 429
sleep 1
N429=0
for _ in $(seq 1 30); do [ "$(code -H "$AUTH" "$GW/orders")" = 429 ] && N429=$((N429+1)); done
check "rate limit: co request bi 429 khi >10 req/s" "$([ "$N429" -gt 0 ] && echo yes)" yes
echo "      (429: $N429/30)"

echo; echo "$pass passed, $fail failed"; [ "$fail" -eq 0 ]
