'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

export default function SystemIndex() {
  const router = useRouter();
  useEffect(() => router.replace('/system/services'), [router]);
  return null;
}
