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
  verified: { label: '已验证', hint: '已核验，参与盲评并优先展示', icon: 'check' },
  unverified: { label: '未验证', hint: '等待核验：可以浏览和贴表情，暂不参与盲评', icon: 'clock' },
  questioned: { label: '存疑', hint: '核验存疑：仅供参考，不参与互动与盲评', icon: 'alert' },
};
const statusBadge = (status, reason = '') => {
  const info = STATUS[status];
  return info ? `<span class="status status-${status}" title="${esc(reason || info.hint)}">${icon(info.icon)}${info.label}</span>` : '';
};
const ACTIONS = { submit: '提交作品', verified: '通过验证', questioned: '标记存疑', unverified: '退回未验证', delete: '删除作品', role: '调整角色',
  'face-settings': '门面开关', meta: '编辑信息', curate: '收录为馆藏', nominate: '提名收录', 'withdraw-nomination': '撤回提名', 'inbox-upload': '收件箱上传', 'inbox-register': '登记入库', 'inbox-remove': '收件箱移除' };
// Per-face review: the same work is approved separately for the gallery (display)
// and the arena (blind test). `audience` carries both flags; adminWork rows also
// carry explicit show_gallery/show_arena.
const AUDIENCE_FACE = { gallery: ['show2', 'both'], arena: ['show1', 'both'] };
const faceOn = (w, face = state.system) => Boolean(w[`show_${face}`] ?? AUDIENCE_FACE[face].includes(w.audience));
const FACE_LABEL = { gallery: '展览馆', arena: '竞技场' };
const REVIEW_TABS = { pending: '待审', shown: '已展示', questioned: '存疑', log: '记录' };
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
  inbox: null, inboxForms: {} };
const taskTitle = (id) => [...(state.data?.tasks ?? []), ...(state.questions ?? [])].find((t) => t.id === id)?.title ?? id;

async function loadCatalog() {
  if (state.data) return;
  try {
    const response = await fetch('/data.json', { cache: 'no-store' });
    state.data = response.ok ? await response.json() : { tasks: [], models: [] };
  } catch {
    state.data = { tasks: [], models: [] };
  }
}

async function loadReview() {
  const data = await api('review');
  state.works = data.works;
  state.audit = data.audit;
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

// Quick "mark as questioned" with a mandatory reason, used by the works table.
function questionWork(w) {
  return new Promise((resolve) => {
    let done = false;
    const sheet = openDialog({
      title: `标记存疑：${w.title}`,
      className: 'confirm-sheet',
      onClose: () => resolve(done),
      body: `<form class="question-form" novalidate>
        <label class="field"><span class="field-label">存疑原因<small>必填，作者与访客都能看到</small></span><textarea class="input" name="reason" rows="3" maxlength="500" required>${esc(w.status === 'questioned' ? w.reason : '')}</textarea></label>
        <p class="form-error" role="alert"></p>
        <div class="sheet-actions"><button class="btn" type="button" data-sheet-close>取消</button><button class="btn primary danger" type="submit">${icon('alert')}标记存疑</button></div>
      </form>`,
    });
    const form = $('form', sheet.el);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const reason = form.reason.value.trim();
      if (!reason) { $('.form-error', form).textContent = '请写明存疑原因'; return; }
      const doneBusy = busy($('[type="submit"]', form), '正在保存…');
      try {
        await api(`works/${encodeURIComponent(w.task)}/${encodeURIComponent(w.id)}/review`, { method: 'POST', body: { status: 'questioned', reason } });
        done = true;
        sheet.close();
        toast(`已标记存疑：${w.title}`);
      } catch (error) {
        $('.form-error', form).textContent = error.message;
        doneBusy();
      }
    });
    setTimeout(() => form.reason.focus());
  });
}

// ---- work rows ------------------------------------------------------------------------------
function thumb(w) {
  const src = Object.values(w.captures ?? {})[0] ?? w.cover;
  const url = src ? (src.startsWith('http') ? src : `/${src}`) : '';
  return `<span class="work-thumb" aria-hidden="true">${url ? `<img src="${esc(url)}" alt="" loading="lazy" decoding="async">` : `<span class="img-empty upload-cover"><b>${esc(w.title)}</b></span>`}</span>`;
}

function workRow(w) {
  const face = state.system;
  const quick = w.status === 'questioned' ? '' : faceOn(w, face)
    ? `<button class="btn sm" data-face-off="${esc(w.id)}" title="本面撤下，不影响另一面">${icon('close')}撤下</button>`
    : `<button class="btn sm primary" data-verify="${esc(w.id)}" title="${w.source === 'curated' ? '让这件馆藏作品' : '内容核验通过并'}${face === 'gallery' ? '上展览馆' : '进入正式盲测'}">${icon('check')}${face === 'gallery' ? '上展览馆' : '进盲测'}</button>`;
  const source = w.source === 'curated' ? ['精选馆藏', esc(provenanceText(w))] : [esc(provenanceText(w) || w.tool)];
  const meta = [taskTitle(w.task), ...source, formatDate(w.addedAt), w.owner ? `投稿者 ${esc(w.owner)}` : ''].filter(Boolean).join(' · ');
  return `<article class="work-row" data-status="${esc(w.status)}">
    ${thumb(w)}
    <div class="work-main">
      <p class="work-model"><b>${esc(w.modelName)}</b>${w.effort ? `<span class="badge">${esc(w.effort)}</span>` : ''}<span class="badge">${esc(FACE_LABEL[face])}·${faceOn(w, face) ? '已展示' : '待审'}</span>${statusBadge(w.status, w.reason)}${w.audience === 'hidden' ? '<span class="badge">未展示</span>' : ''}</p>
      <h3>${esc(w.title)}</h3>
      <p class="work-meta">${meta}</p>
      ${w.reason ? `<p class="work-reason">${icon('alert')}<span>${esc(w.reason)}</span></p>` : ''}
    </div>
    <div class="work-side">
      <div class="actions">
        ${w.scene ? `<a class="btn sm" href="${esc(w.scene)}" target="_blank" rel="noopener">打开${icon('arrow')}</a>` : ''}
        ${quick}
        <button class="btn sm primary" data-review="${esc(w.id)}">审核</button>
        ${w.source !== 'curated' ? `<button class="icon-btn" data-delete="${esc(w.id)}" title="删除作品" aria-label="删除「${esc(w.title)}」">${icon('trash')}</button>` : ''}
      </div>
    </div>
  </article>`;
}

