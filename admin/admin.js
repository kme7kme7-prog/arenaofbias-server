// Admin web app for the shared backend: review queue, uploads and user roles.
// Zero dependencies; served from /admin/ by server/app.mjs. Talks to /api/* on the
// same origin, so the session cookie is the only credential.

// ---- helpers -----------------------------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* private mode */ } },
};
const pad = (n) => String(n).padStart(2, '0');
const formatDate = (value) => (value ? new Date(value).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }) : '');
const formatTime = (value) => (value ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');
const formatBytes = (bytes) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

const ICONS = {
  sun: '<circle cx="12" cy="12" r="3.6"/><path d="M12 3v1.8M12 19.2V21M5.64 5.64l1.27 1.27M17.09 17.09l1.27 1.27M3 12h1.8M19.2 12H21M5.64 18.36l1.27-1.27M17.09 6.91l1.27-1.27"/>',
  moon: '<path d="M19.5 14.6A7.5 7.5 0 0 1 9.4 4.5a7.5 7.5 0 1 0 10.1 10.1Z"/>',
  arrow: '<path d="M7.5 16.5 16.5 7.5M9 7.5h7.5V15"/>',
  close: '<path d="M17.5 6.5l-11 11M6.5 6.5l11 11"/>',
  guide: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 7.9v.01"/>',
  check: '<path d="m6 12.5 4 4 8-9"/>',
  alert: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.8v5M12 16.1v.01"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  shield: '<path d="M12 3.5 19 6v5.6c0 4.3-3 7.5-7 8.9-4-1.4-7-4.6-7-8.9V6z"/><path d="m9 12 2.2 2.2L15.3 10"/>',
  trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13"/>',
  logout: '<path d="M13.5 4.5h5v15h-5M9.5 8l-4 4 4 4M5.5 12h9"/>',
  user: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 19.5a7 7 0 0 1 14 0"/>',
  users: '<circle cx="9" cy="8.5" r="3.5"/><path d="M2.5 19.5a6.5 6.5 0 0 1 13 0"/><path d="M16 5.6a3.5 3.5 0 0 1 0 5.8M17.5 13.6a6.5 6.5 0 0 1 4 5.9"/>',
  file: '<path d="M7 3.5h7l4.5 4.5v12.5h-11.5z"/><path d="M14 3.5V8h4.5"/>',
  reload: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4.2h-4.2"/>',
  panel: '<path d="M4 4.5h16v15H4zM9 4.5v15"/>',
  chart: '<path d="M4 19.5h16M6 16v-5M11 16V7M16 16V4"/>',
  inbox: '<path d="M4 5h16v11l-3 3H7l-3-3zM4 14h5l1.5 2h3L15 14h5"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
  game: '<path d="M7 8h10a4 4 0 0 1 3.8 3l1 5a2 2 0 0 1-3.3 1.8L16 16H8l-2.5 1.8A2 2 0 0 1 2.2 16l1-5A4 4 0 0 1 7 8ZM7 11v4M5 13h4M16 12h.01M18 14h.01"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15"/><path d="M3.5 9h17M8 3v4M16 3v4"/>',
};
const icon = (name) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
// Same mark as the gallery: a solid line (同) over a broken one (异).
const LOGO = '<svg class="logo" viewBox="0 0 32 32" aria-hidden="true"><rect class="logo-bg" width="32" height="32" rx="7"/><rect class="logo-fg" x="7" y="10" width="18" height="4"/><rect class="logo-fg" x="7" y="18" width="7.6" height="4"/><rect class="logo-ac" x="17.4" y="18" width="7.6" height="4"/></svg>';

// ---- theme -------------------------------------------------------------------------------
const THEME_COLOR = { light: '#dfe3dd', dark: '#121211' };
const currentTheme = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
function applySystemTheme() {
  document.documentElement.dataset.system = state.system;
  document.documentElement.dataset.theme = store.get(`admin-theme-${state.system}`)
    || (state.system === 'arena' ? 'light' : 'dark');
  syncThemeUi();
}
function syncThemeUi() {
  const theme = currentTheme();
  $('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[theme]);
  $$('[data-theme-toggle]').forEach((b) => {
    b.setAttribute('aria-pressed', String(theme === 'dark'));
    b.title = theme === 'dark' ? '切换到纸面（浅色）' : '切换到墨色（深色）';
  });
}
function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  store.set(`admin-theme-${state.system}`, next);
  if (state.system === 'gallery') store.set('admin-theme', next);
  document.documentElement.dataset.theme = next;
  syncThemeUi();
}
const themeButton = () => `<button class="icon-btn theme-toggle" data-theme-toggle aria-label="切换主题" aria-pressed="${currentTheme() === 'dark'}">${icon('moon')}${icon('sun')}</button>`;

// ---- api -----------------------------------------------------------------------------------
class ApiError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
async function api(path, { method = 'GET', body } = {}) {
  let response;
  try {
    response = await fetch(`/api/${path}`, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, '网络连接失败，请稍后再试');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, data.error ?? `请求失败（${response.status}）`, data.code);
  if (method !== 'GET') state.workCache.clear();
  return data;
}

// ---- toast and dialogs --------------------------------------------------------------------
let toastTimer = 0;
function toast(message) {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.append(el);
  }
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

function openDialog({ title, body, className = '', onClose }) {
  const dialog = document.createElement('dialog');
  dialog.className = `sheet ${className}`;
  dialog.innerHTML = `<div class="sheet-in">
    <header class="sheet-head"><h2>${esc(title)}</h2><button class="icon-btn" type="button" data-sheet-close aria-label="关闭">${icon('close')}</button></header>
    <div class="sheet-body">${body}</div>
  </div>`;
  document.body.append(dialog);
  const close = () => { if (dialog.open) dialog.close(); };
  dialog.addEventListener('close', () => { dialog.remove(); onClose?.(); });
  dialog.addEventListener('click', (e) => { if (e.target === dialog || e.target.closest('[data-sheet-close]')) close(); });
  dialog.showModal();
  return { el: dialog, close, setTitle: (text) => { $('.sheet-head h2', dialog).textContent = text; } };
}

function confirmDialog({ title, message, confirm = '确认', danger = false }) {
  return new Promise((resolve) => {
    let answer = false;
    const sheet = openDialog({
      title,
      className: 'confirm-sheet',
      body: `<p class="sheet-text">${esc(message)}</p><div class="sheet-actions"><button class="btn" type="button" data-sheet-close>取消</button><button class="btn primary${danger ? ' danger' : ''}" type="button" data-confirm>${esc(confirm)}</button></div>`,
      onClose: () => resolve(answer),
    });
    $('[data-confirm]', sheet.el).addEventListener('click', () => { answer = true; sheet.close(); });
  });
}

// ---- shared bits ---------------------------------------------------------------------------
const STATUS = {
  verified: { label: '已验证', hint: '已核验并公开；单轮生成且无人工介入的作品参与盲评', icon: 'check' },
  unverified: { label: '未验证', hint: '等待核验：可以浏览和贴表情，暂不参与盲评', icon: 'clock' },
  questioned: { label: '存疑', hint: '核验存疑：仅供参考，不参与互动与盲评', icon: 'alert' },
};
const statusBadge = (status, reason = '') => {
  const info = STATUS[status];
  return info ? `<span class="status status-${status}" title="${esc(reason || info.hint)}">${icon(info.icon)}${info.label}</span>` : '';
};
const ACTIONS = { submit: '提交作品', verified: '通过核验', questioned: '标记存疑', unverified: '退回未验证', delete: '删除作品', role: '调整角色',
  'question-create': '发起题目', 'question-review': '审核题目', 'question-delete': '删除题目',
  'content-review': '内容审核', 'content-retry': '重新自动审核',
  'face-settings': '门面开关', meta: '编辑信息', curate: '收录为馆藏', nominate: '提名收录', 'withdraw-nomination': '撤回提名', 'inbox-upload': '收件箱上传', 'inbox-register': '登记入库', 'inbox-remove': '收件箱移除' };
// Per-face review: the same work is approved separately for the gallery (display)
// and the arena (blind test). `audience` carries both flags; adminWork rows also
// carry explicit show_gallery/show_arena.
const AUDIENCE_FACE = { gallery: ['show2', 'both'], arena: ['show1', 'both'] };
const contentHeld = (w) => ['pending', 'review', 'rejected'].includes(w.moderation?.status);
const contentReady = (w) => w.source === 'curated' || ['legacy', 'approved'].includes(w.moderation?.status);
const faceOn = (w, face = state.system) => !contentHeld(w) && Boolean(w[`show_${face}`] ?? AUDIENCE_FACE[face].includes(w.audience));
const CONTENT_STATUS = { pending: '自动审核中', approved: '内容已通过', review: '内容待人工审核', rejected: '内容未通过', legacy: '历史作品' };
const QUESTION_STATUS = { pending: '待审核', approved: '已通过', rejected: '已拒绝', legacy: '历史题目' };

const skeleton = (count = 4, kind = 'row') => `<div class="skeleton-list" aria-label="正在载入" role="status">${Array.from({ length: count }, () => `<div class="skeleton skeleton-${kind}"></div>`).join('')}</div>`;
function busy(button, text = '处理中…') {
  if (!button) return () => {};
  const original = button.innerHTML;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.innerHTML = `<span class="busy-spinner" aria-hidden="true"></span>${text}`;
  return () => { if (button.isConnected) { button.innerHTML = original; button.disabled = false; button.removeAttribute('aria-busy'); } };
}

// App state. `data` is the static catalog (task titles, model list) read from /data.json.
const state = { user: undefined, data: null, works: null, audit: [], users: null, worksFilter: 'all', error: '',
  system: ['arena', 'common'].includes(store.get('admin-system')) ? store.get('admin-system') : 'gallery', adminWorks: [], workTotal: 0,
  workCache: new Map(), workKey: '', workLoading: false, trafficLoading: false, requestId: 0,
  sidebarCollapsed: store.get('admin-sidebar-collapsed') === '1',
  workPage: 1, workTask: '', workStatus: '', workShow: '', workHarness: '', workProvider: '', workSearch: '', traffic: null,
  workModel: '', workEffort: '', workGenerationMode: '', workHumanIntervention: '', workEfforts: [],
  inbox: null, inboxForms: {}, intake: null, adminQuestions: null, reviewCounts: null };
const taskTitle = (id) => [...(state.data?.tasks ?? []), ...(state.questions ?? []), ...(state.adminQuestions ?? [])].find((t) => t.id === id)?.title ?? id;

async function loadCatalog() {
  if (state.data) return;
  try {
    const response = await fetch('/data.json', { cache: 'no-store' });
    state.data = response.ok ? await response.json() : null;
  } catch {
    state.data = null;
  }
  // A failed read (e.g. the pre-login 404) stays null so the post-login boot retries;
  // caching an empty stub here would blank every registry dropdown until a hard reload.
  if (!state.data) return;
}


async function loadInbox() {
  try {
    state.inbox = (await api('admin/inbox')).entries;
  } catch {
    state.inbox = [];
  }
}

async function removeWork(w) {
  const ok = await confirmDialog({
    title: '删除这件作品？',
    message: `「${w.title}」的文件会被永久删除，展厅中不再显示。参与过盲评（有对局记录）的作品会被拒绝删除，请改用「标记存疑」让它下线。操作会记入审核记录。`,
    confirm: '删除',
    danger: true,
  });
  if (!ok) return false;
  toast('正在删除作品…');
  try {
    await api(`works/${encodeURIComponent(w.task)}/${encodeURIComponent(w.id)}`, { method: 'DELETE' });
    toast('作品已删除');
    return true;
  } catch (error) {
    toast(error.message);
    return false;
  }
}


// ---- work rows ------------------------------------------------------------------------------
function thumb(w) {
  const src = Object.values(w.captures ?? {})[0] ?? w.cover;
  const url = src ? (src.startsWith('http') ? src : `/${src}`) : '';
  return `<span class="work-thumb" aria-hidden="true">${url ? `<img src="${esc(url)}" alt="" loading="lazy" decoding="async">` : `<span class="img-empty upload-cover"><b>${esc(w.title)}</b></span>`}</span>`;
}


// ---- views -----------------------------------------------------------------------------------
const app = () => $('#app');
const routeParts = () => location.hash.replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean);
// Face systems carry only their own pages; everything shared lives in the common area.
const TABS = [
  { id: 'works', label: '作品', icon: 'file' },
  { id: 'tasks', label: '题目', icon: 'guide' },
];
const COMMON_TABS = [
  { id: 'dashboard', label: '仪表盘', icon: 'chart' },
  { id: 'upload', label: '上传入口', icon: 'inbox' },
  { id: 'users', label: '用户', icon: 'users' },
  { id: 'traffic', label: '流量', icon: 'clock' },
];
const ARENA_NAV = [
  ['内容管理', [['works', '作品管理', 'file', '#/works'], ['intake', '收件箱 · 娱乐作品', 'inbox', '#/intake'], ['tasks', '题目管理', 'guide', '#/tasks'], ['gallery-review', '审核', 'shield', 'https://gallery.arenaofbias.icu/#/review']]],
  ['玩法', [['guess', '模一把', 'game', '#/guess'], ['activity', '活动管理', 'calendar', '#/activity']]],
];
const SUBMIT_URL = 'https://gallery.arenaofbias.icu/#/submit';
const REVIEW_URL = 'https://gallery.arenaofbias.icu/#/review';
const systemSwitch = () => `<div class="system-switch" role="group" aria-label="管理系统"><button type="button" data-system="gallery" aria-pressed="${state.system === 'gallery'}">展览馆系统</button><button type="button" data-system="arena" aria-pressed="${state.system === 'arena'}">竞技场系统</button><button type="button" data-system="common" aria-pressed="${state.system === 'common'}">通用后台</button></div>`;

