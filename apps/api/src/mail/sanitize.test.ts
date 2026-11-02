import { describe, expect, it } from 'vitest';
import { htmlToText, sanitizeCss, sanitizeEmailHtml, textToHtml } from './sanitize.js';

const noImages = { inlineImage: () => null, remoteImage: () => null };

describe('sanitizeEmailHtml', () => {
  it('removes scripts, handlers, active content and dangerous URLs', () => {
    const { html } = sanitizeEmailHtml(
      `<p onclick="x()">Hi<script>alert(1)</script></p>
       <a href="javascript:alert(1)">a</a><a href="vbscript:x">b</a>
       <iframe src="https://evil.example"></iframe><object data="x"></object><embed src="x">
       <form action="https://evil.example"><input name="pw"></form>
       <svg onload="alert(1)"><circle/></svg><math><mi>x</mi></math>
       <img src="x" onerror="alert(1)"><base href="https://evil.example/"><meta http-equiv="refresh" content="0;url=https://evil.example">`,
      noImages,
    );
    for (const bad of ['script', 'onclick', 'onerror', 'onload', 'javascript:', 'vbscript:', 'iframe', 'object', 'embed', '<form', '<input', '<svg', '<base', '<meta', 'evil.example']) {
      expect(html.toLowerCase(), bad).not.toContain(bad);
    }
    expect(html).toContain('Hi');
  });

  it('opens links in a new window without referrer or opener', () => {
    const { html } = sanitizeEmailHtml('<a href="https://example.com/x" target="_self">x</a>', noImages);
    expect(html).toBe('<a href="https://example.com/x" target="_blank" rel="noopener noreferrer nofollow">x</a>');
  });

  it('blocks remote images unless a proxy URL is given, and counts them', () => {
    const blocked = sanitizeEmailHtml('<img src="https://tracker.example/p.gif" width="1"><img src="http://x.example/a.png">', noImages);
    expect(blocked.blockedImages).toBe(2);
    expect(blocked.html).not.toContain('tracker.example');
    const proxied = sanitizeEmailHtml('<img src="https://cdn.example/a.png">', {
      inlineImage: () => null,
      remoteImage: (url) => `/proxy?u=${encodeURIComponent(url)}`,
    });
    expect(proxied.html).toContain('src="/proxy?u=https%3A%2F%2Fcdn.example%2Fa.png"');
    expect(proxied.blockedImages).toBe(0);
  });

  it('inlines cid: images and keeps safe data: images only', () => {
    const { html } = sanitizeEmailHtml(
      '<img src="cid:logo@x"><img src="cid:unknown"><img src="data:image/png;base64,iVBORw0KGgo="><img src="data:text/html;base64,PHNjcmlwdD4=">',
      { inlineImage: (cid) => (cid === 'logo@x' ? 'data:image/png;base64,AAAA' : null), remoteImage: () => null },
    );
    expect(html).toContain('src="data:image/png;base64,AAAA"');
    expect(html).toContain('src="data:image/png;base64,iVBORw0KGgo="');
    expect(html).not.toContain('text/html');
    expect(html).not.toContain('cid:');
  });

  it('keeps layout styles but neuters loads in CSS', () => {
    const { html } = sanitizeEmailHtml(
      '<style>@import url(https://evil.example/x.css); body { background: url(https://evil.example/t.gif) } p { color: red }</style><p style="color: blue; background-image: url(&quot;https://evil.example/t.gif&quot;)">x</p>',
      noImages,
    );
    expect(html).not.toContain('evil.example');
    expect(html).toContain('color: red');
    expect(html).toMatch(/color:\s*blue/);
  });
});

describe('sanitizeCss', () => {
  it('drops loads spelled with CSS escapes, image-set() and @font-face', () => {
    const attempts = [
      'p{background:\\75rl(https://t.example/x)}',
      '@\\69mport "https://t.example/x.css";',
      'p{background-image:image-set("https://t.example/x" 1x)}',
      'p{background-image:-webkit-image-set("https://t.example/x" 1x)}',
      '@font-face{font-family:x;src:local(x),u\\rl(https://t.example/f.woff)}',
    ];
    for (const css of attempts) {
      const out = sanitizeCss(css);
      expect(out, css).not.toMatch(/\\|(?:url|image-set)\s*\(|@import|@font-face/i);
    }
  });

  it('cannot be broken out of a style element', () => {
    expect(sanitizeCss('p{}</style><script>alert(1)</script>')).not.toMatch(/<\/?style/i);
  });
});

describe('textToHtml', () => {
  it('escapes markup and links URLs', () => {
    expect(textToHtml('<b>hi</b> see https://example.com/a?b=1.')).toBe(
      '<div style="white-space: pre-wrap; font-family: inherit">&lt;b&gt;hi&lt;/b&gt; see <a href="https://example.com/a?b=1" target="_blank" rel="noopener noreferrer nofollow">https://example.com/a?b=1</a>.</div>',
    );
  });
});

describe('htmlToText', () => {
  it('keeps the words and line structure, drops markup and styles', () => {
    expect(htmlToText('<style>p{color:red}</style><h2>Hola</h2><p>Line &amp; one<br>two</p><ul><li>a</li><li>b</li></ul>')).toBe(
      'Hola\nLine & one\ntwo\n- a\n- b',
    );
  });
});
