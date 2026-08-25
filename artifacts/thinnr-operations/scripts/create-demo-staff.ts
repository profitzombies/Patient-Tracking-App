/**
 * Create (or repair) the permanent demo staff login for the investor demo.
 *
 * Dana Reyes — front desk at Jenkins Aesthetics & Wellness (acct-p1). The
 * account is admin-created with the email pre-confirmed, so no email is ever
 * sent; the address is deliberately fake (.example.com). Idempotent: safe to
 * re-run any time, it converges on the same state.
 *
 * These are DEMO credentials, documented in replit.md by design.
 *
 *   pnpm --filter @workspace/thinnr-operations run create:demo-staff
 */

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in the environment.');
  process.exit(1);
}

const BASE = SUPABASE_URL.replace(/\/$/, '');
const HEADERS: Record<string, string> = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

const EMAIL = 'dana.frontdesk@jenkinswellness.example.com';
const PASSWORD = 'JenkinsTraining!26'; // demo credential — documented in replit.md
const NAME = 'Dana Reyes';
const OFFICE = 'acct-p1';

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...HEADERS, Prefer: 'return=representation,resolution=merge-duplicates' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* empty body */
  }
  return { status: response.status, json };
}

async function main() {
  // 1. Pre-approval row (upsert on the email PK).
  const assignment = await call('POST', '/rest/v1/staff_role_assignments?on_conflict=email', {
    email: EMAIL,
    role: 'provider_staff',
    provider_account_code: OFFICE,
  });
  if (assignment.status >= 300) throw new Error(`assignment upsert failed (${assignment.status}): ${JSON.stringify(assignment.json)}`);
  console.log(`Pre-approval in place: ${EMAIL} → provider_staff @ ${OFFICE}`);

  // 2. The auth user — create confirmed, or converge the existing one.
  const existing = await call('GET', `/auth/v1/admin/users?page=1&per_page=1&email=${encodeURIComponent(EMAIL)}`);
  const found = (existing.json?.users ?? []).find(
    (user: any) => String(user?.email ?? '').toLowerCase() === EMAIL,
  );
  let userId: string;
  if (found) {
    userId = found.id;
    const update = await call('PUT', `/auth/v1/admin/users/${userId}`, {
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { display_name: NAME },
    });
    if (update.status >= 300) throw new Error(`admin update failed (${update.status}): ${JSON.stringify(update.json)}`);
    console.log('Existing auth user converged (password + confirmation).');
  } else {
    const created = await call('POST', '/auth/v1/admin/users', {
      email: EMAIL,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { display_name: NAME },
    });
    userId = created.json?.id ?? created.json?.user?.id;
    if ((created.status !== 200 && created.status !== 201) || !userId)
      throw new Error(`admin create failed (${created.status}): ${JSON.stringify(created.json)}`);
    console.log('Auth user created (pre-confirmed, no email sent).');
  }

  // 3. Prove the chain converged: profile role + linked viewer.
  const profile = await call('GET', `/rest/v1/profiles?id=eq.${userId}&select=role,provider_account_code,display_name`);
  const viewer = await call('GET', `/rest/v1/training_viewers?auth_user_id=eq.${userId}&select=id,name,email,account_id,is_demo`);
  const profileRow = profile.json?.[0];
  const viewerRow = viewer.json?.[0];
  if (profileRow?.role !== 'provider_staff' || profileRow?.provider_account_code !== OFFICE)
    throw new Error(`profile did not elevate: ${JSON.stringify(profileRow)}`);
  if (!viewerRow || viewerRow.account_id !== OFFICE)
    throw new Error(`viewer did not link: ${JSON.stringify(viewerRow)}`);

  console.log(`Linked viewer: ${viewerRow.name} <${viewerRow.email}> @ ${viewerRow.account_id}`);
  console.log('\nDemo staff login ready:');
  console.log(`  Email:    ${EMAIL}`);
  console.log(`  Password: ${PASSWORD}`);
}

void main().catch((error) => {
  console.error('Failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
