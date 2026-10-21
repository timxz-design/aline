--
-- PostgreSQL database dump
--

-- Dumped from database version 17.6
-- Dumped by pg_dump version 17.4

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: hangouts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hangouts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    group_id uuid,
    proposed_by uuid NOT NULL,
    title text NOT NULL,
    description text,
    status text DEFAULT 'proposing'::text,
    proposed_start timestamp with time zone,
    proposed_end timestamp with time zone,
    venue_name text,
    venue_address text,
    venue_lat double precision,
    venue_lng double precision,
    reasoning text,
    confidence numeric(3,2),
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    min_attendees integer DEFAULT 2 NOT NULL,
    direct_user_id uuid,
    invite_policy text DEFAULT 'host_only'::text NOT NULL,
    CONSTRAINT hangouts_invite_policy_check CHECK ((invite_policy = ANY (ARRAY['host_only'::text, 'participants'::text, 'mutuals'::text]))),
    CONSTRAINT hangouts_min_attendees_check CHECK ((min_attendees >= 1)),
    CONSTRAINT hangouts_status_check CHECK ((status = ANY (ARRAY['proposing'::text, 'confirmed'::text, 'happening'::text, 'completed'::text, 'cancelled'::text, 'expired'::text]))),
    CONSTRAINT hangouts_target_xor CHECK (((((group_id IS NOT NULL))::integer + ((direct_user_id IS NOT NULL))::integer) = 1))
);


--
-- Name: COLUMN hangouts.invite_policy; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.hangouts.invite_policy IS 'Who may add people: host_only = only proposed_by; participants = anyone not declined; mutuals = anyone not declined, and the invitee must also be friends with another participant.';


--
-- Name: _coordinated_event_payload(uuid, public.hangouts); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public._coordinated_event_payload(_user_id uuid, _h public.hangouts) RETURNS jsonb
    LANGUAGE sql STABLE
    AS $$
  select jsonb_build_object(
    'user_id',     _user_id,
    'title',       coalesce(_h.title, 'Group hangout'),
    'description', _h.description,
    'start_at',    _h.proposed_start,
    'end_at',      coalesce(_h.proposed_end, _h.proposed_start + interval '2 hours'),
    'event_type',  'coordinated',
    'hangout_id',  _h.id,
    'location',    nullif(trim(coalesce(_h.venue_name, '') ||
                          case when _h.venue_address is not null and _h.venue_address <> ''
                               then ' - ' || _h.venue_address else '' end), ''),
    'source',      'aline'
  );
$$;