// ---- review sheet ----------------------------------------------------------------------------
function trialRows(trial) {
  if (!trial || trial.loaded === undefined) return '<li class="check is-info"><span><b>试加载</b>没有记录</span></li>';
  const rows = [
    trial.loaded ? ['ok', '页面载入', `${((trial.loadMs ?? 0) / 1000).toFixed(1)} 秒`] : ['fail', '页面载入', '作者提交时页面未完成载入'],
    trial.errors ? ['warn', '脚本错误', `${trial.errors} 条：${trial.errorSamples?.[0] ?? ''}`] : ['ok', '脚本错误', '没有'],
    trial.failedResources?.length ? ['warn', '资源加载', trial.failedResources.join('、')] : ['ok', '资源加载', '全部载入'],
    trial.blocked?.length ? ['warn', '外部请求', `被拦截：${trial.blocked.join('、')}`] : ['ok', '外部请求', '没有被拦截的请求'],
    trial.canvases || trial.media || trial.words > 20 ? ['ok', '画面内容', trial.canvases ? `${trial.canvases} 个画布` : '有可见内容'] : ['warn', '画面内容', '可能是空白页面'],
  ];
  return rows.map(([st, label, detail]) => `<li class="check is-${st}">${icon(st === 'ok' ? 'check' : st === 'fail' ? 'close' : 'alert')}<span><b>${esc(label)}</b>${esc(detail)}</span></li>`).join('');
}

// ---- provenance (Harness / provider) -------------------------------------------------------------
// Registries come from the datapack (/data.json). A select holds a registry id, '' for "not stated"
// or OTHER for free text; registry ids never contain '_', so OTHER cannot collide with one.
const PROVENANCE = { harness: { label: 'Harness', list: 'harnesses' }, provider: { label: '服务商', list: 'providers' } };
const OTHER = '__other';
const registry = (type) => state.data?.[PROVENANCE[type].list] ?? [];
const provenanceText = (w) => [w.harnessName && `${w.harnessName}${w.harnessVersion ? ` ${w.harnessVersion}` : ''}`, w.providerName].filter(Boolean).join(' · ');
const nameKey = (value) => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[\s-]/g, '');
const suggestEntry = (type, text) => {
  const key = nameKey(text);
  return key ? registry(type).find((entry) => [entry.name, ...(entry.aliases ?? [])].some((name) => nameKey(name) === key)) ?? null : null;
};
// The stored choice of a work: registry id, OTHER (free text only) or ''.
const currentProvenance = (w, type) => ({ choice: w?.[type] ?? (w?.[`${type}Name`] ? OTHER : ''), other: w?.[type] ? '' : w?.[`${type}Name`] ?? '' });

function suggestionHtml(type, choice, other) {
  const match = choice === OTHER ? suggestEntry(type, other) : null;
  return match ? `可能是 ${esc(match.name)}<button type="button" class="btn sm" data-pick-provenance="${type}" data-id="${esc(match.id)}">改选 ${esc(match.name)}</button>` : '';
}

const GENERATION_FIELDS = ['modelVersion', 'generationMode', 'humanIntervention', 'generatedOn', 'evidenceUrl'];
const GENERATION_CHOICES = {
  generationMode: { 'single-turn': '单轮生成', 'multi-turn': '多轮生成', agent: '智能体执行' },
  humanIntervention: { none: '仅初始提示，未修改代码', 'prompt-guided': '人工提示与指导（未改代码）', 'code-edited': '人工修改了代码' },
};
const GENERATION_LABELS = { generationMode: '生成方式', humanIntervention: '人工介入程度' };
function generationFields(work = {}) {
  const select = (key) => `<label class="field"><span class="field-label">${GENERATION_LABELS[key]}</span><select class="input" name="${key}"><option value="">未注明</option>${Object.entries(GENERATION_CHOICES[key]).map(([value, label]) => `<option value="${value}"${work[key] === value ? ' selected' : ''}>${label}</option>`).join('')}</select></label>`;
  return `<details class="generation-fields"${GENERATION_FIELDS.some((key) => work[key]) ? ' open' : ''}><summary>生成与证据信息（选填）</summary>
    <div class="field-row"><label class="field"><span class="field-label">模型版本 / 快照<small>模型的具体版本，区别于 Harness 版本</small></span><input class="input" name="modelVersion" maxlength="60" value="${esc(work.modelVersion)}" placeholder="按原始记录填写"></label>
      <label class="field"><span class="field-label">生成日期<small>区别于上传日期</small></span><input class="input" type="date" name="generatedOn" value="${esc(work.generatedOn)}"></label></div>
    <div class="field-row">${select('generationMode')}${select('humanIntervention')}</div>
    <label class="field"><span class="field-label">公开证据链接<small>对话分享、运行记录等；请勿填写私密链接</small></span><input class="input" type="url" name="evidenceUrl" maxlength="2000" value="${esc(work.evidenceUrl)}" placeholder="https://…"></label>
    <p class="fine">只填写有记录支持的信息；未注明与没有人工介入是不同含义。</p></details>`;
}
const generationBody = (get, work = {}) => Object.fromEntries(GENERATION_FIELDS
  .map((key) => [key, String(get(key) ?? '').trim()]).filter(([key, value]) => value !== (work[key] ?? '')));
const generationFacts = (work) => `<div><dt>模型版本</dt><dd>${esc(work.modelVersion || '未注明')}</dd></div>
  ${Object.keys(GENERATION_CHOICES).map((key) => `<div><dt>${GENERATION_LABELS[key]}</dt><dd>${esc(GENERATION_CHOICES[key][work[key]] || '未注明')}</dd></div>`).join('')}
  <div><dt>生成日期</dt><dd>${esc(work.generatedOn || '未注明')}</dd></div>
  <div><dt>公开证据</dt><dd>${/^https?:\/\//i.test(work.evidenceUrl ?? '') ? `<a href="${esc(work.evidenceUrl)}" target="_blank" rel="noopener noreferrer">查看记录</a>` : '未注明'}</dd></div>`;
let effortInputId = 0;
function effortField(value = '') {
  const id = `admin-efforts-${++effortInputId}`;
  return `<label class="field"><span class="field-label">推理档位<small>可选择常用值或手填；留空表示未注明</small></span><input class="input" name="effort" list="${id}" maxlength="20" value="${esc(value)}" placeholder="未注明"><datalist id="${id}">${['Default', 'Low', 'Medium', 'High', 'XHigh', 'Max'].map((effort) => `<option value="${effort}">${effort === 'Default' ? '默认档位（明确使用默认设置）' : effort}</option>`).join('')}</datalist></label>`;
}

