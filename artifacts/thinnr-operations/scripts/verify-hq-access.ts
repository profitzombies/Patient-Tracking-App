import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  HQ_ROLE_PERMISSIONS,
  INVITABLE_HQ_ROLES,
  canHq,
  firstAllowedAdminPath,
  permissionForAdminPath,
} from '../src/data/hq/team';

assert(!INVITABLE_HQ_ROLES.includes('Super Admin' as never), 'Super Admin must never be invitable');
assert(canHq('Super Admin', 'team'));
assert(canHq('Admin', 'team'));
assert(!canHq('Clinical', 'team'));
assert(!canHq('Support', 'settings'));
assert(!canHq('Support', 'overview'), 'Support must not see financial/clinical overview');
assert(!canHq('Content', 'accounts'));
assert(canHq('Content', 'training'));
assert.equal(permissionForAdminPath('/admin/accounts/provider-id'), 'accounts');
assert.equal(permissionForAdminPath('/admin/training/courses/course-id'), 'training');
assert.equal(permissionForAdminPath('/admin/accounts/provider-id/office'), 'accounts');
assert.equal(permissionForAdminPath('/admin/training/preview/course-id'), 'training');
assert.equal(firstAllowedAdminPath('Clinical'), '/admin/accounts');
assert.equal(firstAllowedAdminPath('Content'), '/admin/training');

for (const permission of HQ_ROLE_PERMISSIONS['Super Admin']) {
  assert(HQ_ROLE_PERMISSIONS.Admin.has(permission), `Admin should share ${permission} access`);
}

// Direct URLs must use the same permission lookup as the visible navigation.
// This catches route-order regressions where a nested or chromeless page could
// otherwise mount before the AdminArea gate is consulted.
const directPaths = [
  '/admin',
  '/admin/accounts',
  '/admin/accounts/provider-id',
  '/admin/accounts/provider-id/office',
  '/admin/conversations',
  '/admin/team',
  '/admin/settings',
  '/admin/training',
  '/admin/training/courses/course-id',
  '/admin/training/preview/course-id',
  '/admin/training/viewers/viewer-id',
  '/admin/training/analytics',
  '/admin/knowledge',
  '/admin/support-test',
  '/admin/files',
] as const;

for (const role of ['Clinical', 'Support', 'Content', 'Admin', 'Super Admin'] as const) {
  for (const path of directPaths) {
    const expected = HQ_ROLE_PERMISSIONS[role].has(permissionForAdminPath(path));
    assert.equal(
      canHq(role, permissionForAdminPath(path)),
      expected,
      `${role} direct URL ${path} must be checked against its path permission`,
    );
  }
}

// The browser session contract must authorize every HQ department through the
// canonical active membership, including roles whose compatibility profile is
// intentionally patient. profiles has no HQ presentation columns.
const sessionSource = readFileSync(
  new URL('../src/contexts/session.tsx', import.meta.url),
  'utf8',
);
assert.match(sessionSource, /\.from\('hq_memberships'\)/);
assert.match(sessionSource, /\.eq\('status', 'active'\)/);
assert.match(sessionSource, /table: 'hq_memberships'/);
assert.match(sessionSource, /setAuthRole\('hq_admin'\)/);
assert.doesNotMatch(
  sessionSource,
  /\.from\('profiles'\)[\s\S]{0,160}\.select\('[^']*(?:hq_role|job_title)/,
  'profiles queries must never request nonexistent HQ columns',
);
for (const storedRole of ['clinical', 'support', 'content', 'admin', 'super_admin']) {
  const displayRole = storedRole
    .split('_')
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(' ');
  assert(
    HQ_ROLE_PERMISSIONS[displayRole as keyof typeof HQ_ROLE_PERMISSIONS],
    `${storedRole} membership must map to an HQ role`,
  );
}

console.log('HQ permission matrix regression checks passed.');