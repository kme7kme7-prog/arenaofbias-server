# 站点与共享后端部署、回滚

本页记录已核实的部署布局和操作步骤，**不代表此刻的线上版本**。2026-09-29 的一次历史记录为服务代码 `a1564ff`、数据包 `574b17e006ef2955b8b4a267192828e2aa63d7f8`、数据库 v14；此后可能已经变化。曾有 `5650315` 只在 PR 中、尚未合并到 main，却差点被后续部署覆盖的情况。每次部署必须先按下节核实现场，不能把这些历史值当作当前值。

后端正式目录 `/www/wwwroot/arenaofbias-server` 不是 Git 仓库，代码版本写在 `.server-version`。systemd 服务 `arenaofbias-server` 监听 `127.0.0.1:5273`（API/管理端）和 `127.0.0.1:5180`（作品沙盒内容）。当时 `COOKIE_SECURE=1`、`TRUST_PROXY=1`、`CAPTURE=0`，SMTP 由 systemd drop-in 配置；这些开关也应在部署前重新确认。每日 03:30 的 cron 运行 `/root/archive-backup.sh`，使用 restic 加密归档。证书续期由 `/root/.acme.sh` 的 cron 处理。不要把凭据、私钥或 drop-in 的实际密钥值写入本文或仓库。

## 0. 现场版本与合并门禁

**在任何线上文件、服务、Nginx 或数据包改动之前**，从公网读取 `https://api.arenaofbias.icu/api/bootstrap` 的 `serverVersion`，与操作者本人上次部署时记录的完整 SHA 对比。若没有可靠的个人记录，或值不一致，立即停止并调查是谁部署了什么、该提交是否已合并 main、现场是否含 PR 独有补丁；先把现场状态和来源弄清楚，再制定新部署。不能用本页历史 SHA 或本地 `main` 猜测线上状态。

```bash
curl -fsS https://api.arenaofbias.icu/api/bootstrap \
  | node -e 'let s=""; process.stdin.on("data", x => s += x); process.stdin.on("end", () => console.log(JSON.parse(s).serverVersion))'
cat /www/wwwroot/arenaofbias-server/.server-version
```

两者也应一致；若 `SERVER_VERSION` 环境变量覆盖了版本文件，先查清来源。只部署**已经合并到上游 `main` 的提交**，即使 PR 已通过审阅也不够。选定目标完整 SHA 后，在对应仓库执行 `git fetch origin main` 和 `git merge-base --is-ancestor <目标SHA> origin/main`；返回非 0 就停止。若当前现场含未合并补丁，须先使其进入 main 或另行明确处理，不能用 main 归档直接盖过。

## 线上路由与 Nginx

配置目录为 `/www/server/panel/vhost/nginx`，可执行文件为 `/www/server/nginx/sbin/nginx`。改配置时先备份对应 `.conf`，编辑后测试，通过才重载：

```bash
conf=/www/server/panel/vhost/nginx/gallery.arenaofbias.icu.conf  # 换成实际文件
cp -a "$conf" "$conf.bak-$(date -u +%Y%m%dT%H%M%SZ)"
# 编辑 $conf
/www/server/nginx/sbin/nginx -t && /www/server/nginx/sbin/nginx -s reload
```

| 配置文件 | 域名与用途 | 目标 |
| --- | --- | --- |
| `114.66.27.88.conf` | `114.66.27.88`、`arenaofbias.icu`、`www.arenaofbias.icu`，Show1 静态站 | `root /www/wwwroot/show1-dist` |
| `gallery.arenaofbias.icu.conf` | Gallery 静态站 | `root /www/wwwroot/gallery`，SPA 回退 `try_files $uri $uri/ /index.html` |
| `api.arenaofbias.icu.conf` | API 和管理端 | 代理 `127.0.0.1:5273` |
| `w.arenaofbias.icu.conf` | `*.w.arenaofbias.icu` 作品沙盒 | 代理 `127.0.0.1:5180` |

`TRUST_PROXY=1` 只信任本机单层反代的转发 IP。API 代理应覆盖客户端传入的头，例如 `proxy_set_header X-Forwarded-For $remote_addr;`，并设置 `proxy_set_header X-Forwarded-Proto $scheme;`、`proxy_set_header Host $host;`；后端继续只监听环回。若前面还有 CDN/负载均衡，先核实 Nginx 的真实 IP 信任范围，不直接把多层头当作客户端 IP。部署本轮代码后，API 数据包静态入口不再提供 HTML/HTM；画廊静态站照常提供自己的作品页面，后端作品从独立内容源打开。

