export const SYSTEM_SUPER_USER_EMAIL = 'aleidar1010@gmail.com';

export function isSystemSuperUser(email: string | null | undefined) {
  return email?.trim().toLowerCase() === SYSTEM_SUPER_USER_EMAIL;
}