const routeAllowed = (route, sub) => state.system === 'common'
  ? COMMON_TABS.some((tab) => tab.id === route)
  : TABS.some((tab) => tab.id === route) || (state.system === 'arena' && ['guess', 'activity', 'intake'].includes(route));
const tabsForSystem = () => state.system === 'common' ? COMMON_TABS : TABS;

function topbar(route) {
  if (state.system === 'arena') return `<header class="topbar arena-topbar">
    <div class="arena-page-mark"><span class="eyebrow">偏见试验场 / 管理工作台</span><strong>${esc(TABS.find((tab) => tab.id === route)?.label ?? (route === 'intake' ? '收件箱 · 娱乐作品' : '竞技场'))}</strong></div>
    <span class="topbar-space"></span>${systemSwitch()}${themeButton()}
    <span class="user-chip" title="当前账号"><span class="avatar" aria-hidden="true">${esc(state.user.name.slice(0, 1).toUpperCase())}</span><span class="user-name">${esc(state.user.name)}</span></span>
    <button class="icon-btn" data-logout title="退出登录" aria-label="退出登录">${icon('logout')}</button>
  </header>`;
  return `<header class="topbar">
    <a class="brand" href="${state.system === 'common' ? '#/dashboard' : '#/works'}">${LOGO}<span class="brand-name">同题异答<b>${state.system === 'common' ? '通用后台' : '管理后台'}</b></span></a>
    ${systemSwitch()}
    <nav class="tabs" aria-label="管理">
      ${tabsForSystem().map((tab) => `<a href="#/${tab.id}"${tab.id === route ? ' aria-current="page"' : ''}>${icon(tab.icon)}${tab.label}</a>`).join('')}
      <a href="${REVIEW_URL}" target="_blank" rel="noopener">${icon('shield')}审核</a>
    </nav>
    <span class="topbar-space"></span>
    ${themeButton()}
    <span class="user-chip" title="当前账号"><span class="avatar" aria-hidden="true">${esc(state.user.name.slice(0, 1).toUpperCase())}</span><span class="user-name">${esc(state.user.name)}</span></span>
    <button class="icon-btn" data-logout title="退出登录" aria-label="退出登录">${icon('logout')}</button>
  </header>`;
}
function arenaSidebar(route, sub) {
  const selected = route;
  return `<aside class="workspace-sidebar" aria-label="竞技场工作台导航">
    <div class="sidebar-head"><a class="sidebar-brand" href="#/works">${LOGO}<span class="sidebar-copy"><b>偏见试验场</b><small>竞技场管理工作台</small></span></a>
      <button class="icon-btn sidebar-collapse" type="button" data-sidebar-collapse aria-label="${state.sidebarCollapsed ? '展开侧栏' : '折叠侧栏'}" aria-expanded="${!state.sidebarCollapsed}" title="${state.sidebarCollapsed ? '展开侧栏' : '折叠侧栏'}">${icon('panel')}</button></div>
    <nav class="sidebar-nav">${ARENA_NAV.map(([group, items]) => `<div class="sidebar-group"><span class="sidebar-caption">${group}</span>${items.map(([id, label, glyph, href]) => `<a href="${href}" title="${label}"${href.startsWith('http') ? ' target="_blank" rel="noopener"' : ''}${selected === id ? ' aria-current="page"' : ''}>${icon(glyph)}<span class="sidebar-label">${label}</span></a>`).join('')}</div>`).join('')}</nav>
    <div class="sidebar-foot"><span>共享数据 · 双系统门面</span><small>竞技场 / 管理后台</small></div>
  </aside>`;
}

