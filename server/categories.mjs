// Categories decide the formats a question can accept.
import { fail } from './http.mjs';

export const CATEGORIES = ['文学', '静态网页', '建模'];
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
