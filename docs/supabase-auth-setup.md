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
