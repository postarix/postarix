import { useMemo } from 'react';

/**
 * Shows sanitized email HTML in an iframe that cannot run scripts or reach
 * this page (sandbox without allow-scripts / allow-same-origin: an opaque
 * origin), with a CSP that only allows images from the API's image proxy and
 * inline data. Links open in a new tab.
 */
export function MessageFrame({ html, title }: { html: string; title: string }) {
  const srcDoc = useMemo(() => {
    const origin = window.location.origin;
    const csp = `default-src 'none'; img-src ${origin} data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'`;
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"><base target="_blank"><style>
html{color-scheme:light}body{margin:0;padding:20px;font:14px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1f2328;background:#fff;overflow-wrap:anywhere}
img{max-width:100%;height:auto}table{max-width:100%}pre{white-space:pre-wrap}blockquote{margin:0 0 0 .5em;padding-left:1em;border-left:3px solid #d0d7de;color:#57606a}
</style></head><body>${html}</body></html>`;
  }, [html]);

  return (
    <iframe
      title={title}
      srcDoc={srcDoc}
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      className="h-full min-h-[50vh] w-full flex-1 rounded-md border bg-white"
    />
  );
}
