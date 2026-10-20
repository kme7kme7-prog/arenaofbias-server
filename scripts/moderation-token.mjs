// Moderation tokens and mode for dots, run on the server as the service user with
// the service environment (DATA_DIR). The plaintext token is printed once and never stored.
//   node scripts/moderation-token.mjs create <label>     new token; prints it once
//   node scripts/moderation-token.mjs list               ids, labels, created/revoked/last used
//   node scripts/moderation-token.mjs revoke <id>        takes effect on the next request
//   node scripts/moderation-token.mjs mode [machine|dots|dots-review-only|env]
//                                                        show, or override MODERATION_MODE (env clears it)
//   node scripts/moderation-token.mjs audit [limit]      recent token requests, newest first
import { join } from 'node:path';
import { userInfo } from 'node:os';
import { config } from '../server/config.mjs';
import { openDatabase } from '../server/db.mjs';
import { MODERATION_MODES, createModerationMode, createModerationTokens } from '../server/dots-moderation.mjs';

const [command, value] = process.argv.slice(2);
const db = openDatabase(join(config.dataDir, 'platform.db'));
const tokens = createModerationTokens(db);
const mode = createModerationMode(db, config);
const operator = `cli:${process.env.SUDO_USER || userInfo().username}`;
const when = (ms) => (ms ? new Date(ms).toISOString() : '-');

try {
  if (command === 'create') {
    const created = tokens.create(value, operator);
    process.stderr.write(`已创建 ${created.id}（${created.label}）。下面一行是令牌明文，只显示这一次，库里只存 SHA-256：\n`);
    process.stdout.write(`${created.token}\n`);
  } else if (command === 'list') {
    for (const row of tokens.list()) {
      console.log([row.id, row.label, `created ${when(row.created_at)} by ${row.created_by}`,
        row.revoked_at ? `REVOKED ${when(row.revoked_at)}` : 'active', `last used ${when(row.last_used_at)}`].join('  '));
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
    console.log(`用法：node scripts/moderation-token.mjs create <label> | list | revoke <id> | mode [${MODERATION_MODES.join('|')}|env] | audit [limit]`);
    process.exitCode = command ? 1 : 0;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  db.close();
}
