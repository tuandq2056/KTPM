#!/usr/bin/env bash
# Gui cung mot payload vao Juice Shop truc tiep (:3000) va qua WAF (:8080), in ma HTTP de so sanh.
DIRECT=${DIRECT:-http://localhost:3100}
WAF=${WAF:-http://localhost:8180}

probe() { # $1=ten tan cong, $2=duong dan (da encode)
  d=$(curl -s -o /dev/null -w '%{http_code}' "$DIRECT$2")
  w=$(curl -s -o /dev/null -w '%{http_code}' "$WAF$2")
  printf '%-18s direct=%s  waf=%s\n' "$1" "$d" "$w"
}

probe "benign"         "/rest/products/search?q=apple"
probe "xss"            "/?q=%3Cscript%3Ealert(1)%3C/script%3E"
probe "sqli"           "/rest/products/search?q=%27%20OR%201%3D1--"
probe "path-traversal" "/?f=../../etc/passwd"
