# @postarix/jmap-client

A small, typed JMAP client (RFC 8620 core, RFC 8621 mail) for the browser.
The webmail uses it against the Postarix API (`/api/jmap/`), which logs in to
Cyrus as the signed-in user. It covers what the webmail needs: the session,
method calls with back-references, uploads, download URLs and push events.

TypeScript source; consumers compile it (Vite).