function pageHero(kicker, title, lead, stats) {
  return `<section class="page-hero">
    <p class="eyebrow"><span class="eyebrow-mark" aria-hidden="true"></span>${esc(kicker)}</p>
    <h1>${esc(title)}<span class="stop">。</span></h1>
    <div class="hero-foot">
      <p class="lead">${esc(lead)}</p>
      <dl class="stats">${stats.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${typeof value === 'number' ? pad(value) : esc(value)}</dd></div>`).join('')}</dl>
    </div>
  </section>`;
}

// -- review tab --
// -- admin staging inbox (代传收件箱) -----------------------------------------------
// Files wait here until an admin previews them and registers them as works;
// registration reuses the platform draft pipeline, so uploads default to
// 展览馆开 / 正式盲测关 and never auto-publish.
function inboxPanel() {
  const entries = state.inbox ?? [];
  const tasks = [...(state.data?.tasks ?? []), ...(state.questions ?? [])];
  const taskOptions = (selected) => tasks.map((t) => `<option value="${esc(t.id)}"${t.id === selected ? ' selected' : ''}>${esc(t.title)}</option>`).join('');
  const modelOptions = (selected) => (state.data?.models ?? []).map((m) => `<option value="${esc(m.id)}"${m.id === selected ? ' selected' : ''}>${esc(m.name)}</option>`).join('');
  const cards = entries.map((entry) => {
    const form = state.inboxForms[entry.id] ??= {
      task: store.get('admin-inbox-task') ?? '', title: entry.suggest.title, summary: '',
      modelId: '', modelName: entry.suggest.model, effort: '',
      harnessChoice: '', harnessOther: '', providerChoice: '',
      ...Object.fromEntries(GENERATION_FIELDS.map((key) => [key, ''])) };
    const value = (name) => esc(String(form[name] ?? ''));
    return `<article class="inbox-card" data-inbox-id="${esc(entry.id)}">
      <div class="inbox-preview"><iframe src="${esc(entry.preview)}" sandbox="allow-scripts allow-pointer-lock" loading="lazy" title="预览「${esc(entry.name)}」"></iframe><a class="btn sm inbox-open" href="${esc(entry.preview)}" target="_blank" rel="noopener">新窗口打开 ${icon('arrow')}</a></div>
      <form class="inbox-form" novalidate>
        <p class="inbox-name">${icon('file')}<b>${esc(entry.name)}</b><span>${formatBytes(entry.size)}</span></p>
        <label class="field"><span class="field-label">题目</span><select class="input" name="task" required><option value="">选择题目</option>${taskOptions(form.task)}</select></label>
        <div class="field-row">
          <label class="field"><span class="field-label">登记为模型<small>挂到模型档案，排行榜按模型记分</small></span><select class="input" name="modelId"><option value="">不登记（用自由文本）</option>${modelOptions(form.modelId)}</select></label>
          ${effortField(form.effort)}
        </div>
        <div class="field-row">
          <label class="field"><span class="field-label">作品标题</span><input class="input" name="title" maxlength="40" value="${value('title')}"></label>
          <label class="field"><span class="field-label">模型名称<small>展签显示的名字，选了档案会自动回填</small></span><input class="input" name="modelName" maxlength="60" value="${value('modelName')}" placeholder="如 Claude 4.5"></label>
        </div>
        <label class="field"><span class="field-label">摘要</span><input class="input" name="summary" maxlength="200" value="${value('summary')}"></label>
        ${provenanceFields({ harness: { choice: form.harnessChoice, other: form.harnessOther }, provider: { choice: form.providerChoice } })}
        ${generationFields(form)}
        <p class="fine">管理员代传视为已通过内容审核和核验：登记后直接上展览馆，不进正式盲测；进不进盲测在竞技场系统里决定。</p>
        <p class="form-error" role="alert"></p>
        <div class="actions"><button type="button" class="btn sm danger ghost" data-inbox-remove>${icon('trash')}移除</button><span class="spacer"></span><button class="btn sm primary" type="submit">${icon('check')}登记入库</button></div>
      </form>
    </article>`;
  }).join('');
  return `<section class="block inbox-panel" aria-label="管理员代传">
    <div class="inbox-head"><h2>管理员代传 · 收件箱</h2><span class="muted">文件先暂存在这里预览，登记后才成为作品</span><button class="btn sm" type="button" data-inbox-reload>${icon('reload')}刷新</button></div>
    <p><a class="btn primary" href="${SUBMIT_URL}" target="_blank" rel="noopener">前往投稿页 ${icon('arrow')}</a></p>
    <p class="fine">新作品改到展览馆投稿页提交。上传接口仍保留给投稿页使用。</p>
    ${state.inbox === null ? skeleton(2) : cards ? `<div class="inbox-list">${cards}</div>` : ''}
  </section>`;
}

async function inboxUpload(files) {
  const list = [...files].filter((file) => /\.(html?|zip)$/i.test(file.name));
  if (!list.length) { toast('只支持 .html / .htm / .zip 文件'); return; }
  for (const file of list) {
    if (file.size > 30 * 1024 * 1024) { toast(`「${file.name}」超过 30 MB，已跳过`); continue; }
    toast(`正在上传：${file.name}`);
    const query = new URLSearchParams({ name: file.name });
    const send = (overwrite) => fetch(`/api/admin/inbox?${query}${overwrite ? '&overwrite=1' : ''}`,
      { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
    let response = await send(false);
    if (response.status === 409) {
      const overwrite = await confirmDialog({ title: '收件箱里已有同名文件', message: `「${file.name}」已经在收件箱里了，覆盖它？`, confirm: '覆盖' });
      if (!overwrite) continue;
      response = await send(true);
    }
    if (!response.ok) toast((await response.json().catch(() => ({}))).error ?? '上传失败');
  }
  await loadInbox();
  render({ soft: true });
}

function dashboardView() {
  const traffic = state.traffic;
  return `${pageHero('总览', '仪表盘', '审核在展览馆进行。这里看访问概况和最近的管理操作。', [
    ['用户', traffic ? traffic.users.total : '—']])}
  <section class="block dashboard-actions">
    <a class="btn primary" href="${REVIEW_URL}" target="_blank" rel="noopener">${icon('shield')}前往审核 ${icon('arrow')}</a>
    <a class="btn" href="${SUBMIT_URL}" target="_blank" rel="noopener">前往投稿页 ${icon('arrow')}</a>
  </section>
  ${traffic ? `<section class="block"><h2>访问近 14 日</h2><div class="traffic-bars" aria-label="近 14 日访问量">${traffic.daily.slice(-14).map((d) => { const max = Math.max(1, ...traffic.daily.slice(-14).map((x) => x.pv)); return `<div class="traffic-day" title="${d.day}：${d.pv} PV，${d.uniqueIps} 位独立访客"><div class="traffic-bar" style="height:${Math.max(2, d.pv / max * 100)}%"></div><span>${d.day.slice(5)}</span></div>`; }).join('')}</div><p class="fine">近 30 日新注册 ${traffic.users.new} 人，累计 ${traffic.users.total} 人。<a href="#/traffic">完整访问概况</a></p></section>` : `<section class="block" aria-busy="true"><h2>访问近 14 日</h2>${skeleton(6, 'bar')}</section>`}
  <section class="block"><h2>最近操作</h2>${state.audit.length ? auditList(12) : skeleton(4)}</section>`;
}

function uploadView() {
  const entries = state.inbox ?? [];
  return `${pageHero('统一上传入口', '上传', '新作品前往展览馆投稿页。这里只保留已经暂存、尚未登记的文件。', [['暂存', entries.length]])}
  ${inboxPanel()}`;
}

const WORKS_FILTERS = { all: '全部', unverified: '未验证', verified: '已验证', questioned: '存疑' };
const faceLabel = () => state.system === 'gallery' ? '展览馆' : '竞技场';
const workKey = (w) => `${encodeURIComponent(w.task)}/${encodeURIComponent(w.id)}`;
function updateBulkSelection() {
  const results = $('.work-results', app());
  if (!results) return;
  const inputs = $$('[data-select-work]:not(:disabled)', results);
  const selected = inputs.filter((input) => input.checked).length;
  const all = $('[data-select-all]', results);
  if (all) {
    all.checked = inputs.length > 0 && selected === inputs.length;
    all.indeterminate = selected > 0 && selected < inputs.length;
  }
  const count = $('[data-bulk-count]', results);
  if (count) count.textContent = `已选 ${selected} 件（本页）`;
  $$('[data-bulk-face]', results).forEach((button) => { button.disabled = selected === 0; });
}
function adminWorkRow(w, face = state.system) {
  const label = face === 'gallery' ? '展览馆' : '竞技场';
  const datapackTasks = new Set((state.data?.tasks ?? []).map((t) => t.id));
  const curable = w.source === 'upload' && w.status === 'verified' && !w.curatedAs && datapackTasks.has(w.task);
  const promoted = Boolean(w.curatedAs);
  const formal = w.entertainment_route === 1 ? '在收件箱' : promoted ? '已收录' : w.arena_eligible ? '在正式盲测池' : w.show_arena && !w.arena_generation_ok ? '不符合盲评条件（多轮 / 人工介入）' : '不在正式盲测池';
  const entertainment = w.entertainment_route === 1 ? '在收件箱' : w.show_entertainment ? '在娱乐池' : '不在娱乐池';
  return `<tr data-work-key="${esc(`${w.task}/${w.id}`)}">
    <td><div class="admin-work-title">${thumb(w)}<div><b>${esc(w.title)}</b><small>${esc(taskTitle(w.task))} · ${w.votes ?? 0} 票</small>${w.entertainment_route === 1 ? '<span class="badge">在收件箱</span>' : ''}</div></div></td>
    <td>${esc(w.modelName)}${provenanceText(w) ? `<small class="work-provenance">${esc(provenanceText(w))}</small>` : ''}</td><td>${statusBadge(w.status)}</td>
    <td>${w.show_gallery ? '进入展览馆' : '未进展览馆'}</td>
    ${face === 'arena' ? `<td>${formal}</td><td>${entertainment}</td>` : '<td>—</td>'}
    <td><div class="actions">${promoted ? '<span class="badge">已收录</span>' : w.nominatedAt ? '<span class="badge">已提名</span>' : ''}<button class="btn sm" data-calibrate="${esc(w.id)}">${label}取景</button><button class="btn sm" data-task-note="${esc(w.task)}">${face === 'gallery' ? '策展笔记' : '题目点评'}</button>${w.source === 'upload' ? `${curable ? `<button class="btn sm primary" data-nominate="${esc(w.id)}">${w.nominatedAt ? '换发命令' : '提名收录'}</button>` : ''}${w.nominatedAt && !promoted ? `<button class="btn sm" data-withdraw="${esc(w.id)}">撤回提名</button>` : ''}` : ''}${promoted ? '' : `<button class="btn sm" data-edit="${esc(w.id)}">编辑</button><a class="btn sm" href="${REVIEW_URL}" target="_blank" rel="noopener">审核</a>`}</div></td>
  </tr>`;
}
function systemWorksView() {
  const face = state.system;
  const works = state.adminWorks;
  const tasks = [...(state.data?.tasks ?? []), ...(state.questions ?? [])];
  const options = tasks.map((t) => `<option value="${esc(t.id)}" ${state.workTask === t.id ? 'selected' : ''}>${esc(t.title)}</option>`).join('');
  const pages = Math.max(1, Math.ceil(state.workTotal / 30));
  const rows = works.map((w) => adminWorkRow(w, face)).join('');
  return `${pageHero('作品管理', `${faceLabel()}作品`, '开关在编辑里保存，取景仍在本行。', [['全部作品', state.workTotal], ['本页', works.length]])}
    <section class="block"><form id="admin-work-filter" class="admin-filter">
      <input class="input" name="search" value="${esc(state.workSearch)}" placeholder="搜索作品或模型" aria-label="搜索作品或模型">
      <select class="input" name="task" aria-label="筛选题目"><option value="">全部题目</option>${options}</select>
      <select class="input" name="status" aria-label="筛选状态"><option value="">全部状态</option>${Object.entries(WORKS_FILTERS).filter(([id]) => id !== 'all').map(([id, label]) => `<option value="${id}" ${state.workStatus === id ? 'selected' : ''}>${label}</option>`).join('')}</select>
      <select class="input" name="show" aria-label="筛选开关"><option value="">全部开关</option><option value="on" ${state.workShow === 'on' ? 'selected' : ''}>已开启</option><option value="off" ${state.workShow === 'off' ? 'selected' : ''}>已关闭</option></select>
      <select class="input" name="model" aria-label="筛选模型"><option value="">全部模型</option><option value="other"${state.workModel === 'other' ? ' selected' : ''}>未登记模型</option>${(state.data?.models ?? []).map((model) => `<option value="${esc(model.id)}"${state.workModel === model.id ? ' selected' : ''}>${esc(model.name)}</option>`).join('')}</select>
      <select class="input" name="effort" aria-label="筛选推理档位"><option value="">全部档位</option><option value="unset"${state.workEffort === 'unset' ? ' selected' : ''}>未注明档位</option>${[...new Set(['Default', 'Low', 'Medium', 'High', 'XHigh', 'Max', ...state.workEfforts, state.workEffort].filter((value) => value && value !== 'unset'))].map((value) => `<option value="${esc(value)}"${state.workEffort === value ? ' selected' : ''}>${esc(value === 'Default' ? '默认档位' : value)}</option>`).join('')}</select>
      ${Object.keys(GENERATION_CHOICES).map((key) => {
        const current = state[`work${key[0].toUpperCase()}${key.slice(1)}`];
        return `<select class="input" name="${key}" aria-label="筛选${GENERATION_LABELS[key]}"><option value="">全部${GENERATION_LABELS[key]}</option>${Object.entries({ unset: '未注明', ...GENERATION_CHOICES[key] }).map(([value, label]) => `<option value="${value}"${current === value ? ' selected' : ''}>${label}</option>`).join('')}</select>`;
      }).join('')}
      ${['harness', 'provider'].map((type) => {
        const current = type === 'harness' ? state.workHarness : state.workProvider;
        const choices = type === 'provider' ? [['unset', '未注明'], ...Object.entries(PROVIDER_CHOICES)] : [['unset', '未注明'], ['other', '其他（手填）'], ...registry(type).map((entry) => [entry.id, entry.name])];
        return `<select class="input" name="${type}" aria-label="筛选${PROVENANCE[type].label}"><option value="">全部${PROVENANCE[type].label}</option>${choices.map(([value, label]) => `<option value="${esc(value)}"${current === value ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select>`;
      }).join('')}
      <button class="btn" type="submit">筛选</button></form>
      <div class="work-results" aria-busy="${state.workLoading}">${state.workLoading ? skeleton(7) : rows ? `<div class="table-wrap"><table class="board admin-work-table"><thead><tr><th>作品</th><th>模型</th><th>状态</th><th>进入展览馆</th><th>${face === 'arena' ? '正式盲测池' : '备注'}</th>${face === 'arena' ? '<th>娱乐池</th>' : ''}<th>操作</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="board-empty">没有符合条件的作品。</p>'}</div>
      <div class="admin-pagination"><button class="btn sm" data-page="${state.workPage - 1}" ${state.workPage <= 1 ? 'disabled' : ''}>上一页</button><span>第 ${state.workPage} / ${pages} 页</span><button class="btn sm" data-page="${state.workPage + 1}" ${state.workPage >= pages ? 'disabled' : ''}>下一页</button></div>
    </section>`;
}

const QUESTION_DOMAINS = ['数学', '物理', '化学', '生物', '天文', '建筑', '自然景观', '交通与机械', '产品与品牌', '文学艺术', '游戏娱乐'];
function tasksView() {
  const tasks = [...(state.data?.tasks ?? []), ...(state.questions ?? [])];
  return `${pageHero('题目管理', `${faceLabel()}题目`, state.system === 'gallery' ? '为每道题编辑策展文案。' : '为每道题编辑点评和六维权重。', [['题目', tasks.length]])}
    <section class="block">${state.system === 'arena' ? '<div class="actions"><button class="btn primary" type="button" data-new-question>新建题目</button></div>' : ''}<div class="admin-task-list">${tasks.map((task) => `<article class="admin-task"><div><h3>${esc(task.title)}</h3><p class="muted">${esc(task.id)}</p></div><button class="btn" data-task-note="${esc(task.id)}">${state.system === 'gallery' ? '编辑策展文案' : '编辑点评与权重'}</button></article>`).join('')}</div></section>`;
}
function intakeView() {
  const works = state.intake ?? [];
  const tasks = [...(state.data?.tasks ?? []), ...(state.questions ?? [])];
  const options = tasks.map((task) => `<option value="${esc(task.id)}">${esc(task.title)}</option>`).join('');
  const rows = works.map((work) => `<tr>
    <td><input type="checkbox" data-intake-task="${esc(work.task)}" data-intake-id="${esc(work.id)}" aria-label="选择${esc(work.title)}"></td>
    <td><b>${esc(work.title)}</b><small>${esc(work.modelName)}</small></td>
    <td>${esc(taskTitle(work.task))}</td>
    <td>${formatTime(work.addedAt)}</td>
    <td><button class="btn sm" data-edit="${esc(work.id)}">补信息</button></td>
  </tr>`).join('');
  return `${pageHero('收件箱 · 娱乐作品', '待归属', '归属到题目后自动离开收件箱。只补信息则继续留在这里。', [['待处理', works.length]])}
    <section class="block"><form id="intake-assign" class="admin-filter">
      <select class="input" name="task" required aria-label="归属题目"><option value="">选择题目</option>${options}</select>
      <label class="face-checks"><input type="checkbox" name="entertainment"> 同时开启娱乐盲测</label>
      <button class="btn primary" type="submit">归属所选</button>
    </form>
    ${rows ? `<div class="table-wrap"><table class="board"><thead><tr><th></th><th>作品</th><th>原题</th><th>进入时间</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="board-empty">收件箱是空的。</p>'}</section>`;
}

function trafficView() {
  const data = state.traffic;
  if (!data) return `${pageHero('访问概况', '流量', '近 30 日页面浏览和注册概况。', [['用户总数', '—'], ['新增用户', '—']])}<section class="block" aria-busy="true"><h2>每日访问</h2><div class="traffic-skeleton">${skeleton(16, 'bar')}</div><h2>热门路径</h2>${skeleton(5)}</section>`;
  const max = Math.max(1, ...data.daily.map((d) => d.pv));
  return `${pageHero('访问概况', '流量', '近 30 日页面浏览和注册概况。', [['用户总数', data.users.total], ['新增用户', data.users.new]])}
    <section class="block"><h2>每日访问</h2><div class="traffic-bars" aria-label="每日访问量">${data.daily.map((d) => `<div class="traffic-day" title="${d.day}：${d.pv} PV，${d.uniqueIps} 位独立访客"><div class="traffic-bar" style="height:${Math.max(2, d.pv / max * 100)}%"></div><span>${d.day.slice(5)}</span></div>`).join('')}</div>
    <h2>热门路径</h2><ol class="traffic-paths">${data.paths.map((p) => `<li><span>${esc(p.path)}</span><b>${p.pv} PV</b></li>`).join('') || '<li>暂无记录</li>'}</ol></section>`;
}
function placeholderView(route) {
  const title = route === 'guess' ? '模一把' : '活动管理';
  return `${pageHero('玩法 / 即将开放', title, '工作台入口已就位，功能建设中。', [])}<section class="block placeholder-module"><div class="placeholder-symbol">${icon(route === 'guess' ? 'game' : 'calendar')}</div><p class="eyebrow">玩法模块 / ${route === 'guess' ? '01' : '02'}</p><h2>功能建设中</h2><p>这里会接入「${title}」的管理工具。现有作品、题目与审核功能可继续使用。</p><a class="btn" href="#/works">返回作品管理 ${icon('arrow')}</a></section>`;
}

function newQuestionDialog() {
  const sheet = openDialog({ title: '新建题目', body: `<form class="admin-editor">
    <label class="field"><span class="field-label">标题</span><input class="input" name="title" maxlength="70" required></label>
    <label class="field"><span class="field-label">简述</span><textarea class="input" name="summary" maxlength="400" rows="2" required></textarea></label>
    <label class="field"><span class="field-label">提示词</span><textarea class="input" name="prompt" maxlength="20000" rows="6" required></textarea></label>
    <label class="field"><span class="field-label">形式</span><select class="input" name="category" required><option value="静态网页">网页</option><option value="建模">三维</option><option value="文学">文本</option></select></label>
    <label class="field"><span class="field-label">领域</span><select class="input" name="domain" required>${QUESTION_DOMAINS.map((domain) => `<option value="${domain}">${domain}</option>`).join('')}</select></label>
    <p class="form-error" role="alert"></p><button class="btn primary" type="submit">创建</button></form>` });
  const form = $('form', sheet.el);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const category = form.category.value;
    const done = busy($('button[type="submit"]', form), '正在创建…');
    try {
      await api('admin/questions', { method: 'POST', body: {
        title: form.title.value, summary: form.summary.value, prompt: form.prompt.value, category,
        domains: [form.domain.value], templates: category === '文学' ? ['text'] : ['static'],
      } });
      sheet.close();
      toast('题目已创建');
      await reload();
    } catch (error) { $('.form-error', form).textContent = error.message; done(); }
  });
}
const PROVENANCE = { harness: { label: 'Harness', list: 'harnesses' }, provider: { label: '服务商', list: 'providers' } };
const OTHER = '__other';
const PROVIDER_CHOICES = { official: '官方', unofficial: '非官方' };
const providerChoice = (w) => w?.provider === 'official' ? 'official' : w?.provider || w?.providerName ? 'unofficial' : '';
const providerLabel = (w) => PROVIDER_CHOICES[providerChoice(w)] ?? '未注明';
const registry = (type) => state.data?.[PROVENANCE[type].list] ?? [];
const provenanceText = (w) => [w.harnessName, providerChoice(w) && providerLabel(w)].filter(Boolean).join(' · ');
const nameKey = (value) => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[\s-]/g, '');
const suggestEntry = (type, text) => {
  const key = nameKey(text);
  return key ? registry(type).find((entry) => [entry.name, ...(entry.aliases ?? [])].some((name) => nameKey(name) === key)) ?? null : null;
};
// The stored choice of a work: registry id, OTHER (free text only) or ''.
const currentProvenance = (w, type) => type === 'provider' ? { choice: providerChoice(w) } : ({ choice: w?.[type] ?? (w?.[`${type}Name`] ? OTHER : ''), other: w?.[type] ? '' : w?.[`${type}Name`] ?? '' });

function suggestionHtml(type, choice, other) {
  const match = choice === OTHER ? suggestEntry(type, other) : null;
  return match ? `可能是 ${esc(match.name)}<button type="button" class="btn sm" data-pick-provenance="${type}" data-id="${esc(match.id)}">改选 ${esc(match.name)}</button>` : '';
}

const GENERATION_FIELDS = ['generationMode', 'humanIntervention'];
const GENERATION_CHOICES = {
  generationMode: { 'single-turn': '单轮', 'multi-turn': '多轮' },
  humanIntervention: { none: '仅初始提示，未修改代码', 'prompt-guided': '人工提示与指导（未改代码）', 'code-edited': '人工修改了代码' },
};
const GENERATION_LABELS = { generationMode: '生成方式', humanIntervention: '人工介入程度' };
function generationFields(work = {}) {
  const select = (key) => `<label class="field"><span class="field-label">${GENERATION_LABELS[key]}</span><select class="input" name="${key}"><option value="">未注明</option>${Object.entries(GENERATION_CHOICES[key]).map(([value, label]) => `<option value="${value}"${work[key] === value ? ' selected' : ''}>${label}</option>`).join('')}</select></label>`;
  return `<details class="generation-fields"${GENERATION_FIELDS.some((key) => work[key]) ? ' open' : ''}><summary>生成信息（选填）</summary>
    <div class="field-row">${select('generationMode')}${select('humanIntervention')}</div>
    <p class="fine">用户只发一次提示词即为单轮，智能体自主迭代也算单轮。仅单轮且无人工介入的作品可进盲评池；未注明与没有人工介入是不同含义。</p></details>`;
}
const generationBody = (get, work = {}) => Object.fromEntries(GENERATION_FIELDS
  .map((key) => [key, String(get(key) ?? '').trim()]).filter(([key, value]) => value !== (work[key] ?? '')));
const generationFacts = (work) => Object.keys(GENERATION_CHOICES).map((key) => `<div><dt>${GENERATION_LABELS[key]}</dt><dd>${esc(GENERATION_CHOICES[key][work[key]] || '未注明')}</dd></div>`).join('');
let effortInputId = 0;
function effortField(value = '') {
  const id = `admin-efforts-${++effortInputId}`;
  return `<label class="field"><span class="field-label">推理档位<i>*</i><small>请选择常用值或手填，使用默认设置填 Default</small></span><input class="input" name="effort" list="${id}" required maxlength="20" value="${esc(value)}" placeholder="选择或填写档位"><datalist id="${id}">${['Default', 'Low', 'Medium', 'High', 'XHigh', 'Max'].map((effort) => `<option value="${effort}">${effort === 'Default' ? '默认档位（明确使用默认设置）' : effort}</option>`).join('')}</datalist></label>`;
}

function provenanceFields({ harness = { choice: '', other: '' }, provider = { choice: '' } } = {}) {
  const field = (type, { choice, other }) => {
    const entries = registry(type).filter((entry) => entry.listed || entry.id === choice);
    const known = !choice || choice === OTHER || entries.some((entry) => entry.id === choice);
    const suggestion = suggestionHtml(type, choice, other);
    return `<label class="field"><span class="field-label">${PROVENANCE[type].label}</span><select class="input" name="${type}Choice" data-provenance-choice="${type}">
        <option value="">未注明</option>
        ${entries.map((entry) => `<option value="${esc(entry.id)}"${entry.id === choice ? ' selected' : ''}>${esc(entry.name)}${entry.listed ? '' : '（已停用）'}</option>`).join('')}
        ${known ? '' : `<option value="${esc(choice)}" selected>${esc(choice)}（不在当前数据包）</option>`}
        <option value="${OTHER}"${choice === OTHER ? ' selected' : ''}>其他（手动填写）</option>
      </select></label>
      <label class="field" data-provenance-other="${type}"${choice === OTHER ? '' : ' hidden'}><span class="field-label">其他${PROVENANCE[type].label}名称</span><input class="input" name="${type}Other" maxlength="40" value="${esc(other)}">
        <span class="provenance-suggestion" data-provenance-suggestion="${type}"${suggestion ? '' : ' hidden'}>${suggestion}</span></label>`;
  };
  return `<div class="field-row">${field('harness', harness)}</div>
    <div class="field-row"><label class="field"><span class="field-label">服务商<i>*</i></span><select class="input" name="providerChoice" required><option value="">选择服务商</option>${Object.entries(PROVIDER_CHOICES).map(([value, label]) => `<option value="${value}"${provider.choice === value ? ' selected' : ''}>${label}</option>`).join('')}</select></label></div>`;
}

function refreshProvenance(form) {
  for (const type of ['harness']) {
    const choice = form.elements.namedItem(`${type}Choice`);
    if (!choice) continue;
    const other = form.elements.namedItem(`${type}Other`).value;
    $(`[data-provenance-other="${type}"]`, form).hidden = choice.value !== OTHER;
    const suggestion = $(`[data-provenance-suggestion="${type}"]`, form);
    suggestion.innerHTML = suggestionHtml(type, choice.value, other);
    suggestion.hidden = !suggestion.innerHTML;
  }
}

// With `work`, only changed fields are sent. Harness id and free text are sent together.
function provenanceBody(get, work = null) {
  const body = {};
  for (const type of ['harness']) {
    const choice = get(`${type}Choice`) ?? '';
    const other = String(get(`${type}Other`) ?? '').trim();
    if (choice === OTHER && !other) throw new Error(`请填写${PROVENANCE[type].label}名称，或改选「未注明」`);
    const next = choice === OTHER ? { id: null, other } : { id: choice || null, other: '' };
    const before = currentProvenance(work, type);
    const initial = { id: before.choice && before.choice !== OTHER ? before.choice : null, other: before.other };
    if (work ? next.id === initial.id && next.other === initial.other : !next.id && !next.other) continue;
    body[`${type}Id`] = next.id;
    body[`${type}Other`] = next.other;
  }
  const provider = get('providerChoice') ?? '';
  if (!provider) throw new Error('请选择服务商');
  if (!String(get('effort') ?? '').trim()) throw new Error('请选择或填写推理档位');
  if (work ? provider !== providerChoice(work) : provider) body.providerId = provider;
  return body;
}

const provenanceFacts = (w) => `<div><dt>Harness</dt><dd>${esc(w.harnessName || '未注明')}</dd></div>
  <div><dt>服务商</dt><dd>${esc(providerLabel(w))}</dd></div>`;

const auditList = (limit) => {
  const titles = new Map([...(state.works ?? []), ...(state.adminQuestions ?? [])].map((w) => [w.id, w.title]));
  return state.audit.length
    ? `<ol class="audit">${state.audit.slice(0, limit).map((row) => {
      const target = row.action.startsWith('question-') ? row.task : row.work;
      return `<li><time>${formatTime(row.at)}</time><span class="audit-actor">${esc(row.actor)}</span><b>${esc(ACTIONS[row.action] ?? row.action)}</b><span class="audit-work">${target ? esc(titles.get(target) ?? `${target}（已删除）`) : ''}${row.detail ? ` · ${esc(row.detail)}` : ''}</span></li>`;
    }).join('')}</ol>`
    : '<p class="muted">还没有记录。</p>';
};


function editDialog(w) {
  const curated = w.source === 'curated';
  const models = state.data?.models ?? [];
  const tasks = [...(state.data?.tasks ?? []), ...(state.questions ?? [])];
  const taskOptions = tasks.map((t) => `<option value="${esc(t.id)}"${t.id === w.task ? ' selected' : ''}>${esc(t.title)}</option>`).join('');
  const sheet = openDialog({ title: `编辑信息 · ${w.title}`, body: `<form class="admin-editor">
    <label class="field"><span class="field-label">归属题目<small>${curated ? '馆藏归属随数据包' : '改归属会连历史投票、评论、表情一起搬过去'}</small></span><select class="input" name="task"${curated ? ' disabled' : ''}>${taskOptions}</select></label>
    <label class="field"><span class="field-label">作品标题</span><input class="input" name="title" maxlength="40" value="${esc(w.title)}" required></label>
    <div class="field-row">
      <label class="field"><span class="field-label">模型名称</span><input class="input" name="modelName" maxlength="60" value="${esc(w.modelName)}" required></label>
      ${effortField(w.effort)}
    </div>
    <label class="field"><span class="field-label">登记为模型</span><select class="input" name="modelId"${curated ? ' disabled' : ''}><option value="">不登记（保持自由文本）</option>${models.map((m) => `<option value="${esc(m.id)}"${m.id === w.model ? ' selected' : ''}>${esc(m.name)}</option>`).join('')}</select></label>
    <label class="field"><span class="field-label">作品摘要</span><textarea class="input" name="summary" maxlength="200" rows="2">${esc(w.summary ?? '')}</textarea></label>
    ${provenanceFields({ harness: currentProvenance(w, 'harness'), provider: currentProvenance(w, 'provider') })}
    ${generationFields(w)}
    <label class="face-checks"><input type="checkbox" name="enterGallery"${w.show_gallery ? ' checked' : ''}> 进入展览馆<small>同时写入展览馆和正式盲测</small></label>
    <label class="face-checks"><input type="checkbox" name="pool"${w.show_entertainment ? ' checked' : ''}> 娱乐盲测</label>
    <p class="form-error" role="alert"></p><button class="btn primary" type="submit">保存</button></form>` });
  const form = $('form', sheet.el);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    let provenance;
    try { provenance = provenanceBody((name) => form.elements.namedItem(name)?.value, w); }
    catch (error) { $('.form-error', form).textContent = error.message; return; }
    const done = busy($('button[type="submit"]', form), '正在保存…');
    const enter = form.enterGallery.checked;
    const fields = { title: form.title.value, summary: form.summary.value, modelName: form.modelName.value, effort: form.effort.value, ...provenance, ...generationBody((name) => form.elements.namedItem(name)?.value, w) };
    try {
      if (curated) await api(`admin/works/${workKey(w)}/display`, { method: 'POST', body: fields });
      else await api(`admin/works/${workKey(w)}/meta`, { method: 'POST', body: { ...fields, ...(form.task.value !== w.task ? { task: form.task.value } : {}), modelId: form.modelId.value || undefined } });
      await api(`admin/works/${workKey(w)}/face-settings`, { method: 'POST', body: { show_gallery: enter, show_arena: enter, show_entertainment: form.pool.checked } });
      sheet.close();
      toast('信息已更新');
      await reload();
    } catch (error) { $('.form-error', form).textContent = error.message; done(); }
  });
}

