-- Public storage bucket that mirrors extracted RustDesk release binaries
-- per platform. The CI workflow's "Bundle rustdesk" step curls from here
-- and drops the binary into the agent's tauri resources before bundling.
--
-- Upload procedure (one-time per RustDesk upstream release):
--   1. Download upstream installer/dmg/deb for each platform
--   2. Extract the raw `rustdesk[.exe]` binary
--   3. Upload via dashboard /admin/integrations OR curl:
--      curl -X POST \
--        -H "Authorization: Bearer <service_role>" \
--        -H "Content-Type: application/octet-stream" \
--        --data-binary @rustdesk \
--        https://api-ems.wellnessextract.com/storage/v1/object/rustdesk/rustdesk-macos-arm64
--
-- Object naming convention (matches workflow case-statement):
--   rustdesk-macos-arm64
--   rustdesk-macos-x64
--   rustdesk-windows-x64.exe
--   rustdesk-linux-x64

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'rustdesk', 'rustdesk', true,
  157286400, -- 150 MB cap (rustdesk binary is ~30-40 MB per platform)
  array['application/octet-stream', 'application/x-executable']::text[]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
