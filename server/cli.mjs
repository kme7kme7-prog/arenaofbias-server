// Account administration from the terminal.
//   npm run admin -- <username>          grant the admin role
//   npm run admin -- <username> --role moderator  assign one of three roles
//   npm run admin -- <username> --revoke  back to a regular user
//   npm run admin -- --create <username>  create an admin with a hidden password prompt
//   npm run admin -- --list               list accounts
// Restricted (gray) models, visible to senior admins only:
//   npm run admin -- restricted-model add <code> [--label <text>] [--force]   register x:<code> (refuses registered model
//     names; refuses when works already use the name unless --force)
//   npm run admin -- restricted-model remove <code>                  make it an ordinary public model key again
//   npm run admin -- restricted-model list
//   npm run admin -- restricted-model check <code>                   read-only: existing works and ballots that match the code
//   npm run admin -- restricted-import --task <taskId> --model <code> --effort <effort> --owner <senior name or id>
//     --dir <work directory, ZIP, HTML or text file> [--title ..] [--summary ..] [--prompt-variant ..] [--template static|vite|text]
//     [--provider official|unofficial] [--harness <id>] [--dry-run]
//   prints the new work id; the running server notices the commit through SQLite's data_version.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import { crc32 } from 'node:zlib';
import { createAuth } from './auth.mjs';
import { createCatalog, modelNameKey } from './catalog.mjs';
import { config, limits } from './config.mjs';
import { createLibrary } from './library.mjs';
import { createQuestions } from './questions.mjs';
import { catalogConflict, createRestricted, restrictedKeyOf, workModelKey } from './restricted.mjs';
import { levelOf } from './roles.mjs';
import { openDatabase } from './db.mjs';

