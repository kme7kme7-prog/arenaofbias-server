# 2026-10-10 · 连接恢复联合发布 · kme7kme7-prog

用户授权立即部署已推送的后台7c5ce10和Gallery3cfdac1。身份使用用户GitHub名与noreply邮箱，提交无联合署名。后端只替换app/arena/library三文件，其余现场代码逐SHA保留；无配置、作品、数据包、schema或Nginx改动。

Linux check111/0、test330/330。最新一致副本新旧配置榜/模型榜除updatedAt外逐字段一致：8159/8022有效票、211参与者、144/66条目；作品清单一致，新totals等于旧配置榜totals。停服另备份最新库v41、1054作品、8495票、260用户、54社区题，前后完整性ok、外键0。没有恢复或替换生产库。

发布与验证约9.62秒，服务active/running、NRestarts0。公网部署检查60题/40社区题/928作品，API/CORS/数据包兼容通过。Gallery六个公网文件SHA、模块缓存版本和内联CSP哈希通过。单次loopback bootstrap1.928s、重叠auth/me34ms（空闲2ms），公网auth/me200/206ms；非长期负载保证。未生产登录、审核、投稿、投票或重新浏览器目检。

备份/root/aob-connectivity-20261010/backup/；旧Gallery/www/wwwroot/gallery.connectivity-before-20261010。忽略证据在相邻Show1的.local/gallery-connectivity-20261010/。回滚只恢复运行文件和Gallery，不以旧库覆盖新用户数据。
