# 站点与共享后端部署、回滚

本页记录部署布局和操作步骤，**不代表此刻的线上版本**。最近已记录的发布为 2026-10-01 Brisbane 最新四仓发布：后端功能基线 `23574fb`、Gallery `e23d9a5`、Show1 `72c7f10`、数据包 `ba442b61`（源码 `997676d`，20 题 / 182 件）、数据库 v25；本轮后端 pin / 文档收尾提交同步正式源码，完整运行 SHA 见 `.server-version` / 公网 bootstrap。详见 [HANDOFF](../HANDOFF.md) 和 [发布归档](archive/2026-10-01-latest-release-wsnxxxs.md)。静态站的文档后继提交不改变已发布产物。历史上曾有 `5650315` 只在 PR 中、未合并 main，却差点被后续部署覆盖；每次部署仍须先按下节核实现场，不能把记录或本地 main 当作线上版本。

后端正式目录 `/www/wwwroot/arenaofbias-server` 不是 Git 仓库，代码版本写在 `.server-version`。systemd 服务 `arenaofbias-server` 监听 `127.0.0.1:5273`（API/管理端）和 `127.0.0.1:5180`（作品沙盒内容）。Cookie、真实 IP、SMTP、截图和审核由服务器环境或 systemd drop-in 配置；最近一次审核接通记录为 `CAPTURE=1`、`CONTENT_MODERATION=1`，通过专用 SSH tunnel 使用第 6.1 节 relay，仍应在部署前重新确认。已记录每日 03:30 的 cron 运行 `/root/archive-backup.sh`，使用 restic 加密归档；证书续期由 `/root/.acme.sh` 的 cron 处理。不要把凭据、私钥或 drop-in 的实际密钥值写入本文或仓库。

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
| `114.66.27.88.conf` | `114.66.27.88`、`arenaofbias.icu`、`www.arenaofbias.icu`，独立总入口 | `root /www/wwwroot/arenaofbias-home` |
| `game.arenaofbias.icu.conf` | Show1 / 偏见试验场 | `root /www/wwwroot/show1-dist` |
| `gallery.arenaofbias.icu.conf` | Gallery 静态站 | `root /www/wwwroot/gallery`，SPA 回退 `try_files $uri $uri/ /index.html` |
| `api.arenaofbias.icu.conf` | API 和管理端 | 代理 `127.0.0.1:5273` |
| `w.arenaofbias.icu.conf` | `*.w.arenaofbias.icu` 作品沙盒 | 代理 `127.0.0.1:5180` |

`TRUST_PROXY=1` 只信任本机单层反代的转发 IP。API 代理应覆盖客户端传入的头，例如 `proxy_set_header X-Forwarded-For $remote_addr;`，并设置 `proxy_set_header X-Forwarded-Proto $scheme;`、`proxy_set_header Host $host;`；后端继续只监听环回。若前面还有 CDN/负载均衡，先核实 Nginx 的真实 IP 信任范围，不直接把多层头当作客户端 IP。部署本轮代码后，API 数据包静态入口不再提供 HTML/HTM；画廊静态站照常提供自己的作品页面，后端作品从独立内容源打开。

旧 `/www/wwwroot/arenaofbias` 目录和 PM2 的 `arena` 进程已经退役，不能再使用旧 Show1 `deploy:vps` 路径。画廊现用 JS/CSS/JSON/HTML `Cache-Control: no-cache`；图片和字体 `expires 1d`。旧画廊配置只匹配 JS/CSS/WebP/PNG/JPG/SVG/WOFF2 并设 `immutable`，`index.html` 从未设为 `immutable`；修改前的备份在同目录 `gallery.arenaofbias.icu.conf.bak-<时间戳>`。**不带内容哈希的文件不能设置 `immutable`**。画廊构建为全部主站模块与样式生成版本 URL，页面仅包含一个合并 Three.js 映射的 import map；须整体发布该次 HTML 和资产，才能绕开旧的无版本 URL 缓存。

## 公开读取与反爬配置

2026-09-30 已记录在四个正式 HTTPS vhost 安装并验收本节规则，详见 [gallery-protection-deploy 归档](archive/2026-09-30-gallery-protection-deploy-wsnxxxs.md)。提交配置文件本身不代表部署；后续操作仍先完成第 0 节现场核对，再备份 Nginx 主配置与四个 vhost。

