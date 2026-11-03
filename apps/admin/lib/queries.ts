'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import type { OrganizationSummary } from './types';

export const keys = {
  myOrgs: ['me', 'organizations'] as const,
  allOrgs: ['admin', 'organizations'] as const,
  org: (orgId: string) => ['org', orgId] as const,
  orgPart: (orgId: string, part: string) => ['org', orgId, part] as const,
};

export function useMyOrganizations() {
  return useQuery({
    queryKey: keys.myOrgs,
    queryFn: () => api.get<{ data: OrganizationSummary[] }>('/me/organizations').then((r) => r.data),
  });
}

export function useAllOrganizations(enabled: boolean) {
  return useQuery({
    queryKey: keys.allOrgs,
    queryFn: () => api.get<{ data: OrganizationSummary[] }>('/admin/organizations').then((r) => r.data),
    enabled,
  });
}

export function useOrganization(orgId: string) {
  return useQuery({
    queryKey: keys.org(orgId),
    queryFn: () => api.get<OrganizationSummary>(`/orgs/${orgId}/overview`),
  });
}

export function isSuperAdmin(role: string | null | undefined): boolean {
  return (role ?? '').split(',').map((r) => r.trim()).includes('admin');
}

export function useOrgList<T>(orgId: string, part: string) {
  return useQuery({
    queryKey: keys.orgPart(orgId, part),
    queryFn: () => api.get<{ data: T[] }>(`/orgs/${orgId}/${part}`).then((r) => r.data),
  });
}

export interface Branding {
  productName: string;
  loginMessage: string;
  announcement: string;
  /** How prominent the announcement is (older servers: none). */
  announcementLevel?: 'info' | 'important' | 'urgent';
  supportUrl: string;
  passwordMinLength: number;
  /** A line at the bottom of the sign-in page. */
  footer?: string;
  /** A data: URL replacing the stamp; empty: the stamp. */
  logo?: string;
  /** More apps for the Apps menus. */
  appLinks?: { name: string; url: string }[];
  /** Only single sign-on on the sign-in page. */
  hidePasswordSignIn?: boolean;
}

/** What instance administrators set for the sign-in page and everyone's screens. */
export function useBranding() {
  return useQuery({
    queryKey: ['branding'],
    queryFn: () => api.get<Branding>('/branding'),
    staleTime: 60_000,
  });
}
