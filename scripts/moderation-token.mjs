// Moderation tokens and mode for dots, run on the server as the service user with
// the service environment (DATA_DIR). The plaintext token is printed once and never stored.
//   node scripts/moderation-token.mjs create <label> [scopes]   new token; prints it once.
//                                                        scopes: comma separated, default moderation;
//                                                        moderation, capture:read, cover:write, works:read,
//                                                        meta:write, preview:write, captures:write
//   node scripts/moderation-token.mjs assistant-create <id> [name]  new independent admin + bind; no password output
//   node scripts/moderation-token.mjs assistant <id>         safe binding metadata
//   node scripts/moderation-token.mjs assistant-bind <id> <actor id>  explicit existing-admin binding
//   node scripts/moderation-token.mjs assistant-unbind <id>   remove binding; scopes unchanged
//   node scripts/moderation-token.mjs list               ids, labels, scopes, created/revoked/last used
//   node scripts/moderation-token.mjs grant <id> <scope>     add one scope
//   node scripts/moderation-token.mjs withdraw <id> <scope>  remove one scope (next request)
//   node scripts/moderation-token.mjs revoke <id>        the whole token, on the next request
//   node scripts/moderation-token.mjs cover-history <work id>
//   node scripts/moderation-token.mjs cover-rollback <work id> [history id]
//                                                        point the work back at its previous cover
//   node scripts/moderation-token.mjs preview-history <work id>
//   node scripts/moderation-token.mjs preview-rollback <work id> [history id]
//                                                        undo a dots preview upload (baked previews untouched)
//   node scripts/moderation-token.mjs mode [machine|dots|dots-review-only|env]
//                                                        show, or override MODERATION_MODE (env clears it)
//   node scripts/moderation-token.mjs audit [limit]      recent token requests, newest first
import { join } from 'node:path';
import { userInfo } from 'node:os';
import { config, limits } from '../server/config.mjs';
import { createAuth } from '../server/auth.mjs';
import { createDotsAdminBindings } from '../server/dots-admin.mjs';
import { openDatabase } from '../server/db.mjs';
import { MODERATION_MODES, TOKEN_SCOPES, createModerationMode, createModerationTokens } from '../server/dots-moderation.mjs';
import { createCoverStore } from '../server/work-covers.mjs';
import { createPreviewStore } from '../server/preview-uploads.mjs';

const [command, value, extra] = process.argv.slice(2);
const db = openDatabase(join(config.dataDir, 'platform.db'));
const tokens = createModerationTokens(db);
const mode = createModerationMode(db, config);
const operator = `cli:${process.env.SUDO_USER || userInfo().username}`;
const when = (ms) => (ms ? new Date(ms).toISOString() : '-');

