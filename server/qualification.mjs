import { randomBytes, randomInt } from 'node:crypto';
import { transaction } from './db.mjs';
import { fail, HttpError } from './http.mjs';
import { levelOf, isSenior } from './roles.mjs';

const id = () => randomBytes(12).toString('hex');
const token = () => `e${randomBytes(16).toString('hex')}`;
const iso = ms => ms == null ? null : new Date(ms).toISOString();
const TICKET_MS = 3 * 3600e3;
export function createQualification({ db, catalog, library, auth }) {
  const settings = () => db.prepare('SELECT * FROM qualification_settings WHERE id=1').get();
  const pairs = () => db.prepare('SELECT * FROM qualification_pairs ORDER BY created_at,id').all();
  const items = attemptId => db.prepare('SELECT * FROM qualification_attempt_items WHERE attempt_id=? ORDER BY position').all(attemptId);
  const digest = work => work.curated ? catalog.snapshot().entryDigest(work) : work.digest;
  function snapshot(work) {
    return JSON.stringify({ taskId: work.taskId, id: work.id, digest: digest(work), root: catalog.snapshot().root,
      promptVariant: work.promptVariant ?? '', calibration: library.calibrationOf?.(work, 'arena')?.framing ?? null });
  }
  function resolve(saved) {
    const s = JSON.parse(saved), current = library.work(s.taskId, s.id);
    if (!library.isEligible(current)) return null;
    try {
      const archive = catalog.at(s.root), work = library.work(s.taskId, s.id, archive);
      if (work && (work.curated ? archive.entryDigest(work) : work.digest) === s.digest) return work;
    } catch { /* An old package can be pruned; identical current content is enough. */ }
    return digest(current) === s.digest ? current : null;
  }
  const available = pair => Boolean(resolve(pair.a_snapshot_json) && resolve(pair.b_snapshot_json));
  const pairDto = pair => ({ id: pair.id, version: pair.version, taskId: pair.task_id,
    aWorkId: pair.a_work, bWorkId: pair.b_work, correctAnswer: pair.correct_answer,
    explanation: pair.explanation, enabled: Boolean(pair.enabled), available: available(pair),
    ...(!available(pair) ? { unavailableReason: '标准对内容已不可用，请重新选择作品' } : {}) });
  const settingsDto = s => ({ version: s.version, questionCount: s.question_count, passPercent: s.pass_percent });
  const audit = (actor, action, detail) => db.prepare('INSERT INTO audit(at,actor_id,actor_name,action,detail) VALUES (?,?,?,?,?)')
    .run(Date.now(), actor.id, actor.name, action, JSON.stringify(detail));
  const staff = actor => { if (!isSenior(actor)) fail(403, '仅高级管理员可以操作'); };
  const own = (user, attemptId, active = false) => {
    const row = db.prepare('SELECT * FROM qualification_attempts WHERE id=? AND user_id=?').get(attemptId, user.id);
    if (!row) fail(404, '考试记录不存在');
    if (active && row.status !== 'active') fail(409, '本次考试已经结束');
    return row;
  };
  const ownItem = (user, attemptId, itemId) => {
    own(user, attemptId, true);
    const row = db.prepare('SELECT * FROM qualification_attempt_items WHERE id=? AND attempt_id=?').get(itemId, attemptId);
    if (!row) fail(404, '考试题目不存在');
    if (!resolve(row.a_snapshot_json) || !resolve(row.b_snapshot_json)) fail(409, '考试作品已不可用，可以重新开始', 'exam_item_unavailable');
    return row;
  };
  const result = row => ({ attemptId: row.id, status: row.status, correctCount: row.correct_count,
    questionCount: row.question_count, scorePercent: row.correct_count == null ? null : row.correct_count / row.question_count * 100,
    passPercent: row.pass_percent, correctRequired: row.correct_required, passCorrect: row.correct_required,
    passed: Boolean(row.passed), finishedAt: iso(row.finished_at) });
  function get(user, attemptId) {
    const row = own(user, attemptId), rows = items(row.id);
    const base = { id: row.id, status: row.status, startedAt: iso(row.started_at), questionCount: row.question_count,
      passPercent: row.pass_percent, correctRequired: row.correct_required, passCorrect: row.correct_required,
      answeredCount: rows.filter(i => i.answer != null).length };
    if (row.status !== 'active') return { attempt: { ...base, result: result(row), items: [] } };
    for (const item of rows) {
      if (!resolve(item.a_snapshot_json) || !resolve(item.b_snapshot_json)) fail(409, '考试作品已不可用，可以重新开始', 'exam_item_unavailable');
      if (item.token_expires_at <= Date.now()) {
        item.a_token = token(); item.b_token = token(); item.token_expires_at = Date.now() + TICKET_MS;
        db.prepare('UPDATE qualification_attempt_items SET a_token=?,b_token=?,token_expires_at=? WHERE id=?')
          .run(item.a_token, item.b_token, item.token_expires_at, item.id);
      }
    }
    return { attempt: { ...base, items: rows.map(i => ({ id: i.id, position: i.position, question: JSON.parse(i.question_json),
      a: `${library.originOf(i.a_token)}/`, b: `${library.originOf(i.b_token)}/`,
      calibration: { a: JSON.parse(i.a_snapshot_json).calibration, b: JSON.parse(i.b_snapshot_json).calibration },
      readyAt: iso(i.ready_at), answerAllowedAt: iso(i.ready_at == null ? null : i.ready_at + 5000), answer: i.answer })) } };
  }
  function pairInput(body, previous = null) {
    const taskId = body.taskId ?? previous?.task_id;
    const aId = body.aWorkId ?? previous?.a_work, bId = body.bWorkId ?? previous?.b_work;
    const correct = body.correctAnswer ?? previous?.correct_answer;
    const task = typeof taskId === 'string' ? catalog.task(taskId) : null;
    const a = task && typeof aId === 'string' ? library.work(taskId, aId) : null;
    const b = task && typeof bId === 'string' ? library.work(taskId, bId) : null;
    if (!task || !a || !b || aId === bId || !library.isEligible(a) || !library.isEligible(b) ||
      (a.promptVariant ?? '') !== (b.promptVariant ?? '') || !['a','b'].includes(correct)) fail(400, '请选择同题同提示词版本的两件可评作品及正确答案');
    const duplicate = db.prepare('SELECT id FROM qualification_pairs WHERE task_id=? AND ((a_work=? AND b_work=?) OR (a_work=? AND b_work=?)) AND id<>?')
      .get(taskId, aId, bId, bId, aId, previous?.id ?? '');
    if (duplicate) fail(409, '该作品组合已是标准对，请编辑原记录');
    const explanation = body.explanation ?? previous?.explanation ?? '';
    const enabled = body.enabled ?? Boolean(previous?.enabled ?? true);
    if (typeof explanation !== 'string' || explanation.length > 2000 || typeof enabled !== 'boolean') fail(400, '标准对说明或启用状态无效');
    return { taskId, aId, bId, correct, a: snapshot(a), b: snapshot(b), explanation, enabled: Number(enabled) };
  }
  return {
    get,
    progress(user) {
      if (!user) return null;
      const row = db.prepare(`SELECT a.question_count,COUNT(i.answer) AS answered FROM qualification_attempts a
        JOIN qualification_attempt_items i ON i.attempt_id=a.id WHERE a.user_id=? AND a.status='active' GROUP BY a.id`).get(user.id);
      return row ? { activeAnswered: row.answered, questionCount: row.question_count } : null;
    },
    summaries() {
      const summaries = new Map();
      for (const row of db.prepare("SELECT user_id,correct_count,question_count,passed,finished_at FROM qualification_attempts WHERE status='completed' ORDER BY finished_at").all()) {
        const s = summaries.get(row.user_id) ?? { passedAt: null, attempts: 0, bestCorrect: null, questionCount: null };
        s.attempts++;
        if (row.passed) s.passedAt = iso(row.finished_at);
        if (s.bestCorrect == null || row.correct_count * s.questionCount >= s.bestCorrect * row.question_count) {
          s.bestCorrect = row.correct_count; s.questionCount = row.question_count;
        }
        summaries.set(row.user_id, s);
      }
      return summaries;
    },
    overview(user) {
      const s = settings(), count = pairs().filter(p => p.enabled && available(p)).length;
      const active = db.prepare("SELECT id FROM qualification_attempts WHERE user_id=? AND status='active'").get(user.id);
      const last = db.prepare("SELECT * FROM qualification_attempts WHERE user_id=? AND status='completed' ORDER BY finished_at DESC LIMIT 1").get(user.id);
      const required = Math.ceil(s.question_count * s.pass_percent / 100);
      return { level: levelOf(user), eligible: levelOf(user) === 0,
        exam: { ...settingsDto(s), kind: 'standard-pair', correctRequired: required, passCorrect: required,
          unlimitedAttempts: true, timeLimitSeconds: null, availablePairCount: count, ready: count >= s.question_count },
        activeAttemptId: active?.id ?? null, lastResult: last ? result(last) : null };
    },
    start(user, body = {}) {
      if (levelOf(user) !== 0) fail(409, '你已具备认证成员资格');
      let active = db.prepare("SELECT id FROM qualification_attempts WHERE user_id=? AND status='active'").get(user.id);
      if (active && body.restart !== true) return get(user, active.id);
      const s = settings(), pool = pairs().filter(p => p.enabled && available(p));
      if (pool.length < s.question_count) {
        const error = new HttpError(409, '资格考试题库尚未就绪', 'exam_not_ready');
        error.details = { availablePairCount: pool.length }; throw error;
      }
      for (let i = pool.length - 1; i > 0; i--) { const j = randomInt(i + 1); [pool[i],pool[j]] = [pool[j],pool[i]]; }
      const attemptId = id(), now = Date.now();
      transaction(db, () => {
        active = db.prepare("SELECT id FROM qualification_attempts WHERE user_id=? AND status='active'").get(user.id);
        if (active) db.prepare("UPDATE qualification_attempts SET status='abandoned',finished_at=? WHERE id=?").run(now, active.id);
        db.prepare(`INSERT INTO qualification_attempts(id,user_id,settings_version,question_count,pass_percent,correct_required,status,started_at)
          VALUES (?,?,?,?,?,?,'active',?)`).run(attemptId, user.id, s.version, s.question_count, s.pass_percent, Math.ceil(s.question_count * s.pass_percent / 100), now);
        const add = db.prepare(`INSERT INTO qualification_attempt_items(id,attempt_id,position,pair_id,pair_version,question_json,
          a_snapshot_json,b_snapshot_json,correct_answer,a_token,b_token,token_expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
        pool.slice(0, s.question_count).forEach((p, i) => {
          const swap = randomInt(2) === 1, task = catalog.task(p.task_id);
          const variant = JSON.parse(p.a_snapshot_json).promptVariant;
          const prompt = task.promptVariants?.find(v => v.id === variant)?.prompt ?? task.prompt ?? '';
          add.run(id(), attemptId, i + 1, p.id, p.version, JSON.stringify({ title: task.title, prompt }),
            swap ? p.b_snapshot_json : p.a_snapshot_json, swap ? p.a_snapshot_json : p.b_snapshot_json,
            swap ? p.correct_answer === 'a' ? 'b' : 'a' : p.correct_answer, token(), token(), now + TICKET_MS);
        });
      });
      return get(user, attemptId);
    },
    ready(user, attemptId, itemId) {
      const item = ownItem(user, attemptId, itemId);
      const at = item.ready_at ?? Date.now();
      db.prepare('UPDATE qualification_attempt_items SET ready_at=COALESCE(ready_at,?) WHERE id=?').run(at, item.id);
      return { readyAt: iso(at), answerAllowedAt: iso(at + 5000), serverNow: iso(Date.now()) };
    },
    answer(user, attemptId, itemId, choice) {
      const item = ownItem(user, attemptId, itemId);
      if (!['a','b'].includes(choice)) fail(400, '请选择A或B');
      if (item.ready_at == null || Date.now() < item.ready_at + 5000) {
        const error = new HttpError(409, '请等待两侧载入并观看五秒', 'answer_too_early');
        error.details = { answerAllowedAt: iso(item.ready_at == null ? null : item.ready_at + 5000), serverNow: iso(Date.now()) }; throw error;
      }
      db.prepare('UPDATE qualification_attempt_items SET answer=?,answered_at=? WHERE id=?').run(choice, Date.now(), item.id);
      return { itemId, answer: choice, answeredCount: items(attemptId).filter(i => i.answer != null).length, questionCount: own(user, attemptId).question_count };
    },
    submit(user, attemptId) {
      return transaction(db, () => {
        let attempt = own(user, attemptId);
        if (attempt.status === 'abandoned') fail(409, '本次考试已放弃');
        if (attempt.status === 'active') {
          const rows = items(attemptId), answered = rows.filter(i => i.answer != null).length;
          if (answered !== attempt.question_count) {
            const error = new HttpError(409, '请完成全部题目再交卷', 'exam_incomplete'); error.details = { answeredCount: answered }; throw error;
          }
          const correct = rows.filter(i => i.answer === i.correct_answer).length, passed = correct >= attempt.correct_required, now = Date.now();
          db.prepare("UPDATE qualification_attempts SET status='completed',finished_at=?,correct_count=?,passed=? WHERE id=?")
            .run(now, correct, Number(passed), attemptId);
          if (passed && db.prepare("UPDATE users SET member_level=1,level_since=?,level_source='exam' WHERE id=? AND role='user' AND member_level=0").run(now, user.id).changes)
            audit(user, 'qualification-promote', { attemptId, correctCount: correct, questionCount: attempt.question_count });
          attempt = own(user, attemptId);
        }
        return { ...result(attempt), user: auth.public(db.prepare('SELECT * FROM users WHERE id=?').get(user.id)) };
      });
    },
    workForToken(key) {
      const item = db.prepare(`SELECT i.* FROM qualification_attempt_items i JOIN qualification_attempts a ON a.id=i.attempt_id
        WHERE (i.a_token=? OR i.b_token=?) AND i.token_expires_at>? AND a.status='active'`).get(key, key, Date.now());
      return item ? resolve(item.a_token === key ? item.a_snapshot_json : item.b_snapshot_json) : null;
    },
    adminInfo(actor) { staff(actor); return { settings: settingsDto(settings()), pairs: pairs().map(pairDto) }; },
    works(actor, taskId) { staff(actor); return { works: library.eligible(taskId).map(w => ({ id: w.id, title: w.title,
      modelName: w.modelName, promptVariant: w.promptVariant ?? '', preview: `${library.previewOrigin(w)}/` })) }; },
    saveSettings(actor, body) {
      staff(actor);
      return transaction(db, () => {
        if (body.version !== settings().version) fail(409, '考试配置已更新', 'exam_revision_conflict');
        if (!Number.isInteger(body.questionCount) || body.questionCount < 1 || body.questionCount > 100 || !Number.isInteger(body.passPercent) || body.passPercent < 1 || body.passPercent > 100) fail(400, '题数或及格率无效');
        db.prepare('UPDATE qualification_settings SET version=version+1,question_count=?,pass_percent=?,updated_by=?,updated_at=? WHERE id=1')
          .run(body.questionCount, body.passPercent, actor.id, Date.now());
        audit(actor, 'qualification-settings', body); return { settings: settingsDto(settings()) };
      });
    },
    savePair(actor, body, pairId = null) {
      staff(actor);
      return transaction(db, () => {
        const previous = pairId ? db.prepare('SELECT * FROM qualification_pairs WHERE id=?').get(pairId) : null;
        if (pairId && !previous) fail(404, '标准对不存在');
        if (previous && body.version !== previous.version) fail(409, '标准对已更新', 'exam_revision_conflict');
        const v = pairInput(body, previous), now = Date.now(), key = pairId ?? id();
        if (previous) db.prepare(`UPDATE qualification_pairs SET task_id=?,a_work=?,b_work=?,a_snapshot_json=?,b_snapshot_json=?,correct_answer=?,
          explanation=?,enabled=?,version=version+1,updated_by=?,updated_at=? WHERE id=?`)
          .run(v.taskId, v.aId, v.bId, v.a, v.b, v.correct, v.explanation, v.enabled, actor.id, now, key);
        else db.prepare('INSERT INTO qualification_pairs VALUES (?,?,?,?,?,?,?,?,?,1,?,?,?,?)')
          .run(key, v.taskId, v.aId, v.bId, v.a, v.b, v.correct, v.explanation, v.enabled, actor.id, now, actor.id, now);
        audit(actor, previous ? 'qualification-pair-edit' : 'qualification-pair-create', { pairId: key, ...body });
        return { pair: pairDto(db.prepare('SELECT * FROM qualification_pairs WHERE id=?').get(key)) };
      });
    },
    deletePair(actor, pairId, body) {
      staff(actor);
      return transaction(db, () => {
        const pair = db.prepare('SELECT * FROM qualification_pairs WHERE id=?').get(pairId);
        if (!pair) fail(404, '标准对不存在');
        if (body.version !== pair.version) fail(409, '标准对已更新', 'exam_revision_conflict');
        db.prepare('UPDATE qualification_pairs SET enabled=0,version=version+1,updated_by=?,updated_at=? WHERE id=?').run(actor.id, Date.now(), pairId);
        audit(actor, 'qualification-pair-disable', { pairId }); return { ok: true };
      });
    },
  };
}
