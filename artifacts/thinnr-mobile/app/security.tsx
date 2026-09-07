import React from 'react';
import { Redirect, usePathname, type Href } from 'expo-router';

export default function SecurityShortcut() {
  const pathname = usePathname();
  return pathname === '/security'
    ? <Redirect href={{ pathname: '/account', params: { section: 'security' } } as Href} />
    : null;
}