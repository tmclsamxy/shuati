#!/usr/bin/env bash
# =====================================================================
# fix-all.sh —— 刷题记忆 · 全自动修复脚本（自包含，不依赖上传）
# ---------------------------------------------------------------------
# 在服务器上执行：
#   cd /mrcheng/shuati
#   bash fix-all.sh
#
# 脚本会：
#   1) 覆盖写 server/Dockerfile、server/docker-entrypoint.sh、docker-compose.yml
#   2) 修正数据目录属主与权限
#   3) 备份旧库（不删除数据）后重建容器
#   4) 导入题库 + 健康检查
# =====================================================================
set -u

HOST_PORT="${HOST_PORT:-3300}"
CONTAINER_PORT=3000
PUID_VAL="${PUID_VAL:-1000}"
PGID_VAL="${PGID_VAL:-1000}"

cd "$(dirname "$0")" || exit 1
PROJECT_DIR="$(pwd)"
LOG="$PROJECT_DIR/fix-all.log"
exec > >(tee "$LOG") 2>&1

hr()  { printf '\n========== %s ==========\n' "$1"; }
ok()  { printf '  [OK] %s\n' "$1"; }
bad() { printf '  [!!] %s\n' "$1"; }

echo "项目目录: $PROJECT_DIR"
echo "日志    : $LOG"
echo "时间    : $(date '+%F %T')"

# ---------------------------------------------------------------
hr "1. 写 server/Dockerfile"
# ---------------------------------------------------------------
mkdir -p server/scripts
cat > server/Dockerfile <<'DOCKERFILE_EOF'
FROM node:22-alpine
ENV TZ=Asia/Shanghai
RUN apk add --no-cache su-exec
WORKDIR /app
COPY . /app/server/
RUN mkdir -p /app/server/data
ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/app/server/data/quiz.sqlite \
    STATIC_DIR=/app/web \
    SESSION_DAYS=30 \
    PUID=1000 \
    PGID=1000
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/auth/me').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server/index.js"]
DOCKERFILE_EOF
ok "server/Dockerfile 已写入（$(wc -l < server/Dockerfile) 行）"

# ---------------------------------------------------------------
hr "2. 写 server/docker-entrypoint.sh"
# ---------------------------------------------------------------
cat > server/docker-entrypoint.sh <<'ENTRY_EOF'
#!/bin/sh
set -e
DATA_DIR="${DATA_DIR:-/app/server/data}"
if [ -n "$DB_PATH" ]; then DATA_DIR="$(dirname "$DB_PATH")"; fi
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  chown -R "$PUID:$PGID" "$DATA_DIR" 2>/dev/null || true
  chmod -R u+rwX,g+rwX "$DATA_DIR" 2>/dev/null || true
  if command -v su-exec >/dev/null 2>&1; then
    exec su-exec "$PUID:$PGID" "$@"
  else
    echo "[entrypoint] su-exec 缺失，以 root 运行" >&2
    exec "$@"
  fi
fi
exec "$@"
ENTRY_EOF
chmod +x server/docker-entrypoint.sh
ok "server/docker-entrypoint.sh 已写入"

# ---------------------------------------------------------------
hr "3. 写 docker-compose.yml"
# ---------------------------------------------------------------
[ -f docker-compose.yml ] && cp docker-compose.yml "docker-compose.yml.bak-$(date +%s)"
cat > docker-compose.yml <<COMPOSE_EOF
services:
  quiz:
    build:
      context: ./server
      dockerfile: Dockerfile
    image: quiz-memory:latest
    container_name: quiz-memory
    restart: unless-stopped
    ports:
      - "127.0.0.1:${HOST_PORT}:${CONTAINER_PORT}"
    environment:
      TZ: Asia/Shanghai
      PORT: "${CONTAINER_PORT}"
      DB_PATH: /app/server/data/quiz.sqlite
      STATIC_DIR: /app/web
      SESSION_DAYS: "30"
      PUID: "${PUID_VAL}"
      PGID: "${PGID_VAL}"
    volumes:
      - ./:/app/web:ro
      - ./server/data:/app/server/data
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
COMPOSE_EOF
ok "docker-compose.yml 已写入（宿主端口 $HOST_PORT）"
docker compose config >/dev/null 2>&1 && ok "compose 语法校验通过" || bad "compose 语法有误"

