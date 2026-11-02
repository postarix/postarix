import type { Auth } from './auth.js';

export interface SuperAdminInput {
  email: string;
  password: string;
  name: string;
}

/** Creates an instance super-admin (Better Auth role "admin"), bypassing the sign-up switch. */
export async function createSuperAdmin(auth: Auth, input: SuperAdminInput) {
  const { user } = await auth.api.createUser({
    body: {
      email: input.email,
      password: input.password,
      name: input.name,
      role: 'admin',
    },
  });
  return user;
}