// The camera answer arrives from the work's content origin via postMessage (server/bridge.mjs).
let calibrationCapture = null;
addEventListener('message', (event) => {
  if (event.data?.aob === 'camera' && calibrationCapture) calibrationCapture(event.data.camera);
});

// Same contain-and-offset math as the arena frontend (Show1 lib/work-framing.ts), so the
// panel preview matches what a calibrated match side will look like on the site.
function applyCalibrationFrame(mat, frame, canvas) {
  const viewWidth = mat.clientWidth;
  const viewHeight = mat.clientHeight;
  const scale = Math.min(viewWidth / canvas.width, viewHeight / canvas.height) * canvas.zoom;
  frame.style.width = `${canvas.width}px`;
  frame.style.height = `${canvas.height}px`;
  frame.style.transform = `scale(${scale})`;
  frame.style.left = `${(viewWidth - canvas.width * scale) / 2 + canvas.offsetX * viewWidth}px`;
  frame.style.top = `${(viewHeight - canvas.height * scale) / 2 + canvas.offsetY * viewHeight}px`;
}

function calibrationDialog(w) {
  const face = state.system;
  const current = w[`calibration_${face}`] ?? {};
  const framing = current.framing ?? { width: 1440, height: 900, zoom: 1, offsetX: 0, offsetY: 0 };
  const camera = current.camera ?? { position: [0, 0, 5], target: [0, 0, 0] };
  const draft = { framing: { ...framing }, camera: { position: [...camera.position], target: [...camera.target] } };
  const names = { width: '画框宽度', height: '画框高度', zoom: '缩放', offsetX: '水平偏移', offsetY: '垂直偏移',
    position0: '相机位置 X', position1: '相机位置 Y', position2: '相机位置 Z', target0: '相机目标 X', target1: '相机目标 Y', target2: '相机目标 Z' };
  const number = (name, value, min, max, step) => `<label class="field"><span class="field-label">${names[name]}</span><input class="input" type="number" data-calib-num="${name}" value="${value}" min="${min}" max="${max}" step="${step}"></label>`;
  const range = (name, min, max, step) => `<label class="calib-range"><span>${names[name]}</span><input type="range" data-calib-range="${name}" min="${min}" max="${max}" step="${step}" value="${draft.framing[name]}"><output>${draft.framing[name]}</output></label>`;
  const sheet = openDialog({ title: `${faceLabel()}取景 · ${w.title}`, className: 'sheet-calib', onClose: () => { calibrationCapture = null; }, body: `<div class="calib">
    <div class="calib-stage">
      <div class="calib-mat" data-calib-mat><div class="calib-frame" data-calib-frame><iframe data-calib-view title="取景预览「${esc(w.title)}」" loading="lazy" referrerpolicy="no-referrer"></iframe></div><div class="calib-drag" data-calib-drag title="拖动移动取景" aria-hidden="true"></div></div>
      <div class="calib-hint-row"><span class="calib-mode"><button type="button" class="btn sm on" data-calib-mode="frame">取景模式</button><button type="button" class="btn sm" data-calib-mode="camera">视角模式（可拖作品）</button></span><span class="calib-hint" data-calib-hint>正在准备预览…</span></div>
    </div>
    <form class="calib-side">
      <fieldset class="calib-group"><legend>1 · 画框 · 装下完整作品</legend>
        <div class="calib-pair">${number('width', draft.framing.width, 320, 3840, 1)}${number('height', draft.framing.height, 240, 3840, 1)}</div>
        <div class="calib-presets">${[720, 960, 1200, 1600].map((h) => `<button type="button" class="btn sm" data-calib-height="${h}">${h}px 高</button>`).join('')}</div>
      </fieldset>
      <fieldset class="calib-group"><legend>2 · 取景 · 缩放与位置</legend>
        ${range('zoom', 0.25, 4, 0.01)}${range('offsetX', -1, 1, 0.01)}${range('offsetY', -1, 1, 0.01)}
      </fieldset>
      <fieldset class="calib-group"><legend>3 · 相机 · 3D 作品</legend>
        <label class="field calib-toggle"><input type="checkbox" data-calib-camera-enabled ${current.camera ? 'checked' : ''}> 使用相机参数</label>
        <div class="calib-row"><button type="button" class="btn sm primary" data-calib-grab disabled>抓取当前视角</button><span class="calib-cam-state" data-calib-cam-state>预览就绪后，把作品转到满意的角度再抓取。</span></div>
        <div class="calib-pair">${['position', 'target'].flatMap((key) => [0, 1, 2].map((i) => number(`${key}${i}`, draft.camera[key][i], -9999999, 9999999, 'any'))).join('')}</div>
      </fieldset>
      <label class="field calib-toggle"><input type="checkbox" data-calib-framing-enabled ${current.framing ? 'checked' : ''}> 使用画框取景（不勾则前台按原始比例显示）</label>
      <p class="form-error" role="alert"></p>
      <div class="actions"><button class="btn primary" type="submit">保存取景</button><button class="btn" type="button" data-clear-calibration>清空取景</button></div>
    </form></div>` });
  const form = $('form', sheet.el);
  const mat = $('[data-calib-mat]', sheet.el);
  const frame = $('[data-calib-frame]', sheet.el);
  const view = $('[data-calib-view]', sheet.el);
  const hint = $('[data-calib-hint]', sheet.el);
  const grab = $('[data-calib-grab]', sheet.el);
  const camState = $('[data-calib-cam-state]', sheet.el);
  const paint = () => applyCalibrationFrame(mat, frame, draft.framing);
  const syncInputs = () => {
    for (const el of $$('[data-calib-num]', form)) {
      const key = el.dataset.calibNum;
      if (key in draft.framing) el.value = Math.round(draft.framing[key] * 100) / 100;
    }
    for (const el of $$('[data-calib-range]', form)) {
      const key = el.dataset.calibRange;
      el.value = draft.framing[key];
      el.nextElementSibling.value = Math.round(draft.framing[key] * 100) / 100;
    }
    paint();
  };
  const save = async (calibration) => {
    const done = busy($('button[type="submit"]', form), '正在保存…');
    $('[data-clear-calibration]', form).disabled = true;
    try { await api(`admin/works/${workKey(w)}/calibration`, { method: 'POST', body: { face, calibration } }); sheet.close(); toast('取景已保存'); await reload(); }
    catch (error) { $('.form-error', form).textContent = error.message; done(); $('[data-clear-calibration]', form).disabled = false; }
  };
  // Live preview: a short-lived content-origin key makes any work (curated or upload)
  // viewable, with the bridge answering the camera handshake (?aob=bridge&face=…).
  (async () => {
    try {
      const { url } = await api(`admin/works/${workKey(w)}/preview`, { method: 'POST' });
      view.src = `${url}${url.includes('?') ? '&' : '?'}aob=bridge&face=${face}`;
      grab.disabled = false;
      hint.textContent = '拖动画面移动取景；滑杆与数字实时联动。取景只改显示，不改作品文件。';
    } catch {
      hint.textContent = '预览暂不可用，仍可手动填写参数保存。';
    }
  })();
  const onResize = () => paint();
  addEventListener('resize', onResize);
  const wasClose = sheet.close.bind(sheet);
  sheet.close = () => { removeEventListener('resize', onResize); wasClose(); };
  for (const el of $$('[data-calib-height]', form)) el.addEventListener('click', () => { draft.framing.height = Number(el.dataset.calibHeight); syncInputs(); });
  for (const el of $$('[data-calib-range]', form)) el.addEventListener('input', () => { draft.framing[el.dataset.calibRange] = Number(el.value); syncInputs(); });
  for (const el of $$('[data-calib-num]', form)) el.addEventListener('input', () => {
    const key = el.dataset.calibNum;
    const value = Number(el.value);
    if (!(key in draft.framing) || !Number.isFinite(value)) return;
    draft.framing[key] = key === 'width' || key === 'height' ? Math.round(value) : value;
    paint();
  });
  // Drag-to-frame: pointer travel maps to offset in units of the visible viewport.
  // Camera mode lets pointer events fall through to the work itself, so its OrbitControls
  // can be turned before capture (the pre-fusion admin used a separate dialog for this).
  const dragLayer = $('[data-calib-drag]', sheet.el);
  for (const btn of $$('[data-calib-mode]', sheet.el)) btn.addEventListener('click', () => {
    const cameraMode = btn.dataset.calibMode === 'camera';
    for (const other of $$('[data-calib-mode]', sheet.el)) other.classList.toggle('on', other === btn);
    dragLayer.style.pointerEvents = cameraMode ? 'none' : '';
    hint.textContent = cameraMode ? '视角模式：直接拖动作品转到满意角度，然后「抓取当前视角」。' : '拖动画面移动取景；滑杆与数字实时联动。取景只改显示，不改作品文件。';
  });
  let drag = null;
  dragLayer.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY, offsetX: draft.framing.offsetX, offsetY: draft.framing.offsetY };
    dragLayer.setPointerCapture(e.pointerId);
  });
  dragLayer.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const clamp = (v) => Math.min(1, Math.max(-1, v));
    draft.framing.offsetX = clamp(drag.offsetX + (e.clientX - drag.x) / mat.clientWidth);
    draft.framing.offsetY = clamp(drag.offsetY + (e.clientY - drag.y) / mat.clientHeight);
    syncInputs();
  });
  const endDrag = () => { drag = null; };
  dragLayer.addEventListener('pointerup', endDrag);
  dragLayer.addEventListener('pointercancel', endDrag);
  grab.addEventListener('click', () => {
    camState.textContent = '等待回包…';
    view.contentWindow?.postMessage({ aob: 'get-camera' }, '*');
  });
  calibrationCapture = (cam) => {
    if (!cam) { camState.textContent = '这件作品没有可抓取的 3D 相机（可能是纯 2D 页面）。'; return; }
    draft.camera = { position: [...cam.position], target: [...cam.target] };
    for (const key of ['position', 'target']) [0, 1, 2].forEach((i) => { form.querySelector(`[data-calib-num="${key}${i}"]`).value = Math.round(cam[key][i] * 1000) / 1000; });
    $('[data-calib-camera-enabled]', form).checked = true;
    camState.textContent = '已抓取当前视角 ✓';
  };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const num = (name) => Number(form.querySelector(`[data-calib-num="${name}"]`).value);
    // Framing lives in draft (sliders, drag and numbers all keep it current); camera
    // inputs are read from the DOM because hand edits there are authoritative.
    const patch = { framing: $('[data-calib-framing-enabled]', form).checked ? { ...draft.framing } : null,
      camera: $('[data-calib-camera-enabled]', form).checked
        ? { position: [0, 1, 2].map((i) => num(`position${i}`)), target: [0, 1, 2].map((i) => num(`target${i}`)) } : null };
    save(patch);
  });
  $('[data-clear-calibration]', sheet.el).addEventListener('click', () => save(null));
  setTimeout(paint);
}

