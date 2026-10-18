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
  more: '<path d="M5 12h.01M12 12h.01M19 12h.01"/>',
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
  'face-settings': '门面开关', meta: '编辑信息', curate: '收录为馆藏', nominate: '提名收录', 'withdraw-nomination': '撤回提名', 'inbox-upload': '收件箱上传', 'inbox-register': '登记入库', 'inbox-remove': '收件箱移除',
  'curated-section-create': '新建精选分区', 'curated-section-edit': '重命名精选分区', 'curated-section-order': '调整精选分区顺序', 'curated-section-delete': '删除精选分区', 'curated-questions': '更新精选题目',
  'qualification-settings': '考试设置', 'qualification-pair-create': '新建标准对', 'qualification-pair-edit': '编辑标准对', 'qualification-pair-disable': '停用标准对', 'qualification-promote': '考试晋升',
  'vote-void': '作废投票', 'vote-restore': '撤销作废投票' };
// Per-face review: the same work is approved separately for the gallery (display)
// and the arena (blind test). `audience` carries both flags; adminWork rows also
// carry explicit show_gallery/show_arena.
const AUDIENCE_FACE = { gallery: ['show2', 'both'], arena: ['show1', 'both'] };
const contentHeld = (w) => ['pending', 'review', 'rejected'].includes(w.moderation?.status);
const contentReady = (w) => ['legacy', 'approved'].includes(w.moderation?.status);
const isStaff = (user) => ['admin', 'moderator'].includes(user?.role);
const isSenior = () => state.user?.role === 'admin';
const canDecide = (work) => isSenior() || !work.mine;
const LEVELS = { 3: 'Lv3 高级管理员', 2: 'Lv2 普通管理员', 1: 'Lv1 认证成员', 0: 'Lv0 成员' };
const levelOfUser = (u) => u.level ?? ({ admin: 3, moderator: 2 }[u.role] ?? 0);
const publisher = (item) => item.author?.role === 'user' ? '用户' : '管理员';
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
  workModel: '', workEffort: '', workAuthor: '', workGenerationMode: '', workHumanIntervention: '', workEfforts: [],
  inbox: null, inboxForms: {}, intake: null, adminQuestions: null, reviewCounts: null, domainGroups: [],
  curated: null, curatedDraft: null, curatedFilter: 'all', curatedSearch: '', curatedType: '', curatedTarget: '', curatedNote: '',
  qualification: null, examWorks: {},
  risk: { view: 'ip', range: '7d', from: '', to: '', voided: 'all', outcome: 'all', ip: '', subnet: '', userId: '', visitorHash: '', modelKey: '', minVotes: 5, limit: 50, offset: 0, sort: '', dir: 'desc', data: null, loading: false, error: '', selected: new Map(), expanded: new Set() } };
const taskTitle = (id) => [...(state.adminQuestions ?? []), ...(state.questions ?? [])].find((t) => t.id === id)?.title ?? id;

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
    title: '下架这件作品？',
    message: `「${w.title}」会从公开目录和盲评中下架。已计入的盲评票继续保留在榜单中，有票作品的文件保留；需要作废对局或清除文件请在 Gallery 作品管理中操作。操作会记入审核记录。`,
    confirm: '下架',
    danger: true,
  });
  if (!ok) return false;
  toast('正在下架作品…');
  try {
    await api(`works/${encodeURIComponent(w.task)}/${encodeURIComponent(w.id)}`, { method: 'DELETE' });
    toast('作品已下架');
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
  { id: 'qualification', label: '资格考试', icon: 'check' },
  { id: 'vote-risk', label: '投票风控', icon: 'shield' },
];
const COMMON_TABS = [
  { id: 'dashboard', label: '仪表盘', icon: 'chart' },
  { id: 'upload', label: '上传入口', icon: 'inbox' },
  { id: 'users', label: '用户', icon: 'users' },
  { id: 'traffic', label: '流量', icon: 'clock' },
];
const ARENA_NAV = [
  ['内容管理', [['works', '作品管理', 'file', '#/works'], ['intake', '收件箱 · 娱乐作品', 'inbox', '#/intake'], ['tasks', '题目管理', 'guide', '#/tasks'], ['qualification', '资格考试', 'check', '#/qualification'], ['vote-risk', '投票风控', 'shield', '#/vote-risk'], ['gallery-review', '审核', 'shield', 'https://gallery.arenaofbias.icu/#/review']]],
  ['玩法', [['guess', '模一把', 'game', '#/guess'], ['activity', '活动管理', 'calendar', '#/activity']]],
];
const SUBMIT_URL = 'https://gallery.arenaofbias.icu/#/submit';
const REVIEW_URL = 'https://gallery.arenaofbias.icu/#/review';
const systemSwitch = () => `<div class="system-switch" role="group" aria-label="管理系统"><button type="button" data-system="gallery" aria-pressed="${state.system === 'gallery'}">展览馆系统</button><button type="button" data-system="arena" aria-pressed="${state.system === 'arena'}">竞技场系统</button><button type="button" data-system="common" aria-pressed="${state.system === 'common'}">通用后台</button></div>`;

const routeAllowed = (route, sub) => !isSenior() ? (state.system === 'common' ? route === 'upload' : ['works', 'intake'].includes(route)) : state.system === 'common'
  ? COMMON_TABS.some((tab) => tab.id === route)
  : TABS.some((tab) => tab.id === route) || (state.system === 'arena' && ['guess', 'activity', 'intake'].includes(route));
const tabsForSystem = () => (state.system === 'common' ? COMMON_TABS : TABS).filter((tab) => isSenior() || ['works', 'upload'].includes(tab.id));

