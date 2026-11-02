import { z } from 'zod';

const issuerSchema = z
  .url({ protocol: /^https?$/ })
  .max(500)
  .transform((value) => value.replace(/\/+$/, ''));

const oidcProviderSchema = z.strictObject({
  type: z.literal('oidc').default('oidc'),
  domainId: z.uuid(),
  issuer: issuerSchema,
  clientId: z.string().trim().min(1).max(500),
  clientSecret: z.string().min(1).max(2000),
});

const samlProviderSchema = z.strictObject({
  type: z.literal('saml'),
  domainId: z.uuid(),
  /** The identity provider's entity ID ("Identifier", "Issuer"). */
  entityId: z.string().trim().min(1).max(500),
  /** Where browsers are sent to sign in (HTTP-Redirect binding). */
  ssoUrl: z.url({ protocol: /^https?$/ }).max(2000),
  /** The identity provider's signing certificate (PEM, or its base64 body). */
  certificate: z.string().trim().min(100).max(20_000),
});

export const createSsoProviderSchema = z.union([samlProviderSchema, oidcProviderSchema]);
export type CreateSsoProviderInput = z.infer<typeof createSsoProviderSchema>;
export type CreateOidcProviderInput = z.infer<typeof oidcProviderSchema>;
export type CreateSamlProviderInput = z.infer<typeof samlProviderSchema>;

export const ssoProviderIdSchema = z.uuid();

export interface SsoProviderDto {
  id: string;
  type: 'oidc' | 'saml';
  /** Used in the callback URL and in "sign in with SSO" requests. */
  providerId: string;
  domain: string;
  /** OIDC issuer URL, or SAML entity ID of the identity provider. */
  issuer: string;
  /** OIDC only. */
  clientId: string;
  /** OIDC: redirect URI to register at the identity provider. SAML: the Assertion Consumer Service URL. */
  callbackUrl: string;
  /** SAML only: Postarix' entity ID (also the URL of its metadata). */
  entityId: string | null;
  /** SAML only: when the identity provider's certificate expires. */
  certificateExpiresAt: string | null;
}