旧 `/www/wwwroot/arenaofbias` 目录和 PM2 的 `arena` 进程已经退役，不能再使用旧 Show1 `deploy:vps` 路径。画廊现用 JS/CSS/JSON/HTML `Cache-Control: no-cache`；图片和字体 `expires 1d`。旧画廊配置只匹配 JS/CSS/WebP/PNG/JPG/SVG/WOFF2 并设 `immutable`，`index.html` 从未设为 `immutable`；修改前的备份在同目录 `gallery.arenaofbias.icu.conf.bak-<时间戳>`。**不带内容哈希的文件不能设置 `immutable`**。画廊构建为全部主站模块与样式生成版本 URL，页面仅包含一个合并 Three.js 映射的 import map；须整体发布该次 HTML 和资产，才能绕开旧的无版本 URL 缓存。

## 公开读取与反爬配置

本节文件是待安装配置，提交代码不代表线上已启用。先完成第 0 节现场核对，再备份 Nginx 主配置与四个 vhost。

1. 将 `deploy/nginx/read-zones.conf`、`read-server.conf` 放到正式服务目录；在 Nginx 主配置的 `http {}` 中、vhost include 之前加入 `include /www/wwwroot/arenaofbias-server/deploy/nginx/read-zones.conf;`，仅加载一次。
2. 在 Show1、Gallery、API、作品泛域名四个 `server {}` 中分别加入 `include /www/wwwroot/arenaofbias-server/deploy/nginx/read-server.conf;`。保留现有 root、proxy、缓存、TLS 和 SPA 路由。如果某个 location 已有 `limit_req` / `limit_conn`，server 层配置不会自动继承，须合并这些限制到该 location。已有 429 error_page 也需核对冲突。
3. Nginx 限制按真实 `$binary_remote_addr` 跨四个域名共享，GET/HEAD 都计数：资源持续 20 次/秒（突发 200），整表/榜单/`data.json` 持续 30 次/分钟（突发 15），HTML/目录页持续 60 次/分钟（突发 30），模型包/ZIP 持续 120 次/分钟（突发 40），最多 64 个并发读取。超限返回 JSON 429、`Retry-After: 30` 和两个正式前端的错误 CORS 许可。写入不占这些边缘读取额度。Nginx 漏桶与后端固定窗口独立生效，后端额度见 README。
4. 保持 API 和作品 Node 端口只监听环回，代理覆盖客户端 XFF。前置 CDN 时先配置只信任该 CDN 地址段的真实 IP，否则共享桶会误把所有用户视为一个 IP；不要信任任意来源的真实 IP 头。学校/公司共用 IP 也共享额度，现场正常双站浏览后按日志调节突发值及额度。
5. 执行 `/www/server/nginx/sbin/nginx -t`，通过才 reload。在独立探针 IP 小量验证 429 与 Retry-After；普通浏览核对两个前端首屏、Show1 榜单、画廊模型包/盲评双 iframe、管理员登录和模型下拉。不要对生产做高频压测。
6. Gallery 工作流移除 Pages 发布后，旧副本仍在线；待用户授权上线并且正式站点验收通过后，在 `wsnxxxs/same-prompt-gallery` Settings → Pages 将 Source 设为 None，或按 GitHub 的 Pages API 关闭站点。不要删除原作、数据仓库或 gh-pages 历史；确认 Pages 的首页和 `data.json` 均已不可访问。工作流变更需先进入 main，避免副本重新发布。

API 域完整 `data.json` 仅供管理员获取，`.datapack-source.json` 不公开；这不影响后台登录页或两个前端的展示目录。画廊构建只裁掉展示端未使用的完整模型池和收录接管字段。Show1 仍在客户端重放逐票数据，本轮不改评分或逐票接口形状。限制可以提高批量抓取成本，不能阻止低频抓取、分布式 IP 或从公开 GitHub 源码/已发布数据包下载。CORS、CSP、随机作品 URL 不能替代这些读取额度。

带不可猜测令牌的 `/api/curate/export/:token` 收录下载不占新通用读取/边缘资源桶，保留后端已有的每令牌 2000 次/分钟和每 IP 10000 次/分钟限制，避免大作品收录中途被打断。该例外不允许访问其他公开接口。

回滚时恢复四个 vhost 和主配置备份，`nginx -t` 后 reload；仅调后端 `READ_*` 环境变量不会撤销 Nginx 限制。关闭的 Pages 不自动恢复，需要单独重新发布。