function topbar(route) {
  if (state.system === 'arena') return `<header class="topbar arena-topbar">
    <div class="arena-page-mark"><span class="eyebrow">偏见试验场 / 管理工作台</span><strong>${esc(TABS.find((tab) => tab.id === route)?.label ?? (route === 'intake' ? '收件箱 · 娱乐作品' : '竞技场'))}</strong></div>
    <span class="topbar-space"></span>${systemSwitch()}${themeButton()}
    <span class="user-chip" title="当前账号"><span class="avatar" aria-hidden="true">${esc(state.user.name.slice(0, 1).toUpperCase())}</span><span class="user-name">${esc(state.user.name)}</span></span>
    <button class="icon-btn" data-logout title="退出登录" aria-label="退出登录">${icon('logout')}</button>
  </header>`;
  return `<header class="topbar">
    <a class="brand" href="${state.system === 'common' ? (isSenior() ? '#/dashboard' : '#/upload') : '#/works'}">${LOGO}<span class="brand-name">同题异答<b>${state.system === 'common' ? '通用后台' : '管理后台'}</b></span></a>
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
    <nav class="sidebar-nav">${ARENA_NAV.map(([group, items]) => [group, items.filter(([id]) => isSenior() || ['works', 'intake', 'gallery-review'].includes(id))]).filter(([, items]) => items.length).map(([group, items]) => `<div class="sidebar-group"><span class="sidebar-caption">${group}</span>${items.map(([id, label, glyph, href]) => `<a href="${href}" title="${label}"${href.startsWith('http') ? ' target="_blank" rel="noopener"' : ''}${selected === id ? ' aria-current="page"' : ''}>${icon(glyph)}<span class="sidebar-label">${label}</span></a>`).join('')}</div>`).join('')}</nav>
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
// Registration reuses the platform draft pipeline and awaits manual verification.
function inboxPanel() {
  const entries = state.inbox ?? [];
  const tasks = state.questions ?? [];
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
        <p class="fine">管理员发布跳过内容审核，登记后进入人工核验队列。普通管理员的作品须由其他管理员核验。</p>
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
  const formal = w.entertainment_route === 1 ? '在收件箱' : w.arena_eligible ? '在正式盲测池' : w.show_arena && !w.arena_generation_ok ? '不符合盲评条件（多轮 / 人工介入）' : '不在正式盲测池';
  const entertainment = w.entertainment_route === 1 ? '在收件箱' : w.show_entertainment ? '在娱乐池' : '不在娱乐池';
  return `<tr data-work-key="${esc(`${w.task}/${w.id}`)}">
    <td><div class="admin-work-title">${thumb(w)}<div><b>${esc(w.title)}</b><small>${esc(taskTitle(w.task))} · ${w.votes ?? 0} 票</small>${w.entertainment_route === 1 ? '<span class="badge">在收件箱</span>' : ''}</div></div></td>
    <td>${esc(w.modelName)}${provenanceText(w) ? `<small class="work-provenance">${esc(provenanceText(w))}</small>` : ''}</td><td>${statusBadge(w.status)}</td>
    <td>${publisher(w)}${w.author?.name ? `<small>${esc(w.author.name)}</small>` : ''}</td><td>${w.show_gallery ? '进入展览馆' : '未进展览馆'}</td>
    ${face === 'arena' ? `<td>${formal}</td><td>${entertainment}</td>` : '<td>—</td>'}
    <td><div class="actions"><button class="btn sm" data-preview="${esc(`${w.task}/${w.id}`)}">预览</button>${canDecide(w) ? `<button class="btn sm" data-calibrate="${esc(`${w.task}/${w.id}`)}">${label}取景</button>` : ''}${isSenior() ? `<button class="btn sm" data-task-note="${esc(w.task)}">${face === 'gallery' ? '策展笔记' : '题目点评'}</button>` : ''}<button class="btn sm" data-edit="${esc(`${w.task}/${w.id}`)}">编辑</button>${canDecide(w) ? `<a class="btn sm" href="${REVIEW_URL}" target="_blank" rel="noopener">审核</a>` : '<small>需由其他管理员审核</small>'}${isSenior() ? `<button class="btn sm danger" data-delete="${esc(`${w.task}/${w.id}`)}">删除</button>` : ''}</div></td>
  </tr>`;
}
function systemWorksView() {
  const face = state.system;
  const works = state.adminWorks;
  const tasks = state.questions ?? [];
  const options = tasks.map((t) => `<option value="${esc(t.id)}" ${state.workTask === t.id ? 'selected' : ''}>${esc(t.title)}</option>`).join('');
  const pages = Math.max(1, Math.ceil(state.workTotal / 30));
  const rows = works.map((w) => adminWorkRow(w, face)).join('');
  return `${pageHero('作品管理', `${faceLabel()}作品`, '开关在编辑里保存，取景仍在本行。', [['全部作品', state.workTotal], ['本页', works.length]])}
    <section class="block"><form id="admin-work-filter" class="admin-filter">
      <input class="input" name="search" value="${esc(state.workSearch)}" placeholder="搜索作品或模型" aria-label="搜索作品或模型">
      <select class="input" name="task" aria-label="筛选题目"><option value="">全部题目</option>${options}</select>
      <select class="input" name="status" aria-label="筛选状态"><option value="">全部状态</option>${Object.entries(WORKS_FILTERS).filter(([id]) => id !== 'all').map(([id, label]) => `<option value="${id}" ${state.workStatus === id ? 'selected' : ''}>${label}</option>`).join('')}</select>
      <select class="input" name="author" aria-label="筛选发布者"><option value="">全部发布者</option><option value="admin"${state.workAuthor === 'admin' ? ' selected' : ''}>管理员</option><option value="user"${state.workAuthor === 'user' ? ' selected' : ''}>用户</option></select>
      <select class="input" name="show" aria-label="筛选开关"><option value="">全部开关</option><option value="on" ${state.workShow === 'on' ? 'selected' : ''}>已开启</option><option value="off" ${state.workShow === 'off' ? 'selected' : ''}>已关闭</option></select>
      <select class="input" name="model" aria-label="筛选模型"><option value="">全部模型</option><option value="other"${state.workModel === 'other' ? ' selected' : ''}>未登记模型</option>${(state.data?.models ?? []).map((model) => `<option value="${esc(model.id)}"${state.workModel === model.id ? ' selected' : ''}>${esc(model.name)}</option>`).join('')}</select>
      <select class="input" name="effort" aria-label="筛选推理档位"><option value="">全部档位</option><option value="unset"${state.workEffort === 'unset' ? ' selected' : ''}>未注明档位</option>${[...new Set(['Default', 'Low', 'Medium', 'High', 'XHigh', 'Max', 'Ultra', 'Ultracode', ...state.workEfforts, state.workEffort].filter((value) => value && value !== 'unset'))].map((value) => `<option value="${esc(value)}"${state.workEffort === value ? ' selected' : ''}>${esc(value === 'Default' ? '默认档位' : value)}</option>`).join('')}</select>
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
      <div class="work-results" aria-busy="${state.workLoading}">${state.workLoading ? skeleton(7) : rows ? `<div class="table-wrap"><table class="board admin-work-table"><thead><tr><th>作品</th><th>模型</th><th>状态</th><th>发布者</th><th>进入展览馆</th><th>${face === 'arena' ? '正式盲测池' : '备注'}</th>${face === 'arena' ? '<th>娱乐池</th>' : ''}<th>操作</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="board-empty">没有符合条件的作品。</p>'}</div>
      <div class="admin-pagination"><button class="btn sm" data-page="${state.workPage - 1}" ${state.workPage <= 1 ? 'disabled' : ''}>上一页</button><span>第 ${state.workPage} / ${pages} 页</span><button class="btn sm" data-page="${state.workPage + 1}" ${state.workPage >= pages ? 'disabled' : ''}>下一页</button></div>
    </section>`;
}

const QUESTION_TYPES = { 文学: '写作', 推理: '推理', 静态网页: '设计', 建模: '三维' };
const MAX_DOMAINS = 2;
function questionTypeField(category = '静态网页') {
  return `<label class="field"><span class="field-label">题目类型</span><select class="input" name="category" required>${Object.entries(QUESTION_TYPES).map(([value, label]) => `<option value="${value}"${value === category ? ' selected' : ''}>${label}</option>`).join('')}</select></label>`;
}
function questionDomainField(selected = []) {
  return `<fieldset class="field domain-field"><legend class="field-label">所属领域<small data-domain-count aria-live="polite">已选 ${selected.length} / ${MAX_DOMAINS}</small></legend>
    <div class="domain-groups">${state.domainGroups.map((group) => `<div class="domain-group" role="group" aria-label="${esc(group.title)}"><span class="domain-group-title">${esc(group.title)}</span><div class="domain-options">${group.domains.map((domain) => `<label class="domain-option"><input type="checkbox" name="domains" value="${esc(domain)}"${selected.includes(domain) ? ' checked' : ''}><span>${esc(domain)}</span></label>`).join('')}</div></div>`).join('')}</div>
    <p class="muted domain-hint">选 1–${MAX_DOMAINS} 个，方便按领域查找题目；选满后取消一项即可更换。</p></fieldset>`;
}
function syncQuestionDomains(form) {
  const count = $$('[name="domains"]:checked', form).length;
  $$('[name="domains"]', form).forEach((input) => { input.disabled = count >= MAX_DOMAINS && !input.checked; });
  $('[data-domain-count]', form).textContent = `已选 ${count} / ${MAX_DOMAINS}`;
}
const taskCard = (task, { lead = '', mark = '', note = '', cls = '', category = false } = {}) => `<article class="admin-task${cls}">${lead}<div class="admin-task-main"><h3>${esc(task.title)}${mark}</h3><p class="muted">${publisher(task)} · ${esc(QUESTION_STATUS[task.moderation?.status] ?? '')}${category ? ` · ${esc(QUESTION_TYPES[task.category] ?? task.category ?? '')}` : ''} · ${task.works ?? 0} 件作品 · ${task.votes ?? 0} 票</p>${note}</div><div class="actions"><button class="btn" data-question-edit="${esc(task.id)}">编辑与审核</button><button class="btn" data-task-note="${esc(task.id)}">${state.system === 'gallery' ? '编辑策展文案' : '编辑点评与权重'}</button><button class="btn danger" data-question-delete="${esc(task.id)}"${task.votes ? ' disabled title="有票题目不能删除"' : ''}>删除</button></div></article>`;
function tasksView() {
  const tasks = state.adminQuestions ?? [];
  const curated = curatedOn() && state.curated;
  return `${pageHero('题目管理', `${faceLabel()}题目`, '统一管理题目信息、投稿开关和审核状态。新题目须经人工审核。', [['题目', tasks.length], ...(curated ? [['精选', curatedCurrent().size]] : [])])}
    <section class="block"><div class="actions"><button class="btn primary" type="button" data-new-question>新建题目</button></div>
    ${curated ? `<div class="admin-filter curated-toolbar"><input class="input" type="search" data-curated-search value="${esc(state.curatedSearch)}" placeholder="搜索题目" aria-label="搜索题目">
      <select class="input" data-curated-type aria-label="按类型筛选"><option value="">全部类型</option>${Object.entries(QUESTION_TYPES).map(([value, label]) => `<option value="${value}"${state.curatedType === value ? ' selected' : ''}>${label}</option>`).join('')}</select></div>
    <div data-curated-body>${curatedBody()}</div>`
    : `${curatedOn() && state.curatedNote ? `<p class="form-error" role="alert">${esc(state.curatedNote)}</p>` : ''}<div class="admin-task-list">${tasks.map((task) => taskCard(task)).join('')}</div>`}</section>`;
}

// ---- curated rankings: the question set is edited in a staged draft and saved as one request (Lv3, gallery) ----
const curatedOn = () => state.system === 'gallery' && isSenior();
const curatedOriginal = () => new Map((state.curated?.questions ?? []).filter((q) => q.selected).map((q) => [q.taskId, q.sectionId]));
const curatedCurrent = () => state.curatedDraft ?? curatedOriginal();
const curatedSections = () => state.curated?.sections ?? [];
const sectionName = (id) => curatedSections().find((section) => section.id === id)?.name ?? id ?? '';
function curatedDiff() {
  const before = curatedOriginal(), after = curatedCurrent();
  const added = [], removed = [], moved = [];
  for (const [id, section] of after) { if (!before.has(id)) added.push(id); else if (before.get(id) !== section) moved.push(id); }
  for (const id of before.keys()) if (!after.has(id)) removed.push(id);
  return { added, removed, moved, count: added.length + removed.length + moved.length };
}
const curatedDirty = () => curatedOn() && Boolean(state.curatedDraft) && curatedDiff().count > 0;
function stageCurated(change) {
  const draft = new Map(curatedCurrent());
  change(draft);
  state.curatedDraft = draft;
  if (!curatedDiff().count) state.curatedDraft = null;
  state.curatedNote = '';
}
// New ticks go to the chosen section, which defaults to the filtered section, else the first one.
const curatedTarget = () => {
  const sections = curatedSections();
  const wanted = state.curatedTarget || (sections.some((section) => section.id === state.curatedFilter) ? state.curatedFilter : '');
  return sections.find((section) => section.id === wanted)?.id ?? sections[0]?.id ?? '';
};
const NO_REASONING = '推理题由 AI 评分，不进排行榜';
function curatedRows() {
  const byId = new Map((state.curated?.questions ?? []).map((q) => [q.taskId, q]));
  const selection = curatedCurrent();
  const text = state.curatedSearch.trim().toLowerCase();
  return (state.adminQuestions ?? []).map((task) => {
    const q = byId.get(task.id) ?? { taskId: task.id, available: false, unavailableReason: '精选信息未载入' };
    const on = selection.has(task.id);
    const lock = task.category === '推理' ? NO_REASONING : !q.available ? `${q.unavailableReason ?? '暂不可用'}，${on ? '暂不计票' : '暂不能加入精选'}` : '';
    // A ticked question that has since become unavailable can still be unticked.
    return { task, q, on, lock, editable: task.category !== '推理' && (q.available || on), addable: task.category !== '推理' && q.available };
  }).filter(({ task, on }) => (!state.curatedType || task.category === state.curatedType)
    && (state.curatedFilter === 'all' || (state.curatedFilter === 'none' ? !on : selection.get(task.id) === state.curatedFilter))
    && (!text || task.title.toLowerCase().includes(text)));
}
function curatedChips() {
  const selection = curatedCurrent();
  const tasks = state.adminQuestions ?? [];
  const chip = (id, label, count) => `<button class="chip" type="button" data-curated-filter="${esc(id)}" aria-pressed="${state.curatedFilter === id}"><span data-i18n-ignore>${esc(label)}</span><span class="mono">${count}</span></button>`;
  return `<div class="chips curated-chips" role="group" aria-label="精选筛选">${chip('all', '全部', tasks.length)}${chip('none', '未精选', tasks.filter((task) => !selection.has(task.id)).length)}`
    + `${curatedSections().map((section) => chip(section.id, section.name, [...selection.values()].filter((id) => id === section.id).length)).join('')}</div>`;
}
function curatedStrip() {
  const dirty = curatedDirty();
  const selection = [...curatedCurrent().values()];
  return `<div class="curated-sections" role="group" aria-label="精选分区"><span class="curated-label">精选分区</span>
    ${curatedSections().map((section) => `<span class="section-chip"><b>${esc(section.name)}</b><span class="mono">${selection.filter((id) => id === section.id).length}</span><button class="icon-btn" type="button" data-section-menu="${esc(section.id)}" aria-label="管理分区「${esc(section.name)}」"${dirty ? ' disabled' : ''}>${icon('more')}</button></span>`).join('')}
    <button class="btn sm" type="button" data-section-new${dirty ? ' disabled' : ''}>+ 新建分区</button>${dirty ? '<small class="muted">先保存或放弃题目改动</small>' : ''}</div>`;
}
function curatedRow({ task, q, on, lock, editable }) {
  const before = curatedOriginal();
  const was = before.has(task.id);
  const section = curatedCurrent().get(task.id);
  const mark = on && !was ? '将加入' : !on && was ? '将移出' : on && was && before.get(task.id) !== section ? `换到 ${sectionName(section)}` : '';
  const sections = curatedSections();
  const lead = `<div class="curated-cell"><label class="curated-check"><input type="checkbox" data-curated-toggle="${esc(task.id)}"${on ? ' checked' : ''}${editable && (on || sections.length) ? '' : ' disabled'} aria-label="${esc(task.title)}加入精选"><span>精选</span></label>
    ${on ? `<select class="input" data-curated-section="${esc(task.id)}" aria-label="${esc(task.title)}的精选分区">${sections.map((item) => `<option value="${esc(item.id)}"${item.id === section ? ' selected' : ''}>${esc(item.name)}</option>`).join('')}</select>` : '<span class="curated-none" aria-hidden="true">—</span>'}</div>`;
  const note = `${lock ? `<p class="curated-lock">${esc(lock)}</p>` : ''}${on && q.curatedComparisons != null ? `<p class="curated-lock">精选榜 ${q.curatedComparisons} 次比较</p>` : ''}`;
  return taskCard(task, { lead, note, category: true, cls: `${mark ? ' is-changed' : ''}${lock && !editable ? ' is-locked' : ''}`, mark: mark ? ` <span class="badge curated-mark">${esc(mark)}</span>` : '' });
}
function curatedBody() {
  const rows = curatedRows();
  const diff = curatedDiff();
  const addable = rows.filter((row) => row.addable).length;
  const sections = curatedSections();
  const bar = diff.count ? `<div class="curated-bar" role="region" aria-label="未保存的精选改动"><div><p><b>未保存：</b>${[diff.added.length && `加入 ${diff.added.length} 题`, diff.removed.length && `移出 ${diff.removed.length} 题`, diff.moved.length && `换分区 ${diff.moved.length} 题`].filter(Boolean).join(' · ')}</p>${state.curatedNote ? `<p class="form-error" role="alert">${esc(state.curatedNote)}</p>` : ''}</div>
    <div class="actions"><button class="btn ghost" type="button" data-curated-discard>放弃改动</button><button class="btn primary" type="button" data-curated-save>保存精选题目</button></div></div>` : '';
  return `${!diff.count && state.curatedNote ? `<p class="curated-note" role="status">${esc(state.curatedNote)}</p>` : ''}${curatedStrip()}${curatedChips()}
    <div class="curated-head"><label class="curated-check"><input type="checkbox" data-curated-all${addable ? '' : ' disabled'}><span>全选当前筛选可选的 ${addable} 道</span></label>
      <label class="curated-target">新勾选的放入 <select class="input" data-curated-target aria-label="新勾选的题目放入哪个分区"${sections.length ? '' : ' disabled'}>${sections.length ? sections.map((section) => `<option value="${esc(section.id)}"${section.id === curatedTarget() ? ' selected' : ''}>${esc(section.name)}</option>`).join('') : '<option>请先新建分区</option>'}</select></label></div>
    ${rows.length ? `<div class="admin-task-list">${rows.map(curatedRow).join('')}</div>` : '<p class="board-empty">没有符合条件的题目。</p>'}${bar}`;
}
// The header tick is a tri-state that only HTML properties can express.
function syncCuratedUi() {
  const all = $('[data-curated-all]', app());
  if (!all) return;
  const rows = curatedRows().filter((row) => row.addable);
  const picked = rows.filter((row) => row.on).length;
  all.checked = rows.length > 0 && picked === rows.length;
  all.indeterminate = picked > 0 && picked < rows.length;
}
function paintCurated() {
  const body = $('[data-curated-body]', app());
  if (!body) { render(); return; }
  body.innerHTML = curatedBody();
  syncCuratedUi();
}
async function loadCurated() { state.curated = await api('admin/curated'); }
// Section edits and the save carry the revision they were made against; a conflict reloads the latest state.
async function curatedFailed(error) {
  if (error.code !== 'curated_revision_conflict') { toast(error.message); return; }
  state.curatedDraft = null;
  state.curatedNote = '精选题目刚被其他管理员修改，已重新载入最新状态';
  try { await loadCurated(); } catch { /* the notice stays */ }
  paintCurated();
}
const curatedCall = (path, method, body) => api(`admin/curated/${path}`, { method, body: { revision: state.curated.revision, ...body } });

function sectionNameDialog(section) {
  const sheet = openDialog({ title: section ? '重命名分区' : '新建分区', className: 'confirm-sheet', body: `<form class="admin-editor" novalidate>
    <label class="field"><span class="field-label">分区名称</span><input class="input" name="name" maxlength="40" value="${esc(section?.name ?? '')}" required></label>
    ${section ? '<p class="fine">改名不影响题目归属和已有的票。</p>' : ''}<p class="form-error" role="alert"></p>
    <div class="sheet-actions"><button class="btn" type="button" data-sheet-close>取消</button><button class="btn primary" type="submit">${section ? '保存' : '创建'}</button></div></form>` });
  const form = $('form', sheet.el);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = form.name.value.trim();
    if (!name) { $('.form-error', form).textContent = '请填写分区名称'; return; }
    const done = busy($('button[type="submit"]', form));
    try {
      if (section) await curatedCall(`sections/${encodeURIComponent(section.id)}`, 'PATCH', { name });
      else await curatedCall('sections', 'POST', { name });
      sheet.close(); await loadCurated(); paintCurated(); toast(section ? '分区已改名' : '分区已创建');
    } catch (error) { sheet.close(); await curatedFailed(error); done(); }
  });
  setTimeout(() => form.name.select());
}
function sectionMenuDialog(section) {
  const sections = curatedSections();
  const index = sections.findIndex((item) => item.id === section.id);
  const sheet = openDialog({ title: `分区「${section.name}」`, className: 'confirm-sheet', body: `<div class="section-menu">
    <button class="btn" type="button" data-act="rename">重命名</button>
    <button class="btn" type="button" data-act="left"${index <= 0 ? ' disabled' : ''}>左移</button>
    <button class="btn" type="button" data-act="right"${index >= sections.length - 1 ? ' disabled' : ''}>右移</button>
    <button class="btn danger" type="button" data-act="delete">删除分区</button></div><p class="fine">前台侧栏按这里的顺序显示分区。</p>` });
  sheet.el.addEventListener('click', async (event) => {
    const act = event.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    sheet.close();
    if (act === 'rename') { sectionNameDialog(section); return; }
    if (act === 'delete') { sectionDeleteDialog(section); return; }
    const ids = sections.map((item) => item.id);
    const to = index + (act === 'left' ? -1 : 1);
    [ids[index], ids[to]] = [ids[to], ids[index]];
    try { await curatedCall('sections/order', 'PUT', { sectionIds: ids }); await loadCurated(); paintCurated(); toast('分区顺序已更新'); }
    catch (error) { await curatedFailed(error); }
  });
}
async function sectionDeleteDialog(section) {
  const count = [...curatedOriginal().values()].filter((id) => id === section.id).length;
  const others = curatedSections().filter((item) => item.id !== section.id);
  const remove = async (moveQuestionsTo) => {
    try { await curatedCall(`sections/${encodeURIComponent(section.id)}`, 'DELETE', moveQuestionsTo ? { moveQuestionsTo } : {}); await loadCurated(); if (state.curatedFilter === section.id) state.curatedFilter = 'all'; paintCurated(); toast('分区已删除'); return true; }
    catch (error) { await curatedFailed(error); return false; }
  };
  if (!count) {
    if (await confirmDialog({ title: `删除分区「${section.name}」？`, message: '这个分区是空的，删除后不能恢复。', confirm: '删除分区', danger: true })) await remove();
    return;
  }
  const sheet = openDialog({ title: `删除「${section.name}」？`, className: 'confirm-sheet', body: `<form novalidate><p class="sheet-text">这个分区有 ${count} 道题。</p>
    ${others.length ? `<label class="face-checks"><input type="radio" name="mode" value="move" checked> 移到 <select class="input" name="target" aria-label="移到哪个分区">${others.map((item) => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('')}</select></label>` : ''}
    <label class="face-checks"><input type="radio" name="mode" value="unselect"${others.length ? '' : ' checked'}> 先去取消这些题的精选</label>
    <div class="sheet-actions"><button class="btn" type="button" data-sheet-close>取消</button><button class="btn primary danger" type="submit">继续</button></div></form>` });
  const form = $('form', sheet.el);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const mode = form.elements.namedItem('mode').value;
    sheet.close();
    if (mode === 'unselect') { state.curatedFilter = section.id; paintCurated(); toast('已筛选出这个分区的题目，取消精选并保存后再删除分区'); return; }
    await remove(form.elements.namedItem('target').value);
  });
}
function curatedConfirm(diff) {
  const names = (ids) => ids.map((id) => `「${esc(taskTitle(id))}」`).join('、');
  const since = state.curated?.countingStartedAt ? `自 ${formatDate(state.curated.countingStartedAt)} 以来` : '';
  const before = curatedOriginal(), after = curatedCurrent();
  const body = `<div class="curated-confirm">
    ${diff.added.length ? `<p><b>加入 ${diff.added.length} 题</b>：${diff.added.map((id) => `「${esc(taskTitle(id))}」（${esc(sectionName(after.get(id)))}）`).join('、')}。这些题${since}Lv1+ 成员的选择会计入精选榜。</p>` : ''}
    ${diff.removed.length ? `<p><b>移出 ${diff.removed.length} 题</b>：${names(diff.removed)}。它们的比较不再计入精选榜；投票记录保留，重新加入后恢复。</p>` : ''}
    ${diff.moved.length ? `<p><b>换分区 ${diff.moved.length} 题</b>：${diff.moved.map((id) => `「${esc(taskTitle(id))}」${esc(sectionName(before.get(id)))} → ${esc(sectionName(after.get(id)))}`).join('；')}。总榜不受影响，两个分区的名次会重新计算。</p>` : ''}
    <p class="muted">精选榜在下一次计算时更新（10 分钟内）。</p>
    ${after.size ? '' : '<p class="curated-warn" role="alert">保存后精选榜没有题目，会显示为空。</p>'}</div>`;
  return new Promise((resolve) => {
    let answer = false;
    const sheet = openDialog({ title: '更新精选题目？', className: 'confirm-sheet', body: `${body}<div class="sheet-actions"><button class="btn" type="button" data-sheet-close>取消</button><button class="btn primary" type="button" data-confirm>确认更新</button></div>`, onClose: () => resolve(answer) });
    $('[data-confirm]', sheet.el).addEventListener('click', () => { answer = true; sheet.close(); });
  });
}
async function saveCurated(button) {
  const diff = curatedDiff();
  if (!diff.count || !await curatedConfirm(diff)) return;
  const done = busy(button, '正在保存…');
  try {
    await curatedCall('questions', 'PUT', { questions: [...curatedCurrent()].map(([taskId, sectionId]) => ({ taskId, sectionId })) });
    state.curatedDraft = null;
    state.curatedNote = '';
    await loadCurated();
    toast(`精选题目已更新：${[diff.added.length && `加入 ${diff.added.length} 题`, diff.removed.length && `移出 ${diff.removed.length} 题`, diff.moved.length && `换分区 ${diff.moved.length} 题`].filter(Boolean).join('，')}。榜单 10 分钟内刷新`);
  } catch (error) {
    if (error.code === 'curated_revision_conflict') { await curatedFailed(error); return; }
    state.curatedNote = `保存失败：${error.message}`;
  }
  paintCurated();
  done();
}
// Leaving with staged edits asks first; the draft is only dropped on a yes.
async function leaveCurated() {
  if (!curatedDirty()) return true;
  if (!await confirmDialog({ title: '放弃未保存的精选改动？', message: '题目的精选勾选和分区还没有保存，离开后会丢失。', confirm: '放弃改动', danger: true })) return false;
  state.curatedDraft = null;
  return true;
}
addEventListener('beforeunload', (event) => { if (curatedDirty()) { event.preventDefault(); event.returnValue = ''; } });