function provenanceFields({ harness = { choice: '', other: '' }, provider = { choice: '', other: '' }, version = '' } = {}) {
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
  return `<div class="field-row">${field('harness', harness)}
      <label class="field"><span class="field-label">Harness 版本<small>选填</small></span><input class="input" name="harnessVersion" maxlength="40" value="${esc(version)}" placeholder="例如 2.1.3"${harness.choice ? '' : ' disabled'}></label>
    </div>
    <div class="field-row">${field('provider', provider)}</div>`;
}

function refreshProvenance(form) {
  for (const type of Object.keys(PROVENANCE)) {
    const choice = form.elements.namedItem(`${type}Choice`);
    if (!choice) continue;
    const other = form.elements.namedItem(`${type}Other`).value;
    $(`[data-provenance-other="${type}"]`, form).hidden = choice.value !== OTHER;
    const suggestion = $(`[data-provenance-suggestion="${type}"]`, form);
    suggestion.innerHTML = suggestionHtml(type, choice.value, other);
    suggestion.hidden = !suggestion.innerHTML;
  }
  const version = form.elements.namedItem('harnessVersion');
  if (version) version.disabled = !form.elements.namedItem('harnessChoice').value;
}

// Request fields for the chosen provenance. With `work`, only changed fields are sent; an id and
// its free text are always sent together so the server clears the other half.
function provenanceBody(get, work = null) {
  const body = {};
  for (const type of Object.keys(PROVENANCE)) {
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
  const version = get('harnessChoice') ? String(get('harnessVersion') ?? '').trim() : '';
  if (work ? version !== (work.harnessVersion ?? '') : version) body.harnessVersion = version;
  return body;
}

const provenanceFacts = (w) => `<div><dt>Harness</dt><dd>${esc(w.harnessName ? `${w.harnessName}${w.harnessVersion ? ` ${w.harnessVersion}` : ''}` : '未注明')}</dd></div>
  <div><dt>服务商</dt><dd>${esc(w.providerName ?? '未注明')}</dd></div>`;

// Curated works are repo-managed: reviewing one only decides the current face's flag.
function openCuratedReview(w) {
  const face = state.system;
  const sheet = openDialog({
    title: `${FACE_LABEL[face]}审核 · 精选馆藏`,
    className: 'review-sheet',
    body: `<div class="review solo">
      <div class="review-facts">
        <div class="review-head">${thumb(w)}<div><h3>${esc(w.title)}</h3><p class="work-model"><span class="badge">精选馆藏</span><span>${esc(taskTitle(w.task))}</span></p></div></div>
        <dl class="facts">
          <div><dt>声明的模型</dt><dd>${esc(w.modelName)}${w.vendor ? ` · ${esc(w.vendor)}` : ''}</dd></div>
          <div><dt>推理档位</dt><dd>${esc(w.effort || '未注明')}</dd></div>
          ${provenanceFacts(w)}
          ${generationFacts(w)}
        </dl>
        <p class="fine">馆藏作品的标题与信息由仓库收录流程管理，这里只决定它在${esc(FACE_LABEL[face])}的展示。</p>
        <div class="face-decision">
          <p class="face-state">${faceOn(w) ? `${FACE_LABEL[face]}：已${face === 'gallery' ? '展示' : '进正式盲测池'}` : `${FACE_LABEL[face]}：未${face === 'gallery' ? '展示' : '进盲测'}`}</p>
          <p class="fine">本面动作只改${FACE_LABEL[face]}，另一面（${face === 'gallery' ? `盲测：${faceOn(w, 'arena') ? '已进' : '未进'}` : `展览馆：${faceOn(w, 'gallery') ? '已展示' : '未展示'}`}）保持不变。</p>
          ${face === 'arena' ? '<label class="face-checks"><input type="checkbox" disabled> 娱乐盲测<small>待接线：接线后作品可进 Show1 娱乐面与老作品对打</small></label>' : ''}
        </div>
        <p class="form-error" role="alert"></p>
        <div class="sheet-actions"><span class="spacer"></span>
          ${faceOn(w)
            ? `<button type="button" class="btn" data-face-decide="hide">从${FACE_LABEL[face]}${face === 'gallery' ? '撤下' : '移出'}</button>`
            : `<button type="button" class="btn primary" data-face-decide="show">${icon('check')}${face === 'gallery' ? '通过并上展览馆' : '通过并进盲测'}</button>`}
        </div>
      </div>
    </div>`,
  });
  sheet.el.addEventListener('click', async (e) => {
    const decide = e.target.closest('[data-face-decide]');
    if (!decide) return;
    const mode = decide.dataset.faceDecide;
    const doneBusy = busy(decide, '正在保存…');
    try {
      await api(`admin/works/${workKey(w)}/face-settings`, { method: 'POST', body: { [`show_${face}`]: mode === 'show' } });
      sheet.close();
      toast(`${mode === 'show' ? `已${face === 'gallery' ? '上展览馆' : '进盲测'}` : `已从${FACE_LABEL[face]}${face === 'gallery' ? '撤下' : '移出'}`}：${w.title}`);
      await reload();
    } catch (error) { $('.form-error', sheet.el).textContent = error.message; doneBusy(); }
  });
}

function openReview(w) {
  if (w.source === 'curated') return openCuratedReview(w);
  const face = state.system;
  const vendors = new Map();
  for (const model of state.data?.models ?? []) {
    if (!vendors.has(model.vendor)) vendors.set(model.vendor, []);
    vendors.get(model.vendor).push(model);
  }
  const options = [...vendors].sort(([a], [b]) => a.localeCompare(b, 'en', { sensitivity: 'base' }))
    .map(([vendor, models]) => `<optgroup label="${esc(vendor)}">${models.map((m) => `<option value="${esc(m.id)}"${m.id === w.model ? ' selected' : ''}>${esc(m.name)}</option>`).join('')}</optgroup>`).join('');
  const sheet = openDialog({
    title: `${FACE_LABEL[face]}审核`,
    className: 'review-sheet',
    body: `<div class="review">
      <div class="review-facts">
        <div class="review-head">${thumb(w)}<div><h3>${esc(w.title)}</h3><p class="work-model">${statusBadge(w.status)}<span>${esc(taskTitle(w.task))}</span></p>
          <div class="actions"><a class="btn sm" href="${esc(w.scene)}" target="_blank" rel="noopener">在新窗口打开${icon('arrow')}</a></div></div></div>
        <dl class="facts">
          <div><dt>投稿者</dt><dd>${esc(w.owner ?? '已注销的用户')} · ${formatTime(w.addedAt)}</dd></div>
          <div><dt>声明的模型</dt><dd>${esc(w.modelName)}${w.vendor ? ` · ${esc(w.vendor)}` : ''}${w.model ? '' : '（未登记）'}</dd></div>
          <div><dt>推理档位</dt><dd>${esc(w.effort || '未注明')}</dd></div>
          ${provenanceFacts(w)}
          ${generationFacts(w)}
          <div><dt>作者原始声明</dt><dd>${esc(w.tool || '未注明')}</dd></div>
          <div><dt>文件</dt><dd>${esc(w.sourceName ?? '')} · ${w.files} 个 · ${formatBytes(w.bytes)} · 入口 ${esc(w.root ? `${w.root}/` : '')}${esc(w.entry ?? '')}</dd></div>
          ${w.reviewer ? `<div><dt>上次核验</dt><dd>${esc(w.reviewer)} · ${formatTime(w.reviewedAt)}</dd></div>` : ''}
        </dl>
        ${w.summary ? `<p class="review-text">${esc(w.summary)}</p>` : ''}
        <h4>生成说明</h4><p class="review-text">${w.note ? esc(w.note) : '<span class="muted">投稿者没有填写。</span>'}</p>
        <h4>上传检查</h4><ul class="checks">${(w.checks ?? []).map((c) => `<li class="check is-${c.state}">${icon(c.state === 'ok' ? 'check' : c.state === 'info' ? 'guide' : 'alert')}<span><b>${esc(c.label)}</b>${esc(c.detail)}</span></li>`).join('')}</ul>
        <h4>作者浏览器中的试加载</h4><ul class="checks">${trialRows(w.trial)}</ul>
        <h4>试加载</h4><div class="trial-live"><iframe src="${esc(w.scene)}" title="试加载「${esc(w.title)}」" loading="lazy"></iframe></div>
      </div>
      <form class="review-form" novalidate>
        <h4>核验清单</h4>
        <ul class="review-list">
          <li><label><input type="checkbox">作品能正常运行，内容符合本题提示词</label></li>
          <li><label><input type="checkbox">模型与档位有可信依据（生成说明、记录链接）</label></li>
          <li><label><input type="checkbox">画面中没有写出模型名称，不会破坏双盲</label></li>
          <li><label><input type="checkbox">没有外部追踪、恶意代码或不当内容</label></li>
        </ul>
        <p class="fine">清单只是提醒，不会随结果保存。</p>
        <div class="field-row">
          <label class="field"><span class="field-label">登记为模型<small>挂到模型档案，排行榜按模型记分</small></span><select class="input" name="modelId"><option value="">保持声明：${esc(w.modelName)}</option>${options}</select></label>
          ${effortField(w.effort)}
        </div>
        <label class="field"><span class="field-label">作品标题</span><input class="input" name="title" maxlength="40" value="${esc(w.title)}" required></label>
        <label class="field"><span class="field-label">模型名称<small>展签显示的名字</small></span><input class="input" name="modelName" maxlength="60" value="${esc(w.modelName)}" required></label>
        <label class="field"><span class="field-label">作品摘要</span><textarea class="input" name="summary" maxlength="200" rows="2">${esc(w.summary)}</textarea></label>
        ${provenanceFields({ harness: currentProvenance(w, 'harness'), provider: currentProvenance(w, 'provider'), version: w.harnessVersion ?? '' })}
        ${generationFields(w)}
        <div class="face-decision">
          <p class="face-state">${faceOn(w) ? `${FACE_LABEL[face]}：已${face === 'gallery' ? '展示' : '进正式盲测池'}` : `${FACE_LABEL[face]}：未${face === 'gallery' ? '展示' : '进盲测'}`}</p>
          <p class="fine">本面动作只改${FACE_LABEL[face]}，另一面（${face === 'gallery' ? `盲测：${faceOn(w, 'arena') ? '已进正式盲测池' : '未进'}` : `展览馆：${faceOn(w, 'gallery') ? '已展示' : '未展示'}`}）保持不变。</p>
          ${face === 'arena' ? '<label class="face-checks"><input type="checkbox" disabled> 娱乐盲测<small>待接线：接线后作品可进 Show1 娱乐面与老作品对打</small></label>' : ''}
        </div>
        <label class="field"><span class="field-label">说明<small>标记存疑时必填，作者与访客都能看到</small></span><textarea class="input" name="reason" rows="3" maxlength="500">${esc(w.status === 'questioned' ? w.reason : '')}</textarea></label>
        <p class="form-error" role="alert"></p>
        <div class="sheet-actions">
          <button type="button" class="btn danger ghost" data-remove>${icon('trash')}删除</button>
          <span class="spacer"></span>
          <button type="button" class="btn" data-decide="questioned">${icon('alert')}标记存疑</button>
          ${faceOn(w)
            ? `<button type="button" class="btn" data-decide="hide">从${FACE_LABEL[face]}${face === 'gallery' ? '撤下' : '移出'}</button>`
            : `<button type="button" class="btn primary" data-decide="show">${icon('check')}${face === 'gallery' ? '通过并上展览馆' : '通过并进盲测'}</button>`}
        </div>
      </form>
    </div>`,
  });
  const form = $('form', sheet.el);
  sheet.el.addEventListener('click', async (e) => {
    const decide = e.target.closest('[data-decide]');
    if (e.target.closest('[data-remove]')) {
      sheet.close();
      if (await removeWork(w)) await reload();
      return;
    }
    if (!decide) return;
    const field = (name) => form.elements.namedItem(name);
    if (decide.dataset.decide === 'questioned' && !field('reason').value.trim()) {
      $('.form-error', form).textContent = '标记存疑时请写明原因，作者和访客都会看到';
      return;
    }
    // Only the current face's flag moves; the server keeps the other face as-is.
    const mode = decide.dataset.decide;
    let provenance;
    try { provenance = provenanceBody((name) => field(name)?.value, w); }
    catch (error) { $('.form-error', form).textContent = error.message; return; }
    const body = { status: mode === 'show' ? 'verified' : mode === 'hide' ? w.status : 'questioned',
      reason: field('reason').value, effort: field('effort').value, ...generationBody((name) => field(name)?.value, w),
      title: field('title').value, summary: field('summary').value,
      [`show_${face}`]: mode === 'show', ...provenance };
    if (field('modelId').value) body.modelId = field('modelId').value;
    else if (field('modelName').value !== w.modelName) body.modelName = field('modelName').value;
    $$('[data-decide]', form).forEach((b) => { b.disabled = true; });
    const doneBusy = busy(decide, '正在保存…');
    try {
      await api(`works/${encodeURIComponent(w.task)}/${encodeURIComponent(w.id)}/review`, { method: 'POST', body });
      sheet.close();
      toast(`${{ show: `已${face === 'gallery' ? '上展览馆' : '进盲测'}`, hide: `已从${FACE_LABEL[face]}${face === 'gallery' ? '撤下' : '移出'}`, questioned: '已标记存疑' }[mode]}：${w.title}`);
      await reload();
    } catch (error) {
      $('.form-error', form).textContent = error.message;
      doneBusy();
      $$('[data-decide]', form).forEach((b) => { b.disabled = false; });
    }
  });
}

// ---- views -----------------------------------------------------------------------------------
const app = () => $('#app');
const routeParts = () => location.hash.replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean);
// Face systems carry only their own pages; everything shared lives in the common area.
const TABS = [
  { id: 'review', label: '审核', icon: 'shield' },
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
  ['内容管理', [['works', '作品管理', 'file', '#/works'], ['tasks', '题目管理', 'guide', '#/tasks'], ['review', '审核', 'shield', '#/review']]],
  ['玩法', [['guess', '模一把', 'game', '#/guess'], ['activity', '活动管理', 'calendar', '#/activity']]],
];
const systemSwitch = () => `<div class="system-switch" role="group" aria-label="管理系统"><button type="button" data-system="gallery" aria-pressed="${state.system === 'gallery'}">展览馆系统</button><button type="button" data-system="arena" aria-pressed="${state.system === 'arena'}">竞技场系统</button><button type="button" data-system="common" aria-pressed="${state.system === 'common'}">通用后台</button></div>`;

