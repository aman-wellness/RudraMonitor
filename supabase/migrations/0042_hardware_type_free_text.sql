-- 0042_hardware_type_free_text.sql
-- Allow any free-text device type so admins can capture niche assets (e.g.
-- "headset", "iPad Pro 12.9", "yubikey"). The UI still shows quick-pick
-- options as a dropdown; selecting "other" reveals a text input that stores
-- the custom string here directly.

alter table public.hardware_assets
  drop constraint if exists hardware_assets_device_type_check;