// ---- qualification test: the standard pairs and the exam's settings (Lv3) ----
const examTasks = () => [...new Map([...(state.data?.tasks ?? []), ...(state.questions ?? [])].map((task) => [task.id, task])).values()];
const examTaskTitle = (id) => examTasks().find((task) => task.id === id)?.title ?? taskTitle(id);
const examWorkLabel = (taskId, id) => { const work = state.examWorks[taskId]?.find((item) => item.id === id); return work ? `${work.modelName} · ${work.title}` : id; };
async function loadExamWorks(taskId) {
  if (!taskId || state.examWorks[taskId]) return state.examWorks[taskId] ?? [];
  const { works } = await api(`admin/qualification/works?taskId=${encodeURIComponent(taskId)}`);
  return (state.examWorks[taskId] = works);
}
const examRequired = (settings) => Math.ceil(settings.questionCount * settings.passPercent / 100);
function qualificationView() {
  const exam = state.qualification;
  if (!exam) return `${pageHero('资格考试', '标准对', '资格考试用的标准对：每组两件作品，管理员标好哪件更好。', [['可用', '—'], ['停用', '—']])}<section class="block" aria-busy="true">${skeleton(5)}</section>`;
  const usable = exam.pairs.filter((pair) => pair.enabled && pair.available).length;
  const off = exam.pairs.filter((pair) => !pair.enabled).length;
  const { settings } = exam;
  const rows = exam.pairs.map((pair) => {
    const status = !pair.enabled ? '<span class="status status-unverified">停用</span>' : pair.available ? '<span class="status status-verified">可用</span>' : `<span class="status status-questioned" title="${esc(pair.unavailableReason ?? '')}">不可用：${esc(pair.unavailableReason ?? '内容已变化')}</span>`;
    return `<article class="admin-task exam-pair${pair.enabled ? '' : ' is-locked'}"><div class="admin-task-main"><h3>${esc(examTaskTitle(pair.taskId))} ${status}</h3>
      <p class="muted" data-i18n-ignore>A：${esc(examWorkLabel(pair.taskId, pair.aWorkId))} vs B：${esc(examWorkLabel(pair.taskId, pair.bWorkId))}</p>
      <p class="muted">标准答案：<b>${pair.correctAnswer === 'a' ? 'A 更好' : 'B 更好'}</b>${pair.explanation ? ` · <span class="exam-note" data-i18n-ignore>${esc(pair.explanation)}</span>` : ''}</p></div>
      <div class="actions"><button class="btn" type="button" data-pair-edit="${esc(pair.id)}">编辑</button><button class="btn" type="button" data-pair-toggle="${esc(pair.id)}">${pair.enabled ? '停用' : '启用'}</button></div></article>`;
  }).join('');
  return `${pageHero('资格考试', '标准对', 'Lv0 成员通过资格考试升为 Lv1。题库不足每场题量时，考试不开放。', [['可用', usable], ['停用', off], ['每场', `${settings.questionCount} 题`], ['及格', `${settings.passPercent}%`]])}
    <section class="block"><div class="actions"><button class="btn primary" type="button" data-pair-new>新建标准对</button><button class="btn" type="button" data-exam-settings>考试设置</button></div>
    ${usable < settings.questionCount ? `<p class="curated-warn" role="status">可用标准对 ${usable} 组，少于每场 ${settings.questionCount} 组，考试暂不开放</p>` : ''}
    ${rows ? `<div class="admin-task-list">${rows}</div>` : '<p class="board-empty">还没有标准对。</p>'}</section>`;
}
function examSettingsDialog() {
  const { settings } = state.qualification;
  const sheet = openDialog({ title: '考试设置', className: 'confirm-sheet', body: `<form class="admin-editor" novalidate>
    <div class="field-row"><label class="field"><span class="field-label">每场题量</span><input class="input" name="questionCount" type="number" min="1" max="100" step="1" value="${settings.questionCount}" required></label>
    <label class="field"><span class="field-label">及格百分比</span><input class="input" name="passPercent" type="number" min="1" max="100" step="1" value="${settings.passPercent}" required></label></div>
    <p class="fine">及格线 = <b data-need></b>。已开始的考卷不受影响。</p><p class="form-error" role="alert"></p>
    <div class="sheet-actions"><button class="btn" type="button" data-sheet-close>取消</button><button class="btn primary" type="submit">保存</button></div></form>` });
  const form = $('form', sheet.el);
  const read = () => ({ questionCount: Number(form.questionCount.value), passPercent: Number(form.passPercent.value) });
  const update = () => { const v = read(); $('[data-need]', form).textContent = Number.isInteger(v.questionCount) && Number.isInteger(v.passPercent) ? `${examRequired(v)} / ${v.questionCount}` : '—'; };
  form.addEventListener('input', update); update();
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const value = read();
    if (![value.questionCount, value.passPercent].every((n) => Number.isInteger(n) && n >= 1 && n <= 100)) { $('.form-error', form).textContent = '题量和及格百分比须为 1–100 的整数'; return; }
    const done = busy($('button[type="submit"]', form), '正在保存…');
    try { await api('admin/qualification/settings', { method: 'PUT', body: { version: settings.version, ...value } }); sheet.close(); await reload(); toast('考试设置已保存'); }
    catch (error) {
      if (error.code === 'exam_revision_conflict') { sheet.close(); await reload(); toast('考试设置刚被其他管理员修改，已重新载入'); return; }
      $('.form-error', form).textContent = error.message; done();
    }
  });
}
function pairDialog(pair, preset = null) {
  const tasks = examTasks();
  const initialTask = pair?.taskId ?? preset?.taskId ?? '';
  const taskOptions = (needle = '') => `<option value="">选择题目</option>${tasks.filter((task) => task.id === initialTask || !needle || task.title.toLowerCase().includes(needle)).map((task) => `<option value="${esc(task.id)}"${task.id === (pair?.taskId ?? preset?.taskId) && !needle ? ' selected' : ''}>${esc(task.title)}</option>`).join('')}`;
  const sheet = openDialog({ title: pair ? '编辑标准对' : '新建标准对', className: 'exam-pair-sheet', body: `<form class="admin-editor" novalidate>
    <div class="exam-task-pick"><label class="field"><span class="field-label">筛选题目</span><input class="input" type="search" name="needle" placeholder="输入题目名称的一部分" autocomplete="off"></label>
      <label class="field"><span class="field-label">题目</span><select class="input" name="taskId" required>${taskOptions()}</select></label></div>
    <div class="exam-sides">${['a', 'b'].map((side) => `<div class="exam-side"><label class="field"><span class="field-label">作品 ${side.toUpperCase()}</span><select class="input" name="${side}WorkId" required disabled><option value="">先选题目</option></select></label>
      <div class="exam-preview" data-preview="${side}"><p class="muted">选好作品后在这里并排预览</p></div>
      <label class="pick-card"><input type="radio" name="correctAnswer" value="${side}"${pair?.correctAnswer === side ? ' checked' : ''}><span>${side.toUpperCase()} 更好</span></label></div>`).join('')}</div>
    <label class="field"><span class="field-label">说明<small>选填，为什么更好，只给管理员看</small></span><textarea class="input" name="explanation" rows="2" maxlength="500">${esc(pair?.explanation ?? '')}</textarea></label>
    <p class="form-error" role="alert"></p>
    <div class="sheet-actions"><button class="btn" type="button" data-sheet-close>取消</button>${pair ? '' : '<button class="btn" type="submit" data-again>保存并新建下一组</button>'}<button class="btn primary" type="submit">保存</button></div></form>` });
  const form = $('form', sheet.el);
  const sideSelect = (side) => form.elements.namedItem(`${side}WorkId`);
  const preview = (side) => {
    const work = state.examWorks[form.taskId.value]?.find((item) => item.id === sideSelect(side).value);
    $(`[data-preview="${side}"]`, form).innerHTML = work?.preview ? `<iframe src="${esc(work.preview)}" sandbox="allow-scripts allow-pointer-lock" loading="lazy" title="预览作品 ${side.toUpperCase()}"></iframe><a class="btn sm" href="${esc(work.preview)}" target="_blank" rel="noopener">在新窗口预览 ↗</a>` : '<p class="muted">选好作品后在这里并排预览</p>';
  };
  const fill = async (initial) => {
    const taskId = form.taskId.value;
    const selects = ['a', 'b'].map(sideSelect);
    selects.forEach((select) => { select.disabled = true; select.innerHTML = `<option value="">${taskId ? '正在载入…' : '先选题目'}</option>`; });
    ['a', 'b'].forEach(preview);
    if (!taskId) return;
    let works;
    try { works = await loadExamWorks(taskId); } catch (error) { $('.form-error', form).textContent = error.message; return; }
    if (form.taskId.value !== taskId) return;
    $('.form-error', form).textContent = works.length < 2 ? '这道题可作为标准对的作品不足两件' : '';
    selects.forEach((select, i) => {
      const current = initial?.taskId === taskId ? initial[`${i ? 'b' : 'a'}WorkId`] : '';
      const missing = current && !works.some((work) => work.id === current);
      select.innerHTML = `<option value="">选择作品</option>${missing ? `<option value="${esc(current)}" selected>${esc(current)}（当前，已不可选）</option>` : ''}${works.map((work) => `<option value="${esc(work.id)}"${work.id === current ? ' selected' : ''}>${esc(`${work.modelName} · ${work.title}`)}</option>`).join('')}`;
      select.disabled = false;
    });
    ['a', 'b'].forEach(preview);
  };
  form.addEventListener('input', (event) => {
    if (event.target.name !== 'needle') return;
    const current = form.taskId.value;
    form.taskId.innerHTML = taskOptions(event.target.value.trim().toLowerCase());
    form.taskId.value = [...form.taskId.options].some((option) => option.value === current) ? current : '';
    if (form.taskId.value !== current) fill(null);
  });
  form.addEventListener('change', (event) => {
    if (event.target === form.taskId) fill(null);
    else if (/WorkId$/.test(event.target.name)) preview(event.target.name[0]);
  });
  fill(pair ?? preset);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const again = event.submitter?.hasAttribute('data-again');
    const error = $('.form-error', form);
    const body = { taskId: form.taskId.value, aWorkId: form.aWorkId.value, bWorkId: form.bWorkId.value, correctAnswer: form.elements.namedItem('correctAnswer').value, explanation: form.explanation.value.trim() };
    if (!body.taskId || !body.aWorkId || !body.bWorkId) { error.textContent = '请选择题目和两件作品'; return; }
    if (body.aWorkId === body.bWorkId) { error.textContent = '两边不能是同一件作品'; return; }
    if (!body.correctAnswer) { error.textContent = '请在作品下方标出哪一件更好'; return; }
    const done = busy(event.submitter ?? $('button[type="submit"]', form), '正在保存…');
    try {
      if (pair) await api(`admin/qualification/pairs/${encodeURIComponent(pair.id)}`, { method: 'PATCH', body: { version: pair.version, ...body } });
      else await api('admin/qualification/pairs', { method: 'POST', body });
      sheet.close(); await reload(); toast('标准对已保存');
      if (again) pairDialog(null, { taskId: body.taskId });
    } catch (err) {
      if (err.code === 'exam_revision_conflict') { sheet.close(); await reload(); toast('这组刚被其他管理员修改，已重新载入'); return; }
      error.textContent = err.message; done();
    }
  });
}
async function togglePair(button) {
  const pair = state.qualification?.pairs.find((item) => item.id === button.dataset.pairToggle);
  if (!pair) return;
  const done = busy(button);
  try {
    if (pair.enabled) await api(`admin/qualification/pairs/${encodeURIComponent(pair.id)}`, { method: 'DELETE', body: { version: pair.version } });
    else await api(`admin/qualification/pairs/${encodeURIComponent(pair.id)}`, { method: 'PATCH', body: { version: pair.version, enabled: true } });
    await reload();
    toast(pair.enabled ? '标准对已停用' : '标准对已启用');
  } catch (error) {
    toast(error.code === 'exam_revision_conflict' ? '这组刚被其他管理员修改，已重新载入' : error.message);
    if (error.code === 'exam_revision_conflict') await reload(); else done();
  }
}
function questionDialog(question) {
  const sheet = openDialog({ title: `编辑与审核 · ${question.title}`, body: `<form class="admin-editor">
    <label class="field"><span class="field-label">标题</span><input class="input" name="title" maxlength="70" value="${esc(question.title)}" required></label>
    <label class="field"><span class="field-label">简述</span><textarea class="input" name="summary" maxlength="400">${esc(question.summary)}</textarea></label>
    <label class="field"><span class="field-label">提示词</span><textarea class="input" name="prompt"${question.works && question.moderation?.status === 'approved' ? ' disabled' : ''}>${esc(question.prompt)}</textarea></label>
    ${questionTypeField(question.category)}
    ${questionDomainField(question.domains)}
    <label class="face-checks"><input type="checkbox" name="acceptsUploads"${question.acceptsUploads ? ' checked' : ''}>接受投稿</label>
    <label class="field"><span class="field-label">封面作品 id<small>留空使用默认封面</small></span><input class="input" name="cover" value="${esc(question.cover)}"></label>
    <p class="form-error" role="alert"></p><button class="btn primary" type="submit">保存信息</button></form>
    <div class="actions"><button class="btn primary" data-question-decision="approved">通过 / 恢复</button><button class="btn danger" data-question-decision="rejected">拒绝 / 撤下</button></div>` });
  const form = $('form', sheet.el);
  syncQuestionDomains(form);
  form.addEventListener('change', () => syncQuestionDomains(form));
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const done = busy($('button[type="submit"]', form));
    try {
      await api(`admin/questions/${encodeURIComponent(question.id)}/meta`, { method: 'POST', body: {
        title: form.title.value, summary: form.summary.value, ...(!form.prompt.disabled ? { prompt: form.prompt.value } : {}),
        category: form.category.value, domains: $$('[name="domains"]:checked', form).map((input) => input.value),
        acceptsUploads: form.acceptsUploads.checked, cover: form.cover.value.trim() || null,
      } });
      sheet.close(); await reload(); toast('题目信息已更新');
    } catch (error) { $('.form-error', form).textContent = error.message; done(); }
  });
  $$('[data-question-decision]', sheet.el).forEach((button) => button.addEventListener('click', async () => {
    const status = button.dataset.questionDecision;
    let reason = '';
    if (status === 'rejected') {
      reason = prompt('请填写拒绝或撤下理由');
      if (!reason?.trim()) return;
    }
    const done = busy(button);
    try {
      await api(`questions/${encodeURIComponent(question.id)}/moderation`, { method: 'POST', body: { status, reason } });
      sheet.close(); await reload(); toast('审核结果已保存');
    } catch (error) { $('.form-error', form).textContent = error.message; done(); }
  }));
}
function intakeView() {
  const works = state.intake ?? [];
  const tasks = [...(state.data?.tasks ?? []), ...(state.questions ?? [])];
  const options = tasks.map((task) => `<option value="${esc(task.id)}">${esc(task.title)}</option>`).join('');
  const rows = works.map((work) => `<tr>
    <td><input type="checkbox" data-intake-task="${esc(work.task)}" data-intake-id="${esc(work.id)}"${canDecide(work) ? '' : ' disabled'} aria-label="选择${esc(work.title)}"></td>
    <td><b>${esc(work.title)}</b><small>${esc(work.modelName)}</small></td>
    <td>${esc(taskTitle(work.task))}</td>
    <td>${formatTime(work.addedAt)}</td>
    <td><button class="btn sm" data-edit="${esc(`${work.task}/${work.id}`)}">补信息</button></td>
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
    ${questionTypeField()}
    ${questionDomainField()}
    <p class="form-error" role="alert"></p><button class="btn primary" type="submit">创建</button></form>` });
  const form = $('form', sheet.el);
  syncQuestionDomains(form);
  form.addEventListener('change', () => syncQuestionDomains(form));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const category = form.category.value;
    const done = busy($('button[type="submit"]', form), '正在创建…');
    try {
      await api('admin/questions', { method: 'POST', body: {
        title: form.title.value, summary: form.summary.value, prompt: form.prompt.value, category,
        domains: $$('[name="domains"]:checked', form).map((input) => input.value), templates: ['文学', '推理'].includes(category) ? ['text'] : ['static'],
      } });
      sheet.close();
      toast('题目已创建，等待审核');
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
  return `<label class="field"><span class="field-label">推理档位<i>*</i><small>请选择常用值或手填，使用默认设置填 Default</small></span><input class="input" name="effort" list="${id}" required maxlength="20" value="${esc(value)}" placeholder="选择或填写档位"><datalist id="${id}">${['Default', 'Low', 'Medium', 'High', 'XHigh', 'Max', 'Ultra', 'Ultracode'].map((effort) => `<option value="${effort}">${effort === 'Default' ? '默认档位（明确使用默认设置）' : effort}</option>`).join('')}</datalist></label>`;
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
  const models = state.data?.models ?? [];
  // Only uploads (they carry `reviewed`) can move to another question; package works stay where the pack puts them.
  const movable = Object.hasOwn(w, 'reviewed') && canDecide(w);
  const homes = new Map([...(state.adminQuestions ?? []), ...(state.questions ?? [])].map((t) => [t.id, t.title]));
  if (!homes.has(w.task)) homes.set(w.task, taskTitle(w.task));
  const sheet = openDialog({ title: `编辑信息 · ${w.title}`, body: `<form class="admin-editor">
    <label class="field"><span class="field-label">归属题目<small>${movable ? '改到其他题目后，盲评记录、评论和表情随作品一起迁移' : Object.hasOwn(w, 'reviewed') ? '自己发布的作品须由其他管理员调整' : '数据包作品的归属题目由数据仓库维护'}</small></span><select class="input" name="task"${movable ? '' : ' disabled'}>${[...homes].map(([id, title]) => `<option value="${esc(id)}"${id === w.task ? ' selected' : ''}>${esc(title)}</option>`).join('')}</select></label>
    ${canDecide(w) ? '' : '<p class="fine">自己发布的作品须由其他管理员处理审核与开关</p>'}
    <label class="field"><span class="field-label">作品标题</span><input class="input" name="title" maxlength="40" value="${esc(w.title)}" required></label>
    <div class="field-row">
      <label class="field"><span class="field-label">模型名称</span><input class="input" name="modelName" maxlength="60" value="${esc(w.modelName)}" required></label>
      ${effortField(w.effort)}
    </div>
    <label class="field"><span class="field-label">登记为模型</span><select class="input" name="modelId"><option value="">不登记（保持自由文本）</option>${models.map((m) => `<option value="${esc(m.id)}"${m.id === w.model ? ' selected' : ''}>${esc(m.name)}</option>`).join('')}</select></label>
    <label class="field"><span class="field-label">作品摘要</span><textarea class="input" name="summary" maxlength="200" rows="2">${esc(w.summary ?? '')}</textarea></label>
    ${provenanceFields({ harness: currentProvenance(w, 'harness'), provider: currentProvenance(w, 'provider') })}
    ${generationFields(w)}
    <label class="face-checks"><input type="checkbox" name="enterGallery"${w.show_gallery ? ' checked' : ''}${canDecide(w) ? '' : ' disabled'}> 进入展览馆<small>同时写入展览馆和正式盲测</small></label>
    <label class="face-checks"><input type="checkbox" name="pool"${w.show_entertainment ? ' checked' : ''}${canDecide(w) ? '' : ' disabled'}> 娱乐盲测</label>
    <p class="form-error" role="alert"></p><button class="btn primary" type="submit">保存</button></form>` });
  const form = $('form', sheet.el);
  // A registered model wins over the typed name on the server, so the name and the registration move together.
  const defaultTitle = (name, effort) => [name.trim(), effort.trim()].filter(Boolean).join(' · ').slice(0, 40);
  let autoTitle = form.title.value === defaultTitle(w.modelName ?? '', w.effort ?? '') ? form.title.value : null;
  form.addEventListener('input', (e) => {
    if (e.target.name === 'modelName') form.modelId.value = models.find((m) => m.name.toLowerCase() === e.target.value.trim().toLowerCase())?.id ?? '';
    if (e.target.name === 'modelId' && e.target.value) form.modelName.value = models.find((m) => m.id === e.target.value)?.name ?? form.modelName.value;
    // A title that was only the default name follows the model and effort.
    if (['modelName', 'modelId', 'effort'].includes(e.target.name) && autoTitle !== null && form.title.value === autoTitle) {
      autoTitle = form.title.value = defaultTitle(form.modelName.value, form.effort.value);
    }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    let provenance;
    try { provenance = provenanceBody((name) => form.elements.namedItem(name)?.value, w); }
    catch (error) { $('.form-error', form).textContent = error.message; return; }
    const done = busy($('button[type="submit"]', form), '正在保存…');
    const enter = form.enterGallery.checked;
    const fields = { title: form.title.value, summary: form.summary.value, modelName: form.modelName.value, effort: form.effort.value, ...provenance, ...generationBody((name) => form.elements.namedItem(name)?.value, w),
      ...(movable && form.task.value !== w.task ? { task: form.task.value } : {}) };
    try {
      const { work } = await api(`admin/works/${workKey(w)}/meta`, { method: 'POST', body: { ...fields, modelId: form.modelId.value || null } });
      if (canDecide(w)) await api(`admin/works/${workKey(work)}/face-settings`, { method: 'POST', body: { show_gallery: enter, show_arena: enter, show_entertainment: form.pool.checked } });
      sheet.close();
      toast('信息已更新');
      await reload();
    } catch (error) { $('.form-error', form).textContent = error.message; done(); }
  });
}

