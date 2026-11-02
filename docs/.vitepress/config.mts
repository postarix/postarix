import { defineConfig } from 'vitepress';

const repo = 'https://github.com/postarix/postarix';

/** The guides keep their upper-case file names in the repository; the site uses lower-case URLs. */
const pages: Record<string, string> = {
  'INSTALL.md': 'install.md',
  'BACKUP.md': 'backup.md',
  'MONITORING.md': 'monitoring.md',
  'ANTIVIRUS.md': 'antivirus.md',
  'CROWDSEC.md': 'crowdsec.md',
  'SCALING.md': 'scaling.md',
  'CALENDAR.md': 'calendar.md',
  'ARCHIVING.md': 'archiving.md',
  'MIGRATION.md': 'migration.md',
  'CONNECTING-DEVICES.md': 'connecting-devices.md',
  'ARCHITECTURE.md': 'architecture.md',
};

export default defineConfig({
  title: 'Postarix',
  description: 'A modern, self-hosted, open-source email platform: mail, webmail, calendar, contacts and an admin panel.',
  lang: 'en',
  // GitHub Pages serves the project at /postarix/ unless a custom domain is set.
  base: process.env.DOCS_BASE ?? '/postarix/',
  cleanUrls: true,
  lastUpdated: true,
  rewrites: pages,
  srcExclude: ['node_modules/**'],
  // Links to files outside docs/ (scripts, templates) point at GitHub instead.
  ignoreDeadLinks: [/^\.\.\//],
  head: [['link', { rel: 'icon', type: 'image/svg+xml', href: `${process.env.DOCS_BASE ?? '/postarix/'}logo.svg` }]],
  markdown: {
    config(md) {
      const render = md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
      md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
        const href = tokens[idx]!.attrGet('href');
        if (href?.startsWith('../')) {
          tokens[idx]!.attrSet('href', `${repo}/blob/main/${href.replace(/^(\.\.\/)+/, '')}`);
          tokens[idx]!.attrSet('target', '_blank');
          tokens[idx]!.attrSet('rel', 'noreferrer');
        }
        return render(tokens, idx, options, env, self);
      };
    },
  },
  themeConfig: {
    logo: '/logo.svg',
    search: { provider: 'local' },
    editLink: {
      pattern: `${repo}/edit/main/docs/:path`,
      text: 'Edit this page on GitHub',
    },
    socialLinks: [{ icon: 'github', link: repo }],
    nav: [
      { text: 'Install', link: '/install-ubuntu' },
      { text: 'Guides', link: '/install' },
      { text: 'Architecture', link: '/architecture' },
      { text: 'Releases', link: `${repo}/releases` },
    ],
    sidebar: [
      {
        text: 'Getting started',
        items: [
          { text: 'What is Postarix', link: '/introduction' },
          { text: 'Install on Ubuntu', link: '/install-ubuntu' },
          { text: 'Install with Dokploy', link: '/install-dokploy' },
          { text: 'Production guide (any Linux, Kubernetes)', link: '/install' },
          { text: 'First steps', link: '/first-steps' },
          { text: 'Connecting devices', link: '/connecting-devices' },
        ],
      },
      {
        text: 'Running a server',
        items: [
          { text: 'Configuration reference', link: '/configuration' },
          { text: 'Updating', link: '/updating' },
          { text: 'Backups and restore', link: '/backup' },
          { text: 'Monitoring', link: '/monitoring' },
          { text: 'Antivirus (ClamAV)', link: '/antivirus' },
          { text: 'Blocking attackers (CrowdSec)', link: '/crowdsec' },
          { text: 'Scaling out (Cyrus Murder)', link: '/scaling' },
          { text: 'Troubleshooting', link: '/troubleshooting' },
        ],
      },
      {
        text: 'Features',
        items: [
          { text: 'Calendar, invitations and rooms', link: '/calendar' },
          { text: 'Archiving and legal hold', link: '/archiving' },
          { text: 'Moving from another provider', link: '/migration' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'Architecture and decisions', link: '/architecture' },
          { text: 'Reverse proxies', link: `${repo}/tree/main/deploy/proxies` },
          { text: 'Security policy', link: `${repo}/blob/main/SECURITY.md` },
          { text: 'Contributing', link: `${repo}/blob/main/CONTRIBUTING.md` },
        ],
      },
    ],
    footer: {
      message: 'Released under the AGPL-3.0 license.',
      copyright: 'Postarix contributors',
    },
  },
});
