import http from 'node:http';
import type net from 'node:net';
import { describe, expect, it } from 'vitest';
import { fetchRemoteImage, ImageProxyError, isPublicAddress, proxiedImageUrl, verifyImageLink } from './image-proxy.js';

const SECRET = 's'.repeat(40);

describe('image proxy', () => {
  it('signs links and rejects tampered or expired ones', () => {
    const now = Date.now();
    const link = new URL(proxiedImageUrl(SECRET, 'https://mail.example.com/api/mail/image', 'https://cdn.example/a.png', now));
    const [u, e, s] = ['u', 'e', 's'].map((k) => link.searchParams.get(k)!);
    expect(verifyImageLink(SECRET, u!, e!, s!, now)).toBe(true);
    expect(verifyImageLink(SECRET, 'https://evil.example/a.png', e!, s!, now)).toBe(false);
    expect(verifyImageLink(SECRET, u!, String(Number(e) + 1), s!, now)).toBe(false);
    expect(verifyImageLink(SECRET, u!, e!, s!, now + 2 * 24 * 3600 * 1000)).toBe(false);
    expect(verifyImageLink('t'.repeat(40), u!, e!, s!, now)).toBe(false);
  });

  it('knows which addresses are public', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) expect(isPublicAddress(ip), ip).toBe(true);
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.5', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '224.0.0.1', 'localhost']) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
  });

  it('refuses internal targets, by address or by name', async () => {
    for (const url of ['http://127.0.0.1/a.png', 'http://[::1]/a.png', 'http://169.254.169.254/latest/meta-data', 'http://localhost/a.png', 'http://postgres/a.png']) {
      await expect(fetchRemoteImage(url), url).rejects.toBeInstanceOf(ImageProxyError);
    }
    await expect(fetchRemoteImage('http://example.com:8080/a.png')).rejects.toMatchObject({ status: 400 });
    await expect(fetchRemoteImage('file:///etc/passwd')).rejects.toMatchObject({ status: 400 });
    await expect(fetchRemoteImage('http://user:pw@example.com/a.png')).rejects.toMatchObject({ status: 400 });
  });

  describe('fetching', () => {
    // A local server plays the remote site. The policy allows only 127.0.0.1
    // (any port), standing in for "public"; 127.0.0.2 stands in for internal.
    const policy = { isAllowedAddress: (ip: string) => ip === '127.0.0.1', anyPort: true };
    const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

    async function site(handler: http.RequestListener) {
      const server = http.createServer(handler);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as net.AddressInfo;
      return { url: `http://127.0.0.1:${port}`, port, close: () => server.close() };
    }

    it('returns raster images', async () => {
      const s = await site((_req, res) => res.writeHead(200, { 'content-type': 'image/png' }).end(PNG));
      try {
        expect(await fetchRemoteImage(`${s.url}/a.png`, policy)).toEqual({ type: 'image/png', body: PNG });
      } finally {
        s.close();
      }
    });

    it('follows redirects, but never into a disallowed address', async () => {
      const s = await site((req, res) => {
        if (req.url === '/ok') return res.writeHead(302, { location: '/img' }).end();
        if (req.url === '/img') return res.writeHead(200, { 'content-type': 'image/gif' }).end(PNG);
        res.writeHead(302, { location: `http://127.0.0.2:${s.port}/secret` }).end();
      });
      try {
        expect((await fetchRemoteImage(`${s.url}/ok`, policy)).type).toBe('image/gif');
        await expect(fetchRemoteImage(`${s.url}/evil`, policy)).rejects.toMatchObject({ status: 403 });
      } finally {
        s.close();
      }
    });

    it('refuses SVG, other types, oversized bodies and endless redirects', async () => {
      const s = await site((req, res) => {
        if (req.url === '/svg') return res.writeHead(200, { 'content-type': 'image/svg+xml' }).end('<svg/>');
        if (req.url === '/html') return res.writeHead(200, { 'content-type': 'text/html' }).end('<p>');
        if (req.url === '/big') {
          res.writeHead(200, { 'content-type': 'image/png' });
          const chunk = Buffer.alloc(1024 * 1024);
          for (let i = 0; i < 11; i++) res.write(chunk);
          return res.end();
        }
        res.writeHead(302, { location: '/loop' }).end();
      });
      try {
        await expect(fetchRemoteImage(`${s.url}/svg`, policy)).rejects.toMatchObject({ status: 415 });
        await expect(fetchRemoteImage(`${s.url}/html`, policy)).rejects.toMatchObject({ status: 415 });
        await expect(fetchRemoteImage(`${s.url}/big`, policy)).rejects.toMatchObject({ status: 413 });
        await expect(fetchRemoteImage(`${s.url}/loop`, policy)).rejects.toMatchObject({ status: 502 });
      } finally {
        s.close();
      }
    });
  });
});
