#!/usr/bin/env bash
# 数据包自动同步：arenaofbias-data 的 datapack 分支有新 commit 就换钉、拉取、激活。
# catalog 会惰性感知 current 软链指向变化，无需重启服务。需要 /root/arenaofbias-data 克隆。
set -euo pipefail
ROOT="${DATAPACK_SERVER_ROOT:-/www/wwwroot/arenaofbias-server}"
REPO="${DATAPACK_REPO_DIR:-/root/arenaofbias-data}"

cd "$REPO"
git fetch -q origin datapack
HEAD="$(git rev-parse origin/datapack)"
PIN="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$ROOT/datapack.json', 'utf8')).commit)")"
CURRENT="${DIST_DIR:-$ROOT/.datapack/current}"
ACTIVE="$(node -e 'try { console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).commit || "") } catch { console.log("") }' "$CURRENT/.datapack-source.json")"
if [ "$HEAD" = "$PIN" ] && [ "$ACTIVE" = "$HEAD" ]; then exit 0; fi

cd "$ROOT"
DATAPACK_COMMIT="$HEAD" npm run --silent fetch:datapack
DATAPACK_COMMIT="$HEAD" npm run --silent activate:datapack
node -e 'const fs = require("fs"); const file = "datapack.json"; const tmp = `${file}.tmp-${process.pid}`; const p = JSON.parse(fs.readFileSync(file, "utf8")); p.commit = process.argv[1]; try { fs.writeFileSync(tmp, JSON.stringify(p, null, 2) + "\n"); fs.renameSync(tmp, file); } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }' "$HEAD"
echo "$(date -u '+%F %T') activated $HEAD"
npm run --silent prune:datapack -- --apply
