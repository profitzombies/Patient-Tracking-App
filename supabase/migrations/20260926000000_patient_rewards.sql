-- Patient rewards are an append-only, server-evaluated engagement ledger.
-- The mobile client never supplies XP, award ids, or progress.  Re-running
-- the reconciler is safe after retries, offline replay, concurrent devices,
-- corrections, and a lost response.

create table if not exists public.patient_reward_state (
  patient_id uuid primary key references public.patients(id) on delete cascade,
  catalog_version integer not null default 1 check (catalog_version = 1),
  enrolled_at timestamptz not null default clock_timestamp(),
  enrollment_date date not null,
  baseline_weight numeric,
  baseline_goal_weight numeric,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create table if not exists public.patient_reward_events (
  patient_id uuid not null references public.patients(id) on delete cascade,
  event_key text not null check (char_length(event_key) between 1 and 160),
  category text not null check (category in ('daily', 'streak', 'goal', 'level')),
  label text not null check (char_length(label) between 1 and 200),
  xp integer not null check (xp >= 0),
  occurred_on date not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (patient_id, event_key)
);

create index if not exists patient_reward_events_recent
  on public.patient_reward_events (patient_id, occurred_on desc, created_at desc);

create table if not exists public.patient_reward_awards (
  patient_id uuid not null references public.patients(id) on delete cascade,
  award_id text not null check (char_length(award_id) between 1 and 120),
  category text not null check (category in ('level', 'activity', 'goal')),
  title text not null,
  description text not null,
  requirement text not null,
  target numeric not null check (target >= 0),
  unit text not null,
  xp_award integer not null check (xp_award >= 0),
  earned_at timestamptz not null default clock_timestamp(),
  primary key (patient_id, award_id)
);

alter table public.patient_reward_state enable row level security;
alter table public.patient_reward_events enable row level security;
alter table public.patient_reward_awards enable row level security;
revoke all on public.patient_reward_state, public.patient_reward_events, public.patient_reward_awards from anon, authenticated;

-- This migration runs after the general identity-guard migration, so install
-- the guard explicitly for these new patient-owned tables.
drop trigger if exists patient_identity_write_guard on public.patient_reward_state;
create trigger patient_identity_write_guard
  before insert or update of patient_id on public.patient_reward_state
  for each row execute function private.guard_patient_dependency_write();
drop trigger if exists patient_identity_write_guard on public.patient_reward_events;
create trigger patient_identity_write_guard
  before insert or update of patient_id on public.patient_reward_events
  for each row execute function private.guard_patient_dependency_write();
drop trigger if exists patient_identity_write_guard on public.patient_reward_awards;
create trigger patient_identity_write_guard
  before insert or update of patient_id on public.patient_reward_awards
  for each row execute function private.guard_patient_dependency_write();

create or replace function public.patient_rewards_reconcile(
  p_patient_id uuid,
  p_today_key date default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.patients%rowtype;
  s public.patient_reward_state%rowtype;
  today date;
  run_at timestamptz := clock_timestamp();
  dates date[];
  previous_day date;
  day_value date;
  current_streak integer;
  best_streak integer;
  food_current integer := 0;
  food_best integer := 0;
  checkin_current integer := 0;
  checkin_best integer := 0;
  hydration_current integer := 0;
  hydration_best integer := 0;
  target_oz numeric;
  total_xp integer := 0;
  level integer := 1;
  level_xp integer := 0;
  next_level_xp integer;
  xp_to_next integer := 0;
  goal_percent numeric := 0;
  pounds_lost numeric := 0;
  latest_weight numeric;
  threshold integer;
  i integer;
begin
  select * into p from public.patients where id = p_patient_id for key share;
  if not found then raise exception 'unknown patient'; end if;
  today := coalesce(
    p_today_key,
    (now() at time zone coalesce(nullif(p.timezone, ''), 'UTC'))::date
  );

  insert into public.patient_reward_state (
    patient_id, enrollment_date, baseline_weight, baseline_goal_weight
  )
  values (
    p.id,
    today,
    coalesce(
      p.starting_weight,
      (select ci.weight from public.patient_check_ins ci
       where ci.patient_id = p.id and ci.date_key <= today and ci.weight is not null
       order by ci.date_key desc limit 1)
    ),
    p.goal_weight
  )
  on conflict (patient_id) do nothing;
  select * into s from public.patient_reward_state where patient_id = p.id for update;

  -- One base event per eligible local day.  These inserts are intentionally
  -- based on committed rows, not on a client claim or request id.
  insert into public.patient_reward_events
    (patient_id, event_key, category, label, xp, occurred_on)
  select p.id, 'food:' || x.day_key, 'daily', 'First food log of the day', 100, x.day_key
  from (
    select distinct date_key as day_key
    from public.patient_diary_entries
    where patient_id = p.id and date_key >= s.enrollment_date and date_key <= today
  ) x
  on conflict do nothing;

  insert into public.patient_reward_events
    (patient_id, event_key, category, label, xp, occurred_on)
  select p.id, 'checkin:' || x.day_key, 'daily', 'Completed daily check-in', 100, x.day_key
  from (
    select distinct date_key as day_key
    from public.patient_check_ins
    where patient_id = p.id and date_key >= s.enrollment_date and date_key <= today
  ) x
  on conflict do nothing;

  select t.water_oz into target_oz
  from public.patient_target_overrides t
  where t.patient_id = p.id;
  if target_oz is not null and target_oz > 0 then
    insert into public.patient_reward_events
      (patient_id, event_key, category, label, xp, occurred_on)
    select p.id, 'hydration:' || w.date_key, 'daily', 'Met personal hydration target', 100, w.date_key
    from public.patient_water_days w
    where w.patient_id = p.id
      and w.date_key >= s.enrollment_date
      and w.date_key <= today
      and w.oz >= target_oz
    on conflict do nothing;
  end if;

  -- Current and best streaks use today's valid clinical rows.  The earned
  -- bonus event remains append-only even if a prior row is later corrected.
  select coalesce(array_agg(d order by d), '{}'::date[]) into dates
  from (
    select distinct date_key d from public.patient_diary_entries
    where patient_id = p.id and date_key between s.enrollment_date and today
  ) q;
  previous_day := null; current_streak := 0; best_streak := 0;
  foreach day_value in array dates loop
    if previous_day is not null and day_value = previous_day + 1 then current_streak := current_streak + 1;
    else current_streak := 1;
    end if;
    best_streak := greatest(best_streak, current_streak);
    previous_day := day_value;
  end loop;
  food_current := case when dates <> '{}'::date[] and dates[array_length(dates, 1)] = today then current_streak else 0 end;
  food_best := best_streak;

  select coalesce(array_agg(d order by d), '{}'::date[]) into dates
  from (
    select distinct date_key d from public.patient_check_ins
    where patient_id = p.id and date_key between s.enrollment_date and today
  ) q;
  previous_day := null; current_streak := 0; best_streak := 0;
  foreach day_value in array dates loop
    if previous_day is not null and day_value = previous_day + 1 then current_streak := current_streak + 1;
    else current_streak := 1;
    end if;
    best_streak := greatest(best_streak, current_streak);
    previous_day := day_value;
  end loop;
  checkin_current := case when dates <> '{}'::date[] and dates[array_length(dates, 1)] = today then current_streak else 0 end;
  checkin_best := best_streak;

  select coalesce(array_agg(w.date_key order by w.date_key), '{}'::date[]) into dates
  from public.patient_water_days w
  where w.patient_id = p.id and target_oz is not null and target_oz > 0
    and w.oz >= target_oz and w.date_key between s.enrollment_date and today;
  previous_day := null; current_streak := 0; best_streak := 0;
  foreach day_value in array dates loop
    if previous_day is not null and day_value = previous_day + 1 then current_streak := current_streak + 1;
    else current_streak := 1;
    end if;
    best_streak := greatest(best_streak, current_streak);
    previous_day := day_value;
  end loop;
  hydration_current := case when dates <> '{}'::date[] and dates[array_length(dates, 1)] = today then current_streak else 0 end;
  hydration_best := best_streak;

  -- Activity consistency medals are independent per activity.  Their bonus
  -- events are keyed by the medal, so a reset never removes the medal or XP.
  foreach i in array array[3, 7, 14, 30] loop
    if food_best >= i then
      insert into public.patient_reward_events
        (patient_id, event_key, category, label, xp, occurred_on)
      values (p.id, 'streak:food:' || i, 'streak', 'Food logging streak: ' || i || ' days', 250, today)
      on conflict do nothing;
    end if;
    if checkin_best >= i then
      insert into public.patient_reward_events
        (patient_id, event_key, category, label, xp, occurred_on)
      values (p.id, 'streak:checkin:' || i, 'streak', 'Check-in streak: ' || i || ' days', 250, today)
      on conflict do nothing;
    end if;
    if hydration_best >= i then
      insert into public.patient_reward_events
        (patient_id, event_key, category, label, xp, occurred_on)
      values (p.id, 'streak:hydration:' || i, 'streak', 'Hydration streak: ' || i || ' days', 250, today)
      on conflict do nothing;
    end if;
  end loop;

  -- Goal progress starts at enrollment and keeps the enrollment goal
  -- baseline.  A later target edit therefore cannot mint a prior award.
  if s.baseline_weight is not null and s.baseline_goal_weight is not null
     and s.baseline_weight > s.baseline_goal_weight then
    select ci.weight into latest_weight
    from public.patient_check_ins ci
    where ci.patient_id = p.id and ci.date_key >= s.enrollment_date
      and ci.date_key <= today and ci.weight is not null
    order by ci.date_key desc limit 1;
    latest_weight := coalesce(latest_weight, s.baseline_weight);
    pounds_lost := greatest(0, s.baseline_weight - latest_weight);
    goal_percent := greatest(0, least(100,
      pounds_lost / (s.baseline_weight - s.baseline_goal_weight) * 100
    ));
    foreach i in array array[10, 25, 50, 75, 100] loop
      if goal_percent >= i then
        insert into public.patient_reward_events
          (patient_id, event_key, category, label, xp, occurred_on)
        values (p.id, 'goal:' || i, 'goal', 'Personal goal: ' || i || '%', 500, today)
        on conflict do nothing;
      end if;
    end loop;
    if pounds_lost >= 5 then
      insert into public.patient_reward_events
        (patient_id, event_key, category, label, xp, occurred_on)
      values (p.id, 'goal:five-pounds', 'goal', 'First five pounds toward goal', 500, today)
      on conflict do nothing;
    end if;
  end if;

  -- Every bonus event has a durable medal row as well. Keeping this
  -- projection server-side means corrections can lower current progress
  -- without reclaiming an already earned event or award.
  insert into public.patient_reward_awards
    (patient_id, award_id, category, title, description, requirement, target, unit, xp_award)
  select
    e.patient_id,
    e.event_key,
    case when e.event_key like 'streak:%' then 'activity' else 'goal' end,
    case
      when e.event_key = 'goal:five-pounds' then 'Five-pound marker'
      when e.event_key like 'goal:%' then 'Personal goal: ' || split_part(e.event_key, ':', 2) || '%'
      else initcap(split_part(e.event_key, ':', 2)) || ' rhythm: ' || split_part(e.event_key, ':', 3) || ' days'
    end,
    case
      when e.event_key = 'goal:five-pounds' then 'A personal milestone, measured on your terms.'
      when e.event_key like 'goal:%' then 'A milestone toward your personal goal.'
      else 'A consistency marker for steady work.'
    end,
    case
      when e.event_key = 'goal:five-pounds' then 'Lose your first 5 lb toward a valid goal'
      when e.event_key like 'goal:%' then 'Reach ' || split_part(e.event_key, ':', 2) || '% of your goal'
      else 'Keep ' || split_part(e.event_key, ':', 2) || ' going for ' || split_part(e.event_key, ':', 3) || ' consecutive days'
    end,
    case when e.event_key = 'goal:five-pounds' then 5 else split_part(e.event_key, ':', 2)::numeric end,
    case when e.event_key like 'streak:%' then 'days' else 'goal milestone' end,
    e.xp
  from public.patient_reward_events e
  where e.patient_id = p.id and (e.category = 'streak' or e.category = 'goal')
  on conflict do nothing;

  select coalesce(sum(xp), 0)::integer into total_xp
  from public.patient_reward_events where patient_id = p.id;
  for i in 2..50 loop
    threshold := case
      when i <= 10 then (i - 1) * 300
      when i <= 20 then 2700 + (i - 10) * 500
      when i <= 30 then 7700 + (i - 20) * 750
      when i <= 40 then 15200 + (i - 30) * 1000
      else 25200 + (i - 40) * 1250
    end;
    if total_xp >= threshold then level := i; end if;
  end loop;
  level_xp := case
    when level = 1 then 0
    when level <= 10 then (level - 1) * 300
    when level <= 20 then 2700 + (level - 10) * 500
    when level <= 30 then 7700 + (level - 20) * 750
    when level <= 40 then 15200 + (level - 30) * 1000
    else 25200 + (level - 40) * 1250
  end;
  if level < 50 then
    next_level_xp := case
      when level + 1 <= 10 then level * 300
      when level + 1 <= 20 then 2700 + (level + 1 - 10) * 500
      when level + 1 <= 30 then 7700 + (level + 1 - 20) * 750
      when level + 1 <= 40 then 15200 + (level + 1 - 30) * 1000
      else 25200 + (level + 1 - 40) * 1250
    end;
    xp_to_next := greatest(0, next_level_xp - total_xp);
  else
    next_level_xp := null; xp_to_next := 0;
  end if;

  -- Tier medals are level-derived and deliberately award zero XP.
  foreach i in array array[5, 10, 15, 20, 25, 30, 35, 40, 45, 50] loop
    if level >= i then
      insert into public.patient_reward_awards
        (patient_id, award_id, category, title, description, requirement, target, unit, xp_award)
      values (
        p.id, 'level:' || i, 'level',
        case when i = 50 then 'Thinnr landmark' else 'Level ' || i || ' marker' end,
        case when i = 50 then 'A lasting record of the progress you chose.' else 'A level marker for steady work.' end,
        'Reach level ' || i, i, 'level', 0
      ) on conflict do nothing;
    end if;
  end loop;
  update public.patient_reward_state set updated_at = run_at where patient_id = p.id;

  return jsonb_build_object(
    'catalogVersion', 1,
    'enrolledAt', s.enrolled_at,
    'enrollmentDate', s.enrollment_date,
    'totalXp', total_xp,
    'level', level,
    'levelXp', level_xp,
    'nextLevelXp', next_level_xp,
    'xpToNextLevel', xp_to_next,
    'currentStreak', jsonb_build_object('food', food_current, 'checkin', checkin_current, 'hydration', hydration_current),
    'bestStreak', jsonb_build_object('food', food_best, 'checkin', checkin_best, 'hydration', hydration_best),
    'awards', coalesce((
      with catalog(id, category, title, description, requirement, threshold, progress, unit, xp_award, icon) as (
        select * from (values
          ('level:5','level','Level 5 marker','A level marker for steady work.','Reach level 5',5,level,'level',0,'award'),
          ('level:10','level','Level 10 marker','A level marker for steady work.','Reach level 10',10,level,'level',0,'award'),
          ('level:15','level','Level 15 marker','A level marker for steady work.','Reach level 15',15,level,'level',0,'award'),
          ('level:20','level','Level 20 marker','A level marker for steady work.','Reach level 20',20,level,'level',0,'award'),
          ('level:25','level','Level 25 marker','A level marker for steady work.','Reach level 25',25,level,'level',0,'award'),
          ('level:30','level','Level 30 marker','A level marker for steady work.','Reach level 30',30,level,'level',0,'award'),
          ('level:35','level','Level 35 marker','A level marker for steady work.','Reach level 35',35,level,'level',0,'award'),
          ('level:40','level','Level 40 marker','A level marker for steady work.','Reach level 40',40,level,'level',0,'award'),
          ('level:45','level','Level 45 marker','A level marker for steady work.','Reach level 45',45,level,'level',0,'award'),
          ('level:50','level','Thinnr landmark','A lasting record of the progress you chose.','Reach level 50',50,level,'level',0,'award'),
          ('streak:food:3','activity','Food rhythm','Three consecutive days of food notes.','Log food on 3 consecutive days',3,food_best,'days',250,'calendar'),
          ('streak:food:7','activity','Food steady week','A week of showing up.','Log food on 7 consecutive days',7,food_best,'days',250,'calendar'),
          ('streak:food:14','activity','Food in stride','Two weeks of steady notes.','Log food on 14 consecutive days',14,food_best,'days',250,'calendar'),
          ('streak:food:30','activity','Food foundation','A month of steady notes.','Log food on 30 consecutive days',30,food_best,'days',250,'calendar'),
          ('streak:checkin:3','activity','Check-in rhythm','Three consecutive daily check-ins.','Complete check-ins on 3 consecutive days',3,checkin_best,'days',250,'check-circle'),
          ('streak:checkin:7','activity','Check-in steady week','A week of honest check-ins.','Complete check-ins on 7 consecutive days',7,checkin_best,'days',250,'check-circle'),
          ('streak:checkin:14','activity','Check-in in stride','Two weeks of check-ins.','Complete check-ins on 14 consecutive days',14,checkin_best,'days',250,'check-circle'),
          ('streak:checkin:30','activity','Check-in foundation','A month of check-ins.','Complete check-ins on 30 consecutive days',30,checkin_best,'days',250,'check-circle'),
          ('streak:hydration:3','activity','Hydration rhythm','Three consecutive hydration target days.',case when target_oz is null then 'Set a personal hydration target to make this available' else 'Meet your hydration target on 3 consecutive days' end,3,hydration_best,'days',250,'droplet'),
          ('streak:hydration:7','activity','Hydration steady week','A week of meeting your target.',case when target_oz is null then 'Set a personal hydration target to make this available' else 'Meet your hydration target on 7 consecutive days' end,7,hydration_best,'days',250,'droplet'),
          ('streak:hydration:14','activity','Hydration in stride','Two weeks of meeting your target.',case when target_oz is null then 'Set a personal hydration target to make this available' else 'Meet your hydration target on 14 consecutive days' end,14,hydration_best,'days',250,'droplet'),
          ('streak:hydration:30','activity','Hydration foundation','A month of meeting your target.',case when target_oz is null then 'Set a personal hydration target to make this available' else 'Meet your hydration target on 30 consecutive days' end,30,hydration_best,'days',250,'droplet'),
          ('goal:10','goal','First direction','A first meaningful share of your personal goal.','Reach 10% of your goal',10,goal_percent,'% of goal',500,'trending-down'),
          ('goal:25','goal','Quarter ground','A quarter of your personal goal.','Reach 25% of your goal',25,goal_percent,'% of goal',500,'trending-down'),
          ('goal:50','goal','Halfway home','The middle is meaningful.','Reach 50% of your goal',50,goal_percent,'% of goal',500,'trending-down'),
          ('goal:75','goal','Quiet momentum','Progress with staying power.','Reach 75% of your goal',75,goal_percent,'% of goal',500,'trending-down'),
          ('goal:100','goal','Your landmark','A goal met on your terms.','Reach 100% of your goal',100,goal_percent,'% of goal',500,'trending-down'),
          ('goal:five-pounds','goal','Five-pound marker','A personal milestone, measured on your terms.','Lose your first 5 lb toward a valid goal',5,pounds_lost,'lb toward goal',500,'trending-down')
        ) v(id,category,title,description,requirement,threshold,progress,unit,xp_award,icon)
      )
      select jsonb_agg(jsonb_build_object(
        'id', c.id, 'category', c.category, 'title', c.title, 'description', c.description,
        'requirement', c.requirement, 'threshold', c.threshold, 'progress', least(c.threshold, c.progress),
        'unit', c.unit, 'xpAward', c.xp_award, 'earned', a.award_id is not null,
        'earnedAt', a.earned_at, 'icon', c.icon
      ) order by case c.category when 'level' then 1 when 'activity' then 2 else 3 end, c.threshold, c.id)
      from catalog c
      left join public.patient_reward_awards a on a.patient_id = p.id and a.award_id = c.id
    ), '[]'::jsonb),
    'history', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', e.event_key, 'label', e.label,
        'category', e.category, 'xp', e.xp, 'occurredOn', e.occurred_on
      ) order by e.created_at desc)
      from (
        select * from public.patient_reward_events
        where patient_id = p.id order by created_at desc limit 30
      ) e
    ), '[]'::jsonb),
    'newlyUnlocked', coalesce((
      select jsonb_agg(a.award_id order by a.earned_at)
      from public.patient_reward_awards a
      where a.patient_id = p.id and a.earned_at >= run_at - interval '2 seconds'
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.patient_rewards_reconcile(uuid, date) from public, anon, authenticated;
grant execute on function public.patient_rewards_reconcile(uuid, date) to service_role;