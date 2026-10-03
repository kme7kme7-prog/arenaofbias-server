#!/usr/bin/env bash
# 部署遗留物保留策略：回滚快照保留最新 N 份，/tmp 部署暂存保留 3 天，
# 数据包旧版本走 datapack.mjs prune 的安全清理，journal 归档保留 14 天。
# 由 cron 每日运行；任何一步失败不影响其余步骤。
set -uo pipefail

WWW=/www/wwwroot

# prune_wwwroot <glob…> <keep> <exempt>
# 在 $WWW 下按 mtime 从新到旧排列匹配项，跳过 <exempt>，删除第 <keep> 份之后
# 的全部目录。<exempt> 是部署脚本使用的「上一份」活动回滚名，永不删除。
prune_wwwroot() {
  local keep="$1" exempt="$2"; shift 2
  local -a dirs=()
  local d
  while IFS= read -r d; do
    [ "$d" = "$exempt" ] && continue
    dirs+=("$d")
  done < <(cd "$WWW" && ls -dt $@ 2>/dev/null)
  local i
  for ((i = keep; i < ${#dirs[@]}; i++)); do
    echo "remove $WWW/${dirs[$i]}"
    rm -rf -- "$WWW/${dirs[$i]}"
  done
}

prune_wwwroot 1 gallery.prev 'gallery.prev*' 'gallery.before-*'
prune_wwwroot 1 show1-dist.prev 'show1-dist.prev*' 'show1-dist.bak-*'
prune_wwwroot 1 arenaofbias-home.prev 'arenaofbias-home.prev*'
prune_wwwroot 5 '' 'arenaofbias-deploy-backups/*'

# /tmp 部署暂存与截图残留（部署脚本不自动清）
find /tmp -maxdepth 1 \( -name 'aob-*' -o -name 'playwright-*' -o -name 'com.google.Chrome.*' \) -mtime +3 -exec rm -rf {} + 2>/dev/null

# 数据包旧版本（内部校验当前版本、pin 与进行中对局引用后才删）
(cd /www/wwwroot/arenaofbias-server && npm run --silent prune:datapack -- --apply) || true

# journal 归档保留 14 天
journalctl --vacuum-time=14d >/dev/null 2>&1 || true
