// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { cleanHtml, htmlToText } from './rich-text';

describe('formatted messages', () => {
  it('keep formatting, lists and links, and drop anything active', () => {
    const html = cleanHtml(
      '<p onclick="x()">Hi <b>there</b> <script>alert(1)</script><img src=x onerror=alert(1)></p><a href="javascript:alert(1)">bad</a><a href="https://example.com">good</a><style>p{}</style>',
    );
    expect(html).toContain('<b>there</b>');
    expect(html).not.toMatch(/script|onerror|onclick|<img|<style|javascript:/);
    expect(html).toContain('<a href="https://example.com" rel="noopener noreferrer" target="_blank">good</a>');
  });

  it('turn into readable plain text', () => {
    const text = htmlToText(
      '<p>Hello <b>Ana</b>,</p><ul><li>one</li><li>two</li></ul><ol><li>first</li></ol><blockquote><p>quoted line</p></blockquote><p>See <a href="https://example.com/doc">the doc</a></p>',
    );
    expect(text).toBe('Hello Ana,\n\n- one\n- two\n\n1. first\n\n> quoted line\n\nSee the doc (https://example.com/doc)');
  });
});