async function editorialDialog(taskId) {
  const face = state.system;
  const label = face === 'gallery' ? '展览馆' : '竞技场';
  const sheet = openDialog({ title: `${label}主编视角 · ${taskTitle(taskId)}`, body: skeleton(4) });
  let current;
  try { current = await api(`admin/tasks/${encodeURIComponent(taskId)}/editorial?face=${face}`); }
  catch (error) { if (sheet.el.isConnected) $('.sheet-body', sheet.el).innerHTML = `<p class="form-error" role="alert">${esc(error.message)}</p>`; return; }
  if (!sheet.el.isConnected) return;
  const weights = current.weights ?? [0.166, 0.166, 0.167, 0.167, 0.167, 0.167];
  const labels = ['视觉设计', '空间营造', '动态表现', '文字表达', '思辨推理', '创意构思'];
  $('.sheet-body', sheet.el).innerHTML = `<form class="admin-editor">
    <label class="field"><span class="field-label">${face === 'gallery' ? '策展文案' : '题目点评'}</span><textarea class="input" name="commentary" rows="8" maxlength="4000">${esc(current.commentary)}</textarea></label>
    ${face === 'arena' ? `<div class="weight-list">${labels.map((label, i) => `<label><span>${label}</span><input type="range" name="weight${i}" min="0" max="1" step="0.001" value="${weights[i]}"><output>${weights[i].toFixed(3)}</output></label>`).join('')}</div><p class="weight-sum">权重和：<strong></strong>（须为 1）</p>` : ''}
    <p class="form-error" role="alert"></p><button class="btn primary" type="submit">保存</button></form>`;
  const form = $('form', sheet.el);
  const update = () => {
    if (face !== 'arena') return;
    const values = labels.map((_, i) => Number(form.elements.namedItem(`weight${i}`).value));
    $$('.weight-list output', form).forEach((out, i) => { out.value = values[i].toFixed(3); });
    const sum = values.reduce((a, b) => a + b, 0);
    $('.weight-sum strong', form).textContent = sum.toFixed(3);
    $('button[type="submit"]', form).disabled = Math.abs(sum - 1) > 0.001;
  };
  form.addEventListener('input', update); update();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = { face, commentary: form.elements.namedItem('commentary').value };
    if (face === 'arena') body.weights = labels.map((_, i) => Number(form.elements.namedItem(`weight${i}`).value));
    const done = busy($('button[type="submit"]', form), '正在保存…');
    try { await api(`admin/tasks/${encodeURIComponent(taskId)}/editorial`, { method: 'POST', body }); sheet.close(); toast('主编视角已保存'); }
    catch (error) { $('.form-error', form).textContent = error.message; done(); update(); }
  });
}

