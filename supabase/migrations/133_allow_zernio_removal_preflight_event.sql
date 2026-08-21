alter table public.zernio_profile_recycling_job_events
  drop constraint zernio_profile_recycling_job_events_event_type_check;

alter table public.zernio_profile_recycling_job_events
  add constraint zernio_profile_recycling_job_events_event_type_check
  check (event_type in (
    'scheduled', 'deferred', 'claimed', 'retry_scheduled',
    'dead_lettered', 'reopened', 'completed', 'removal_preflight_approved'
  ));
