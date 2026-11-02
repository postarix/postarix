# @postarix/ui

Shared UI for the admin panel and the webmail: [shadcn/ui](https://ui.shadcn.com)
components (Radix UI + Tailwind CSS v4) and the Postarix theme.

```tsx
import { Button } from '@postarix/ui/components/button';
import { cn } from '@postarix/ui/lib/utils';
```

```css
/* the app's global CSS */
@import "tailwindcss";
@import "@postarix/ui/styles.css";
@source "../../../packages/ui/src";
```

- `src/components/` holds the shadcn components, copied from the official
  registry (`new-york` style) and owned by us. Postarix adds `success` and
  `warning` variants to `Badge` and `Alert`.
- `src/styles.css` holds the theme tokens; dark mode follows the operating system.
- Add components with the shadcn CLI from this folder (`components.json` is set
  up for the monorepo): `pnpm dlx shadcn@latest add <component>`.

Plain TypeScript source; consumers compile it (Next.js `transpilePackages`, Vite).