const routeAllowed = (route, sub) => state.system === 'common'
  ? COMMON_TABS.some((tab) => tab.id === route)
  : TABS.some((tab) => tab.id === route) || (state.system === 'arena' && ['guess', 'activity'].includes(route));
const tabsForSystem = () => state.system === 'common' ? COMMON_TABS : TABS;

function topbar(route) {
  if (state.system === 'arena') return `<header class="topbar arena-topbar">
    <div class="arena-page-mark"><span class="eyebrow">偏见试验场 / 管理工作台</span><strong>${esc(TABS.find((tab) => tab.id === route)?.label ?? '竞技场')}</strong></div>
    <span class="topbar-space"></span>${systemSwitch()}${themeButton()}
    <span class="user-chip" title="当前账号"><span class="avatar" aria-hidden="true">${esc(state.user.name.slice(0, 1).toUpperCase())}</span><span class="user-name">${esc(state.user.name)}</span></span>
    <button class="icon-btn" data-logout title="退出登录" aria-label="退出登录">${icon('logout')}</button>
  </header>`;
  return `<header class="topbar">
    <a class="brand" href="${state.system === 'common' ? '#/dashboard' : '#/review'}">${LOGO}<span class="brand-name">同题异答<b>${state.system === 'common' ? '通用后台' : '管理后台'}</b></span></a>
    ${systemSwitch()}
    <nav class="tabs" aria-label="管理">
      ${tabsForSystem().map((tab) => `<a href="#/${tab.id}"${tab.id === route ? ' aria-current="page"' : ''}>${icon(tab.icon)}${tab.label}</a>`).join('')}
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
    <nav class="sidebar-nav">${ARENA_NAV.map(([group, items]) => `<div class="sidebar-group"><span class="sidebar-caption">${group}</span>${items.map(([id, label, glyph, href]) => `<a href="${href}" title="${label}" ${selected === id ? 'aria-current="page"' : ''}>${icon(glyph)}<span class="sidebar-label">${label}</span>${id === 'review' && state.works ? `<i>${state.works.filter((w) => w.status !== 'questioned' && !faceOn(w, 'arena')).length}</i>` : ''}</a>`).join('')}</div>`).join('')}</nav>
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
      harnessChoice: '', harnessOther: '', harnessVersion: '', providerChoice: '', providerOther: '',
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
        ${provenanceFields({ harness: { choice: form.harnessChoice, other: form.harnessOther }, provider: { choice: form.providerChoice, other: form.providerOther }, version: form.harnessVersion })}
        ${generationFields(form)}
        <p class="fine">登记只是入库，不决定展示：作品会同时出现在两边的审核队列——展览馆系统审「上不上展览馆」，竞技场系统审「进不进盲测」，两边各审一次。</p>
        <p class="form-error" role="alert"></p>
        <div class="actions"><button type="button" class="btn sm danger ghost" data-inbox-remove>${icon('trash')}移除</button><span class="spacer"></span><button class="btn sm primary" type="submit">${icon('check')}登记入库</button></div>
      </form>
    </article>`;
  }).join('');
  return `<section class="block inbox-panel" aria-label="管理员代传">
    <div class="inbox-head"><h2>管理员代传 · 收件箱</h2><span class="muted">文件先暂存在这里预览，登记后才进入待核验队列</span><button class="btn sm" type="button" data-inbox-reload>${icon('reload')}刷新</button></div>
    <div class="inbox-drop" data-inbox-drop>
      <input class="inbox-file-input" type="file" accept=".html,.htm,.zip" multiple data-inbox-input aria-hidden="true" tabindex="-1">
      <p><b>把 HTML 单文件或 ZIP 拖到这里</b>，或</p>
      <button class="btn" type="button" data-inbox-pick>选择文件</button>
      <p class="fine">支持多选，单件不超过 30 MB。文件名用「标题，模型名.html」可以自动填表。</p>
    </div>
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

function reviewView(sub) {
  const tab = Object.hasOwn(REVIEW_TABS, sub ?? '') ? sub : 'pending';
  const works = state.works ?? [];
  const face = state.system;
  const count = (kind) => works.filter((w) => kind === 'questioned' ? w.status === 'questioned' : kind === 'shown' ? faceOn(w, face) : !faceOn(w, face) && w.status !== 'questioned').length;
  let list;
  if (tab === 'log') {
    list = auditList(state.audit.length);
  } else {
    const rows = works.filter((w) => tab === 'questioned' ? w.status === 'questioned' : tab === 'shown' ? faceOn(w, face) : !faceOn(w, face) && w.status !== 'questioned')
      .sort((a, b) => (tab === 'pending' ? Date.parse(a.addedAt) - Date.parse(b.addedAt) : Date.parse(b.addedAt) - Date.parse(a.addedAt)));
    list = rows.length
      ? `<div class="work-list">${rows.map(workRow).join('')}</div>`
      : `<div class="board-empty"><p class="board-empty-title">${tab === 'pending' ? `没有等待${FACE_LABEL[face]}审核的作品` : tab === 'shown' ? `${FACE_LABEL[face]}还没有展示中的作品` : '没有存疑的投稿'}</p><p>${tab === 'pending' ? '新登记或新投稿的作品会出现在这里，审核决定它在本面的展示。' : tab === 'shown' ? `在本面审核通过的作品会展示在这里。` : '无法核实的作品标记存疑并写明原因。'}</p></div>`;
  }
  const lead = face === 'gallery'
    ? '决定哪些作品上展览馆展示；盲测的进出在竞技场系统里审，两边互不影响。'
    : '决定哪些作品进入盲测；展览馆的上下架在展览馆系统里审，两边互不影响。';
  return `${pageHero('审核管理', '审核', lead, [['待审', count('pending')], ['已展示', count('shown')], ['存疑', count('questioned')]])}
  <section class="block">
    <nav class="seg review-tabs" aria-label="审核分类">${Object.entries(REVIEW_TABS).map(([id, text]) => `<a href="#/review/${id}"${id === tab ? ' aria-current="page"' : ''}>${text}${id === 'log' ? '' : `<span>${count(id)}</span>`}</a>`).join('')}</nav>
    ${state.works === null ? skeleton(5) : list}
  </section>`;
}

// -- common area: dashboard + unified upload -----------------------------------
const auditList = (limit) => {
  const titles = new Map((state.works ?? []).map((w) => [w.id, w.title]));
  return state.audit.length
    ? `<ol class="audit">${state.audit.slice(0, limit).map((row) => `<li><time>${formatTime(row.at)}</time><span class="audit-actor">${esc(row.actor)}</span><b>${esc(ACTIONS[row.action] ?? row.action)}</b><span class="audit-work">${row.work ? esc(titles.get(row.work) ?? `${row.work}（已删除）`) : ''}${row.detail ? ` · ${esc(row.detail)}` : ''}</span></li>`).join('')}</ol>`
    : '<p class="muted">还没有记录。</p>';
};

function dashboardView() {
  const works = state.works;
  const pending = (face) => (works ? works.filter((w) => w.status !== 'questioned' && !faceOn(w, face)).length : '—');
  const traffic = state.traffic;
  return `${pageHero('总览', '仪表盘', '两个系统共用的后台：作品从这里统一上传，两边的审核进度和访问概况在这里看。', [
    ['投稿作品', works ? works.length : '—'], ['展览馆待审', pending('gallery')], ['竞技场待审', pending('arena')], ['用户', traffic ? traffic.users.total : '—']])}
  <section class="block dashboard-actions">
    <button class="btn primary" type="button" data-goto-system="gallery">${icon('file')}进展览馆系统审核</button>
    <button class="btn primary" type="button" data-goto-system="arena">${icon('shield')}进竞技场系统审核</button>
    <a class="btn" href="#/upload">${icon('inbox')}统一上传入口</a>
  </section>
  ${traffic ? `<section class="block"><h2>访问近 14 日</h2><div class="traffic-bars" aria-label="近 14 日访问量">${traffic.daily.slice(-14).map((d) => { const max = Math.max(1, ...traffic.daily.slice(-14).map((x) => x.pv)); return `<div class="traffic-day" title="${d.day}：${d.pv} PV，${d.uniqueIps} 位独立访客"><div class="traffic-bar" style="height:${Math.max(2, d.pv / max * 100)}%"></div><span>${d.day.slice(5)}</span></div>`; }).join('')}</div><p class="fine">近 30 日新注册 ${traffic.users.new} 人，累计 ${traffic.users.total} 人。<a href="#/traffic">完整访问概况</a></p></section>` : `<section class="block" aria-busy="true"><h2>访问近 14 日</h2>${skeleton(6, 'bar')}</section>`}
  <section class="block"><h2>最近操作</h2>${state.works === null ? skeleton(4) : auditList(12)}</section>`;
}

function uploadView() {
  const entries = state.inbox ?? [];
  return `${pageHero('统一上传入口', '上传', '两个系统共用的代传收件箱：上传暂存、预览、登记入库。登记只是入库——之后在展览馆系统审展示，在竞技场系统审盲测。', [['暂存', entries.length]])}
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
  return `<tr data-work-key="${esc(`${w.task}/${w.id}`)}">
    <td><input type="checkbox" data-select-work="${esc(`${w.task}/${w.id}`)}" aria-label="选择${esc(w.title)}" ${promoted ? 'disabled' : ''}></td>
    <td><div class="admin-work-title">${thumb(w)}<div><b>${esc(w.title)}</b><small>${esc(taskTitle(w.task))}</small></div></div></td>
    <td>${esc(w.modelName)}${provenanceText(w) ? `<small class="work-provenance">${esc(provenanceText(w))}</small>` : ''}</td><td>${w.source === 'curated' ? '精选' : '投稿'}</td><td>${statusBadge(w.status)}</td>
    <td>${promoted ? '—' : `<label class="face-toggle"><input type="checkbox" data-face-toggle="${esc(w.id)}" ${w[`show_${face}`] ? 'checked' : ''} aria-label="${esc(w.title)}${face === 'gallery' ? '在展览馆显示' : '进正式盲测'}">${w[`show_${face}`] ? '已开启' : '已关闭'}</label>`}</td>
    ${face === 'arena' ? `<td>${promoted ? '已收录' : w.status === 'verified' && w.show_arena ? '在正式盲测池' : '不在正式盲测池'}</td>` : '<td>—</td>'}
    <td><div class="actions">${promoted ? '<span class="badge">已收录</span>' : w.nominatedAt ? '<span class="badge">已提名</span>' : ''}<button class="btn sm" data-calibrate="${esc(w.id)}">${label}取景</button><button class="btn sm" data-task-note="${esc(w.task)}">${face === 'gallery' ? '策展笔记' : '题目点评'}</button>${w.source === 'upload' ? `${curable ? `<button class="btn sm primary" data-nominate="${esc(w.id)}">${w.nominatedAt ? '换发命令' : '提名收录'}</button>` : ''}${w.nominatedAt && !promoted ? `<button class="btn sm" data-withdraw="${esc(w.id)}">撤回提名</button>` : ''}<button class="btn sm" data-edit="${esc(w.id)}">编辑</button><button class="btn sm" data-review="${esc(w.id)}">审核</button>` : ''}</div></td>
  </tr>`;
}
function systemWorksView() {
  const face = state.system;
  const works = state.adminWorks;
  const tasks = [...(state.data?.tasks ?? []), ...(state.questions ?? [])];
  const options = tasks.map((t) => `<option value="${esc(t.id)}" ${state.workTask === t.id ? 'selected' : ''}>${esc(t.title)}</option>`).join('');
  const pages = Math.max(1, Math.ceil(state.workTotal / 30));
  const rows = works.map((w) => adminWorkRow(w, face)).join('');
  return `${pageHero('作品管理', `${faceLabel()}作品`, '精选与投稿共用作品库，开关和取景分别保存。', [['全部作品', state.workTotal], ['本页', works.length]])}
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
        const choices = [['unset', '未注明'], ['other', '其他（手填）'], ...registry(type).map((entry) => [entry.id, entry.name])];
        return `<select class="input" name="${type}" aria-label="筛选${PROVENANCE[type].label}"><option value="">全部${PROVENANCE[type].label}</option>${choices.map(([value, label]) => `<option value="${esc(value)}"${current === value ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select>`;
      }).join('')}
      <button class="btn" type="submit">筛选</button></form>
      <div class="work-results" aria-busy="${state.workLoading}">${state.workLoading ? skeleton(7) : rows ? `<div class="admin-bulk"><span data-bulk-count>已选 0 件（本页）</span><button class="btn sm" data-bulk-face="on" disabled>批量开启${faceLabel()}</button><button class="btn sm" data-bulk-face="off" disabled>批量关闭${faceLabel()}</button></div><div class="table-wrap"><table class="board admin-work-table"><thead><tr><th><input type="checkbox" data-select-all aria-label="选择本页全部作品"></th><th>作品</th><th>模型</th><th>来源</th><th>状态</th><th>${face === 'arena' ? '正式盲测' : `${faceLabel()}开关`}</th><th>${face === 'arena' ? '正式盲测池' : '备注'}</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="board-empty">没有符合条件的作品。</p>'}</div>
      <div class="admin-pagination"><button class="btn sm" data-page="${state.workPage - 1}" ${state.workPage <= 1 ? 'disabled' : ''}>上一页</button><span>第 ${state.workPage} / ${pages} 页</span><button class="btn sm" data-page="${state.workPage + 1}" ${state.workPage >= pages ? 'disabled' : ''}>下一页</button></div>
    </section>`;
}

