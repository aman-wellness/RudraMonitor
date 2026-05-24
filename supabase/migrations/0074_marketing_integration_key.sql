-- Surface the marketing OpenAI key in the super-admin Integrations page
-- so it can be edited from the UI instead of SSH-ing into the EC2 host
-- to nano /etc/rudrans-marketing.env. The EC2 generate.py script reads
-- this row at the start of every run (falls back to the env var so old
-- setups keep working).

BEGIN;

INSERT INTO public.integrations (key, value, category, label, description, is_secret)
VALUES (
  'MARKETING_OPENAI_API_KEY',
  '',
  'marketing',
  'Marketing OpenAI Key',
  'OpenAI API key used by the daily/weekly AI marketing content generator (GPT-4o + DALL-E 3 + TTS). Kept separate from the DLP OPENAI_API_KEY so marketing spend can be tracked independently. Expected format: sk-proj-...',
  true
)
ON CONFLICT (key) DO NOTHING;

COMMIT;