try {
  if (command === 'create') {
    const created = tokens.create(value, operator, extra ?? 'moderation');
    process.stderr.write(`已创建 ${created.id}（${created.label}，权限 ${created.scopes.join(',')}）。下面一行是令牌明文，只显示这一次，库里只存 SHA-256：\n`);
    process.stdout.write(`${created.token}\n`);
  } else if (['assistant-create', 'assistant', 'assistant-bind', 'assistant-unbind'].includes(command)) {
    if (!value || (command === 'assistant-bind' && !extra)) throw new Error('请指定令牌 id；assistant-bind 还需账号 id');
    const auth = createAuth(db, { admins: config.admins, secureCookies: config.secureCookies, cookieSameSite: config.cookieSameSite, sessionTtl: limits.sessionTtl });
    const bindings = createDotsAdminBindings({ db, auth });
    const result = command === 'assistant-create' ? bindings.createAssistant(value, extra ?? 'dots', operator)
      : command === 'assistant-bind' ? bindings.bind(value, extra, operator)
      : command === 'assistant-unbind' ? { unbound: bindings.unbind(value, operator) } : bindings.describe(value);
    console.log(JSON.stringify({ tokenId: value, binding: result }));
  } else if (command === 'list') {
    for (const row of tokens.list()) {
      console.log([row.id, row.label, `scopes ${row.scopes.join(',') || '(none)'}`, `created ${when(row.created_at)} by ${row.created_by}`,
        row.revoked_at ? `REVOKED ${when(row.revoked_at)}` : 'active', `last used ${when(row.last_used_at)}`].join('  '));
    }
  } else if (command === 'grant' || command === 'withdraw') {
    if (!value || !extra) throw new Error(`用法：${command} <id> <${TOKEN_SCOPES.join('|')}>`);
    console.log(`${value} 现有权限：${tokens[command](value, extra).join(',') || '(none)'}`);
  } else if (command === 'cover-history' || command === 'cover-rollback') {
    const row = db.prepare('SELECT id, task_id, cover FROM works WHERE id = ? AND deleted_at IS NULL').get(String(value ?? ''));
    if (!row) throw new Error('作品不存在');
    const covers = createCoverStore({ db, library: { mediaDir: join(config.dataDir, 'media') } });
    const work = { id: row.id, taskId: row.task_id, cover: row.cover, curated: false };
    if (command === 'cover-history') {
      console.log(`当前封面：${row.cover ?? '(无)'}`);
      for (const entry of covers.history(work)) console.log([entry.id, entry.at, entry.action, `${entry.previous ?? '(无)'} -> ${entry.next ?? '(无)'}`, entry.actor].join('  '));
    } else {
      console.log(JSON.stringify(covers.rollback(work, extra ?? null, { id: operator, name: operator })));
      console.log('已回滚；服务进程按数据库版本号发现这次写入，bootstrap / catalog 缓存下一次请求即重建');
    }
  } else if (command === 'preview-history' || command === 'preview-rollback') {
    const row = db.prepare('SELECT id, task_id, cover FROM works WHERE id = ? AND deleted_at IS NULL').get(String(value ?? ''));
    if (!row) throw new Error('作品不存在');
    const previews = createPreviewStore({ db, library: { mediaDir: join(config.dataDir, 'media') } });
    const work = { id: row.id, taskId: row.task_id, cover: row.cover, curated: false };
    if (command === 'preview-history') {
      const now = previews.current(work);
      console.log(`当前预览：${now.kind === 'none' ? '(无)' : now.kind === 'foreign' ? '人工/烘焙预览（不归 dots 管）' : now.version}`);
      for (const entry of previews.history(work)) console.log([entry.id, entry.at, entry.action, `${entry.previous ?? '(无)'} -> ${entry.next ?? '(无)'}`, entry.actor].join('  '));
    } else {
      console.log(JSON.stringify(previews.rollback(work, extra ?? null, { id: operator, name: operator })));
    }
  } else if (command === 'revoke') {
    if (!value) throw new Error('用法：revoke <id>');
    console.log(tokens.revoke(value) ? `已吊销 ${value}` : `${value} 不存在或早已吊销`);
  } else if (command === 'mode') {
    if (value) mode.set(value === 'env' ? null : value, operator);
    console.log(JSON.stringify(mode.describe(), null, 2));
  } else if (command === 'audit') {
    const limit = Math.min(1000, Math.max(1, Number(value) || 50));
    for (const row of db.prepare('SELECT * FROM moderation_token_audit ORDER BY id DESC LIMIT ?').all(limit)) {
      console.log([when(row.at), row.token_id, row.token_label, row.action, row.task_id ?? '-', row.work_id ?? '-', row.outcome, row.ip ?? '-', row.reason ?? ''].join('  '));
    }
  } else {
    console.log(`用法：node scripts/moderation-token.mjs create <label> [${TOKEN_SCOPES.join(',')}] | assistant-create <id> [name] | assistant <id> | assistant-bind <id> <actor-id> | assistant-unbind <id> | list | grant <id> <scope> | withdraw <id> <scope> | revoke <id> | mode [${MODERATION_MODES.join('|')}|env] | audit [limit] | cover-history <work id> | cover-rollback <work id> [history id] | preview-history <work id> | preview-rollback <work id> [history id]`);
    process.exitCode = command ? 1 : 0;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  db.close();
}
