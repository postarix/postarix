# Contributing

Thanks for your interest in Postarix!

## Before you start

- Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). It explains the design decisions and why they were made.
- For large changes, open an issue first to discuss the approach.

## Workflow

1. Branch off `main`: `feat/…`, `fix/…`, `docs/…`, `chore/…`.
2. Make small commits following [Conventional Commits](https://www.conventionalcommits.org/):
   `feat(api): add domains endpoint`, `fix(webmail): …`.
3. Make sure `pnpm lint`, `pnpm typecheck` and `pnpm test` pass.
4. Open a pull request describing what changes and why.

## Non-negotiable rules

- **Isolation between organizations.** Every query is scoped by organization in the repository layer, and every new endpoint comes with a test that tries to reach another organization's data.
- **No unsanitized email HTML** outside the webmail's sandboxed iframe.
- **No Docker socket access** from any service.
- **No secrets in the repository.** Use `.env` (ignored by git) and document variables in `.env.example`.

## Language

Everything in the repository — code, comments, documentation, commit messages — is in English.