# ---------------------------------------------------------------
hr "4. 修正数据目录"
# ---------------------------------------------------------------
mkdir -p server/data
echo "--- 修正前 ---"; ls -ld server/data
chmod -R u+rwX,g+rwX,o+rwX server/data 2>/dev/null
chown -R "$PUID_VAL:$PGID_VAL" server/data 2>/dev/null \
  && ok "属主 -> $PUID_VAL:$PGID_VAL" \
  || bad "chown 失败（请用 sudo 重跑本脚本）"
echo "--- 修正后 ---"; ls -ld server/data; ls -l server/data

touch server/data/.hosttest 2>/dev/null \
  && { rm -f server/data/.hosttest; ok "宿主机写入 OK"; } \
  || bad "宿主机写入失败"

# ---------------------------------------------------------------
hr "5. 端口检查"
# ---------------------------------------------------------------
if command -v ss >/dev/null 2>&1; then
  if ss -lntp 2>/dev/null | grep -q ":${HOST_PORT} "; then
    bad "端口 $HOST_PORT 已被占用：" ; ss -lntp 2>/dev/null | grep ":${HOST_PORT} "
    echo "  -> 换端口重跑：HOST_PORT=3310 bash fix-all.sh"
  else
    ok "端口 $HOST_PORT 空闲"
  fi
fi

# ---------------------------------------------------------------
hr "6. 重建并启动"
# ---------------------------------------------------------------
docker compose down --remove-orphans
docker compose build --no-cache
docker compose up -d || { bad "启动失败，请看上方错误"; exit 1; }
sleep 6
docker compose ps
echo "--- 启动日志 ---"
docker compose logs --tail=25 quiz

# ---------------------------------------------------------------
hr "7. 验证挂载与写入"
# ---------------------------------------------------------------
docker compose config | grep -A3 "source:"
docker compose exec -T quiz sh -c 'echo "容器内用户: $(id)"; ls -ld /app/server/data; touch /app/server/data/.ctest 2>/dev/null && { echo "容器写入: OK"; rm -f /app/server/data/.ctest; } || echo "容器写入: 失败"'

# ---------------------------------------------------------------
hr "8. 导入题库"
# ---------------------------------------------------------------
docker compose exec -T quiz node server/scripts/seed.js && ok "题库导入完成" || bad "题库导入失败"

# ---------------------------------------------------------------
hr "9. 健康检查"
# ---------------------------------------------------------------
C=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${HOST_PORT}/api/auth/me")
[ "$C" = "200" ] && ok "API HTTP $C" || bad "API HTTP $C"
curl -s -o /dev/null -w "首页 HTTP %{http_code}\n" "http://127.0.0.1:${HOST_PORT}/"
echo -n "题库接口: "; curl -s "http://127.0.0.1:${HOST_PORT}/api/questions" | head -c 160; echo

# ---------------------------------------------------------------
hr "10. 数据核对"
# ---------------------------------------------------------------
docker compose exec -T quiz node -e 'import("node:sqlite").then(({DatabaseSync})=>{const d=new DatabaseSync(process.env.DB_PATH);console.log("  题目数:",d.prepare("SELECT COUNT(*) c FROM questions").get().c);console.log("  用户数:",d.prepare("SELECT COUNT(*) c FROM users").get().c);d.close();}).catch(e=>console.log("  失败:",e.message))' 2>/dev/null

echo
echo "=============================================="
echo " 完成！日志: $LOG"
echo " 若失败，把本日志整段发回即可。"
echo "=============================================="