## 静态站差异部署（Show1 / Gallery）

Show1 发布目录是 `/www/wwwroot/show1-dist`，Gallery 是 `/www/wwwroot/gallery`；对应的上一版目录为 `show1-dist.prev`、`gallery.prev`。另有 `/www/wwwroot/show1-dist-backups/` 保存 Show1 历史备份。先执行第 0 节门禁，再在**各自前端仓库**确认目标 SHA 已进入上游 main。不要从工作树或 PR 分支直接构建上线。

下面以 POSIX shell 为例；本机若用 PowerShell，`git archive` 也要用 `--output=<绝对路径>` 写二进制 tar，不能把二进制流经 PowerShell 管道重定向。`site` 取 `show1` 或 `gallery`，`sha` 和 SSH 目标由操作者填入；`work` 使用新的本机临时目录。目标提交的完整 SHA 应记录到个人部署日志。

```bash
set -euo pipefail
site=gallery                         # 或 show1
sha='FULL_SHA_ON_MAIN'
host='user@server'
work='/tmp/static-build-unique-name'
job=/root/static-deploy-$site-$sha
git fetch origin main
git merge-base --is-ancestor "$sha" origin/main
mkdir -p "$work/src" "$work/out"
git -c core.autocrlf=false archive --format=tar --output="$work/source.tar" "$sha"
tar -xf "$work/source.tar" -C "$work/src"
cd "$work/src"
npm ci
if [ "$site" = gallery ]; then
  GITHUB_SHA="$sha" API_BASE_URL=https://api.arenaofbias.icu/ npm run build
else
  npm run build
fi
cp -a dist/. "$work/out/"
(cd "$work/out" && find . -type f -print0 | sort -z | xargs -0 sha256sum) > "$work/manifest.sha256"
scp "$work/manifest.sha256" "$host:/root/static-deploy-$site-$sha.manifest"
```

Gallery 的 `GITHUB_SHA` 必须是该次前端源码 SHA，`API_BASE_URL` 设为 `https://api.arenaofbias.icu/`；前端请求层会把根地址规范化为 `/api/` 目录。两站产物都在各自 `dist/`。上传之前检查入口文件和构建结果。完整 manifest **先**上传，在服务器上对比当前正式目录，产生变化及缺失列表、过时文件列表：

```bash
set -euo pipefail
site=gallery                         # 与本机构建一致
sha='SAME_FULL_SHA'
live=/www/wwwroot/gallery            # Show1 改为 /www/wwwroot/show1-dist
job=/root/static-deploy-$site-$sha
mkdir -m 700 "$job"
mv "/root/static-deploy-$site-$sha.manifest" "$job/manifest.sha256"
sed -n 's/^[0-9a-f]\{64\}  \.\///p' "$job/manifest.sha256" | sort > "$job/target-files.txt"
find "$live" -type f -printf '%P\n' | sort > "$job/live-files.txt"
comm -23 "$job/live-files.txt" "$job/target-files.txt" > "$job/deleted.txt"
while IFS= read -r line; do
  hash=${line%% *}
  rel=${line#*  ./}
  if [ ! -f "$live/$rel" ] || [ "$(sha256sum "$live/$rel" | cut -d' ' -f1)" != "$hash" ]; then
    printf '%s\n' "$rel"
  fi
done < "$job/manifest.sha256" > "$job/changed.txt"
wc -l "$job/changed.txt" "$job/deleted.txt"
```

人工核对清单后，将 `changed.txt` 传回本机；从**已构建产物**仅打包所列新增或变化文件，上传差异包。删除清单不打包，保留在服务器。以下命令在本机执行：

```bash
scp "$host:$job/changed.txt" "$work/changed.txt"
(cd "$work/out" && tar -cf "$work/changed.tar" -T "$work/changed.txt")
scp "$work/changed.tar" "$host:$job/changed.tar"
```

服务器上用普通复制生成 `.next`，不能用硬链接；所有删除只对 `.next` 执行。核对完整 SHA-256 manifest 和**精确文件集合**均通过后才切换，留下 `.prev` 供快速回滚。已有 `.prev` 时先移入相应历史备份目录，不能覆盖。以下命令在服务器上执行：

