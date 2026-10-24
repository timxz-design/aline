-- A routine that is really a goal's sessions (home Wed/Thu ~17:00 = "Get fit"
-- training) is linked to that goal: it counts toward it, isn't asked about,
-- and doesn't add a block where the goal's plan already has one.
alter table public.routines
  add column if not exists goal_id uuid references public.goals(id) on delete set null;

-- Linked when completed sessions of one goal fell on the routine's weekday and
-- hours in at least 2 different weeks of the last 6.
-- (Superseded by 20261024135410: evidence uses actual workout times.)
create or replace function public.link_routines_to_goals(_user uuid)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  _tz text := coalesce(nullif((select timezone from profiles where id = _user), ''), 'UTC');
  _r record; _goal uuid; _n int := 0;
begin
  for _r in
    select id, day_of_week, start_minute, end_minute from routines
     where user_id = _user and active
       and day_of_week is not null and start_minute is not null and end_minute is not null
  loop
    select ce.goal_id into _goal
      from calendar_events ce
      join activity_log al on al.event_id = ce.id and al.result = 'done'
      join goals g on g.id = ce.goal_id and g.status = 'active'
     where ce.user_id = _user and ce.event_type = 'goal' and ce.goal_id is not null
       and ce.start_at > now() - interval '42 days' and ce.start_at < now()
       and extract(dow from ce.start_at at time zone _tz)::int = _r.day_of_week
       and (extract(hour from ce.start_at at time zone _tz) * 60 + extract(minute from ce.start_at at time zone _tz)) < _r.end_minute
       and (extract(hour from ce.end_at at time zone _tz) * 60 + extract(minute from ce.end_at at time zone _tz)) > _r.start_minute
     group by ce.goal_id
    having count(distinct date_trunc('week', ce.start_at at time zone _tz)) >= 2
     order by count(*) desc
     limit 1;
    update routines set goal_id = _goal, updated_at = now()
     where id = _r.id and goal_id is distinct from _goal;
    if _goal is not null then _n := _n + 1; end if;
  end loop;
  return _n;
end $function$;

do $mig$
declare _src text;
begin
  -- hourly rebuild links routines after recomputing them
  select pg_get_functiondef('public.rebuild_places_and_routines_all()'::regprocedure) into _src;
  _src := replace(_src, '    perform public.rebuild_routines(_u);',
                        '    perform public.rebuild_routines(_u);
    perform public.link_routines_to_goals(_u);');
  if _src not like '%link_routines_to_goals%' then raise exception 'rebuild patch did not apply'; end if;
  execute _src;

  -- don't ask "is this a regular thing?" about a goal's own sessions
  select pg_get_functiondef('public._next_curiosity_item(uuid)'::regprocedure) into _src;
  _src := replace(_src, 'where r.user_id = _user and r.active = true and r.inference_status = ''pending''',
                        'where r.user_id = _user and r.active = true and r.inference_status = ''pending'' and r.goal_id is null');
  if _src not like '%r.goal_id is null%' then raise exception 'curiosity patch did not apply'; end if;
  execute _src;

  -- linked routine: the goal's plan already schedules it; without a live plan
  -- it goes on the calendar as a goal session so it counts toward the goal
  select pg_get_functiondef('public.materialize_routines()'::regprocedure) into _src;
  _src := replace(_src,
    'SELECT ro.id, ro.user_id, ro.category, ro.day_of_week,',
    'SELECT ro.id, ro.user_id, ro.category, ro.day_of_week, ro.goal_id,
           exists (select 1 from goal_plans gp where gp.goal_id = ro.goal_id and gp.status = ''live'') AS goal_planned,');
  _src := replace(_src,
    '    CONTINUE WHEN _is_home;',
    '    CONTINUE WHEN _is_home;
    CONTINUE WHEN _r.goal_id IS NOT NULL AND _r.goal_planned;');
  _src := replace(_src,
    '        (user_id, title, start_at, end_at, event_type, is_movable, location, source, external_id)
      VALUES
        (_r.user_id, _place_name, _start_ts, _end_ts, ''routine'', true, _r.place_name, ''routine'', _ext)
      ON CONFLICT (user_id, source, external_id) DO UPDATE
        SET title = excluded.title, start_at = excluded.start_at, end_at = excluded.end_at,
            event_type = excluded.event_type, location = excluded.location, updated_at = now();',
    '        (user_id, title, start_at, end_at, event_type, goal_id, is_movable, location, source, external_id)
      VALUES
        (_r.user_id, _place_name, _start_ts, _end_ts,
         CASE WHEN _r.goal_id IS NOT NULL THEN ''goal'' ELSE ''routine'' END, _r.goal_id,
         true, _r.place_name, ''routine'', _ext)
      ON CONFLICT (user_id, source, external_id) DO UPDATE
        SET title = excluded.title, start_at = excluded.start_at, end_at = excluded.end_at,
            event_type = excluded.event_type, goal_id = excluded.goal_id,
            location = excluded.location, updated_at = now();');
  if _src not like '%goal_planned%' or _src not like '%CASE WHEN _r.goal_id IS NOT NULL THEN ''goal''%' then
    raise exception 'materialize patch did not apply';
  end if;
  execute _src;
end $mig$;