// The camera answer arrives from the work's content origin via postMessage (server/bridge.mjs).
let calibrationCapture = null;
addEventListener('message', (event) => {
  if (event.data?.aob === 'camera' && calibrationCapture
    && event.source === calibrationCapture.frame.contentWindow
    && event.origin === new URL(calibrationCapture.frame.src).origin) calibrationCapture(event.data.camera);
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
  // Live preview: a short-lived content-origin key makes any work
  // viewable, with the bridge answering the camera handshake (?aob=bridge&face=…).
  (async () => {
    try {
      const { url } = await api(`admin/works/${workKey(w)}/preview`, { method: 'POST' });
      const preview = new URL(url, location.href);
      preview.searchParams.append('aob', 'bridge');
      preview.searchParams.set('face', face);
      if (face === 'arena') {
        preview.searchParams.append('aob', 'arena-fold');
        const question = [...(state.adminQuestions ?? []), ...(state.questions ?? []), ...(state.data?.tasks ?? [])].find(item => item.id === w.task);
        if (/^(建模|3D 场景|物理模拟|体素世界)$/.test(question?.category ?? '')) preview.searchParams.append('aob', 'arena-scene');
      }
      view.src = preview.href;
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
    if (view.getAttribute('src')) view.contentWindow?.postMessage({ aob: 'get-camera' }, new URL(view.src).origin);
  });
  calibrationCapture = (cam) => {
    if (!cam) { camState.textContent = '这件作品没有可抓取的 3D 相机（可能是纯 2D 页面）。'; return; }
    if (!['position', 'target'].every(key => Array.isArray(cam[key]) && cam[key].length === 3 && cam[key].every(Number.isFinite))) return;
    draft.camera = { position: [...cam.position], target: [...cam.target] };
    for (const key of ['position', 'target']) [0, 1, 2].forEach((i) => { form.querySelector(`[data-calib-num="${key}${i}"]`).value = Math.round(cam[key][i] * 1000) / 1000; });
    $('[data-calib-camera-enabled]', form).checked = true;
    camState.textContent = '已抓取当前视角 ✓';
  };
  calibrationCapture.frame = view;
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
const examLine = (exam) => !exam?.attempts ? '未参加' : exam.passedAt ? `${formatDate(exam.passedAt)} 通过` : `未通过 · ${exam.attempts} 次 · 最好 ${exam.bestCorrect ?? 0}/${exam.questionCount ?? '—'}`;
function usersView() {
  const users = state.users ?? [];
  const rows = users.map((u) => {
    const self = u.id === state.user.id;
    const level = levelOfUser(u);
    return `<tr>
      <td class="c-title"><span class="avatar" aria-hidden="true">${esc(u.name.slice(0, 1).toUpperCase())}</span><b>${esc(u.name)}</b>${self ? '<span class="badge">当前账号</span>' : ''}</td>
      <td><span class="status role-${level === 3 ? 'admin' : 'user'}">${icon(level >= 2 ? 'shield' : 'user')}${LEVELS[level]}</span></td>
      <td>${level < 2 ? esc(examLine(u.exam)) : '—'}</td>
      <td><time>${formatTime(u.createdAt)}</time></td>
      <td class="c-actions"><select class="input" data-user-role="${esc(u.id)}" aria-label="调整${esc(u.name)}的等级"${self ? ' disabled title="不能修改自己的等级"' : ''}>${Object.entries(LEVELS).sort(([x], [y]) => y - x).map(([value, label]) => `<option value="${value}"${Number(value) === level ? ' selected' : ''}>${label}</option>`).join('')}</select></td>
    </tr>`;
  }).join('');
  return `${pageHero('用户管理', '用户', '账号与等级。Lv2 及以上可以审核作品；只有 Lv3 高级管理员能调整等级，自己的等级只能由别的高级管理员修改。', [['账号', users.length], ['管理员（Lv2+）', users.filter((u) => levelOfUser(u) >= 2).length]])}
  <section class="block">
    ${state.users === null ? skeleton(5) : `<div class="table-wrap"><table class="board users-table">
      <thead><tr><th class="c-title">用户名</th><th>等级</th><th>资格考试</th><th>注册时间</th><th class="c-actions">操作</th></tr></thead>
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
  if (state.workAuthor) query.set('author', state.workAuthor);
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
  const hash = `#/works${[state.workTask, state.workStatus, state.workAuthor, state.workShow, state.workHarness, state.workProvider, state.workModel, state.workEffort, state.workGenerationMode, state.workHumanIntervention, state.workSearch].some(Boolean) || state.workPage > 1 ? `?${worksQuery()}` : ''}`;
  history.replaceState(null, '', hash);
}
function applyWorksHash() {
  const query = new URLSearchParams(location.hash.split('?')[1] ?? '');
  const pick = (key, fallback) => (query.has(key) ? String(query.get(key) ?? '') : fallback);
  state.workPage = Math.max(1, Number(pick('page', '1')) || 1);
  state.workTask = pick('task', state.workTask);
  state.workStatus = pick('status', state.workStatus);
  state.workAuthor = pick('author', state.workAuthor);
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
// ---- vote risk: who votes, from where and how fast (Lv3) ----
// The server only shows evidence; nothing here judges anyone. The marks below are plain
// thresholds that point the eye at a row, and a void is a soft, reversible flag on the vote.
const RISK_VIEWS = [['ip', '按 IP'], ['subnet', '按网段'], ['actor', '按账号 / 访客'], ['model', '按模型反查'], ['choices', '投票明细']];
const RISK_RANGES = [['24h', '近 24 小时', 1], ['3d', '近 3 天', 3], ['7d', '近 7 天', 7], ['30d', '近 30 天', 30], ['custom', '自定义', 0]];
const RISK_MARK = { fastShare: 0.7, fastMin: 10, winnerShare: 0.8, decisiveMin: 10, hourly: 60, crowd: 5, shared: 3 };
const RISK_CHOICE = { a: 'A 更好', b: 'B 更好', tie: '不分伯仲', skip: '跳过' };
const RISK_ERROR = { vote_too_early: '太早', duplicate_vote: '重复', already_voted: '重复', turnstile_required: '待验证', turnstile_failed: '验证未过' };
let riskToken = 0;
const riskPct = (value) => (value == null ? '—' : `${Math.round(value * 100)}%`);
const riskSeconds = (ms) => (ms == null ? '—' : `${(ms / 1000).toFixed(1)} 秒`);
const riskStamp = (value) => (value ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '—');
const riskLocal = (date) => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const riskModelName = (key) => (state.data?.models ?? []).find((model) => model.id === key)?.name ?? String(key ?? '').replace(/^x:/, '');
const riskModelLabel = (model) => (model ? model.name || riskModelName(model.key) || model.key : '—');
const riskActor = (row) => (row.userId
  ? `<b data-i18n-ignore>${esc(row.username ?? row.userId)}</b> <small class="muted">账号</small>`
  : `<span class="mono" title="${esc(row.visitorHash)}">访客 ${esc(String(row.visitorHash ?? '').slice(0, 8))}</span>`);
function riskWindow() {
  const r = state.risk;
  if (r.range === 'custom') {
    const from = new Date(r.from), to = new Date(r.to);
    if (!r.from || !r.to || !(from < to)) throw new Error('请选择有效的起止时间（起点要早于终点）');
    return { from: from.toISOString(), to: to.toISOString() };
  }
  const days = RISK_RANGES.find(([id]) => id === r.range)?.[2] ?? 7, now = Date.now();
  return { from: new Date(now - days * 86400e3).toISOString(), to: new Date(now).toISOString() };
}
function riskQuery() {
  const r = state.risk, params = new URLSearchParams(riskWindow());
  for (const name of ['ip', 'subnet', 'userId', 'visitorHash', 'modelKey']) if (r[name].trim()) params.set(name, r[name].trim());
  if (r.voided !== 'all') params.set('voided', r.voided);
  params.set('limit', r.limit);
  params.set('offset', r.offset);
  if (r.view === 'choices' && r.outcome !== 'all') params.set('outcome', r.outcome);
  if (r.view === 'model') params.set('minVotes', Math.max(1, Number(r.minVotes) || 5));
  if (['ip', 'subnet', 'actor'].includes(r.view)) params.set('groupBy', r.view);
  return params;
}
async function loadRisk() {
  const r = state.risk, token = ++riskToken;
  r.error = '';
  if (r.view === 'model' && !r.modelKey.trim()) { r.data = null; r.loading = false; paintRisk(); return; }
  let query;
  try { query = riskQuery(); } catch (error) { r.error = error.message; r.data = null; r.loading = false; paintRisk(); return; }
  r.loading = true;
  paintRisk();
  const path = r.view === 'choices' ? 'choices' : r.view === 'model' ? 'model-voters' : 'summary';
  try {
    const data = await api(`admin/vote-risk/${path}?${query}`);
    if (token !== riskToken) return;
    r.data = data;
  } catch (error) {
    if (token !== riskToken) return;
    if (error.status === 401 || error.status === 403) { await boot(); return; }
    r.error = error.message;
    r.data = null;
  }
  r.loading = false;
  paintRisk();
}
function riskMarks(row) {
  const out = [];
  if (row.fastChoiceShare != null && row.timedChoices >= RISK_MARK.fastMin && row.fastChoiceShare >= RISK_MARK.fastShare) out.push(['快速', `${riskPct(row.fastChoiceShare)} 的选择在 10 秒内完成（${row.timedChoices} 次有计时）`]);
  const share = row.winShare ?? row.topWinnerShare, decisive = row.winShare != null ? row.wins + row.losses : row.decisiveVotes;
  if (share != null && decisive >= RISK_MARK.decisiveMin && share >= RISK_MARK.winnerShare) out.push(['偏向', `${riskPct(share)} 的决胜票投给同一模型（${decisive} 张决胜票）`]);
  if (row.peakHourlyVotes >= RISK_MARK.hourly) out.push(['高频', `最忙的一小时入库 ${row.peakHourlyVotes} 张票`]);
  if (state.risk.view !== 'actor' && state.risk.view !== 'model' && row.actorCount >= RISK_MARK.crowd) out.push(['多人', `同一${state.risk.view === 'ip' ? ' IP ' : '网段'}下有 ${row.actorCount} 个账号或访客`]);
  if (row.sharedIpOtherAccounts >= RISK_MARK.shared) out.push(['共享 IP', `与另外 ${row.sharedIpOtherAccounts} 个账号用过同一个 IP`]);
  return out;
}
const riskFlagHtml = (row) => riskMarks(row).map(([label, why]) => `<span class="risk-flag" title="${esc(why)}">${label}</span>`).join('');
const riskHot = (hot, html) => `<span${hot ? ' class="risk-hot"' : ''}>${html}</span>`;
const riskWinner = (row) => (row.topWinnerModel
  ? `<button class="link-btn" type="button" data-risk-model="${esc(row.topWinnerModel.key)}" title="反查给 ${esc(riskModelLabel(row.topWinnerModel))} 投票的人">${esc(riskModelLabel(row.topWinnerModel))}</button> ${riskHot(row.topWinnerShare >= RISK_MARK.winnerShare && row.decisiveVotes >= RISK_MARK.decisiveMin, riskPct(row.topWinnerShare))} <small class="muted" title="胜出 ${row.topWinnerVotes} / 决胜 ${row.decisiveVotes}">${row.topWinnerVotes}/${row.decisiveVotes}</small>`
  : '<span class="muted">—</span>');
const riskFast = (row) => `${riskHot(row.fastChoiceShare != null && row.timedChoices >= RISK_MARK.fastMin && row.fastChoiceShare >= RISK_MARK.fastShare, riskPct(row.fastChoiceShare))} <small class="muted" title="有计时的非跳过选择">${row.timedChoices ?? 0} 次</small>`;
const riskVotes = (row) => `<b>${row.voteCount}</b>${row.voidedVoteCount ? ` <small class="muted" title="其中已作废 ${row.voidedVoteCount} 张">作废 ${row.voidedVoteCount}</small>` : ''}`;
const drillAttrs = (row) => {
  const view = state.risk.view;
  if (view === 'ip') return `data-risk-drill="ip" data-value="${esc(row.ip ?? row.key)}"`;
  if (view === 'subnet') return `data-risk-drill="subnet" data-value="${esc(row.subnet ?? row.key)}"`;
  return `data-risk-drill="actor" data-user="${esc(row.userId ?? '')}" data-visitor="${esc(row.visitorHash ?? '')}"`;
};
function riskColumns() {
  const view = state.risk.view, group = view === 'ip' || view === 'subnet';
  const lead = group
    ? { key: 'key', label: view === 'ip' ? 'IP' : '网段', value: (row) => row.key, html: (row) => `<span class="mono" data-i18n-ignore>${esc(row.key)}</span>` }
    : { key: 'key', label: '账号 / 访客', value: (row) => row.username ?? row.visitorHash ?? '', html: riskActor };
  const votes = { key: 'voteCount', label: '票数', value: (row) => row.voteCount, html: riskVotes, num: true };
  const fast = { key: 'fastChoiceShare', label: '快速占比', value: (row) => row.fastChoiceShare, html: riskFast, num: true };
  const winner = { key: 'topWinnerShare', label: '最集中的胜出模型', value: (row) => row.topWinnerShare, html: riskWinner };
  const peak = { key: 'peakHourlyVotes', label: '峰值 / 小时', value: (row) => row.peakHourlyVotes, html: (row) => riskHot(row.peakHourlyVotes >= RISK_MARK.hourly, row.peakHourlyVotes), num: true };
  const marks = { key: 'marks', label: '提示', value: (row) => riskMarks(row).length, html: riskFlagHtml };
  const open = { key: '', label: '', html: (row) => `<button class="btn sm" type="button" ${drillAttrs(row)}>查看明细</button>` };
  if (group) {
    return [lead, votes,
      { key: 'actorCount', label: '账号 / 访客', value: (row) => row.actorCount, num: true,
        html: (row) => `${riskHot(row.actorCount >= RISK_MARK.crowd, `<button class="link-btn" type="button" data-risk-drill="${view}-actors" data-value="${esc(row.key)}" title="按账号 / 访客查看这里的投票人">${row.actorCount}</button>`)} <small class="muted">账号 ${row.accountCount} · 访客 ${row.visitorCount}</small>` },
      fast, winner, peak, marks, open];
  }
  if (view === 'model') {
    return [lead,
      { key: 'modelComparisons', label: '对该模型的比较', value: (row) => row.modelComparisons, html: (row) => `<b>${row.modelComparisons}</b>`, num: true },
      { key: 'wins', label: '胜 · 负 · 平', value: (row) => row.wins, html: (row) => `${row.wins} · ${row.losses} · ${row.ties}`, num: true },
      { key: 'winShare', label: '偏向该模型', value: (row) => row.winShare, html: (row) => riskHot(row.winShare != null && row.wins + row.losses >= RISK_MARK.decisiveMin && row.winShare >= RISK_MARK.winnerShare, riskPct(row.winShare)), num: true },
      votes, fast, marks, open];
  }
  return [lead, votes, peak, fast,
    { key: 'sharedIpOtherAccounts', label: '同 IP 其他账号', value: (row) => row.sharedIpOtherAccounts, num: true,
      html: (row) => riskHot(row.sharedIpOtherAccounts >= RISK_MARK.shared, row.sharedIpOtherAccounts ?? 0) },
    winner, marks, open];
}
function riskSorted(rows, columns) {
  const { sort, dir } = state.risk, column = columns.find((item) => item.key === sort && item.value);
  if (!column) return rows;
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((x, y) => {
    const a = column.value(x), b = column.value(y);
    if (a == null && b == null) return 0;
    if (a == null) return 1;
    if (b == null) return -1;
    return (typeof a === 'string' ? a.localeCompare(b, 'zh-CN') : a - b) * sign;
  });
}
function riskSummaryTable() {
  const r = state.risk, columns = riskColumns(), rows = riskSorted(r.data.rows, columns);
  if (!rows.length) return `<p class="board-empty">这个窗口内没有符合条件的记录。${r.view === 'model' ? `可以把「最少比较」调低（现在是 ${r.minVotes}）。` : ''}</p>`;
  return `<div class="table-wrap"><table class="board risk-table">
    <thead><tr>${columns.map((column) => `<th${column.num ? ' class="c-num"' : ''}${column.key === r.sort ? ` aria-sort="${r.dir === 'asc' ? 'ascending' : 'descending'}"` : ''}>${column.value
      ? `<button class="risk-sort" type="button" data-risk-sort="${column.key}">${column.label}${column.key === r.sort ? `<i aria-hidden="true">${r.dir === 'asc' ? '↑' : '↓'}</i>` : ''}</button>` : column.label}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((row) => `<tr${riskMarks(row).length ? ' class="has-mark"' : ''}>${columns.map((column) => `<td${column.num ? ' class="c-num"' : ''}>${column.html(row)}</td>`).join('')}</tr>`).join('')}</tbody>
  </table></div>`;
}
function riskChoiceStatus(row) {
  if (row.outcome === 'rejected') return `<span class="risk-state is-rejected" title="这次提交没有成功处理">未计入 · ${esc(RISK_ERROR[row.errorCode] ?? row.errorCode ?? '失败')}</span>`;
  return row.voidedAt ? '<span class="status status-questioned">已作废</span>' : '<span class="risk-state">有效</span>';
}
function riskChoicesTable() {
  const r = state.risk, rows = r.data.rows;
  if (!rows.length) return '<p class="board-empty">这个窗口内没有符合条件的投票记录。</p>';
  const selectable = rows.filter((row) => row.voteId);
  const allOn = selectable.length > 0 && selectable.every((row) => r.selected.has(row.voteId));
  return `<div class="table-wrap"><table class="board risk-table risk-choices">
    <thead><tr><th class="c-check"><input type="checkbox" data-risk-all aria-label="选择本页所有可作废的票"${allOn ? ' checked' : ''}${selectable.length ? '' : ' disabled'}></th>
      <th>时间</th><th>IP</th><th>账号 / 访客</th><th>题目</th><th>选择</th><th>胜出模型</th><th class="c-num">用时</th><th>状态</th><th></th></tr></thead>
    <tbody>${rows.map((row) => {
    const open = r.expanded.has(row.id);
    const slow = row.readyElapsedMs != null && row.readyElapsedMs <= 10000 && row.choice !== 'skip';
    return `<tr class="${row.voidedAt ? 'is-voided' : ''}${row.outcome === 'rejected' ? ' is-rejected' : ''}">
      <td class="c-check">${row.voteId ? `<input type="checkbox" data-risk-pick="${esc(row.voteId)}" aria-label="选择这张票"${r.selected.has(row.voteId) ? ' checked' : ''}>` : ''}</td>
      <td><time>${riskStamp(row.submittedAt)}</time></td>
      <td>${row.ip ? `<button class="link-btn mono" type="button" data-risk-drill="ip" data-value="${esc(row.ip)}" title="只看这个 IP" data-i18n-ignore>${esc(row.ip)}</button>` : `<span class="muted" title="原始 IP 已过期，只保留网段">已匿名化</span>`}<br>${row.subnet ? `<button class="link-btn mono small" type="button" data-risk-drill="subnet" data-value="${esc(row.subnet)}" title="只看这个网段" data-i18n-ignore>${esc(row.subnet)}</button>` : ''}</td>
      <td>${riskActor(row)}</td>
      <td data-i18n-ignore>${esc(taskTitle(row.taskId))}</td>
      <td>${RISK_CHOICE[row.choice] ?? esc(row.choice)}</td>
      <td>${row.winnerModel ? `<button class="link-btn" type="button" data-risk-model="${esc(row.winnerModel.key)}" title="反查给该模型投票的人" data-i18n-ignore>${esc(riskModelLabel(row.winnerModel))}</button>` : '<span class="muted">—</span>'}</td>
      <td class="c-num">${riskHot(slow, riskSeconds(row.readyElapsedMs))}</td>
      <td>${riskChoiceStatus(row)}</td>
      <td><button class="btn sm ghost" type="button" data-risk-expand="${esc(row.id)}" aria-expanded="${open}" aria-label="详情">${icon('more')}</button></td>
    </tr>${open ? `<tr class="risk-detail"><td></td><td colspan="9"><dl>
      <div><dt>抽题 IP</dt><dd class="mono" data-i18n-ignore>${esc(row.drawIp ?? '已匿名化')}${row.drawSubnet ? ` · ${esc(row.drawSubnet)}` : ''}</dd></div>
      <div><dt>浏览器标识</dt><dd class="mono" data-i18n-ignore>${esc(row.userAgent ?? '—')}</dd></div>
      <div><dt>人机验证</dt><dd>${row.turnstilePassed ? '本次通过' : '本次未验证'}${row.lastVerifiedAt ? ` · 最近通过 ${riskStamp(row.lastVerifiedAt)}` : ''}</dd></div>
      <div><dt>对阵</dt><dd data-i18n-ignore>A ${esc(riskModelLabel(row.aModel))} · B ${esc(riskModelLabel(row.bModel))}</dd></div>
      ${row.voidedAt ? `<div><dt>作废</dt><dd><span data-i18n-ignore>${esc(row.voidedBy ?? '')}</span> · ${riskStamp(row.voidedAt)} · <span data-i18n-ignore>${esc(row.voidReason ?? '')}</span></dd></div>` : ''}
    </dl></td></tr>` : ''}`;
  }).join('')}</tbody></table></div>`;
}
function riskPager() {
  const r = state.risk, total = r.data?.total ?? 0, rows = r.data?.rows.length ?? 0;
  if (!total) return '';
  return `<div class="admin-pagination risk-pager"><button class="btn sm" type="button" data-risk-page="${Math.max(0, r.offset - r.limit)}"${r.offset <= 0 ? ' disabled' : ''}>上一页</button>
    <span>第 ${r.offset + 1}–${r.offset + rows} 条 / 共 ${total} 条</span>
    <button class="btn sm" type="button" data-risk-page="${r.offset + r.limit}"${r.offset + r.limit >= total ? ' disabled' : ''}>下一页</button>
    <label class="risk-size">每页<select class="input" data-risk-field="limit" aria-label="每页条数">${[50, 100, 200].map((n) => `<option value="${n}"${n === r.limit ? ' selected' : ''}>${n}</option>`).join('')}</select></label></div>`;
}
function riskBar() {
  const r = state.risk, picked = [...r.selected.values()];
  if (!picked.length) return '';
  const live = picked.filter((item) => !item.voided).length, voided = picked.length - live;
  return `<div class="curated-bar risk-bar" role="region" aria-label="已选投票"><p><b>已选 ${picked.length} 张票</b> <span class="muted">${live ? `${live} 张有效` : ''}${live && voided ? ' · ' : ''}${voided ? `${voided} 张已作废` : ''}（可跨页累计，每次最多 200 张）</span></p>
    <div class="actions"><button class="btn" type="button" data-risk-clear>清空选择</button>${voided ? '<button class="btn" type="button" data-risk-restore>撤销作废…</button>' : ''}${live ? '<button class="btn primary danger" type="button" data-risk-void>软作废…</button>' : ''}</div></div>`;
}
function riskBody() {
  const r = state.risk, summary = r.view !== 'choices';
  const tabs = `<div class="seg risk-tabs" role="group" aria-label="查看方式">${RISK_VIEWS.map(([id, label]) => `<button type="button" data-risk-view="${id}" aria-pressed="${r.view === id}">${label}</button>`).join('')}</div>`;
  const tools = r.view === 'choices'
    ? `<label class="risk-inline">结果<select class="input" data-risk-field="outcome" aria-label="结果筛选"><option value="all"${r.outcome === 'all' ? ' selected' : ''}>全部</option><option value="accepted"${r.outcome === 'accepted' ? ' selected' : ''}>已处理</option><option value="rejected"${r.outcome === 'rejected' ? ' selected' : ''}>失败的提交</option></select></label>`
    : r.view === 'model' ? `<label class="risk-inline">最少比较<input class="input" type="number" min="1" step="1" value="${esc(r.minVotes)}" data-risk-field="minVotes" aria-label="最少比较次数"></label>` : '';
  let content;
  if (r.error) content = `<p class="form-error" role="alert">${esc(r.error)}</p>`;
  else if (r.view === 'model' && !r.modelKey.trim()) content = '<p class="board-empty">在上方「模型」里填入或选择一个模型，看看是谁在给它集中投票。也可以在别的表格里点模型名进入。</p>';
  else if (!r.data) content = skeleton(5);
  else content = summary ? riskSummaryTable() : riskChoicesTable();
  const started = r.data?.recordingStartedAt;
  const early = started && r.data.from && new Date(r.data.from) < new Date(started);
  const note = started ? `<p class="fine risk-note">证据从 ${formatDate(started)} 开始记录，更早的票没有 IP 与计时。${early ? '<b>所选窗口包含记录之前的时段，那部分不在统计内。</b>' : ''}原始 IP 保留 180 天，之后只保留网段。</p>` : '';
  const legend = summary ? `<p class="fine risk-note">「提示」只是阈值标记，不代表已判定刷票：快速 = 10 秒内完成的选择占 ≥${RISK_MARK.fastShare * 100}%（至少 ${RISK_MARK.fastMin} 次有计时）；偏向 = 决胜票 ≥${RISK_MARK.winnerShare * 100}% 投给同一模型（至少 ${RISK_MARK.decisiveMin} 张）；高频 = 单小时 ≥${RISK_MARK.hourly} 张；多人 = 同一 IP / 网段下 ≥${RISK_MARK.crowd} 个账号或访客；共享 IP = 与 ≥${RISK_MARK.shared} 个其他账号用过同一 IP。排序只作用于当前页（服务器按票数从多到少分页）。</p>` : '';
  // Regions are patched one by one (see paintRisk), so a reload never replaces the tabs under the pointer.
  const region = (name, html) => `<div data-risk-region="${name}">${html}</div>`;
  return region('toolbar', `<div class="risk-toolbar">${tabs}<span class="risk-tools">${tools}<button class="btn sm" type="button" data-risk-reload>${icon('reload')}刷新</button></span></div>${note}`)
    + region('results', `<div class="risk-results${r.loading ? ' is-loading' : ''}" aria-busy="${r.loading}">${content}</div>${r.data && !r.error ? riskPager() : ''}${legend}`)
    + region('bar', `<div data-risk-bar>${riskBar()}</div>`);
}
function riskFilters() {
  const r = state.risk, models = state.data?.models ?? [];
  const text = (name, label, placeholder, extra = '') => `<label class="field"><span class="field-label">${label}</span><input class="input mono" data-risk-field="${name}" value="${esc(r[name])}" placeholder="${placeholder}" autocomplete="off" spellcheck="false" ${extra}></label>`;
  return `<div class="risk-filters" data-risk-filters>
    <label class="field"><span class="field-label">时间窗口</span><select class="input" data-risk-field="range">${RISK_RANGES.map(([id, label]) => `<option value="${id}"${r.range === id ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
    ${r.range === 'custom' ? `<label class="field"><span class="field-label">起</span><input class="input" type="datetime-local" data-risk-field="from" value="${esc(r.from)}"></label>
      <label class="field"><span class="field-label">止</span><input class="input" type="datetime-local" data-risk-field="to" value="${esc(r.to)}"></label>` : ''}
    <label class="field"><span class="field-label">作废状态</span><select class="input" data-risk-field="voided"><option value="all"${r.voided === 'all' ? ' selected' : ''}>全部</option><option value="no"${r.voided === 'no' ? ' selected' : ''}>未作废</option><option value="yes"${r.voided === 'yes' ? ' selected' : ''}>已作废</option></select></label>
    ${text('ip', 'IP', '如 203.0.113.7')}${text('subnet', '网段', '如 203.0.113.0/24')}${text('userId', '账号 ID', '账号的用户 ID')}${text('visitorHash', '访客标识', '访客哈希')}
    <label class="field"><span class="field-label">模型</span><input class="input mono" data-risk-field="modelKey" list="risk-models" value="${esc(r.modelKey)}" placeholder="模型 id，自填模型为 x:名称" autocomplete="off" spellcheck="false"><datalist id="risk-models">${models.map((model) => `<option value="${esc(model.id)}">${esc(model.name)}</option>`).join('')}</datalist></label>
    <div class="field risk-reset"><button class="btn" type="button" data-risk-reset>清除筛选</button></div></div>`;
}
function voteRiskView() {
  return `${pageHero('投票风控', '投票风控', '从 IP、账号和模型三个角度找集中刷票的迹象。这里只展示证据，不会自动封号或作废；作废是软作废，可以随时撤销。', [['窗口', '—'], ['结果', '—'], ['已选', '0']])}
    <section class="block risk-page">${riskFilters()}<div data-risk-body>${riskBody()}</div></section>`;
}
function paintRisk() {
  const body = $('[data-risk-body]');
  if (!body) return;
  const next = document.createElement('div');
  next.innerHTML = riskBody();
  if (!$('[data-risk-region]', body)) body.innerHTML = next.innerHTML;
  else for (const fresh of $$('[data-risk-region]', next)) {
    const current = $(`[data-risk-region="${fresh.dataset.riskRegion}"]`, body);
    if (current.painted === fresh.innerHTML) continue;
    const scroll = $('.table-wrap', current)?.scrollLeft ?? 0;
    current.innerHTML = fresh.innerHTML;
    current.painted = fresh.innerHTML;
    const wrap = $('.table-wrap', current);
    if (wrap) wrap.scrollLeft = scroll;
  }
  const r = state.risk, stats = $$('.page-hero .stats dd');
  if (stats.length === 3) {
    stats[0].textContent = { '24h': '24 小时', '3d': '3 天', '7d': '7 天', '30d': '30 天', custom: '自定' }[r.range];
    stats[1].textContent = r.data ? String(r.data.total) : '—';
    stats[2].textContent = String(r.selected.size);
  }
}
function paintRiskBar() {
  const bar = $('[data-risk-bar]');
  if (bar) bar.innerHTML = riskBar();
  const stats = $$('.page-hero .stats dd');
  if (stats.length === 3) stats[2].textContent = String(state.risk.selected.size);
}
function riskGo(patch, { reset = true } = {}) {
  Object.assign(state.risk, patch);
  if (reset) state.risk.offset = 0;
  loadRisk();
}
function riskDrill(button) {
  const kind = button.dataset.riskDrill, none = { ip: '', subnet: '', userId: '', visitorHash: '' };
  const patch = kind === 'ip' ? { ...none, ip: button.dataset.value }
    : kind === 'subnet' ? { ...none, subnet: button.dataset.value }
      : kind === 'ip-actors' ? { ...none, ip: button.dataset.value }
        : kind === 'subnet-actors' ? { ...none, subnet: button.dataset.value }
          : { ...none, userId: button.dataset.user, visitorHash: button.dataset.user ? '' : button.dataset.visitor };
  riskGo({ ...patch, view: kind.endsWith('-actors') ? 'actor' : 'choices', sort: '' });
  $('[data-risk-filters]').outerHTML = riskFilters();
}
function riskVoteDialog(restore) {
  const r = state.risk, picked = [...r.selected.entries()].filter(([, item]) => item.voided === restore);
  if (!picked.length) return;
  if (picked.length > 200) { toast('一次最多处理 200 张票，请先取消一部分'); return; }
  const actors = new Set(picked.map(([, item]) => item.actor)).size, ips = new Set(picked.map(([, item]) => item.ip).filter(Boolean)).size;
  const sheet = openDialog({ title: restore ? `撤销 ${picked.length} 张票的作废` : `软作废 ${picked.length} 张票`, className: 'confirm-sheet', body: `<form class="admin-editor" novalidate>
    <p class="sheet-text">${restore ? `这 ${picked.length} 张票会重新计入大众榜与精选榜（仍受原有的有效性规则限制）。` : `涉及 ${actors} 个账号 / 访客、${ips} 个 IP。作废的票不再计入大众榜、精选榜和作品分，数据与重复投票限制都保留，之后可以撤销。`}</p>
    <label class="field"><span class="field-label">理由<small>必填，会记入审核记录</small></span><textarea class="input" name="reason" rows="3" maxlength="500" required placeholder="${restore ? '例如：复核后确认是同一办公室的正常投票' : '例如：同一网段 10 分钟内 120 张快速投票，集中投给同一模型'}"></textarea></label>
    <p class="form-error" role="alert"></p>
    <div class="sheet-actions"><button class="btn" type="button" data-sheet-close>取消</button><button class="btn primary${restore ? '' : ' danger'}" type="submit">${restore ? '确认撤销作废' : '确认作废'}</button></div></form>` });
  const form = $('form', sheet.el), line = $('.form-error', sheet.el);
  $('[name=reason]', form).focus();
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const reason = new FormData(form).get('reason').trim();
    if (!reason) { line.textContent = '请填写理由'; return; }
    const done = busy($('[type=submit]', form));
    try {
      const { changed } = await api(`admin/vote-risk/votes/${restore ? 'restore' : 'void'}`, { method: 'POST', body: { voteIds: picked.map(([id]) => id), reason } });
      for (const [id] of picked) r.selected.delete(id);
      sheet.close();
      toast(restore ? `已撤销 ${changed} 张票的作废` : `已作废 ${changed} 张票，榜单随即重算`);
      await loadRisk();
    } catch (error) {
      line.textContent = error.status === 404 ? '有票已不存在或不是盲评票，请刷新后重新选择' : error.message;
      done();
    }
  });
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('[data-risk-body], [data-risk-filters]')) return;
  const r = state.risk, hit = (selector) => e.target.closest(selector);
  const view = hit('[data-risk-view]');
  if (view) { if (r.view !== view.dataset.riskView) riskGo({ view: view.dataset.riskView, sort: '' }); return; }
  const drill = hit('[data-risk-drill]');
  if (drill) { riskDrill(drill); return; }
  const model = hit('[data-risk-model]');
  if (model) { riskGo({ modelKey: model.dataset.riskModel, view: 'model', sort: '' }); $('[data-risk-filters]').outerHTML = riskFilters(); return; }
  const sort = hit('[data-risk-sort]');
  if (sort) { const key = sort.dataset.riskSort; Object.assign(r, { sort: key, dir: r.sort === key && r.dir === 'desc' ? 'asc' : 'desc' }); paintRisk(); return; }
  const page = hit('[data-risk-page]');
  if (page && !page.disabled) { riskGo({ offset: Number(page.dataset.riskPage) }, { reset: false }); return; }
  if (hit('[data-risk-reload]')) { loadRisk(); return; }
  if (hit('[data-risk-reset]')) { Object.assign(r, { ip: '', subnet: '', userId: '', visitorHash: '', modelKey: '', voided: 'all', outcome: 'all', range: '7d', sort: '' }); riskGo({}); $('[data-risk-filters]').outerHTML = riskFilters(); return; }
  const expand = hit('[data-risk-expand]');
  if (expand) { const id = expand.dataset.riskExpand; r.expanded.has(id) ? r.expanded.delete(id) : r.expanded.add(id); paintRisk(); return; }
  if (hit('[data-risk-clear]')) { r.selected.clear(); paintRisk(); return; }
  if (hit('[data-risk-void]')) { riskVoteDialog(false); return; }
  if (hit('[data-risk-restore]')) { riskVoteDialog(true); }
});
document.addEventListener('change', (e) => {
  const target = e.target;
  if (!(target instanceof HTMLElement) || !target.closest('[data-risk-body], [data-risk-filters]')) return;
  const r = state.risk;
  if (target.matches('[data-risk-pick]')) {
    const row = r.data?.rows.find((item) => item.voteId === target.dataset.riskPick);
    if (!row) return;
    if (target.checked) r.selected.set(row.voteId, { voided: Boolean(row.voidedAt), actor: row.actorKey, ip: row.ip ?? row.subnet });
    else r.selected.delete(row.voteId);
    const all = $('[data-risk-all]');
    if (all) all.checked = r.data.rows.filter((item) => item.voteId).every((item) => r.selected.has(item.voteId));
    paintRiskBar();
    return;
  }
  if (target.matches('[data-risk-all]')) {
    for (const row of r.data?.rows ?? []) {
      if (!row.voteId) continue;
      if (target.checked) r.selected.set(row.voteId, { voided: Boolean(row.voidedAt), actor: row.actorKey, ip: row.ip ?? row.subnet });
      else r.selected.delete(row.voteId);
    }
    paintRisk();
    return;
  }
  const field = target.dataset.riskField;
  if (!field) return;
  let value = target.value;
  if (field === 'limit') value = Number(value);
  if (field === 'range' && value === 'custom' && !r.from) { r.from = riskLocal(new Date(Date.now() - 7 * 86400e3)); r.to = riskLocal(new Date()); }
  riskGo({ [field]: value });
  if (field === 'range') $('[data-risk-filters]').outerHTML = riskFilters();
});

async function reload({ navigation = false } = {}) {
  const requestId = ++state.requestId;
  const [route = 'works'] = routeParts();
  const system = state.system;
  if (route === 'review') { location.replace(REVIEW_URL); return; }
  if (!routeAllowed(route)) { location.hash = system === 'common' ? (isSenior() ? '#/dashboard' : '#/upload') : '#/works'; return; }
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
    else if (route === 'tasks') {
      const [questions, curated] = await Promise.all([api('admin/questions'), curatedOn() ? api('admin/curated').catch((error) => { state.curatedNote = `精选信息暂时无法载入：${error.message}`; return null; }) : null]);
      state.adminQuestions = questions.questions;
      if (curated) { state.curated = curated; if (!curatedDirty()) state.curatedNote = ''; }
    } else if (route === 'qualification') {
      state.qualification = await api('admin/qualification');
      await Promise.all([...new Set(state.qualification.pairs.map((pair) => pair.taskId))].map((taskId) => loadExamWorks(taskId).catch(() => [])));
    }
    else if (route === 'vote-risk') { if (navigation || !state.risk.data) loadRisk(); }
    else if (route === 'works') {
      const data = await api(`admin/works?${key}`);
      if (requestId !== state.requestId || system !== state.system || (routeParts()[0] || 'works') !== 'works') return;
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
  if (!isStaff(state.user)) return forbiddenView();
  const [route = 'works', sub] = routeParts();
  if (route === 'review') { location.replace(REVIEW_URL); return; }
  if (!routeAllowed(route, sub)) { location.hash = state.system === 'common' ? (isSenior() ? '#/dashboard' : '#/upload') : '#/works'; return; }
  const body = state.system === 'common'
    ? route === 'upload' ? uploadView() : route === 'users' ? usersView() : route === 'traffic' ? trafficView() : dashboardView()
    : route === 'works' ? systemWorksView() : route === 'intake' ? intakeView() : route === 'tasks' ? tasksView() : route === 'qualification' ? qualificationView() : route === 'vote-risk' ? voteRiskView() : placeholderView(route);
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
  if (route === 'tasks') syncCuratedUi();
  syncThemeUi();
}

async function boot() {
  try {
    const data = await api('bootstrap');
    state.user = data.user;
    state.questions = data.questions;
    state.reviewCounts = data.review;
    state.site = data.site;
    state.domainGroups = data.domainGroups;
    state.adminQuestions = null;
  } catch {
    state.user = null;
  }
  if (isStaff(state.user)) {
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
    if (!await leaveCurated()) return;
    state.system = system.dataset.system; store.set('admin-system', state.system); state.workPage = 1;
    applySystemTheme();
    if (routeParts()[0] === 'review') { location.replace(REVIEW_URL); return; }
    if (!routeAllowed(routeParts()[0])) location.hash = state.system === 'common' ? (isSenior() ? '#/dashboard' : '#/upload') : '#/works';
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
  const filterChip = e.target.closest('[data-curated-filter]');
  if (filterChip) { state.curatedFilter = filterChip.dataset.curatedFilter; state.curatedTarget = ''; paintCurated(); return; }
  if (e.target.closest('[data-curated-discard]')) { state.curatedDraft = null; state.curatedNote = ''; paintCurated(); return; }
  const curatedSave = e.target.closest('[data-curated-save]');
  if (curatedSave) { await saveCurated(curatedSave); return; }
  if (e.target.closest('[data-section-new]')) { sectionNameDialog(null); return; }
  const sectionMenu = e.target.closest('[data-section-menu]');
  if (sectionMenu) { const section = curatedSections().find((item) => item.id === sectionMenu.dataset.sectionMenu); if (section) sectionMenuDialog(section); return; }
  if (e.target.closest('[data-pair-new]')) { pairDialog(null); return; }
  const pairEdit = e.target.closest('[data-pair-edit]');
  if (pairEdit) { pairDialog(state.qualification?.pairs.find((item) => item.id === pairEdit.dataset.pairEdit)); return; }
  const pairToggle = e.target.closest('[data-pair-toggle]');
  if (pairToggle) { await togglePair(pairToggle); return; }
  if (e.target.closest('[data-exam-settings]')) { examSettingsDialog(); return; }
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
  if (calibrate) { const w = state.adminWorks.find((item) => `${item.task}/${item.id}` === calibrate.dataset.calibrate); if (w && canDecide(w)) calibrationDialog(w); return; }
  const preview = e.target.closest('[data-preview]');
  if (preview) {
    const work = state.adminWorks.find((item) => `${item.task}/${item.id}` === preview.dataset.preview);
    if (work) {
      const sheet = openDialog({ title: `预览 · ${work.title}`, body: '<p class="fine">正在载入…</p>' });
      try { const data = await api(`admin/works/${workKey(work)}/preview`, { method: 'POST' }); $('.sheet-body', sheet.el).innerHTML = `<iframe src="${esc(data.url)}" title="${esc(work.title)}" sandbox="allow-scripts allow-pointer-lock" style="width:100%;height:65vh;border:0"></iframe>`; }
      catch (error) { $('.sheet-body', sheet.el).textContent = error.message; }
    }
    return;
  }
  const editBtn = e.target.closest('[data-edit]');
  if (editBtn) {
    const w = [...state.adminWorks, ...(state.intake ?? [])].find((item) => `${item.task}/${item.id}` === editBtn.dataset.edit);
    if (w) editDialog(w);
    return;
  }
  if (e.target.closest('[data-new-question]')) { newQuestionDialog(); return; }
  const questionEdit = e.target.closest('[data-question-edit]');
  if (questionEdit) { const question = state.adminQuestions?.find((item) => item.id === questionEdit.dataset.questionEdit); if (question) questionDialog(question); return; }
  const questionDelete = e.target.closest('[data-question-delete]');
  if (questionDelete && !questionDelete.disabled && await confirmDialog({ title: '删除题目？', message: '题目与题下作品将不再公开。有票的题目不能删除。', confirm: '删除', danger: true })) {
    try { await api(`questions/${encodeURIComponent(questionDelete.dataset.questionDelete)}`, { method: 'DELETE' }); await reload(); toast('题目已删除'); } catch (error) { toast(error.message); }
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
    const work = state.adminWorks.find((w) => `${w.task}/${w.id}` === deleteBtn.dataset.delete);
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
      await api(`admin/users/${encodeURIComponent(user.id)}/role`, { method: 'POST', body: { level: target === 'admin' ? 3 : 0 } });
      toast(`${user.name} 现在是${target === 'admin' ? ' Lv3 高级管理员' : ' Lv0 成员'}`);
      await reload();
    } catch (error) {
      toast(error.message);
      doneBusy();
    }
  }
});
document.addEventListener('change', async (e) => {
  const curatedToggle = e.target.closest('[data-curated-toggle]');
  if (curatedToggle) {
    const id = curatedToggle.dataset.curatedToggle;
    const section = curatedTarget();
    if (curatedToggle.checked && !section) { curatedToggle.checked = false; toast('请先新建一个精选分区'); return; }
    stageCurated((draft) => { if (curatedToggle.checked) draft.set(id, section); else draft.delete(id); });
    paintCurated();
    return;
  }
  const curatedSection = e.target.closest('[data-curated-section]');
  if (curatedSection) { stageCurated((draft) => draft.set(curatedSection.dataset.curatedSection, curatedSection.value)); paintCurated(); return; }
  const curatedAll = e.target.closest('[data-curated-all]');
  if (curatedAll) {
    const section = curatedTarget();
    if (curatedAll.checked && !section) { curatedAll.checked = false; toast('请先新建一个精选分区'); return; }
    const rows = curatedRows().filter((row) => row.addable);
    stageCurated((draft) => { for (const row of rows) { if (curatedAll.checked) { if (!draft.has(row.task.id)) draft.set(row.task.id, section); } else draft.delete(row.task.id); } });
    paintCurated();
    return;
  }
  if (e.target.closest('[data-curated-target]')) { state.curatedTarget = e.target.value; return; }
  if (e.target.closest('[data-curated-type]')) { state.curatedType = e.target.value; paintCurated(); return; }
  const roleSelect = e.target.closest('[data-user-role]');
  if (roleSelect) {
    roleSelect.disabled = true;
    try { await api(`admin/users/${encodeURIComponent(roleSelect.dataset.userRole)}/role`, { method: 'POST', body: { level: Number(roleSelect.value) } }); await reload(); toast('等级已更新'); }
    catch (error) { toast(error.message); roleSelect.disabled = false; }
    return;
  }
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
  if (e.target.matches?.('[data-curated-search]')) { state.curatedSearch = e.target.value; paintCurated(); }
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
      toast(`已登记，等待人工核验：${data.work.title}`);
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
  state.workAuthor = form.elements.namedItem('author').value;
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
addEventListener('hashchange', async () => {
  if (!isStaff(state.user)) return;
  if (routeParts()[0] !== 'tasks' && !await leaveCurated()) { history.replaceState(null, '', '#/tasks'); return; }
  reload({ navigation: true });
});

boot();
