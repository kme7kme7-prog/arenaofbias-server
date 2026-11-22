#!/usr/bin/env bash
# 部署遗留物保留策略（2026-10-30 改造版；原版备份见 /root/backup-cleanup-retention-*/）。
# 事故背景：原版 prune_root_aob 只留最新 3 个 /root/aob-* 且删 >48h，
#           10-30 04:15 删掉了 /root/aob-performance-20261026/（含 /media/ 301 护栏）等发布作业目录。
# 由 cron 每日 04:15 运行（crontab 行未改）；任何一步失败不影响其余步骤。
#
#   DRY_RUN=1 /root/cleanup-retention.sh   只列出会删什么，不删除、不 prune、不 vacuum。
#
# 通用保护（safe_rm 统一执行）：
#   - 目录内有 .keep 文件 → 不删
#   - 符号链接 → 不删（也不跟随）
#   - /root/backup-*、/root/ops-guard、/root 本身、当前线上目录（见 PROTECT）→ 永不删除
# 策略：
#   /www/wwwroot  gallery.prev* / gallery.before-* / show1-dist.prev*(+bak-*) / arenaofbias-home.prev*
#                 各组至少保留最新 5 份，且 14 天内的一律不删；活动回滚名 *.prev 永不删除
#   /root/aob-*   发布作业目录（aob-server-*、aob-*-pr*、aob-performance*、aob-dualwrite*、aob-release*、
#                 aob-static-rel*、aob-retry-*、aob-approve-*、aob-*-release*）永不自动删除；
#                 其他非豁免目录至少保留最新 10 个，且只删 30 天以上的
#   /tmp、datapack、journal 同原版
set -uo pipefail

DRY_RUN="${DRY_RUN:-0}"
WWW=/www/wwwroot
WWW_KEEP=5; WWW_MIN_AGE_DAYS=14
ROOT_KEEP=10; ROOT_MIN_AGE_DAYS=30

PROTECT=(
  /root /root/ops-guard
  "$WWW" "$WWW/gallery" "$WWW/show1-dist" "$WWW/arenaofbias-home" "$WWW/arenaofbias-server"
  "$WWW/arenaofbias" "$WWW/acme" "$WWW/default" "$WWW/arenaofbias-server-backups"
  "$WWW/gallery.prev" "$WWW/show1-dist.prev" "$WWW/arenaofbias-home.prev"
)

echo "=== cleanup-retention $(date '+%F %T %z') DRY_RUN=$DRY_RUN"

is_protected() {
  local p="${1%/}" r q
  r="$(readlink -f -- "$p" 2>/dev/null || echo "$p")"
  for q in "$p" "$r"; do
    case "$q" in /root/backup-*|/root/ops-guard|/root/ops-guard/*) return 0 ;; esac
    local x; for x in "${PROTECT[@]}"; do [ "$q" = "$x" ] && return 0; done
  done
  return 1
}

# safe_rm <path>：统一的删除入口
safe_rm() {
  local p="${1%/}"
  if [ -L "$p" ]; then echo "skip(symlink) $p"; return; fi
  if is_protected "$p"; then echo "skip(protected) $p"; return; fi
  if [ -d "$p" ] && [ -e "$p/.keep" ]; then echo "skip(.keep) $p"; return; fi
  if [ "$DRY_RUN" = 1 ]; then echo "would remove $p"; else echo "remove $p"; rm -rf -- "$p"; fi
}

older_than_days() { find "$1" -maxdepth 0 -mtime +"$2" 2>/dev/null | grep -q .; }

# prune_wwwroot <keep> <min_age_days> <exempt> <glob…>
prune_wwwroot() {
  local keep="$1" age="$2" exempt="$3"; shift 3
  local -a dirs=(); local d i
  while IFS= read -r d; do
    d="${d%/}"
    [ "$d" = "$exempt" ] && continue
    [ -L "$WWW/$d" ] && continue
    dirs+=("$d")
  done < <(cd "$WWW" && ls -dt $@ 2>/dev/null)
  for ((i = keep; i < ${#dirs[@]}; i++)); do
    older_than_days "$WWW/${dirs[$i]}" "$age" && safe_rm "$WWW/${dirs[$i]}"
  done
}

prune_wwwroot "$WWW_KEEP" "$WWW_MIN_AGE_DAYS" gallery.prev 'gallery.prev*'
prune_wwwroot "$WWW_KEEP" "$WWW_MIN_AGE_DAYS" '' 'gallery.before-*'
prune_wwwroot "$WWW_KEEP" "$WWW_MIN_AGE_DAYS" show1-dist.prev 'show1-dist.prev*' 'show1-dist.bak-*'
prune_wwwroot "$WWW_KEEP" "$WWW_MIN_AGE_DAYS" arenaofbias-home.prev 'arenaofbias-home.prev*'
prune_wwwroot 5 "$WWW_MIN_AGE_DAYS" '' 'arenaofbias-deploy-backups/*'

# /tmp 部署暂存与截图残留（部署脚本不自动清）——同原版，统一走 safe_rm（支持 .keep / DRY_RUN）
while IFS= read -r -d '' t; do safe_rm "$t"; done < <(
  find /tmp -maxdepth 1 \( -name 'aob-*' -o -name 'playwright-*' -o -name 'com.google.Chrome.*' \) -mtime +3 -print0 2>/dev/null)

# 数据包旧版本（内部校验当前版本、pin 与进行中对局引用后才删）
if [ "$DRY_RUN" = 1 ]; then
  (cd /www/wwwroot/arenaofbias-server && npm run --silent prune:datapack) || true   # 不带 --apply = 只列出
  echo "would run: journalctl --vacuum-time=14d"
else
  (cd /www/wwwroot/arenaofbias-server && npm run --silent prune:datapack -- --apply) || true
  journalctl --vacuum-time=14d >/dev/null 2>&1 || true
fi

# /root/aob-* 作业目录
prune_root_aob() {
  local -a dirs=(); local d base i
  while IFS= read -r d; do
    d="${d%/}"; base="$(basename "$d")"
    [ -L "$d" ] && continue
    case "$base" in
      # 非发布小目录：沿用原版豁免
      aob-backup-*|aob-security-*|aob-stage-*|aob-capture-*|aob-fountain-*|aob-gallery-*) continue ;;
      # 发布作业目录：永不自动删除（回滚/护栏/receipt 都在里面）
      aob-server-*|aob-*-pr[0-9]*|aob-pr[0-9]*|aob-performance*|aob-dualwrite*|aob-release*|aob-*-release*|aob-static-rel*|aob-retry-*|aob-approve-*)
        echo "keep(release-job) $d"; continue ;;
    esac
    dirs+=("$d")
  done < <(ls -dt /root/aob-*/ 2>/dev/null)
  for ((i = ROOT_KEEP; i < ${#dirs[@]}; i++)); do
    older_than_days "${dirs[$i]}" "$ROOT_MIN_AGE_DAYS" && safe_rm "${dirs[$i]}"
  done
}
prune_root_aob
echo "=== done $(date '+%F %T %z')"
