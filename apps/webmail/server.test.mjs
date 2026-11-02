import { describe, expect, it } from 'vitest';
import { isInternalPath } from './server.mjs';

describe('isInternalPath', () => {
  it('catches every spelling of /api/internal', () => {
    for (const p of ['/api/internal', '/api/internal/mail-auth', '/API/INTERNAL/x', '//api//internal/x', '/api/%69nternal/x', '/api/%2569nternal/x', '/api/x/../internal/x', '/api%2finternal/x', '/api\\internal/x', '/api/internal%2fmail-auth']) {
      expect(isInternalPath(p), p).toBe(true);
    }
  });

  it('lets other API paths through', () => {
    for (const p of ['/api/jmap/', '/api/jmap/download/ann%40x.com/B1/a.pdf', '/api/auth/get-session', '/api/internalize']) {
      expect(isInternalPath(p), p).toBe(false);
    }
  });
});
