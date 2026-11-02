import DOMPurify from 'dompurify';

/** What a formatted message may contain: text formatting, lists, links and quotes. */
const ALLOWED_TAGS = ['p', 'br', 'div', 'b', 'strong', 'i', 'em', 'u', 's', 'ul', 'ol', 'li', 'a', 'blockquote', 'span'];

/** Keeps only plain formatting (no scripts, styles, images or forms); links open safely. */
export function cleanHtml(html: string): string {
  const clean = DOMPurify.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR: ['href'], ALLOWED_URI_REGEXP: /^(?:https?|mailto):/i });
  const doc = new DOMParser().parseFromString(`<body>${clean}</body>`, 'text/html');
  for (const a of doc.querySelectorAll('a')) {
    a.setAttribute('rel', 'noopener noreferrer');
    a.setAttribute('target', '_blank');
  }
  return doc.body.innerHTML;
}

const BLOCKS = new Set(['p', 'div', 'ul', 'ol', 'blockquote']);

function nodeText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? '').replace(/\s+/g, ' ');
  if (!(node instanceof Element)) return '';
  const tag = node.tagName.toLowerCase();
  if (tag === 'br') return '\n';
  const inner = Array.from(node.childNodes, nodeText).join('');
  if (tag === 'li') {
    const ordered = node.parentElement?.tagName.toLowerCase() === 'ol';
    const index = Array.prototype.indexOf.call(node.parentElement?.children ?? [], node) + 1;
    return `\n${ordered ? `${index}. ` : '- '}${inner.trim()}`;
  }
  if (tag === 'blockquote') {
    const lines = inner.replace(/\n{3,}/g, '\n\n').trim().split('\n');
    return `\n\n${lines.map((line) => (line ? `> ${line}` : '>')).join('\n')}\n\n`;
  }
  if (tag === 'a') {
    const href = node.getAttribute('href');
    return href && href !== node.textContent && !href.startsWith('mailto:') ? `${inner} (${href})` : inner;
  }
  return BLOCKS.has(tag) ? `\n\n${inner}\n\n` : inner;
}

/** The plain-text version of a formatted message (sent alongside it). */
export function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  return Array.from(doc.body.childNodes, nodeText)
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
