import { expect, type Page } from '@playwright/test';

/**
 * Signs in to the webmail. The stack runs Better Auth's production rate limit
 * (a few sign-ins per address and client every ten seconds), so a "Too many
 * requests" answer waits and tries again, like a person would.
 */
export async function signInToWebmail(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  const folders = page.getByRole('navigation', { name: 'Folders' });
  const limited = page.getByText(/too many requests/i);
  for (let attempt = 0; ; attempt++) {
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(folders.or(limited)).toBeVisible();
    if (await folders.isVisible()) return;
    if (attempt >= 4) throw new Error(`Sign-in as ${email} stayed rate limited`);
    await page.waitForTimeout(5_000);
  }
}
