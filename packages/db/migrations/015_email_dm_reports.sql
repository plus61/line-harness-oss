-- Migration 015: Email DM report timestamps + delivery/open columns
--
-- Adds per-campaign cadence-report bookkeeping so the cron-driven
-- Discord metrics push (services/email-dm-report.ts) is idempotent
-- across the every-5-minute scheduled handler. Also adds delivered/
-- opened mirror columns on recipients for Resend webhook events.

ALTER TABLE email_dm_campaigns ADD COLUMN report_24h_sent_at TEXT;
ALTER TABLE email_dm_campaigns ADD COLUMN report_48h_sent_at TEXT;
ALTER TABLE email_dm_campaigns ADD COLUMN report_1w_sent_at TEXT;

ALTER TABLE email_dm_recipients ADD COLUMN delivered_at TEXT;
ALTER TABLE email_dm_recipients ADD COLUMN opened_at TEXT;
ALTER TABLE email_dm_recipients ADD COLUMN open_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_email_dm_recipients_resend_id
  ON email_dm_recipients (resend_message_id)
  WHERE resend_message_id IS NOT NULL;
