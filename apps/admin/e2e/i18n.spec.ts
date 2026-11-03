import { expect, test } from '@playwright/test';
import { baseURL } from './env';

test('shows the sign-in page in Spanish with the language cookie', async ({ page, context }) => {
  await context.addCookies([{ name: 'postarix-lang', value: 'es', url: baseURL }]);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/admin/login');
  await expect(page.getByRole('button', { name: 'Iniciar sesión', exact: true })).toBeVisible();
  await expect(page.getByLabel('Contraseña')).toBeVisible();
  expect(errors).toEqual([]);
});
