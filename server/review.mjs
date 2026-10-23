// Request-local indexes for Gallery management. Role checks remain in the routes;
// no result is retained across requests or moderation/role changes.
import { fail } from './http.mjs';
import { isSenior } from './roles.mjs';

const invalid = () => fail(400, '列表参数无效', 'invalid_query');
export function listQuery(query, allowed) {
  for (const key of query.keys()) if (!allowed.includes(key) || query.getAll(key).length !== 1) invalid();
  const number = (key, fallback, max) => {
    if (!query.has(key)) return fallback;
    const text = query.get(key);
    if (!/^[1-9]\d*$/.test(text) || Number(text) > max) invalid();
    return Number(text);
  };
  const choice = (key, values, fallback = values[0]) => {
    const value = query.get(key) ?? fallback;
    if (!values.includes(value)) invalid();
    return value;
  };
  for (const key of ['q', 'task', 'category', 'domain']) {
    const value = query.get(key);
    if (value !== null && (value.length > (key === 'q' ? 200 : 128) || /[\x00-\x1f\x7f]/.test(value))) invalid();
  }
  return { number, choice, page: number('page', 1, 100000), pageSize: number('pageSize', 50, 100), q: (query.get('q') ?? '').trim().toLowerCase() };
}
const waiting = q => ['pending', 'review'].includes(q.moderation?.status);
const shown = q => ['legacy', 'approved'].includes(q.moderation?.status ?? 'legacy');
const fold = value => String(value ?? '').toLowerCase().replace(/[\s.\-_]/g, '');
const wordsIn = (query, value) => query.split(/\s+/).filter(Boolean).every(word => value.toLowerCase().includes(word));
const slice = (rows, page, pageSize) => rows.slice((page - 1) * pageSize, page * pageSize);
const time = row => row.createdAt == null ? Date.parse(row.addedAt ?? row.date ?? '') || 0 : Number(row.createdAt) || Date.parse(row.createdAt) || 0;
const titleSort = (a, b) => a.title.localeCompare(b.title, 'zh-CN', { numeric: true });
const roleNames = { admin: '高级管理员', moderator: '普通管理员' };
const categoryNames = { 文学: '写作 Writing', 推理: '推理 Reasoning', 静态网页: '设计 Design', 建模: '三维 3D' };
const domainNames = { 数学: 'Mathematics', 物理: 'Physics', 化学: 'Chemistry', 生物: 'Biology', 天文: 'Astronomy', 计算机技术: 'Computing', 工程技术: 'Engineering', 医学健康: 'Health & medicine', 地理环境: 'Geography & environment',
  文学艺术: 'Literature & arts', 哲学: 'Philosophy', 历史文化: 'History & culture', 教育学习: 'Education & learning', 经济金融: 'Economics & finance', 商业管理: 'Business & management', 法律政务: 'Law & government', 社会生活: 'Society',
  建筑: 'Architecture', 自然景观: 'Nature & landscapes', 交通与机械: 'Transport & machinery', 产品与品牌: 'Products & brands', 游戏娱乐: 'Games & entertainment', 生活服务: 'Everyday services', 餐饮美食: 'Food & dining', 旅游出行: 'Travel', 运动体育: 'Sports' };

function classify(viewer, questions, publicIds, works, logCount) {
  const questionById = new Map(questions.map(q => [q.id, q]));
  const buckets = new Map(works.map(work => {
    let bucket;
    if (isSenior(viewer) && questionById.get(work.taskId)?.moderation?.status === 'rejected') bucket = 'rejected';
    else if (work.moderation?.status === 'review') bucket = 'content';
    else if (work.moderation?.status === 'pending') bucket = 'auto';
    else if (work.moderation?.status === 'rejected') bucket = 'rejected';
    else if (!publicIds.has(work.taskId)) bucket = questionById.has(work.taskId) || !isSenior(viewer) ? 'sample' : 'rejected';
    else if (work.status === 'questioned') bucket = 'questioned';
    else if (work.curated ? work.status === 'unverified' : !work.reviewedGalleryAt) bucket = 'unverified';
    else if (work.status === 'verified' && (work.showGallery || work.showArena)) bucket = 'verified';
    else bucket = 'off';
    return [work, bucket];
  }));
  const counts = { questions: isSenior(viewer) ? questions.filter(waiting).length : 0, content: 0, auto: 0, unverified: 0, done: 0,
    catalog: isSenior(viewer) ? questions.length : 0, works: works.length, log: logCount };
  for (const value of buckets.values()) {
    if (['content', 'auto', 'unverified'].includes(value)) counts[value]++;
    if (['verified', 'off', 'questioned', 'rejected'].includes(value)) counts.done++;
  }
  return { questionById, buckets, counts };
}

