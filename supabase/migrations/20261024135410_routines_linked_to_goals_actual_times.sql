-- Link evidence uses when sessions really happened: Apple Health workout times
-- when there is one (a 15:00 block trained at 16:07 counts at 16:07).
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
    with sessions as (
      select ce.goal_id,
             coalesce(hw.started_at, ce.start_at) as s,
             coalesce(hw.ended_at, ce.end_at) as e
        from calendar_events ce
        join activity_log al on al.event_id = ce.id and al.result = 'done'
        left join health_workouts hw on hw.id = ce.health_workout_id
       where ce.user_id = _user and ce.event_type = 'goal' and ce.goal_id is not null
         and ce.start_at > now() - interval '42 days' and ce.start_at < now()
    )
    select s.goal_id into _goal
      from sessions s
      join goals g on g.id = s.goal_id and g.status = 'active'
     where extract(dow from s.s at time zone _tz)::int = _r.day_of_week
       and (extract(hour from s.s at time zone _tz) * 60 + extract(minute from s.s at time zone _tz)) < _r.end_minute
       and (extract(hour from s.e at time zone _tz) * 60 + extract(minute from s.e at time zone _tz)) > _r.start_minute
     group by s.goal_id
    having count(distinct date_trunc('week', s.s at time zone _tz)) >= 2
     order by count(*) desc
     limit 1;
    update routines set goal_id = _goal, updated_at = now()
     where id = _r.id and goal_id is distinct from _goal;
    if _goal is not null then _n := _n + 1; end if;
  end loop;
  return _n;
end $function$;
