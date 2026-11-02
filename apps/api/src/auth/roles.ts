/** Better Auth's admin plugin role that grants instance-wide super-admin rights. */
export const INSTANCE_ADMIN_ROLE = 'admin';

/** Better Auth stores roles as a comma-separated string ("user,admin"). */
export function parseRoles(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((role) => role.trim())
    .filter((role) => role.length > 0);
}

export function hasInstanceAdminRole(raw: string | null | undefined): boolean {
  return parseRoles(raw).includes(INSTANCE_ADMIN_ROLE);
}