// -- users tab --
function usersView() {
  const users = state.users ?? [];
  const rows = users.map((u) => {
    const self = u.id === state.user.id;
    const target = u.role === 'admin' ? 'member' : 'admin';
    return `<tr>
      <td class="c-title"><span class="avatar" aria-hidden="true">${esc(u.name.slice(0, 1).toUpperCase())}</span><b>${esc(u.name)}</b>${self ? '<span class="badge">当前账号</span>' : ''}</td>
      <td><span class="status role-${esc(u.role)}">${icon(u.role === 'admin' ? 'shield' : 'user')}${u.role === 'admin' ? '管理员' : '成员'}</span></td>
      <td><time>${formatTime(u.createdAt)}</time></td>
      <td class="c-actions"><button class="btn sm${target === 'admin' ? ' primary' : ''}" data-role="${esc(u.id)}" data-target="${target}"${self ? ' disabled title="不能修改自己的角色"' : ''}>${target === 'admin' ? '设为管理员' : '设为成员'}</button></td>
    </tr>`;
  }).join('');
  return `${pageHero('用户管理', '用户', '账号与角色。管理员可以审核作品、调整其他账号的角色；自己的角色只能由别的管理员修改。', [['账号', users.length], ['管理员', users.filter((u) => u.role === 'admin').length]])}
  <section class="block">
    ${state.users === null ? skeleton(5) : `<div class="table-wrap"><table class="board users-table">
      <thead><tr><th class="c-title">用户名</th><th>角色</th><th>注册时间</th><th class="c-actions">操作</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`}
  </section>`;
}

// -- login / forbidden --
let turnstileLoader;
function loadTurnstile() {
  if (globalThis.turnstile) return Promise.resolve();
  if (!turnstileLoader) {
    turnstileLoader = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      script.onload = () => globalThis.turnstile ? resolve() : script.onerror();
      script.onerror = () => { script.remove(); reject(new Error('人机验证加载失败，请刷新页面重试。')); };
      document.head.append(script);
    }).catch((error) => { turnstileLoader = null; throw error; });
  }
  return turnstileLoader;
}
function loginView() {
  app().innerHTML = `<main class="gate">
    <div class="gate-panel">
      <div class="gate-brand">${LOGO}</div>
      <p class="eyebrow"><span class="eyebrow-mark" aria-hidden="true"></span>管理后台</p>
      <h1>管理后台<span class="stop">。</span></h1>
      <p class="gate-lead">同题异答展厅的共用管理端：审核投稿、管理作品与账号角色。需要管理员账号。</p>
      <form class="gate-form" novalidate>
        <label class="field"><span class="field-label">用户名</span><input class="input" name="name" autocomplete="username" maxlength="24" required></label>
        <label class="field"><span class="field-label">密码</span><input class="input" name="password" type="password" autocomplete="current-password" maxlength="128" required></label>
        <div class="auth-turnstile" hidden></div>
        <p class="auth-turnstile-status" role="status"></p>
        <p class="form-error" role="alert"></p>
        <button class="btn primary full" type="submit">登录</button>
      </form>
      <div class="gate-foot">${themeButton()}</div>
    </div>
  </main>`;
  const form = $('form', app());
  let token = '';
  let widget;
  let challengeError;
  const ready = (async () => {
    const { siteKey } = await api('auth/turnstile');
    if (siteKey !== null && (typeof siteKey !== 'string' || !siteKey)) throw new Error('人机验证加载失败，请刷新页面重试。');
    if (!siteKey) return;
    await loadTurnstile();
    if (!form.isConnected) return;
    const host = $('.auth-turnstile', form);
    host.hidden = false;
    widget = globalThis.turnstile.render(host, {
      sitekey: siteKey,
      size: 'flexible',
      callback(value) { token = value; $('.auth-turnstile-status', form).textContent = ''; },
      'expired-callback'() { token = ''; globalThis.turnstile.reset(widget); },
      'error-callback'() { token = ''; $('.auth-turnstile-status', form).textContent = '人机验证暂时失败，请稍候重试。'; },
    });
    if (widget === undefined || widget === null) throw new Error('人机验证无法显示，请刷新页面重试。');
  })().catch((error) => {
    challengeError = error;
    if (form.isConnected) $('.form-error', form).textContent = error.message;
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if ($('[type="submit"]', form).disabled) return;
    const doneBusy = busy($('[type="submit"]', form), '正在登录…');
    let sent = false;
    try {
      await ready;
      if (challengeError) throw challengeError;
      if (widget !== undefined && !token) throw new Error('请先完成人机验证。');
      const body = { name: form.name.value, password: form.password.value, turnstileToken: token };
      token = '';
      sent = true;
      await api('auth/login', { method: 'POST', body });
      if (widget !== undefined) { globalThis.turnstile.remove(widget); widget = undefined; }
      await boot();
      toast('欢迎回来');
    } catch (error) {
      $('.form-error', form).textContent = error.message;
      doneBusy();
    } finally {
      if (sent && widget !== undefined && form.isConnected) globalThis.turnstile.reset(widget);
    }
  });
  setTimeout(() => form.name.focus());
}

function forbiddenView() {
  app().innerHTML = `<main class="gate">
    <div class="gate-panel">
      <div class="gate-brand">${LOGO}</div>
      <p class="eyebrow"><span class="eyebrow-mark" aria-hidden="true"></span>管理后台</p>
      <h1>需要管理员权限<span class="stop">。</span></h1>
      <p class="gate-lead">当前账号「${esc(state.user.name)}」不是管理员。管理员可以在用户页调整角色，或由维护者在服务器上运行 <code>npm run admin -- &lt;用户名&gt;</code>。</p>
      <div class="actions">
        <button class="btn primary" data-logout>${icon('logout')}退出登录</button>
        ${themeButton()}
      </div>
    </div>
  </main>`;
}

