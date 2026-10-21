-- Scheduled jobs (pg_cron). These live in the `cron` schema, so they are not
-- part of schema.sql. Times are UTC. Functions that call edge functions
-- (invoke_*) read the cron secret from app_config at run time — no secrets here.
--
-- Restore: run after schema.sql on a database with pg_cron + pg_net enabled.

select cron.schedule('align_routines_to_arrival_10min', '*/10 * * * *',   $$SELECT public.align_routines_to_arrival();$$);
select cron.schedule('app_sessions_30d_cleanup',        '0 3 * * *',      $$DELETE FROM public.app_sessions WHERE opened_at < now() - interval '30 days'$$);
select cron.schedule('build_visits_10min',              '3-59/10 * * * *', $$SELECT public.build_visits_all();$$);
select cron.schedule('check_activities_6h',             '15 */6 * * *',   $$SELECT public.check_activities();$$);
select cron.schedule('detect_goal_time_drift_daily',    '30 17 * * *',    $$SELECT public.detect_goal_time_drift();$$);
select cron.schedule('evaluate_active_blocks_5min',     '*/5 * * * *',    $$SELECT public.evaluate_active_blocks();$$);
select cron.schedule('expire_stale_change_sets_hourly', '23 * * * *',     $$SELECT public.expire_stale_change_sets();$$);
select cron.schedule('expire_stale_hangouts_hourly',    '7 * * * *',      $$SELECT public.expire_stale_hangouts();$$);
select cron.schedule('google_calendar_sync_30min',      '*/30 * * * *',   $$SELECT public.invoke_google_calendar_sync();$$);
select cron.schedule('health_probe_daily',              '40 5 * * *',     $$SELECT public.invoke_health_probe();$$);
select cron.schedule('materialize_goal_plans_daily',    '20 2 * * *',     $$select public.materialize_goal_plans();$$);
select cron.schedule('materialize_routines_daily',      '0 2 * * *',      $$SELECT public.materialize_routines();$$);
select cron.schedule('name_stays_30min',                '20,50 * * * *',  $$SELECT public.invoke_name_stays();$$);
select cron.schedule('post_curiosity_questions_hourly', '41 * * * *',     $$SELECT public.post_curiosity_questions();$$);
select cron.schedule('proactive_weather_hourly',        '13 * * * *',     $$SELECT public.invoke_proactive_weather();$$);
select cron.schedule('purge_old_chat_daily',            '25 3 * * *',     $$SELECT public.purge_old_chat();$$);
select cron.schedule('push_goal_pacing_hourly',         '11 * * * *',     $$SELECT public.push_goal_pacing();$$);
select cron.schedule('push_hangout_soon_10min',         '*/10 * * * *',   $$SELECT public.push_hangout_soon();$$);
select cron.schedule('push_leave_by_5min',              '*/5 * * * *',    $$SELECT public.push_leave_by();$$);
select cron.schedule('push_rsvp_nudges_hourly',         '37 * * * *',     $$SELECT public.push_rsvp_nudges();$$);
select cron.schedule('push_workout_start_5min',         '*/5 * * * *',    $$SELECT public.push_workout_start();$$);
select cron.schedule('rebuild_places_routines_hourly',  '17 * * * *',     $$SELECT public.rebuild_places_and_routines_all();$$);
select cron.schedule('rebuild_summaries_6h',            '35 */6 * * *',   $$SELECT public.invoke_rebuild_summaries();$$);
select cron.schedule('resolve_places_hourly',           '27 * * * *',     $$SELECT public.invoke_resolve_places();$$);
select cron.schedule('send_due_reminders_minutely',     '* * * * *',      $$SELECT public.send_due_reminders();$$);
select cron.schedule('system_health_check_daily',       '0 6 * * *',      $$SELECT public.system_health_check();$$);
