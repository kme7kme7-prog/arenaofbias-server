import { HttpError } from './http.mjs';

export const roleOf = (role) => ['admin', 'moderator'].includes(role) ? role : 'user';
export const isStaff = (user) => ['admin', 'moderator'].includes(user?.role);
export const isSenior = (user) => user?.role === 'admin';
export const levelOf = (user) => !user ? null : isSenior(user) ? 3 : isStaff(user) ? 2 : user.member_level === 1 ? 1 : 0;
export const capabilitiesOf = (user) => ({ canSubmitQuestion: levelOf(user) >= 1, canSubmitWork: levelOf(user) >= 1,
  canTakeQualificationExam: levelOf(user) === 0 });
export function requireContributor(user) {
  if (levelOf(user) < 1) {
    const error = new HttpError(403, '通过资格考试成为认证成员后即可投稿', 'level_required');
    error.details = { requiredLevel: 1, currentLevel: levelOf(user) };
    throw error;
  }
  return user;
}

export function authorOf({ role, name = null, avatar = null }) {
  return { role: roleOf(role), name, avatar };
}
