import sanitizeHtml from 'sanitize-html';

export interface SanitizeOptions {
  /** Maps a cid: reference to a data: URI (inline images), or null if unknown. */
  inlineImage: (cid: string) => string | null;
  /** Maps a remote image URL to a proxied one, or null to block it. */
  remoteImage: (url: string) => string | null;
}

export interface SanitizedHtml {
  html: string;
  blockedImages: number;
}

const ALLOWED_TAGS = [
  ...sanitizeHtml.defaults.allowedTags,
  'img', 'font', 'center', 'span', 'div', 'style', 'u', 's', 'strike', 'small', 'big', 'sub', 'sup',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup', 'col',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'br', 'pre', 'blockquote', 'figure', 'figcaption',
];

const LAYOUT_ATTRIBUTES = ['style', 'align', 'valign', 'width', 'height', 'bgcolor', 'color', 'dir', 'lang', 'title', 'class', 'id', 'border'];

/**
 * Removes anything in a stylesheet that could load or run something: url(),
 * image-set(), @import, @font-face, expression(), behaviours. CSS escapes
 * (\75rl, @\69mport…) are dropped first so they cannot spell those out. The
 * sandboxed iframe's CSP blocks such loads too; this keeps them from even
 * being attempted.
 */
export function sanitizeCss(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\\/g, '')
    .replace(/@import[^;]*;?/gi, '')
    .replace(/@font-face\s*\{[^}]*\}?/gi, '')
    .replace(/(?:-webkit-)?image-set\s*\(/gi, 'invalid(')
    .replace(/url\s*\([^)]*\)/gi, 'none')
    .replace(/expression\s*\(/gi, 'invalid(')
    .replace(/(-moz-binding|behavior)\s*:/gi, 'x-removed:')
    .replace(/<\/?\s*style/gi, '');
}

/**
 * Sanitizes untrusted email HTML for display. The result is still shown in a
 * sandboxed iframe (no scripts, opaque origin) with a strict CSP: this is the
 * server-side half of that defence.
 */
export function sanitizeEmailHtml(html: string, options: SanitizeOptions): SanitizedHtml {
  let blockedImages = 0;
  const clean = sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowVulnerableTags: true, // <style>: its contents are filtered below
    allowedAttributes: {
      '*': LAYOUT_ATTRIBUTES,
      a: ['href', 'name', 'target', 'rel'],
      img: ['src', 'alt', 'width', 'height', 'data-blocked-src'],
      td: ['colspan', 'rowspan', 'nowrap'],
      th: ['colspan', 'rowspan', 'scope'],
      table: ['cellpadding', 'cellspacing', 'summary'],
      col: ['span'],
      colgroup: ['span'],
      ol: ['start', 'type'],
      font: ['face', 'size', 'color'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: ['http', 'https', 'cid', 'data'] },
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    nonTextTags: ['script', 'textarea', 'option', 'noscript', 'title', 'head', 'iframe', 'object', 'embed'],
    transformTags: {
      a: (tagName, attribs) => ({
        tagName,
        attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer nofollow' },
      }),
      img: (tagName, attribs) => {
        const src = (attribs.src ?? '').trim();
        const { src: _drop, ...rest } = attribs;
        let resolved: string | null = null;
        if (/^cid:/i.test(src)) resolved = options.inlineImage(src.slice(4).replace(/^<|>$/g, ''));
        else if (/^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(src)) resolved = src;
        else if (/^https?:\/\//i.test(src)) {
          resolved = options.remoteImage(src);
          if (resolved === null) {
            blockedImages++;
            return { tagName, attribs: { ...rest, 'data-blocked-src': 'remote' } };
          }
        }
        return { tagName, attribs: resolved ? { ...rest, src: resolved } : rest };
      },
    },
  });
  // Stylesheets and inline style attributes are filtered after the HTML pass
  // (sanitize-html keeps <style> contents as raw text).
  const html2 = clean
    .replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/gi, (_m, open: string, css: string, close: string) => `${open}${sanitizeCss(css)}${close}`)
    .replace(/style="([^"]*)"/gi, (_m, css: string) => `style="${sanitizeCss(css.replace(/&quot;/g, '"')).replace(/"/g, '&quot;')}"`);
  return { html: html2, blockedImages };
}

/** Plain-text bodies as HTML: escaped, with line breaks kept and links made clickable. */
export function textToHtml(text: string): string {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const linked = escaped.replace(
    /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g,
    (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer nofollow">${url}</a>`,
  );
  return `<div style="white-space: pre-wrap; font-family: inherit">${linked}</div>`;
}

/** Readable plain text from HTML (for quoting HTML-only messages in replies). */
export function htmlToText(html: string): string {
  const withBreaks = html
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/blockquote)\b[^>]*>/gi, '$&\n')
    .replace(/<li\b[^>]*>/gi, '$&- ');
  const text = sanitizeHtml(withBreaks, { allowedTags: [], allowedAttributes: {}, nonTextTags: ['style', 'script', 'textarea', 'option', 'noscript', 'title', 'head'] });
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