```bash
next="${live}.next"
prev="${live}.prev"
test ! -e "$next"
cp -a "$live" "$next"
tar -xf "$job/changed.tar" -C "$next"
while IFS= read -r rel; do
  case "$rel" in ''|/*|..|../*|*/../*) exit 1;; esac
  rm -f -- "$next/$rel"
done < "$job/deleted.txt"
(cd "$next" && sha256sum -c "$job/manifest.sha256")
find "$next" -type f -printf '%P\n' | sort | cmp - "$job/target-files.txt"
if [ -e "$prev" ]; then
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  if [ "$site" = show1 ]; then
    mkdir -p /www/wwwroot/show1-dist-backups
    mv "$prev" "/www/wwwroot/show1-dist-backups/show1-dist.prev-$stamp"
  else
    mv "$prev" "${prev}.bak-$stamp"
  fi
fi
mv "$live" "$prev"
mv "$next" "$live"
```

切换后核对首页、JS/CSS/JSON 的响应与缓存头，并在桌面和窄屏检查关键页面。若验收失败，先保留新目录作调查，可用 `mv "$live" "${live}.failed-$sha"`、`mv "$prev" "$live"` 回滚；不要在正式目录上直接解包或删除文件。Nginx 配置若需同步修改，按上节备份、`-t`、reload。此流程描述操作方法，本页修改本身不执行发布。

## 1. 备份与检出

部署前确认 `df -h` 有足够空间，并记录旧版本、数据包指针和数据库版本。以下命令在服务器上以有权限的账号执行。备份目录只保存在服务器受限路径，不传到仓库。

```bash
set -euo pipefail
live=/www/wwwroot/arenaofbias-server
backup=/root/arenaofbias-predeploy-$(date -u +%Y%m%dT%H%M%SZ)
mkdir -m 700 "$backup"
cat "$live/.server-version" > "$backup/server-version"
readlink -f "$live/.datapack/current" > "$backup/datapack-current"
node -e 'const {DatabaseSync}=require("node:sqlite"); const db=new DatabaseSync(process.argv[1],{readOnly:true}); const target=process.argv[2].replaceAll("\u0027","\u0027\u0027"); db.exec("VACUUM INTO \u0027"+target+"\u0027"); db.close();' "$live/.data/platform.db" "$backup/platform.db"
tar -C "$live" --exclude='./.git' --exclude='./.data' --exclude='./.datapack' --exclude='./output' -czf "$backup/code.tar.gz" .
```

数据库先做一致性快照，代码另行打包。投稿文件与媒体由现有每日 restic 归档保存；若本次变更会改动它们，另做同步文件备份。当前仓库的 `scripts/archive-backup.sh` 已先 `VACUUM INTO`，再把 `works`、`media`、数据包和快照交给 restic。恢复较早数据库时，多出的作品目录会在服务启动时移至 `.data/orphans`。

在服务器克隆到临时目录、检出明确的目标 SHA 并运行门禁：

```bash
target_sha='FULL_SHA_ON_MAIN'
stage=/root/arenaofbias-deploy-$target_sha
git clone https://github.com/kme7kme7-prog/arenaofbias-server.git "$stage"
git -C "$stage" fetch origin main
git -C "$stage" merge-base --is-ancestor "$target_sha" origin/main
git -C "$stage" checkout --detach "$target_sha"
(cd "$stage" && npm run check && npm test)
old_sha=$(cat "$backup/server-version")
git -C "$stage" cat-file -e "$old_sha^{commit}"
git -C "$stage" diff --name-status --diff-filter=DR "$old_sha" "$target_sha"
```

最后一条命令列出被删除或改名的旧文件。若有输出，先逐项确认、记录并安排清理；直接 tar 覆盖不会移除旧文件。确认清单为空或已完成处理后才覆盖。`.server-version` 在覆盖完成并确认代码 SHA 后写入：

```bash
tar -C "$stage" --exclude='./.git' --exclude='./.data' --exclude='./.datapack' --exclude='./.server-version' --exclude='./output' -cf - . | tar -C "$live" -xf -
printf '%s\n' "$target_sha" > "$live/.server-version"
```

## 2. 数据包

优先从数据仓的不可变发布包安装。`datapack.json.commit` 须为本次目标产物 SHA；安装完成后先检查目录，再激活。

```bash
cd "$live"
npm run fetch:datapack
npm run activate:datapack
```

服务器从 GitHub 下载约 150 MB 数据包可能卡住，本机上传也只有约 20 KB/s。此时在本机用**两个已安装版本目录**生成仅含变化文件、删除清单、旧树与目标树 SHA-256 的差异包；先在本机试应用一次。示例路径须改为实际绝对路径，目标目录不能已存在：

