---
layout: home

hero:
  name: Postarix
  text: Your own email, done properly.
  tagline: Mail, webmail, calendar, contacts and an admin panel in one self-hosted, open-source system — for one person or a provider hosting thousands of organizations.
  image:
    src: /logo.svg
    alt: Postarix
  actions:
    - theme: brand
      text: Install on Ubuntu
      link: /install-ubuntu
    - theme: alt
      text: Install with Dokploy
      link: /install-dokploy
    - theme: alt
      text: What is Postarix?
      link: /introduction

features:
  - title: Everything in one place
    details: Postfix, Cyrus IMAP and Rspamd, already wired together, with its own webmail, calendar, contacts and admin panel. No SOGo, no Roundcube.
  - title: Multi-tenant from the start
    details: Organizations, domains, roles, quotas and an audit log are part of the core. One organization never sees another's data.
  - title: Secure by default
    details: Two-step sign-in, passkeys, app passwords, SSO (OpenID Connect and SAML), DKIM, DMARC, MTA-STS and DANE, signed release images.
  - title: Runs anywhere
    details: One Linux server with Docker Compose, a PaaS like Dokploy, or Kubernetes with the Helm chart — and Cyrus Murder when one mail server is not enough.
  - title: Moving in is easy
    details: People import their old mail from Gmail or any IMAP account from the webmail, and their calendars and contacts from .ics and .vcf files.
  - title: Built for operators
    details: Encrypted backups, Prometheus metrics and alerts, archiving and legal hold, and guides for every step.
---