1. 将 `deploy/nginx/read-zones.conf`、`read-server.conf` 放到正式服务目录；在 Nginx 主配置的 `http {}` 中、vhost include 之前加入 `include /www/wwwroot/arenaofbias-server/deploy/nginx/read-zones.conf;`，仅加载一次。
2. 在 Show1、Gallery、API、作品泛域名四个 `server {}` 中分别加入 `include /www/wwwroot/arenaofbias-server/deploy/nginx/read-server.conf;`。保留现有 root、proxy、缓存、TLS 和 SPA 路由。如果某个 location 已有 `limit_req` / `limit_conn`，server 层配置不会自动继承，须合并这些限制到该 location。已有 429 error_page 也需核对冲突。
3. Nginx 限制按真实 `$binary_remote_addr` 跨四个域名共享，GET/HEAD 都计数：资源持续 20 次/秒（突发 200），整表/榜单/`data.json` 持续 30 次/分钟（突发 15），HTML/目录页持续 60 次/分钟（突发 30），模型包/ZIP 持续 120 次/分钟（突发 40），最多 64 个并发读取。超限返回 JSON 429、`Retry-After: 30` 和两个正式前端的错误 CORS 许可。写入不占这些边缘读取额度。Nginx 漏桶与后端固定窗口独立生效，后端额度见 README。
4. 保持 API 和作品 Node 端口只监听环回，代理覆盖客户端 XFF。前置 CDN 时先配置只信任该 CDN 地址段的真实 IP，否则共享桶会误把所有用户视为一个 IP；不要信任任意来源的真实 IP 头。学校/公司共用 IP 也共享额度，现场正常双站浏览后按日志调节突发值及额度。
5. 执行 `/www/server/nginx/sbin/nginx -t`，通过才 reload。在独立探针 IP 小量验证 429 与 Retry-After；普通浏览核对两个前端首屏、Show1 榜单、画廊模型包/盲评双 iframe、管理员登录和模型下拉。不要对生产做高频压测。
6. 从 ArenaGalleri 仓库取 `deploy/nginx/gallery-private-files.conf`，安装到网页根目录之外（现用 `/www/server/nginx/conf/aob-protection/`），在 Gallery、API、作品的 HTTPS `server {}` 中分别 include。共享限流不会自动阻止内部构建说明等文件；三处都须核对来源标记、私有配置、build-info、posters 清单及 `.map` 返回 404。Gallery 差异发布还须移除旧内部文件，不能仅依靠 Nginx 隐藏。
7. 正式画廊源码现为 `wsnxxxs/ArenaGalleri`，仅包含 Gallery。旧 Pages 已关闭、gh-pages 与 Actions 缓存已清理，旧 `wsnxxxs/same-prompt-gallery` 已 private 且 archived；认证 API 已确认数据仓 private。新公开 CI 不取私有包、不发布或缓存产物。后续发布不要恢复旧公开副本；权限变更无法收回此前已经下载的内容。

API 域完整 `data.json` 仅供管理员获取，匿名请求返回 404，`.datapack-source.json` 不公开；这不影响后台登录页或两个前端的展示目录。画廊展示字段使用白名单，裁掉完整模型池、源码入口和内部收录字段；完整提示词继续显示和复制。Show1 的聚合与 Gallery 计分均由后台执行，已发布投票逻辑本次未改。限制可以提高批量抓取成本，公开展示内容仍可被低频或分布式读取。CORS、CSP、随机作品 URL 不能替代这些读取额度。

收录导出接口 `/api/curate/export/` 已退役，后端对该路径返回 404 并计入通用读取桶；`read-zones.conf` 里对应的豁免映射暂留，下次修改 Nginx 时再删。

回滚时恢复四个 vhost 和主配置备份，`nginx -t` 后 reload；仅调后端 `READ_*` 环境变量不会撤销 Nginx 限制。若仍保留私有文件防护，只移除共享限流 include；先确认所有旧内部文件已删除，再考虑撤下私有文件规则。关闭的 Pages 不自动恢复。此次数据 pin 更新不含数据库迁移，回退本轮代码/数据时应保留当前 v19 数据库与新写入，不恢复上一轮投票清零前的库。

## 共用题库发布

2026-09-30 已完成新版共用题库切入和 Gallery 版本切换发布，详见 `docs/archive/2026-09-30-shared-question-release-wsnxxxs.md`。Show1 通过既有 API 读取 20 道共用题与 5 道历史题，静态站无需重新构建；Gallery 需要同时更新消费 pin 和前端。不能把数据源发布或消费端本地构建称为正式上线。

数据包变体的来源字段不用于公开展示，`/api/prompts` 与 Gallery 仅输出版本 id、标签和原文。题库卡片只对有解答的题读取榜单，避免空题并发消耗共享读取额度。新增作品应声明实际使用的 promptVariant，不拆题或改作品 ID。

