#!/usr/bin/env bash
# 每日加密归档：restic 快照（AES-256 加密 + 去重 + 增量，密钥只在 /root/.archive-restic-password）
# 推送的是加密块，仓库里看不到任何明文。无变化则静默跳过。
set -euo pipefail
# cron 默认 PATH 只有 /usr/bin:/bin，restic 装在 /usr/local/bin
export PATH="/usr/local/bin:$PATH"
DATA="${ARCHIVE_DATA_DIR:-/www/wwwroot/arenaofbias-server/.data}"
DIST="${ARCHIVE_DIST_DIR:-/www/wwwroot/arenaofbias-server/.datapack/current}"
REPO="${ARCHIVE_REPO_DIR:-/root/arenaofbias-archive}"
export RESTIC_PASSWORD_FILE="${RESTIC_PASSWORD_FILE:-/root/.archive-restic-password}"
STAMP="$(date -u '+%Y-%m-%d %H:%M UTC')"
STAGING="${ARCHIVE_STAGING_DIR:-/root/archive-staging}"

cd "$REPO"
git pull --ff-only -q origin main 2>/dev/null || true

# 数据库一致性快照（VACUUM INTO 的目标文件必须不存在）。
mkdir -p "$STAGING"
TEMP_DB="$(mktemp "$STAGING/platform.db.tmp.XXXXXX")"
rm "$TEMP_DB"
trap 'rm -f "$TEMP_DB"' EXIT
node -e 'const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[1], { readOnly: true }); db.exec("VACUUM INTO \x27" + process.argv[2] + "\x27");' "$DATA/platform.db" "$TEMP_DB"
mv -f "$TEMP_DB" "$STAGING/platform.db"

# 加密快照：投稿作品、媒体、当前馆藏（软链解引用）、数据库快照。
restic -r "$REPO/restic" backup "$DATA/works" "$DATA/media" "$DIST/" "$STAGING/platform.db" --tag daily --quiet

git add -A
if git diff --cached --quiet; then
  echo "$STAMP no changes"
  exit 0
fi
git -c user.name='arenaofbias-archive' -c user.email='archive@arenaofbias.icu' commit -q -m "archive $STAMP · encrypted snapshot"
git push -q origin main
echo "$STAMP pushed (encrypted)"
