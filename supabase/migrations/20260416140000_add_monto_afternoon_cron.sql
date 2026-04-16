-- Add a second daily Monto sync at 20:00 UTC.
--
-- Context: the 08:00 UTC run can only refresh ~54 of our 178 known-sub
-- orders within the 150s free-tier edge-function wall clock (178 * 2.2s
-- per-request pacing = ~392s of work). A second afternoon run gets all
-- 178 refreshed inside one day.
--
-- The command body mirrors what's actually deployed for jobid=3 today
-- (anon JWT inline, both apikey and Authorization headers, pg_net
-- timeout >= 150000ms). The anon key is safe to commit because it's
-- embedded in every Supabase client app by design.
--
-- Idempotent: unschedule first so re-running this migration is safe.

do $$
begin
  perform cron.unschedule('sync-monto-subscriptions-pm');
exception when others then null;
end $$;

select cron.schedule(
  'sync-monto-subscriptions-pm',
  '0 20 * * *',
  $cron$
    select net.http_post(
      url := 'https://jiqkhinnzqxvkzkihufa.supabase.co/functions/v1/monto-sync',
      headers := jsonb_build_object(
        'Content-Type','application/json',
        'apikey','eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImppcWtoaW5uenF4dmt6a2lodWZhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYxMzE5OTIsImV4cCI6MjA5MTcwNzk5Mn0.3-4wog0JjVMiV8ciMflmkb3GIGHz1yto3jKUzsTfO1A',
        'Authorization','Bearer ' || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImppcWtoaW5uenF4dmt6a2lodWZhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYxMzE5OTIsImV4cCI6MjA5MTcwNzk5Mn0.3-4wog0JjVMiV8ciMflmkb3GIGHz1yto3jKUzsTfO1A'
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 150000
    );
  $cron$
);
