-- Training portal: retire the world-readable demo roster.
--
-- The guided demo is gone from both apps, so nothing anonymous reads the
-- training roster any more. The "Demo … readable by everyone" policies let
-- anon/authenticated callers read every viewer row flagged is_demo (and the
-- completions/invites belonging to those viewers). Drop them: the anonymous
-- share-link learner tracks its own progress through the token-keyed RPCs,
-- HQ admins keep their FOR ALL policies, and office staff keep the
-- own-office read policies from 20260827000000_training_staff_logins.sql.
--
-- The is_demo column stays for now (RPCs and the dev seed still write it);
-- it carries no access meaning after this migration.
--
-- Safe to re-run: drop if exists throughout.

drop policy if exists "Demo training viewers are readable by everyone" on public.training_viewers;
drop policy if exists "Demo training completions are readable by everyone" on public.training_completions;
drop policy if exists "Demo training invites are readable by everyone" on public.training_invites;

comment on table public.training_viewers is
  'Training viewers. Readable by HQ admins and, for their own office, provider staff; never by anonymous callers.';

comment on column public.training_viewers.is_demo is
  'Legacy seed marker. Grants no access since 20261203000000_training_drop_demo_roster_policies.sql.';

do $proof$
begin
  if exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename in ('training_viewers', 'training_completions', 'training_invites')
      and policyname like 'Demo training %'
  ) then
    raise exception 'demo training read policies still present';
  end if;
end
$proof$;
