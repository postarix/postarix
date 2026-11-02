import { z } from 'zod';

const issuerSchema = z
  .url({ protocol: /^https?$/ })
  .max(500)
  .transform((value) => value.replace(/\/+$/, ''));

export const createSsoProviderSchema = z.strictObject({
  domainId: z.uuid(),
  issuer: issuerSchema,
  clientId: z.string().trim().min(1).max(500),
  clientSecret: z.string().min(1).max(2000),
});
export type CreateSsoProviderInput = z.infer<typeof createSsoProviderSchema>;

export const ssoProviderIdSchema = z.uuid();

export interface SsoProviderDto {
  id: string;
  /** Used in the callback URL and in "sign in with SSO" requests. */
  providerId: string;
  domain: string;
  issuer: string;
  clientId: string;
  /** Redirect URI to register at the identity provider. */
  callbackUrl: string;
}