// ---- render loop -----------------------------------------------------------------------------
function worksQuery() {
  const query = new URLSearchParams({ page: state.workPage, pageSize: 30, face: state.system });
  if (state.workTask) query.set('task', state.workTask);
  if (state.workStatus) query.set('status', state.workStatus);
  if (state.workShow) query.set('show', state.workShow);
  if (state.workHarness) query.set('harness', state.workHarness);
  if (state.workProvider) query.set('provider', state.workProvider);
  if (state.workModel) query.set('model', state.workModel);
  if (state.workEffort) query.set('effort', state.workEffort);
  if (state.workGenerationMode) query.set('generationMode', state.workGenerationMode);
  if (state.workHumanIntervention) query.set('humanIntervention', state.workHumanIntervention);
  if (state.workSearch) query.set('search', state.workSearch);
  return query;
}
// Works filters live in the hash (#/works?task=…&status=…) so views can be shared as links.
function syncWorksHash() {
  const hash = `#/works${[state.workTask, state.workStatus, state.workShow, state.workHarness, state.workProvider, state.workModel, state.workEffort, state.workGenerationMode, state.workHumanIntervention, state.workSearch].some(Boolean) || state.workPage > 1 ? `?${worksQuery()}` : ''}`;
  history.replaceState(null, '', hash);
}
function applyWorksHash() {
  const query = new URLSearchParams(location.hash.split('?')[1] ?? '');
  const pick = (key, fallback) => (query.has(key) ? String(query.get(key) ?? '') : fallback);
  state.workPage = Math.max(1, Number(pick('page', '1')) || 1);
  state.workTask = pick('task', state.workTask);
  state.workStatus = pick('status', state.workStatus);
  state.workShow = pick('show', state.workShow);
  state.workHarness = pick('harness', state.workHarness);
  state.workProvider = pick('provider', state.workProvider);
  state.workModel = pick('model', state.workModel);
  state.workEffort = pick('effort', state.workEffort);
  state.workGenerationMode = pick('generationMode', state.workGenerationMode);
  state.workHumanIntervention = pick('humanIntervention', state.workHumanIntervention);
  state.workSearch = pick('search', state.workSearch);
}
const rowSignatures = new Map();
let renderedWorkSignature = '';
let renderedContent = '';
let worldTimer = 0;
function patchWorks(newMain) {
  const oldMain = $('main.page', app());
  const oldResults = $('.work-results', oldMain);
  const newResults = $('.work-results', newMain);
  const oldBody = $('tbody', oldResults);
  const newBody = $('tbody', newResults);
  if (oldBody && newBody) {
    const existing = new Map($$('tr[data-work-key]', oldBody).map((row) => [row.dataset.workKey, row]));
    const nextKeys = new Set();
    [...newBody.children].forEach((fresh, index) => {
      const key = fresh.dataset.workKey;
      nextKeys.add(key);
      const work = state.adminWorks[index];
      const signature = JSON.stringify(work);
      let row = existing.get(key);
      if (!row || rowSignatures.get(key) !== signature) {
        if (row) row.replaceWith(fresh);
        row = fresh;
        row.classList.add('row-enter');
        rowSignatures.set(key, signature);
      }
      if (oldBody.children[index] !== row) oldBody.insertBefore(row, oldBody.children[index] || null);
    });
    existing.forEach((row, key) => { if (!nextKeys.has(key)) { row.remove(); rowSignatures.delete(key); } });
  } else if (oldResults.innerHTML !== newResults.innerHTML) {
    oldResults.replaceWith(newResults);
    rowSignatures.clear();
    state.adminWorks.forEach((w) => rowSignatures.set(`${w.task}/${w.id}`, JSON.stringify(w)));
  }
  for (const selector of ['.page-hero', '.admin-pagination', '.page-error']) {
    const oldEl = $(selector, oldMain);
    const newEl = $(selector, newMain);
    if (oldEl && newEl && oldEl.innerHTML !== newEl.innerHTML) oldEl.innerHTML = newEl.innerHTML;
    else if (!oldEl && newEl) oldMain.prepend(newEl);
    else if (oldEl && !newEl) oldEl.remove();
  }
}
async function reload({ navigation = false } = {}) {
  const requestId = ++state.requestId;
  const [route = 'works'] = routeParts();
  const system = state.system;
  if (route === 'review') { location.replace(REVIEW_URL); return; }
  if (!routeAllowed(route)) { location.hash = system === 'common' ? '#/dashboard' : '#/works'; return; }
  let key = '';
  if (route === 'works') {
    if (navigation) applyWorksHash();
    key = worksQuery().toString();
    if (navigation || state.workKey !== key) {
      const cached = state.workCache.get(key);
      state.workKey = key;
      state.adminWorks = cached?.works ?? [];
      state.workTotal = cached?.total ?? 0;
      state.workLoading = !cached;
    }
  } else if (route === 'traffic' && !state.traffic) state.trafficLoading = true;
  if (navigation || !app().dataset.shell) render({ soft: route === 'works' && !state.workLoading });
  try {
    if (route === 'users') state.users = (await api('admin/users')).users;
    else if (route === 'works') {
      const data = await api(`admin/works?${key}`);
      if (requestId !== state.requestId || system !== state.system || routeParts()[0] !== 'works') return;
      state.workCache.set(key, data);
      if (state.workCache.size > 24) state.workCache.delete(state.workCache.keys().next().value);
      state.adminWorks = data.works;
      state.workTotal = data.total;
      state.workEfforts = data.efforts ?? [];
      state.workLoading = false;
    } else if (route === 'traffic') {
      state.traffic = await api('admin/traffic?days=30');
      state.trafficLoading = false;
    } else if (route === 'dashboard') {
      const [review, traffic] = await Promise.all([api('review'), state.traffic ? Promise.resolve(state.traffic) : api('admin/traffic?days=30')]);
      state.audit = review.audit;
      if (!state.traffic) state.traffic = traffic;
    }     else if (route === 'upload') await loadInbox();
    else if (route === 'intake') state.intake = (await api('admin/inbox/works')).works;
    if (requestId !== state.requestId) return;
    state.error = '';
  } catch (error) {
    if (requestId !== state.requestId) return;
    if (error.status === 401 || error.status === 403) { await boot(); return; }
    state.error = error.message;
    state.workLoading = false;
    state.trafficLoading = false;
  }
  render({ soft: true });
}

function render({ soft = false, world = false } = {}) {
  syncThemeUi();
  if (state.user === undefined) { app().innerHTML = `<main class="gate">${skeleton(3)}</main>`; return; }
  if (!state.user) return loginView();
  if (state.user.role !== 'admin') return forbiddenView();
  const [route = 'works', sub] = routeParts();
  if (route === 'review') { location.replace(REVIEW_URL); return; }
  if (!routeAllowed(route, sub)) { location.hash = state.system === 'common' ? '#/dashboard' : '#/works'; return; }
  const body = state.system === 'common'
    ? route === 'upload' ? uploadView() : route === 'users' ? usersView() : route === 'traffic' ? trafficView() : dashboardView()
    : route === 'works' ? systemWorksView() : route === 'intake' ? intakeView() : route === 'tasks' ? tasksView() : placeholderView(route);
  const content = `${state.error ? `<p class="form-error page-error">${esc(state.error)}</p>` : ''}${body}`;
  const shellKey = `${state.system}/${route}/${sub || ''}`;
  const currentMain = $('main.page', app());
  const sameShell = app().dataset.shell === shellKey && currentMain;
  const workSignature = route === 'works' ? `${state.workKey}:${state.workLoading}:${state.workTotal}:${JSON.stringify(state.adminWorks)}:${state.error}` : '';
  if (!sameShell) {
    const prevRoute = String(app().dataset.shell ?? '').split('/')[1];
    app().dataset.shell = shellKey;
    const template = document.createElement('div');
    template.innerHTML = state.system === 'arena'
      ? `<div class="workspace ${state.sidebarCollapsed ? 'is-collapsed' : ''}">${arenaSidebar(route, sub)}<div class="workspace-content">${topbar(route)}<main class="page">${content}</main></div></div>`
      : `${topbar(route)}<main class="page">${content}</main>`;
    // 同路由且渲染内容不变时移植现有内容节点：已解码的图片和滚动位置原样保留，消除整表闪动。
    // （作品表两边列不同、必须重建；流量/用户/审核等内容与系统无关，走移植。）
    const freshMain = $('main.page', template);
    if (freshMain && currentMain && prevRoute === route && renderedContent === content) freshMain.replaceWith(currentMain);
    app().replaceChildren(...template.childNodes);
    rowSignatures.clear();
    if (route === 'works' && !state.workLoading) state.adminWorks.forEach((w) => rowSignatures.set(`${w.task}/${w.id}`, JSON.stringify(w)));
    renderedWorkSignature = workSignature;
    renderedContent = content;
    if (world && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      clearTimeout(worldTimer);
      app().classList.add('world-enter');
      worldTimer = setTimeout(() => app().classList.remove('world-enter'), 440);
    }
  } else if (route === 'works' && soft && !state.workLoading) {
    if (workSignature !== renderedWorkSignature) {
      const template = document.createElement('main'); template.className = 'page'; template.innerHTML = content;
      patchWorks(template);
      renderedWorkSignature = workSignature;
      renderedContent = content;
    }
  } else if (renderedContent !== content) {
    currentMain.innerHTML = content;
    renderedWorkSignature = workSignature;
    renderedContent = content;
  }
  document.title = `${route === 'guess' ? '模一把' : route === 'activity' ? '活动管理' : tabsForSystem().find((tab) => tab.id === route)?.label ?? '管理后台'} · 管理后台`;
  if (route === 'works') updateBulkSelection();
  syncThemeUi();
}

async function boot() {
  try {
    const data = await api('bootstrap');
    state.user = data.user;
    state.questions = data.questions;
    state.reviewCounts = data.review;
    state.site = data.site;
    state.adminQuestions = null;
  } catch {
    state.user = null;
  }
  if (state.user?.role === 'admin') {
    applySystemTheme();
    state.works = null;
    state.users = null;
    state.workLoading = routeParts()[0] === 'works';
    render();
    await loadCatalog();
    await reload({ navigation: true });
  }
  render();
}

