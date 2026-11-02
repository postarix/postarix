import type { NextFunction, Request, Response } from 'express';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defense in depth for cookie-authenticated endpoints: rejects
 * state-changing requests whose Origin header is present but not trusted.
 *
 * Browsers always send Origin on cross-site POST/PUT/PATCH/DELETE, so a
 * missing header means a non-browser client (CLI, server-to-server), which
 * cannot ride on a victim's cookies.
 */
export function originCheck(allowedOrigins: readonly string[]) {
  const allowed = new Set(allowedOrigins.map((origin) => new URL(origin).origin));

  return (req: Request, res: Response, next: NextFunction) => {
    if (SAFE_METHODS.has(req.method)) return next();

    const origin = req.headers.origin;
    if (origin === undefined || allowed.has(origin)) return next();

    res.status(403).json({ statusCode: 403, message: 'Origin not allowed' });
  };
}