本次没有数据库迁移，完整回退应一起恢复旧后端 pin、数据版本和 Gallery，保留当前 v19 数据库与后续写入；Nginx、Show1 和审核配置保持。不可变数据版本按消费方显式 pin 管理，不自动追随数据仓文档提交产生的新产物。

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
if [ "$site" = gallery ]; then
  node --input-type=module - "$work/out" <<'NODE'
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const root = process.argv[2];
const { assets } = JSON.parse(readFileSync(join(root, 'version.json'), 'utf8'));
const html = readFileSync(join(root, 'index.html'), 'utf8');
const versions = [...html.matchAll(/[?&]v=([^"'&\s<>]+)/g)].map(match => decodeURIComponent(match[1]));
if (typeof assets !== 'string' || !assets || !versions.length || versions.some(version => version !== assets)) {
  throw new Error('version.json assets must match every index.html asset version');
}
NODE
fi
(cd "$work/out" && find . -type f -print0 | sort -z | xargs -0 sha256sum) > "$work/manifest.sha256"
scp "$work/manifest.sha256" "$host:/root/static-deploy-$site-$sha.manifest"
```

game 的 `npm run build` 自动读取已入库的 `.env.production`（`VITE_API_BASE_URL=https://api.arenaofbias.icu`），也可显式使用 `VITE_API_BASE_URL=https://api.arenaofbias.icu npm run build`。game 的 `/api` 反代用于兼容上线前已打开的旧页面；移除条件、验收与回滚见[第 9 节](#9-移除-game-api-反代)，满足条件并获用户明确同意前保留。

Gallery 的 `GITHUB_SHA` 必须是该次前端源码 SHA，`API_BASE_URL` 设为 `https://api.arenaofbias.icu/`；前端请求层会把根地址规范化为 `/api/` 目录。两站产物都在各自 `dist/`。Gallery 根目录的 `version.json` 内容为 `{"assets":"<资产版本>"}`，`assets` 由该次构建生成，必须与该次 `index.html` 中所有 `?v=` 一致，用于旧标签页加载失败后判断是否可以刷新恢复。上传之前检查入口文件和构建结果。完整 manifest **先**上传，必须包含 `version.json`，不能从目标文件清单中排除它，否则会被误判为过时文件。在服务器上对比当前正式目录，产生变化及缺失列表、过时文件列表：

```bash
set -euo pipefail
site=gallery                         # 与本机构建一致
sha='SAME_FULL_SHA'
live=/www/wwwroot/gallery            # Show1 改为 /www/wwwroot/show1-dist
job=/root/static-deploy-$site-$sha
mkdir -m 700 "$job"
mv "/root/static-deploy-$site-$sha.manifest" "$job/manifest.sha256"
sed -n 's/^[0-9a-f]\{64\}  \.\///p' "$job/manifest.sha256" | sort > "$job/target-files.txt"
if [ "$site" = gallery ]; then
  grep -Fx version.json "$job/target-files.txt"
fi
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

人工核对清单后，将 `changed.txt` 传回本机；从**已构建产物**仅打包所列新增或变化文件，上传差异包。Gallery 的完整 manifest 包含 `version.json`，变化比较也按完整 manifest 执行，只有资产差异包排除它：先上传完整资产和 `index.html` 的差异包，最后单独上传 `version.json` 到暂存任务目录，即使标记哈希未变也单独上传，避免漏传。删除清单不打包，保留在服务器。以下命令在本机执行：

```bash
scp "$host:$job/changed.txt" "$work/changed.txt"
if [ "$site" = gallery ]; then
  sed '/^version\.json$/d' "$work/changed.txt" > "$work/asset-changed.txt"
else
  cp "$work/changed.txt" "$work/asset-changed.txt"
fi
(cd "$work/out" && tar -cf "$work/changed.tar" -T "$work/asset-changed.txt")
scp "$work/changed.tar" "$host:$job/changed.tar"
if [ "$site" = gallery ]; then
  scp "$work/out/version.json" "$host:$job/version.json"
fi
```

服务器上用普通复制生成 `.next`，不能用硬链接；所有删除只对 `.next` 执行。核对完整 SHA-256 manifest 和**精确文件集合**均通过后才切换，留下 `.prev` 供快速回滚。Gallery 必须先上线完整资产和 `index.html`，最后独立发布 `version.json`；提前发布新标记会让旧标签页刷新到半套新版。下面先在 `.next` 校验完整目标，再暂留正式站的旧标记（首次发布无旧标记时暂不放标记），切换目录后才原子替换新标记。标记暂存在同一文件系统的兄弟路径，避免跨文件系统移动变成复制。已有 `.prev` 时先移入相应历史备份目录，不能覆盖。以下命令在服务器上执行：

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
if [ "$site" = gallery ]; then
  cp -p "$job/version.json" "$next/version.json"
fi
(cd "$next" && sha256sum -c "$job/manifest.sha256")
find "$next" -type f -printf '%P\n' | sort | cmp - "$job/target-files.txt"
if [ "$site" = gallery ]; then
  marker="${live}.version-$sha.json"
  test ! -e "$marker"
  cp -p "$next/version.json" "$marker"
  if [ -f "$live/version.json" ]; then
    cp -p "$live/version.json" "$next/version.json"
  else
    rm -f "$next/version.json"
  fi
fi
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
if [ "$site" = gallery ]; then
  mv -f "$marker" "$live/version.json"
  (cd "$live" && sha256sum -c "$job/manifest.sha256")
  find "$live" -type f -printf '%P\n' | sort | cmp - "$job/target-files.txt"
fi
```

切换后核对首页、JS/CSS/JSON 的响应与缓存头，并在桌面和窄屏检查关键页面。Gallery vhost 的 `/version.json` 必须返回 `Cache-Control: no-cache` 或 `no-store`，不能进入长缓存或 `immutable`；前置 CDN / 反代也不得缓存这个路径。本地已有文档与历史 vhost 样本中的 JSON `no-cache` 规则满足此要求，无需另加 location；这些记录不代表当前生产已验收，应在发布时核对实际响应。若为 `version.json` 确需新增 location，其中必须 include `security-headers.conf`，避免丢失安全头；本文不新增配置。Nginx 配置若需同步修改，按上节备份、`-t`、reload。

本地配置核对：`static-private-paths.conf`、`read-zones.conf` 和 ArenaGalleri 的 `gallery-private-files.conf` 均不阻止 `version.json`；它走普通资源限流 20 次/秒、突发 200，不加入 catalog 限流。

Gallery 发布验收增加以下请求（由获准发布的操作者执行）：

```bash
curl -I https://gallery.arenaofbias.icu/version.json
curl -fsS https://gallery.arenaofbias.icu/version.json
curl -fsS https://gallery.arenaofbias.icu/index.html
```

HEAD 应为 HTTP 200、包含 `no-cache`（或 `no-store`），无 `immutable`；GET 的 `assets` 必须与返回 HTML 的 `app.js?v=` 及其他全部资产版本一致。还须验证旧标签页的加载失败恢复提示和刷新后的关键页面，不能只凭构建或 HTTP 200 宣称交互通过。

若验收失败，先保留新目录作调查。Show1 沿用 `mv "$live" "${live}.failed-$sha"`、`mv "$prev" "$live"`。Gallery 回退 `gallery.prev` 时也先恢复完整资产和 `index.html`，最后恢复旧 `version.json`；复制到独立回滚暂存目录，不直接修改 `.prev`：

```bash
set -euo pipefail
rollback="${live}.rollback-next"
rollback_marker="${live}.rollback-version-$sha.json"
test ! -e "$rollback"
test ! -e "$rollback_marker"
test -f "$prev/version.json"
cp -a "$prev" "$rollback"
cp -p "$rollback/version.json" "$rollback_marker"
if [ -f "$live/version.json" ]; then
  cp -p "$live/version.json" "$rollback/version.json"
else
  rm -f "$rollback/version.json"
fi
mv "$live" "${live}.failed-$sha"
mv "$rollback" "$live"
mv -f "$rollback_marker" "$live/version.json"
```

若 `.prev` 来自尚无 `version.json` 的旧构建，上述 Gallery 回滚脚本会停止；须先确认该旧版不支持版本恢复，再使用整目录切换回退，不能伪造或沿用新版标记。回滚后重新核对标记与 HTML 版本和缓存头。不要在正式目录上直接解包或删除资产文件。此流程描述操作方法，本页修改本身不执行发布。

两站登录互通验收：在 game 登录后，打开 Gallery 应显示已登录；在 Gallery 登出后，切回 game 应显示未登录。DevTools 中新会话 Cookie 只出现在 `api.arenaofbias.icu`。首次上线后，原本在 game 上登录的用户需要重新登录一次；旧 game Cookie 自然过期，不需要清理。

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

## 6. Luna Flex 内容审查

实际运行状态以 HANDOFF 最新部署记录为准。首次启用时，按本文版本门禁与备份流程先发布配套后端（启动追加 v19），再发布前端。密钥只放受限服务器环境文件，不写入仓库、前端构建变量或验收日志：

```ini
# /etc/systemd/system/arenaofbias-server.service.d/moderation.conf
[Service]
Environment="CONTENT_MODERATION=1"
Environment="CAPTURE=1"
Environment="MODERATION_BASE_URL=https://api.openai.com/v1"
Environment="MODERATION_MODEL=gpt-6-luna"
Environment="MODERATION_API_KEY=<server-only-key>"
```

生产启用截图和自动审核时，必须安装能被后端进程 `import('playwright')` 解析的 Playwright 及 Chrome，并保证服务账号可以启动浏览器；只在其他前端目录安装 Playwright 不保证后端可用。本服务不新增 npm 依赖声明，截图所需组件作为部署环境单独准备。`CAPTURE_BROWSER` 默认 `chrome`，对应本机 Chrome；所装 Playwright 必须支持 `routeWebSocket`。启动会实际探测导入和浏览器启动，并打印一次「自动截图可用」「自动截图不可用」或「自动截图已关闭」。

浏览器启动失败后 `site.capture=false`，冷却五分钟后的下一件作品再尝试启动，恢复成功后变回 true；单个视口截图失败会用新 context 重试一次，两档仍需齐备才能送 Luna。`CAPTURE=0` 始终关闭截图。配置后 daemon-reload 并重启，在 bootstrap 同时核对 `site.capture`、`site.contentModeration` 和 `site.autoModeration`：后者只有审核开启、密钥已配置且截图当前可用时才为 true。审核开启但自动能力为 false 时，新作品转人工，前端应提示「管理员检查内容」。

先在隔离环境确认两档截图及 Responses API 的 Flex 结构化响应；真实调用会计费，本地回归可使用模拟接口。用测试投稿确认公开列表/原作品源/媒体均被限制，作者与管理员可预览，自动通过后公开，疑似与错误转人工。后台人工通过内容理由选填，空白保存「人工复核通过」；拒绝理由必填。

管理员直传与收件箱「登记并发布」视为管理员已完成人工内容审核：保存 approved / human、管理员名与「管理员上传」理由，写审计后一步核验发布，不送 Luna。仅登记收件箱仍走自动内容审核。普通作品核验接口在内容未放行时返回 409「请先完成内容审核」。

截图机器需能显示中文；Debian 可安装 `fonts-noto-cjk`，用 `fc-list :lang=zh` 确认可用，并用实际截图核对。缺少中文字体时，页面 innerText 仍可能正确，但图片中的文字会显示为方框，导致模型交人工；安装后需让截图浏览器重新启动。

Flex 固定为唯一计费档，不自动改用标准档。密钥缺失、`CAPTURE=0`、浏览器不可用、容量不足或超时均会进入人工队列；不要以「上传成功」判断审查完成。旧作品标记 legacy，默认不批量重审。送审涵盖声明、页面文字、封面和两档首屏，不覆盖整包及全部交互。

关闭 `CONTENT_MODERATION` 会停止自动队列，新作品走旧流程，已有待审/拒绝作品仍保持限制。退回不理解 v19 内容状态的旧代码会公开这些作品，不能直接只回滚代码；须先停写并按备份流程恢复兼容数据库及文件，或保留支持内容访问限制的版本。

本轮上传审核收口可先发布后端，再发布 Gallery；新前端对缺少 `autoModeration` / `review.content` 有兜底，旧前端发送的 `harnessVersion` 会被忽略，因此前端也可先发布。不新增数据库清理迁移，`harness_version` 列和存量值保留；私有数据仓同轮更新来源脚本，后续构建不输出 Harness 版本。消费者 pin 仍按不可变数据包发布流程另行切换。

### 6.1 独立审查服务器与 SSH 连接

正式站无法连接官方 API 时，可以在可用的审查服务器运行 `scripts/moderation-relay.mjs`。它只接受已配置 Key 的 `/v1/responses` 请求，限定 `gpt-6-luna`、`service_tier=flex`、`store=false` 和非流式响应；只连接官方 Responses API，保留上游 HTTP 状态，不重试或切换计费档。请求最多 81 MiB、上游时限 15 分钟，客户端断开会取消上游请求。未记录 Key、请求正文或提供商错误消息。

审查服务器用独立的 Node ≥ 22.13 运行环境与 systemd `arenaofbias-review-relay`，监听 `127.0.0.1:5280`。`/etc/arenaofbias-review.env` 为 root 持有的 0600 文件，配置 `MODERATION_API_KEY`、`MODERATION_MODEL=gpt-6-luna`、`REVIEW_PORT=5280`。服务以无登录 shell 的 `arena-review` 用户运行。无需新增 npm 依赖、公开 HTTP 端口、域名或修改已有 Nginx / Xray。

正式服务器通过 systemd `arenaofbias-moderation-tunnel` 维护 SSH 本地转发：

```sh
ssh -NT -i /root/.ssh/arenaofbias-review-154.36.185.169 \
  -o BatchMode=yes -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile=/root/.ssh/arenaofbias-review-known-hosts \
  -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -L 127.0.0.1:5280:127.0.0.1:5280 arena-review@154.36.185.169
```

SSH 使用独立 Ed25519 身份并固定主机公钥；远端授权公钥限制为 `restrict,port-forwarding,permitopen="127.0.0.1:5280"`，用户无登录 shell。上述两项新服务设为开机启动、失败后恢复，既有 Xray、443 监听及全局 Node 均不改动。

先在正式服务器请求 `http://127.0.0.1:5280/health`，再用隔离作品跑实际截图和内容审查模块、确认 Luna Flex 响应。成功后将现有 moderation.conf 的 `MODERATION_BASE_URL` 改为 `http://127.0.0.1:5280/v1`，保留 Key 与审核/截图开关；daemon-reload、重启正式服务，再核对运行进程设置和公网 bootstrap。loopback HTTP 由上述 SSH 通道加密跨机传输。

回滚该连接仅需恢复备份 moderation.conf 并重启平台，再停止专用 tunnel/relay；不涉及数据迁移，也不删除 Xray 或修改共享端口。当前部署、实际验证与备份位置以 HANDOFF 最新记录为准。

## 7. 安全加固（2026-10-02 红队报告后续）

以下步骤由站长在 VPS、DNS 控制台执行；仓库只提供代码开关和说明。每一步都先备份要改的文件，改完先校验语法再重载。

### 7.1 SSH

1. 本机 `ssh-keygen -t ed25519`，`ssh-copy-id root@<VPS>`，在新窗口确认免密码登录可用。
2. 保持一个已登录会话，写入 `/etc/ssh/sshd_config.d/10-hardening.conf`：

```
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
```

3. `sshd -t` 无输出后 `systemctl restart ssh`，从新窗口确认仍可登录，再关闭旧会话。
4. `apt install fail2ban`，`/etc/fail2ban/jail.d/sshd.local`：

```
[sshd]
enabled = true
maxretry = 3
findtime = 10m
bantime = 1d
```

### 7.2 平台与截图分别降权和隔离

平台用 `arenaofbias` 用户写业务库；执行投稿脚本的 Chrome 用独立的 `aob-capture` 用户，在 systemd 文件系统沙盒中运行。截图服务不挂载平台数据，不继承 SMTP、审核或 Turnstile 环境；它只返回截图字节与页面文字，仍由平台写 `.data/media` 和数据库。这里不要求安装 Docker。

部署顺序如下，先完成第 0 节版本门禁、备份原配置和源码，并在临时目录验收：

1. 创建两个无登录 shell 的系统用户和对应同名组：`arenaofbias` 的 HOME 为 `/var/lib/arenaofbias`，`aob-capture` 的 HOME 为 `/var/lib/aob-capture`。保留已有账号，不重建。
2. 保持 `/opt/arenaofbias-capture/node_modules` 的既有 Playwright 运行时；把本次已合入 main 的 `scripts/capture-browser.mjs` 安装为 root 所有的 `/opt/arenaofbias-capture/capture-browser.mjs`。平台的 `node_modules` 仍指向相同运行时，客户端与服务端 Playwright 版本必须一致。Chrome 使用系统 `/opt/google/chrome`，不依赖 `/root` 缓存。
3. 将 `deploy/systemd/arenaofbias-capture.service` 安装为 `/etc/systemd/system/arenaofbias-capture.service`。此服务绑定环回，开启 Chromium 系统沙盒，隐藏 `/www`、平台 drop-in 和平台 HOME；限制 1 GiB 内存、1 CPU 和 256 tasks。不要增加 `RestrictNamespaces` 或 `MemoryDenyWriteExecute`，Chrome 沙盒和 V8 需要相应能力。保留主机网络供受控 `route.fetch()` 读取作品和批准的 CDN。
4. `systemctl daemon-reload && systemctl enable --now arenaofbias-capture`。服务在发布 `/run/aob-capture/endpoint` 后才通知 ready；该文件为 `aob-capture:aob-capture 0640`，目录为 0750。端点含浏览器控制令牌，不打印、不写入日志或仓库，不公开控制端口。
5. 停止平台后，把 `.data` 的所有者改为 `arenaofbias:arenaofbias`，根目录权限改为 0700；源码和 `.datapack` 仍由 root 持有、平台用户可读。将 `deploy/systemd/arenaofbias-server-hardening.conf` 安装到平台服务 drop-in 的 `hardening.conf`，保留现有 SMTP、审核、Turnstile 配置，daemon-reload 后启动平台。
6. 配置 `CAPTURE_ENDPOINT_FILE=/run/aob-capture/endpoint` 时，平台只连接独立服务；连接失败转人工，不退回本地 Chrome。未配置此项时保留开发环境的本地截图路径；本地路径的 `CAPTURE_SANDBOX=1` 仍要求非 root 用户。

验收实际进程 UID、Chrome 不带 `--no-sandbox`、`chrome://sandbox` 的 namespace/seccomp 状态、两档首屏与延迟截图、页面/iframe 文字、外站 HTTP/WebSocket 阻断，以及截图用户无法读取业务库、平台密钥配置与平台进程环境。先用合成页面和临时媒体目录，不为验收创建生产投稿。

root 的备份 cron 与审核 SSH tunnel 保持独立。确认备份快照能读取降权后的数据库；后续 root 停服维护若产生 SQLite WAL/SHM，重新核对 owner。数据包目录与 root 同步任务生成的文件应允许平台读取，使用 `umask 022`，不得为此给平台开放 `/root`。

回滚时先停平台和截图服务，恢复本轮备份的源码、版本标记和 drop-in，再重启平台；保留当前数据库与后续业务写入，不恢复旧数据库。若恢复 root 本地截图，同时恢复旧 `CAPTURE_SANDBOX` 设置。按备份恢复 `.data` owner 和根目录权限，避免只撤销一半配置。

### 7.3 截图沙盒与 Chrome 更新

- 独立截图服务固定开启 Chromium 沙盒；用 `systemctl status arenaofbias-capture` 和实际 Chrome 进程核对。截图服务故障由 systemd 重启，平台保留五分钟重试冷却与人工审核路径，不自动降级为无沙盒执行。
- `apt update && apt install --only-upgrade google-chrome-stable`；在 unattended-upgrades 的 `Origins-Pattern` 加入 Google 源，保持 Chrome 自动更新。

### 7.4 上线本轮代码前

本轮起，投稿要在人工作出决定（核验 / 存疑，或人工内容审查通过）后才出现在公开列表和公开作品源。部署前列出受影响的作品，建议先在后台处理：

```sql
SELECT task_id, id, title FROM works
WHERE status = 'unverified' AND deleted_at IS NULL
  AND json_extract(moderation, '$.status') IN ('approved', 'legacy')
  AND json_extract(moderation, '$.source') IS NOT 'human';
```

本轮不涉及数据库迁移。定期复查默认每 24 小时，可用 `CONTENT_RECHECK_HOURS` 调整，0 关闭；只有内容变化的作品会再次调用 Luna。

### 7.5 DNS 与 Nginx

- **SPF / DMARC**：验证码发件地址不在本域时加 `TXT @ "v=spf1 -all"`；在本域时改为 `v=spf1 include:<SMTP 服务商给出的值> -all` 并按服务商说明加 DKIM。两种情况都加 `TXT _dmarc "v=DMARC1; p=quarantine; rua=mailto:<站长邮箱>"`，观察两周无误后改 `p=reject`。
- **主域与 game 安全头**（gallery、api 同样补齐；带自己 `add_header` 的 location 不继承 server 层，需逐个补）：

```nginx
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header X-Frame-Options "SAMEORIGIN" always;
```

  CSP 先用 `Content-Security-Policy-Report-Only` 观察一周再改为正式头。
- **主域只跳首页**：`114.66.27.88.conf` 中改为 `location = / { return 301 https://game.arenaofbias.icu/; }` 与 `location / { try_files $uri $uri/ =404; }`，以现有配置为准合并。
- **埋点单独限流**：`http {}` 加 `limit_req_zone $binary_remote_addr zone=aob_track:10m rate=20r/m;`；api 的 server 块加 `location = /api/track { limit_req zone=aob_track burst=10 nodelay; <照抄现有 /api 的 proxy 配置> }`。后端自身上限为 600 次/分/IP，超限仍回 204。
- 每次改完 `nginx -t` 再 `systemctl reload nginx`。

### 7.6 管理员用户名

`grep -r ADMIN_USERNAMES /etc/systemd/system/arenaofbias-server.service.d/` 查看保留名；本轮起没有有效验证码的注册请求不再暴露保留名或已有账号。若保留名是 `admin` 这类易猜名字，换成不易猜的用户名；若确有 `admin` 账号，按 `npm run admin` 建新管理员后删除旧号。

### 7.7 验收

| 检查 | 期望 |
| --- | --- |
| 密码方式 SSH | `Permission denied (publickey)` |
| `systemctl show arenaofbias-server -p User` | `arenaofbias` |
| `ps -o user,args -C chrome` | 非 root，无 `--no-sandbox` |
| Luna 通过但未人工处理的投稿公开源 | 410 |
| 人工核验或人工内容通过后 | 200 |
| 带 `type="password"` 的测试投稿 | 转 review，理由列出命中信号 |
| 已注册邮箱发注册验证码 | 与正常发码相同的响应，邮箱收到注册提醒 |
| `curl -sI https://arenaofbias.icu/xxx` | 404 |
| 主域、game 响应头 | 含 HSTS、nosniff |
| DoH 查询 `_dmarc` TXT | 有 DMARC 记录 |

## 8. 2026-10-02 红队复核与登录加固

以下是候选修复的发布步骤，不表示已上线。先按第 0 节核实现场版本并确保目标提交进入上游 main。后端、管理端与两个前端必须配套发布：生产配置 Turnstile 后，所有密码登录都需提交 `turnstileToken`，服务端在验密前校验，验证不可用时返回 503。沿用现有 `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY`，不得在仓库保存密钥。管理员页面 CSP 已放行 `challenges.cloudflare.com`，两个前端也须保留脚本与 iframe 许可。

- 同一账号跨 IP、同一 IP 跨账号 15 分钟内 5 次错误密码后，登录临时封禁 15 分钟；全站最多 32 个在途登录流程，超额立即返回 429 与 Retry-After。管理员失败与触发封禁记入 audit，封禁同时写 journal。封禁状态为进程内状态，重启清除；不自动给任何管理员降权，也不按用户名永久封禁。
- 登录撤销请求中唯一的旧会话 Cookie；普通账号闲置 24 小时、管理员 30 分钟失效，绝对有效期仍为 30 天。上线前备份 SQLite；启动自动追加 v32 `sessions.last_seen_at`，旧会话按原创建时间回填，部分用户需重新登录。回滚代码时保留新库与之后写入，不恢复旧业务库。
- 匿名对局已有 3 小时过期时间，改为启动与每分钟确定清理无正式票引用的过期行，匿名无票对局最多 10000 条。练习模式始终只存内存，原有 5000 局上限，新增 3 小时 TTL；不强制练习登录。
- 部署 `deploy/nginx/security-headers.conf`、`static-private-paths.conf` 与更新的 `read-zones.conf` / `read-server.conf`。主域、game、gallery、API 在 server 级加入 security-headers include；自带 `add_header` 的 location 同样加入，避免丢失 HSTS / nosniff / CSP。CSP 按 host 在 read-zones 中定义，API / 作品域不叠加前端 CSP。作品沙箱保持原策略。Gallery 的 `/results/`、`/_sandtable/`、`/_scenes/` 和 game 的 `/art/pelican-cover.html` 题库封面及 `/works/` 内置作品路径仅使用 `frame-ancestors 'self'`，允许各自同源嵌入；其他页面保留对应 host 的原 CSP（包括 game 顶层 `frame-ancestors 'none'`）。发布此映射后核对 game 题库封面 iframe，以及顶层、API 和上传作品响应头。
- 三个静态站在其他正则 location 之前 include `static-private-paths.conf`，隐藏文件与仓库配置返回 404，ACME 路径保留。Gallery 使用 hash 路由，`try_files $uri $uri/ =404`；game 静态导出用 `try_files $uri $uri/ $uri.html =404`，保留实际导出页面。`robots.txt` 仅返回真实文件，不回退 HTML。主域到 game 的既有旧路径跳转按原用途保留。
- game `/api` 反代保留期间覆盖 XFF 为 `$remote_addr`，移除流程见[第 9 节](#9-移除-game-api-反代)。现有读取限流均带 `nodelay`，后端固定窗口也直接拒绝；本次不因报告中超时现象猜测并调整限流额度。429 错误 CORS 补齐 game 来源，安全头同时覆盖限流错误页。

每次改 Nginx 前备份原 vhost 与 game 反代 include，`nginx -t` 成功才 reload。发布验收应包含三个首屏、安全头、game 合法静态路由、未知路径 / `.git` / `.env` / `robots.txt` 的状态码，以及三个登录 UI 的 token 获取、失败后重置、正常登录。不得用生产管理员错误密码或批量请求做压测。

复核报告的实际差异：会话原先已有绝对过期和新 token，只缺旧会话撤销及闲置超时；练习局不落库；后台 traffic paths 已通过 `esc()` 输出，报告的 canary 不会作为 HTML 渲染。服务仍以 root 运行、SSH 允许 root 密码登录属于独立基础设施风险；修改它们前须确认新的运维登录通道与截图服务权限，不能直接关闭现有唯一通道。

## 9. 移除 game /api 反代

game `/api` 反代只用于兼容上线前已打开的旧页面；配置仅在服务器的 game vhost 或其 include 中，仓库没有这段配置。执行前必须同时满足：Show1 共用会话版本已发布并通过“两站登录互通”验收；上线后已完成用户指定时长的观察；用户在聊天中明确同意修改生产 Nginx。缺一项就只维护文档，不连接服务器或修改配置，不自行决定观察时长。

1. 先按第 0 节核对现场版本与来源，并核对已发布的 Show1 产物确实直接请求 `https://api.arenaofbias.icu`。核对两站登录互通的验收记录和观察期起止。
2. 只读查看 game vhost 及其实际引用的 include，必要时用 `/www/server/nginx/sbin/nginx -T` 核对有效配置。列出所有匹配 `/api` 的精确、前缀与正则 location，连同 XFF 覆盖、限流、429 错误 CORS 和安全头的相关配置；确认哪些 include 被其他站点共用。按现场 `access_log` 路径和 `log_format`，只读统计观察期内 game 主机 `/api` 的近期请求量与 UA，确认只剩零星旧页面请求；共享日志须按 game 主机筛选，不能把 api 主机流量算入。仍有持续使用者或来源不明就停止并报告。
3. 将拟删除的配置原文、涉及的 vhost / include 路径、日志结论、备份位置与修改计划先发给用户看，取得针对这份计划的明确同意后再执行。备份 game vhost 及所有将修改的 include，记录路径；共用文件只改 game 对应的配置，不删除其他站点使用的规则。
4. 删除 game 中代理 `/api` 的 location，让该路径回到既有静态站 404 规则（game 为 `try_files $uri $uri/ $uri.html =404`），不加入首页回退。保留其余静态路由、安全头和 CSP。`deploy/nginx/read-zones.conf` 的 CORS 映射必须保留 game 来源，因为 game 页面仍会跨域请求 api 主机；api 主机的代理、XFF 与 429 CORS 配置不随此次删除而撤下。
5. 执行 `/www/server/nginx/sbin/nginx -t`，通过后才执行 `/www/server/nginx/sbin/nginx -s reload`；失败时恢复备份，不重载无效配置。按下表验收，并如实记录执行时间、配置差异、语法检查与验收结果。

| 检查 | 期望 |
| --- | --- |
| `https://game.arenaofbias.icu/api/bootstrap` | HTTP 404 |
| game 首屏、登录、投票、评论 | 正常，API 请求发往 api 主机 |
| Gallery 首屏与登录状态 | 正常；game 登录后 Gallery 已登录，Gallery 登出后切回 game 未登录 |
| DevTools 新会话 Cookie | 只出现在 api.arenaofbias.icu |
| game 安全头与 CSP | 与修改前一致 |

回滚时恢复本次备份的 vhost 与 include，执行 `/www/server/nginx/sbin/nginx -t`，通过后 reload，再确认 game `/api/bootstrap` 恢复代理且两个前端正常。此次操作不改后端代码、Cookie 或生产数据。