// ---- events ----------------------------------------------------------------------------------
document.addEventListener('click', async (e) => {
  const system = e.target.closest('[data-system]');
  if (system && state.system !== system.dataset.system) {
    state.system = system.dataset.system; store.set('admin-system', state.system); state.workPage = 1;
    applySystemTheme();
    if (routeParts()[0] === 'review') { location.replace(REVIEW_URL); return; }
    if (!routeAllowed(routeParts()[0])) location.hash = state.system === 'common' ? '#/dashboard' : '#/works';
    if (routeParts()[0] === 'works') {
      const cached = state.workCache.get(worksQuery().toString());
      state.adminWorks = cached?.works ?? [];
      state.workTotal = cached?.total ?? 0;
      state.workLoading = !cached;
    }
    render({ world: true });
    reload();
    return;
  }
  const gotoSystem = e.target.closest('[data-goto-system]');
  if (gotoSystem && state.system !== gotoSystem.dataset.gotoSystem) {
    state.system = gotoSystem.dataset.gotoSystem; store.set('admin-system', state.system);
    applySystemTheme();
    location.hash = '#/works';
    return;
  }
  if (e.target.closest('[data-sidebar-collapse]')) {
    state.sidebarCollapsed = !state.sidebarCollapsed;
    store.set('admin-sidebar-collapsed', state.sidebarCollapsed ? '1' : '0');
    $('.workspace')?.classList.toggle('is-collapsed', state.sidebarCollapsed);
    const button = $('[data-sidebar-collapse]');
    button?.setAttribute('aria-expanded', String(!state.sidebarCollapsed));
    button?.setAttribute('aria-label', state.sidebarCollapsed ? '展开侧栏' : '折叠侧栏');
    button.title = state.sidebarCollapsed ? '展开侧栏' : '折叠侧栏';
    return;
  }
  if (e.target.closest('[data-theme-toggle]')) { toggleTheme(); return; }
  const inboxPick = e.target.closest('[data-inbox-pick]');
  if (inboxPick) { $('.inbox-panel [data-inbox-input]')?.click(); return; }
  const inboxReload = e.target.closest('[data-inbox-reload]');
  if (inboxReload) { toast('正在刷新收件箱…'); await loadInbox(); render({ soft: true }); return; }
  const inboxRemove = e.target.closest('[data-inbox-remove]');
  if (inboxRemove) {
    const card = inboxRemove.closest('[data-inbox-id]');
    const id = card?.dataset.inboxId;
    if (id && await confirmDialog({ title: '移除这个文件？', message: '文件会从收件箱删除，不会登记为作品。', confirm: '移除', danger: true })) {
      try { await api(`admin/inbox?id=${encodeURIComponent(id)}`, { method: 'DELETE' }); delete state.inboxForms[id]; await loadInbox(); render({ soft: true }); }
      catch (error) { toast(error.message); }
    }
    return;
  }
  const page = e.target.closest('[data-page]');
  if (page && !page.disabled) { state.workPage = Number(page.dataset.page); syncWorksHash(); await reload({ navigation: true }); return; }
  const bulk = e.target.closest('[data-bulk-face]');
  if (bulk && !bulk.disabled) {
    const keys = new Set($$('[data-select-work]:checked', $('.work-results', app())).map((input) => input.dataset.selectWork));
    const works = state.adminWorks.filter((work) => keys.has(`${work.task}/${work.id}`));
    if (!works.length || !await confirmDialog({ title: `批量${bulk.dataset.bulkFace === 'on' ? '开启' : '关闭'}${faceLabel()}？`,
      message: `将修改本页选中的 ${works.length} 件作品。`, confirm: '确认修改' })) return;
    const done = busy(bulk, '正在保存…');
    try {
      await api('admin/works/batch-face-settings', { method: 'POST', body: {
        works: works.map(({ task, id }) => ({ task, id })), [`show_${state.system}`]: bulk.dataset.bulkFace === 'on' } });
      $$('[data-select-work]:checked', $('.work-results', app())).forEach((input) => { input.checked = false; });
      state.workCache.clear();
      toast(`已更新 ${works.length} 件作品`);
      await reload();
    } catch (error) { toast(error.message); }
    finally { done(); updateBulkSelection(); }
    return;
  }
  const calibrate = e.target.closest('[data-calibrate]');
  if (calibrate) { const w = state.adminWorks.find((item) => item.id === calibrate.dataset.calibrate); if (w) calibrationDialog(w); return; }
  const editBtn = e.target.closest('[data-edit]');
  if (editBtn) {
    const w = [...state.adminWorks, ...(state.intake ?? [])].find((item) => item.id === editBtn.dataset.edit);
    if (w) editDialog(w);
    return;
  }
  if (e.target.closest('[data-new-question]')) { newQuestionDialog(); return; }
  const nominateBtn = e.target.closest('[data-nominate]');
  if (nominateBtn) {
    const w = state.adminWorks.find((item) => item.id === nominateBtn.dataset.nominate);
    if (!w) return;
    const doneBusy = busy(nominateBtn, '正在提名…');
    try {
      const data = await api(`admin/works/${workKey(w)}/nominate`, { method: 'POST' });
      const sheet = openDialog({ title: '复制收录命令', body: `<p class="sheet-text">在 arenaofbias-data 仓库执行。命令中的导出令牌 14 天有效，请妥善保管。</p><textarea readonly rows="4" style="width:100%">${esc(data.command)}</textarea><div class="sheet-actions"><button class="btn primary" data-copy-command>复制命令</button></div>` });
      $('[data-copy-command]', sheet.el).addEventListener('click', async () => { await navigator.clipboard.writeText(data.command); toast('命令已复制'); });
      await reload();
    } catch (error) { toast(error.message); doneBusy(); }
    return;
  }
  const withdrawBtn = e.target.closest('[data-withdraw]');
  if (withdrawBtn) {
    const w = state.adminWorks.find((item) => item.id === withdrawBtn.dataset.withdraw);
    if (!w || !await confirmDialog({ title: '撤回提名？', message: '现有导出命令会立即失效。', confirm: '撤回提名' })) return;
    try { await api(`admin/works/${workKey(w)}/nominate`, { method: 'DELETE' }); toast('提名已撤回'); await reload(); }
    catch (error) { toast(error.message); }
    return;
  }
  const note = e.target.closest('[data-task-note]');
  if (note) { await editorialDialog(note.dataset.taskNote); return; }
  if (e.target.closest('[data-logout]')) {
    toast('正在退出登录…');
    await api('auth/logout', { method: 'POST' }).catch(() => {});
    state.user = null;
    state.works = null;
    state.users = null;
    render();
    toast('已退出登录');
    return;
  }
  const filter = e.target.closest('[data-filter]');
  if (filter) { state.worksFilter = filter.dataset.filter; render(); return; }
  const deleteBtn = e.target.closest('[data-delete]');
  if (deleteBtn) {
    const work = state.works?.find((w) => w.id === deleteBtn.dataset.delete);
    if (work && await removeWork(work)) await reload();
    return;
  }
  const roleBtn = e.target.closest('[data-role]');
  if (roleBtn && !roleBtn.disabled) {
    const target = roleBtn.dataset.target;
    const user = state.users?.find((u) => u.id === roleBtn.dataset.role);
    if (!user) return;
    const doneBusy = busy(roleBtn, '正在保存…');
    try {
      await api(`admin/users/${encodeURIComponent(user.id)}/role`, { method: 'POST', body: { role: target } });
      toast(`${user.name} 现在是${target === 'admin' ? '管理员' : '普通成员'}`);
      await reload();
    } catch (error) {
      toast(error.message);
      doneBusy();
    }
  }
});
document.addEventListener('change', async (e) => {
  const selectAll = e.target.closest('[data-select-all]');
  if (selectAll) {
    $$('[data-select-work]:not(:disabled)', $('.work-results', app())).forEach((input) => { input.checked = selectAll.checked; });
    updateBulkSelection();
    return;
  }
  if (e.target.closest('[data-select-work]')) { updateBulkSelection(); return; }
  const input = e.target.closest('[data-inbox-input]');
  if (input) {
    if (input.files.length) await inboxUpload(input.files);
    input.value = '';
    return;
  }
  const toggle = e.target.closest('[data-face-toggle], [data-entertainment-toggle]');
  if (!toggle) return;
  const entertainment = toggle.hasAttribute('data-entertainment-toggle');
  const work = [...state.adminWorks, ...(state.works ?? [])].find((item) => item.id === (entertainment ? toggle.dataset.entertainmentToggle : toggle.dataset.faceToggle));
  if (!work) return;
  toggle.disabled = true;
  toggle.parentElement.classList.add('is-saving');
  toggle.parentElement.setAttribute('aria-busy', 'true');
  try {
    await api(`admin/works/${workKey(work)}/face-settings`, { method: 'POST', body: { [entertainment ? 'show_entertainment' : `show_${state.system}`]: toggle.checked } });
    toast(entertainment ? `娱乐盲测已${toggle.checked ? '开启' : '关闭'}` : `${state.system === 'arena' ? '正式盲测' : '展览馆开关'}已${toggle.checked ? '开启' : '关闭'}`);
    await reload();
  } catch (error) { toggle.checked = !toggle.checked; toggle.disabled = false; toast(error.message); }
  finally { if (toggle.isConnected) { toggle.disabled = false; toggle.parentElement.classList.remove('is-saving'); toggle.parentElement.removeAttribute('aria-busy'); } }
});
// Provenance fields: show the free-text box, enable the version, offer a registry match.
document.addEventListener('input', (e) => {
  if (e.target.matches?.('[data-provenance-choice], [name="harnessOther"]')) refreshProvenance(e.target.form);
});
document.addEventListener('click', (e) => {
  const pick = e.target.closest?.('[data-pick-provenance]');
  if (!pick) return;
  const select = pick.form.elements.namedItem(`${pick.dataset.pickProvenance}Choice`);
  if (![...select.options].some((option) => option.value === pick.dataset.id)) {
    const entry = registry(pick.dataset.pickProvenance).find((item) => item.id === pick.dataset.id);
    select.add(new Option(`${entry.name}（已停用）`, entry.id), select.options[select.options.length - 1]);
  }
  select.value = pick.dataset.id;
  // Bubbles to the inbox listener below, which keeps the stored form in sync.
  select.dispatchEvent(new Event('input', { bubbles: true }));
});
// Inbox form fields survive re-renders through state.inboxForms (keyed by entry id).
document.addEventListener('input', (e) => {
  const card = e.target.closest('.inbox-card[data-inbox-id]');
  const form = e.target.closest('form');
  if (!card || !form || !state.inboxForms[card.dataset.inboxId]) return;
  const stored = state.inboxForms[card.dataset.inboxId];
  if (e.target.name in stored) stored[e.target.name] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
  // Picking a catalog model back-fills the display name (editable afterwards).
  if (e.target.name === 'modelId' && stored.modelId) {
    const label = e.target.selectedOptions?.[0]?.textContent ?? '';
    stored.modelName = label;
    const nameInput = $('input[name="modelName"]', card);
    if (nameInput) nameInput.value = label;
  }
});
document.addEventListener('submit', async (e) => {
  if (e.target.classList?.contains('inbox-form')) {
    e.preventDefault();
    const card = e.target.closest('[data-inbox-id]');
    const id = card?.dataset.inboxId;
    const stored = state.inboxForms[id];
    if (!id || !stored) return;
    const error = $('.form-error', e.target);
    if (!stored.task) { error.textContent = '请选择题目'; return; }
    if (!stored.modelId && !stored.modelName.trim()) { error.textContent = '请填写模型名称，或从「登记为模型」里选择'; return; }
    let provenance;
    try { provenance = provenanceBody((name) => stored[name]); }
    catch (err) { error.textContent = err.message; return; }
    const done = busy($('button[type="submit"]', e.target), '正在登记…');
    try {
      const data = await api('admin/inbox/register', { method: 'POST', body: {
        id, task: stored.task, title: stored.title, summary: stored.summary, modelId: stored.modelId || undefined,
        modelName: stored.modelName, effort: stored.effort, ...provenance, ...generationBody((name) => stored[name]) } });
      store.set('admin-inbox-task', stored.task);
      delete state.inboxForms[id];
      state.workCache.clear();
      toast(`已入库并上展览馆：${data.work.title}`);
      await loadInbox();
      render({ soft: true });
    } catch (err) { error.textContent = err.message; done(); }
    return;
  }
  if (e.target.id === 'intake-assign') {
    e.preventDefault();
    const picked = $$('[data-intake-id]:checked').map((input) => ({ task: input.dataset.intakeTask, id: input.dataset.intakeId }));
    if (!picked.length) { toast('请先选择作品'); return; }
    const task = e.target.elements.namedItem('task').value;
    if (!task) { toast('请选择题目'); return; }
    const done = busy($('button[type="submit"]', e.target), '正在归属…');
    try {
      await api('admin/works/batch-inbox', { method: 'POST', body: {
        works: picked, task, entertainment: e.target.elements.namedItem('entertainment').checked,
      } });
      toast('已归属，作品离开收件箱');
      await reload();
    } catch (error) { toast(error.message); done(); }
    return;
  }
  if (e.target.id !== 'admin-work-filter') return;
  e.preventDefault();
  const form = e.target;
  state.workSearch = form.elements.namedItem('search').value.trim();
  state.workTask = form.elements.namedItem('task').value;
  state.workStatus = form.elements.namedItem('status').value;
  state.workShow = form.elements.namedItem('show').value;
  state.workHarness = form.elements.namedItem('harness').value;
  state.workProvider = form.elements.namedItem('provider').value;
  state.workModel = form.elements.namedItem('model').value;
  state.workEffort = form.elements.namedItem('effort').value.trim();
  state.workGenerationMode = form.elements.namedItem('generationMode').value;
  state.workHumanIntervention = form.elements.namedItem('humanIntervention').value;
  state.workPage = 1;
  syncWorksHash();
  await reload({ navigation: true });
});
// Drag-and-drop for the staging inbox; the events do not delegate cleanly, so the
// drop zone tracks dragging state through document-level listeners.
document.addEventListener('dragover', (e) => {
  const zone = e.target.closest?.('[data-inbox-drop]');
  if (!zone) return;
  e.preventDefault();
  zone.classList.add('dragging');
});
document.addEventListener('dragleave', (e) => {
  const zone = e.target.closest?.('[data-inbox-drop]');
  if (zone && !zone.contains(e.relatedTarget)) zone.classList.remove('dragging');
});
document.addEventListener('drop', async (e) => {
  const zone = e.target.closest?.('[data-inbox-drop]');
  if (!zone) return;
  e.preventDefault();
  zone.classList.remove('dragging');
  if (e.dataTransfer?.files?.length) await inboxUpload(e.dataTransfer.files);
});
addEventListener('hashchange', () => { if (state.user?.role === 'admin') reload({ navigation: true }); });

boot();
