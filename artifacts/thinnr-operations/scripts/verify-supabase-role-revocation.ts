/**
 * Live Supabase integration proof for the database-only staff allowlist.
 *
 * Creates and signs in a temporary confirmed user, proves provider promotion,
 * then verifies the active session observes demotion after the allowlist is
 * deleted and after the authenticated email changes. It always removes
 * temporary auth/assignment records.
 */
const required = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'] as const;
for (const key of required) {
  if (!process.env[key]) throw new Error(`${key} is required for Supabase role verification.`);
}

const baseUrl = process.env.SUPABASE_URL!.replace(/\/$/, '');
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const anonKey = process.env.SUPABASE_ANON_KEY!;
const suffix = `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
const firstEmail = `role-check-${suffix}@thinnrweightloss.com`;
const changedEmail = `role-check-changed-${suffix}@thinnrweightloss.com`;
const password = `Tn!${suffix}aZ9`;
const adminHeaders = {
  apikey: serviceKey,
  Authorization: `Bearer ${serviceKey}`,
  'Content-Type': 'application/json',
};

type Profile = { role: string; provider_account_code: string | null };

async function expectOk(response: Response, description: string) {
  if (!response.ok) throw new Error(`${description} failed with HTTP ${response.status}.`);
  return response;
}

async function readProfile(userId: string): Promise<Profile> {
  const response = await expectOk(
    await fetch(`${baseUrl}/rest/v1/profiles?select=role,provider_account_code&id=eq.${userId}`, {
      headers: adminHeaders,
    }),
    'Profile read',
  );
  const rows = (await response.json()) as Profile[];
  if (rows.length !== 1) throw new Error('Expected exactly one temporary profile.');
  return rows[0];
}

async function readOwnProfile(accessToken: string, userId: string): Promise<Profile> {
  const response = await expectOk(
    await fetch(`${baseUrl}/rest/v1/profiles?select=role,provider_account_code&id=eq.${userId}`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${accessToken}` },
    }),
    'Active-session profile read',
  );
  const rows = (await response.json()) as Profile[];
  if (rows.length !== 1) throw new Error('Active session could not read exactly one profile.');
  return rows[0];
}

async function expectProfile(userId: string, role: string, providerAccountCode: string | null) {
  const profile = await readProfile(userId);
  if (profile.role !== role || profile.provider_account_code !== providerAccountCode) {
    throw new Error(`Expected ${role}/${providerAccountCode ?? 'null'} profile state.`);
  }
}

async function upsertAssignment(email: string) {
  await expectOk(
    await fetch(`${baseUrl}/rest/v1/staff_role_assignments?on_conflict=email`, {
      method: 'POST',
      headers: { ...adminHeaders, Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify([{ email, role: 'provider_staff', provider_account_code: 'acct-p1' }]),
    }),
    'Provider approval write',
  );
}

async function deleteAssignment(email: string) {
  await expectOk(
    await fetch(`${baseUrl}/rest/v1/staff_role_assignments?email=eq.${encodeURIComponent(email)}`, {
      method: 'DELETE',
      headers: adminHeaders,
    }),
    'Provider approval delete',
  );
}

let userId: string | null = null;
try {
  const response = await expectOk(
    await fetch(`${baseUrl}/auth/v1/admin/users`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ email: firstEmail, password, email_confirm: true }),
    }),
    'Temporary user creation',
  );
  const payload = (await response.json()) as { id?: string; user?: { id?: string } };
  userId = payload.user?.id ?? payload.id ?? null;
  if (!userId) throw new Error('Temporary user creation returned no id.');

  const login = await expectOk(
    await fetch(`${baseUrl}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: firstEmail, password }),
    }),
    'Temporary provider sign-in',
  );
  const tokenPayload = (await login.json()) as { access_token?: string };
  if (!tokenPayload.access_token) throw new Error('Temporary provider sign-in returned no access token.');

  await upsertAssignment(firstEmail);
  await expectProfile(userId, 'provider_staff', 'acct-p1');
  const activeProviderProfile = await readOwnProfile(tokenPayload.access_token, userId);
  if (activeProviderProfile.role !== 'provider_staff') {
    throw new Error('Signed-in provider did not receive the provider workspace role.');
  }

  await deleteAssignment(firstEmail);
  await expectProfile(userId, 'patient', null);
  const activeRevokedProfile = await readOwnProfile(tokenPayload.access_token, userId);
  if (activeRevokedProfile.role !== 'patient' || activeRevokedProfile.provider_account_code !== null) {
    throw new Error('Active provider session remained privileged after access revocation.');
  }

  await upsertAssignment(firstEmail);
  await expectProfile(userId, 'provider_staff', 'acct-p1');

  await expectOk(
    await fetch(`${baseUrl}/auth/v1/admin/users/${userId}`, {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({ email: changedEmail, email_confirm: true }),
    }),
    'Temporary user email change',
  );
  await expectProfile(userId, 'patient', null);
  console.log('Supabase provider role promotion and both revocation paths passed.');
} finally {
  await deleteAssignment(firstEmail).catch(() => undefined);
  await deleteAssignment(changedEmail).catch(() => undefined);
  if (userId) {
    await fetch(`${baseUrl}/auth/v1/admin/users/${userId}`, {
      method: 'DELETE',
      headers: adminHeaders,
    });
  }
}