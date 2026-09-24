-- HQ setup override.
--
-- Setup normally opens only when BOTH money arrangements are real: the office
-- can charge its patients (connected Stripe account) and THINNR can charge the
-- office (bank, cards, plan, disclosure). Demonstration and support accounts
-- can never satisfy that, so HQ may deliberately waive the gate for ONE office
-- at a time. The waiver is recorded on the launch row (who, when, why) and is
-- never granted by the office itself; every confirmation the office already
-- made stays exactly as it was, so removing the waiver restores the real gate.
alter table public.practice_launch
  add column if not exists setup_override_at timestamptz,
  add column if not exists setup_override_by uuid,
  add column if not exists setup_override_note text;

create or replace function public.set_practice_launch_override(
  p_provider_id text,
  p_expected_version integer,
  p_actor uuid,
  p_enabled boolean,
  p_note text
) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare launch public.practice_launch%rowtype;
begin
  select * into launch from public.practice_launch where provider_id=p_provider_id for update;
  if not found then raise exception 'Practice setup not found.' using errcode='22023'; end if;
  -- A stale request never lands, even when it asks for the state already in
  -- place: the caller decided from a snapshot that no longer describes this row.
  if launch.version<>p_expected_version then
    raise exception 'Practice setup changed. Reload and try again.' using errcode='40001';
  end if;
  -- Repeating the current state from a current snapshot is harmless.
  if p_enabled = (launch.setup_override_at is not null) then return; end if;
  update public.practice_launch set
    setup_override_at = case when p_enabled then now() else null end,
    setup_override_by = case when p_enabled then p_actor else null end,
    setup_override_note = case when p_enabled then nullif(btrim(coalesce(p_note,'')),'') else null end,
    version = version+1
  where provider_id=p_provider_id;
end $$;
revoke all on function public.set_practice_launch_override(text,integer,uuid,boolean,text) from public,anon,authenticated;
grant execute on function public.set_practice_launch_override(text,integer,uuid,boolean,text) to service_role;

-- Requiring setup again must actually close the gate: a waiver left in place
-- would keep the office and its staff in the workspace while HQ believes it
-- has been shut out. Re-gating therefore clears the waiver in the same
-- statement that clears the completions.
create or replace function public.regate_practice_launch(p_provider_id text,p_expected_version integer,p_actor uuid)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare l public.practice_launch%rowtype;
begin
  select * into l from public.practice_launch where provider_id=p_provider_id for update;
  if not found or l.version<>p_expected_version then raise exception 'Setup changed. Reload.' using errcode='40001'; end if;
  delete from public.practice_launch_completions where provider_id=p_provider_id;
  update public.practice_launch set completed_at=null,regated_at=clock_timestamp(),
    setup_override_at=null,setup_override_by=null,setup_override_note=null,
    version=version+1 where provider_id=p_provider_id;
  insert into public.practice_launch_regates(provider_id,actor_user_id) values(p_provider_id,p_actor);
end $$;
revoke all on function public.regate_practice_launch(text,integer,uuid) from public,anon,authenticated;
grant execute on function public.regate_practice_launch(text,integer,uuid) to service_role;
