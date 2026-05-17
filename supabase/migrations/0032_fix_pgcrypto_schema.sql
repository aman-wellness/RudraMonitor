-- 0032_fix_pgcrypto_schema.sql
-- On Supabase the pgcrypto extension lives in the `extensions` schema, not
-- `public`. The encrypt/decrypt SECURITY DEFINER functions in migration 0027
-- and the cred_reveal function in 0028 reference pgp_sym_encrypt /
-- pgp_sym_decrypt unqualified — that resolves only when search_path includes
-- extensions. Fully qualify the calls so the functions work regardless of the
-- caller's search_path.

create or replace function public.pgp_sym_encrypt_text_to_bytea(p_plain text, p_key text)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'forbidden';
  end if;
  return encode(extensions.pgp_sym_encrypt(p_plain, p_key), 'base64');
end$$;

create or replace function public.pgp_sym_decrypt_bytea_to_text(p_cipher_b64 text, p_key text)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'forbidden';
  end if;
  return extensions.pgp_sym_decrypt(decode(p_cipher_b64, 'base64'), p_key);
end$$;

revoke all on function public.pgp_sym_encrypt_text_to_bytea(text, text) from public, anon, authenticated;
revoke all on function public.pgp_sym_decrypt_bytea_to_text(text, text) from public, anon, authenticated;

-- Same fix for cred_reveal (used by cred-send-direct and cred-request-decision).
create or replace function public.cred_reveal(p_cred_id uuid, p_key text)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_plain text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'cred_reveal: forbidden';
  end if;
  select extensions.pgp_sym_decrypt(decode(password_enc, 'base64'), p_key)
    into v_plain
    from public.credentials
   where id = p_cred_id;
  return v_plain;
end$$;

revoke all on function public.cred_reveal(uuid, text) from public, anon, authenticated;