function tasksView() {
  const tasks = [...(state.data?.tasks ?? []), ...(state.questions ?? [])];
  return `${pageHero('题目管理', `${faceLabel()}题目`, state.system === 'gallery' ? '为每道题编辑策展文案。' : '为每道题编辑点评和六维权重。', [['题目', tasks.length]])}
    <section class="block"><div class="admin-task-list">${tasks.map((task) => `<article class="admin-task"><div><h3>${esc(task.title)}</h3><p class="muted">${esc(task.id)}</p></div><button class="btn" data-task-note="${esc(task.id)}">${state.system === 'gallery' ? '编辑策展文案' : '编辑点评与权重'}</button></article>`).join('')}</div></section>`;
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

// Inline edit of an upload's registration info (title/summary/model); curated
// works are repo-managed and never get this dialog.
function editDialog(w) {
  const models = state.data?.models ?? [];
  const sheet = openDialog({ title: `编辑信息 · ${w.title}`, body: `<form class="admin-editor">
    <label class="field"><span class="field-label">作品标题</span><input class="input" name="title" maxlength="40" value="${esc(w.title)}" required></label>
    <div class="field-row">
      <label class="field"><span class="field-label">模型名称</span><input class="input" name="modelName" maxlength="60" value="${esc(w.modelName)}" required></label>
      ${effortField(w.effort)}
    </div>
    <label class="field"><span class="field-label">登记为模型</span><select class="input" name="modelId"><option value="">不登记（保持自由文本）</option>${models.map((m) => `<option value="${esc(m.id)}"${m.id === w.model ? ' selected' : ''}>${esc(m.name)}</option>`).join('')}</select></label>
    <label class="field"><span class="field-label">作品摘要</span><textarea class="input" name="summary" maxlength="200" rows="2">${esc(w.summary)}</textarea></label>
    ${provenanceFields({ harness: currentProvenance(w, 'harness'), provider: currentProvenance(w, 'provider'), version: w.harnessVersion ?? '' })}
    ${generationFields(w)}
    <p class="form-error" role="alert"></p><button class="btn primary" type="submit">保存</button></form>` });
  const form = $('form', sheet.el);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    let provenance;
    try { provenance = provenanceBody((name) => form.elements.namedItem(name)?.value, w); }
    catch (error) { $('.form-error', form).textContent = error.message; return; }
    const done = busy($('button[type="submit"]', form), '正在保存…');
    try {
      await api(`admin/works/${workKey(w)}/meta`, { method: 'POST', body: { title: form.title.value, summary: form.summary.value,
        modelName: form.modelName.value, modelId: form.modelId.value || undefined, effort: form.effort.value,
        ...provenance, ...generationBody((name) => form.elements.namedItem(name)?.value, w) } });
      sheet.close();
      toast('信息已更新');
      await reload();
    } catch (error) { $('.form-error', form).textContent = error.message; done(); }
  });
}

