import express, { type ErrorRequestHandler, type RequestHandler } from 'express';

export const BODY_LIMIT = '1mb';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function hasBody(req: express.Request): boolean {
  return (
    req.headers['transfer-encoding'] !== undefined ||
    (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0')
  );
}

/**
 * Parses and size-limits every request body before any route sees it,
 * including the Better Auth handler (which reuses an already-parsed body
 * instead of reading the raw stream with no limit).
 *
 * Only JSON, URL-encoded forms and small XML documents are accepted; any other body is rejected
 * with 415 so nothing downstream ever streams an unbounded payload.
 */
export function bodyLimits(): Array<RequestHandler | ErrorRequestHandler> {
  const rejectUnparsed: RequestHandler = (req, res, next) => {
    if (!SAFE_METHODS.has(req.method) && req.body === undefined && hasBody(req)) {
      res.status(415).json({ statusCode: 415, message: 'Unsupported content type' });
      return;
    }
    next();
  };

  // Turns body-parser errors (413 too large, 400 malformed JSON) into JSON responses
  // instead of Express' default HTML error page.
  const handleParseErrors: ErrorRequestHandler = (err, _req, res, next) => {
    const status = typeof err?.status === 'number' ? err.status : undefined;
    if (status === undefined || status < 400 || status >= 500) return next(err);
    res.status(status).json({
      statusCode: status,
      message: status === 413 ? 'Payload too large' : 'Malformed request body',
    });
  };

  return [
    express.json({ limit: BODY_LIMIT }),
    express.urlencoded({ limit: BODY_LIMIT, extended: false }),
    // Small XML documents only (Outlook's Autodiscover request).
    express.text({ type: ['text/xml', 'application/xml'], limit: '16kb' }),
    handleParseErrors,
    rejectUnparsed,
  ];
}
