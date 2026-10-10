export const roleOf = (role) => ['admin', 'moderator'].includes(role) ? role : 'user';
export const isStaff = (user) => ['admin', 'moderator'].includes(user?.role);
export const isSenior = (user) => user?.role === 'admin';

export function authorOf({ role, name = null, avatar = null }) {
  return { role: roleOf(role), name, avatar };
}