```bash
node scripts/datapack-delta.mjs create <旧版本目录> <新版本目录> <差异包.gz>
node scripts/datapack-delta.mjs apply <旧版本目录> <差异包.gz> <本机临时目标目录>
node scripts/datapack-delta.mjs verify <本机临时目标目录> <差异包.gz>
```

把差异包传至服务器后，使用服务器已安装的旧版本重建新版本。不要在当前链接指向的目录上原地覆盖。应用命令在完整目录树校验失败时删除暂存目录并拒绝生成目标版本；激活前再校验一次。

```bash
old_pack=$(cat "$backup/datapack-current")
new_pack="$live/.datapack/versions/$(node -p "require('$live/datapack.json').commit")"
delta=/root/<差异包.gz>
node "$live/scripts/datapack-delta.mjs" apply "$old_pack" "$delta" "$new_pack"
node "$live/scripts/datapack-delta.mjs" verify "$new_pack" "$delta"
(cd "$live" && npm run activate:datapack)
```

若目标目录已有半成品，先调查来源；差异脚本会拒绝覆盖。传输或文件被篡改时校验失败，不能激活。以后定期运行 `npm run prune:datapack` 预览，再按需运行 `npm run prune:datapack -- --apply`；它会保留当前、pin 和仍被对局引用的版本。

## 3. 重启和验收

```bash
systemctl daemon-reload
systemctl restart arenaofbias-server
systemctl status arenaofbias-server --no-pager
journalctl -u arenaofbias-server -n 100 --no-pager
curl -fsS http://127.0.0.1:5273/api/bootstrap
```

检查 JSON 的 `serverVersion` 等于目标代码 SHA，`datapack` 等于目标产物 SHA，并核对 `catalogDigest`、作品数和关键登录/榜单接口。代码部署目录没有 `.git`，所以 `.server-version` 是 `serverVersion` 的依据。若从旧会话 Cookie 升级到 `COOKIE_SECURE=1` 下的 `__Host-sp_session`，会让现有用户登出一次。若本轮含数据库迁移，重启时自动执行追加迁移，部署前须另核对迁移版本；数据库不能靠切回旧代码自动降级。

## 4. 回滚

先停止服务，把当前 `.data/platform.db` 和现有代码另存以便调查。恢复备份的代码和数据库，恢复旧数据包链接，确认 `.server-version`，再启动服务。若新版本已经产生业务写入，恢复旧数据库会丢弃这段时间的写入；应先决定是否做人工数据恢复。跨数据库版本回滚必须使用兼容旧代码的备份。

```bash
systemctl stop arenaofbias-server
tar -C "$live" -xzf "$backup/code.tar.gz"
cp "$backup/platform.db" "$live/.data/platform.db"
ln -sfn "$(cat "$backup/datapack-current")" "$live/.datapack/current"
cp "$backup/server-version" "$live/.server-version"
systemctl start arenaofbias-server
systemctl status arenaofbias-server --no-pager
curl -fsS http://127.0.0.1:5273/api/bootstrap
```

若新版本删除或改名了旧代码文件，回滚前按第 1 节记录的清单恢复或清理；tar 解包也不会自动删除新增文件。`.data/works` 与 `.data/media` 不随代码覆盖，必要时从 restic 日备份恢复。

## 5. 运维文件

仓库更新归档脚本后，安装到 cron 现用位置并检查权限。它使用 `/root/.archive-restic-password` 和现有 restic 仓库，部署不应重写密钥。

```bash
install -m 700 "$live/scripts/archive-backup.sh" /root/archive-backup.sh
```

Turnstile 是否启用以部署时环境和 `/api/auth/turnstile` 为准，不使用 2026-09-29 的旧状态推断。官方测试密钥做过 `siteverify` 连通性验证：返回 `success: true`，约 0.7 秒；这只证明测试链路，当次真实密钥配置与端到端注册流程仍须另验。启用时使用受限的 systemd drop-in；下列值仅是占位符，不记录真实密钥：

```ini
# /etc/systemd/system/arenaofbias-server.service.d/turnstile.conf
[Service]
Environment="TURNSTILE_SITE_KEY=<site-key>"
Environment="TURNSTILE_SECRET_KEY=<secret-key>"
```

写入后执行 `systemctl daemon-reload`、重启服务，并通过 `/api/auth/turnstile` 核对站点密钥。SMTP 仍由现有 `smtp.conf` 提供。
