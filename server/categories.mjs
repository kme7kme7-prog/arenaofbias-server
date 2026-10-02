// Categories decide the formats a question can accept.
import { fail } from './http.mjs';

export const CATEGORIES = ['文学', '静态网页', '建模'];
// Domains say what a question is about. They scope browsing and the leaderboard, never formats.
export const DOMAINS = ['数学', '物理', '化学', '生物', '天文', '建筑', '自然景观', '交通与机械', '产品与品牌', '文学艺术', '游戏娱乐'];
export const MAX_DOMAINS = 2;
export const defaultTemplates = (category) => category === '文学' ? ['text'] : ['static', 'vite'];
export const templatesOf = (task) => task.templates?.length ? task.templates : defaultTemplates(task.category);
// Community text questions have templates but no kind field.
export const isTextTask = (task) => Boolean(task && (task.kind === 'text' || templatesOf(task).every((type) => type === 'text')));
export const compatibleTemplates = (category, templates) => Array.isArray(templates) && templates.length > 0
  && (category === '文学' ? templates.length === 1 && templates[0] === 'text'
    : templates.every((type) => ['static', 'vite'].includes(type)));

export function requireCategory(category) {
  if (!CATEGORIES.includes(category)) fail(400, '请选择题目分类');
  return category;
}

// One or two listed domains, duplicates folded.
export function requireDomains(domains) {
  const unique = Array.isArray(domains) ? [...new Set(domains)] : [];
  if (!unique.length) fail(400, '请选择所属领域');
  if (unique.length > MAX_DOMAINS || unique.some((domain) => !DOMAINS.includes(domain))) fail(400, `所属领域为 1–${MAX_DOMAINS} 个，且须在列表内`);
  return unique;
}
