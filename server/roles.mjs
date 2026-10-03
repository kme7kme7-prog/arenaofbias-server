export const roleOf = (role) => ['admin', 'moderator'].includes(role) ? role : 'user';
export const isStaff = (user) => ['admin', 'moderator'].includes(user?.role);
export const isSenior = (user) => user?.role === 'admin';

export function authorOf({ role, name = null, avatar = null }, adminView = false) {
  role = roleOf(role);
  const hidden = !adminView && isStaff({ role });
  return { role, name: hidden ? null : name, avatar: hidden ? null : avatar };
}
