-- Speed up license_key lookup during enrollment.
create unique index if not exists organizations_license_key_uniq
  on public.organizations (license_key);

-- One agent row per (org, machine) so re-installs are idempotent.
create unique index if not exists agents_org_machine_uniq
  on public.agents (org_id, machine_name);

-- Index on enroll_token for fast ingest validation.
create index if not exists agents_enroll_token_idx
  on public.agents (enroll_token);
