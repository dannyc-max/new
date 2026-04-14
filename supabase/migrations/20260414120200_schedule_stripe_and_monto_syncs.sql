-- Schedule stripe-sync at 7am UTC and monto-sync at 8am UTC.
-- Uses the same pattern as the existing sync-webflow-orders job (6am UTC).
-- Unschedule first so re-running the migration is idempotent.

do $$
begin
  perform cron.unschedule('sync-stripe-charges');
exception when others then null;
end $$;

do $$
begin
  perform cron.unschedule('sync-monto-subscriptions');
exception when others then null;
end $$;

select cron.schedule(
  'sync-stripe-charges',
  '0 7 * * *',
  $cron$
  select net.http_post(
    url := 'https://jiqkhinnzqxvkzkihufa.supabase.co/functions/v1/stripe-sync',
    headers := ('{"Content-Type": "application/json", "apikey": "' ||
      current_setting('app.settings.service_role_key') || '"}')::jsonb,
    body := '{}'::jsonb
  );
  $cron$
);

select cron.schedule(
  'sync-monto-subscriptions',
  '0 8 * * *',
  $cron$
  select net.http_post(
    url := 'https://jiqkhinnzqxvkzkihufa.supabase.co/functions/v1/monto-sync',
    headers := ('{"Content-Type": "application/json", "apikey": "' ||
      current_setting('app.settings.service_role_key') || '"}')::jsonb,
    body := '{}'::jsonb
  );
  $cron$
);