function calibrationDialog(w) {
  const face = state.system;
  const current = w[`calibration_${face}`] ?? {};
  const framing = current.framing ?? { width: 1440, height: 900, zoom: 1, offsetX: 0, offsetY: 0 };
  const camera = current.camera ?? { position: [0, 0, 5], target: [0, 0, 0] };
  const fields = [['width', 320, 3840, 1], ['height', 240, 3840, 1], ['zoom', 0.25, 4, 0.01], ['offsetX', -1, 1, 0.01], ['offsetY', -1, 1, 0.01]];
  const names = { width: '画框宽度', height: '画框高度', zoom: '缩放', offsetX: '水平偏移', offsetY: '垂直偏移',
    position0: '相机位置 X', position1: '相机位置 Y', position2: '相机位置 Z', target0: '相机目标 X', target1: '相机目标 Y', target2: '相机目标 Z' };
  const input = (name, value, min, max, step) => `<label class="field"><span class="field-label">${names[name]}</span><input class="input" type="number" name="${name}" value="${value}" min="${min}" max="${max}" step="${step}" required></label>`;
  const sheet = openDialog({ title: `${faceLabel()}取景 · ${w.title}`, body: `<form class="admin-editor">
    <label class="field"><input type="checkbox" name="framing_enabled" ${current.framing ? 'checked' : ''}> 使用画框参数</label><div class="admin-grid">${fields.map(([name, min, max, step]) => input(name, framing[name], min, max, step)).join('')}</div>
    <label class="field"><input type="checkbox" name="camera_enabled" ${current.camera ? 'checked' : ''}> 使用相机参数</label><div class="admin-grid">${['position', 'target'].flatMap((key) => [0, 1, 2].map((i) => input(`${key}${i}`, camera[key][i], -9999999, 9999999, 'any'))).join('')}</div>
    <p class="form-error" role="alert"></p><div class="actions"><button class="btn primary" type="submit">保存取景</button><button class="btn" type="button" data-clear-calibration>清空取景</button></div></form>` });
  const form = $('form', sheet.el);
  const save = async (calibration) => {
    const done = busy($('button[type="submit"]', form), '正在保存…');
    $('[data-clear-calibration]', form).disabled = true;
    try { await api(`admin/works/${workKey(w)}/calibration`, { method: 'POST', body: { face, calibration } }); sheet.close(); toast('取景已保存'); await reload(); }
    catch (error) { $('.form-error', form).textContent = error.message; done(); $('[data-clear-calibration]', form).disabled = false; }
  };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const val = (name) => Number(form.elements.namedItem(name).value);
    const patch = { framing: form.elements.namedItem('framing_enabled').checked ? Object.fromEntries(fields.map(([name]) => [name, val(name)])) : null,
      camera: form.elements.namedItem('camera_enabled').checked ? { position: [0, 1, 2].map((i) => val(`position${i}`)), target: [0, 1, 2].map((i) => val(`target${i}`)) } : null };
    save(patch);
  });
  $('[data-clear-calibration]', sheet.el).addEventListener('click', () => save(null));
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
        <p class="form-error" role="alert"></p>
        <button class="btn primary full" type="submit">登录</button>
      </form>
      <div class="gate-foot">${themeButton()}</div>
    </div>
  </main>`;
  const form = $('form', app());
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const doneBusy = busy($('[type="submit"]', form), '正在登录…');
    try {
      await api('auth/login', { method: 'POST', body: { name: form.name.value, password: form.password.value } });
      await boot();
      toast('欢迎回来');
    } catch (error) {
      $('.form-error', form).textContent = error.message;
      doneBusy();
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
  const [route = 'review'] = routeParts();
  const system = state.system;
  if (!routeAllowed(route)) { location.hash = system === 'common' ? '#/dashboard' : '#/review'; return; }
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
      await Promise.all([loadReview(), state.traffic ? Promise.resolve() : api('admin/traffic?days=30').then((data) => { state.traffic = data; })]);
    } else if (route === 'upload') await loadInbox();
    else if (route === 'review') await loadReview();
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
  const [route = 'review', sub] = routeParts();
  if (!routeAllowed(route, sub)) { location.hash = state.system === 'common' ? '#/dashboard' : '#/review'; return; }
  const body = state.system === 'common'
    ? route === 'upload' ? uploadView() : route === 'users' ? usersView() : route === 'traffic' ? trafficView() : dashboardView()
    : route === 'works' ? systemWorksView() : route === 'tasks' ? tasksView() : ['guess', 'activity'].includes(route) ? placeholderView(route) : reviewView(sub);
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
    if (!routeAllowed(routeParts()[0])) location.hash = state.system === 'common' ? '#/dashboard' : '#/review';
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
    if (routeParts()[0] === 'review') { render({ world: true }); reload(); }
    else location.hash = '#/review';
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
  if (editBtn) { const w = state.adminWorks.find((item) => item.id === editBtn.dataset.edit); if (w) editDialog(w); return; }
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
  const reviewBtn = e.target.closest('[data-review]');
  if (reviewBtn) {
    const work = state.works?.find((w) => w.id === reviewBtn.dataset.review) ?? state.adminWorks.find((w) => w.id === reviewBtn.dataset.review);
    if (work) openReview(work);
    return;
  }
  const verifyBtn = e.target.closest('[data-verify]');
  if (verifyBtn) {
    const work = state.works?.find((w) => w.id === verifyBtn.dataset.verify);
    if (!work) return;
    const doneBusy = busy(verifyBtn, '正在通过…');
    try {
      // Quick approve: current face on. Curated works go through face-settings
      // (their content is repo-vetted); uploads also get content-verified here.
      if (work.source === 'curated') {
        await api(`admin/works/${workKey(work)}/face-settings`, { method: 'POST', body: { [`show_${state.system}`]: true } });
      } else {
        await api(`works/${encodeURIComponent(work.task)}/${encodeURIComponent(work.id)}/review`,
          { method: 'POST', body: { status: 'verified', [`show_${state.system}`]: true } });
      }
      toast(`已${state.system === 'gallery' ? '上展览馆' : '进盲测'}：${work.title}`);
      await reload();
    } catch (error) {
      toast(error.message);
      doneBusy();
    }
    return;
  }
  // 本面撤下（审核队列的行）；作品表里的「撤回提名」用的是 data-withdraw，两者不要混。
  const faceOffBtn = e.target.closest('[data-face-off]');
  if (faceOffBtn) {
    const work = state.works?.find((w) => w.id === faceOffBtn.dataset.faceOff);
    if (!work) return;
    const doneBusy = busy(faceOffBtn, '正在撤下…');
    try {
      if (work.source === 'curated') {
        await api(`admin/works/${workKey(work)}/face-settings`, { method: 'POST', body: { [`show_${state.system}`]: false } });
      } else {
        await api(`works/${encodeURIComponent(work.task)}/${encodeURIComponent(work.id)}/review`,
          { method: 'POST', body: { status: work.status, [`show_${state.system}`]: false } });
      }
      toast(`已从${FACE_LABEL[state.system]}撤下：${work.title}`);
      await reload();
    } catch (error) {
      toast(error.message);
      doneBusy();
    }
    return;
  }
  const questionBtn = e.target.closest('[data-question]');
  if (questionBtn) {
    const work = state.works?.find((w) => w.id === questionBtn.dataset.question);
    if (work && await questionWork(work)) await reload();
    return;
  }
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
  const toggle = e.target.closest('[data-face-toggle]');
  if (!toggle) return;
  const work = state.adminWorks.find((item) => item.id === toggle.dataset.faceToggle);
  if (!work) return;
  toggle.disabled = true;
  toggle.parentElement.classList.add('is-saving');
  toggle.parentElement.setAttribute('aria-busy', 'true');
  try {
    await api(`admin/works/${workKey(work)}/face-settings`, { method: 'POST', body: { [`show_${state.system}`]: toggle.checked } });
    toast(`${state.system === 'arena' ? '正式盲测' : '展览馆开关'}已${toggle.checked ? '开启' : '关闭'}`);
    await reload();
  } catch (error) { toggle.checked = !toggle.checked; toggle.disabled = false; toast(error.message); }
  finally { if (toggle.isConnected) { toggle.disabled = false; toggle.parentElement.classList.remove('is-saving'); toggle.parentElement.removeAttribute('aria-busy'); } }
});
// Provenance fields: show the free-text box, enable the version, offer a registry match.
document.addEventListener('input', (e) => {
  if (e.target.matches?.('[data-provenance-choice], [name="harnessOther"], [name="providerOther"]')) refreshProvenance(e.target.form);
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
      toast(`已入库，等两边审核：${data.work.title}`);
      await Promise.all([loadInbox(), loadReview()]);
      render({ soft: true });
    } catch (err) { error.textContent = err.message; done(); }
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