--
-- Name: _hangout_can_invite(public.hangouts, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public._hangout_can_invite(_h public.hangouts, _caller uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT _h.status IN ('proposing','confirmed')
     AND (
       _h.proposed_by = _caller
       OR (_h.invite_policy IN ('participants','mutuals') AND EXISTS (
             SELECT 1 FROM hangout_responses
             WHERE hangout_id = _h.id AND user_id = _caller AND status <> 'declined'))
     );
$$;


--
-- Name: _hangout_invite_block_reason(public.hangouts, uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public._hangout_invite_block_reason(_h public.hangouts, _caller uuid, _invitee uuid) RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM hangout_responses WHERE hangout_id = _h.id AND user_id = _invitee) THEN 'already_in'
    WHEN NOT are_friends(_caller, _invitee) THEN 'not_your_friend'
    WHEN _h.invite_policy = 'mutuals' AND NOT EXISTS (
      SELECT 1 FROM hangout_responses r
      WHERE r.hangout_id = _h.id AND r.user_id <> _caller AND r.status <> 'declined'
        AND are_friends(r.user_id, _invitee)
    ) THEN 'no_mutual'
    ELSE NULL
  END;
$$;


--
-- Name: _hhmm(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public._hhmm(_min integer) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$ SELECT lpad((_min / 60)::text, 2, '0') || ':' || lpad((_min % 60)::text, 2, '0') $$;


--
-- Name: _materialize_goal_plan(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public._materialize_goal_plan(_plan_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  _horizon_days int := 14;
  _uid uuid; _goal uuid; _spec jsonb; _tz text; _today date;
  _sess jsonb; _start text; _dur int; _activity text; _loc text; _note text;
  _days jsonb; _cycle jsonb; _clen int; _anchor date; _on jsonb;
  _d date; _occurs boolean; _diff int; _pos int;
  _start_utc timestamptz; _end_utc timestamptz;
  _created int := 0; _skipped int := 0;
begin
  select gp.user_id, gp.goal_id, gp.plan_spec, p.timezone
    into _uid, _goal, _spec, _tz
    from goal_plans gp join profiles p on p.id = gp.user_id
   where gp.id = _plan_id and gp.status = 'live';
  if _uid is null or coalesce(_tz,'') = '' or jsonb_typeof(_spec->'sessions') <> 'array' then
    return jsonb_build_object('created', 0, 'skipped', 0);
  end if;

  _today := (now() at time zone _tz)::date;

  for _sess in select jsonb_array_elements(_spec->'sessions')
  loop
    _start := _sess->>'start';
    _dur := nullif(_sess->>'duration_min','')::int;
    _activity := coalesce(nullif(_sess->>'activity',''), 'Goal session');
    _loc := _sess->>'location_hint';
    _note := _sess->>'note';
    continue when _start is null or _dur is null;

    _cycle := _sess->'cycle';
    _days := _sess->'days';
    _clen := null; _on := null; _anchor := null;
    if jsonb_typeof(_cycle) = 'object' then
      _clen := nullif(_cycle->>'length','')::int;
      _on := _cycle->'on';
      begin _anchor := coalesce((_cycle->>'anchor')::date, _today);
      exception when others then _anchor := _today; end;
    end if;

    for _d in
      select g::date from generate_series(_today::timestamp,
                                          (_today + (_horizon_days - 1))::timestamp,
                                          interval '1 day') g
    loop
      _occurs := false;
      if _clen is not null and _clen >= 1 and jsonb_typeof(_on) = 'array' then
        _diff := _d - _anchor;
        if _diff >= 0 then
          _pos := (_diff % _clen) + 1;
          _occurs := exists (select 1 from jsonb_array_elements_text(_on) e where e.value::int = _pos);
        end if;
      elsif jsonb_typeof(_days) = 'array' then
        _occurs := exists (
          select 1 from jsonb_array_elements_text(_days) e
           where case e.value when 'Sun' then 0 when 'Mon' then 1 when 'Tue' then 2 when 'Wed' then 3
                              when 'Thu' then 4 when 'Fri' then 5 when 'Sat' then 6 else -1 end
                 = extract(dow from _d)::int);
      end if;
      continue when not _occurs;

      _start_utc := (_d::text || ' ' || left(_start, 5) || ':00')::timestamp at time zone _tz;
      continue when _start_utc < now();
      _end_utc := _start_utc + (_dur || ' minutes')::interval;

      -- already placed for this plan+activity on this local day → skip silently
      continue when exists (
        select 1 from calendar_events ce
         where ce.user_id = _uid and ce.goal_plan_id = _plan_id
           and ce.title = _activity and (ce.start_at at time zone _tz)::date = _d);

      -- clashes with a real (non routine/transit) event → count as skipped
      if exists (
        select 1 from calendar_events ce
         where ce.user_id = _uid and coalesce(ce.event_type,'') not in ('routine','transit')
           and ce.start_at < _end_utc and ce.end_at > _start_utc) then
        _skipped := _skipped + 1;
        continue;
      end if;

      insert into calendar_events (
        user_id, title, description, start_at, end_at, event_type,
        is_movable, location, source, goal_id, goal_plan_id
      ) values (
        _uid, _activity, _note, _start_utc, _end_utc, 'goal',
        true, _loc, 'aline', _goal, _plan_id);
      _created := _created + 1;
    end loop;
  end loop;

  return jsonb_build_object('created', _created, 'skipped', _skipped);
end;
$$;


--
-- Name: _move_goal_block_to_actual(uuid, uuid, timestamp with time zone, timestamp with time zone, text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public._move_goal_block_to_actual(_uid uuid, _event_id uuid, _start timestamp with time zone, _end timestamp with time zone, _confirmed_by text, _workout_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare _log_id uuid; _goal uuid;
begin
  update calendar_events
     set original_start_at = coalesce(original_start_at, start_at),
         start_at = _start, end_at = _end,
         health_workout_id = coalesce(_workout_id, health_workout_id),
         updated_at = now()
   where id = _event_id and user_id = _uid
   returning goal_id into _goal;

  select id into _log_id from activity_log where event_id = _event_id and user_id = _uid limit 1;
  if _log_id is not null then
    update activity_log
       set result = 'done', confirmed_by = _confirmed_by, checked_at = now(),
           scheduled_start = _start, scheduled_end = _end
     where id = _log_id;
  else
    insert into activity_log (user_id, event_id, result, confirmed_by,
                              scheduled_start, scheduled_end, source_kind, checked_at)
    values (_uid, _event_id, 'done', _confirmed_by, _start, _end, 'goal', now());
  end if;

  if _goal is not null then
    update goals set last_completed_at = greatest(coalesce(last_completed_at, _end), _end)
     where id = _goal and user_id = _uid;
  end if;
end;
$$;


--
-- Name: _next_curiosity_item(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public._next_curiosity_item(_user uuid) RETURNS TABLE(kind text, id uuid, payload jsonb)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
declare
  _snooze interval := interval '30 days';
begin
  return query
  select 'activity'::text, al.id,
    jsonb_build_object(
      'source_kind', al.source_kind,
      'label', regexp_replace(coalesce(ce.title, pl.user_label, pl.name, al.expected_category, 'your activity'), '\s*\([^)]*\)\s*$', ''),
      'place_name', coalesce(pl.user_label, pl.name),
      'scheduled_start', al.scheduled_start,
      'ambiguity', case
        when al.place_id is null then 'goal'
        when (pl.category = 'home' or lower(coalesce(pl.user_label,'')) in ('home','dom')) then 'home'
        else 'skipped' end)
  from activity_log al
  left join places pl on pl.id = al.place_id
  left join calendar_events ce on ce.id = al.event_id
  where al.user_id = _user
    and al.result = 'needs_confirm'
    and coalesce(al.scheduled_end, al.scheduled_start + interval '1 hour') < now()
    and al.scheduled_start > now() - interval '2 days'
    and not (al.source_kind = 'goal' and exists (
          select 1 from health_workouts hw
           where hw.user_id = _user and hw.duration_min >= 5
             and hw.started_at >= coalesce((select value::timestamptz from app_config where key = 'reliable_data_since'), '-infinity')))
    and not exists (
          select 1 from activity_log al2
            join calendar_events ce2 on ce2.id = al2.event_id
           where al2.user_id = _user and al2.id <> al.id
             and ce2.goal_id is not null and ce2.goal_id = ce.goal_id
             and al2.last_asked_at > now() - interval '7 days')
    and (al.last_asked_at is null or al.last_asked_at < now() - _snooze)
  order by al.scheduled_start desc
  limit 1;
  if found then return; end if;

  return query
  select 'place'::text, p.id,
    jsonb_build_object(
      'name', coalesce(p.user_label, p.name),
      'category', coalesce(p.category, p.primary_type),
      'visit_count', p.visit_count,
      'lat', p.centroid_lat, 'lon', p.centroid_lon)
  from places p
  where p.user_id = _user and p.inference_status = 'pending' and p.is_hidden = false
    and p.visit_count >= 3 and (p.confidence is null or p.confidence < 0.7)
    and (p.last_asked_at is null or p.last_asked_at < now() - _snooze)
  order by case when p.last_asked_at is null then 0 else 1 end, p.visit_count desc, p.last_seen desc
  limit 1;
  if found then return; end if;

  return query
  select 'routine'::text, r.id,
    jsonb_build_object(
      'place_name', coalesce(pl.user_label, pl.name, 'the same place'),
      'day_of_week', r.day_of_week, 'start_minute', r.start_minute, 'end_minute', r.end_minute)
  from routines r
  left join places pl on pl.id = r.place_id
  where r.user_id = _user and r.active = true and r.inference_status = 'pending'
    and r.consistency >= 0.65
    and (r.last_asked_at is null or r.last_asked_at < now() - _snooze)
  order by case when r.last_asked_at is null then 0 else 1 end, r.consistency desc, r.last_observed desc nulls last
  limit 1;
end;
$_$;


--
-- Name: add_friends_to_group(uuid, uuid[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.add_friends_to_group(_group_id uuid, _user_ids uuid[]) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  _user_id uuid := auth.uid();
  _added integer := 0;
  _candidate uuid;
  _is_friend boolean;
begin
  if _user_id is null then
    raise exception 'Not authenticated';
  end if;

  -- Caller must be a group member (admin or not — for now, any member can invite).
  if not exists (
    select 1 from public.group_members
    where group_id = _group_id and user_id = _user_id
  ) then
    raise exception 'You are not a member of this group';
  end if;

  if _user_ids is null or array_length(_user_ids, 1) is null then
    return 0;
  end if;

  foreach _candidate in array _user_ids
  loop
    if _candidate = _user_id then
      continue;
    end if;
    -- friend check
    select exists(
      select 1 from public.friendships
      where status = 'accepted'
        and user_a = least(_user_id, _candidate)
        and user_b = greatest(_user_id, _candidate)
    ) into _is_friend;
    if not _is_friend then
      continue;
    end if;
    -- insert (no-op if already a member)
    insert into public.group_members (group_id, user_id, role, trust_tier)
    values (_group_id, _candidate, 'member', 'friends')
    on conflict (group_id, user_id) do nothing;
    if found then
      _added := _added + 1;
    end if;
  end loop;

  return _added;
end;
$$;


--
-- Name: align_routines_to_arrival(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.align_routines_to_arrival() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  _b record; _arrive timestamptz; _len interval; _new_start timestamptz; _new_end timestamptz;
  _pre interval; _post interval; _moved int := 0;
begin
  for _b in
    select ce.id, ce.user_id, ce.start_at, ce.end_at, ce.external_id, pl.geohash_7, pr.timezone tz
      from calendar_events ce
      join profiles pr on pr.id = ce.user_id
      join routines r on r.id = nullif(split_part(ce.external_id, ':', 1), '')::uuid
      join places pl on pl.id = r.place_id
     where ce.source = 'routine' and ce.event_type = 'routine'
       and ce.original_start_at is null
       and ce.end_at > now()
       and ce.start_at < now() + interval '3 hours'
       and coalesce(pr.timezone, '') <> ''
       and (ce.start_at at time zone pr.timezone)::date = (now() at time zone pr.timezone)::date
       and not (pl.category = 'home' or lower(coalesce(pl.user_label, '')) in ('home', 'dom'))
       and pl.geohash_7 is not null
  loop
    -- First sign of being there: earliest ping at the place from 3h before
    -- the planned start onward (geofence entries make this exact).
    select min(bp.captured_at) into _arrive
      from behavioral_pings bp
     where bp.user_id = _b.user_id
       and substr(bp.geohash_8, 1, 7) = _b.geohash_7
       and bp.captured_at between _b.start_at - interval '3 hours' and least(_b.end_at, now());
    continue when _arrive is null;
    continue when abs(extract(epoch from (_arrive - _b.start_at))) < 20 * 60;

    _len := _b.end_at - _b.start_at;
    _new_start := _arrive;
    _new_end := _arrive + _len;

    update calendar_events
       set original_start_at = start_at, start_at = _new_start, end_at = _new_end, updated_at = now()
     where id = _b.id;

    -- Keep the transit envelopes attached, same lengths.
    select end_at - start_at into _pre from calendar_events
     where user_id = _b.user_id and source = 'routine' and external_id = _b.external_id || ':pre';
    if _pre is not null then
      update calendar_events set start_at = _new_start - _pre, end_at = _new_start, updated_at = now()
       where user_id = _b.user_id and source = 'routine' and external_id = _b.external_id || ':pre';
    end if;
    select end_at - start_at into _post from calendar_events
     where user_id = _b.user_id and source = 'routine' and external_id = _b.external_id || ':post';
    if _post is not null then
      update calendar_events set start_at = _new_end, end_at = _new_end + _post, updated_at = now()
       where user_id = _b.user_id and source = 'routine' and external_id = _b.external_id || ':post';
    end if;
    _moved := _moved + 1;
  end loop;
  return _moved;
end;
$$;


--
-- Name: apply_change_set(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.apply_change_set(_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  _user uuid := auth.uid();
  _set  record;
  _op   jsonb;
  _new_event_id uuid;
  _existing record;
  _applied jsonb := '[]'::jsonb;
begin
  if _user is null then
    raise exception 'must be authenticated';
  end if;

  select * into _set from public.change_sets
   where id = _id and user_id = _user for update;
  if not found then raise exception 'change set not found'; end if;
  if _set.status <> 'pending' then
    raise exception 'change set is %, cannot apply', _set.status;
  end if;
  if _set.expires_at < now() then
    update public.change_sets set status = 'expired', updated_at = now() where id = _id;
    raise exception 'change set has expired';
  end if;

  -- validate
  for _op in select * from jsonb_array_elements(_set.operations) loop
    if _op->>'op' = 'move' then
      select id, user_id, is_movable into _existing
        from public.calendar_events where id = (_op->>'event_id')::uuid;
      if not found then raise exception 'move target event not found: %', _op->>'event_id'; end if;
      if _existing.user_id <> _user then raise exception 'cannot move another user''s event'; end if;
      if not _existing.is_movable then raise exception 'event % is not movable', _op->>'event_id'; end if;
    elsif _op->>'op' = 'create' then
      if (_op->>'title') is null or (_op->>'start_at') is null or (_op->>'end_at') is null then
        raise exception 'create op missing required fields';
      end if;
    elsif _op->>'op' = 'cancel' then
      raise exception 'cancel op is not enabled in v1';
    else
      raise exception 'unknown op: %', _op->>'op';
    end if;
  end loop;

  -- apply
  for _op in select * from jsonb_array_elements(_set.operations) loop
    if _op->>'op' = 'move' then
      update public.calendar_events
        set original_start_at = coalesce(original_start_at, start_at),
            start_at = (_op->>'new_start')::timestamptz,
            end_at   = (_op->>'new_end')::timestamptz,
            updated_at = now()
      where id = (_op->>'event_id')::uuid;
      _applied := _applied || jsonb_build_object('op','move','event_id', _op->>'event_id');

    elsif _op->>'op' = 'create' then
      -- Double-booking guard: skip if a committed (non-routine/transit) event
      -- already overlaps this slot.
      perform 1 from public.calendar_events
       where user_id = _user
         and coalesce(event_type,'') not in ('routine','transit')
         and start_at < (_op->>'end_at')::timestamptz
         and end_at   > (_op->>'start_at')::timestamptz
       limit 1;
      if found then
        _applied := _applied || jsonb_build_object('op','create','skipped','overlap','title', _op->>'title');
      else
        insert into public.calendar_events (
          user_id, title, description, start_at, end_at,
          event_type, hangout_id, location, source, goal_id, goal_plan_id
        ) values (
          _user, _op->>'title', _op->>'description',
          (_op->>'start_at')::timestamptz, (_op->>'end_at')::timestamptz,
          coalesce(_op->>'event_type','flexible'),
          nullif(_op->>'hangout_id','')::uuid, _op->>'location', 'aline',
          nullif(_op->>'goal_id','')::uuid, nullif(_op->>'goal_plan_id','')::uuid
        ) returning id into _new_event_id;
        _applied := _applied || jsonb_build_object('op','create','event_id', _new_event_id);
      end if;
    end if;
  end loop;

  update public.change_sets set status = 'accepted', updated_at = now() where id = _id;
  return jsonb_build_object('success', true, 'applied', _applied);
end;
$$;


--
-- Name: apply_schedule_suggestion(uuid, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.apply_schedule_suggestion(_id uuid, _accept boolean) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare _uid uuid := auth.uid(); _s schedule_suggestions; _spec jsonb; _res jsonb; _removed int;
begin
  select * into _s from schedule_suggestions where id = _id and user_id = _uid and status = 'pending';
  if not found then raise exception 'no open suggestion with that id'; end if;

  if not _accept then
    update schedule_suggestions set status = 'declined', resolved_at = now() where id = _id;
    return jsonb_build_object('applied', false);
  end if;

  select plan_spec into _spec from goal_plans where id = _s.goal_plan_id and user_id = _uid for update;
  _spec := jsonb_set(_spec, '{sessions}', (
    select jsonb_agg(case when e->>'activity' = _s.session_activity
                          then e || jsonb_build_object('start', _s.to_start, 'duration_min', _s.to_duration)
                          else e end)
      from jsonb_array_elements(_spec->'sessions') e));
  update goal_plans set plan_spec = _spec, updated_at = now() where id = _s.goal_plan_id;

  -- Replace this session's future, not-yet-done blocks at the new time.
  delete from calendar_events ce
   where ce.user_id = _uid and ce.goal_plan_id = _s.goal_plan_id and ce.title = _s.session_activity
     and ce.start_at > now()
     and not exists (select 1 from activity_log al where al.event_id = ce.id and al.result = 'done');
  get diagnostics _removed = row_count;
  _res := public._materialize_goal_plan(_s.goal_plan_id);

  update schedule_suggestions set status = 'accepted', resolved_at = now() where id = _id;
  return jsonb_build_object('applied', true, 'removed', _removed,
                            'created', (_res->>'created')::int, 'new_time', _s.to_start,
                            'new_duration', _s.to_duration);
end;
$$;


--
-- Name: appointment_locations(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.appointment_locations() RETURNS TABLE(event_title text, starts_at timestamp with time zone, last_visit timestamp with time zone, lat double precision, lon double precision, spot_name text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  with upcoming as (
    select ce.title, ce.start_at, public.norm_event_title(ce.title) k
      from calendar_events ce
     where ce.user_id = auth.uid()
       and ce.start_at > now() and ce.start_at < now() + interval '14 days'
       and coalesce(trim(ce.location), '') = ''
       and coalesce(ce.event_type, '') not in ('routine', 'transit', 'goal')
       and public.norm_event_title(ce.title) is not null
  ), past as (
    select public.norm_event_title(v.activity) k, v.arrived_at, c.lat, c.lon
      from visits v
      cross join lateral public.stay_centroid(v.user_id, v.arrived_at, v.left_at) c
     where v.user_id = auth.uid() and v.kind = 'stay' and v.activity_source = 'calendar'
       and v.arrived_at < now() and c.lat is not null
  )
  select distinct on (u.title, u.start_at)
         u.title, u.start_at, p.arrived_at, p.lat, p.lon,
         coalesce(
           (select coalesce(pl.user_label, pl.name) from places pl
             where pl.user_id = auth.uid() and not pl.is_hidden and pl.centroid_lat is not null
               and public.approx_metres(pl.centroid_lat, pl.centroid_lon, p.lat, p.lon) <= 150
             limit 1))
    from upcoming u join past p on p.k = u.k
   order by u.title, u.start_at, p.arrived_at desc
$$;


--
-- Name: approx_metres(double precision, double precision, double precision, double precision); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.approx_metres(lat1 double precision, lon1 double precision, lat2 double precision, lon2 double precision) RETURNS double precision
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT sqrt(power((lon2 - lon1) * cos(radians((lat1 + lat2) / 2)) * 111320, 2)
            + power((lat2 - lat1) * 110540, 2));
$$;


--
-- Name: are_friends(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.are_friends(_a uuid, _b uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.friendships
    WHERE status = 'accepted'
      AND user_a = LEAST(_a, _b)
      AND user_b = GREATEST(_a, _b)
  );
$$;


--
-- Name: auto_friend_new_profile(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auto_friend_new_profile() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE _host uuid;
BEGIN
  SELECT value::uuid INTO _host FROM app_config WHERE key = 'auto_friend_user_id';
  IF _host IS NULL OR _host = NEW.id THEN RETURN NEW; END IF;
  INSERT INTO friendships (user_a, user_b, status, requested_by)
  VALUES (LEAST(_host, NEW.id), GREATEST(_host, NEW.id), 'accepted', _host)
  ON CONFLICT (user_a, user_b) DO NOTHING;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never block account creation over the convenience friendship.
  RETURN NEW;
END;
$$;


--
-- Name: build_visits(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.build_visits(_user uuid) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  _cutoff timestamptz := coalesce((select value::timestamptz from app_config where key = 'reliable_data_since'), '-infinity');
  _cursor timestamptz; _prev_stay uuid; _prev_left timestamptz;
  _p record; _c record; _m record;
  _open boolean := false; _a_lat double precision; _a_lon double precision;
  _first timestamptz; _last timestamptz; _n int; _cells text[]; _precise boolean;
  _radius constant double precision := 250;   -- metres: same spot (background GPS is coarse)
  _precise_radius constant double precision := 120;  -- iOS visits are accurate: a stop 150 m away is a different place
  _r double precision;
  _min_stay constant interval := interval '10 minutes';
  _min_dwell constant interval := interval '5 minutes';  -- shorter = a pause on the road, not a stay
  _new uuid; _made int := 0; _mode text; _dep timestamptz; _speed double precision; _late timestamptz;
  _next_arrival timestamptz; _last_visit boolean; _dep_known boolean; _prev_lat double precision; _prev_lon double precision;
begin
  -- Resume after the last CLOSED stay; everything after it is rebuilt.
  -- Late arrivals: pings uploaded recently but captured before the last closed
  -- stay ended (e.g. queued iOS visits). Rewind to the stay before them.
  select min(captured_at) into _late from behavioral_pings
   where user_id = _user and created_at > now() - interval '30 minutes'
     and captured_at > _cutoff;
  select id, left_at, (public.geohash_center(geohash_7)).lat, (public.geohash_center(geohash_7)).lon
    into _prev_stay, _prev_left, _prev_lat, _prev_lon from visits
   where user_id = _user and kind = 'stay' and not is_open
     and left_at <= coalesce(_late, 'infinity'::timestamptz)
   order by left_at desc limit 1;
  _cursor := greatest(coalesce(_prev_left, _cutoff), _cutoff);
  delete from visits where user_id = _user and arrived_at >= _cursor
     and not (kind = 'stay' and not is_open and id = _prev_stay)
     and activity_source is distinct from 'user';

  for _p in
    select bp.captured_at, bp.geohash_8, bp.motion_state, bp.source, (public.geohash_center(bp.geohash_8)).*
      from behavioral_pings bp
     where bp.user_id = _user and bp.captured_at > _cursor and bp.geohash_8 is not null
     order by bp.captured_at
  loop
    _r := _radius;
    if _precise or _p.source = 'visit' then _r := _precise_radius; end if;
    if _open and public.approx_metres(_a_lat, _a_lon, _p.lat, _p.lon) <= _r then
      _last := _p.captured_at; _n := _n + 1; _last_visit := _p.source = 'visit';
      _a_lat := _a_lat + (_p.lat - _a_lat) / _n;    -- running centre
      _a_lon := _a_lon + (_p.lon - _a_lon) / _n;
      _cells := _cells || substr(_p.geohash_8, 1, 7);
      continue;
    end if;

    -- moved away: close the current candidate if it was a real stay
    _next_arrival := null;
    if _open and (_p.captured_at - _first) >= _min_stay then
      _speed := 1.4;
      if _p.motion_state = 'driving' then _speed := 8.0; elsif _p.motion_state = 'active' then _speed := 3.0; end if;
      _dep := greatest(_last, _p.captured_at - make_interval(secs =>
                public.approx_metres(_a_lat, _a_lon, _p.lat, _p.lon) / _speed));
      -- Only the arrival is known (no later ping there, nothing for a while):
      -- iOS motion says when they actually got up and left.
      -- Last thing seen there is an iOS visit after the arrival = the departure itself.
      _dep_known := _n >= 2 and _last_visit and _last > _first + interval '1 minute';
      if _dep_known then _dep := _last; end if;
      if not _dep_known and _n <= 2 and _p.captured_at - _last > interval '20 minutes'
         -- iOS reported leaving this spot (maybe a few seconds after this ping): trust that.
         and not exists (select 1 from behavioral_pings vp
                          where vp.user_id = _user and vp.source = 'visit'
                            and vp.captured_at > _last and vp.captured_at <= _p.captured_at + interval '15 minutes'
                            and public.approx_metres(_a_lat, _a_lon, (public.geohash_center(vp.geohash_8)).lat,
                                                     (public.geohash_center(vp.geohash_8)).lon) <= _precise_radius) then
        select * into _m from public.stay_end_by_motion(_user, _last, _p.captured_at);
        if _m.departed is not null and _m.departed < _dep then
          _dep := greatest(_m.departed, _last);
          _next_arrival := _m.next_arrival;
        end if;
      end if;
      -- A lone point mid-drive (traffic light, slow traffic) is not a stay:
      -- needs real dwell and must not be "mostly moving" per iOS motion.
      if _dep - _first >= _min_dwell and not public.was_moving(_user, _first, _dep) then
        insert into visits (user_id, kind, arrived_at, left_at, left_by, is_open, geohash_7, ping_count)
        values (_user, 'stay', _first, _dep, _p.captured_at, false,
                (select c from unnest(_cells) c group by c order by count(*) desc limit 1), _n)
        returning id into _new;
        perform public.predict_visit_activity(_new);
        if _prev_stay is not null then
          -- iOS motion history first; ping speeds only as a fallback (a car
          -- crawling in traffic reads as "walking" by speed alone).
          _mode := public.travel_mode_for(_user, _prev_left, _first);
          if _mode is null then
            select case max(case motion_state when 'driving' then 3 when 'active' then 2 when 'walking' then 1 else 0 end)
                     when 3 then 'driving' when 2 then 'active' when 1 then 'walking' else 'unknown' end
              into _mode from behavioral_pings
             where user_id = _user and captured_at > _prev_left and captured_at < _first;
          end if;
          insert into visits (user_id, kind, arrived_at, left_at, travel_mode, from_visit_id, to_visit_id)
          values (_user, 'travel', _prev_left, _first, coalesce(_mode, 'unknown'), _prev_stay, _new);
        end if;
        _prev_stay := _new; _prev_left := _dep; _prev_lat := _a_lat; _prev_lon := _a_lon; _made := _made + 1;
      else
        _next_arrival := null;
      end if;
    end if;

    -- Short hop after a stay that ended at a motion break: they arrived when
    -- motion settled again, not at this (possibly much later) ping. Recomputed
    -- here so the hourly incremental rebuild agrees with a full one. Only for
    -- hops under 1 km: on a long drive a red light would look like an arrival.
    if _p.source <> 'visit' and _prev_left is not null and _p.captured_at - _prev_left > interval '20 minutes'
       and public.approx_metres(_prev_lat, _prev_lon, _p.lat, _p.lon) <= 1000 then
      if _next_arrival is null then
        select * into _m from public.stay_end_by_motion(_user, _prev_left - interval '2 minutes', _p.captured_at);
        if _m.departed between _prev_left - interval '2 minutes' and _prev_left + interval '2 minutes'
           and _m.next_arrival > _prev_left then
          _next_arrival := _m.next_arrival;
        end if;
      end if;
    else
      _next_arrival := null;
    end if;
    -- start a new candidate here (back-dated to when motion settled, if known)
    _open := true; _first := coalesce(least(_next_arrival, _p.captured_at), _p.captured_at);
    _last := _p.captured_at; _n := 1; _precise := _p.source = 'visit';
    _a_lat := _p.lat; _a_lon := _p.lon; _cells := array[substr(_p.geohash_8, 1, 7)];
  end loop;

  -- the place you're at now (or were last seen): an open stay, if long enough
  if _open and (now() - _first) >= _min_stay then
    insert into visits (user_id, kind, arrived_at, left_at, is_open, geohash_7, ping_count)
    values (_user, 'stay', _first, _last, true,
            (select c from unnest(_cells) c group by c order by count(*) desc limit 1), _n)
    returning id into _new;
    perform public.predict_visit_activity(_new);
    if _prev_stay is not null then
      insert into visits (user_id, kind, arrived_at, left_at, travel_mode, from_visit_id, to_visit_id)
      values (_user, 'travel', _prev_left, _first,
              coalesce(public.travel_mode_for(_user, _prev_left, _first), 'unknown'), _prev_stay, _new);
    end if;
    _made := _made + 1;
  end if;

  -- Interpretations can improve after the fact (a workout synced later, a
  -- place got labelled): refresh the last 2 days' non-user guesses.
  for _c in select id from visits where user_id = _user and kind = 'stay'
              and arrived_at > now() - interval '2 days' and activity_source is distinct from 'user' loop
    perform public.predict_visit_activity(_c.id);
  end loop;
  return _made;
end $$;


--
-- Name: build_visits_all(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.build_visits_all() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare _u uuid; _total int := 0;
begin
  for _u in select distinct user_id from behavioral_pings
             where captured_at > now() - interval '2 days' loop
    _total := _total + public.build_visits(_u);
    perform public.reclassify_moving_stays(_u);
  end loop;
  return _total;
end $$;


--
-- Name: bump_activity_pattern(uuid, text, integer, integer, uuid, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bump_activity_pattern(_user uuid, _key text, _dow integer, _bucket integer, _place uuid, _ts timestamp with time zone) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF _key IS NULL OR _key = '' THEN RETURN; END IF;

  IF _place IS NULL THEN
    INSERT INTO activity_patterns (user_id, activity_key, day_of_week, time_bucket, place_id, count, last_seen)
    VALUES (_user, _key, _dow, _bucket, NULL, 1, _ts)
    ON CONFLICT (user_id, activity_key, day_of_week, time_bucket) WHERE place_id IS NULL
    DO UPDATE SET count = activity_patterns.count + 1,
                  last_seen = greatest(activity_patterns.last_seen, excluded.last_seen),
                  updated_at = now();
  ELSE
    INSERT INTO activity_patterns (user_id, activity_key, day_of_week, time_bucket, place_id, count, last_seen)
    VALUES (_user, _key, _dow, _bucket, _place, 1, _ts)
    ON CONFLICT (user_id, activity_key, day_of_week, time_bucket, place_id) WHERE place_id IS NOT NULL
    DO UPDATE SET count = activity_patterns.count + 1,
                  last_seen = greatest(activity_patterns.last_seen, excluded.last_seen),
                  updated_at = now();
  END IF;

  -- Recompute confidence across the (key, dow, bucket) group.
  UPDATE activity_patterns ap
     SET confidence = ap.count::real / NULLIF(g.total, 0)
    FROM (
      SELECT sum(count) AS total
        FROM activity_patterns
       WHERE user_id = _user AND activity_key = _key
         AND day_of_week = _dow AND time_bucket = _bucket
    ) g
   WHERE ap.user_id = _user AND ap.activity_key = _key
     AND ap.day_of_week = _dow AND ap.time_bucket = _bucket;
END;
$$;


--
-- Name: cancel_hangout(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cancel_hangout(_hangout_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  caller uuid := auth.uid();
  h      public.hangouts%ROWTYPE;
BEGIN
  IF caller IS NULL THEN
    RAISE EXCEPTION 'auth required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO h FROM public.hangouts WHERE id = _hangout_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'hangout not found' USING ERRCODE = '42704';
  END IF;
  IF h.status = 'cancelled' THEN
    RETURN; -- idempotent
  END IF;

  IF h.group_id IS NOT NULL THEN
    -- group hangout: proposer only
    IF h.proposed_by <> caller THEN
      RAISE EXCEPTION 'only the proposer can cancel a group hangout' USING ERRCODE = '42501';
    END IF;
  ELSE
    -- direct hangout: either party
    IF h.proposed_by <> caller AND h.direct_user_id <> caller THEN
      RAISE EXCEPTION 'not a participant in this hangout' USING ERRCODE = '42501';
    END IF;
  END IF;

  UPDATE public.hangouts
     SET status = 'cancelled', updated_at = now()
   WHERE id = _hangout_id;
END;
$$;


--
-- Name: check_activities(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.check_activities() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  _ev record; _tz text; _routine_id uuid; _expected uuid; _exp_home boolean;
  _cat text; _src_kind text; _key text; _dow int; _bucket int;
  _total int; _dom_place uuid; _dom_count int; _act_home boolean;
  _result text; _confirmed text; _pred uuid; _pred_conf real; _done_count int;
  _hw record;
BEGIN
  FOR _ev IN
    SELECT ce.id, ce.user_id, ce.event_type, ce.external_id, ce.start_at, ce.end_at, ce.title, ce.location,
           p.timezone AS tz
      FROM calendar_events ce
      JOIN profiles p ON p.id = ce.user_id
     WHERE ce.event_type IN ('routine','goal','flexible')
       AND coalesce(ce.source,'') IN ('aline','manual','routine')
       AND ce.end_at < now()
       AND ce.end_at > now() - interval '36 hours'
       AND coalesce(p.timezone,'') <> ''
       AND NOT EXISTS (SELECT 1 FROM activity_log al
                        WHERE al.event_id = ce.id
                          AND (al.confirmed_by IS NOT NULL OR al.result <> 'unknown'))
  LOOP
    _tz := _ev.tz; _routine_id := NULL; _expected := NULL; _exp_home := false; _cat := NULL;
    _act_home := false;
    _src_kind := CASE WHEN _ev.event_type = 'routine' THEN 'routine' ELSE 'goal' END;

    IF _ev.event_type = 'routine' THEN
      _routine_id := nullif(split_part(_ev.external_id, ':', 1), '')::uuid;
      SELECT r.place_id, r.category INTO _expected, _cat FROM routines r WHERE r.id = _routine_id;
    END IF;

    _key := lower(trim(coalesce(nullif(_cat,''), _ev.title, 'activity')));
    _dow := extract(dow FROM (_ev.start_at AT TIME ZONE _tz))::int;
    _bucket := floor(extract(hour FROM (_ev.start_at AT TIME ZONE _tz)) / 3)::int;

    IF _expected IS NOT NULL THEN
      SELECT (pl.category='home' OR lower(coalesce(pl.user_label,'')) IN ('home','dom'))
        INTO _exp_home FROM places pl WHERE pl.id = _expected;
    END IF;

    SELECT count(*) INTO _total FROM behavioral_pings bp
     WHERE bp.user_id = _ev.user_id
       AND bp.captured_at BETWEEN _ev.start_at - interval '5 min' AND _ev.end_at + interval '5 min';

    SELECT pl.id, count(*) INTO _dom_place, _dom_count
      FROM behavioral_pings bp
      JOIN places pl ON pl.user_id = _ev.user_id AND substr(bp.geohash_8,1,7) = pl.geohash_7
     WHERE bp.user_id = _ev.user_id
       AND bp.captured_at BETWEEN _ev.start_at - interval '5 min' AND _ev.end_at + interval '5 min'
     GROUP BY pl.id ORDER BY count(*) DESC LIMIT 1;
    IF _dom_place IS NULL OR coalesce(_dom_count,0) < 2 THEN _dom_place := NULL; END IF;
    IF _dom_place IS NOT NULL THEN
      SELECT (pl.category='home' OR lower(coalesce(pl.user_label,'')) IN ('home','dom'))
        INTO _act_home FROM places pl WHERE pl.id = _dom_place;
    END IF;

    -- STRONGEST SIGNAL FIRST: a measured workout overlapping this block.
    SELECT hw.id, hw.activity_type INTO _hw
      FROM health_workouts hw
     WHERE hw.user_id = _ev.user_id
       AND coalesce(hw.duration_min, 0) >= 5
       AND tstzrange(_ev.start_at - interval '45 min', _ev.end_at + interval '45 min')
           && tstzrange(hw.started_at, hw.ended_at)
     ORDER BY abs(extract(epoch FROM (hw.started_at - _ev.start_at)))
     LIMIT 1;

    IF _hw.id IS NOT NULL THEN
      _result := 'done'; _confirmed := 'healthkit';
    ELSIF _total = 0 THEN
      _result := 'unknown'; _confirmed := NULL;
    ELSIF _expected IS NOT NULL AND NOT _exp_home THEN
      IF _dom_place = _expected THEN _result := 'done'; _confirmed := 'auto';
      ELSE _result := 'needs_confirm'; _confirmed := NULL; END IF;
    ELSIF _dom_place IS NOT NULL AND NOT _act_home THEN
      -- Being at a known NON-home place during the block is reasonable evidence.
      _result := 'done'; _confirmed := 'auto';
    ELSE
      -- At home (or nowhere identifiable): presence proves nothing about whether
      -- the session happened. Ask rather than assume.
      _result := 'needs_confirm'; _confirmed := NULL;
    END IF;

    _pred := _expected; _pred_conf := CASE WHEN _expected IS NOT NULL THEN 0.8 ELSE NULL END;
    IF _pred IS NULL THEN
      SELECT place_id, confidence INTO _pred, _pred_conf FROM activity_patterns
       WHERE user_id=_ev.user_id AND activity_key=_key AND day_of_week=_dow AND time_bucket=_bucket
       ORDER BY confidence DESC NULLS LAST LIMIT 1;
    END IF;

    INSERT INTO activity_log
      (user_id, event_id, source_kind, source_id, place_id, expected_category,
       scheduled_start, scheduled_end, result, confirmed_by,
       predicted_place_id, prediction_confidence, actual_place_id)
    VALUES
      (_ev.user_id, _ev.id, _src_kind, _routine_id, _expected, _cat,
       _ev.start_at, _ev.end_at, _result, _confirmed,
       _pred, _pred_conf, _dom_place)
    ON CONFLICT (event_id) DO UPDATE
      SET result = excluded.result, confirmed_by = excluded.confirmed_by,
          predicted_place_id = excluded.predicted_place_id,
          prediction_confidence = excluded.prediction_confidence,
          actual_place_id = coalesce(excluded.actual_place_id, activity_log.actual_place_id),
          checked_at = now()
      WHERE activity_log.confirmed_by IS DISTINCT FROM 'user';

    IF _result = 'done' THEN
      PERFORM public.bump_activity_pattern(_ev.user_id, _key, _dow, _bucket, _dom_place, _ev.end_at);
      IF _hw.id IS NOT NULL THEN
        UPDATE calendar_events SET health_workout_id = _hw.id
          WHERE id = _ev.id AND health_workout_id IS NULL;
        UPDATE health_workouts SET matched_event_id = _ev.id, match_kind = 'planned',
               reconciled_at = coalesce(reconciled_at, now())
         WHERE id = _hw.id AND matched_event_id IS NULL;
      END IF;
      IF _routine_id IS NOT NULL THEN
        UPDATE routines SET last_observed = _ev.end_at, updated_at = now() WHERE id = _routine_id;
        SELECT count(*) INTO _done_count FROM activity_log WHERE source_id = _routine_id AND result = 'done';
        IF _done_count >= 3 THEN
          UPDATE routines SET inference_status = 'confirmed', updated_at = now()
            WHERE id = _routine_id AND inference_status = 'pending';
        END IF;
      END IF;
    END IF;
  END LOOP;
END;
$$;


--
-- Name: commit_goal_plan(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.commit_goal_plan(_goal_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare _uid uuid := auth.uid(); _plan_id uuid; _res jsonb;
begin
  if _uid is null then raise exception 'must be authenticated'; end if;
  select id into _plan_id from goal_plans
   where goal_id = _goal_id and user_id = _uid and status <> 'archived'
   order by updated_at desc limit 1;
  if _plan_id is null then raise exception 'no plan for that goal'; end if;

  delete from calendar_events
   where user_id = _uid and goal_plan_id = _plan_id and start_at > now();
  update goal_plans set status = 'live', committed_at = now(), updated_at = now()
   where id = _plan_id;

  _res := public._materialize_goal_plan(_plan_id);
  return jsonb_build_object('plan_id', _plan_id,
                            'created', (_res->>'created')::int,
                            'skipped', (_res->>'skipped')::int);
end;
$$;


--
-- Name: create_group(text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_group(_name text, _description text DEFAULT NULL::text, _group_type text DEFAULT 'friends'::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  _user_id uuid := auth.uid();
  _group_id uuid;
begin
  if _user_id is null then
    raise exception 'Not authenticated';
  end if;

  if _name is null or length(trim(_name)) = 0 then
    raise exception 'Group name required';
  end if;

  insert into public.groups (name, description, created_by, group_type)
  values (trim(_name), nullif(trim(coalesce(_description, '')), ''), _user_id, _group_type)
  returning id into _group_id;

  insert into public.group_members (group_id, user_id, role, trust_tier)
  values (_group_id, _user_id, 'admin', 'friends');

  return _group_id;
end;
$$;


--
-- Name: detect_goal_time_drift(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.detect_goal_time_drift() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
declare
  _p record; _sess jsonb; _tz text;
  _act text; _pmin int; _pdur int;
  _n int; _drift_n int; _spread int; _to_min int; _to_dur int; _med_dur int;
  _ev jsonb; _sid uuid; _body text; _posted int := 0;
begin
  for _p in
    select gp.id, gp.user_id, gp.goal_id, gp.plan_spec, coalesce(nullif(pr.timezone,''),'UTC') tz
      from goal_plans gp join profiles pr on pr.id = gp.user_id
     where gp.status = 'live' and jsonb_typeof(gp.plan_spec->'sessions') = 'array'
  loop
    _tz := _p.tz;
    for _sess in select jsonb_array_elements(_p.plan_spec->'sessions') loop
      _act := _sess->>'activity';
      continue when _act is null or _sess->>'start' is null;
      _pmin := split_part(_sess->>'start', ':', 1)::int * 60 + split_part(_sess->>'start', ':', 2)::int;
      _pdur := coalesce(nullif(_sess->>'duration_min','')::int, 45);

      continue when exists (select 1 from schedule_suggestions s
                             where s.goal_plan_id = _p.id and s.session_activity = _act and s.status = 'pending');

      with recent as (
        select hw.started_at, hw.duration_min,
               (extract(hour from hw.started_at at time zone _tz) * 60
                + extract(minute from hw.started_at at time zone _tz))::int as m
          from health_workouts hw
          join calendar_events ce on ce.id = hw.matched_event_id
         where hw.user_id = _p.user_id and ce.goal_plan_id = _p.id and ce.title = _act
           and hw.duration_min between 5 and 360
           and hw.started_at >= coalesce((select value::timestamptz from app_config where key = 'reliable_data_since'), '-infinity')
         order by hw.started_at desc
         limit 4),
      drifted as (select * from recent where abs(m - _pmin) >= 90)
      select (select count(*) from recent),
             (select count(*) from drifted),
             (select coalesce(max(m) - min(m), 0) from drifted),
             (select (round(percentile_cont(0.5) within group (order by m) / 15.0) * 15)::int from drifted),
             (select (round(percentile_cont(0.5) within group (order by duration_min) / 5.0) * 5)::int from recent),
             (select jsonb_agg(jsonb_build_object('start', started_at, 'min', duration_min)) from recent)
        into _n, _drift_n, _spread, _to_min, _med_dur, _ev;

      continue when _n < 3;
      if _drift_n >= 3 and _spread <= 120 then
        null; -- time drift: _to_min set
      else
        _to_min := _pmin; -- no time drift
      end if;
      _to_dur := case when abs(coalesce(_med_dur, _pdur) - _pdur) >= 15 then _med_dur else _pdur end;
      continue when _to_min = _pmin and _to_dur = _pdur;

      continue when exists (select 1 from schedule_suggestions s
                             where s.goal_plan_id = _p.id and s.session_activity = _act
                               and s.to_start = public._hhmm(_to_min) and s.to_duration = _to_dur
                               and s.status = 'declined' and s.resolved_at > now() - interval '30 days');

      insert into schedule_suggestions (user_id, goal_plan_id, goal_id, session_activity,
                                        from_start, to_start, from_duration, to_duration, evidence)
      values (_p.user_id, _p.id, _p.goal_id, _act,
              public._hhmm(_pmin), public._hhmm(_to_min), _pdur, _to_dur, _ev)
      returning id into _sid;

      _body := case
        when _to_min <> _pmin then format(
          'Your last %s %s sessions were around %s, not the planned %s%s. Want me to move future sessions to %s–%s?',
          _drift_n, regexp_replace(_act, '\s*\([^)]*\)\s*$', ''), public._hhmm(_to_min), public._hhmm(_pmin),
          case when _to_dur <> _pdur then format(' (and took about %s min)', _to_dur) else '' end,
          public._hhmm(_to_min), public._hhmm((_to_min + _to_dur) % 1440))
        else format(
          'Your %s sessions usually take about %s min, not the planned %s. Want me to plan them as %s–%s?',
          regexp_replace(_act, '\s*\([^)]*\)\s*$', ''), _to_dur, _pdur,
          public._hhmm(_pmin), public._hhmm((_pmin + _to_dur) % 1440)) end;

      if public.try_proactive_push(_p.user_id, 'schedule_suggestion', 'sched:' || _sid::text,
                                   'Adjust your plan?', _body,
                                   jsonb_build_object('suggestion_id', _sid)) then
        _posted := _posted + 1;
      else
        delete from schedule_suggestions where id = _sid; -- quiet hours / cap: retry next run
      end if;
    end loop;
  end loop;
  return _posted;
end;
$_$;


--
-- Name: disconnect_google_calendar(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.disconnect_google_calendar() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  delete from public.google_oauth_tokens where user_id = auth.uid();
  -- Also drop the synced events to avoid orphaned data shown after disconnect
  delete from public.calendar_events where user_id = auth.uid() and source = 'google';
end;
$$;


--
-- Name: evaluate_active_blocks(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.evaluate_active_blocks() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  _ev         record;
  _tz         text;
  _routine_id uuid;
  _expected   uuid;
  _exp_home   boolean;
  _cat        text;
  _src_kind   text;
  _key        text;
  _dow        int;
  _bucket     int;
  _recent     int;
  _dom        uuid;
  _dom_home   boolean;
  _status     text;
BEGIN
  FOR _ev IN
    SELECT ce.id, ce.user_id, ce.event_type, ce.external_id, ce.start_at, ce.end_at, ce.title,
           p.timezone AS tz
      FROM calendar_events ce
      JOIN profiles p ON p.id = ce.user_id
     WHERE ce.event_type IN ('routine','goal','flexible')
       AND coalesce(ce.source,'') IN ('aline','manual','routine')
       AND now() >= ce.start_at AND now() <= ce.end_at
       AND coalesce(p.timezone,'') <> ''
  LOOP
    _tz := _ev.tz; _routine_id := NULL; _expected := NULL; _exp_home := false; _cat := NULL;
    _src_kind := CASE WHEN _ev.event_type = 'routine' THEN 'routine' ELSE 'goal' END;

    IF _ev.event_type = 'routine' THEN
      _routine_id := nullif(split_part(_ev.external_id, ':', 1), '')::uuid;
      SELECT r.place_id, r.category INTO _expected, _cat FROM routines r WHERE r.id = _routine_id;
    END IF;

    _key := lower(trim(coalesce(nullif(_cat,''), _ev.title, 'activity')));
    _dow := extract(dow FROM (_ev.start_at AT TIME ZONE _tz))::int;
    _bucket := floor(extract(hour FROM (_ev.start_at AT TIME ZONE _tz)) / 3)::int;

    IF _expected IS NULL THEN
      SELECT place_id INTO _expected FROM activity_patterns
       WHERE user_id=_ev.user_id AND activity_key=_key AND day_of_week=_dow AND time_bucket=_bucket
       ORDER BY confidence DESC NULLS LAST LIMIT 1;
    END IF;
    IF _expected IS NOT NULL THEN
      SELECT (pl.category='home' OR lower(coalesce(pl.user_label,'')) IN ('home','dom'))
        INTO _exp_home FROM places pl WHERE pl.id = _expected;
    END IF;

    SELECT count(*) INTO _recent FROM behavioral_pings bp
     WHERE bp.user_id=_ev.user_id AND bp.captured_at > now() - interval '20 min';
    SELECT pl.id INTO _dom
      FROM behavioral_pings bp
      JOIN places pl ON pl.user_id=_ev.user_id AND substr(bp.geohash_8,1,7)=pl.geohash_7
     WHERE bp.user_id=_ev.user_id AND bp.captured_at > now() - interval '20 min'
     GROUP BY pl.id ORDER BY count(*) DESC LIMIT 1;
    IF _dom IS NOT NULL THEN
      SELECT (pl.category='home' OR lower(coalesce(pl.user_label,'')) IN ('home','dom'))
        INTO _dom_home FROM places pl WHERE pl.id = _dom;
    END IF;

    IF _recent = 0 THEN _status := 'unknown';
    ELSIF _expected IS NOT NULL THEN
      IF _dom = _expected THEN _status := 'on_track';
      ELSIF _dom_home AND NOT _exp_home THEN _status := 'likely_skip';
      ELSIF _dom IS NULL THEN _status := 'late_incoming';
      ELSE _status := 'unknown_location';
      END IF;
    ELSE
      _status := CASE WHEN _dom IS NULL THEN 'unknown_location' ELSE 'on_track' END;
    END IF;

    INSERT INTO activity_log
      (user_id, event_id, source_kind, source_id, place_id, expected_category,
       scheduled_start, scheduled_end, result, live_status, actual_place_id, evaluated_at)
    VALUES
      (_ev.user_id, _ev.id, _src_kind, _routine_id, _expected, _cat,
       _ev.start_at, _ev.end_at, 'unknown', _status, _dom, now())
    ON CONFLICT (event_id) DO UPDATE
      SET live_status = excluded.live_status,
          actual_place_id = coalesce(excluded.actual_place_id, activity_log.actual_place_id),
          evaluated_at = now();

    -- Speak up (guarded: quiet hours, daily cap, once per event+status).
    IF coalesce((select value from app_config where key = 'live_status_pushes'), 'off') <> 'on' THEN
      NULL;  -- paused (see app_config live_status_pushes)
    ELSIF _status = 'likely_skip' THEN
      PERFORM public.try_proactive_push(
        _ev.user_id, 'live_status', 'live:' || _ev.id || ':skip',
        'ALINE',
        'Looks like you might be missing "' || coalesce(_ev.title,'your activity') ||
        '". Want me to reschedule it? Just open the chat.',
        jsonb_build_object('type','live_status','event_id',_ev.id,'status',_status));
    ELSIF _status = 'late_incoming' THEN
      PERFORM public.try_proactive_push(
        _ev.user_id, 'live_status', 'live:' || _ev.id || ':late',
        'ALINE',
        'Running late for "' || coalesce(_ev.title,'your activity') ||
        '"? I can shift your later blocks — just say the word.',
        jsonb_build_object('type','live_status','event_id',_ev.id,'status',_status));
    END IF;
  END LOOP;
END;
$$;


--
-- Name: expire_stale_change_sets(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.expire_stale_change_sets() RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  UPDATE public.change_sets
     SET status = 'expired', updated_at = now()
   WHERE status = 'pending' AND expires_at < now();
$$;


--
-- Name: expire_stale_hangouts(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.expire_stale_hangouts() RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  UPDATE public.hangouts
     SET status = 'expired', updated_at = now()
   WHERE status = 'proposing'
     AND proposed_start IS NOT NULL
     AND proposed_start < now();
$$;


--
-- Name: find_mutual_slots(uuid[], timestamp with time zone, timestamp with time zone, integer, text, integer, integer, integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.find_mutual_slots(_user_ids uuid[], _earliest timestamp with time zone, _latest timestamp with time zone, _duration_minutes integer DEFAULT 60, _time_preference text DEFAULT 'any'::text, _max_results integer DEFAULT 5, _earliest_hour integer DEFAULT 8, _latest_hour integer DEFAULT 22, _min_free_count integer DEFAULT NULL::integer) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  caller       uuid := auth.uid();
  caller_tz    text;
  uid          uuid;
  user_ids     uuid[] := _user_ids;
  total_count  int;
  effective_min int;
  slot_start   timestamptz;
  slot_end     timestamptz;
  duration_iv  interval := make_interval(mins => _duration_minutes);
  step_iv      interval := '30 minutes'::interval;
  hour_local   int;
  end_hour_local numeric;
  caller_busy  boolean;
  busy_others  uuid[];
  free_count   int;
  result       jsonb := '[]'::jsonb;
  score        numeric;
  slot_count   int := 0;
  caller_habit text;
  soft_others  int;
BEGIN
  IF caller IS NULL THEN
    RAISE EXCEPTION 'auth required' USING ERRCODE = '42501';
  END IF;

  FOREACH uid IN ARRAY user_ids LOOP
    IF uid = caller THEN CONTINUE; END IF;
    IF NOT (
      public.are_friends(caller, uid)
      OR EXISTS (
        SELECT 1 FROM public.group_members gm1
        JOIN public.group_members gm2 ON gm1.group_id = gm2.group_id
        WHERE gm1.user_id = caller AND gm2.user_id = uid
      )
    ) THEN
      RAISE EXCEPTION 'not authorized to find slots with user %', uid
        USING ERRCODE = '42501';
    END IF;
  END LOOP;

  IF NOT caller = ANY(user_ids) THEN
    user_ids := array_append(user_ids, caller);
  END IF;
  total_count := array_length(user_ids, 1);

  effective_min := COALESCE(_min_free_count, total_count);
  IF effective_min < 1 THEN effective_min := 1; END IF;
  IF effective_min > total_count THEN effective_min := total_count; END IF;

  SELECT timezone INTO caller_tz FROM public.profiles WHERE id = caller;
  IF caller_tz IS NULL OR caller_tz = '' THEN caller_tz := 'UTC'; END IF;

  slot_start := _earliest;
  WHILE slot_start + duration_iv <= _latest AND slot_count < _max_results LOOP
    slot_end := slot_start + duration_iv;
    hour_local := EXTRACT(HOUR FROM slot_start AT TIME ZONE caller_tz)::int;
    end_hour_local := hour_local + (_duration_minutes::numeric / 60.0);

    IF hour_local >= _earliest_hour AND end_hour_local <= _latest_hour THEN
      SELECT EXISTS (
        SELECT 1 FROM public.calendar_events
        WHERE user_id = caller AND start_at < slot_end AND end_at > slot_start
      ) INTO caller_busy;

      IF NOT caller_busy THEN
        SELECT COALESCE(array_agg(DISTINCT user_id), ARRAY[]::uuid[])
        INTO busy_others
        FROM public.calendar_events
        WHERE user_id = ANY(user_ids) AND user_id <> caller
          AND start_at < slot_end AND end_at > slot_start;

        free_count := total_count - COALESCE(array_length(busy_others, 1), 0);

        IF free_count >= effective_min THEN
          score := CASE
            WHEN _time_preference = 'morning'   THEN CASE WHEN hour_local BETWEEN 7 AND 11 THEN 1.0 ELSE 0.4 END
            WHEN _time_preference = 'afternoon' THEN CASE WHEN hour_local BETWEEN 12 AND 16 THEN 1.0 ELSE 0.4 END
            WHEN _time_preference = 'evening'   THEN CASE WHEN hour_local BETWEEN 17 AND 21 THEN 1.0 ELSE 0.4 END
            ELSE 0.7
          END;
          score := score * (free_count::numeric / total_count::numeric);

          -- SOFT BUSY: what the caller habitually does in this slot, learned
          -- from verified activity (workouts included) rather than the calendar.
          SELECT ap.activity_key INTO caller_habit
            FROM public.activity_patterns ap
           WHERE ap.user_id = caller
             AND ap.day_of_week = EXTRACT(DOW FROM slot_start AT TIME ZONE caller_tz)::int
             AND ap.time_bucket = floor(EXTRACT(HOUR FROM slot_start AT TIME ZONE caller_tz) / 3)::int
             AND ap.count >= 3
             AND COALESCE(ap.confidence, 0) >= 0.4
           ORDER BY ap.confidence DESC NULLS LAST
           LIMIT 1;

          -- Other participants' habits: counted, never named.
          SELECT count(DISTINCT ap.user_id) INTO soft_others
            FROM public.activity_patterns ap
            JOIN public.profiles pr ON pr.id = ap.user_id
           WHERE ap.user_id = ANY(user_ids)
             AND ap.user_id <> caller
             AND NOT (ap.user_id = ANY(busy_others))
             AND ap.day_of_week = EXTRACT(DOW FROM slot_start AT TIME ZONE COALESCE(NULLIF(pr.timezone,''),'UTC'))::int
             AND ap.time_bucket = floor(EXTRACT(HOUR FROM slot_start AT TIME ZONE COALESCE(NULLIF(pr.timezone,''),'UTC')) / 3)::int
             AND ap.count >= 3
             AND COALESCE(ap.confidence, 0) >= 0.4;

          IF caller_habit IS NOT NULL THEN score := score * 0.6; END IF;
          IF COALESCE(soft_others,0) > 0 THEN
            score := score * (1 - least(0.4, 0.2 * soft_others));
          END IF;

          result := result || jsonb_build_array(jsonb_build_object(
            'start_at',        slot_start,
            'end_at',          slot_end,
            'score',           score,
            'free_count',      free_count,
            'total_count',     total_count,
            'busy_user_ids',   busy_others,
            'your_habit',      caller_habit,
            'soft_busy_count', COALESCE(soft_others, 0)
          ));
          slot_count := slot_count + 1;
        END IF;
      END IF;
    END IF;

    slot_start := slot_start + step_iv;
  END LOOP;

  RETURN result;
END;
$$;


--
-- Name: find_user_by_handle(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.find_user_by_handle(_handle text) RETURNS TABLE(id uuid, handle text, first_name text, display_name text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select id, handle, first_name, display_name
  from public.profiles
  where handle = lower(trim(_handle))
  limit 1;
$$;


--
-- Name: friend_tier_to(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.friend_tier_to(_viewer uuid, _owner uuid) RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select case when _owner < _viewer then f.tier_a else f.tier_b end
    from public.friendships f
   where f.status = 'accepted'
     and f.user_a = least(_owner, _viewer)
     and f.user_b = greatest(_owner, _viewer);
$$;


--
-- Name: geohash_center(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.geohash_center(_gh text, OUT lat double precision, OUT lon double precision) RETURNS record
    LANGUAGE plpgsql IMMUTABLE
    AS $$
declare
  b32 text := '0123456789bcdefghjkmnpqrstuvwxyz';
  lat_lo double precision := -90; lat_hi double precision := 90;
  lon_lo double precision := -180; lon_hi double precision := 180;
  even boolean := true; i int; v int; bit int; mid double precision;
begin
  for i in 1..length(_gh) loop
    v := position(substr(_gh, i, 1) in b32) - 1;
    if v < 0 then exit; end if;
    for bit in reverse 4..0 loop
      if even then
        mid := (lon_lo + lon_hi) / 2;
        if (v >> bit) & 1 = 1 then lon_lo := mid; else lon_hi := mid; end if;
      else
        mid := (lat_lo + lat_hi) / 2;
        if (v >> bit) & 1 = 1 then lat_lo := mid; else lat_hi := mid; end if;
      end if;
      even := not even;
    end loop;
  end loop;
  lat := (lat_lo + lat_hi) / 2; lon := (lon_lo + lon_hi) / 2;
end;
$$;


--
-- Name: get_friend_schedule(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_friend_schedule(_friend_id uuid) RETURNS TABLE(title text, start_at timestamp with time zone, end_at timestamp with time zone, location text, event_type text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select ce.title, ce.start_at, ce.end_at, ce.location, ce.event_type
    from public.calendar_events ce
   where ce.user_id = _friend_id
     and ce.start_at >= now() - interval '6 hours'
     and ce.start_at <  now() + interval '14 days'
     and coalesce(ce.event_type,'') <> 'transit'
     and public.friend_tier_to(auth.uid(), _friend_id) = 'inner'
   order by ce.start_at
   limit 60;
$$;


--
-- Name: get_hangout_details(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_hangout_details(_hangout_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  _h public.hangouts;
  _caller uuid := auth.uid();
begin
  if not public.is_hangout_participant(_hangout_id) then
    return null;
  end if;
  select * into _h from public.hangouts where id = _hangout_id;
  return jsonb_build_object(
    'id', _h.id,
    'title', _h.title,
    'description', _h.description,
    'reasoning', _h.reasoning,
    'status', _h.status,
    'proposed_start', _h.proposed_start,
    'proposed_end', _h.proposed_end,
    'venue_name', _h.venue_name,
    'venue_address', _h.venue_address,
    'venue_lat', _h.venue_lat,
    'venue_lng', _h.venue_lng,
    'min_attendees', _h.min_attendees,
    'group_id', _h.group_id,
    'group_name', (select name from groups where id = _h.group_id),
    'proposed_by', _h.proposed_by,
    'invite_policy', _h.invite_policy,
    'is_host', _h.proposed_by = _caller,
    'can_invite', public._hangout_can_invite(_h, _caller),
    'participants', coalesce((
      select jsonb_agg(jsonb_build_object(
        'user_id', r.user_id,
        'status', r.status,
        'first_name', p.first_name,
        'display_name', p.display_name,
        'handle', p.handle
      ) order by (r.user_id = _h.proposed_by) desc, r.status, p.first_name)
      from hangout_responses r join profiles p on p.id = r.user_id
      where r.hangout_id = _h.id
    ), '[]'::jsonb)
  );
end;
$$;


--
-- Name: get_participant_feasibility_context(uuid, uuid[], timestamp with time zone, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_participant_feasibility_context(_requester uuid, _participant_ids uuid[], _slot_start timestamp with time zone, _slot_end timestamp with time zone) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  _out jsonb := '[]'::jsonb;
  _p uuid;
  _is_ok boolean;
  _ghash text;
  _home_lat double precision;
  _home_lon double precision;
  _win_start timestamptz;
  _win_end timestamptz;
  _next_start timestamptz;
  _fname text;
  _tz text;
  _habit_end timestamptz;
  _habit_start timestamptz;
  _soft_bounded boolean;
  _habit_conflict boolean;
begin
  foreach _p in array _participant_ids loop
    _is_ok := (_p = _requester) or exists (
      select 1 from friendships f
      where f.status = 'accepted'
        and ((f.user_a = _requester and f.user_b = _p)
          or (f.user_b = _requester and f.user_a = _p))
    );
    if not _is_ok then continue; end if;

    _soft_bounded := false;
    _habit_conflict := false;
    _habit_end := null;
    _habit_start := null;

    select first_name into _fname from profiles where id = _p;
    select coalesce(nullif(timezone, ''), 'UTC') into _tz from profiles where id = _p;
    _tz := coalesce(_tz, 'UTC');

    select geohash_8 into _ghash
      from behavioral_pings where user_id = _p
      order by captured_at desc limit 1;

    select centroid_lat, centroid_lon into _home_lat, _home_lon
      from places
      where user_id = _p and centroid_lat is not null
        and (category = 'home' or lower(coalesce(user_label,'')) in ('home','dom'))
      limit 1;

    -- Hard bounds from the calendar (unchanged).
    select max(end_at) into _win_start
      from calendar_events
      where user_id = _p and end_at <= _slot_start and end_at >= _slot_start - interval '6 hours';
    if _win_start is null then _win_start := _slot_start - interval '6 hours'; end if;

    select min(start_at) into _next_start
      from calendar_events
      where user_id = _p and start_at >= _slot_end and start_at <= _slot_end + interval '6 hours';
    _win_end := coalesce(_next_start, _slot_end + interval '6 hours');

    -- SOFT bound: the soonest habitual 3h block starting at/after the slot.
    select min(q.cand) into _habit_end
      from (
        select ((date_trunc('day', (_slot_end at time zone _tz))
                 + make_interval(hours => ap.time_bucket * 3)) at time zone _tz) as cand
          from activity_patterns ap
         where ap.user_id = _p
           and ap.count >= 3
           and coalesce(ap.confidence, 0) >= 0.4
           and ap.day_of_week = extract(dow from (_slot_end at time zone _tz))::int
      ) q
     where q.cand >= _slot_end;

    if _habit_end is not null and _habit_end < _win_end then
      _win_end := _habit_end;
      _soft_bounded := true;
    end if;

    -- SOFT bound: the latest habitual block ending at/before the slot starts.
    select max(q.cand) into _habit_start
      from (
        select ((date_trunc('day', (_slot_start at time zone _tz))
                 + make_interval(hours => ap.time_bucket * 3 + 3)) at time zone _tz) as cand
          from activity_patterns ap
         where ap.user_id = _p
           and ap.count >= 3
           and coalesce(ap.confidence, 0) >= 0.4
           and ap.day_of_week = extract(dow from (_slot_start at time zone _tz))::int
      ) q
     where q.cand <= _slot_start;

    if _habit_start is not null and _habit_start > _win_start then
      _win_start := _habit_start;
      _soft_bounded := true;
    end if;

    -- Do they habitually do something DURING the proposed slot itself?
    select exists (
      select 1 from activity_patterns ap
       where ap.user_id = _p
         and ap.count >= 3
         and coalesce(ap.confidence, 0) >= 0.4
         and ap.day_of_week = extract(dow from (_slot_start at time zone _tz))::int
         and ap.time_bucket = floor(extract(hour from (_slot_start at time zone _tz)) / 3)::int
    ) into _habit_conflict;

    -- Degenerate guard: a habit either side can invert the window.
    if _win_end <= _win_start then
      _win_start := least(_win_start, _slot_start);
      _win_end := greatest(_win_end, _slot_end);
    end if;

    _out := _out || jsonb_build_object(
      'user_id', _p,
      'first_name', _fname,
      'ping_geohash', _ghash,
      'home_lat', _home_lat,
      'home_lon', _home_lon,
      'window_start', _win_start,
      'window_end', _win_end,
      'next_activity_start', _next_start,
      'soft_bounded', _soft_bounded,
      'habit_conflict', _habit_conflict
    );
  end loop;
  return _out;
end $$;


--
-- Name: google_calendar_status(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.google_calendar_status() RETURNS TABLE(connected boolean, last_synced_at timestamp with time zone, last_sync_error text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select
    true as connected,
    last_synced_at,
    last_sync_error
  from public.google_oauth_tokens
  where user_id = auth.uid()
  union all
  select false, null::timestamptz, null::text
  where not exists (
    select 1 from public.google_oauth_tokens where user_id = auth.uid()
  )
  limit 1;
$$;


--
-- Name: handle_new_user(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.handle_new_user() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  insert into public.profiles (id, display_name, first_name)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email,'@',1)),
    coalesce(new.raw_user_meta_data->>'first_name', split_part(new.email,'@',1))
  )
  on conflict (id) do nothing;
  return new;
end;
$$;


--
-- Name: hangout_invite_candidates(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.hangout_invite_candidates(_hangout_id uuid) RETURNS TABLE(user_id uuid, first_name text, handle text, allowed boolean, reason text)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  _caller uuid := auth.uid();
  _h public.hangouts;
begin
  select * into _h from public.hangouts where id = _hangout_id;
  if not found or not public.is_hangout_participant(_hangout_id) then
    return;
  end if;
  return query
    select p.id, p.first_name, p.handle,
           public._hangout_invite_block_reason(_h, _caller, p.id) is null,
           public._hangout_invite_block_reason(_h, _caller, p.id)
    from friendships f
    join profiles p on p.id = case when f.user_a = _caller then f.user_b else f.user_a end
    where f.status = 'accepted' and _caller in (f.user_a, f.user_b)
      and not exists (select 1 from hangout_responses r where r.hangout_id = _hangout_id and r.user_id = p.id)
    order by p.first_name;
end;
$$;


--
-- Name: hangout_participants_for(uuid[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.hangout_participants_for(_hangout_ids uuid[]) RETURNS TABLE(hangout_id uuid, user_id uuid, status text, first_name text, handle text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT r.hangout_id, r.user_id, r.status, p.first_name, p.handle
  FROM hangout_responses r JOIN profiles p ON p.id = r.user_id
  WHERE r.hangout_id = ANY(_hangout_ids) AND public.is_hangout_participant(r.hangout_id);
$$;


--
-- Name: interest_is_gated(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.interest_is_gated(_key text, _source text) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    AS $$
  select coalesce(_source, 'chat') = 'chat'
     and _key in ('activity_like','activity_dislike','time_preference','venue_preference',
                  'social_preference','group_preference','other')
$$;


--
-- Name: interest_subject(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.interest_subject(_v jsonb) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
  select lower(trim(coalesce(
    case when jsonb_typeof(_v) = 'string' then _v #>> '{}' end,
    _v->>'activity', _v->>'label', _v->>'time', _v->>'detail', _v->>'context', _v::text)))
$$;


--
-- Name: interests_accumulate(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.interests_accumulate() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  _day date := (now() at time zone coalesce(nullif((select timezone from profiles where id = NEW.user_id), ''), 'UTC'))::date;
  _id uuid;
  _shown_key boolean := NEW.key in ('activity_like','activity_dislike','time_preference','venue_preference',
                                    'social_preference','group_preference');
begin
  NEW.evidence_days := array[_day];

  -- Hint-only notes from chat: never shown, just skip exact duplicates.
  if coalesce(NEW.source, 'chat') = 'chat' and NEW.key in ('other','mood','life_event') then
    NEW.stated := false;
    perform 1 from interests
     where user_id = NEW.user_id and key = NEW.key and value = NEW.value;
    if found then return null; end if;
    NEW.active := false;
    return NEW;
  end if;

  -- Goal notes: only skip an exact duplicate — matching by subject could
  -- merge notes of different goals.
  if not public.interest_is_gated(NEW.key, NEW.source) then
    update interests set updated_at = now()
     where user_id = NEW.user_id and key = NEW.key and value = NEW.value and active;
    if found then return null; end if;
    return NEW;
  end if;

  -- Preferences: a repeat mention on another day adds evidence and may promote.
  select id into _id from interests
   where user_id = NEW.user_id and key = NEW.key
     and public.interest_subject(value) = public.interest_subject(NEW.value)
   order by active desc, created_at limit 1;
  if _id is not null then
    update interests set
      evidence_days = (select array_agg(distinct d order by d) from unnest(evidence_days || _day) d),
      stated = stated or (_shown_key and coalesce(NEW.stated, false)),
      active = _shown_key and (active or coalesce(NEW.stated, false)
               or cardinality(array(select distinct d from unnest(evidence_days || _day) d)) >= 2),
      updated_at = now()
     where id = _id;
    return null;
  end if;

  NEW.active := _shown_key and coalesce(NEW.stated, false);
  return NEW;
end $$;


--
-- Name: interests_skip_exact_duplicate(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.interests_skip_exact_duplicate() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  UPDATE interests
     SET updated_at = now()
   WHERE user_id = NEW.user_id
     AND key = NEW.key
     AND value = NEW.value
     AND active;
  IF FOUND THEN
    RETURN NULL; -- existing identical row refreshed; skip the insert
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: invite_to_hangout(uuid, uuid[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.invite_to_hangout(_hangout_id uuid, _user_ids uuid[]) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  _caller uuid := auth.uid();
  _h public.hangouts;
  _invitee uuid;
  _added uuid[] := '{}';
  _name text;
  _tz text;
begin
  if _caller is null then
    raise exception 'Not authenticated';
  end if;
  select * into _h from public.hangouts where id = _hangout_id;
  if not found then
    raise exception 'Hangout not found';
  end if;
  if not public._hangout_can_invite(_h, _caller) then
    raise exception 'You can''t invite people to this plan';
  end if;

  foreach _invitee in array coalesce(_user_ids, '{}') loop
    if _invitee is null or _invitee = _caller then continue; end if;
    if public._hangout_invite_block_reason(_h, _caller, _invitee) is not null then continue; end if;
    insert into public.hangout_responses (hangout_id, user_id, status)
    values (_hangout_id, _invitee, 'pending')
    on conflict (hangout_id, user_id) do nothing;
    if found then _added := _added || _invitee; end if;
  end loop;

  if array_length(_added, 1) > 0 then
    select coalesce(first_name, display_name, 'A friend'), coalesce(timezone, 'UTC')
      into _name, _tz from public.profiles where id = _caller;
    perform public.send_push_to_users(
      _added,
      _name || ' invited you to ' || coalesce(_h.title, 'a plan'),
      coalesce(to_char(_h.proposed_start at time zone _tz, 'Dy HH24:MI'), 'Time TBD')
        || coalesce(' · ' || _h.venue_name, ''),
      jsonb_build_object('type', 'hangout_proposed', 'hangout_id', _h.id)
    );
  end if;
  return coalesce(array_length(_added, 1), 0);
end;
$$;


--
-- Name: invoke_google_calendar_sync(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.invoke_google_calendar_sync() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE _secret text;
BEGIN
  SELECT value INTO _secret FROM app_config WHERE key = 'cron_secret';
  PERFORM net.http_post(
    url := 'https://etsyyjwulqrbnogwjifh.supabase.co/functions/v1/google-calendar-sync-cron',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-key', _secret),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
END;
$$;


--
-- Name: invoke_health_probe(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.invoke_health_probe() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare _secret text;
begin
  select value into _secret from app_config where key = 'cron_secret';
  perform net.http_post(
    url := 'https://etsyyjwulqrbnogwjifh.supabase.co/functions/v1/health-probe',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-key', _secret),
    body := '{}'::jsonb, timeout_milliseconds := 60000);
end $$;


--
-- Name: invoke_name_stays(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.invoke_name_stays() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare _secret text;
begin
  select value into _secret from app_config where key = 'cron_secret';
  perform net.http_post(
    url := 'https://etsyyjwulqrbnogwjifh.supabase.co/functions/v1/name-stays',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-key', _secret),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000);
end $$;


--
-- Name: invoke_proactive_weather(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.invoke_proactive_weather() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE _secret text;
BEGIN
  SELECT value INTO _secret FROM app_config WHERE key = 'cron_secret';
  PERFORM net.http_post(
    url := 'https://etsyyjwulqrbnogwjifh.supabase.co/functions/v1/proactive-weather',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-key', _secret),
    body := '{}'::jsonb
  );
END;
$$;


--
-- Name: invoke_rebuild_summaries(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.invoke_rebuild_summaries() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare _secret text;
begin
  select value into _secret from app_config where key = 'cron_secret';
  perform net.http_post(
    url := 'https://etsyyjwulqrbnogwjifh.supabase.co/functions/v1/rebuild-summaries',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-key', _secret),
    body := '{}'::jsonb, timeout_milliseconds := 120000);
end $$;


--
-- Name: invoke_resolve_places(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.invoke_resolve_places() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare _secret text;
begin
  -- only when there's something to name (skips the call otherwise)
  if not exists (select 1 from places where google_place_id is null) then return; end if;
  select value into _secret from app_config where key = 'cron_secret';
  perform net.http_post(
    url := 'https://etsyyjwulqrbnogwjifh.supabase.co/functions/v1/resolve-places',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-key', _secret),
    body := '{}'::jsonb, timeout_milliseconds := 120000);
end $$;


--
-- Name: is_group_admin(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_group_admin(_group_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select exists (
    select 1
    from public.group_members
    where group_id = _group_id
      and user_id = auth.uid()
      and role = 'admin'
  );
$$;


--
-- Name: is_group_member(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_group_member(_group_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select exists (
    select 1
    from public.group_members
    where group_id = _group_id
      and user_id = auth.uid()
  );
$$;


--
-- Name: is_hangout_participant(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_hangout_participant(_hangout_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT EXISTS (SELECT 1 FROM hangout_responses r WHERE r.hangout_id = _hangout_id AND r.user_id = auth.uid())
      OR EXISTS (
        SELECT 1 FROM hangouts h
        WHERE h.id = _hangout_id
          AND ((h.group_id IS NOT NULL AND is_group_member(h.group_id))
            OR (h.direct_user_id IS NOT NULL AND auth.uid() IN (h.proposed_by, h.direct_user_id)))
      );
$$;


--
-- Name: learned_duration_min(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.learned_duration_min(_user uuid, _activity_type text) RETURNS integer
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  WITH recent AS (
    SELECT duration_min FROM health_workouts
     WHERE user_id = _user AND activity_type = _activity_type
       AND duration_min BETWEEN 5 AND 360
       AND started_at >= coalesce((SELECT value::timestamptz FROM app_config WHERE key = 'reliable_data_since'), '-infinity')
     ORDER BY started_at DESC LIMIT 10)
  SELECT CASE WHEN count(*) >= 3
              THEN round(percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_min))::int END
    FROM recent;
$$;


--
-- Name: log_agent_message(uuid, text, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.log_agent_message(_user uuid, _content text, _kind text, _data jsonb DEFAULT '{}'::jsonb) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare _id uuid;
begin
  insert into chat_messages (user_id, role, content, extracted_data)
  values (
    _user, 'agent', _content,
    jsonb_build_object('proactive', true, 'kind', _kind) || coalesce(_data, '{}'::jsonb)
  )
  returning id into _id;
  return _id;
exception when others then
  raise notice 'log_agent_message failed silently: %', sqlerrm;
  return null;
end $$;


--
-- Name: mark_curiosity_asked(text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mark_curiosity_asked(_kind text, _id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if _kind = 'place' then
    update public.places
    set last_asked_at = now()
    where id = _id and user_id = auth.uid();
  elsif _kind = 'routine' then
    update public.routines
    set last_asked_at = now()
    where id = _id and user_id = auth.uid();
  end if;
end;
$$;


--
-- Name: mark_goal_done(uuid, date, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mark_goal_done(_goal_id uuid, _date date DEFAULT NULL::date, _at timestamp with time zone DEFAULT NULL::timestamp with time zone) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  _uid uuid := auth.uid();
  _tz text;
  _ev record;
  _log_id uuid;
  _dur int;
begin
  if _uid is null then raise exception 'must be authenticated'; end if;
  if not exists (select 1 from goals where id = _goal_id and user_id = _uid) then
    raise exception 'no such goal';
  end if;
  select coalesce(timezone,'UTC') into _tz from profiles where id = _uid;

  if _at is not null then
    select ce.id, ce.start_at, ce.end_at into _ev
      from calendar_events ce
     where ce.user_id = _uid and ce.goal_id = _goal_id and ce.event_type = 'goal'
       and (ce.start_at at time zone _tz)::date = (_at at time zone _tz)::date
       and not exists (select 1 from activity_log al where al.event_id = ce.id and al.result = 'done')
     order by abs(extract(epoch from (ce.start_at - _at)))
     limit 1;
    if _ev.id is null then
      return jsonb_build_object('marked', false, 'reason', 'no unfinished session of that goal on that day');
    end if;
    -- Keep the session's own length (the plan's, or learned via the plan).
    _dur := greatest(5, round(extract(epoch from (_ev.end_at - _ev.start_at)) / 60)::int);
    perform public._move_goal_block_to_actual(_uid, _ev.id, _at, _at + make_interval(mins => _dur), 'user', null);
    return jsonb_build_object('marked', true, 'moved_from', _ev.start_at, 'session_start', _at);
  end if;

  select ce.id, ce.start_at, ce.end_at into _ev
    from calendar_events ce
   where ce.user_id = _uid and ce.goal_id = _goal_id and ce.event_type = 'goal'
     and ce.start_at < now()
     and (_date is null or (ce.start_at at time zone _tz)::date = _date)
     and not exists (select 1 from activity_log al where al.event_id = ce.id and al.result = 'done')
   order by ce.start_at desc
   limit 1;

  if _ev.id is null then
    return jsonb_build_object('marked', false, 'reason', 'no matching past session to mark');
  end if;

  select id into _log_id from activity_log where event_id = _ev.id and user_id = _uid limit 1;
  if _log_id is not null then
    update activity_log
       set result = 'done', confirmed_by = 'user', checked_at = now(), last_asked_at = now()
     where id = _log_id;
  else
    insert into activity_log (user_id, event_id, result, confirmed_by,
                              scheduled_start, scheduled_end, source_kind, checked_at)
    values (_uid, _ev.id, 'done', 'user', _ev.start_at, _ev.end_at, 'goal', now());
  end if;

  update goals set last_completed_at = now() where id = _goal_id and user_id = _uid;
  return jsonb_build_object('marked', true, 'session_start', _ev.start_at);
end;
$$;


--
-- Name: materialize_goal_plans(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.materialize_goal_plans() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare _p record;
begin
  for _p in select id from goal_plans where status = 'live' loop
    perform public._materialize_goal_plan(_p.id);
  end loop;
end;
$$;


--
-- Name: materialize_routines(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.materialize_routines() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  _r          record;
  _d          int;
  _local_date date;
  _start_ts   timestamptz;
  _end_ts     timestamptz;
  _pre        int;
  _post       int;
  _is_home    boolean;
  _place_name text;
  _ext        text;
BEGIN
  DELETE FROM calendar_events WHERE source = 'routine';

  FOR _r IN
    SELECT ro.id, ro.user_id, ro.category, ro.day_of_week,
           ro.start_minute, ro.end_minute,
           p.timezone,
           pl.category AS place_category, pl.user_label, pl.name AS place_name
      FROM routines ro
      JOIN profiles p ON p.id = ro.user_id
      LEFT JOIN places pl ON pl.id = ro.place_id
     WHERE ro.active
       AND ro.consistency >= 0.65
       AND ro.start_minute IS NOT NULL
       AND ro.end_minute   IS NOT NULL
       AND ro.day_of_week  IS NOT NULL
       AND coalesce(p.timezone, '') <> ''
  LOOP
    _is_home := (_r.place_category = 'home')
                OR (lower(coalesce(_r.user_label, '')) = 'home');
    -- Being home is not a commitment: it blocks nothing, so it doesn't go on
    -- the calendar (it made people look busy to find_mutual_slots and drew
    -- "did you do Home?" checks). The routine itself stays in `routines` as
    -- location knowledge — where they'll probably be — for planning.
    CONTINUE WHEN _is_home;
    -- Walks/runs/rides are habits, not commitments: known to the agent, but
    -- they don't make you look busy.
    CONTINUE WHEN _r.place_category IS NULL AND _r.category IN ('walk', 'run', 'ride');

    _place_name := coalesce(nullif(_r.user_label, ''), _r.place_name,
                            initcap(coalesce(_r.category, 'Routine')));

    IF _is_home THEN
      _pre := 0; _post := 0;
    ELSE
      CASE _r.category
        WHEN 'gym'       THEN _pre := 25; _post := 30;
        WHEN 'education' THEN _pre := 20; _post := 10;
        WHEN 'work'      THEN _pre := 25; _post := 10;
        WHEN 'food'      THEN _pre := 20; _post := 20;
        WHEN 'social'    THEN _pre := 20; _post := 20;
        WHEN 'shopping'  THEN _pre := 15; _post := 10;
        WHEN 'outdoors'  THEN _pre := 15; _post := 10;
        ELSE                  _pre := 15; _post := 15;
      END CASE;
    END IF;

    FOR _d IN 0..13 LOOP
      _local_date := ((now() AT TIME ZONE _r.timezone)::date + _d);
      CONTINUE WHEN extract(dow FROM _local_date)::int <> _r.day_of_week;

      _start_ts := (_local_date + (_r.start_minute || ' minutes')::interval) AT TIME ZONE _r.timezone;
      _end_ts   := (_local_date + (_r.end_minute   || ' minutes')::interval) AT TIME ZONE _r.timezone;

      CONTINUE WHEN _start_ts < now();

      -- Yield to ANY real (non-routine-sourced) event, incl. the transit envelope.
      IF EXISTS (
        SELECT 1 FROM calendar_events ce
         WHERE ce.user_id = _r.user_id
           AND coalesce(ce.source, 'manual') <> 'routine'
           AND ce.start_at < _end_ts + (_post || ' minutes')::interval
           AND ce.end_at   > _start_ts - (_pre || ' minutes')::interval
      ) THEN
        CONTINUE;
      END IF;

      _ext := _r.id::text || ':' || to_char(_local_date, 'YYYY-MM-DD');

      INSERT INTO calendar_events
        (user_id, title, start_at, end_at, event_type, is_movable, location, source, external_id)
      VALUES
        (_r.user_id, _place_name, _start_ts, _end_ts, 'routine', true, _r.place_name, 'routine', _ext)
      ON CONFLICT (user_id, source, external_id) DO UPDATE
        SET title = excluded.title, start_at = excluded.start_at, end_at = excluded.end_at,
            event_type = excluded.event_type, location = excluded.location, updated_at = now();

      IF NOT _is_home THEN
        INSERT INTO calendar_events
          (user_id, title, start_at, end_at, event_type, is_movable, location, source, external_id)
        VALUES
          (_r.user_id, 'Transit', _start_ts - (_pre || ' minutes')::interval, _start_ts,
           'transit', true, '→ ' || _place_name, 'routine', _ext || ':pre')
        ON CONFLICT (user_id, source, external_id) DO UPDATE
          SET start_at = excluded.start_at, end_at = excluded.end_at, updated_at = now();

        INSERT INTO calendar_events
          (user_id, title, start_at, end_at, event_type, is_movable, location, source, external_id)
        VALUES
          (_r.user_id, 'Transit', _end_ts, _end_ts + (_post || ' minutes')::interval,
           'transit', true, _place_name || ' →', 'routine', _ext || ':post')
        ON CONFLICT (user_id, source, external_id) DO UPDATE
          SET start_at = excluded.start_at, end_at = excluded.end_at, updated_at = now();
      END IF;
    END LOOP;
  END LOOP;
END;
$$;


--
-- Name: next_curiosity_item(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.next_curiosity_item() RETURNS TABLE(kind text, id uuid, payload jsonb)
    LANGUAGE sql STABLE
    AS $$
  SELECT NULL::text, NULL::uuid, NULL::jsonb WHERE false;
$$;


--
-- Name: norm_event_title(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.norm_event_title(_t text) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $_$
  select nullif(lower(trim(regexp_replace(coalesce(_t, ''), '\s*\([^)]*\)\s*$', ''))), '')
$_$;


--
-- Name: notify_friendship_accepted(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_friendship_accepted() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  _accepter_name text;
  _accepter_handle text;
  _accepter_id uuid;
BEGIN
  -- Only on transition pending → accepted
  IF OLD.status = 'accepted' OR NEW.status <> 'accepted' THEN
    RETURN NEW;
  END IF;

  -- The "accepter" is the one who is NOT requested_by.
  _accepter_id := CASE
    WHEN NEW.requested_by = NEW.user_a THEN NEW.user_b
    ELSE NEW.user_a
  END;

  SELECT first_name, handle INTO _accepter_name, _accepter_handle
  FROM public.profiles WHERE id = _accepter_id;

  PERFORM public.send_push_to_users(
    ARRAY[NEW.requested_by],
    COALESCE(_accepter_name, '@' || COALESCE(_accepter_handle, 'someone')) || ' accepted your friend request',
    'You are friends now.',
    jsonb_build_object('type', 'friend_accepted', 'from_user_id', _accepter_id)
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'notify_friendship_accepted failed silently: %', sqlerrm;
  RETURN NEW;
END;
$$;


--
-- Name: notify_friendship_requested(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_friendship_requested() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  _requester_name text;
  _requester_handle text;
  _receiver uuid;
BEGIN
  IF NEW.status <> 'pending' THEN
    RETURN NEW;
  END IF;

  -- The "receiver" is whichever side is NOT the requester.
  _receiver := CASE
    WHEN NEW.requested_by = NEW.user_a THEN NEW.user_b
    ELSE NEW.user_a
  END;

  SELECT first_name, handle INTO _requester_name, _requester_handle
  FROM public.profiles WHERE id = NEW.requested_by;

  PERFORM public.send_push_to_users(
    ARRAY[_receiver],
    COALESCE(_requester_name, '@' || COALESCE(_requester_handle, 'someone')) || ' wants to be friends',
    'Tap to accept or decline.',
    jsonb_build_object('type', 'friend_request', 'from_user_id', NEW.requested_by)
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'notify_friendship_requested failed silently: %', sqlerrm;
  RETURN NEW;
END;
$$;


--
-- Name: notify_hangout_cancelled(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_hangout_cancelled() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  _target_ids uuid[];
BEGIN
  IF OLD.status = 'cancelled' OR NEW.status <> 'cancelled' THEN
    RETURN NEW;
  END IF;

  SELECT array_agg(user_id) INTO _target_ids
  FROM public.hangout_responses
  WHERE hangout_id = NEW.id;

  IF _target_ids IS NULL OR array_length(_target_ids, 1) IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM public.send_push_to_users(
    _target_ids,
    '"' || NEW.title || '" was cancelled',
    'No need to show up.',
    jsonb_build_object('type', 'hangout_cancelled', 'hangout_id', NEW.id)
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'notify_hangout_cancelled failed silently: %', sqlerrm;
  RETURN NEW;
END;
$$;


--
-- Name: notify_hangout_confirmed(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_hangout_confirmed() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  _target_ids uuid[];
  _tz text;
BEGIN
  IF OLD.status = 'confirmed' OR NEW.status <> 'confirmed' THEN
    RETURN NEW;
  END IF;
  SELECT array_agg(user_id) INTO _target_ids
  FROM public.hangout_responses
  WHERE hangout_id = NEW.id AND status = 'confirmed';
  IF _target_ids IS NULL OR array_length(_target_ids, 1) IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT coalesce(timezone, 'UTC') INTO _tz FROM public.profiles WHERE id = NEW.proposed_by;

  PERFORM public.send_push_to_users(
    _target_ids,
    '"' || NEW.title || '" is on!',
    COALESCE('Confirmed for ' || to_char(NEW.proposed_start AT TIME ZONE coalesce(_tz, 'UTC'), 'Dy HH24:MI'), 'See the plan for details.'),
    jsonb_build_object('type', 'hangout_confirmed', 'hangout_id', NEW.id)
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'notify_hangout_confirmed failed silently: %', sqlerrm;
  RETURN NEW;
END;
$$;


--
-- Name: notify_hangout_proposed(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_hangout_proposed() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  _proposer_name text;
  _tz text;
  _target_ids uuid[];
BEGIN
  SELECT first_name, coalesce(timezone, 'UTC') INTO _proposer_name, _tz
  FROM public.profiles WHERE id = NEW.proposed_by;

  IF NEW.group_id IS NOT NULL THEN
    SELECT array_agg(user_id) INTO _target_ids
    FROM public.group_members
    WHERE group_id = NEW.group_id AND user_id <> NEW.proposed_by;
  ELSIF NEW.direct_user_id IS NOT NULL THEN
    _target_ids := ARRAY[NEW.direct_user_id];
  END IF;
  IF _target_ids IS NULL OR array_length(_target_ids, 1) IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM public.send_push_to_users(
    _target_ids,
    COALESCE(_proposer_name, 'A friend') || ' proposed ' || NEW.title,
    COALESCE(to_char(NEW.proposed_start AT TIME ZONE coalesce(_tz, 'UTC'), 'Dy HH24:MI'), 'soon')
      || COALESCE(' · ' || NEW.venue_name, ''),
    jsonb_build_object('type', 'hangout_proposed', 'hangout_id', NEW.id)
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'notify_hangout_proposed failed silently: %', sqlerrm;
  RETURN NEW;
END;
$$;


--
-- Name: people_together_summary(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.people_together_summary() RETURNS TABLE(other_user_id uuid, last_met timestamp with time zone, times_met integer, next_plan_at timestamp with time zone)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  with mine as (
    select r.hangout_id
    from hangout_responses r
    where r.user_id = auth.uid()
  ),
  pairs as (
    select o.user_id as other,
           h.proposed_start,
           coalesce(h.proposed_end, h.proposed_start + interval '1 hour') as ends,
           h.status as hstatus,
           me.status as my_status,
           o.status as their_status
    from mine m
    join hangouts h on h.id = m.hangout_id
    join hangout_responses me on me.hangout_id = h.id and me.user_id = auth.uid()
    join hangout_responses o on o.hangout_id = h.id and o.user_id <> auth.uid()
    where h.proposed_start is not null
  )
  select other,
         max(proposed_start) filter (
           where hstatus in ('confirmed', 'completed') and ends < now()
             and my_status = 'confirmed' and their_status = 'confirmed'),
         (count(*) filter (
           where hstatus in ('confirmed', 'completed') and ends < now()
             and my_status = 'confirmed' and their_status = 'confirmed'))::int,
         min(proposed_start) filter (
           where hstatus in ('proposing', 'confirmed') and proposed_start > now()
             and coalesce(my_status, 'pending') <> 'declined'
             and coalesce(their_status, 'pending') <> 'declined')
  from pairs
  group by other;
$$;


--
-- Name: post_curiosity_questions(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.post_curiosity_questions() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  _u record;
  _it record;
  _tz text;
  _local timestamp;
  _day text;
  _hm text;
  _body text;
  _maps text;
  _dow text[] := array['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  _posted int := 0;
begin
  for _u in select id, timezone tz from profiles where coalesce(timezone, '') <> '' loop
    _tz := _u.tz;
    -- one question a day
    if exists (
      select 1 from proactive_pushes
      where user_id = _u.id and kind = 'curiosity'
        and sent_at >= (date_trunc('day', now() at time zone _tz) at time zone _tz)
    ) then continue; end if;

    select * into _it from public._next_curiosity_item(_u.id) limit 1;
    if not found or _it.id is null then continue; end if;

    if _it.kind = 'activity' then
      _local := (_it.payload->>'scheduled_start')::timestamptz at time zone _tz;
      _day := case
        when _local::date = (now() at time zone _tz)::date then 'earlier today'
        when _local::date = (now() at time zone _tz)::date - 1 then 'yesterday'
        else 'on ' || _dow[extract(dow from _local)::int + 1] end;
      _hm := to_char(_local, 'HH24:MI');
      _body := case _it.payload->>'ambiguity'
        when 'home' then format('Did you do your %s at home %s at %s? Asking because you were home and nothing showed up in Apple Health, so I can''t tell — and your weekly pace depends on it.', _it.payload->>'label', _day, _hm)
        when 'skipped' then format('It looks like you missed %s %s at %s — did you skip it, or do it somewhere else?', _it.payload->>'label', _day, _hm)
        else format('Did you get your %s in %s at %s? Asking because nothing showed up in Apple Health and your weekly pace depends on it.', _it.payload->>'label', _day, _hm) end;
    elsif _it.kind = 'place' then
      _maps := case when _it.payload->>'lat' is not null
        then ' https://maps.google.com/?q=' || (_it.payload->>'lat') || ',' || (_it.payload->>'lon') else '' end;
      _body := case when _it.payload->>'name' is not null
        then format('Quick one: is the place you''ve been %s times %s? Asking so I can plan around it correctly — just say yes, or tell me what it really is.%s',
                    _it.payload->>'visit_count', _it.payload->>'name', _maps)
        else format('You''ve been to the same spot %s times — what is it? (home, work, gym, a friend''s…) Knowing it lets me plan around it.%s',
                    _it.payload->>'visit_count', _maps) end;
    else
      _body := format('I''ve noticed you''re usually at %s on %ss, %s–%s. Is that a regular thing I should plan around?',
        _it.payload->>'place_name',
        _dow[coalesce((_it.payload->>'day_of_week')::int, 0) + 1],
        lpad(((_it.payload->>'start_minute')::int / 60)::text, 2, '0') || ':' || lpad(((_it.payload->>'start_minute')::int % 60)::text, 2, '0'),
        lpad(((_it.payload->>'end_minute')::int / 60)::text, 2, '0') || ':' || lpad(((_it.payload->>'end_minute')::int % 60)::text, 2, '0'));
    end if;

    if public.try_proactive_push(
         _u.id, 'curiosity', 'curiosity:' || _it.kind || ':' || _it.id::text,
         'Quick question', _body,
         jsonb_build_object('curiosity_kind', _it.kind, 'curiosity_id', _it.id)) then
      -- Asked: don't re-ask this item for 30 days (the picker's snooze window).
      if _it.kind = 'activity' then update activity_log set last_asked_at = now() where id = _it.id;
      elsif _it.kind = 'place' then update places set last_asked_at = now() where id = _it.id;
      else update routines set last_asked_at = now() where id = _it.id; end if;
      _posted := _posted + 1;
    end if;
  end loop;
  return _posted;
end;
$$;


--
-- Name: predict_visit_activity(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.predict_visit_activity(_visit_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v visits; _hw record; _ev record; _ro record; _pl record;
  _overlap_min double precision;
begin
  select * into v from visits where id = _visit_id;
  if not found or v.kind <> 'stay' or v.activity_source = 'user' then return; end if;

  -- place: a known place in the stay's cell
  if v.place_id is null and v.geohash_7 is not null then
    update visits set place_id = (
      select p.id from places p, public.geohash_center(v.geohash_7) g
       where p.user_id = v.user_id and not p.is_hidden and p.centroid_lat is not null
         and public.approx_metres(p.centroid_lat, p.centroid_lon, g.lat, g.lon) <= 150
       order by public.approx_metres(p.centroid_lat, p.centroid_lon, g.lat, g.lon) limit 1)
    where id = v.id;
    select * into v from visits where id = _visit_id;
  end if;

  -- 1) measured workout overlapping the stay
  select hw.id, hw.activity_type into _hw from health_workouts hw
   where hw.user_id = v.user_id and hw.duration_min >= 5
     and tstzrange(hw.started_at, hw.ended_at) && tstzrange(v.arrived_at, coalesce(v.left_by, v.left_at) + interval '5 min')
     and extract(epoch from (least(hw.ended_at, coalesce(v.left_by, v.left_at)) - greatest(hw.started_at, v.arrived_at)))
         >= 0.5 * greatest(extract(epoch from (v.left_at - v.arrived_at)), 60)
   order by hw.started_at limit 1;
  if _hw.id is not null then
    update visits set activity = _hw.activity_type, activity_source = 'healthkit', activity_confidence = 1,
           health_workout_id = _hw.id, updated_at = now() where id = v.id;
    return;
  end if;

  -- 2) a real calendar block covering most of the stay
  select ce.id, ce.title into _ev from calendar_events ce
   where ce.user_id = v.user_id and coalesce(ce.event_type,'') not in ('routine','transit')
     and ce.start_at < v.left_at and ce.end_at > v.arrived_at
     and extract(epoch from (least(ce.end_at, v.left_at) - greatest(ce.start_at, v.arrived_at)))
         >= 0.5 * greatest(extract(epoch from (v.left_at - v.arrived_at)), 60)
   order by ce.start_at limit 1;
  if _ev.id is not null then
    update visits set activity = _ev.title, activity_source = 'calendar', activity_confidence = 0.7,
           event_id = _ev.id, updated_at = now() where id = v.id;
    return;
  end if;

  -- 3) a learned routine at this place at this time
  if v.place_id is not null then
    select r.category into _ro from routines r join profiles p on p.id = r.user_id
     where r.user_id = v.user_id and r.place_id = v.place_id and r.active
       and r.day_of_week = extract(dow from v.arrived_at at time zone coalesce(p.timezone,'UTC'))::int
     limit 1;
    if _ro.category is not null then
      update visits set activity = _ro.category, activity_source = 'routine', activity_confidence = 0.6,
             updated_at = now() where id = v.id;
      return;
    end if;

    -- 4) what the place is
    select coalesce(nullif(user_label,''), name) label, category into _pl from places where id = v.place_id;
    update visits set activity = case
        when _pl.category = 'home' or lower(coalesce(_pl.label,'')) in ('home','dom') then 'at home'
        when _pl.category = 'work' then 'work'
        when _pl.category = 'gym' then 'workout'
        when _pl.category = 'education' then 'studying'
        when _pl.category = 'food' then 'eating out'
        when _pl.category = 'social' then 'social'
        when _pl.category = 'shopping' then 'shopping'
        else coalesce(_pl.label, _pl.category) end,
      activity_source = 'place', activity_confidence = 0.5, updated_at = now()
     where id = v.id;
  end if;

  -- 5) not at a known place: the looked-up name for this spot, as a guess
  if v.place_id is null then
    update visits set activity = public.stay_name_near(v.user_id, c.lat, c.lon),
           activity_source = 'place', activity_confidence = 0.4, updated_at = now()
      from public.stay_centroid(v.user_id, v.arrived_at, v.left_at) c
     where visits.id = v.id and public.stay_name_near(v.user_id, c.lat, c.lon) is not null;
  end if;
end;
$$;


--
-- Name: propose_direct_hangout(uuid, text, timestamp with time zone, text, text, timestamp with time zone, text, text, numeric); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.propose_direct_hangout(_direct_user_id uuid, _title text, _proposed_start timestamp with time zone, _reasoning text, _description text DEFAULT NULL::text, _proposed_end timestamp with time zone DEFAULT NULL::timestamp with time zone, _venue_name text DEFAULT NULL::text, _venue_address text DEFAULT NULL::text, _confidence numeric DEFAULT 0.75) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  caller       uuid := auth.uid();
  new_id       uuid;
BEGIN
  IF caller IS NULL THEN
    RAISE EXCEPTION 'auth required' USING ERRCODE = '42501';
  END IF;
  IF _direct_user_id = caller THEN
    RAISE EXCEPTION 'cannot propose a direct hangout with yourself' USING ERRCODE = '22023';
  END IF;
  IF NOT public.are_friends(caller, _direct_user_id) THEN
    RAISE EXCEPTION 'not friends with that user' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.hangouts (
    group_id, direct_user_id, proposed_by, title, description, status,
    proposed_start, proposed_end, venue_name, venue_address, reasoning,
    confidence, min_attendees
  ) VALUES (
    NULL, _direct_user_id, caller, _title, _description, 'proposing',
    _proposed_start, _proposed_end, _venue_name, _venue_address, _reasoning,
    _confidence, 2
  )
  RETURNING id INTO new_id;

  -- Proposer auto-confirms; target starts pending.
  INSERT INTO public.hangout_responses (hangout_id, user_id, status)
    VALUES (new_id, caller, 'confirmed'),
           (new_id, _direct_user_id, 'pending');

  RETURN new_id;
END;
$$;


--
-- Name: propose_hangout(uuid, text, timestamp with time zone, text, text, timestamp with time zone, text, text, numeric); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.propose_hangout(_group_id uuid, _title text, _proposed_start timestamp with time zone, _reasoning text, _description text DEFAULT NULL::text, _proposed_end timestamp with time zone DEFAULT NULL::timestamp with time zone, _venue_name text DEFAULT NULL::text, _venue_address text DEFAULT NULL::text, _confidence numeric DEFAULT 0.75) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  _user_id uuid := auth.uid();
  _hangout_id uuid;
  _end timestamptz := coalesce(_proposed_end, _proposed_start + interval '2 hours');
begin
  if _user_id is null then
    raise exception 'Not authenticated';
  end if;

  if _title is null or length(trim(_title)) = 0 then
    raise exception 'Title required';
  end if;

  if not exists (
    select 1 from public.group_members
    where group_id = _group_id and user_id = _user_id
  ) then
    raise exception 'Not a member of this group';
  end if;

  insert into public.hangouts (
    group_id, proposed_by, title, description,
    proposed_start, proposed_end,
    venue_name, venue_address,
    reasoning, confidence,
    status
  )
  values (
    _group_id, _user_id, trim(_title), nullif(trim(coalesce(_description, '')), ''),
    _proposed_start, _end,
    nullif(trim(coalesce(_venue_name, '')), ''),
    nullif(trim(coalesce(_venue_address, '')), ''),
    _reasoning, _confidence,
    'proposing'
  )
  returning id into _hangout_id;

  -- Pre-populate per-member response rows. Proposer is auto-confirmed.
  insert into public.hangout_responses (hangout_id, user_id, status, responded_at)
  select
    _hangout_id,
    gm.user_id,
    case when gm.user_id = _user_id then 'confirmed' else 'pending' end,
    case when gm.user_id = _user_id then now() else null end
  from public.group_members gm
  where gm.group_id = _group_id;

  return _hangout_id;
end;
$$;


--
-- Name: propose_hangout(uuid, text, timestamp with time zone, text, text, timestamp with time zone, text, text, numeric, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.propose_hangout(_group_id uuid, _title text, _proposed_start timestamp with time zone, _reasoning text, _description text DEFAULT NULL::text, _proposed_end timestamp with time zone DEFAULT NULL::timestamp with time zone, _venue_name text DEFAULT NULL::text, _venue_address text DEFAULT NULL::text, _confidence numeric DEFAULT 0.75, _min_attendees integer DEFAULT NULL::integer) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  _user_id uuid := auth.uid();
  _hangout_id uuid;
  _end timestamptz := coalesce(_proposed_end, _proposed_start + interval '2 hours');
  _group_size integer;
  _threshold integer;
begin
  if _user_id is null then
    raise exception 'Not authenticated';
  end if;

  if _title is null or length(trim(_title)) = 0 then
    raise exception 'Title required';
  end if;

  if not exists (
    select 1 from public.group_members
    where group_id = _group_id and user_id = _user_id
  ) then
    raise exception 'Not a member of this group';
  end if;

  -- Compute threshold default if not provided.
  --   1-3 members: needs everyone
  --   4-6 members: half + 1 (e.g. 4 → 3, 5 → 3, 6 → 4)
  --   7+ members: half (e.g. 8 → 4, 10 → 5), min 4
  select count(*) into _group_size from public.group_members where group_id = _group_id;

  _threshold := coalesce(_min_attendees,
    case
      when _group_size <= 3 then _group_size
      when _group_size <= 6 then ceil(_group_size::numeric / 2.0 + 1)::integer
      else greatest(4, ceil(_group_size::numeric / 2.0)::integer)
    end
  );
  -- clamp to [1, group_size]
  _threshold := least(greatest(_threshold, 1), _group_size);

  insert into public.hangouts (
    group_id, proposed_by, title, description,
    proposed_start, proposed_end,
    venue_name, venue_address,
    reasoning, confidence,
    min_attendees,
    status
  )
  values (
    _group_id, _user_id, trim(_title), nullif(trim(coalesce(_description, '')), ''),
    _proposed_start, _end,
    nullif(trim(coalesce(_venue_name, '')), ''),
    nullif(trim(coalesce(_venue_address, '')), ''),
    _reasoning, _confidence,
    _threshold,
    'proposing'
  )
  returning id into _hangout_id;

  insert into public.hangout_responses (hangout_id, user_id, status, responded_at)
  select
    _hangout_id,
    gm.user_id,
    case when gm.user_id = _user_id then 'confirmed' else 'pending' end,
    case when gm.user_id = _user_id then now() else null end
  from public.group_members gm
  where gm.group_id = _group_id;

  -- If proposer alone meets the threshold (e.g. 1-person group), auto-confirm.
  if 1 >= _threshold then
    update public.hangouts set status = 'confirmed' where id = _hangout_id;
  end if;

  return _hangout_id;
end;
$$;


--
-- Name: purge_old_chat(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.purge_old_chat() RETURNS integer
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  with d as (delete from chat_messages where created_at < now() - interval '30 days' returning 1)
  select count(*)::int from d;
$$;


--
-- Name: push_goal_pacing(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.push_goal_pacing() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
declare
  _u record; _g record; _week text;
begin
  for _u in
    select p.id, p.timezone as tz from profiles p
     where coalesce(p.timezone,'') <> ''
       -- a week of trusted data first: "1/6 done" from incomplete data is nagging
       and now() >= greatest(p.created_at,
             coalesce((select value::timestamptz from app_config where key = 'reliable_data_since'), '-infinity'))
           + interval '7 days'
       and extract(dow  from (now() at time zone p.timezone))::int = 4
       and extract(hour from (now() at time zone p.timezone))::int = 17
  loop
    -- Pick this user's single most-behind goal for the week. Prefer a LIVE plan's
    -- cadence as the target; fall back to the goal's target_per_week. Done-count is
    -- now per-goal via calendar_events.goal_id (linked at commit time).
    select g.id, g.title, _target.target, coalesce(_done.done,0) as done,
           (_target.target - coalesce(_done.done,0)) as shortfall,
           (gp.id is not null) as has_live_plan
      into _g
      from goals g
      left join lateral (
        select coalesce(
          (select (gp2.plan_spec->>'cadence_per_week')::int
             from goal_plans gp2
            where gp2.goal_id = g.id and gp2.status = 'live'
              and (gp2.plan_spec->>'cadence_per_week') ~ '^[0-9]+$'
            limit 1),
          g.target_per_week::int
        ) as target
      ) _target on true
      left join lateral (
        select count(*)::int as done
          from activity_log al
          join calendar_events ce on ce.id = al.event_id
         where al.user_id = _u.id and al.result = 'done'
           and ce.event_type = 'goal' and ce.goal_id = g.id
           and al.scheduled_start >= date_trunc('week', now() at time zone _u.tz) at time zone _u.tz
      ) _done on true
      left join goal_plans gp on gp.goal_id = g.id and gp.status = 'live'
     where g.user_id = _u.id and g.status = 'active'
       and coalesce(_target.target,0) > 0
       and (_target.target - coalesce(_done.done,0)) > 0
       -- one session a day at most: if Fri–Sun can't fit it, a push only nags
       and (_target.target - coalesce(_done.done,0)) <= 3
     order by shortfall desc, has_live_plan desc
     limit 1;

    continue when _g.id is null;

    _week := to_char(now() at time zone _u.tz, 'IYYY-IW');
    perform public.try_proactive_push(
      _u.id, 'goal_pacing', 'goalpace:' || _g.id || ':' || _week,
      'This week: ' || _g.title,
      _g.done || ' of ' || _g.target || ' "' || _g.title || '" sessions done so far. ' ||
        'Want me to fit the other ' || _g.shortfall || ' into Fri–Sun?',
      jsonb_build_object('type','goal_pacing','goal_id',_g.id));
  end loop;
end;
$_$;


--
-- Name: push_hangout_soon(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.push_hangout_soon() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE _r record;
BEGIN
  FOR _r IN
    SELECT h.id, h.title, h.venue_name, h.proposed_start, hr.user_id, p.timezone AS tz
      FROM hangouts h
      JOIN hangout_responses hr ON hr.hangout_id = h.id AND hr.status = 'confirmed'
      JOIN profiles p ON p.id = hr.user_id
     WHERE h.status = 'confirmed'
       AND h.proposed_start BETWEEN now() + interval '50 min' AND now() + interval '70 min'
  LOOP
    PERFORM public.try_proactive_push(
      _r.user_id, 'hangout_soon', 'hsoon:' || _r.id,
      coalesce(_r.title,'Hangout') || ' in about an hour',
      to_char(_r.proposed_start AT TIME ZONE _r.tz, 'HH24:MI') ||
        coalesce(' at ' || _r.venue_name, '') || '. See you there.',
      jsonb_build_object('type','hangout_soon','hangout_id',_r.id));
  END LOOP;
END;
$$;


--
-- Name: push_leave_by(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.push_leave_by() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE _r record;
BEGIN
  FOR _r IN
    SELECT ce.id, ce.user_id, ce.end_at AS activity_start, ce.location, p.timezone AS tz
      FROM calendar_events ce
      JOIN profiles p ON p.id = ce.user_id
     WHERE ce.event_type = 'transit' AND ce.source = 'routine'
       AND ce.external_id LIKE '%:pre'
       AND ce.start_at BETWEEN now() - interval '1 min' AND now() + interval '5 min'
  LOOP
    PERFORM public.try_proactive_push(
      _r.user_id, 'leave_by', 'leaveby:' || _r.id,
      'Time to head out',
      'Leave now to make ' ||
        to_char(_r.activity_start AT TIME ZONE _r.tz, 'HH24:MI') || ' at ' ||
        replace(coalesce(_r.location, 'your next stop'), '→ ', '') || '.',
      jsonb_build_object('type','leave_by','event_id',_r.id));
  END LOOP;
END;
$$;


--
-- Name: push_rsvp_nudges(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.push_rsvp_nudges() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE _r record;
BEGIN
  FOR _r IN
    SELECT h.id, h.title, h.proposed_start, hr.user_id, p.timezone AS tz
      FROM hangouts h
      JOIN hangout_responses hr ON hr.hangout_id = h.id AND hr.status = 'pending'
      JOIN profiles p ON p.id = hr.user_id
     WHERE h.status IN ('proposing','confirmed')
       AND h.proposed_start BETWEEN now() + interval '6 hours' AND now() + interval '3 days'
  LOOP
    PERFORM public.try_proactive_push(
      _r.user_id, 'rsvp_nudge', 'rsvp:' || _r.id,
      'Still deciding?',
      '"' || coalesce(_r.title,'A hangout') || '" is on ' ||
        to_char(_r.proposed_start AT TIME ZONE _r.tz, 'Dy "at" HH24:MI') ||
        ' and you have not answered yet. In or out?',
      jsonb_build_object('type','rsvp_nudge','hangout_id',_r.id));
  END LOOP;
END;
$$;


--
-- Name: push_workout_start(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.push_workout_start() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  _r record;
begin
  for _r in
    select ce.id as event_id, ce.user_id as user_id, ce.title as title
      from calendar_events ce
      join profiles p on p.id = ce.user_id
     where ce.event_type = 'goal'
       and ce.goal_id is not null
       and ce.source is distinct from 'healthkit'   -- never nudge a retroactive block
       and p.health_connected = true
       and ce.start_at >= now()
       and ce.start_at < now() + interval '6 minutes'
       and not exists (
             select 1 from activity_log al
              where al.event_id = ce.id and al.result = 'done')
       -- once per user, ever
       and not exists (
             select 1 from proactive_pushes pp
              where pp.user_id = ce.user_id and pp.kind = 'workout_start')
       -- already training? don't interrupt.
       and not exists (
             select 1 from health_workouts hw
              where hw.user_id = ce.user_id
                and tstzrange(hw.started_at, hw.ended_at)
                    && tstzrange(ce.start_at - interval '30 minutes',
                                 ce.start_at + interval '30 minutes'))
  loop
    perform public.try_proactive_push(
      _r.user_id,
      'workout_start',
      'workoutstart:' || _r.event_id,
      _r.title,
      'Starting now — hit start in Fitness (or whatever you train with) and it logs itself. No need to tell me afterwards.',
      jsonb_build_object('type', 'workout_start', 'event_id', _r.event_id));
  end loop;
end;
$$;


--
-- Name: rebuild_places(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rebuild_places(_user uuid) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  _tz text := coalesce(nullif((select timezone from profiles where id = _user), ''), 'UTC');
  _s record; _c record; _p record;
  _cid int; _best_d double precision; _d double precision;
  _keep uuid[] := '{}'; _home_cid int; _place uuid; _n int := 0;
  _touched boolean; _cal_title text; _cal_days int;
begin
  create temp table if not exists _pc (
    cid int primary key, lat double precision, lon double precision,
    n_stays int, minutes double precision, nights int, workdays int,
    days date[], cells text[], cal text[], first_seen timestamptz, last_seen timestamptz
  ) on commit drop;
  truncate _pc;

  for _s in
    select v.arrived_at, v.left_at, v.geohash_7, v.activity, v.activity_source,
           (public.geohash_center(v.geohash_7)).*,
           extract(epoch from v.left_at - v.arrived_at) / 60 as mins,
           (v.arrived_at at time zone _tz) as a_local, (v.left_at at time zone _tz) as l_local
      from visits v
     where v.user_id = _user and v.kind = 'stay' and v.geohash_7 is not null
       and v.arrived_at > now() - interval '120 days'
       and v.left_at - v.arrived_at >= interval '15 minutes'
     order by v.arrived_at
  loop
    _cid := null; _best_d := 1e12;
    for _c in select cid, lat, lon from _pc loop
      _d := public.approx_metres(_c.lat, _c.lon, _s.lat, _s.lon);
      if _d <= 150 and _d < _best_d then _best_d := _d; _cid := _c.cid; end if;
    end loop;
    if _cid is null then
      insert into _pc values ((select coalesce(max(cid), 0) + 1 from _pc), _s.lat, _s.lon, 0, 0, 0, 0,
                              '{}', '{}', '{}', _s.arrived_at, _s.left_at)
      returning cid into _cid;
    end if;
    update _pc set
      lat = (lat * minutes + _s.lat * _s.mins) / nullif(minutes + _s.mins, 0),
      lon = (lon * minutes + _s.lon * _s.mins) / nullif(minutes + _s.mins, 0),
      n_stays = n_stays + 1,
      minutes = minutes + _s.mins,
      nights = nights + case when (_s.l_local - interval '3 hours')::date > (_s.a_local - interval '3 hours')::date then 1 else 0 end,
      workdays = workdays + case when extract(isodow from _s.a_local) <= 5 and _s.mins >= 180
                                   and extract(hour from _s.a_local) between 6 and 13 then 1 else 0 end,
      days = days || _s.a_local::date,
      cells = cells || _s.geohash_7,
      -- appointments from the calendar seen here: "title|date"
      cal = cal || case when _s.activity_source = 'calendar' and public.norm_event_title(_s.activity) is not null
                        then array[public.norm_event_title(_s.activity) || '|' || _s.a_local::date] else '{}'::text[] end,
      first_seen = least(first_seen, _s.arrived_at),
      last_seen = greatest(last_seen, _s.left_at)
     where cid = _cid;
  end loop;

  select cid into _home_cid from _pc where nights >= 2 order by nights desc, minutes desc limit 1;

  for _c in
    select *, (select count(distinct d) from unnest(days) d) as n_days,
           (select x from unnest(cells) x group by x order by count(*) desc limit 1) as cell
      from _pc
  loop
    -- the same appointment here on 2+ different days (e.g. "Striženje")
    select split_part(x, '|', 1), count(distinct split_part(x, '|', 2))
      into _cal_title, _cal_days
      from unnest(_c.cal) x group by 1 order by 2 desc limit 1;

    -- regular places: ≥3 stays on ≥2 days in the last 60 days; home; or a
    -- recurring calendar appointment (2 visits suffice — a barber every month)
    continue when not (
      _c.cid = _home_cid
      or (_c.n_stays >= 3 and _c.n_days >= 2 and _c.last_seen > now() - interval '60 days')
      or coalesce(_cal_days, 0) >= 2
    );

    select id, user_label, inference_status, last_asked_at, category into _p
      from places
     where user_id = _user and not (id = any(_keep))
       and public.approx_metres(coalesce(centroid_lat, (public.geohash_center(geohash_7)).lat),
                                coalesce(centroid_lon, (public.geohash_center(geohash_7)).lon),
                                _c.lat, _c.lon) <= 150
     order by (user_label is not null or inference_status = 'corrected' or last_asked_at is not null) desc,
              visit_count desc nulls last
     limit 1;

    if _p.id is not null then
      _touched := _p.user_label is not null or _p.inference_status = 'corrected' or _p.last_asked_at is not null;
      update places set
        visit_count = _c.n_stays, total_dwell_minutes = _c.minutes,
        first_seen = least(first_seen, _c.first_seen), last_seen = _c.last_seen,
        centroid_lat = _c.lat, centroid_lon = _c.lon,
        category = case when _touched then category
                        when _c.cid = _home_cid then 'home'
                        when _c.workdays >= 3 then 'work'
                        else category end,
        -- a recurring appointment names the place (beats a map guess)
        name = case when _touched or coalesce(_cal_days, 0) < 2 then name else initcap(_cal_title) end,
        google_place_id = case when not _touched and coalesce(_cal_days, 0) >= 2 then 'CALENDAR' else google_place_id end,
        is_hidden = case when _touched then is_hidden else false end,
        updated_at = now()
       where id = _p.id;
      _place := _p.id;
    else
      insert into places (user_id, geohash_7, geohash_5, centroid_lat, centroid_lon, visit_count,
                          total_dwell_minutes, first_seen, last_seen, category, confidence,
                          inference_status, is_hidden, name, google_place_id)
      values (_user, _c.cell, left(_c.cell, 5), _c.lat, _c.lon, _c.n_stays, _c.minutes,
              _c.first_seen, _c.last_seen,
              case when _c.cid = _home_cid then 'home' when _c.workdays >= 3 then 'work' end,
              case when _c.cid = _home_cid then 0.8 when _c.workdays >= 3 then 0.7 else 0.5 end,
              'pending', false,
              case when coalesce(_cal_days, 0) >= 2 then initcap(_cal_title) end,
              -- 'CALENDAR' = named by the appointment; resolve-places leaves it
              case when coalesce(_cal_days, 0) >= 2 then 'CALENDAR' end)
      returning id into _place;
    end if;
    _keep := _keep || _place;
    _n := _n + 1;
  end loop;

  update places set is_hidden = true, updated_at = now()
   where user_id = _user and not (id = any(_keep))
     and (user_label is not null or inference_status = 'corrected' or last_asked_at is not null)
     and last_seen < now() - interval '60 days' and not is_hidden;
  delete from places
   where user_id = _user and not (id = any(_keep))
     and user_label is null and inference_status <> 'corrected' and last_asked_at is null;

  update visits v set place_id = (
      select p.id from places p, public.geohash_center(v.geohash_7) g
       where p.user_id = _user and not p.is_hidden and p.centroid_lat is not null
         and public.approx_metres(p.centroid_lat, p.centroid_lon, g.lat, g.lon) <= 150
       order by public.approx_metres(p.centroid_lat, p.centroid_lon, g.lat, g.lon) limit 1)
   where v.user_id = _user and v.kind = 'stay' and v.geohash_7 is not null
     and v.arrived_at > now() - interval '60 days';
  return _n;
end $$;


--
-- Name: rebuild_places_and_routines_all(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rebuild_places_and_routines_all() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare _u uuid; _n int := 0;
begin
  for _u in select distinct user_id from visits where arrived_at > now() - interval '60 days' loop
    perform public.rebuild_places(_u);
    perform public.rebuild_routines(_u);
    _n := _n + 1;
  end loop;
  return _n;
end $$;


--
-- Name: rebuild_routines(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rebuild_routines(_user uuid) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  _tz text := coalesce(nullif((select timezone from profiles where id = _user), ''), 'UTC');
  _since timestamptz := greatest(now() - interval '42 days',
                          coalesce((select value::timestamptz from app_config where key = 'reliable_data_since'), '-infinity'));
  _weeks double precision;
  _n int := 0;
begin
  select extract(epoch from now() - min(arrived_at)) / (7 * 86400) into _weeks
    from visits where user_id = _user and arrived_at >= _since;
  delete from routines where user_id = _user and inference_status = 'pending';
  if coalesce(_weeks, 0) < 2 then return 0; end if;

  with stays as (
    select v.place_id, p.category,
           extract(dow from v.arrived_at at time zone _tz)::int as dow,
           date_trunc('week', v.arrived_at at time zone _tz) as wk,
           (extract(hour from v.arrived_at at time zone _tz) * 60 + extract(minute from v.arrived_at at time zone _tz))::int as s_min,
           least(1439, (extract(hour from v.left_at at time zone _tz) * 60 + extract(minute from v.left_at at time zone _tz))::int) as e_min,
           v.left_at
      from visits v join places p on p.id = v.place_id
     where v.user_id = _user and v.kind = 'stay' and v.arrived_at >= _since
       and v.left_at - v.arrived_at >= interval '20 minutes'
       and not p.is_hidden and coalesce(p.category, '') <> 'home'
       and (v.left_at at time zone _tz)::date = (v.arrived_at at time zone _tz)::date
  ), agg as (
    select place_id, max(category) category, dow, count(distinct wk) occ,
           percentile_disc(0.5) within group (order by s_min) s_min,
           percentile_disc(0.5) within group (order by e_min) e_min,
           max(left_at) last_obs
      from stays group by place_id, dow
  )
  insert into routines (user_id, place_id, category, day_of_week, start_minute, end_minute,
                        consistency, last_observed, active, inference_status)
  select _user, a.place_id, a.category, a.dow, a.s_min, a.e_min,
         least(1, a.occ / ceil(_weeks)), a.last_obs, true, 'pending'
    from agg a
   where a.occ >= 2 and a.occ / ceil(_weeks) >= 0.6 and a.e_min > a.s_min
     and not exists (select 1 from routines r where r.user_id = _user and r.place_id = a.place_id
                       and r.day_of_week = a.dow and r.inference_status <> 'pending');
  get diagnostics _n = row_count;

  -- recurring walks / runs / rides (2-hour start window per weekday)
  with trips as (
    select case v.travel_mode when 'running' then 'run' when 'cycling' then 'ride' else 'walk' end as category,
           extract(dow from v.arrived_at at time zone _tz)::int as dow,
           (extract(hour from v.arrived_at at time zone _tz)::int / 2) as slot,
           date_trunc('week', v.arrived_at at time zone _tz) as wk,
           (extract(hour from v.arrived_at at time zone _tz) * 60 + extract(minute from v.arrived_at at time zone _tz))::int as s_min,
           least(1439, (extract(hour from v.left_at at time zone _tz) * 60 + extract(minute from v.left_at at time zone _tz))::int) as e_min,
           v.left_at
      from visits v
     where v.user_id = _user and v.kind = 'travel' and v.arrived_at >= _since
       and v.travel_mode in ('walking', 'running', 'cycling')
       and v.left_at - v.arrived_at >= interval '20 minutes'
  ), agg as (
    select category, dow, slot, count(distinct wk) occ,
           percentile_disc(0.5) within group (order by s_min) s_min,
           percentile_disc(0.5) within group (order by e_min) e_min,
           max(left_at) last_obs
      from trips group by category, dow, slot
  )
  insert into routines (user_id, place_id, category, day_of_week, start_minute, end_minute,
                        consistency, last_observed, active, inference_status)
  select _user, null, a.category, a.dow, a.s_min, a.e_min,
         least(1, a.occ / ceil(_weeks)), a.last_obs, true, 'pending'
    from agg a
   where a.occ >= 2 and a.occ / ceil(_weeks) >= 0.6 and a.e_min > a.s_min
     and not exists (select 1 from routines r where r.user_id = _user and r.place_id is null
                       and r.category = a.category and r.day_of_week = a.dow and r.inference_status <> 'pending');
  return _n;
end $$;


--
-- Name: reclassify_moving_stays(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reclassify_moving_stays(_user uuid) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare _v record; _moving double precision; _mode text; _n int := 0;
begin
  for _v in
    select id, arrived_at, left_at from visits
     where user_id = _user and kind = 'stay' and activity_source is distinct from 'user'
       and arrived_at > now() - interval '3 days' and left_at > arrived_at
  loop
    select sum(extract(epoch from least(ma.ended_at, _v.left_at) - greatest(ma.started_at, _v.arrived_at))),
           (array_agg(ma.kind order by least(ma.ended_at, _v.left_at) - greatest(ma.started_at, _v.arrived_at) desc))[1]
      into _moving, _mode
      from motion_activity ma
     where ma.user_id = _user and ma.kind in ('walking','running','cycling','driving')
       and ma.started_at < _v.left_at and ma.ended_at > _v.arrived_at;
    if coalesce(_moving, 0) >= 0.5 * extract(epoch from _v.left_at - _v.arrived_at) then
      update visits set kind = 'travel', travel_mode = _mode, place_id = null, activity = null,
             activity_source = null, activity_confidence = null, health_workout_id = null, updated_at = now()
       where id = _v.id;
      _n := _n + 1;
    end if;
  end loop;
  return _n;
end $$;


--
-- Name: reconcile_health_workouts(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reconcile_health_workouts(_max integer DEFAULT 50) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  _uid uuid := auth.uid();
  _tz text;
  _w record;
  _ev record;
  _goal_id uuid;
  _cand int;
  _new_event uuid;
  _log_id uuid;
  _keywords text[];
  _label text;
  _mins numeric;
  _place uuid;
  _dow int;
  _bucket int;
  _planned int := 0;
  _unplanned int := 0;
  _linked int := 0;
  _ambiguous int := 0;
  _skipped int := 0;
begin
  if _uid is null then raise exception 'must be authenticated'; end if;
  select coalesce(timezone, 'UTC') into _tz from profiles where id = _uid;
  _tz := coalesce(_tz, 'UTC');

  for _w in
    select * from health_workouts
     where user_id = _uid and reconciled_at is null
     order by started_at
     limit greatest(coalesce(_max, 50), 1)
  loop
    _mins := coalesce(_w.duration_min, extract(epoch from (_w.ended_at - _w.started_at)) / 60.0);

    -- Sanity guards: a 3-minute session is a mis-tap; a 6-hour "workout" is a
    -- timer someone forgot to stop. Neither is goal work.
    if _mins < 5 or _mins > 360 then
      update health_workouts set reconciled_at = now(), match_kind = 'none' where id = _w.id;
      _skipped := _skipped + 1;
      continue;
    end if;

    -- Where were they? Fuses location into the health signal, so the pattern
    -- learner can tell "trains at the gym" from "trains at home" (null place).
    _place := null;
    select pl.id into _place
      from behavioral_pings bp
      join places pl on pl.user_id = _uid and substr(bp.geohash_8, 1, 7) = pl.geohash_7
     where bp.user_id = _uid
       and bp.captured_at between _w.started_at - interval '5 minutes'
                              and _w.ended_at + interval '5 minutes'
     group by pl.id
     order by count(*) desc
     limit 1;

    _dow := extract(dow from (_w.started_at at time zone _tz))::int;
    _bucket := floor(extract(hour from (_w.started_at at time zone _tz)) / 3)::int;

    -- 1) Does this workout belong to a scheduled goal block? Note: NO done-filter
    -- here — a block already resolved from location must still capture this
    -- workout, or step 2 would duplicate it.
    select ce.id as id, ce.goal_id as goal_id, ce.start_at as start_at, ce.end_at as end_at
      into _ev
      from calendar_events ce
     where ce.user_id = _uid
       and ce.event_type = 'goal'
       and ce.goal_id is not null
       and ce.health_workout_id is null
       and tstzrange(ce.start_at - interval '45 minutes', ce.end_at + interval '45 minutes')
           && tstzrange(_w.started_at, _w.ended_at)
     order by abs(extract(epoch from (ce.start_at - _w.started_at)))
     limit 1;

    if _ev.id is not null then
      select id into _log_id from activity_log
       where event_id = _ev.id and user_id = _uid limit 1;

      if _log_id is not null then
        -- Upgrade provenance: measurement outranks inference and claims, and
        -- they agree on the outcome. Never downgrades an existing 'done'.
        update activity_log
           set result = 'done', confirmed_by = 'healthkit', checked_at = now()
         where id = _log_id;
      else
        insert into activity_log (user_id, event_id, result, confirmed_by,
                                  scheduled_start, scheduled_end, source_kind, checked_at)
        values (_uid, _ev.id, 'done', 'healthkit',
                _ev.start_at, _ev.end_at, 'goal', now());
      end if;

      update calendar_events set health_workout_id = _w.id where id = _ev.id;
      update goals set last_completed_at = greatest(coalesce(last_completed_at, _w.ended_at), _w.ended_at)
       where id = _ev.goal_id and user_id = _uid;
      update health_workouts
         set matched_event_id = _ev.id, matched_goal_id = _ev.goal_id,
             match_kind = 'planned', reconciled_at = now()
       where id = _w.id;

      -- Learn from it: this is how "you train Tue evenings" becomes predictable.
      perform public.bump_activity_pattern(
        _uid, _w.activity_type, _dow, _bucket, _place, _w.ended_at);

      _planned := _planned + 1;
      continue;
    end if;

    -- 2) Unplanned: which active goal does this activity belong to?
    _keywords := case _w.activity_type
      when 'strength' then array['%strength%','%lift%','%gym%','%weight%','%fit%']
      when 'running'  then array['%run%','%jog%','%fit%']
      when 'cycling'  then array['%cycl%','%bike%','%ride%','%fit%']
      when 'walking'  then array['%walk%','%hike%','%step%']
      when 'hiit'     then array['%hiit%','%interval%','%circuit%','%fit%']
      when 'yoga'     then array['%yoga%','%mobility%','%stretch%']
      when 'swimming' then array['%swim%','%fit%']
      else array['%workout%','%train%','%fit%']
    end;

    select count(*)::int, (array_agg(g.id))[1] into _cand, _goal_id
      from goals g
     where g.user_id = _uid and g.status = 'active'
       and (
         exists (select 1 from goal_plans gp
                  where gp.goal_id = g.id and gp.status = 'live'
                    and gp.plan_spec::text ilike any (_keywords))
         or g.title ilike any (_keywords)
         or (g.category is not null and g.category ilike any (_keywords))
       );

    if _cand = 0 then
      -- No goal owns it, but it still happened — learn the rhythm anyway.
      perform public.bump_activity_pattern(
        _uid, _w.activity_type, _dow, _bucket, _place, _w.ended_at);
      update health_workouts set reconciled_at = now(), match_kind = 'none' where id = _w.id;
      _skipped := _skipped + 1;
      continue;
    elsif _cand > 1 then
      perform public.bump_activity_pattern(
        _uid, _w.activity_type, _dow, _bucket, _place, _w.ended_at);
      update health_workouts set reconciled_at = now(), match_kind = 'ambiguous' where id = _w.id;
      _ambiguous := _ambiguous + 1;
      continue;
    end if;

    -- 2b) Did it at a different time, same local day: MOVE that day's
    -- unfinished session of this goal to when it actually happened, instead of
    -- adding a second block and leaving a ghost session that later gets asked
    -- about ("did you do your 17:00?") or double-counted.
    select ce.id into _ev
      from calendar_events ce
     where ce.user_id = _uid and ce.event_type = 'goal' and ce.goal_id = _goal_id
       and ce.health_workout_id is null
       and (ce.start_at at time zone _tz)::date = (_w.started_at at time zone _tz)::date
       and not exists (select 1 from activity_log al where al.event_id = ce.id and al.result = 'done')
     order by abs(extract(epoch from (ce.start_at - _w.started_at)))
     limit 1;
    if _ev.id is not null then
      perform public._move_goal_block_to_actual(_uid, _ev.id, _w.started_at, _w.ended_at, 'healthkit', _w.id);
      update health_workouts
         set matched_event_id = _ev.id, matched_goal_id = _goal_id,
             match_kind = 'planned', reconciled_at = now()
       where id = _w.id;
      perform public.bump_activity_pattern(_uid, _w.activity_type, _dow, _bucket, _place, _w.ended_at);
      _planned := _planned + 1;
      continue;
    end if;

    _label := case _w.activity_type
      when 'strength' then 'Strength training'
      when 'running'  then 'Run'
      when 'cycling'  then 'Ride'
      when 'walking'  then 'Walk'
      when 'hiit'     then 'HIIT'
      when 'yoga'     then 'Yoga'
      when 'swimming' then 'Swim'
      else 'Workout'
    end;

    insert into calendar_events (user_id, title, start_at, end_at, event_type,
                                 goal_id, source, is_movable, health_workout_id)
    values (_uid, _label, _w.started_at, _w.ended_at, 'goal',
            _goal_id, 'healthkit', false, _w.id)
    returning id into _new_event;

    insert into activity_log (user_id, event_id, result, confirmed_by,
                              scheduled_start, scheduled_end, source_kind, checked_at)
    values (_uid, _new_event, 'done', 'healthkit',
            _w.started_at, _w.ended_at, 'goal', now());

    update goals set last_completed_at = greatest(coalesce(last_completed_at, _w.ended_at), _w.ended_at)
     where id = _goal_id and user_id = _uid;
    update health_workouts
       set matched_event_id = _new_event, matched_goal_id = _goal_id,
           match_kind = 'unplanned', reconciled_at = now()
     where id = _w.id;

    perform public.bump_activity_pattern(
      _uid, _w.activity_type, _dow, _bucket, _place, _w.ended_at);

    _unplanned := _unplanned + 1;
  end loop;

  return jsonb_build_object(
    'planned', _planned, 'unplanned', _unplanned, 'linked', _linked,
    'ambiguous', _ambiguous, 'skipped', _skipped);
end;
$$;


--
-- Name: reject_change_set(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reject_change_set(_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if auth.uid() is null then raise exception 'must be authenticated'; end if;

  update public.change_sets
  set status = 'rejected', updated_at = now()
  where id = _id and user_id = auth.uid() and status = 'pending';
end;
$$;


--
-- Name: request_friendship_by_handle(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.request_friendship_by_handle(_handle text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  _user_id uuid := auth.uid();
  _other_id uuid;
  _a uuid;
  _b uuid;
  _existing public.friendships%rowtype;
begin
  if _user_id is null then
    raise exception 'Not authenticated';
  end if;

  select id into _other_id
  from public.profiles
  where handle = lower(trim(_handle))
  limit 1;

  if _other_id is null then
    raise exception 'No user with handle "%"', _handle;
  end if;

  if _other_id = _user_id then
    raise exception 'Cannot friend yourself';
  end if;

  _a := least(_user_id, _other_id);
  _b := greatest(_user_id, _other_id);

  select * into _existing from public.friendships where user_a = _a and user_b = _b;

  if _existing.user_a is not null then
    if _existing.status = 'accepted' then
      return 'already_friends';
    elsif _existing.status = 'pending' then
      -- If THEY requested us → auto-accept. Otherwise it's a re-send no-op.
      if _existing.requested_by = _other_id then
        update public.friendships
        set status = 'accepted', updated_at = now()
        where user_a = _a and user_b = _b;
        return 'auto_accepted';
      else
        return 'request_pending';
      end if;
    else
      -- blocked — silently reject as if user doesn't exist
      raise exception 'No user with handle "%"', _handle;
    end if;
  end if;

  insert into public.friendships (user_a, user_b, status, requested_by)
  values (_a, _b, 'pending', _user_id);
  return 'request_sent';
end;
$$;


--
-- Name: resolve_activity_check(uuid, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.resolve_activity_check(_id uuid, _result text, _actual_label text DEFAULT NULL::text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  _user    uuid := auth.uid();
  _row     record;
  _key     text;
  _dow     int;
  _bucket  int;
  _done    int;
  _skipped int;
BEGIN
  IF _user IS NULL THEN RAISE EXCEPTION 'must be authenticated'; END IF;
  IF _result NOT IN ('done','skipped','elsewhere') THEN
    RAISE EXCEPTION 'invalid result: %', _result;
  END IF;

  UPDATE public.activity_log
     SET result = _result, confirmed_by = 'user', actual_label = _actual_label,
         last_asked_at = now(), checked_at = now()
   WHERE id = _id AND user_id = _user
   RETURNING * INTO _row;
  IF NOT FOUND THEN RAISE EXCEPTION 'activity check not found'; END IF;

  -- Recompute the pattern key for this occurrence.
  SELECT lower(trim(coalesce(nullif(_row.expected_category,''), ce.title, 'activity'))),
         extract(dow FROM (_row.scheduled_start AT TIME ZONE p.timezone))::int,
         floor(extract(hour FROM (_row.scheduled_start AT TIME ZONE p.timezone)) / 3)::int
    INTO _key, _dow, _bucket
    FROM public.profiles p
    LEFT JOIN public.calendar_events ce ON ce.id = _row.event_id
   WHERE p.id = _user;

  -- Phase B: the user's answer reshapes the location memory.
  IF _result IN ('done','elsewhere') THEN
    -- count the observed actual location (NULL → the no-clear-location bucket)
    PERFORM public.bump_activity_pattern(_user, _key, _dow, _bucket, _row.actual_place_id, now());
  END IF;

  -- Routine reinforcement (unchanged).
  IF _row.source_id IS NOT NULL THEN
    IF _result = 'done' THEN
      UPDATE public.routines SET last_observed = now(), updated_at = now() WHERE id = _row.source_id;
      SELECT count(*) INTO _done FROM public.activity_log WHERE source_id = _row.source_id AND result = 'done';
      IF _done >= 3 THEN
        UPDATE public.routines SET inference_status = 'confirmed', updated_at = now()
          WHERE id = _row.source_id AND inference_status = 'pending';
      END IF;
    ELSIF _result = 'skipped' THEN
      SELECT count(*) INTO _skipped FROM public.activity_log WHERE source_id = _row.source_id AND result = 'skipped';
      IF _skipped >= 3 THEN
        UPDATE public.routines SET active = false, updated_at = now() WHERE id = _row.source_id;
      END IF;
    END IF;
  END IF;
END;
$$;


--
-- Name: respond_to_friendship(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.respond_to_friendship(_other_user uuid, _action text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  _user_id uuid := auth.uid();
  _a uuid;
  _b uuid;
  _existing public.friendships%rowtype;
begin
  if _user_id is null then
    raise exception 'Not authenticated';
  end if;
  if _action not in ('accept', 'decline') then
    raise exception 'Invalid action';
  end if;

  _a := least(_user_id, _other_user);
  _b := greatest(_user_id, _other_user);

  select * into _existing from public.friendships where user_a = _a and user_b = _b;
  if _existing.user_a is null then
    raise exception 'No friendship row';
  end if;
  if _existing.status <> 'pending' then
    raise exception 'Friendship not pending';
  end if;
  -- Only the recipient (NOT the requester) can accept/decline.
  if _existing.requested_by = _user_id then
    raise exception 'Cannot respond to your own request';
  end if;

  if _action = 'accept' then
    update public.friendships
    set status = 'accepted', updated_at = now()
    where user_a = _a and user_b = _b;
  else
    delete from public.friendships where user_a = _a and user_b = _b;
  end if;
end;
$$;


--
-- Name: respond_to_hangout(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.respond_to_hangout(_hangout_id uuid, _status text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  _user_id uuid := auth.uid();
  _threshold integer;
  _confirmed_count integer;
  _possible_yes integer;
  _current_status text;
begin
  if _user_id is null then
    raise exception 'Not authenticated';
  end if;
  if _status not in ('confirmed','declined','maybe','pending') then
    raise exception 'Invalid status: %', _status;
  end if;

  select min_attendees, status into _threshold, _current_status
  from public.hangouts where id = _hangout_id;
  if not found then
    raise exception 'Hangout not found';
  end if;
  if not public.is_hangout_participant(_hangout_id) then
    raise exception 'Not part of this hangout';
  end if;

  insert into public.hangout_responses (hangout_id, user_id, status, responded_at)
  values (_hangout_id, _user_id, _status, now())
  on conflict (hangout_id, user_id)
  do update set status = excluded.status, responded_at = now();

  select count(*) into _confirmed_count
  from public.hangout_responses where hangout_id = _hangout_id and status = 'confirmed';
  select count(*) into _possible_yes
  from public.hangout_responses where hangout_id = _hangout_id and status in ('confirmed','maybe','pending');

  _threshold := coalesce(_threshold, 2);
  if _current_status = 'proposing' and _confirmed_count >= _threshold then
    update public.hangouts set status = 'confirmed' where id = _hangout_id;
  end if;
  if _current_status = 'proposing' and _possible_yes < _threshold then
    update public.hangouts set status = 'cancelled' where id = _hangout_id;
  end if;
end;
$$;


--
-- Name: send_due_reminders(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.send_due_reminders() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE _r record; _mid uuid;
BEGIN
  FOR _r IN
    SELECT id, user_id, content FROM reminders
     WHERE status = 'pending' AND remind_at <= now()
     ORDER BY remind_at
     LIMIT 50
  LOOP
    BEGIN
      _mid := public.log_agent_message(_r.user_id, _r.content, 'reminder',
                jsonb_build_object('reminder_id', _r.id));
      PERFORM public.send_push_to_users(
        _user_ids => ARRAY[_r.user_id],
        _title    => 'Reminder',
        _body     => _r.content,
        _data     => jsonb_build_object('type', 'reminder', 'reminder_id', _r.id,
                                        'chat_message_id', _mid)
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'reminder push failed silently: %', sqlerrm;
    END;
    UPDATE reminders SET status = 'sent' WHERE id = _r.id;
  END LOOP;
END $$;


--
-- Name: send_push_to_users(uuid[], text, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.send_push_to_users(_user_ids uuid[], _title text, _body text, _data jsonb DEFAULT NULL::jsonb) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  _tokens text[];
  _payload jsonb;
begin
  if _user_ids is null or array_length(_user_ids, 1) is null then
    return;
  end if;

  select array_agg(expo_push_token) into _tokens
  from public.profiles
  where id = any(_user_ids)
    and push_notifications_enabled = true
    and expo_push_token is not null;

  if _tokens is null or array_length(_tokens, 1) is null then
    return;  -- nobody to push to
  end if;

  -- Expo Push expects an array of message objects
  select jsonb_agg(
    jsonb_build_object(
      'to', t,
      'title', _title,
      'body', _body,
      'data', coalesce(_data, '{}'::jsonb),
      'sound', 'default',
      'priority', 'high'
    )
  ) into _payload
  from unnest(_tokens) as t;

  -- Async HTTP via pg_net — request runs in the background, we don't wait.
  -- Errors land in the net.http_request_queue; we don't surface them
  -- to the caller because failing to push must never block a hangout.
  perform net.http_post(
    url := 'https://exp.host/--/api/v2/push/send',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Accept', 'application/json',
      'Accept-Encoding', 'gzip, deflate'
    ),
    body := _payload
  );
exception when others then
  -- absolutely never let push failures break the calling transaction
  raise notice 'send_push_to_users failed silently: %', sqlerrm;
end;
$$;


--
-- Name: set_friend_tier(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_friend_tier(_other_user uuid, _tier text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare _me uuid := auth.uid();
begin
  if _me is null then raise exception 'must be authenticated'; end if;
  if _tier not in ('friend','inner') then raise exception 'invalid tier'; end if;
  update public.friendships
     set tier_a = case when _me < _other_user then _tier else tier_a end,
         tier_b = case when _me > _other_user then _tier else tier_b end,
         updated_at = now()
   where status = 'accepted'
     and user_a = least(_me, _other_user)
     and user_b = greatest(_me, _other_user);
  if not found then raise exception 'not friends with that user'; end if;
end;
$$;


--
-- Name: set_handle(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_handle(_handle text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
declare
  _user_id uuid := auth.uid();
  _normalized text := lower(trim(_handle));
begin
  if _user_id is null then
    raise exception 'Not authenticated';
  end if;

  if _normalized !~ '^[a-z][a-z0-9_]{2,19}$' then
    raise exception 'Handle must be 3-20 chars, start with a letter, lowercase letters/digits/underscore only';
  end if;

  -- Uniqueness check (case-insensitive — column already lowercase).
  if exists (
    select 1 from public.profiles
    where handle = _normalized and id <> _user_id
  ) then
    raise exception 'Handle "%" is already taken', _normalized;
  end if;

  update public.profiles
  set handle = _normalized
  where id = _user_id;
end;
$_$;


--
-- Name: set_hangout_invite_policy(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_hangout_invite_policy(_hangout_id uuid, _policy text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if _policy not in ('host_only','participants','mutuals') then
    raise exception 'Invalid invite policy: %', _policy;
  end if;
  update public.hangouts set invite_policy = _policy
  where id = _hangout_id and proposed_by = auth.uid();
  if not found then
    raise exception 'Only the host can change who can invite';
  end if;
end;
$$;


--
-- Name: set_push_token(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_push_token(_token text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if auth.uid() is null then
    raise exception 'must be authenticated';
  end if;

  if _token is null or length(trim(_token)) < 10 then
    update public.profiles
    set expo_push_token = null,
        push_notifications_enabled = false,
        push_token_updated_at = now()
    where id = auth.uid();
  else
    update public.profiles
    set expo_push_token = trim(_token),
        push_notifications_enabled = true,
        push_token_updated_at = now()
    where id = auth.uid();
  end if;
end;
$$;


--
-- Name: set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


--
-- Name: shares_group_with(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.shares_group_with(_other_user uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select exists (
    select 1
    from public.group_members gm1
    join public.group_members gm2 on gm1.group_id = gm2.group_id
    where gm1.user_id = auth.uid()
      and gm2.user_id = _other_user
  );
$$;


--
-- Name: stay_centroid(uuid, timestamp with time zone, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.stay_centroid(_user uuid, _from timestamp with time zone, _to timestamp with time zone, OUT lat double precision, OUT lon double precision) RETURNS record
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  with pts as (
    select (public.geohash_center(geohash_8)).*, source
      from behavioral_pings
     where user_id = _user and captured_at between _from - interval '1 minute' and _to + interval '1 minute'
       and geohash_8 is not null
  ), pick as (
    select * from pts where source = 'visit'
    union all
    select * from pts where not exists (select 1 from pts where source = 'visit')
  )
  select avg(pick.lat), avg(pick.lon) from pick
$$;


--
-- Name: stay_end_by_motion(uuid, timestamp with time zone, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.stay_end_by_motion(_user uuid, _from timestamp with time zone, _to timestamp with time zone, OUT departed timestamp with time zone, OUT next_arrival timestamp with time zone) RETURNS record
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  _s record; _run_end timestamptz;
  _break constant interval := interval '5 minutes';  -- shorter gaps = fidgeting, not leaving
begin
  for _s in
    select started_at, ended_at from motion_activity
     where user_id = _user and kind = 'stationary'
       and ended_at > _from and started_at < _to
     order by started_at
  loop
    if _run_end is null then
      if _s.started_at > _from + interval '20 minutes' then return; end if;
      _run_end := _s.ended_at;                 -- the run they settled into
    elsif _s.started_at - _run_end <= _break then
      _run_end := greatest(_run_end, _s.ended_at);
    else
      departed := _run_end; next_arrival := _s.started_at;
      return;
    end if;
  end loop;
  if _run_end is not null and _to - _run_end > _break then
    departed := _run_end;                       -- left; nothing settled before _to
  end if;
end $$;


--
-- Name: stay_name_near(uuid, double precision, double precision); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.stay_name_near(_user uuid, _lat double precision, _lon double precision) RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select sn.name from stay_names sn
   where sn.user_id = _user and sn.name is not null
     and public.approx_metres(sn.lat, sn.lon, _lat, _lon) <= 75
   order by public.approx_metres(sn.lat, sn.lon, _lat, _lon) limit 1
$$;


--
-- Name: stays_needing_names(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.stays_needing_names(_limit integer DEFAULT 20) RETURNS TABLE(user_id uuid, lat double precision, lon double precision, minutes integer)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select v.user_id, c.lat, c.lon, (extract(epoch from v.left_at - v.arrived_at) / 60)::int
    from visits v
    cross join lateral public.stay_centroid(v.user_id, v.arrived_at, v.left_at) c
   where v.kind = 'stay' and v.arrived_at > now() - interval '3 days'
     and v.left_at - v.arrived_at >= interval '15 minutes'
     and c.lat is not null
     and not exists (select 1 from places p where p.id = v.place_id
                       and (p.user_label is not null or p.category = 'home'))
     and not exists (select 1 from stay_names sn where sn.user_id = v.user_id
                       and public.approx_metres(sn.lat, sn.lon, c.lat, c.lon) <= 75)
   order by v.arrived_at desc
   limit _limit
$$;


--
-- Name: summary_users(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.summary_users() RETURNS TABLE(user_id uuid, timezone text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select p.id, p.timezone from profiles p
   where exists (select 1 from behavioral_pings b where b.user_id = p.id and b.captured_at > now() - interval '30 days')
      or exists (select 1 from app_sessions s where s.user_id = p.id and s.opened_at > now() - interval '30 days')
$$;


--
-- Name: system_health_check(boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.system_health_check(_notify boolean DEFAULT true) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'cron'
    AS $$
declare
  _p jsonb := '[]'::jsonb;
  _r record;
  _latest_build int;
  _admin uuid := (select value::uuid from app_config where key = 'admin_user_id');
  _n int;
begin
  -- 1) outside services (from today's health-probe run)
  for _r in
    select distinct on (service) service, ok, detail, checked_at
      from system_health_probes order by service, checked_at desc
  loop
    if not _r.ok then
      _p := _p || jsonb_build_object('area', 'service', 'severity', 'high',
              'message', _r.service || ' failing: ' || left(_r.detail, 140));
    elsif _r.checked_at < now() - interval '26 hours' then
      _p := _p || jsonb_build_object('area', 'service', 'severity', 'medium',
              'message', _r.service || ' not checked since ' || to_char(_r.checked_at, 'DD Mon HH24:MI'));
    end if;
  end loop;
  if not exists (select 1 from system_health_probes where checked_at > now() - interval '26 hours') then
    _p := _p || jsonb_build_object('area', 'service', 'severity', 'medium', 'message', 'health-probe did not run in the last 26h');
  end if;

  -- 2) scheduled jobs: failures, or not running at all
  for _r in
    select j.jobname,
           count(*) filter (where d.status = 'failed') as failed,
           max(d.start_time) as last_run,
           left(max(d.return_message) filter (where d.status = 'failed'), 120) as msg
      from cron.job j left join cron.job_run_details d
        on d.jobid = j.jobid and d.start_time > now() - interval '26 hours'
     where j.active
     group by j.jobname
  loop
    if _r.failed > 0 then
      _p := _p || jsonb_build_object('area', 'jobs', 'severity', 'high',
              'message', _r.jobname || ' failed ' || _r.failed || 'x: ' || coalesce(_r.msg, ''));
    elsif _r.last_run is null
          and exists (select 1 from cron.job_run_details d2 join cron.job j2 on j2.jobid = d2.jobid
                       where j2.jobname = _r.jobname) then  -- ran before, now silent (brand-new jobs skipped)
      _p := _p || jsonb_build_object('area', 'jobs', 'severity', 'high', 'message', _r.jobname || ' has not run in 26h');
    end if;
  end loop;

  -- 3) the agent: user messages that never got a reply
  select count(*) into _n from chat_messages m
   where m.role = 'user' and m.created_at between now() - interval '24 hours' and now() - interval '5 minutes'
     and not exists (select 1 from chat_messages a where a.user_id = m.user_id and a.role = 'agent'
                       and a.created_at between m.created_at and m.created_at + interval '3 minutes');
  if _n > 0 then
    _p := _p || jsonb_build_object('area', 'agent', 'severity', 'high', 'message', _n || ' user message(s) got no reply in 24h');
  end if;

  -- 4) Google Calendar sync errors (not revoked tokens — those are expected)
  select count(*) into _n from google_oauth_tokens
   where last_sync_error is not null and last_sync_error not ilike '%invalid_grant%';
  if _n > 0 then
    _p := _p || jsonb_build_object('area', 'calendar', 'severity', 'medium', 'message', _n || ' Google Calendar sync(s) erroring');
  end if;

  -- 5) naming backlog: stops waiting for a name means name-stays isn't working
  select count(*) into _n from public.stays_needing_names(100);
  if _n > 30 then
    _p := _p || jsonb_build_object('area', 'places', 'severity', 'medium', 'message', _n || ' stops waiting for a name');
  end if;

  -- 6) each active tester's phone (active = data or chat in the last 14 days)
  select max(nullif(regexp_replace(app_build, '\D', '', 'g'), '')::int) into _latest_build from collection_health;
  for _r in
    select p.id, coalesce(p.first_name, p.handle, 'user') as who, p.timezone, p.expo_push_token,
           (select max(captured_at) from behavioral_pings b where b.user_id = p.id) as last_ping,
           ch.app_build, ch.location_bg, ch.motion_permission, ch.visits_monitoring, ch.visits_queued, ch.reported_at
      from profiles p
      left join lateral (select * from collection_health c where c.user_id = p.id order by reported_at desc limit 1) ch on true
     where p.onboarding_complete
       and (exists (select 1 from behavioral_pings b where b.user_id = p.id and b.captured_at > now() - interval '14 days')
            or exists (select 1 from chat_messages c where c.user_id = p.id and c.created_at > now() - interval '14 days'))
  loop
    if _r.last_ping is null or _r.last_ping < now() - interval '48 hours' then
      _p := _p || jsonb_build_object('area', 'tester', 'severity', 'high',
              'message', _r.who || ': no location data for 48h+ (last ' || coalesce(to_char(_r.last_ping, 'DD Mon HH24:MI'), 'never') || ')');
    end if;
    if _r.reported_at is null then
      _p := _p || jsonb_build_object('area', 'tester', 'severity', 'medium', 'message', _r.who || ': phone has never reported its setup');
      continue;
    end if;
    if coalesce(_r.location_bg, '') <> 'granted' then
      _p := _p || jsonb_build_object('area', 'tester', 'severity', 'high', 'message', _r.who || ': location is not set to Always');
    end if;
    if coalesce(_r.motion_permission, '') <> 'granted' then
      _p := _p || jsonb_build_object('area', 'tester', 'severity', 'medium', 'message', _r.who || ': Motion & Fitness off');
    end if;
    if _r.visits_monitoring is false then
      _p := _p || jsonb_build_object('area', 'tester', 'severity', 'medium', 'message', _r.who || ': iOS visit tracking not running');
    end if;
    if coalesce(_r.visits_queued, 0) > 50 then
      _p := _p || jsonb_build_object('area', 'tester', 'severity', 'medium', 'message', _r.who || ': ' || _r.visits_queued || ' visits stuck on the phone');
    end if;
    if _r.expo_push_token is null then
      _p := _p || jsonb_build_object('area', 'tester', 'severity', 'medium', 'message', _r.who || ': no push token (notifications won''t arrive)');
    end if;
    if _latest_build is not null and nullif(regexp_replace(coalesce(_r.app_build, ''), '\D', '', 'g'), '')::int < _latest_build - 2 then
      _p := _p || jsonb_build_object('area', 'tester', 'severity', 'low', 'message', _r.who || ': on old build ' || _r.app_build);
    end if;
  end loop;

  insert into system_health_runs (problems, notified)
  values (_p, _notify and jsonb_array_length(_p) > 0 and _admin is not null);

  if _notify and jsonb_array_length(_p) > 0 and _admin is not null then
    perform public.send_push_to_users(
      array[_admin],
      'ALINE health: ' || jsonb_array_length(_p) || ' issue' || case when jsonb_array_length(_p) = 1 then '' else 's' end,
      (select string_agg(x->>'message', ' · ') from (select x from jsonb_array_elements(_p) x
         order by case x->>'severity' when 'high' then 0 when 'medium' then 1 else 2 end limit 3) s),
      jsonb_build_object('type', 'system_health'));
  end if;
  return _p;
end $$;


--
-- Name: tg_calendar_events_sync_movable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.tg_calendar_events_sync_movable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  -- 'flexible' and 'goal' are user-controlled blocks the agent may suggest moving
  -- 'fixed' and 'coordinated' are not — they represent immutable obligations
  -- (work meetings, agreed group hangouts).
  new.is_movable := new.event_type in ('flexible', 'goal');
  return new;
end;
$$;


--
-- Name: tg_hangout_responses_sync_calendar(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.tg_hangout_responses_sync_calendar() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  _h public.hangouts;
  _payload jsonb;
begin
  select * into _h from public.hangouts where id = new.hangout_id;
  if not found or _h.status <> 'confirmed' then
    return new;
  end if;

  if new.status is not distinct from old.status then
    return new;
  end if;

  if new.status = 'confirmed' then
    _payload := public._coordinated_event_payload(new.user_id, _h);
    insert into public.calendar_events (
      user_id, title, description, start_at, end_at,
      event_type, hangout_id, location, source
    ) values (
      (_payload->>'user_id')::uuid,
      _payload->>'title',
      _payload->>'description',
      (_payload->>'start_at')::timestamptz,
      (_payload->>'end_at')::timestamptz,
      _payload->>'event_type',
      (_payload->>'hangout_id')::uuid,
      _payload->>'location',
      _payload->>'source'
    )
    on conflict (user_id, hangout_id) where hangout_id is not null
    do update set
      title       = excluded.title,
      description = excluded.description,
      start_at    = excluded.start_at,
      end_at      = excluded.end_at,
      location    = excluded.location,
      updated_at  = now();
  elsif old.status = 'confirmed' then
    delete from public.calendar_events
    where user_id = new.user_id and hangout_id = new.hangout_id;
  end if;

  return new;
end;
$$;


--
-- Name: tg_hangouts_sync_calendar(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.tg_hangouts_sync_calendar() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  _resp record;
  _payload jsonb;
begin
  if new.status is not distinct from old.status
     and new.proposed_start is not distinct from old.proposed_start
     and new.proposed_end is not distinct from old.proposed_end
     and new.title is not distinct from old.title
     and new.venue_name is not distinct from old.venue_name
     and new.venue_address is not distinct from old.venue_address then
    return new;
  end if;

  if new.status = 'confirmed' then
    for _resp in
      select user_id from public.hangout_responses
      where hangout_id = new.id and status = 'confirmed'
    loop
      _payload := public._coordinated_event_payload(_resp.user_id, new);
      insert into public.calendar_events (
        user_id, title, description, start_at, end_at,
        event_type, hangout_id, location, source
      ) values (
        (_payload->>'user_id')::uuid,
        _payload->>'title',
        _payload->>'description',
        (_payload->>'start_at')::timestamptz,
        (_payload->>'end_at')::timestamptz,
        _payload->>'event_type',
        (_payload->>'hangout_id')::uuid,
        _payload->>'location',
        _payload->>'source'
      )
      on conflict (user_id, hangout_id) where hangout_id is not null
      do update set
        title       = excluded.title,
        description = excluded.description,
        start_at    = excluded.start_at,
        end_at      = excluded.end_at,
        location    = excluded.location,
        updated_at  = now();
    end loop;
  end if;

  if old.status = 'confirmed' and new.status <> 'confirmed' then
    delete from public.calendar_events where hangout_id = new.id;
  end if;

  return new;
end;
$$;


--
-- Name: tg_push_friendship_event(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.tg_push_friendship_event() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  _requester_name text;
  _accepter_name text;
  _recipient uuid;
begin
  -- INSERT: status='pending' → notify the non-requester
  if tg_op = 'INSERT' then
    if new.status = 'pending' and new.requested_by is not null then
      _recipient := case
        when new.requested_by = new.user_a then new.user_b
        else new.user_a
      end;

      select coalesce(first_name, display_name, 'Someone') into _requester_name
      from public.profiles where id = new.requested_by;

      perform public.send_push_to_users(
        ARRAY[_recipient],
        'Friend request',
        _requester_name || ' wants to connect on ALINE',
        jsonb_build_object('type', 'friend_request', 'from_user_id', new.requested_by)
      );
    end if;
    return new;
  end if;

  -- UPDATE: pending → accepted → notify the original requester
  if tg_op = 'UPDATE'
     and new.status = 'accepted'
     and (old.status is distinct from 'accepted')
     and new.requested_by is not null then

    -- whichever user did the accepting is the OTHER one (not the requester)
    declare
      _accepter uuid := case
        when new.requested_by = new.user_a then new.user_b
        else new.user_a
      end;
    begin
      select coalesce(first_name, display_name, 'Your friend') into _accepter_name
      from public.profiles where id = _accepter;

      perform public.send_push_to_users(
        ARRAY[new.requested_by],
        'Friend request accepted',
        _accepter_name || ' is now your ALINE friend',
        jsonb_build_object('type', 'friend_accepted', 'user_id', _accepter)
      );
    end;
  end if;

  return new;
end;
$$;


--
-- Name: tg_push_hangout_proposed(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.tg_push_hangout_proposed() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  _proposer_name text;
  _group_name text;
  _recipients uuid[];
begin
  -- proposer's name
  select coalesce(first_name, display_name, '') into _proposer_name
  from public.profiles
  where id = new.proposed_by;

  -- group name
  select name into _group_name from public.groups where id = new.group_id;

  -- everyone in the group except the proposer
  select array_agg(user_id) into _recipients
  from public.group_members
  where group_id = new.group_id
    and user_id <> new.proposed_by;

  perform public.send_push_to_users(
    _recipients,
    coalesce(_proposer_name, 'Someone') || ' proposed a hangout',
    coalesce(new.title, 'Hangout') ||
      case when _group_name is not null then ' · ' || _group_name else '' end,
    jsonb_build_object(
      'type', 'hangout_proposed',
      'hangout_id', new.id,
      'group_id', new.group_id
    )
  );
  return new;
end;
$$;


--
-- Name: tg_push_hangout_status_change(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.tg_push_hangout_status_change() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  _group_name text;
  _recipients uuid[];
  _title text;
  _body text;
begin
  if new.status is not distinct from old.status then
    return new;  -- nothing changed
  end if;

  if new.status not in ('confirmed', 'cancelled') then
    return new;  -- only ping on the dramatic transitions
  end if;

  select name into _group_name from public.groups where id = new.group_id;

  select array_agg(user_id) into _recipients
  from public.group_members
  where group_id = new.group_id;

  if new.status = 'confirmed' then
    _title := 'It''s on: ' || coalesce(new.title, 'Hangout');
    _body := 'Confirmed' ||
      case when _group_name is not null then ' · ' || _group_name else '' end;
  else
    _title := 'Cancelled: ' || coalesce(new.title, 'Hangout');
    _body := case when _group_name is not null then _group_name else 'Group hangout' end;
  end if;

  perform public.send_push_to_users(
    _recipients,
    _title,
    _body,
    jsonb_build_object(
      'type', 'hangout_' || new.status,
      'hangout_id', new.id,
      'group_id', new.group_id
    )
  );
  return new;
end;
$$;


--
-- Name: tg_routine_blocks_yield(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.tg_routine_blocks_yield() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE _hit record;
BEGIN
  IF coalesce(NEW.source, 'manual') = 'routine' THEN
    RETURN NEW;  -- materializer's own rows don't evict each other
  END IF;

  FOR _hit IN
    SELECT id, external_id FROM calendar_events
     WHERE user_id = NEW.user_id
       AND source = 'routine'
       AND event_type = 'routine'
       AND start_at < NEW.end_at
       AND end_at   > NEW.start_at
  LOOP
    DELETE FROM calendar_events
     WHERE user_id = NEW.user_id AND source = 'routine'
       AND (id = _hit.id
            OR external_id = _hit.external_id || ':pre'
            OR external_id = _hit.external_id || ':post');
  END LOOP;

  -- A real event overlapping just a transit sliver evicts that sliver too.
  DELETE FROM calendar_events
   WHERE user_id = NEW.user_id AND source = 'routine' AND event_type = 'transit'
     AND start_at < NEW.end_at AND end_at > NEW.start_at;

  RETURN NEW;
END;
$$;


--
-- Name: travel_mode_for(uuid, timestamp with time zone, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.travel_mode_for(_user uuid, _from timestamp with time zone, _to timestamp with time zone) RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select ma.kind from motion_activity ma
   where ma.user_id = _user and ma.kind <> 'stationary'
     and ma.started_at < _to and ma.ended_at > _from
   group by ma.kind
   order by sum(extract(epoch from least(ma.ended_at, _to) - greatest(ma.started_at, _from))) desc
   limit 1
$$;


--
-- Name: try_proactive_push(uuid, text, text, text, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.try_proactive_push(_user uuid, _kind text, _dedupe text, _title text, _body text, _data jsonb DEFAULT '{}'::jsonb) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  _tz      text;
  _min     int;           -- local minute-of-day
  _bed     int; _wake int; _quality text;
  _asleep  boolean := false;
  _today   int;
  _mid     uuid;
BEGIN
  SELECT timezone INTO _tz FROM profiles WHERE id = _user;
  IF coalesce(_tz,'') = '' THEN RETURN false; END IF;
  _min := extract(hour FROM (now() AT TIME ZONE _tz))::int * 60
        + extract(minute FROM (now() AT TIME ZONE _tz))::int;

  SELECT bedtime_minute, waketime_minute, data_quality
    INTO _bed, _wake, _quality FROM behavioral_summary WHERE user_id = _user;

  IF _quality = 'high' AND _bed IS NOT NULL AND _wake IS NOT NULL THEN
    IF _bed > _wake THEN _asleep := (_min >= _bed OR _min < _wake);
    ELSE _asleep := (_min >= _bed AND _min < _wake);
    END IF;
  ELSE
    _asleep := (_min >= 22*60 OR _min < 8*60);  -- default quiet hours
  END IF;
  IF _asleep THEN RETURN false; END IF;

  SELECT count(*) INTO _today FROM proactive_pushes
   WHERE user_id = _user
     AND sent_at >= (date_trunc('day', now() AT TIME ZONE _tz) AT TIME ZONE _tz);
  IF _today >= 3 THEN RETURN false; END IF;

  INSERT INTO proactive_pushes (user_id, kind, dedupe_key)
  VALUES (_user, _kind, _dedupe)
  ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN RETURN false; END IF;   -- already sent this one

  -- Land the nudge in the agent chat thread + deep-link the push to it.
  _mid := public.log_agent_message(_user, _body, _kind, _data);
  _data := coalesce(_data, '{}'::jsonb) || jsonb_build_object('chat_message_id', _mid);

  PERFORM public.send_push_to_users(
    _user_ids => ARRAY[_user], _title => _title, _body => _body, _data => _data);
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'try_proactive_push failed silently: %', sqlerrm;
  RETURN false;
END $$;


--
-- Name: unfriend(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.unfriend(_other_user uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  _user_id uuid := auth.uid();
  _a uuid := least(auth.uid(), _other_user);
  _b uuid := greatest(auth.uid(), _other_user);
begin
  if _user_id is null then
    raise exception 'Not authenticated';
  end if;
  delete from public.friendships where user_a = _a and user_b = _b;
end;
$$;


--
-- Name: update_hangout(uuid, timestamp with time zone, timestamp with time zone, text, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_hangout(_hangout_id uuid, _new_start timestamp with time zone DEFAULT NULL::timestamp with time zone, _new_end timestamp with time zone DEFAULT NULL::timestamp with time zone, _new_title text DEFAULT NULL::text, _new_venue_name text DEFAULT NULL::text, _new_venue_addr text DEFAULT NULL::text, _new_description text DEFAULT NULL::text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  caller        uuid := auth.uid();
  h             public.hangouts%ROWTYPE;
  time_changed  boolean := false;
BEGIN
  IF caller IS NULL THEN
    RAISE EXCEPTION 'auth required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO h FROM public.hangouts WHERE id = _hangout_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'hangout not found' USING ERRCODE = '42704';
  END IF;
  IF h.proposed_by <> caller THEN
    RAISE EXCEPTION 'only the proposer can update this hangout' USING ERRCODE = '42501';
  END IF;
  IF h.status = 'cancelled' THEN
    RAISE EXCEPTION 'cannot update a cancelled hangout' USING ERRCODE = '22023';
  END IF;

  IF _new_start IS NOT NULL AND _new_start IS DISTINCT FROM h.proposed_start THEN
    time_changed := true;
  END IF;
  IF _new_end IS NOT NULL AND _new_end IS DISTINCT FROM h.proposed_end THEN
    time_changed := true;
  END IF;

  UPDATE public.hangouts SET
    proposed_start = COALESCE(_new_start, proposed_start),
    proposed_end   = COALESCE(_new_end, proposed_end),
    title          = COALESCE(_new_title, title),
    venue_name     = COALESCE(_new_venue_name, venue_name),
    venue_address  = COALESCE(_new_venue_addr, venue_address),
    description    = COALESCE(_new_description, description),
    status         = CASE WHEN time_changed THEN 'proposing' ELSE status END,
    updated_at     = now()
  WHERE id = _hangout_id;

  -- If time changed, reset other participants' RSVPs (proposer stays confirmed)
  IF time_changed THEN
    UPDATE public.hangout_responses
       SET status = 'pending',
           responded_at = NULL
     WHERE hangout_id = _hangout_id
       AND user_id <> caller;
  END IF;
END;
$$;


--
-- Name: was_moving(uuid, timestamp with time zone, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.was_moving(_user uuid, _from timestamp with time zone, _to timestamp with time zone) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select coalesce(sum(extract(epoch from least(ma.ended_at, _to) - greatest(ma.started_at, _from))), 0)
         >= 0.5 * greatest(extract(epoch from _to - _from), 1)
    from motion_activity ma
   where ma.user_id = _user and ma.kind in ('walking','running','cycling','driving')
     and ma.started_at < _to and ma.ended_at > _from
$$;


--
-- Name: activity_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.activity_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    source_kind text NOT NULL,
    source_id uuid,
    place_id uuid,
    expected_category text,
    scheduled_start timestamp with time zone NOT NULL,
    scheduled_end timestamp with time zone NOT NULL,
    result text NOT NULL,
    confirmed_by text,
    actual_label text,
    last_asked_at timestamp with time zone,
    checked_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    event_id uuid,
    predicted_place_id uuid,
    prediction_confidence real,
    actual_place_id uuid,
    live_status text,
    evaluated_at timestamp with time zone,
    CONSTRAINT activity_log_confirmed_by_check CHECK ((confirmed_by = ANY (ARRAY['auto'::text, 'user'::text, 'healthkit'::text]))),
    CONSTRAINT activity_log_live_status_check CHECK (((live_status IS NULL) OR (live_status = ANY (ARRAY['on_track'::text, 'late_incoming'::text, 'likely_skip'::text, 'unknown_location'::text, 'unknown'::text])))),
    CONSTRAINT activity_log_result_check CHECK ((result = ANY (ARRAY['done'::text, 'skipped'::text, 'elsewhere'::text, 'unknown'::text, 'needs_confirm'::text]))),
    CONSTRAINT activity_log_source_kind_check CHECK ((source_kind = ANY (ARRAY['routine'::text, 'goal'::text])))
);


--
-- Name: activity_patterns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.activity_patterns (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    activity_key text NOT NULL,
    day_of_week integer NOT NULL,
    time_bucket integer NOT NULL,
    place_id uuid,
    count integer DEFAULT 0 NOT NULL,
    confidence real DEFAULT 0 NOT NULL,
    last_seen timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: app_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_config (
    key text NOT NULL,
    value text NOT NULL
);


--
-- Name: app_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    opened_at timestamp with time zone DEFAULT now() NOT NULL,
    duration_seconds integer,
    source text DEFAULT 'foreground'::text NOT NULL,
    CONSTRAINT app_sessions_source_check CHECK ((source = ANY (ARRAY['cold_start'::text, 'background_resume'::text, 'notification_tap'::text, 'foreground'::text])))
);


--
-- Name: behavioral_pings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.behavioral_pings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    captured_at timestamp with time zone NOT NULL,
    geohash_8 text NOT NULL,
    motion_state text,
    battery_level real,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    source text,
    speed_mps real,
    battery_state text,
    network_type text,
    wifi_bssid_hash text,
    wifi_ssid_hash text,
    device_id text,
    CONSTRAINT behavioral_pings_battery_state_check CHECK ((battery_state = ANY (ARRAY['unplugged'::text, 'charging'::text, 'full'::text, 'unknown'::text]))),
    CONSTRAINT behavioral_pings_motion_state_check CHECK ((motion_state = ANY (ARRAY['stationary'::text, 'walking'::text, 'active'::text, 'running'::text, 'cycling'::text, 'driving'::text, 'unknown'::text]))),
    CONSTRAINT behavioral_pings_network_type_check CHECK ((network_type = ANY (ARRAY['wifi'::text, 'cellular'::text, 'none'::text, 'other'::text])))
);


--
-- Name: COLUMN behavioral_pings.motion_state; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.behavioral_pings.motion_state IS 'Speed buckets: <0.3 stationary, 0.3-1.5 walking, 1.5-7 active (running OR cycling, indistinguishable by speed), >7 driving. running/cycling reserved for pedometer disambiguation.';


--
-- Name: COLUMN behavioral_pings.source; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.behavioral_pings.source IS 'Origin of the ping: movement | periodic | foreground | geofence. NULL for pre-provenance rows.';


--
-- Name: COLUMN behavioral_pings.speed_mps; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.behavioral_pings.speed_mps IS 'Raw OS-reported ground speed (m/s) at capture; NULL when the fix had no valid speed. motion_state is derived from it client-side.';


--
-- Name: behavioral_summary; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.behavioral_summary (
    user_id uuid NOT NULL,
    archetype_text text,
    chronotype text,
    bedtime_minute smallint,
    waketime_minute smallint,
    weekly_workout_count real,
    avg_daily_steps real,
    data_quality text DEFAULT 'none'::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT behavioral_summary_bedtime_minute_check CHECK (((bedtime_minute >= 0) AND (bedtime_minute <= 1439))),
    CONSTRAINT behavioral_summary_chronotype_check CHECK ((chronotype = ANY (ARRAY['early_bird'::text, 'night_owl'::text, 'intermediate'::text]))),
    CONSTRAINT behavioral_summary_data_quality_check CHECK ((data_quality = ANY (ARRAY['none'::text, 'low'::text, 'medium'::text, 'high'::text]))),
    CONSTRAINT behavioral_summary_waketime_minute_check CHECK (((waketime_minute >= 0) AND (waketime_minute <= 1439)))
);


--
-- Name: calendar_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.calendar_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    external_id text,
    source text DEFAULT 'manual'::text,
    title text,
    description text,
    start_at timestamp with time zone NOT NULL,
    end_at timestamp with time zone NOT NULL,
    location text,
    event_type text DEFAULT 'fixed'::text,
    hangout_id uuid,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    is_movable boolean DEFAULT false NOT NULL,
    original_start_at timestamp with time zone,
    google_synced_at timestamp with time zone,
    goal_id uuid,
    goal_plan_id uuid,
    local_event_id uuid,
    health_workout_id uuid,
    CONSTRAINT calendar_events_event_type_check CHECK ((event_type = ANY (ARRAY['fixed'::text, 'flexible'::text, 'goal'::text, 'coordinated'::text, 'routine'::text, 'transit'::text]))),
    CONSTRAINT calendar_events_source_check CHECK ((source = ANY (ARRAY['google'::text, 'apple'::text, 'manual'::text, 'aline'::text, 'routine'::text, 'healthkit'::text])))
);


--
-- Name: COLUMN calendar_events.google_synced_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.calendar_events.google_synced_at IS 'Last time this ALINE-origin event was pushed to Google. NULL = never pushed.';


--
-- Name: change_sets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.change_sets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    chat_message_id uuid,
    operations jsonb NOT NULL,
    reasoning text,
    status text DEFAULT 'pending'::text NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '24:00:00'::interval) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT change_sets_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'rejected'::text, 'expired'::text, 'superseded'::text])))
);


--
-- Name: chat_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    role text NOT NULL,
    content text NOT NULL,
    extracted_data jsonb,
    context_snapshot jsonb,
    input_tokens integer,
    output_tokens integer,
    model text,
    created_at timestamp with time zone DEFAULT now(),
    goal_plan_id uuid,
    image_url text,
    event_ids uuid[],
    CONSTRAINT chat_messages_role_check CHECK ((role = ANY (ARRAY['user'::text, 'agent'::text, 'system'::text])))
);


--
-- Name: collection_health; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.collection_health (
    user_id uuid NOT NULL,
    app_build text,
    os_version text,
    location_fg text,
    location_bg text,
    location_precise boolean,
    background_refresh text,
    location_task_running boolean,
    geofencing_running boolean,
    periodic_task_registered boolean,
    calendar_permission text,
    motion_permission text,
    last_steps_synced_hour timestamp with time zone,
    reported_at timestamp with time zone DEFAULT now() NOT NULL,
    device_id text DEFAULT 'unknown'::text NOT NULL,
    wifi_probe text,
    health_connected boolean,
    visits_monitoring boolean,
    visits_queued integer,
    motion_activity_available boolean,
    last_motion_synced_at timestamp with time zone
);


--
-- Name: events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text NOT NULL,
    description text,
    venue_id uuid,
    venue_text text,
    lat double precision,
    lon double precision,
    starts_at timestamp with time zone NOT NULL,
    ends_at timestamp with time zone,
    category text,
    price_text text,
    url text,
    visibility text DEFAULT 'public'::text NOT NULL,
    status text DEFAULT 'scheduled'::text NOT NULL,
    source text DEFAULT 'manual'::text NOT NULL,
    source_id text,
    created_by uuid NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    image_url text,
    CONSTRAINT events_status_check CHECK ((status = ANY (ARRAY['scheduled'::text, 'cancelled'::text]))),
    CONSTRAINT events_visibility_check CHECK ((visibility = ANY (ARRAY['public'::text, 'friends'::text, 'private'::text])))
);


--
-- Name: friendships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.friendships (
    user_a uuid NOT NULL,
    user_b uuid NOT NULL,
    status text NOT NULL,
    requested_by uuid,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    tier_a text DEFAULT 'friend'::text NOT NULL,
    tier_b text DEFAULT 'friend'::text NOT NULL,
    CONSTRAINT friendships_check CHECK ((user_a < user_b)),
    CONSTRAINT friendships_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'blocked'::text]))),
    CONSTRAINT friendships_tier_a_check CHECK ((tier_a = ANY (ARRAY['friend'::text, 'inner'::text]))),
    CONSTRAINT friendships_tier_b_check CHECK ((tier_b = ANY (ARRAY['friend'::text, 'inner'::text])))
);


--
-- Name: goal_plans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.goal_plans (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    goal_id uuid NOT NULL,
    user_id uuid NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    plan_spec jsonb DEFAULT '{}'::jsonb NOT NULL,
    prev_spec jsonb,
    rationale text,
    committed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT goal_plans_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'live'::text, 'archived'::text])))
);


--
-- Name: goals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.goals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    title text NOT NULL,
    category text,
    status text DEFAULT 'active'::text,
    is_aspirational boolean DEFAULT false,
    target_date date,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    target_per_week real,
    last_completed_at timestamp with time zone,
    CONSTRAINT goals_status_check CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text, 'achieved'::text, 'abandoned'::text])))
);


--
-- Name: google_oauth_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.google_oauth_tokens (
    user_id uuid NOT NULL,
    access_token text NOT NULL,
    refresh_token text NOT NULL,
    token_expires_at timestamp with time zone NOT NULL,
    scope text,
    last_synced_at timestamp with time zone,
    last_sync_error text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: group_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.group_members (
    group_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text DEFAULT 'member'::text,
    joined_at timestamp with time zone DEFAULT now(),
    trust_tier text DEFAULT 'friends'::text,
    muted_until timestamp with time zone,
    CONSTRAINT group_members_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'member'::text]))),
    CONSTRAINT group_members_trust_tier_check CHECK ((trust_tier = ANY (ARRAY['friends'::text, 'inner_circle'::text])))
);


--
-- Name: groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.groups (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    description text,
    created_by uuid NOT NULL,
    group_type text DEFAULT 'friends'::text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT groups_group_type_check CHECK ((group_type = ANY (ARRAY['friends'::text, 'family'::text, 'activity'::text, 'study'::text, 'other'::text])))
);


--
-- Name: hangout_responses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hangout_responses (
    hangout_id uuid NOT NULL,
    user_id uuid NOT NULL,
    status text DEFAULT 'pending'::text,
    note text,
    responded_at timestamp with time zone,
    CONSTRAINT hangout_responses_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'confirmed'::text, 'declined'::text, 'maybe'::text])))
);


--
-- Name: health_sleep; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.health_sleep (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    external_id text NOT NULL,
    stage text NOT NULL,
    started_at timestamp with time zone NOT NULL,
    ended_at timestamp with time zone NOT NULL,
    source_name text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT health_sleep_stage_check CHECK ((stage = ANY (ARRAY['in_bed'::text, 'asleep'::text, 'awake'::text, 'core'::text, 'deep'::text, 'rem'::text])))
);


--
-- Name: health_workouts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.health_workouts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    source text DEFAULT 'healthkit'::text NOT NULL,
    external_id text NOT NULL,
    activity_type text NOT NULL,
    raw_activity_type text,
    started_at timestamp with time zone NOT NULL,
    ended_at timestamp with time zone NOT NULL,
    duration_min numeric,
    energy_kcal numeric,
    distance_m numeric,
    avg_heart_rate numeric,
    max_heart_rate numeric,
    device text,
    matched_event_id uuid,
    matched_goal_id uuid,
    match_kind text,
    reconciled_at timestamp with time zone,
    imported_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT health_workouts_match_kind_check CHECK ((match_kind = ANY (ARRAY['planned'::text, 'unplanned'::text, 'ambiguous'::text, 'none'::text])))
);


--
-- Name: interests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.interests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    key text NOT NULL,
    value jsonb NOT NULL,
    source text DEFAULT 'chat'::text,
    confidence numeric(3,2) DEFAULT 0.80,
    active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    evidence_days date[] DEFAULT '{}'::date[] NOT NULL,
    stated boolean DEFAULT false NOT NULL,
    CONSTRAINT interests_source_check CHECK ((source = ANY (ARRAY['onboarding'::text, 'chat'::text, 'inferred'::text, 'manual'::text])))
);


--
-- Name: motion_activity; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.motion_activity (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    device_id text,
    started_at timestamp with time zone NOT NULL,
    ended_at timestamp with time zone NOT NULL,
    kind text NOT NULL,
    confidence smallint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT motion_activity_confidence_check CHECK (((confidence >= 0) AND (confidence <= 2))),
    CONSTRAINT motion_activity_kind_check CHECK ((kind = ANY (ARRAY['stationary'::text, 'walking'::text, 'running'::text, 'cycling'::text, 'driving'::text])))
);


--
-- Name: places; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.places (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    google_place_id text,
    name text,
    primary_type text,
    category text,
    geohash_5 text NOT NULL,
    geohash_7 text NOT NULL,
    visit_count integer DEFAULT 1 NOT NULL,
    first_seen timestamp with time zone DEFAULT now() NOT NULL,
    last_seen timestamp with time zone DEFAULT now() NOT NULL,
    user_label text,
    is_hidden boolean DEFAULT false NOT NULL,
    is_sensitive boolean DEFAULT false NOT NULL,
    inference_status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_asked_at timestamp with time zone,
    confidence real,
    ping_count integer DEFAULT 0 NOT NULL,
    centroid_lat double precision,
    centroid_lon double precision,
    total_dwell_minutes real,
    CONSTRAINT places_inference_status_check CHECK ((inference_status = ANY (ARRAY['pending'::text, 'confirmed'::text, 'corrected'::text])))
);


--
-- Name: COLUMN places.centroid_lat; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.places.centroid_lat IS 'Precise cluster centroid latitude (mean of member pings). Used as Google Places search center. Falls back to geohash_7 decode when null (legacy rows).';


--
-- Name: COLUMN places.centroid_lon; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.places.centroid_lon IS 'Precise cluster centroid longitude. See centroid_lat.';


--
-- Name: COLUMN places.total_dwell_minutes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.places.total_dwell_minutes IS 'Sum of intra-visit dwell minutes over the clustering window. Significance signal; NULL for rows not yet recomputed by the build-19 client.';


--
-- Name: proactive_pushes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.proactive_pushes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    kind text NOT NULL,
    dedupe_key text NOT NULL,
    sent_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.profiles (
    id uuid NOT NULL,
    display_name text,
    first_name text,
    timezone text DEFAULT 'Europe/Ljubljana'::text,
    social_openness text DEFAULT 'crew_only'::text,
    onboarding_complete boolean DEFAULT false,
    archetype_summary text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    handle text,
    expo_push_token text,
    push_notifications_enabled boolean DEFAULT false NOT NULL,
    push_token_updated_at timestamp with time zone,
    last_morning_push_at timestamp with time zone,
    health_connected boolean DEFAULT false NOT NULL,
    CONSTRAINT profiles_handle_format CHECK (((handle IS NULL) OR (handle ~ '^[a-z][a-z0-9_]{2,19}$'::text))),
    CONSTRAINT profiles_social_openness_check CHECK ((social_openness = ANY (ARRAY['closed'::text, 'crew_only'::text, 'open'::text])))
);


--
-- Name: COLUMN profiles.last_morning_push_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.profiles.last_morning_push_at IS 'When the morning_push edge function last delivered a push to this user. Used as idempotency key so hourly cron runs do not double-push.';


--
-- Name: reminders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reminders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    content text NOT NULL,
    remind_at timestamp with time zone NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT reminders_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'sent'::text, 'cancelled'::text])))
);


--
-- Name: routines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.routines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    place_id uuid,
    category text,
    day_of_week smallint,
    start_minute smallint,
    end_minute smallint,
    consistency real,
    last_observed timestamp with time zone,
    active boolean DEFAULT true NOT NULL,
    inference_status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_asked_at timestamp with time zone,
    CONSTRAINT routines_consistency_check CHECK (((consistency >= (0)::double precision) AND (consistency <= (1)::double precision))),
    CONSTRAINT routines_day_of_week_check CHECK (((day_of_week >= 0) AND (day_of_week <= 6))),
    CONSTRAINT routines_end_minute_check CHECK (((end_minute >= 0) AND (end_minute <= 1439))),
    CONSTRAINT routines_inference_status_check CHECK ((inference_status = ANY (ARRAY['pending'::text, 'confirmed'::text, 'corrected'::text]))),
    CONSTRAINT routines_start_minute_check CHECK (((start_minute >= 0) AND (start_minute <= 1439)))
);


--
-- Name: schedule_suggestions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schedule_suggestions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    goal_plan_id uuid NOT NULL,
    goal_id uuid,
    session_activity text NOT NULL,
    from_start text NOT NULL,
    to_start text NOT NULL,
    from_duration integer NOT NULL,
    to_duration integer NOT NULL,
    evidence jsonb,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    CONSTRAINT schedule_suggestions_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'declined'::text, 'expired'::text])))
);


--
-- Name: stay_names; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stay_names (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    lat double precision NOT NULL,
    lon double precision NOT NULL,
    name text,
    primary_type text,
    types text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: step_counts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.step_counts (
    user_id uuid NOT NULL,
    hour_start timestamp with time zone NOT NULL,
    steps integer NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT step_counts_steps_check CHECK ((steps >= 0))
);


--
-- Name: system_health_probes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.system_health_probes (
    id bigint NOT NULL,
    service text NOT NULL,
    ok boolean NOT NULL,
    detail text,
    checked_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: system_health_probes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.system_health_probes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: system_health_probes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.system_health_probes_id_seq OWNED BY public.system_health_probes.id;


--
-- Name: system_health_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.system_health_runs (
    id bigint NOT NULL,
    ran_at timestamp with time zone DEFAULT now() NOT NULL,
    problems jsonb NOT NULL,
    notified boolean DEFAULT false NOT NULL
);


--
-- Name: system_health_runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.system_health_runs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: system_health_runs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.system_health_runs_id_seq OWNED BY public.system_health_runs.id;


--
-- Name: venues; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.venues (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    lat double precision,
    lon double precision,
    address text,
    category text,
    google_place_id text,
    claimed_by uuid,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: visits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.visits (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    kind text NOT NULL,
    arrived_at timestamp with time zone NOT NULL,
    left_at timestamp with time zone NOT NULL,
    left_by timestamp with time zone,
    is_open boolean DEFAULT false NOT NULL,
    geohash_7 text,
    ping_count integer DEFAULT 0 NOT NULL,
    travel_mode text,
    from_visit_id uuid,
    to_visit_id uuid,
    place_id uuid,
    activity text,
    activity_source text,
    activity_confidence real,
    event_id uuid,
    health_workout_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT visits_activity_source_check CHECK ((activity_source = ANY (ARRAY['healthkit'::text, 'calendar'::text, 'routine'::text, 'place'::text, 'user'::text]))),
    CONSTRAINT visits_kind_check CHECK ((kind = ANY (ARRAY['stay'::text, 'travel'::text])))
);


--
-- Name: wifi_networks; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.wifi_networks WITH (security_invoker='true') AS
 SELECT bp.user_id,
    bp.wifi_bssid_hash,
    min(bp.wifi_ssid_hash) AS wifi_ssid_hash,
    count(*) AS pings,
    count(DISTINCT ((bp.captured_at AT TIME ZONE COALESCE(p.timezone, 'UTC'::text)))::date) AS days_seen,
    round(avg(
        CASE
            WHEN (EXTRACT(hour FROM (bp.captured_at AT TIME ZONE COALESCE(p.timezone, 'UTC'::text))) < (6)::numeric) THEN 1
            ELSE 0
        END), 2) AS night_share,
    mode() WITHIN GROUP (ORDER BY ("left"(bp.geohash_8, 7))) AS geohash_7,
    min(bp.captured_at) AS first_seen,
    max(bp.captured_at) AS last_seen
   FROM (public.behavioral_pings bp
     LEFT JOIN public.profiles p ON ((p.id = bp.user_id)))
  WHERE (bp.wifi_bssid_hash IS NOT NULL)
  GROUP BY bp.user_id, bp.wifi_bssid_hash;


--
-- Name: system_health_probes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_health_probes ALTER COLUMN id SET DEFAULT nextval('public.system_health_probes_id_seq'::regclass);


--
-- Name: system_health_runs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_health_runs ALTER COLUMN id SET DEFAULT nextval('public.system_health_runs_id_seq'::regclass);


--
-- Name: activity_log activity_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activity_log
    ADD CONSTRAINT activity_log_pkey PRIMARY KEY (id);


--
-- Name: activity_log activity_log_user_id_source_kind_source_id_scheduled_start_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activity_log
    ADD CONSTRAINT activity_log_user_id_source_kind_source_id_scheduled_start_key UNIQUE (user_id, source_kind, source_id, scheduled_start);


--
-- Name: activity_patterns activity_patterns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activity_patterns
    ADD CONSTRAINT activity_patterns_pkey PRIMARY KEY (id);


--
-- Name: app_config app_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_config
    ADD CONSTRAINT app_config_pkey PRIMARY KEY (key);


--
-- Name: app_sessions app_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_sessions
    ADD CONSTRAINT app_sessions_pkey PRIMARY KEY (id);


--
-- Name: behavioral_pings behavioral_pings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.behavioral_pings
    ADD CONSTRAINT behavioral_pings_pkey PRIMARY KEY (id);


--
-- Name: behavioral_summary behavioral_summary_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.behavioral_summary
    ADD CONSTRAINT behavioral_summary_pkey PRIMARY KEY (user_id);


--
-- Name: calendar_events calendar_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_events
    ADD CONSTRAINT calendar_events_pkey PRIMARY KEY (id);


--
-- Name: calendar_events calendar_events_user_source_external_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_events
    ADD CONSTRAINT calendar_events_user_source_external_id_key UNIQUE (user_id, source, external_id);


--
-- Name: change_sets change_sets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.change_sets
    ADD CONSTRAINT change_sets_pkey PRIMARY KEY (id);


--
-- Name: chat_messages chat_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_pkey PRIMARY KEY (id);


--
-- Name: collection_health collection_health_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.collection_health
    ADD CONSTRAINT collection_health_pkey PRIMARY KEY (user_id, device_id);


--
-- Name: events events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_pkey PRIMARY KEY (id);


--
-- Name: friendships friendships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.friendships
    ADD CONSTRAINT friendships_pkey PRIMARY KEY (user_a, user_b);


--
-- Name: goal_plans goal_plans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.goal_plans
    ADD CONSTRAINT goal_plans_pkey PRIMARY KEY (id);


--
-- Name: goals goals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.goals
    ADD CONSTRAINT goals_pkey PRIMARY KEY (id);


--
-- Name: google_oauth_tokens google_oauth_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.google_oauth_tokens
    ADD CONSTRAINT google_oauth_tokens_pkey PRIMARY KEY (user_id);


--
-- Name: group_members group_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_members
    ADD CONSTRAINT group_members_pkey PRIMARY KEY (group_id, user_id);


--
-- Name: groups groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.groups
    ADD CONSTRAINT groups_pkey PRIMARY KEY (id);


--
-- Name: hangout_responses hangout_responses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hangout_responses
    ADD CONSTRAINT hangout_responses_pkey PRIMARY KEY (hangout_id, user_id);


--
-- Name: hangouts hangouts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hangouts
    ADD CONSTRAINT hangouts_pkey PRIMARY KEY (id);


--
-- Name: health_sleep health_sleep_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.health_sleep
    ADD CONSTRAINT health_sleep_pkey PRIMARY KEY (id);


--
-- Name: health_sleep health_sleep_user_id_external_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.health_sleep
    ADD CONSTRAINT health_sleep_user_id_external_id_key UNIQUE (user_id, external_id);


--
-- Name: health_workouts health_workouts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.health_workouts
    ADD CONSTRAINT health_workouts_pkey PRIMARY KEY (id);


--
-- Name: health_workouts health_workouts_user_id_external_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.health_workouts
    ADD CONSTRAINT health_workouts_user_id_external_id_key UNIQUE (user_id, external_id);


--
-- Name: interests interests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.interests
    ADD CONSTRAINT interests_pkey PRIMARY KEY (id);


--
-- Name: motion_activity motion_activity_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.motion_activity
    ADD CONSTRAINT motion_activity_pkey PRIMARY KEY (id);


--
-- Name: motion_activity motion_activity_user_id_started_at_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.motion_activity
    ADD CONSTRAINT motion_activity_user_id_started_at_key UNIQUE (user_id, started_at);


--
-- Name: places places_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.places
    ADD CONSTRAINT places_pkey PRIMARY KEY (id);


--
-- Name: proactive_pushes proactive_pushes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.proactive_pushes
    ADD CONSTRAINT proactive_pushes_pkey PRIMARY KEY (id);


--
-- Name: proactive_pushes proactive_pushes_user_id_dedupe_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.proactive_pushes
    ADD CONSTRAINT proactive_pushes_user_id_dedupe_key_key UNIQUE (user_id, dedupe_key);


--
-- Name: profiles profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);


--
-- Name: reminders reminders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reminders
    ADD CONSTRAINT reminders_pkey PRIMARY KEY (id);


--
-- Name: routines routines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.routines
    ADD CONSTRAINT routines_pkey PRIMARY KEY (id);


--
-- Name: schedule_suggestions schedule_suggestions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule_suggestions
    ADD CONSTRAINT schedule_suggestions_pkey PRIMARY KEY (id);


--
-- Name: stay_names stay_names_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stay_names
    ADD CONSTRAINT stay_names_pkey PRIMARY KEY (id);


--
-- Name: step_counts step_counts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.step_counts
    ADD CONSTRAINT step_counts_pkey PRIMARY KEY (user_id, hour_start);


--
-- Name: system_health_probes system_health_probes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_health_probes
    ADD CONSTRAINT system_health_probes_pkey PRIMARY KEY (id);


--
-- Name: system_health_runs system_health_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_health_runs
    ADD CONSTRAINT system_health_runs_pkey PRIMARY KEY (id);


--
-- Name: venues venues_google_place_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.venues
    ADD CONSTRAINT venues_google_place_id_key UNIQUE (google_place_id);


--
-- Name: venues venues_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.venues
    ADD CONSTRAINT venues_pkey PRIMARY KEY (id);


--
-- Name: visits visits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.visits
    ADD CONSTRAINT visits_pkey PRIMARY KEY (id);


--
-- Name: activity_log_event_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX activity_log_event_id_key ON public.activity_log USING btree (event_id);


--
-- Name: activity_log_user_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX activity_log_user_pending_idx ON public.activity_log USING btree (user_id, result) WHERE (result = 'needs_confirm'::text);


--
-- Name: activity_patterns_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX activity_patterns_key ON public.activity_patterns USING btree (user_id, activity_key, day_of_week, time_bucket, place_id) WHERE (place_id IS NOT NULL);


--
-- Name: activity_patterns_key_noplace; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX activity_patterns_key_noplace ON public.activity_patterns USING btree (user_id, activity_key, day_of_week, time_bucket) WHERE (place_id IS NULL);


--
-- Name: app_sessions_user_opened_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX app_sessions_user_opened_idx ON public.app_sessions USING btree (user_id, opened_at DESC);


--
-- Name: behavioral_pings_user_captured; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX behavioral_pings_user_captured ON public.behavioral_pings USING btree (user_id, captured_at DESC);


--
-- Name: behavioral_pings_wifi_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX behavioral_pings_wifi_idx ON public.behavioral_pings USING btree (wifi_bssid_hash, captured_at) WHERE (wifi_bssid_hash IS NOT NULL);


--
-- Name: calendar_events_goal_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX calendar_events_goal_idx ON public.calendar_events USING btree (goal_id) WHERE (goal_id IS NOT NULL);


--
-- Name: calendar_events_local_event_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX calendar_events_local_event_idx ON public.calendar_events USING btree (local_event_id) WHERE (local_event_id IS NOT NULL);


--
-- Name: calendar_events_user_hangout_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX calendar_events_user_hangout_unique ON public.calendar_events USING btree (user_id, hangout_id) WHERE (hangout_id IS NOT NULL);


--
-- Name: calendar_events_user_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX calendar_events_user_time_idx ON public.calendar_events USING btree (user_id, start_at);


--
-- Name: change_sets_user_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX change_sets_user_status_idx ON public.change_sets USING btree (user_id, status, created_at DESC);


--
-- Name: chat_messages_user_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chat_messages_user_time_idx ON public.chat_messages USING btree (user_id, created_at DESC);


--
-- Name: events_created_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX events_created_by_idx ON public.events USING btree (created_by);


--
-- Name: events_starts_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX events_starts_at_idx ON public.events USING btree (starts_at) WHERE (status = 'scheduled'::text);


--
-- Name: friendships_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX friendships_status_idx ON public.friendships USING btree (status);


--
-- Name: friendships_user_a_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX friendships_user_a_idx ON public.friendships USING btree (user_a);


--
-- Name: friendships_user_b_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX friendships_user_b_idx ON public.friendships USING btree (user_b);


--
-- Name: goal_plans_one_active_per_goal; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX goal_plans_one_active_per_goal ON public.goal_plans USING btree (goal_id) WHERE (status <> 'archived'::text);


--
-- Name: goal_plans_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX goal_plans_user_idx ON public.goal_plans USING btree (user_id, updated_at DESC);


--
-- Name: goals_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX goals_user_id_idx ON public.goals USING btree (user_id);


--
-- Name: group_members_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX group_members_user_id_idx ON public.group_members USING btree (user_id);


--
-- Name: groups_created_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX groups_created_by_idx ON public.groups USING btree (created_by);


--
-- Name: hangout_responses_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX hangout_responses_user_id_idx ON public.hangout_responses USING btree (user_id);


--
-- Name: hangouts_direct_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX hangouts_direct_user_idx ON public.hangouts USING btree (direct_user_id) WHERE (direct_user_id IS NOT NULL);


--
-- Name: hangouts_group_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX hangouts_group_id_idx ON public.hangouts USING btree (group_id);


--
-- Name: hangouts_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX hangouts_status_idx ON public.hangouts USING btree (status) WHERE (status = ANY (ARRAY['proposing'::text, 'confirmed'::text]));


--
-- Name: health_sleep_user_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX health_sleep_user_time_idx ON public.health_sleep USING btree (user_id, started_at);


--
-- Name: health_workouts_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX health_workouts_pending_idx ON public.health_workouts USING btree (user_id) WHERE (reconciled_at IS NULL);


--
-- Name: health_workouts_user_started_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX health_workouts_user_started_idx ON public.health_workouts USING btree (user_id, started_at DESC);


--
-- Name: interests_key_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX interests_key_idx ON public.interests USING btree (user_id, key) WHERE (active = true);


--
-- Name: interests_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX interests_user_id_idx ON public.interests USING btree (user_id);


--
-- Name: motion_activity_user_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX motion_activity_user_time ON public.motion_activity USING btree (user_id, started_at DESC);


--
-- Name: places_user_geohash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX places_user_geohash ON public.places USING btree (user_id, geohash_5);


--
-- Name: profiles_handle_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX profiles_handle_unique ON public.profiles USING btree (handle) WHERE (handle IS NOT NULL);


--
-- Name: profiles_push_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX profiles_push_active_idx ON public.profiles USING btree (id) WHERE ((expo_push_token IS NOT NULL) AND (push_notifications_enabled = true));


--
-- Name: reminders_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reminders_due_idx ON public.reminders USING btree (status, remind_at) WHERE (status = 'pending'::text);


--
-- Name: routines_user_place; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX routines_user_place ON public.routines USING btree (user_id, place_id);


--
-- Name: schedule_suggestions_user_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX schedule_suggestions_user_status_idx ON public.schedule_suggestions USING btree (user_id, status);


--
-- Name: stay_names_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX stay_names_user ON public.stay_names USING btree (user_id);


--
-- Name: venues_google_place_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX venues_google_place_id_idx ON public.venues USING btree (google_place_id);


--
-- Name: visits_user_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX visits_user_time_idx ON public.visits USING btree (user_id, arrived_at);


--
-- Name: profiles auto_friend_new_profile; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER auto_friend_new_profile AFTER INSERT ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.auto_friend_new_profile();


--
-- Name: calendar_events calendar_events_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER calendar_events_updated_at BEFORE UPDATE ON public.calendar_events FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: friendships friendships_push_on_accept; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER friendships_push_on_accept AFTER UPDATE OF status ON public.friendships FOR EACH ROW EXECUTE FUNCTION public.notify_friendship_accepted();


--
-- Name: friendships friendships_push_on_request; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER friendships_push_on_request AFTER INSERT ON public.friendships FOR EACH ROW EXECUTE FUNCTION public.notify_friendship_requested();


--
-- Name: friendships friendships_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER friendships_updated_at BEFORE UPDATE ON public.friendships FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: goals goals_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER goals_updated_at BEFORE UPDATE ON public.goals FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: google_oauth_tokens google_oauth_tokens_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER google_oauth_tokens_updated_at BEFORE UPDATE ON public.google_oauth_tokens FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: groups groups_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER groups_updated_at BEFORE UPDATE ON public.groups FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: hangouts hangouts_push_on_cancel; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER hangouts_push_on_cancel AFTER UPDATE OF status ON public.hangouts FOR EACH ROW EXECUTE FUNCTION public.notify_hangout_cancelled();


--
-- Name: hangouts hangouts_push_on_confirm; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER hangouts_push_on_confirm AFTER UPDATE OF status ON public.hangouts FOR EACH ROW EXECUTE FUNCTION public.notify_hangout_confirmed();


--
-- Name: hangouts hangouts_push_on_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER hangouts_push_on_insert AFTER INSERT ON public.hangouts FOR EACH ROW EXECUTE FUNCTION public.notify_hangout_proposed();


--
-- Name: hangouts hangouts_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER hangouts_updated_at BEFORE UPDATE ON public.hangouts FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: interests interests_accumulate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER interests_accumulate BEFORE INSERT ON public.interests FOR EACH ROW EXECUTE FUNCTION public.interests_accumulate();


--
-- Name: interests interests_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER interests_updated_at BEFORE UPDATE ON public.interests FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: profiles profiles_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER profiles_updated_at BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: calendar_events tr_calendar_events_sync_movable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tr_calendar_events_sync_movable BEFORE INSERT OR UPDATE OF event_type ON public.calendar_events FOR EACH ROW EXECUTE FUNCTION public.tg_calendar_events_sync_movable();


--
-- Name: hangout_responses tr_hangout_responses_sync_calendar; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tr_hangout_responses_sync_calendar AFTER UPDATE ON public.hangout_responses FOR EACH ROW EXECUTE FUNCTION public.tg_hangout_responses_sync_calendar();


--
-- Name: hangouts tr_hangouts_sync_calendar; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tr_hangouts_sync_calendar AFTER UPDATE ON public.hangouts FOR EACH ROW EXECUTE FUNCTION public.tg_hangouts_sync_calendar();


--
-- Name: friendships tr_push_friendship_event; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tr_push_friendship_event AFTER INSERT OR UPDATE ON public.friendships FOR EACH ROW EXECUTE FUNCTION public.tg_push_friendship_event();


--
-- Name: calendar_events tr_routine_blocks_yield; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tr_routine_blocks_yield AFTER INSERT OR UPDATE OF start_at, end_at ON public.calendar_events FOR EACH ROW EXECUTE FUNCTION public.tg_routine_blocks_yield();


--
-- Name: activity_log activity_log_actual_place_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activity_log
    ADD CONSTRAINT activity_log_actual_place_id_fkey FOREIGN KEY (actual_place_id) REFERENCES public.places(id) ON DELETE SET NULL;


--
-- Name: activity_log activity_log_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activity_log
    ADD CONSTRAINT activity_log_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.calendar_events(id) ON DELETE CASCADE;


--
-- Name: activity_log activity_log_place_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activity_log
    ADD CONSTRAINT activity_log_place_id_fkey FOREIGN KEY (place_id) REFERENCES public.places(id) ON DELETE SET NULL;


--
-- Name: activity_log activity_log_predicted_place_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activity_log
    ADD CONSTRAINT activity_log_predicted_place_id_fkey FOREIGN KEY (predicted_place_id) REFERENCES public.places(id) ON DELETE SET NULL;


--
-- Name: activity_log activity_log_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activity_log
    ADD CONSTRAINT activity_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: activity_patterns activity_patterns_place_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activity_patterns
    ADD CONSTRAINT activity_patterns_place_id_fkey FOREIGN KEY (place_id) REFERENCES public.places(id) ON DELETE CASCADE;


--
-- Name: activity_patterns activity_patterns_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activity_patterns
    ADD CONSTRAINT activity_patterns_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: app_sessions app_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_sessions
    ADD CONSTRAINT app_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: behavioral_pings behavioral_pings_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.behavioral_pings
    ADD CONSTRAINT behavioral_pings_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: behavioral_summary behavioral_summary_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.behavioral_summary
    ADD CONSTRAINT behavioral_summary_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: calendar_events calendar_events_goal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_events
    ADD CONSTRAINT calendar_events_goal_id_fkey FOREIGN KEY (goal_id) REFERENCES public.goals(id) ON DELETE SET NULL;


--
-- Name: calendar_events calendar_events_goal_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_events
    ADD CONSTRAINT calendar_events_goal_plan_id_fkey FOREIGN KEY (goal_plan_id) REFERENCES public.goal_plans(id) ON DELETE SET NULL;


--
-- Name: calendar_events calendar_events_hangout_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_events
    ADD CONSTRAINT calendar_events_hangout_id_fkey FOREIGN KEY (hangout_id) REFERENCES public.hangouts(id) ON DELETE SET NULL;


--
-- Name: calendar_events calendar_events_health_workout_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_events
    ADD CONSTRAINT calendar_events_health_workout_id_fkey FOREIGN KEY (health_workout_id) REFERENCES public.health_workouts(id) ON DELETE SET NULL;


--
-- Name: calendar_events calendar_events_local_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_events
    ADD CONSTRAINT calendar_events_local_event_id_fkey FOREIGN KEY (local_event_id) REFERENCES public.events(id) ON DELETE SET NULL;


--
-- Name: calendar_events calendar_events_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_events
    ADD CONSTRAINT calendar_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: change_sets change_sets_chat_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.change_sets
    ADD CONSTRAINT change_sets_chat_message_id_fkey FOREIGN KEY (chat_message_id) REFERENCES public.chat_messages(id) ON DELETE SET NULL;


--
-- Name: change_sets change_sets_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.change_sets
    ADD CONSTRAINT change_sets_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: chat_messages chat_messages_goal_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_goal_plan_id_fkey FOREIGN KEY (goal_plan_id) REFERENCES public.goal_plans(id) ON DELETE SET NULL;


--
-- Name: chat_messages chat_messages_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: collection_health collection_health_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.collection_health
    ADD CONSTRAINT collection_health_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: events events_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: events events_venue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_venue_id_fkey FOREIGN KEY (venue_id) REFERENCES public.venues(id) ON DELETE SET NULL;


--
-- Name: friendships friendships_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.friendships
    ADD CONSTRAINT friendships_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: friendships friendships_user_a_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.friendships
    ADD CONSTRAINT friendships_user_a_fkey FOREIGN KEY (user_a) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: friendships friendships_user_b_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.friendships
    ADD CONSTRAINT friendships_user_b_fkey FOREIGN KEY (user_b) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: goal_plans goal_plans_goal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.goal_plans
    ADD CONSTRAINT goal_plans_goal_id_fkey FOREIGN KEY (goal_id) REFERENCES public.goals(id) ON DELETE CASCADE;


--
-- Name: goal_plans goal_plans_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.goal_plans
    ADD CONSTRAINT goal_plans_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: goals goals_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.goals
    ADD CONSTRAINT goals_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: google_oauth_tokens google_oauth_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.google_oauth_tokens
    ADD CONSTRAINT google_oauth_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: group_members group_members_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_members
    ADD CONSTRAINT group_members_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.groups(id) ON DELETE CASCADE;


--
-- Name: group_members group_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_members
    ADD CONSTRAINT group_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: groups groups_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.groups
    ADD CONSTRAINT groups_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: hangout_responses hangout_responses_hangout_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hangout_responses
    ADD CONSTRAINT hangout_responses_hangout_id_fkey FOREIGN KEY (hangout_id) REFERENCES public.hangouts(id) ON DELETE CASCADE;


--
-- Name: hangout_responses hangout_responses_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hangout_responses
    ADD CONSTRAINT hangout_responses_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: hangouts hangouts_direct_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hangouts
    ADD CONSTRAINT hangouts_direct_user_id_fkey FOREIGN KEY (direct_user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: hangouts hangouts_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hangouts
    ADD CONSTRAINT hangouts_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.groups(id) ON DELETE CASCADE;


--
-- Name: hangouts hangouts_proposed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hangouts
    ADD CONSTRAINT hangouts_proposed_by_fkey FOREIGN KEY (proposed_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: health_sleep health_sleep_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.health_sleep
    ADD CONSTRAINT health_sleep_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: health_workouts health_workouts_matched_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.health_workouts
    ADD CONSTRAINT health_workouts_matched_event_id_fkey FOREIGN KEY (matched_event_id) REFERENCES public.calendar_events(id) ON DELETE SET NULL;


--
-- Name: health_workouts health_workouts_matched_goal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.health_workouts
    ADD CONSTRAINT health_workouts_matched_goal_id_fkey FOREIGN KEY (matched_goal_id) REFERENCES public.goals(id) ON DELETE SET NULL;


--
-- Name: health_workouts health_workouts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.health_workouts
    ADD CONSTRAINT health_workouts_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: interests interests_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.interests
    ADD CONSTRAINT interests_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: motion_activity motion_activity_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.motion_activity
    ADD CONSTRAINT motion_activity_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: places places_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.places
    ADD CONSTRAINT places_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: proactive_pushes proactive_pushes_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.proactive_pushes
    ADD CONSTRAINT proactive_pushes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: profiles profiles_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: reminders reminders_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reminders
    ADD CONSTRAINT reminders_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: routines routines_place_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.routines
    ADD CONSTRAINT routines_place_id_fkey FOREIGN KEY (place_id) REFERENCES public.places(id) ON DELETE SET NULL;


--
-- Name: routines routines_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.routines
    ADD CONSTRAINT routines_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: schedule_suggestions schedule_suggestions_goal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule_suggestions
    ADD CONSTRAINT schedule_suggestions_goal_id_fkey FOREIGN KEY (goal_id) REFERENCES public.goals(id) ON DELETE CASCADE;


--
-- Name: schedule_suggestions schedule_suggestions_goal_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule_suggestions
    ADD CONSTRAINT schedule_suggestions_goal_plan_id_fkey FOREIGN KEY (goal_plan_id) REFERENCES public.goal_plans(id) ON DELETE CASCADE;


--
-- Name: schedule_suggestions schedule_suggestions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule_suggestions
    ADD CONSTRAINT schedule_suggestions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: stay_names stay_names_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stay_names
    ADD CONSTRAINT stay_names_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: step_counts step_counts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.step_counts
    ADD CONSTRAINT step_counts_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: venues venues_claimed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.venues
    ADD CONSTRAINT venues_claimed_by_fkey FOREIGN KEY (claimed_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: venues venues_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.venues
    ADD CONSTRAINT venues_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: visits visits_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.visits
    ADD CONSTRAINT visits_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.calendar_events(id) ON DELETE SET NULL;


--
-- Name: visits visits_health_workout_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.visits
    ADD CONSTRAINT visits_health_workout_id_fkey FOREIGN KEY (health_workout_id) REFERENCES public.health_workouts(id) ON DELETE SET NULL;


--
-- Name: visits visits_place_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.visits
    ADD CONSTRAINT visits_place_id_fkey FOREIGN KEY (place_id) REFERENCES public.places(id) ON DELETE SET NULL;


--
-- Name: visits visits_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.visits
    ADD CONSTRAINT visits_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: group_members Members can update their own membership; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members can update their own membership" ON public.group_members FOR UPDATE USING ((user_id = auth.uid())) WITH CHECK ((user_id = auth.uid()));


--
-- Name: activity_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.activity_log ENABLE ROW LEVEL SECURITY;

--
-- Name: activity_log activity_log_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY activity_log_select_own ON public.activity_log FOR SELECT USING ((user_id = auth.uid()));


--
-- Name: activity_log activity_log_update_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY activity_log_update_own ON public.activity_log FOR UPDATE USING ((user_id = auth.uid())) WITH CHECK ((user_id = auth.uid()));


--
-- Name: activity_patterns; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.activity_patterns ENABLE ROW LEVEL SECURITY;

--
-- Name: activity_patterns activity_patterns_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY activity_patterns_select_own ON public.activity_patterns FOR SELECT USING ((user_id = auth.uid()));


--
-- Name: app_config; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.app_config ENABLE ROW LEVEL SECURITY;

--
-- Name: app_sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.app_sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: app_sessions app_sessions_self_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY app_sessions_self_insert ON public.app_sessions FOR INSERT WITH CHECK ((auth.uid() = user_id));


--
-- Name: app_sessions app_sessions_self_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY app_sessions_self_read ON public.app_sessions FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: app_sessions app_sessions_self_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY app_sessions_self_update ON public.app_sessions FOR UPDATE USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: behavioral_pings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.behavioral_pings ENABLE ROW LEVEL SECURITY;

--
-- Name: behavioral_summary; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.behavioral_summary ENABLE ROW LEVEL SECURITY;

--
-- Name: calendar_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.calendar_events ENABLE ROW LEVEL SECURITY;

--
-- Name: calendar_events calendar_events_owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY calendar_events_owner_all ON public.calendar_events USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: change_sets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.change_sets ENABLE ROW LEVEL SECURITY;

--
-- Name: chat_messages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;

--
-- Name: chat_messages chat_messages_owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY chat_messages_owner_all ON public.chat_messages USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: collection_health; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.collection_health ENABLE ROW LEVEL SECURITY;

--
-- Name: collection_health collection_health_owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY collection_health_owner_all ON public.collection_health USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;

--
-- Name: events events_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY events_delete ON public.events FOR DELETE TO authenticated USING ((created_by = auth.uid()));


--
-- Name: events events_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY events_insert ON public.events FOR INSERT TO authenticated WITH CHECK ((created_by = auth.uid()));


--
-- Name: events events_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY events_select ON public.events FOR SELECT TO authenticated USING (((created_by = auth.uid()) OR (visibility = 'public'::text) OR ((visibility = 'friends'::text) AND (EXISTS ( SELECT 1
   FROM public.friendships f
  WHERE ((f.status = 'accepted'::text) AND (((f.user_a = auth.uid()) AND (f.user_b = events.created_by)) OR ((f.user_b = auth.uid()) AND (f.user_a = events.created_by)))))))));


--
-- Name: events events_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY events_update ON public.events FOR UPDATE TO authenticated USING ((created_by = auth.uid())) WITH CHECK ((created_by = auth.uid()));


--
-- Name: friendships; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.friendships ENABLE ROW LEVEL SECURITY;

--
-- Name: friendships friendships_party_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY friendships_party_read ON public.friendships FOR SELECT USING (((auth.uid() = user_a) OR (auth.uid() = user_b)));


--
-- Name: goal_plans; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.goal_plans ENABLE ROW LEVEL SECURITY;

--
-- Name: goal_plans goal_plans_self_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY goal_plans_self_delete ON public.goal_plans FOR DELETE USING ((auth.uid() = user_id));


--
-- Name: goal_plans goal_plans_self_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY goal_plans_self_insert ON public.goal_plans FOR INSERT WITH CHECK ((auth.uid() = user_id));


--
-- Name: goal_plans goal_plans_self_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY goal_plans_self_select ON public.goal_plans FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: goal_plans goal_plans_self_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY goal_plans_self_update ON public.goal_plans FOR UPDATE USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: goals; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.goals ENABLE ROW LEVEL SECURITY;

--
-- Name: goals goals_owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY goals_owner_all ON public.goals USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: google_oauth_tokens; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.google_oauth_tokens ENABLE ROW LEVEL SECURITY;

--
-- Name: group_members; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.group_members ENABLE ROW LEVEL SECURITY;

--
-- Name: group_members group_members_admin_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY group_members_admin_insert ON public.group_members FOR INSERT WITH CHECK ((public.is_group_admin(group_id) AND ((user_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM public.friendships f
  WHERE ((f.status = 'accepted'::text) AND (LEAST(auth.uid(), group_members.user_id) = f.user_a) AND (GREATEST(auth.uid(), group_members.user_id) = f.user_b)))))));


--
-- Name: group_members group_members_member_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY group_members_member_read ON public.group_members FOR SELECT USING (public.is_group_member(group_id));


--
-- Name: group_members group_members_self_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY group_members_self_delete ON public.group_members FOR DELETE USING ((auth.uid() = user_id));


--
-- Name: group_members group_members_self_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY group_members_self_insert ON public.group_members FOR INSERT WITH CHECK ((auth.uid() = user_id));


--
-- Name: groups; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.groups ENABLE ROW LEVEL SECURITY;

--
-- Name: groups groups_creator_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY groups_creator_delete ON public.groups FOR DELETE USING ((auth.uid() = created_by));


--
-- Name: groups groups_creator_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY groups_creator_insert ON public.groups FOR INSERT WITH CHECK ((auth.uid() = created_by));


--
-- Name: groups groups_creator_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY groups_creator_update ON public.groups FOR UPDATE USING ((auth.uid() = created_by)) WITH CHECK ((auth.uid() = created_by));


--
-- Name: groups groups_member_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY groups_member_read ON public.groups FOR SELECT USING (public.is_group_member(id));


--
-- Name: hangout_responses; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.hangout_responses ENABLE ROW LEVEL SECURITY;

--
-- Name: hangout_responses hangout_responses_participant_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY hangout_responses_participant_read ON public.hangout_responses FOR SELECT USING (public.is_hangout_participant(hangout_id));


--
-- Name: hangout_responses hangout_responses_self_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY hangout_responses_self_delete ON public.hangout_responses FOR DELETE USING ((auth.uid() = user_id));


--
-- Name: hangout_responses hangout_responses_self_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY hangout_responses_self_update ON public.hangout_responses FOR UPDATE USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: hangout_responses hangout_responses_self_upsert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY hangout_responses_self_upsert ON public.hangout_responses FOR INSERT WITH CHECK ((auth.uid() = user_id));


--
-- Name: hangouts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.hangouts ENABLE ROW LEVEL SECURITY;

--
-- Name: hangouts hangouts_participant_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY hangouts_participant_insert ON public.hangouts FOR INSERT WITH CHECK (((auth.uid() = proposed_by) AND (((group_id IS NOT NULL) AND public.is_group_member(group_id)) OR ((direct_user_id IS NOT NULL) AND public.are_friends(auth.uid(), direct_user_id)))));


--
-- Name: hangouts hangouts_participant_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY hangouts_participant_read ON public.hangouts FOR SELECT USING (public.is_hangout_participant(id));


--
-- Name: hangouts hangouts_participant_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY hangouts_participant_update ON public.hangouts FOR UPDATE USING (public.is_hangout_participant(id));


--
-- Name: health_sleep; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.health_sleep ENABLE ROW LEVEL SECURITY;

--
-- Name: health_sleep health_sleep_owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY health_sleep_owner_all ON public.health_sleep USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: health_workouts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.health_workouts ENABLE ROW LEVEL SECURITY;

--
-- Name: health_workouts health_workouts_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY health_workouts_delete ON public.health_workouts FOR DELETE TO authenticated USING ((user_id = auth.uid()));


--
-- Name: health_workouts health_workouts_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY health_workouts_insert ON public.health_workouts FOR INSERT TO authenticated WITH CHECK ((user_id = auth.uid()));


--
-- Name: health_workouts health_workouts_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY health_workouts_select ON public.health_workouts FOR SELECT TO authenticated USING ((user_id = auth.uid()));


--
-- Name: health_workouts health_workouts_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY health_workouts_update ON public.health_workouts FOR UPDATE TO authenticated USING ((user_id = auth.uid())) WITH CHECK ((user_id = auth.uid()));


--
-- Name: interests; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.interests ENABLE ROW LEVEL SECURITY;

--
-- Name: interests interests_owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY interests_owner_all ON public.interests USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: motion_activity; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.motion_activity ENABLE ROW LEVEL SECURITY;

--
-- Name: motion_activity motion_activity_own_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY motion_activity_own_insert ON public.motion_activity FOR INSERT WITH CHECK ((auth.uid() = user_id));


--
-- Name: motion_activity motion_activity_own_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY motion_activity_own_select ON public.motion_activity FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: motion_activity motion_activity_own_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY motion_activity_own_update ON public.motion_activity FOR UPDATE USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: places; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.places ENABLE ROW LEVEL SECURITY;

--
-- Name: proactive_pushes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.proactive_pushes ENABLE ROW LEVEL SECURITY;

--
-- Name: profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: profiles profiles_groupmate_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY profiles_groupmate_read ON public.profiles FOR SELECT USING (public.shares_group_with(id));


--
-- Name: profiles profiles_self_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY profiles_self_insert ON public.profiles FOR INSERT WITH CHECK ((auth.uid() = id));


--
-- Name: profiles profiles_self_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY profiles_self_read ON public.profiles FOR SELECT USING ((auth.uid() = id));


--
-- Name: profiles profiles_self_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY profiles_self_update ON public.profiles FOR UPDATE USING ((auth.uid() = id)) WITH CHECK ((auth.uid() = id));


--
-- Name: reminders; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.reminders ENABLE ROW LEVEL SECURITY;

--
-- Name: reminders reminders_insert_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY reminders_insert_own ON public.reminders FOR INSERT WITH CHECK ((user_id = auth.uid()));


--
-- Name: reminders reminders_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY reminders_select_own ON public.reminders FOR SELECT USING ((user_id = auth.uid()));


--
-- Name: reminders reminders_update_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY reminders_update_own ON public.reminders FOR UPDATE USING ((user_id = auth.uid())) WITH CHECK ((user_id = auth.uid()));


--
-- Name: routines; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.routines ENABLE ROW LEVEL SECURITY;

--
-- Name: schedule_suggestions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.schedule_suggestions ENABLE ROW LEVEL SECURITY;

--
-- Name: schedule_suggestions schedule_suggestions_owner_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY schedule_suggestions_owner_read ON public.schedule_suggestions FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: stay_names; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.stay_names ENABLE ROW LEVEL SECURITY;

--
-- Name: stay_names stay_names_own_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY stay_names_own_select ON public.stay_names FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: step_counts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.step_counts ENABLE ROW LEVEL SECURITY;

--
-- Name: step_counts step_counts_owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY step_counts_owner_all ON public.step_counts USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: system_health_probes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.system_health_probes ENABLE ROW LEVEL SECURITY;

--
-- Name: system_health_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.system_health_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: change_sets users_own_change_sets; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY users_own_change_sets ON public.change_sets USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: behavioral_pings users_own_pings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY users_own_pings ON public.behavioral_pings USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: places users_own_places; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY users_own_places ON public.places USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: routines users_own_routines; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY users_own_routines ON public.routines USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: behavioral_summary users_own_summary; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY users_own_summary ON public.behavioral_summary USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: venues; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.venues ENABLE ROW LEVEL SECURITY;

--
-- Name: venues venues_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY venues_insert ON public.venues FOR INSERT TO authenticated WITH CHECK ((created_by = auth.uid()));


--
-- Name: venues venues_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY venues_select ON public.venues FOR SELECT TO authenticated USING (true);


--
-- Name: venues venues_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY venues_update ON public.venues FOR UPDATE TO authenticated USING (((created_by = auth.uid()) OR (claimed_by = auth.uid()))) WITH CHECK (((created_by = auth.uid()) OR (claimed_by = auth.uid())));


--
-- Name: visits; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.visits ENABLE ROW LEVEL SECURITY;

--
-- Name: visits visits_owner_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY visits_owner_read ON public.visits FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: visits visits_owner_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY visits_owner_update ON public.visits FOR UPDATE USING ((auth.uid() = user_id));


--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA public TO postgres;
GRANT USAGE ON SCHEMA public TO anon;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA public TO service_role;


--
-- Name: TABLE hangouts; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.hangouts TO anon;
GRANT ALL ON TABLE public.hangouts TO authenticated;
GRANT ALL ON TABLE public.hangouts TO service_role;


--
-- Name: FUNCTION _coordinated_event_payload(_user_id uuid, _h public.hangouts); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public._coordinated_event_payload(_user_id uuid, _h public.hangouts) TO anon;
GRANT ALL ON FUNCTION public._coordinated_event_payload(_user_id uuid, _h public.hangouts) TO authenticated;
GRANT ALL ON FUNCTION public._coordinated_event_payload(_user_id uuid, _h public.hangouts) TO service_role;


--
-- Name: FUNCTION _hangout_can_invite(_h public.hangouts, _caller uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public._hangout_can_invite(_h public.hangouts, _caller uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public._hangout_can_invite(_h public.hangouts, _caller uuid) TO service_role;


--
-- Name: FUNCTION _hangout_invite_block_reason(_h public.hangouts, _caller uuid, _invitee uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public._hangout_invite_block_reason(_h public.hangouts, _caller uuid, _invitee uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public._hangout_invite_block_reason(_h public.hangouts, _caller uuid, _invitee uuid) TO service_role;


--
-- Name: FUNCTION _hhmm(_min integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public._hhmm(_min integer) TO anon;
GRANT ALL ON FUNCTION public._hhmm(_min integer) TO authenticated;
GRANT ALL ON FUNCTION public._hhmm(_min integer) TO service_role;


--
-- Name: FUNCTION _materialize_goal_plan(_plan_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public._materialize_goal_plan(_plan_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public._materialize_goal_plan(_plan_id uuid) TO service_role;


--
-- Name: FUNCTION _move_goal_block_to_actual(_uid uuid, _event_id uuid, _start timestamp with time zone, _end timestamp with time zone, _confirmed_by text, _workout_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public._move_goal_block_to_actual(_uid uuid, _event_id uuid, _start timestamp with time zone, _end timestamp with time zone, _confirmed_by text, _workout_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public._move_goal_block_to_actual(_uid uuid, _event_id uuid, _start timestamp with time zone, _end timestamp with time zone, _confirmed_by text, _workout_id uuid) TO service_role;


--
-- Name: FUNCTION _next_curiosity_item(_user uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public._next_curiosity_item(_user uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public._next_curiosity_item(_user uuid) TO service_role;


--
-- Name: FUNCTION add_friends_to_group(_group_id uuid, _user_ids uuid[]); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.add_friends_to_group(_group_id uuid, _user_ids uuid[]) FROM PUBLIC;
GRANT ALL ON FUNCTION public.add_friends_to_group(_group_id uuid, _user_ids uuid[]) TO anon;
GRANT ALL ON FUNCTION public.add_friends_to_group(_group_id uuid, _user_ids uuid[]) TO authenticated;
GRANT ALL ON FUNCTION public.add_friends_to_group(_group_id uuid, _user_ids uuid[]) TO service_role;


--
-- Name: FUNCTION align_routines_to_arrival(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.align_routines_to_arrival() FROM PUBLIC;
GRANT ALL ON FUNCTION public.align_routines_to_arrival() TO service_role;


--
-- Name: FUNCTION apply_change_set(_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.apply_change_set(_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.apply_change_set(_id uuid) TO anon;
GRANT ALL ON FUNCTION public.apply_change_set(_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.apply_change_set(_id uuid) TO service_role;


--
-- Name: FUNCTION apply_schedule_suggestion(_id uuid, _accept boolean); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.apply_schedule_suggestion(_id uuid, _accept boolean) TO anon;
GRANT ALL ON FUNCTION public.apply_schedule_suggestion(_id uuid, _accept boolean) TO authenticated;
GRANT ALL ON FUNCTION public.apply_schedule_suggestion(_id uuid, _accept boolean) TO service_role;


--
-- Name: FUNCTION appointment_locations(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.appointment_locations() FROM PUBLIC;
GRANT ALL ON FUNCTION public.appointment_locations() TO authenticated;
GRANT ALL ON FUNCTION public.appointment_locations() TO service_role;


--
-- Name: FUNCTION approx_metres(lat1 double precision, lon1 double precision, lat2 double precision, lon2 double precision); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.approx_metres(lat1 double precision, lon1 double precision, lat2 double precision, lon2 double precision) TO anon;
GRANT ALL ON FUNCTION public.approx_metres(lat1 double precision, lon1 double precision, lat2 double precision, lon2 double precision) TO authenticated;
GRANT ALL ON FUNCTION public.approx_metres(lat1 double precision, lon1 double precision, lat2 double precision, lon2 double precision) TO service_role;


--
-- Name: FUNCTION are_friends(_a uuid, _b uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.are_friends(_a uuid, _b uuid) TO anon;
GRANT ALL ON FUNCTION public.are_friends(_a uuid, _b uuid) TO authenticated;
GRANT ALL ON FUNCTION public.are_friends(_a uuid, _b uuid) TO service_role;


--
-- Name: FUNCTION auto_friend_new_profile(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.auto_friend_new_profile() FROM PUBLIC;
GRANT ALL ON FUNCTION public.auto_friend_new_profile() TO service_role;


--
-- Name: FUNCTION build_visits(_user uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.build_visits(_user uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.build_visits(_user uuid) TO service_role;


--
-- Name: FUNCTION build_visits_all(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.build_visits_all() FROM PUBLIC;
GRANT ALL ON FUNCTION public.build_visits_all() TO service_role;


--
-- Name: FUNCTION bump_activity_pattern(_user uuid, _key text, _dow integer, _bucket integer, _place uuid, _ts timestamp with time zone); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.bump_activity_pattern(_user uuid, _key text, _dow integer, _bucket integer, _place uuid, _ts timestamp with time zone) TO anon;
GRANT ALL ON FUNCTION public.bump_activity_pattern(_user uuid, _key text, _dow integer, _bucket integer, _place uuid, _ts timestamp with time zone) TO authenticated;
GRANT ALL ON FUNCTION public.bump_activity_pattern(_user uuid, _key text, _dow integer, _bucket integer, _place uuid, _ts timestamp with time zone) TO service_role;


--
-- Name: FUNCTION cancel_hangout(_hangout_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.cancel_hangout(_hangout_id uuid) TO anon;
GRANT ALL ON FUNCTION public.cancel_hangout(_hangout_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.cancel_hangout(_hangout_id uuid) TO service_role;


--
-- Name: FUNCTION check_activities(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.check_activities() TO anon;
GRANT ALL ON FUNCTION public.check_activities() TO authenticated;
GRANT ALL ON FUNCTION public.check_activities() TO service_role;


--
-- Name: FUNCTION commit_goal_plan(_goal_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.commit_goal_plan(_goal_id uuid) TO anon;
GRANT ALL ON FUNCTION public.commit_goal_plan(_goal_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.commit_goal_plan(_goal_id uuid) TO service_role;


--
-- Name: FUNCTION create_group(_name text, _description text, _group_type text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.create_group(_name text, _description text, _group_type text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.create_group(_name text, _description text, _group_type text) TO anon;
GRANT ALL ON FUNCTION public.create_group(_name text, _description text, _group_type text) TO authenticated;
GRANT ALL ON FUNCTION public.create_group(_name text, _description text, _group_type text) TO service_role;


--
-- Name: FUNCTION detect_goal_time_drift(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.detect_goal_time_drift() FROM PUBLIC;
GRANT ALL ON FUNCTION public.detect_goal_time_drift() TO service_role;


--
-- Name: FUNCTION disconnect_google_calendar(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.disconnect_google_calendar() FROM PUBLIC;
GRANT ALL ON FUNCTION public.disconnect_google_calendar() TO anon;
GRANT ALL ON FUNCTION public.disconnect_google_calendar() TO authenticated;
GRANT ALL ON FUNCTION public.disconnect_google_calendar() TO service_role;


--
-- Name: FUNCTION evaluate_active_blocks(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.evaluate_active_blocks() TO anon;
GRANT ALL ON FUNCTION public.evaluate_active_blocks() TO authenticated;
GRANT ALL ON FUNCTION public.evaluate_active_blocks() TO service_role;


--
-- Name: FUNCTION expire_stale_change_sets(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.expire_stale_change_sets() TO anon;
GRANT ALL ON FUNCTION public.expire_stale_change_sets() TO authenticated;
GRANT ALL ON FUNCTION public.expire_stale_change_sets() TO service_role;


--
-- Name: FUNCTION expire_stale_hangouts(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.expire_stale_hangouts() TO anon;
GRANT ALL ON FUNCTION public.expire_stale_hangouts() TO authenticated;
GRANT ALL ON FUNCTION public.expire_stale_hangouts() TO service_role;


--
-- Name: FUNCTION find_mutual_slots(_user_ids uuid[], _earliest timestamp with time zone, _latest timestamp with time zone, _duration_minutes integer, _time_preference text, _max_results integer, _earliest_hour integer, _latest_hour integer, _min_free_count integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.find_mutual_slots(_user_ids uuid[], _earliest timestamp with time zone, _latest timestamp with time zone, _duration_minutes integer, _time_preference text, _max_results integer, _earliest_hour integer, _latest_hour integer, _min_free_count integer) TO anon;
GRANT ALL ON FUNCTION public.find_mutual_slots(_user_ids uuid[], _earliest timestamp with time zone, _latest timestamp with time zone, _duration_minutes integer, _time_preference text, _max_results integer, _earliest_hour integer, _latest_hour integer, _min_free_count integer) TO authenticated;
GRANT ALL ON FUNCTION public.find_mutual_slots(_user_ids uuid[], _earliest timestamp with time zone, _latest timestamp with time zone, _duration_minutes integer, _time_preference text, _max_results integer, _earliest_hour integer, _latest_hour integer, _min_free_count integer) TO service_role;


--
-- Name: FUNCTION find_user_by_handle(_handle text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.find_user_by_handle(_handle text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.find_user_by_handle(_handle text) TO anon;
GRANT ALL ON FUNCTION public.find_user_by_handle(_handle text) TO authenticated;
GRANT ALL ON FUNCTION public.find_user_by_handle(_handle text) TO service_role;


--
-- Name: FUNCTION friend_tier_to(_viewer uuid, _owner uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.friend_tier_to(_viewer uuid, _owner uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.friend_tier_to(_viewer uuid, _owner uuid) TO service_role;


--
-- Name: FUNCTION geohash_center(_gh text, OUT lat double precision, OUT lon double precision); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.geohash_center(_gh text, OUT lat double precision, OUT lon double precision) TO anon;
GRANT ALL ON FUNCTION public.geohash_center(_gh text, OUT lat double precision, OUT lon double precision) TO authenticated;
GRANT ALL ON FUNCTION public.geohash_center(_gh text, OUT lat double precision, OUT lon double precision) TO service_role;


--
-- Name: FUNCTION get_friend_schedule(_friend_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_friend_schedule(_friend_id uuid) TO anon;
GRANT ALL ON FUNCTION public.get_friend_schedule(_friend_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.get_friend_schedule(_friend_id uuid) TO service_role;


--
-- Name: FUNCTION get_hangout_details(_hangout_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_hangout_details(_hangout_id uuid) TO anon;
GRANT ALL ON FUNCTION public.get_hangout_details(_hangout_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.get_hangout_details(_hangout_id uuid) TO service_role;


--
-- Name: FUNCTION get_participant_feasibility_context(_requester uuid, _participant_ids uuid[], _slot_start timestamp with time zone, _slot_end timestamp with time zone); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_participant_feasibility_context(_requester uuid, _participant_ids uuid[], _slot_start timestamp with time zone, _slot_end timestamp with time zone) TO anon;
GRANT ALL ON FUNCTION public.get_participant_feasibility_context(_requester uuid, _participant_ids uuid[], _slot_start timestamp with time zone, _slot_end timestamp with time zone) TO authenticated;
GRANT ALL ON FUNCTION public.get_participant_feasibility_context(_requester uuid, _participant_ids uuid[], _slot_start timestamp with time zone, _slot_end timestamp with time zone) TO service_role;


--
-- Name: FUNCTION google_calendar_status(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.google_calendar_status() FROM PUBLIC;
GRANT ALL ON FUNCTION public.google_calendar_status() TO anon;
GRANT ALL ON FUNCTION public.google_calendar_status() TO authenticated;
GRANT ALL ON FUNCTION public.google_calendar_status() TO service_role;


--
-- Name: FUNCTION handle_new_user(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.handle_new_user() TO anon;
GRANT ALL ON FUNCTION public.handle_new_user() TO authenticated;
GRANT ALL ON FUNCTION public.handle_new_user() TO service_role;


--
-- Name: FUNCTION hangout_invite_candidates(_hangout_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.hangout_invite_candidates(_hangout_id uuid) TO anon;
GRANT ALL ON FUNCTION public.hangout_invite_candidates(_hangout_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.hangout_invite_candidates(_hangout_id uuid) TO service_role;


--
-- Name: FUNCTION hangout_participants_for(_hangout_ids uuid[]); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.hangout_participants_for(_hangout_ids uuid[]) TO anon;
GRANT ALL ON FUNCTION public.hangout_participants_for(_hangout_ids uuid[]) TO authenticated;
GRANT ALL ON FUNCTION public.hangout_participants_for(_hangout_ids uuid[]) TO service_role;


--
-- Name: FUNCTION interest_is_gated(_key text, _source text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.interest_is_gated(_key text, _source text) TO anon;
GRANT ALL ON FUNCTION public.interest_is_gated(_key text, _source text) TO authenticated;
GRANT ALL ON FUNCTION public.interest_is_gated(_key text, _source text) TO service_role;


--
-- Name: FUNCTION interest_subject(_v jsonb); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.interest_subject(_v jsonb) TO anon;
GRANT ALL ON FUNCTION public.interest_subject(_v jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.interest_subject(_v jsonb) TO service_role;


--
-- Name: FUNCTION interests_accumulate(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.interests_accumulate() TO anon;
GRANT ALL ON FUNCTION public.interests_accumulate() TO authenticated;
GRANT ALL ON FUNCTION public.interests_accumulate() TO service_role;


--
-- Name: FUNCTION interests_skip_exact_duplicate(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.interests_skip_exact_duplicate() TO anon;
GRANT ALL ON FUNCTION public.interests_skip_exact_duplicate() TO authenticated;
GRANT ALL ON FUNCTION public.interests_skip_exact_duplicate() TO service_role;


--
-- Name: FUNCTION invite_to_hangout(_hangout_id uuid, _user_ids uuid[]); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.invite_to_hangout(_hangout_id uuid, _user_ids uuid[]) TO anon;
GRANT ALL ON FUNCTION public.invite_to_hangout(_hangout_id uuid, _user_ids uuid[]) TO authenticated;
GRANT ALL ON FUNCTION public.invite_to_hangout(_hangout_id uuid, _user_ids uuid[]) TO service_role;


--
-- Name: FUNCTION invoke_google_calendar_sync(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.invoke_google_calendar_sync() FROM PUBLIC;
GRANT ALL ON FUNCTION public.invoke_google_calendar_sync() TO service_role;


--
-- Name: FUNCTION invoke_health_probe(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.invoke_health_probe() FROM PUBLIC;
GRANT ALL ON FUNCTION public.invoke_health_probe() TO service_role;


--
-- Name: FUNCTION invoke_name_stays(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.invoke_name_stays() FROM PUBLIC;
GRANT ALL ON FUNCTION public.invoke_name_stays() TO service_role;


--
-- Name: FUNCTION invoke_proactive_weather(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.invoke_proactive_weather() TO anon;
GRANT ALL ON FUNCTION public.invoke_proactive_weather() TO authenticated;
GRANT ALL ON FUNCTION public.invoke_proactive_weather() TO service_role;


--
-- Name: FUNCTION invoke_rebuild_summaries(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.invoke_rebuild_summaries() FROM PUBLIC;
GRANT ALL ON FUNCTION public.invoke_rebuild_summaries() TO service_role;


--
-- Name: FUNCTION invoke_resolve_places(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.invoke_resolve_places() FROM PUBLIC;
GRANT ALL ON FUNCTION public.invoke_resolve_places() TO service_role;


--
-- Name: FUNCTION is_group_admin(_group_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.is_group_admin(_group_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.is_group_admin(_group_id uuid) TO anon;
GRANT ALL ON FUNCTION public.is_group_admin(_group_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.is_group_admin(_group_id uuid) TO service_role;


--
-- Name: FUNCTION is_group_member(_group_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.is_group_member(_group_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.is_group_member(_group_id uuid) TO anon;
GRANT ALL ON FUNCTION public.is_group_member(_group_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.is_group_member(_group_id uuid) TO service_role;


--
-- Name: FUNCTION is_hangout_participant(_hangout_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.is_hangout_participant(_hangout_id uuid) TO anon;
GRANT ALL ON FUNCTION public.is_hangout_participant(_hangout_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.is_hangout_participant(_hangout_id uuid) TO service_role;


--
-- Name: FUNCTION learned_duration_min(_user uuid, _activity_type text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.learned_duration_min(_user uuid, _activity_type text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.learned_duration_min(_user uuid, _activity_type text) TO authenticated;
GRANT ALL ON FUNCTION public.learned_duration_min(_user uuid, _activity_type text) TO service_role;


--
-- Name: FUNCTION log_agent_message(_user uuid, _content text, _kind text, _data jsonb); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.log_agent_message(_user uuid, _content text, _kind text, _data jsonb) TO anon;
GRANT ALL ON FUNCTION public.log_agent_message(_user uuid, _content text, _kind text, _data jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.log_agent_message(_user uuid, _content text, _kind text, _data jsonb) TO service_role;


--
-- Name: FUNCTION mark_curiosity_asked(_kind text, _id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.mark_curiosity_asked(_kind text, _id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.mark_curiosity_asked(_kind text, _id uuid) TO anon;
GRANT ALL ON FUNCTION public.mark_curiosity_asked(_kind text, _id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.mark_curiosity_asked(_kind text, _id uuid) TO service_role;


--
-- Name: FUNCTION mark_goal_done(_goal_id uuid, _date date, _at timestamp with time zone); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.mark_goal_done(_goal_id uuid, _date date, _at timestamp with time zone) TO anon;
GRANT ALL ON FUNCTION public.mark_goal_done(_goal_id uuid, _date date, _at timestamp with time zone) TO authenticated;
GRANT ALL ON FUNCTION public.mark_goal_done(_goal_id uuid, _date date, _at timestamp with time zone) TO service_role;


--
-- Name: FUNCTION materialize_goal_plans(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.materialize_goal_plans() TO anon;
GRANT ALL ON FUNCTION public.materialize_goal_plans() TO authenticated;
GRANT ALL ON FUNCTION public.materialize_goal_plans() TO service_role;


--
-- Name: FUNCTION materialize_routines(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.materialize_routines() TO anon;
GRANT ALL ON FUNCTION public.materialize_routines() TO authenticated;
GRANT ALL ON FUNCTION public.materialize_routines() TO service_role;


--
-- Name: FUNCTION next_curiosity_item(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.next_curiosity_item() FROM PUBLIC;
GRANT ALL ON FUNCTION public.next_curiosity_item() TO anon;
GRANT ALL ON FUNCTION public.next_curiosity_item() TO authenticated;
GRANT ALL ON FUNCTION public.next_curiosity_item() TO service_role;


--
-- Name: FUNCTION norm_event_title(_t text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.norm_event_title(_t text) TO anon;
GRANT ALL ON FUNCTION public.norm_event_title(_t text) TO authenticated;
GRANT ALL ON FUNCTION public.norm_event_title(_t text) TO service_role;


--
-- Name: FUNCTION notify_friendship_accepted(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.notify_friendship_accepted() TO anon;
GRANT ALL ON FUNCTION public.notify_friendship_accepted() TO authenticated;
GRANT ALL ON FUNCTION public.notify_friendship_accepted() TO service_role;


--
-- Name: FUNCTION notify_friendship_requested(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.notify_friendship_requested() TO anon;
GRANT ALL ON FUNCTION public.notify_friendship_requested() TO authenticated;
GRANT ALL ON FUNCTION public.notify_friendship_requested() TO service_role;


--
-- Name: FUNCTION notify_hangout_cancelled(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.notify_hangout_cancelled() TO anon;
GRANT ALL ON FUNCTION public.notify_hangout_cancelled() TO authenticated;
GRANT ALL ON FUNCTION public.notify_hangout_cancelled() TO service_role;


--
-- Name: FUNCTION notify_hangout_confirmed(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.notify_hangout_confirmed() TO anon;
GRANT ALL ON FUNCTION public.notify_hangout_confirmed() TO authenticated;
GRANT ALL ON FUNCTION public.notify_hangout_confirmed() TO service_role;


--
-- Name: FUNCTION notify_hangout_proposed(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.notify_hangout_proposed() TO anon;
GRANT ALL ON FUNCTION public.notify_hangout_proposed() TO authenticated;
GRANT ALL ON FUNCTION public.notify_hangout_proposed() TO service_role;


--
-- Name: FUNCTION people_together_summary(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.people_together_summary() FROM PUBLIC;
GRANT ALL ON FUNCTION public.people_together_summary() TO authenticated;
GRANT ALL ON FUNCTION public.people_together_summary() TO service_role;


--
-- Name: FUNCTION post_curiosity_questions(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.post_curiosity_questions() FROM PUBLIC;
GRANT ALL ON FUNCTION public.post_curiosity_questions() TO service_role;


--
-- Name: FUNCTION predict_visit_activity(_visit_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.predict_visit_activity(_visit_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.predict_visit_activity(_visit_id uuid) TO service_role;


--
-- Name: FUNCTION propose_direct_hangout(_direct_user_id uuid, _title text, _proposed_start timestamp with time zone, _reasoning text, _description text, _proposed_end timestamp with time zone, _venue_name text, _venue_address text, _confidence numeric); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.propose_direct_hangout(_direct_user_id uuid, _title text, _proposed_start timestamp with time zone, _reasoning text, _description text, _proposed_end timestamp with time zone, _venue_name text, _venue_address text, _confidence numeric) TO anon;
GRANT ALL ON FUNCTION public.propose_direct_hangout(_direct_user_id uuid, _title text, _proposed_start timestamp with time zone, _reasoning text, _description text, _proposed_end timestamp with time zone, _venue_name text, _venue_address text, _confidence numeric) TO authenticated;
GRANT ALL ON FUNCTION public.propose_direct_hangout(_direct_user_id uuid, _title text, _proposed_start timestamp with time zone, _reasoning text, _description text, _proposed_end timestamp with time zone, _venue_name text, _venue_address text, _confidence numeric) TO service_role;


--
-- Name: FUNCTION propose_hangout(_group_id uuid, _title text, _proposed_start timestamp with time zone, _reasoning text, _description text, _proposed_end timestamp with time zone, _venue_name text, _venue_address text, _confidence numeric); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.propose_hangout(_group_id uuid, _title text, _proposed_start timestamp with time zone, _reasoning text, _description text, _proposed_end timestamp with time zone, _venue_name text, _venue_address text, _confidence numeric) FROM PUBLIC;
GRANT ALL ON FUNCTION public.propose_hangout(_group_id uuid, _title text, _proposed_start timestamp with time zone, _reasoning text, _description text, _proposed_end timestamp with time zone, _venue_name text, _venue_address text, _confidence numeric) TO anon;
GRANT ALL ON FUNCTION public.propose_hangout(_group_id uuid, _title text, _proposed_start timestamp with time zone, _reasoning text, _description text, _proposed_end timestamp with time zone, _venue_name text, _venue_address text, _confidence numeric) TO authenticated;
GRANT ALL ON FUNCTION public.propose_hangout(_group_id uuid, _title text, _proposed_start timestamp with time zone, _reasoning text, _description text, _proposed_end timestamp with time zone, _venue_name text, _venue_address text, _confidence numeric) TO service_role;


--
-- Name: FUNCTION propose_hangout(_group_id uuid, _title text, _proposed_start timestamp with time zone, _reasoning text, _description text, _proposed_end timestamp with time zone, _venue_name text, _venue_address text, _confidence numeric, _min_attendees integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.propose_hangout(_group_id uuid, _title text, _proposed_start timestamp with time zone, _reasoning text, _description text, _proposed_end timestamp with time zone, _venue_name text, _venue_address text, _confidence numeric, _min_attendees integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.propose_hangout(_group_id uuid, _title text, _proposed_start timestamp with time zone, _reasoning text, _description text, _proposed_end timestamp with time zone, _venue_name text, _venue_address text, _confidence numeric, _min_attendees integer) TO anon;
GRANT ALL ON FUNCTION public.propose_hangout(_group_id uuid, _title text, _proposed_start timestamp with time zone, _reasoning text, _description text, _proposed_end timestamp with time zone, _venue_name text, _venue_address text, _confidence numeric, _min_attendees integer) TO authenticated;
GRANT ALL ON FUNCTION public.propose_hangout(_group_id uuid, _title text, _proposed_start timestamp with time zone, _reasoning text, _description text, _proposed_end timestamp with time zone, _venue_name text, _venue_address text, _confidence numeric, _min_attendees integer) TO service_role;


--
-- Name: FUNCTION purge_old_chat(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.purge_old_chat() FROM PUBLIC;
GRANT ALL ON FUNCTION public.purge_old_chat() TO service_role;


--
-- Name: FUNCTION push_goal_pacing(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.push_goal_pacing() TO anon;
GRANT ALL ON FUNCTION public.push_goal_pacing() TO authenticated;
GRANT ALL ON FUNCTION public.push_goal_pacing() TO service_role;


--
-- Name: FUNCTION push_hangout_soon(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.push_hangout_soon() TO anon;
GRANT ALL ON FUNCTION public.push_hangout_soon() TO authenticated;
GRANT ALL ON FUNCTION public.push_hangout_soon() TO service_role;


--
-- Name: FUNCTION push_leave_by(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.push_leave_by() TO anon;
GRANT ALL ON FUNCTION public.push_leave_by() TO authenticated;
GRANT ALL ON FUNCTION public.push_leave_by() TO service_role;


--
-- Name: FUNCTION push_rsvp_nudges(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.push_rsvp_nudges() TO anon;
GRANT ALL ON FUNCTION public.push_rsvp_nudges() TO authenticated;
GRANT ALL ON FUNCTION public.push_rsvp_nudges() TO service_role;


--
-- Name: FUNCTION push_workout_start(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.push_workout_start() TO anon;
GRANT ALL ON FUNCTION public.push_workout_start() TO authenticated;
GRANT ALL ON FUNCTION public.push_workout_start() TO service_role;


--
-- Name: FUNCTION rebuild_places(_user uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rebuild_places(_user uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.rebuild_places(_user uuid) TO service_role;


--
-- Name: FUNCTION rebuild_places_and_routines_all(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rebuild_places_and_routines_all() FROM PUBLIC;
GRANT ALL ON FUNCTION public.rebuild_places_and_routines_all() TO service_role;


--
-- Name: FUNCTION rebuild_routines(_user uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rebuild_routines(_user uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.rebuild_routines(_user uuid) TO service_role;


--
-- Name: FUNCTION reclassify_moving_stays(_user uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.reclassify_moving_stays(_user uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.reclassify_moving_stays(_user uuid) TO service_role;


--
-- Name: FUNCTION reconcile_health_workouts(_max integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.reconcile_health_workouts(_max integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.reconcile_health_workouts(_max integer) TO anon;
GRANT ALL ON FUNCTION public.reconcile_health_workouts(_max integer) TO authenticated;
GRANT ALL ON FUNCTION public.reconcile_health_workouts(_max integer) TO service_role;


--
-- Name: FUNCTION reject_change_set(_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.reject_change_set(_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.reject_change_set(_id uuid) TO anon;
GRANT ALL ON FUNCTION public.reject_change_set(_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.reject_change_set(_id uuid) TO service_role;


--
-- Name: FUNCTION request_friendship_by_handle(_handle text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.request_friendship_by_handle(_handle text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.request_friendship_by_handle(_handle text) TO anon;
GRANT ALL ON FUNCTION public.request_friendship_by_handle(_handle text) TO authenticated;
GRANT ALL ON FUNCTION public.request_friendship_by_handle(_handle text) TO service_role;


--
-- Name: FUNCTION resolve_activity_check(_id uuid, _result text, _actual_label text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.resolve_activity_check(_id uuid, _result text, _actual_label text) TO anon;
GRANT ALL ON FUNCTION public.resolve_activity_check(_id uuid, _result text, _actual_label text) TO authenticated;
GRANT ALL ON FUNCTION public.resolve_activity_check(_id uuid, _result text, _actual_label text) TO service_role;


--
-- Name: FUNCTION respond_to_friendship(_other_user uuid, _action text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.respond_to_friendship(_other_user uuid, _action text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.respond_to_friendship(_other_user uuid, _action text) TO anon;
GRANT ALL ON FUNCTION public.respond_to_friendship(_other_user uuid, _action text) TO authenticated;
GRANT ALL ON FUNCTION public.respond_to_friendship(_other_user uuid, _action text) TO service_role;


--
-- Name: FUNCTION respond_to_hangout(_hangout_id uuid, _status text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.respond_to_hangout(_hangout_id uuid, _status text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.respond_to_hangout(_hangout_id uuid, _status text) TO anon;
GRANT ALL ON FUNCTION public.respond_to_hangout(_hangout_id uuid, _status text) TO authenticated;
GRANT ALL ON FUNCTION public.respond_to_hangout(_hangout_id uuid, _status text) TO service_role;


--
-- Name: FUNCTION send_due_reminders(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.send_due_reminders() TO anon;
GRANT ALL ON FUNCTION public.send_due_reminders() TO authenticated;
GRANT ALL ON FUNCTION public.send_due_reminders() TO service_role;


--
-- Name: FUNCTION send_push_to_users(_user_ids uuid[], _title text, _body text, _data jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.send_push_to_users(_user_ids uuid[], _title text, _body text, _data jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.send_push_to_users(_user_ids uuid[], _title text, _body text, _data jsonb) TO anon;
GRANT ALL ON FUNCTION public.send_push_to_users(_user_ids uuid[], _title text, _body text, _data jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.send_push_to_users(_user_ids uuid[], _title text, _body text, _data jsonb) TO service_role;


--
-- Name: FUNCTION set_friend_tier(_other_user uuid, _tier text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.set_friend_tier(_other_user uuid, _tier text) TO anon;
GRANT ALL ON FUNCTION public.set_friend_tier(_other_user uuid, _tier text) TO authenticated;
GRANT ALL ON FUNCTION public.set_friend_tier(_other_user uuid, _tier text) TO service_role;


--
-- Name: FUNCTION set_handle(_handle text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.set_handle(_handle text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.set_handle(_handle text) TO anon;
GRANT ALL ON FUNCTION public.set_handle(_handle text) TO authenticated;
GRANT ALL ON FUNCTION public.set_handle(_handle text) TO service_role;


--
-- Name: FUNCTION set_hangout_invite_policy(_hangout_id uuid, _policy text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.set_hangout_invite_policy(_hangout_id uuid, _policy text) TO anon;
GRANT ALL ON FUNCTION public.set_hangout_invite_policy(_hangout_id uuid, _policy text) TO authenticated;
GRANT ALL ON FUNCTION public.set_hangout_invite_policy(_hangout_id uuid, _policy text) TO service_role;


--
-- Name: FUNCTION set_push_token(_token text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.set_push_token(_token text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.set_push_token(_token text) TO anon;
GRANT ALL ON FUNCTION public.set_push_token(_token text) TO authenticated;
GRANT ALL ON FUNCTION public.set_push_token(_token text) TO service_role;


--
-- Name: FUNCTION set_updated_at(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.set_updated_at() TO anon;
GRANT ALL ON FUNCTION public.set_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.set_updated_at() TO service_role;


--
-- Name: FUNCTION shares_group_with(_other_user uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.shares_group_with(_other_user uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.shares_group_with(_other_user uuid) TO anon;
GRANT ALL ON FUNCTION public.shares_group_with(_other_user uuid) TO authenticated;
GRANT ALL ON FUNCTION public.shares_group_with(_other_user uuid) TO service_role;


--
-- Name: FUNCTION stay_centroid(_user uuid, _from timestamp with time zone, _to timestamp with time zone, OUT lat double precision, OUT lon double precision); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.stay_centroid(_user uuid, _from timestamp with time zone, _to timestamp with time zone, OUT lat double precision, OUT lon double precision) FROM PUBLIC;
GRANT ALL ON FUNCTION public.stay_centroid(_user uuid, _from timestamp with time zone, _to timestamp with time zone, OUT lat double precision, OUT lon double precision) TO service_role;


--
-- Name: FUNCTION stay_end_by_motion(_user uuid, _from timestamp with time zone, _to timestamp with time zone, OUT departed timestamp with time zone, OUT next_arrival timestamp with time zone); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.stay_end_by_motion(_user uuid, _from timestamp with time zone, _to timestamp with time zone, OUT departed timestamp with time zone, OUT next_arrival timestamp with time zone) TO anon;
GRANT ALL ON FUNCTION public.stay_end_by_motion(_user uuid, _from timestamp with time zone, _to timestamp with time zone, OUT departed timestamp with time zone, OUT next_arrival timestamp with time zone) TO authenticated;
GRANT ALL ON FUNCTION public.stay_end_by_motion(_user uuid, _from timestamp with time zone, _to timestamp with time zone, OUT departed timestamp with time zone, OUT next_arrival timestamp with time zone) TO service_role;


--
-- Name: FUNCTION stay_name_near(_user uuid, _lat double precision, _lon double precision); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.stay_name_near(_user uuid, _lat double precision, _lon double precision) FROM PUBLIC;
GRANT ALL ON FUNCTION public.stay_name_near(_user uuid, _lat double precision, _lon double precision) TO service_role;


--
-- Name: FUNCTION stays_needing_names(_limit integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.stays_needing_names(_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.stays_needing_names(_limit integer) TO service_role;


--
-- Name: FUNCTION summary_users(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.summary_users() FROM PUBLIC;
GRANT ALL ON FUNCTION public.summary_users() TO service_role;


--
-- Name: FUNCTION system_health_check(_notify boolean); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.system_health_check(_notify boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.system_health_check(_notify boolean) TO service_role;


--
-- Name: FUNCTION tg_calendar_events_sync_movable(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.tg_calendar_events_sync_movable() TO anon;
GRANT ALL ON FUNCTION public.tg_calendar_events_sync_movable() TO authenticated;
GRANT ALL ON FUNCTION public.tg_calendar_events_sync_movable() TO service_role;


--
-- Name: FUNCTION tg_hangout_responses_sync_calendar(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.tg_hangout_responses_sync_calendar() TO anon;
GRANT ALL ON FUNCTION public.tg_hangout_responses_sync_calendar() TO authenticated;
GRANT ALL ON FUNCTION public.tg_hangout_responses_sync_calendar() TO service_role;


--
-- Name: FUNCTION tg_hangouts_sync_calendar(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.tg_hangouts_sync_calendar() TO anon;
GRANT ALL ON FUNCTION public.tg_hangouts_sync_calendar() TO authenticated;
GRANT ALL ON FUNCTION public.tg_hangouts_sync_calendar() TO service_role;


--
-- Name: FUNCTION tg_push_friendship_event(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.tg_push_friendship_event() TO anon;
GRANT ALL ON FUNCTION public.tg_push_friendship_event() TO authenticated;
GRANT ALL ON FUNCTION public.tg_push_friendship_event() TO service_role;


--
-- Name: FUNCTION tg_push_hangout_proposed(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.tg_push_hangout_proposed() TO anon;
GRANT ALL ON FUNCTION public.tg_push_hangout_proposed() TO authenticated;
GRANT ALL ON FUNCTION public.tg_push_hangout_proposed() TO service_role;


--
-- Name: FUNCTION tg_push_hangout_status_change(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.tg_push_hangout_status_change() TO anon;
GRANT ALL ON FUNCTION public.tg_push_hangout_status_change() TO authenticated;
GRANT ALL ON FUNCTION public.tg_push_hangout_status_change() TO service_role;


--
-- Name: FUNCTION tg_routine_blocks_yield(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.tg_routine_blocks_yield() TO anon;
GRANT ALL ON FUNCTION public.tg_routine_blocks_yield() TO authenticated;
GRANT ALL ON FUNCTION public.tg_routine_blocks_yield() TO service_role;


--
-- Name: FUNCTION travel_mode_for(_user uuid, _from timestamp with time zone, _to timestamp with time zone); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.travel_mode_for(_user uuid, _from timestamp with time zone, _to timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION public.travel_mode_for(_user uuid, _from timestamp with time zone, _to timestamp with time zone) TO service_role;


--
-- Name: FUNCTION try_proactive_push(_user uuid, _kind text, _dedupe text, _title text, _body text, _data jsonb); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.try_proactive_push(_user uuid, _kind text, _dedupe text, _title text, _body text, _data jsonb) TO anon;
GRANT ALL ON FUNCTION public.try_proactive_push(_user uuid, _kind text, _dedupe text, _title text, _body text, _data jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.try_proactive_push(_user uuid, _kind text, _dedupe text, _title text, _body text, _data jsonb) TO service_role;


--
-- Name: FUNCTION unfriend(_other_user uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.unfriend(_other_user uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.unfriend(_other_user uuid) TO anon;
GRANT ALL ON FUNCTION public.unfriend(_other_user uuid) TO authenticated;
GRANT ALL ON FUNCTION public.unfriend(_other_user uuid) TO service_role;


--
-- Name: FUNCTION update_hangout(_hangout_id uuid, _new_start timestamp with time zone, _new_end timestamp with time zone, _new_title text, _new_venue_name text, _new_venue_addr text, _new_description text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.update_hangout(_hangout_id uuid, _new_start timestamp with time zone, _new_end timestamp with time zone, _new_title text, _new_venue_name text, _new_venue_addr text, _new_description text) TO anon;
GRANT ALL ON FUNCTION public.update_hangout(_hangout_id uuid, _new_start timestamp with time zone, _new_end timestamp with time zone, _new_title text, _new_venue_name text, _new_venue_addr text, _new_description text) TO authenticated;
GRANT ALL ON FUNCTION public.update_hangout(_hangout_id uuid, _new_start timestamp with time zone, _new_end timestamp with time zone, _new_title text, _new_venue_name text, _new_venue_addr text, _new_description text) TO service_role;


--
-- Name: FUNCTION was_moving(_user uuid, _from timestamp with time zone, _to timestamp with time zone); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.was_moving(_user uuid, _from timestamp with time zone, _to timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION public.was_moving(_user uuid, _from timestamp with time zone, _to timestamp with time zone) TO service_role;


--
-- Name: TABLE activity_log; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.activity_log TO anon;
GRANT ALL ON TABLE public.activity_log TO authenticated;
GRANT ALL ON TABLE public.activity_log TO service_role;


--
-- Name: TABLE activity_patterns; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.activity_patterns TO anon;
GRANT ALL ON TABLE public.activity_patterns TO authenticated;
GRANT ALL ON TABLE public.activity_patterns TO service_role;


--
-- Name: TABLE app_config; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.app_config TO anon;
GRANT ALL ON TABLE public.app_config TO authenticated;
GRANT ALL ON TABLE public.app_config TO service_role;


--
-- Name: TABLE app_sessions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.app_sessions TO anon;
GRANT ALL ON TABLE public.app_sessions TO authenticated;
GRANT ALL ON TABLE public.app_sessions TO service_role;


--
-- Name: TABLE behavioral_pings; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.behavioral_pings TO anon;
GRANT ALL ON TABLE public.behavioral_pings TO authenticated;
GRANT ALL ON TABLE public.behavioral_pings TO service_role;


--
-- Name: TABLE behavioral_summary; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.behavioral_summary TO anon;
GRANT ALL ON TABLE public.behavioral_summary TO authenticated;
GRANT ALL ON TABLE public.behavioral_summary TO service_role;


--
-- Name: TABLE calendar_events; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.calendar_events TO anon;
GRANT ALL ON TABLE public.calendar_events TO authenticated;
GRANT ALL ON TABLE public.calendar_events TO service_role;


--
-- Name: TABLE change_sets; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.change_sets TO anon;
GRANT ALL ON TABLE public.change_sets TO authenticated;
GRANT ALL ON TABLE public.change_sets TO service_role;


--
-- Name: TABLE chat_messages; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.chat_messages TO anon;
GRANT ALL ON TABLE public.chat_messages TO authenticated;
GRANT ALL ON TABLE public.chat_messages TO service_role;


--
-- Name: TABLE collection_health; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.collection_health TO anon;
GRANT ALL ON TABLE public.collection_health TO authenticated;
GRANT ALL ON TABLE public.collection_health TO service_role;


--
-- Name: TABLE events; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.events TO anon;
GRANT ALL ON TABLE public.events TO authenticated;
GRANT ALL ON TABLE public.events TO service_role;


--
-- Name: TABLE friendships; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.friendships TO anon;
GRANT ALL ON TABLE public.friendships TO authenticated;
GRANT ALL ON TABLE public.friendships TO service_role;


--
-- Name: TABLE goal_plans; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.goal_plans TO anon;
GRANT ALL ON TABLE public.goal_plans TO authenticated;
GRANT ALL ON TABLE public.goal_plans TO service_role;


--
-- Name: TABLE goals; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.goals TO anon;
GRANT ALL ON TABLE public.goals TO authenticated;
GRANT ALL ON TABLE public.goals TO service_role;


--
-- Name: TABLE google_oauth_tokens; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.google_oauth_tokens TO anon;
GRANT ALL ON TABLE public.google_oauth_tokens TO authenticated;
GRANT ALL ON TABLE public.google_oauth_tokens TO service_role;


--
-- Name: TABLE group_members; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.group_members TO anon;
GRANT ALL ON TABLE public.group_members TO authenticated;
GRANT ALL ON TABLE public.group_members TO service_role;


--
-- Name: TABLE groups; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.groups TO anon;
GRANT ALL ON TABLE public.groups TO authenticated;
GRANT ALL ON TABLE public.groups TO service_role;


--
-- Name: TABLE hangout_responses; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.hangout_responses TO anon;
GRANT ALL ON TABLE public.hangout_responses TO authenticated;
GRANT ALL ON TABLE public.hangout_responses TO service_role;


--
-- Name: TABLE health_sleep; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.health_sleep TO anon;
GRANT ALL ON TABLE public.health_sleep TO authenticated;
GRANT ALL ON TABLE public.health_sleep TO service_role;


--
-- Name: TABLE health_workouts; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.health_workouts TO anon;
GRANT ALL ON TABLE public.health_workouts TO authenticated;
GRANT ALL ON TABLE public.health_workouts TO service_role;


--
-- Name: TABLE interests; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.interests TO anon;
GRANT ALL ON TABLE public.interests TO authenticated;
GRANT ALL ON TABLE public.interests TO service_role;


--
-- Name: TABLE motion_activity; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.motion_activity TO anon;
GRANT ALL ON TABLE public.motion_activity TO authenticated;
GRANT ALL ON TABLE public.motion_activity TO service_role;


--
-- Name: TABLE places; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.places TO anon;
GRANT SELECT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.places TO authenticated;
GRANT ALL ON TABLE public.places TO service_role;


--
-- Name: COLUMN places.category; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(category) ON TABLE public.places TO authenticated;


--
-- Name: COLUMN places.user_label; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(user_label) ON TABLE public.places TO authenticated;


--
-- Name: COLUMN places.is_hidden; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(is_hidden) ON TABLE public.places TO authenticated;


--
-- Name: COLUMN places.inference_status; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(inference_status) ON TABLE public.places TO authenticated;


--
-- Name: COLUMN places.updated_at; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE public.places TO authenticated;


--
-- Name: COLUMN places.last_asked_at; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(last_asked_at) ON TABLE public.places TO authenticated;


--
-- Name: TABLE proactive_pushes; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.proactive_pushes TO anon;
GRANT ALL ON TABLE public.proactive_pushes TO authenticated;
GRANT ALL ON TABLE public.proactive_pushes TO service_role;


--
-- Name: TABLE profiles; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.profiles TO anon;
GRANT ALL ON TABLE public.profiles TO authenticated;
GRANT ALL ON TABLE public.profiles TO service_role;


--
-- Name: TABLE reminders; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.reminders TO anon;
GRANT ALL ON TABLE public.reminders TO authenticated;
GRANT ALL ON TABLE public.reminders TO service_role;


--
-- Name: TABLE routines; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.routines TO anon;
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.routines TO authenticated;
GRANT ALL ON TABLE public.routines TO service_role;


--
-- Name: COLUMN routines.active; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(active) ON TABLE public.routines TO authenticated;


--
-- Name: COLUMN routines.inference_status; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(inference_status) ON TABLE public.routines TO authenticated;


--
-- Name: COLUMN routines.updated_at; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE public.routines TO authenticated;


--
-- Name: COLUMN routines.last_asked_at; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(last_asked_at) ON TABLE public.routines TO authenticated;


--
-- Name: TABLE schedule_suggestions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.schedule_suggestions TO anon;
GRANT ALL ON TABLE public.schedule_suggestions TO authenticated;
GRANT ALL ON TABLE public.schedule_suggestions TO service_role;


--
-- Name: TABLE stay_names; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.stay_names TO anon;
GRANT ALL ON TABLE public.stay_names TO authenticated;
GRANT ALL ON TABLE public.stay_names TO service_role;


--
-- Name: TABLE step_counts; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.step_counts TO anon;
GRANT ALL ON TABLE public.step_counts TO authenticated;
GRANT ALL ON TABLE public.step_counts TO service_role;


--
-- Name: TABLE system_health_probes; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.system_health_probes TO anon;
GRANT ALL ON TABLE public.system_health_probes TO authenticated;
GRANT ALL ON TABLE public.system_health_probes TO service_role;


--
-- Name: SEQUENCE system_health_probes_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.system_health_probes_id_seq TO anon;
GRANT ALL ON SEQUENCE public.system_health_probes_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.system_health_probes_id_seq TO service_role;


--
-- Name: TABLE system_health_runs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.system_health_runs TO anon;
GRANT ALL ON TABLE public.system_health_runs TO authenticated;
GRANT ALL ON TABLE public.system_health_runs TO service_role;


--
-- Name: SEQUENCE system_health_runs_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.system_health_runs_id_seq TO anon;
GRANT ALL ON SEQUENCE public.system_health_runs_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.system_health_runs_id_seq TO service_role;


--
-- Name: TABLE venues; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.venues TO anon;
GRANT ALL ON TABLE public.venues TO authenticated;
GRANT ALL ON TABLE public.venues TO service_role;


--
-- Name: TABLE visits; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.visits TO anon;
GRANT ALL ON TABLE public.visits TO authenticated;
GRANT ALL ON TABLE public.visits TO service_role;


--
-- Name: TABLE wifi_networks; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.wifi_networks TO anon;
GRANT ALL ON TABLE public.wifi_networks TO authenticated;
GRANT ALL ON TABLE public.wifi_networks TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO service_role;


--
-- PostgreSQL database dump complete
--

