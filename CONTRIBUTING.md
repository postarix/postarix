# Cómo contribuir

¡Gracias por tu interés en Postarix!

## Antes de empezar

- Lee [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Explica las decisiones de diseño y por qué se tomaron.
- Para cambios grandes, abre primero un issue para discutir el enfoque.

## Flujo de trabajo

1. Crea una rama desde `main`: `feat/…`, `fix/…`, `docs/…`, `chore/…`.
2. Haz commits pequeños siguiendo [Conventional Commits](https://www.conventionalcommits.org/es/):
   `feat(api): crear endpoint de dominios`, `fix(webmail): …`.
3. Asegúrate de que pasan `pnpm lint`, `pnpm typecheck` y `pnpm test`.
4. Abre un pull request describiendo qué cambia y por qué.

## Reglas que no se negocian

- **Aislamiento entre organizaciones.** Toda consulta se filtra por organización en la capa de repositorio, y todo endpoint nuevo incluye una prueba que intenta acceder a datos de otra organización.
- **Nada de HTML de correo sin sanitizar** fuera del iframe aislado del webmail.
- **Nada de acceso al socket de Docker** desde ningún servicio.
- **Nada de secretos en el repositorio.** Usa `.env` (ignorado por git) y documenta las variables en `.env.example`.

## Idioma

La documentación de cara al usuario está en español. El código, los nombres de variables y los comentarios técnicos, en inglés.
