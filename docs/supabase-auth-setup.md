# THINNR Supabase authentication setup

The operations web app uses Supabase email/phone + password auth. The
publishable key is the only Supabase credential compiled into client bundles.
The service-role key must stay in workspace secrets and is only for
administrator or migration work.

## Apply the profile schema

1. Open the THINNR Supabase project.
2. Open **SQL Editor** and create a new query.
3. Paste and run
   `supabase/migrations/20260824000000_profiles.sql`.
4. In **Authentication → Users**, confirm the owner account
   `andrew@thinnrweightloss.com` exists. If it existed before the migration,
   the final update promotes it to `hq_admin`; if it is created afterward, the
   signup trigger promotes it automatically **after the email has been
   confirmed**.
5. In **Database → Tables → profiles → RLS policies**, confirm the two select
   policies are enabled. There is intentionally no client update policy for
   roles.
6. Run the Supabase Security Advisor. The `profiles` table must have RLS
   enabled; the trigger functions use a fixed `search_path`.

## Pre-approve HQ and provider staff

Patients are the default for every new account. Before a staff member creates
an account, a database administrator adds their real email to
`staff_role_assignments`; the signup trigger grants that role only after
Supabase confirms ownership of the email.

```sql
insert into public.staff_role_assignments (email, role, provider_account_code)
values (
  'frontdesk@yourclinic.com',
  'provider_staff',
  'acct-p1' -- optional: the matching provider account code
)
on conflict (email) do update
  set role = excluded.role,
      provider_account_code = excluded.provider_account_code,
      updated_at = now();
```

Use `hq_admin` for an HQ administrator and leave
`provider_account_code` null. The table has no client policies: role
assignments remain a database-admin operation until the staff-access management
screen is built. To revoke a staff account, delete its assignment; the database
immediately returns the matching profile to `patient` and clears its provider
account code:

```sql
delete from public.staff_role_assignments
where email = lower('frontdesk@yourclinic.com');
```

## Live HQ team roles

Apply `supabase/migrations/20260908000000_hq_team_access.sql` after the account
claiming and live-provider migrations. It adds the canonical `hq_memberships`
roster and hashed-token `hq_invitations` lifecycle.

The migration links the existing, confirmed
`andrew+admin@thinnrweightloss.com` Auth user and profile to the sole protected
`super_admin` membership. It does not write `auth.users`, create a replacement
user, reset a password, alter confirmation state, or send an invitation. If the
owner Auth identity is absent the migration emits a notice and does not
manufacture one; if it exists but is unconfirmed, migration fails explicitly.

The one approved QA cleanup is intentionally exact: both Auth UUID
`65825658-4ceb-442f-99fa-5ace1c06df83` and email
`qa-ui-hq-1787681027458@thinnr-staff-check.com` must agree before deletion.
There is no domain wildcard or reusable purge function. The migration removes
that identity from Auth, profiles (by Auth cascade), both role-assignment
tables, the HQ lifecycle tables, and its training-viewer row. Do not broaden
those predicates for convenience.

Department permissions are enforced by database helpers and RLS:

| Role | Database authority |
| --- | --- |
| Super Admin | Full access; protected from ordinary demotion/removal |
| Admin | Full HQ access, including team, settings, locks, and financial data |
| Clinical | Provider and clinical directories, clinical records/conversations, and non-financial analytics |
| Support | Narrow provider contact/status directory and support conversations only |
| Content | Training and knowledge management only |

`private.is_hq_admin()` remains the compatibility check for old code, but now
means an active Super Admin/Admin membership. A pre-migration `hq_admin`
profile with no membership remains compatible; once a membership exists,
including a revoked one, the durable membership is authoritative. Clinical,
Support, and Content profiles are deliberately not marked `hq_admin`, so
legacy API checks fail closed.

New authorization code should use
`private.has_hq_permission(permission_name)` for the signed-in caller, or the
service-role-only `private.hq_user_has_permission(user_id, permission_name)`
after the API has verified the bearer token. Unknown permission names return
false. Direct client writes to memberships and invitations are denied; the API
must perform lifecycle writes with the service role after checking
`team_manage`.

Invitation rows store only a 64-character SHA-256 token hash. Never store a
plaintext setup token or temporary password. Create the pending membership and
invitation atomically, commit, and only then send the setup email. Activation
requires a matching, email-confirmed Auth identity. Revocation immediately
removes admin compatibility assignment/profile elevation, while retaining the
membership audit row. The protected owner and the final active team
administrator are guarded by database triggers.

For a secure setup email, the API must call the service-only
`public.hq_invite_team_member_v2(actor_id, name, email, title, role,
token_hash, expires_at default null)` RPC. Generate the plaintext token in API
memory, send only its lowercase SHA-256 hash to PostgreSQL, and put the
plaintext token only in the single-use setup URL sent after commit. Once GoTrue
has created the recipient's chosen-password account, call the service-only
`public.hq_accept_team_invitation(token_hash, auth_user_id)` RPC. It locks the
token row, requires a pending unexpired token and matching confirmed email,
creates/updates the profile, activates the membership, accepts the invitation,
and is idempotent only for the same token/Auth-user pair. The legacy
five-argument `hq_invite_team_member` remains only for compatibility and must
not be used for new secure invitations.

Support must read provider data through
`public.hq_provider_contact_directory()`; it intentionally excludes balances,
MRR, banking, pricing, and patient metrics. Clinical patient directory reads
use `public.hq_clinical_patient_directory()`, which excludes the legacy
patients table's billing/subscription fields. Service-role API handlers must
apply the same permission and field selection rather than treating the service
role as authorization.

The migration ends with executable SQL assertions for the role matrix, exact
QA deletion, protected owner, and one-person initial live roster. After
applying, run the Supabase Security Advisor and verify:

```sql
select display_name, email, department_role, status, is_protected_owner
from public.hq_memberships
where status = 'active';
```

The live bootstrap result must be exactly Andrew,
`andrew+admin@thinnrweightloss.com`, `super_admin`, `active`, `true`.

## Enable phone sign-in and sign-up

Phone password sign-up is already implemented in both the web flow and the
mobile flow. Supabase returns an SMS verification challenge and the app asks
for the one-time code.

1. In **Authentication → Providers**, open **Phone** and enable Phone
   provider.
2. Choose **Twilio Verify** as the SMS provider.
3. In the Twilio Console, create or select a **Verify Service** and copy its
   Service SID. Ensure the Twilio account has permission to send verification
   messages to the countries you support.
4. In Supabase Phone provider settings, enter the Twilio Account SID,
   Auth Token, and Verify Service SID. Save the provider settings.
5. Add a test phone number in **Authentication → Users** or sign up from the
   app using E.164 format, such as `+15551234567`.
6. Complete the SMS code step. If the provider is not configured yet, THINNR
   shows “SMS verification isn't configured yet” instead of exposing a raw
   provider error.

## Client configuration

Set these workspace secrets for the workflows:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY` (or the Supabase publishable key)
- `SUPABASE_SERVICE_ROLE_KEY` (server/migration use only; never expose it to Vite or Expo)

The web Vite config maps only the URL and publishable key to
`VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`. The service-role key is never
read by the browser code.
