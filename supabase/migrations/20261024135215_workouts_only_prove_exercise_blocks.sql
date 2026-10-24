-- A workout from Apple Health proves exercise blocks only: "Work block 16:00–18:00"
-- overlapping a 16:07 gym session was marked done-by-workout and took the workout.
do $mig$
declare _src text;
begin
  select pg_get_functiondef('public.check_activities()'::regprocedure) into _src;
  _src := replace(_src,
    'AND coalesce(hw.duration_min, 0) >= 5
       AND tstzrange(_ev.start_at - interval ''45 min'', _ev.end_at + interval ''45 min'')',
    'AND coalesce(hw.duration_min, 0) >= 5
       AND (_ev.event_type = ''goal''
            OR _key ~ ''(gym|train|strength|workout|run|jog|cycl|bike|ride|swim|yoga|hiit|lift|sport|fitness|exercise|walk|hike|climb|padel|tennis|football|basket)'')
       AND tstzrange(_ev.start_at - interval ''45 min'', _ev.end_at + interval ''45 min'')');
  if _src not like '%(gym|train|strength|workout%' then raise exception 'check_activities patch did not apply'; end if;
  execute _src;
end $mig$;

-- Undo what it did to non-exercise blocks: unlink the workout and drop the
-- workout-based "done" so the block is evaluated again on its own evidence.
with bad as (
  select ce.id from calendar_events ce
   where ce.health_workout_id is not null
     and ce.event_type <> 'goal'
     and lower(ce.title) !~ '(gym|train|strength|workout|run|jog|cycl|bike|ride|swim|yoga|hiit|lift|sport|fitness|exercise|walk|hike|climb|padel|tennis|football|basket)'
), unlinked as (
  update calendar_events ce set health_workout_id = null, updated_at = now() from bad where ce.id = bad.id returning ce.id
)
delete from activity_log al using unlinked where al.event_id = unlinked.id and al.confirmed_by = 'healthkit';
