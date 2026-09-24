-- HQ team invitations: resend a stalled invitation and look one up by token.
--
-- Inviting already works through hq_invite_team_member_v2. Two gaps remained:
--   * a half-finished invite (cancelled, or still pending) left the email
--     permanently claimed by an hq_memberships row, so the only recovery was
--     database surgery;
--   * the emailed setup link had nothing to exchange its token for, so the
--     setup page could not greet the invitee or tell a dead link from a live
--     one without leaking whether an unknown token belongs to anybody.
--
-- Both functions stay security definer and service_role-only: the operations
-- app never talks to them directly.

create or replace function public.hq_resend_team_invitation(
  p_actor_id uuid,
  p_member_id uuid,
  p_token_hash text,
  p_expires_at timestamptz default null,
  p_name text default null,
  p_title text default null,
  p_role text default null
)
returns public.hq_team_members
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member public.hq_memberships%rowtype;
  v_role public.hq_department_role;
  v_token_hash text := lower(trim(coalesce(p_token_hash, '')));
  v_expires_at timestamptz := coalesce(p_expires_at, now() + interval '24 hours');
  v_result public.hq_team_members%rowtype;
begin
  if not private.hq_user_has_permission(p_actor_id, 'team_manage') then
    raise exception 'Only an active THINNR administrator can invite HQ teammates.';
  end if;
  if v_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'A SHA-256 setup token hash is required.';
  end if;
  if v_expires_at <= now() or v_expires_at > now() + interval '7 days' then
    raise exception 'Choose an invitation expiry within the next seven days.';
  end if;
  if p_role is not null then
    if p_role not in ('admin', 'clinical', 'support', 'content') then
      raise exception 'Choose an inviteable HQ role.';
    end if;
    v_role := p_role::public.hq_department_role;
  end if;

  select * into v_member
  from public.hq_memberships
  where id = p_member_id
  for update;
  if not found then
    raise exception 'HQ teammate not found.';
  end if;
  if v_member.is_protected_owner or v_member.department_role = 'super_admin' then
    raise exception 'The protected Super Admin does not use setup invitations.';
  end if;
  if v_member.status = 'active' then
    raise exception 'That teammate has already joined the HQ team.';
  end if;
  -- A membership that once had a live sign-in is not a stalled invitation;
  -- restoring it is a deliberate re-invite of a real former teammate, which
  -- the roster deliberately does not offer.
  if v_member.status = 'revoked'
    and (v_member.auth_user_id is not null or v_member.activated_at is not null) then
    raise exception 'That teammate previously signed in. Invite them with a new work email.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('hq-email:' || v_member.email, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('hq-token:' || v_token_hash, 0)
  );

  -- Retire the superseded link before the membership can move: the lifecycle
  -- trigger only allows 'expired' while the membership is still 'invited'.
  if v_member.status = 'invited' then
    update public.hq_invitations
    set status = 'expired'
    where membership_id = v_member.id and status = 'pending';
  end if;

  update public.hq_memberships
  set status = 'invited',
      revoked_at = null,
      revoked_by = null,
      invited_by = p_actor_id,
      invited_at = now(),
      display_name = coalesce(nullif(trim(coalesce(p_name, '')), ''), display_name),
      job_title = case when p_title is null then job_title else nullif(trim(p_title), '') end,
      department_role = coalesce(v_role, department_role)
  where id = v_member.id
  returning * into v_member;

  insert into public.hq_invitations (
    membership_id, email, token_hash, expires_at, created_by
  )
  values (v_member.id, v_member.email, v_token_hash, v_expires_at, p_actor_id);

  select * into v_result from public.hq_team_members where id = v_member.id;
  return v_result;
end;
$$;

-- Token exchange for the emailed setup link. Returns a state for every
-- outcome and identity only for a live invitation, so an unknown token is
-- indistinguishable from one that never existed.
create or replace function public.hq_lookup_team_invitation(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hash text := lower(trim(coalesce(p_token_hash, '')));
  v_invitation public.hq_invitations%rowtype;
  v_member public.hq_memberships%rowtype;
  v_state text;
begin
  if v_hash !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('state', 'unknown');
  end if;

  select * into v_invitation
  from public.hq_invitations
  where token_hash = v_hash;
  if not found then
    return jsonb_build_object('state', 'unknown');
  end if;

  select * into v_member
  from public.hq_memberships
  where id = v_invitation.membership_id;
  if not found then
    return jsonb_build_object('state', 'unknown');
  end if;

  v_state := case
    when v_invitation.status = 'accepted' then 'used'
    when v_invitation.status = 'revoked' then 'cancelled'
    when v_invitation.status = 'expired' then 'expired'
    when v_invitation.expires_at <= now() then 'expired'
    when v_member.status = 'active' then 'used'
    when v_member.status <> 'invited' then 'cancelled'
    else 'pending'
  end;

  if v_state <> 'pending' then
    return jsonb_build_object('state', v_state);
  end if;

  return jsonb_build_object(
    'state', 'pending',
    'name', v_member.display_name,
    'email', v_member.email,
    'role', v_member.department_role::text,
    'title', v_member.job_title,
    'expiresAt', v_invitation.expires_at
  );
end;
$$;

revoke all on function public.hq_resend_team_invitation(uuid, uuid, text, timestamptz, text, text, text)
  from public, anon, authenticated;
revoke all on function public.hq_lookup_team_invitation(text)
  from public, anon, authenticated;
grant execute on function public.hq_resend_team_invitation(uuid, uuid, text, timestamptz, text, text, text)
  to service_role;
grant execute on function public.hq_lookup_team_invitation(text)
  to service_role;

comment on function public.hq_resend_team_invitation(uuid, uuid, text, timestamptz, text, text, text) is
  'Issues a fresh setup token for a stalled HQ invitation, reviving a cancelled invitation that never signed in.';
comment on function public.hq_lookup_team_invitation(text) is
  'Exchanges a setup token hash for the invitation state, and identity only while it is live.';