export function createReview({ catalog, library, questions, adminService, auth, qualification }) {
  const publisher = item => item.author?.role === 'user' ? item.author.name ?? '已注销的用户'
    : `${item.author?.name ?? catalog.snapshot().title} · ${roleNames[item.author?.role ?? 'admin']}`;
  function index(viewer) {
    const allQuestions = isSenior(viewer) ? questions.adminIndex(viewer) : catalog.tasks();
    const publicIds = new Set(catalog.tasks().filter(q => !q.tags?.includes('arena-only')).map(q => q.id));
    const works = library.allWorks({ viewer });
    const { questionById, buckets, counts } = classify(viewer, allQuestions, publicIds, works, library.auditLog(200, viewer).length);
    const thin = work => {
      const dto = library.adminWork(work, viewer, { preview: false });
      for (const key of ['checks', 'trial', 'sourceName', 'root', 'entry', 'summary', 'note', 'calibration', 'calibration_gallery', 'calibration_arena']) delete dto[key];
      return { ...dto, bucket: buckets.get(work) };
    };
    return { allQuestions, questionById, publicIds, works, buckets, counts, thin };
  }
  function questionDetail(id, viewer, current = null) {
    const question = questions.adminGet(id, viewer) ?? fail(404, '题目不存在', 'not_found');
    const data = current ?? index(viewer);
    const works = data.works.filter(w => w.taskId === id).map(data.thin);
    const sampleIds = new Set(question.samples.map(w => w.id));
    const { ownerId, ...dto } = question;
    return { question: { ...dto, samples: works.filter(w => sampleIds.has(w.id)) }, works, ...(current ? {} : { audit: library.auditFor(id, null, viewer) }) };
  }
  function navigation(viewer, logCount) {
    const states = questions.reviewStates();
    const publicQuestions = states.filter(q => ['legacy', 'approved'].includes(q.moderation?.status));
    const publicIds = new Set(publicQuestions.filter(q => !q.tags?.includes('arena-only')).map(q => q.id));
    return classify(viewer, isSenior(viewer) ? states : publicQuestions, publicIds,
      library.reviewStates(new Set(states.map(q => q.id)), viewer), logCount).counts;
  }
  const workFilters = ['all', 'public', 'content', 'unverified', 'questioned', 'off', 'rejected'];
  const doneFilters = ['all', 'public', 'noarena', 'off', 'questioned', 'rejected', 'machine', 'injection'];
  const catalogFilters = ['all', 'public', 'waiting', 'hidden', 'closed'];
  const managedIn = (bucket, filter) => ({ all: true, public: bucket === 'verified', content: ['content', 'auto'].includes(bucket),
    unverified: ['unverified', 'sample'].includes(bucket), questioned: bucket === 'questioned', off: bucket === 'off', rejected: bucket === 'rejected' })[filter];
  const catalogIn = (q, filter) => ({ all: true, public: shown(q), waiting: waiting(q), hidden: !shown(q) && !waiting(q), closed: shown(q) && !q.acceptsUploads })[filter];
  return {
    list(query, viewer) {
      const params = listQuery(query, ['panel', 'page', 'pageSize', 'autoPage', 'filter', 'q', 'task', 'arena', 'sort', 'category', 'domain']);
      let panel = params.choice('panel', ['default', 'unverified', 'content', 'done', 'questions', 'catalog', 'works', 'log']);
      if (['questions', 'catalog'].includes(panel) && !isSenior(viewer)) fail(403, '需要高级管理员权限', 'forbidden');
      const data = index(viewer), { counts, works, buckets, thin, allQuestions, questionById, publicIds } = data;
      if (panel === 'default') panel = counts.questions ? 'questions' : counts.content ? 'content' : 'unverified';
      const { page, pageSize, q } = params;
      const result = { panel, works: [], questions: [], audit: [], counts, filterCounts: {}, total: 0, page, pageSize, scopeTotal: 0,
        questionChoices: allQuestions.map(({ id, title }) => ({ id, title })), domainChoices: [], autoWorks: [], autoTotal: 0, autoPage: params.number('autoPage', 1, 100000) };
      if (panel === 'log') {
        const audit = library.auditLog(200, viewer);
        const current = slice(audit, page, pageSize);
        const keys = new Set(current.filter(row => row.work).map(row => `${row.task}/${row.work}`));
        return { ...result, audit: current, works: works.filter(work => keys.has(`${work.taskId}/${work.id}`)).map(thin), total: audit.length, scopeTotal: audit.length };
      }
      if (['questions', 'catalog'].includes(panel)) {
        const category = query.get('category') ?? '', domain = query.get('domain') ?? '';
        const scoped = allQuestions.filter(row => !category || row.category === category);
        result.domainChoices = [...new Set(scoped.flatMap(row => row.domains ?? []))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
        let rows = scoped.filter(row => (!domain || row.domains?.includes(domain)) && (!q ||
          q.split(/\s+/).map(fold).every(word => [row.title, row.summary, categoryNames[row.category], ...(row.domains ?? []), ...(row.domains ?? []).map(value => domainNames[value]), row.prompt, ...(row.promptVariants ?? []).map(v => v.prompt)].map(fold).some(text => text.includes(word))) || publisher(row).toLowerCase().includes(q)));
        const filters = panel === 'catalog' ? catalogFilters : ['all'];
        const filter = params.choice('filter', filters);
        if (panel === 'questions') rows = rows.filter(waiting);
        result.scopeTotal = rows.length;
        result.filterCounts = Object.fromEntries(filters.map(value => [value, rows.filter(row => catalogIn(row, value)).length]));
        rows = rows.filter(row => catalogIn(row, filter));
        const sort = params.choice('sort', ['latest', 'oldest', 'title', 'works'], panel === 'questions' ? 'oldest' : 'latest');
        const byTask = new Map();
        for (const work of works) { const stats = byTask.get(work.taskId) ?? {}; stats[buckets.get(work)] = (stats[buckets.get(work)] ?? 0) + 1; byTask.set(work.taskId, stats); }
        const countWorks = row => Object.values(byTask.get(row.id) ?? {}).reduce((a, b) => a + b, 0);
        rows.sort(sort === 'title' ? titleSort : sort === 'works' ? (a, b) => countWorks(b) - countWorks(a) : (a, b) => (sort === 'oldest' ? 1 : -1) * (time(a) - time(b)));
        result.total = rows.length;
        const votes = panel === 'catalog' ? questions.adminVoteCounts(viewer) : null;
        result.questions = slice(rows, page, pageSize).map(row => {
          if (panel === 'questions') return questionDetail(row.id, viewer, data).question;
          const { prompt, promptVariants, references, referenceCredit, ...summary } = row;
          return { ...summary, works: countWorks(row), votes: votes.get(row.id) ?? 0, workCounts: byTask.get(row.id) ?? {} };
        });
        if (panel === 'questions') result.works = result.questions.flatMap(row => row.samples);
        return result;
      }
      const arenaStates = new Map();
      const arenaOf = work => {
        if (!arenaStates.has(work)) arenaStates.set(work, work.status !== 'verified' || ['pending', 'review', 'rejected'].includes(work.moderation?.status) || work.entertainmentRoute || !publicIds.has(work.taskId)
          ? 'not_ready' : library.access(work, viewer).arena?.state ?? library.adminWork(work, viewer, { preview: false }).arena?.state ?? 'not_ready');
        return arenaStates.get(work);
      };
      const doneIn = (work, filter) => {
        const bucket = buckets.get(work);
        if (filter === 'noarena') return bucket === 'verified' && arenaOf(work) !== 'in_pool';
        return { all: true, public: bucket === 'verified', off: bucket === 'off', questioned: bucket === 'questioned',
          rejected: bucket === 'rejected', machine: bucket === 'rejected' && work.moderation?.source !== 'human', injection: bucket === 'rejected' && work.moderation?.categories?.includes('prompt-injection') }[filter];
      };
      let rows = works;
      if (panel === 'works') {
        const task = query.get('task') ?? '', arena = params.choice('arena', ['all', 'in_pool', 'off', 'not_qualified', 'not_ready']);
        rows = rows.filter(work => (!task || work.taskId === task) && (arena === 'all' || arenaOf(work) === arena) && (!q || wordsIn(q,
          `${work.title} ${work.modelName} ${work.vendor} ${publisher({ author: work.curated ? { role: 'admin' } : { role: work.authorRole, name: work.ownerName } })} ${questionById.get(work.taskId)?.title ?? ''}`)));
      } else rows = rows.filter(work => panel === 'done' ? ['verified', 'off', 'questioned', 'rejected'].includes(buckets.get(work)) : buckets.get(work) === panel);
      const filters = panel === 'works' ? workFilters : panel === 'done' ? doneFilters : ['all'];
      const filter = params.choice('filter', filters);
      const inFilter = work => panel === 'works' ? managedIn(buckets.get(work), filter) : panel === 'done' ? doneIn(work, filter) : true;
      result.scopeTotal = rows.length;
      result.filterCounts = Object.fromEntries(filters.map(value => [value, rows.filter(work => panel === 'works' ? managedIn(buckets.get(work), value) : panel === 'done' ? doneIn(work, value) : true).length]));
      rows = rows.filter(inFilter);
      const sort = params.choice('sort', ['latest', 'oldest', 'title']);
      rows.sort(panel === 'works' ? sort === 'title' ? titleSort : (a, b) => (sort === 'oldest' ? 1 : -1) * (time(a) - time(b))
        : ['unverified', 'content'].includes(panel) ? (a, b) => time(a) - time(b) : (a, b) => time(b) - time(a));
      result.total = rows.length;
      result.works = slice(rows, page, pageSize).map(thin);
      if (panel === 'content') {
        const auto = works.filter(work => buckets.get(work) === 'auto').sort((a, b) => time(a) - time(b));
        result.autoTotal = auto.length;
        result.autoWorks = slice(auto, result.autoPage, pageSize).map(thin);
      }
      return result;
    },
    work(task, id, viewer) {
      const work = library.work(task, id, null, viewer) ?? fail(404, '作品不存在', 'not_found');
      return { work: library.adminWork(work, viewer), ...(isSenior(viewer) ? { question: questions.adminGet(task, viewer) } : {}), audit: library.auditFor(task, id, viewer) };
    },
    question: questionDetail,
    members(query, viewer) {
      const params = listQuery(query, ['page', 'pageSize', 'filter', 'q', 'email', 'active', 'sort']);
      const filter = params.choice('filter', ['all', '0', '1', '2', '3', 'trusted']);
      const email = params.choice('email', ['', 'bound', 'unbound']);
      const active = params.choice('active', ['', 'week', 'month', 'idle']);
      const sort = params.choice('sort', ['seen', 'latest', 'oldest', 'works', 'votes']);
      const now = Date.now();
      let rows = adminService.members(auth.list(), viewer).filter(user => (!params.q || wordsIn(params.q, `${user.name} ${user.nickname ?? ''}`)) &&
        (!email || user.emailVerified === (email === 'bound')) && (!active || (() => { const days = user.lastSeenAt ? (now - Date.parse(user.lastSeenAt)) / 86400000 : Infinity; return active === 'week' ? days <= 7 : active === 'month' ? days <= 30 : days > 30; })()));
      const inFilter = (user, value) => value === 'all' || (value === 'trusted' ? user.trusted : user.level === Number(value));
      const scopeTotal = rows.length;
      const filterCounts = Object.fromEntries(['all', '0', '1', '2', '3', 'trusted'].map(value => [value, rows.filter(user => inFilter(user, value)).length]));
      rows = rows.filter(user => inFilter(user, filter));
      const totalWorks = user => Object.values(user.works).reduce((a, b) => a + b, 0);
      rows.sort((a, b) => sort === 'seen' ? (Date.parse(b.lastSeenAt) || 0) - (Date.parse(a.lastSeenAt) || 0) : sort === 'works' ? totalWorks(b) - totalWorks(a) : sort === 'votes' ? b.votes - a.votes : (sort === 'oldest' ? 1 : -1) * (Date.parse(a.createdAt) - Date.parse(b.createdAt)));
      const exams = qualification.summaries();
      const audit = library.auditLog(200, viewer);
      return { users: slice(rows, params.page, params.pageSize).map(user => ({ ...user, exam: exams.get(user.id) ?? { passedAt: null, attempts: 0, bestCorrect: null, questionCount: null } })),
        total: rows.length, page: params.page, pageSize: params.pageSize, scopeTotal, filterCounts, counts: navigation(viewer, audit.length), audit: audit.filter(row => row.action === 'role') };
    },
  };
}