const args = process.argv.slice(2);
const roleLabels = { admin: '高级管理员', moderator: '普通管理员', user: '普通用户' };
const db = openDatabase(join(config.dataDir, 'platform.db'));
async function passwordFromStdin() {
  if (!process.stdin.isTTY) {
    let value = '';
    for await (const chunk of process.stdin) value += chunk;
    return value.replace(/\r?\n$/, '');
  }
  process.stdout.write('密码：');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  try {
    return await new Promise((resolve, reject) => {
      let value = '';
      const onData = (chunk) => {
        for (const char of chunk.toString('utf8')) {
          if (char === '\r' || char === '\n') {
            process.stdin.off('data', onData);
            process.stdout.write('\n');
            resolve(value);
            return;
          }
          if (char === '\u0003') {
            process.stdin.off('data', onData);
            reject(new Error('已取消'));
            return;
          }
          if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
          else value += char;
        }
      };
      process.stdin.on('data', onData);
    });
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}

// A stored (uncompressed) ZIP of a directory, so imports go through the upload inspector unchanged.
function zipDirectory(root) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push([relative(root, path).split(sep).join('/'), readFileSync(path)]);
    }
  };
  walk(root);
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, data] of files) {
    const path = Buffer.from(name), crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(path.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(path.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, path, data);
    centrals.push(central, path);
    offset += 30 + path.length + data.length;
  }
  const directory = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function options(list, allowed, flags = []) {
  const result = {};
  for (let i = 0; i < list.length; i++) {
    const name = list[i].replace(/^--/, '');
    if (!list[i].startsWith('--') || (!allowed.includes(name) && !flags.includes(name))) throw new Error(`未知参数：${list[i]}`);
    if (flags.includes(name)) result[name] = true;
    else if (i + 1 >= list.length) throw new Error(`${list[i]} 缺少取值`);
    else result[name] = list[++i];
  }
  return result;
}

// Read-only survey: works stored under this key or a name that compacts the same way, and their ballots.
function survey(key, code) {
  const compact = modelNameKey(key.slice(2));
  const works = db.prepare('SELECT id, task_id, owner_id, status, deleted_at, model_id, model_other, created_at FROM works ORDER BY created_at').all()
    .filter((work) => workModelKey(work) === key || (compact && (modelNameKey(work.model_other ?? '') === compact || modelNameKey(work.model_id ?? '') === compact)));
  const ids = new Set(works.map((work) => work.id));
  const votes = ids.size ? db.prepare('SELECT a_work, b_work FROM votes').all().filter((vote) => ids.has(vote.a_work) || ids.has(vote.b_work)).length : 0;
  return { key, registered: createRestricted(db).hasKey(key), conflictsWithCatalog: catalogConflict(createCatalog(config.dist), code),
    works: works.length, liveWorks: works.filter((work) => !work.deleted_at).length, votes,
    list: works.map((work) => ({ id: work.id, task: work.task_id, owner: work.owner_id, status: work.status, deleted: Boolean(work.deleted_at),
      modelId: work.model_id, modelName: work.model_other, createdAt: new Date(work.created_at).toISOString() })) };
}

function restrictedModel(rest) {
  const restricted = createRestricted(db);
  const [action, code, ...more] = rest;
  if (action === 'list' && !code) {
    const rows = restricted.list();
    if (!rows.length) console.log('还没有登记灰度模型。');
    for (const row of rows) console.log(`${row.model_key}\t${row.label}\t${new Date(row.created_at).toLocaleString('zh-CN')}\t${row.created_by}`);
    return;
  }
  if (!['add', 'remove', 'check'].includes(action) || !code) throw new Error('用法：npm run admin -- restricted-model add|remove|check <代号> [--label <说明>] | list');
  const key = restrictedKeyOf(code);
  if (key === 'x:') throw new Error('代号不能为空');
  if (action === 'check') {
    if (more.length) throw new Error('check 不接受其他参数');
    console.log(JSON.stringify(survey(key, code), null, 2));
    return;
  }
  if (action === 'remove') {
    if (more.length) throw new Error('remove 不接受其他参数');
    console.log(restricted.remove(key) ? `已取消 ${key} 的灰度限制，它的作品将按普通作品公开。` : `${key} 不在灰度登记中。`);
    return;
  }
  // The label doubles as the display spelling ("Mix" for x:mix) when it is the code itself.
  const { label = String(code).normalize('NFKC').trim().replace(/^x:/i, ''), force = false } = options(more, ['label'], ['force']);
  if (catalogConflict(createCatalog(config.dist), code)) throw new Error(`代号 ${key.slice(2)} 与已登记的公开模型重名，请换一个代号。`);
  if ([...createRestricted(db).keys()].some((other) => other !== key && modelNameKey(other.slice(2)) === modelNameKey(key.slice(2)))) throw new Error(`代号 ${key.slice(2)} 与已登记的灰度模型重名。`);
  if (restricted.hasKey(key)) throw new Error(`${key} 已经登记。`);
  // Registering hides works already stored under the key; any match needs an explicit --force.
  const found = survey(key, code);
  if (found.works && !force) {
    console.error(JSON.stringify({ ...found, list: found.list.slice(0, 20) }, null, 2));
    throw new Error(`已有 ${found.works} 件作品（其中 ${found.liveWorks} 件未删除、相关 ${found.votes} 票）的模型名与 ${key.slice(2)} 相同或规范化后相同。确认后加 --force 再登记。`);
  }
  restricted.add(key, label, 'cli');
  console.log(`已登记灰度模型 ${key}：只有高级管理员能看到它的作品。`);
}

function restrictedImport(rest) {
  const o = options(rest, ['task', 'model', 'effort', 'owner', 'dir', 'title', 'summary', 'prompt-variant', 'template', 'provider', 'harness'], ['dry-run']);
  for (const name of ['task', 'model', 'effort', 'owner', 'dir']) if (!o[name]) throw new Error(`缺少 --${name}`);
  const auth = createAuth(db, { admins: config.admins, secureCookies: false, sessionTtl: limits.sessionTtl });
  const row = db.prepare('SELECT id FROM users WHERE id = ? OR name = ?').get(o.owner, o.owner);
  const owner = row && auth.byId(row.id);
  if (!owner) throw new Error(`找不到用户「${o.owner}」。`);
  const questions = createQuestions(db);
  const catalog = createCatalog(config.dist, questions);
  const library = createLibrary({ db, catalog, config, limits, restricted: createRestricted(db), maintenance: false });
  const path = resolve(o.dir);
  const directory = statSync(path).isDirectory();
  const result = catalog.withSnapshot(() => library.importRestricted(owner, {
    taskId: o.task, code: o.model, effort: o.effort, title: o.title, summary: o.summary, promptVariant: o['prompt-variant'] ?? '',
    template: o.template ?? null, providerId: o.provider ?? 'official', harnessId: o.harness ?? null,
    // The stored source name never carries the local directory or file name.
    filename: directory ? 'import.zip' : `import${extname(path).toLowerCase()}`, buffer: directory ? zipDirectory(path) : readFileSync(path),
  }, { dryRun: Boolean(o['dry-run']) }));
  if (result.duplicateOf) console.warn(`注意：内容与已有作品 ${result.duplicateOf} 相同。`);
  console.log(JSON.stringify(result, null, 2));
  if (!result.dryRun) console.log(result.id);
}

try {
  if (args[0] === 'restricted-model') restrictedModel(args.slice(1));
  else if (args[0] === 'restricted-import') restrictedImport(args.slice(1));
  else if (args.includes('--create')) {
    if (args.length !== 2 || args[0] !== '--create') throw new Error('用法：npm run admin -- --create <用户名>（密码从标准输入读取）');
    const auth = createAuth(db, { admins: config.admins, secureCookies: false, sessionTtl: limits.sessionTtl });
    const user = auth.createAdmin(args[1], await passwordFromStdin());
    console.log(`已创建管理员「${user.name}」。`);
  } else if (args.includes('--list') || !args.length) {
    const users = db.prepare('SELECT name, role, member_level, created_at FROM users ORDER BY created_at').all();
    if (!users.length) console.log('还没有账号。运行 npm run admin -- --create <用户名> 创建管理员。');
    for (const user of users) console.log(`Lv${levelOf(user)} ${roleLabels[user.role] ?? roleLabels.user}\t${user.name}\t${new Date(user.created_at).toLocaleString('zh-CN')}`);
  } else {
    const name = args[0];
    let role = 'admin';
    if (args.length === 2 && args[1] === '--revoke') role = 'user';
    else if (args.length === 3 && args[1] === '--level' && /^[0-3]$/.test(args[2])) role = Number(args[2]);
    else if (args.length === 3 && args[1] === '--role' && Object.hasOwn(roleLabels, args[2])) role = args[2];
    else if (args.length !== 1 || !name || name.startsWith('--')) throw new Error('用法：npm run admin -- <用户名> [--revoke | --level 0|1|2|3 | --role admin|moderator|user]');
  const auth = createAuth(db, { admins: config.admins, secureCookies: false, sessionTtl: limits.sessionTtl });
  const user = auth.promote(name, role);
  if (!user) {
    console.error(`找不到用户「${name}」。`);
    process.exitCode = 1;
  } else {
    console.log(`${user.name} 现在是Lv${levelOf(user)} ${roleLabels[user.role]}。`);
  }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  db.close();
}
