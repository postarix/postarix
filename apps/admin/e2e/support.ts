import { expect, type Page } from '@playwright/test';

export async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/admin/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}

export const unique = (label: string) => `${label}-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
