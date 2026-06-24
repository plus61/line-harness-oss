-- Migration 014: Email DM campaigns + recipients + events
--
-- Phase 1 Campaign A (wayback): 44 recipients, sato@dragon-ai.jp sender.
-- Tracking via /goe/{code} click redirect and /u/{code} one-click unsubscribe.
-- Reputation isolated from transactional dragon-ai-tr.com sender.

CREATE TABLE IF NOT EXISTS email_dm_campaigns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  subject TEXT NOT NULL,
  html_template TEXT NOT NULL,
  text_template TEXT NOT NULL,
  from_name TEXT,                                                       -- nullable → falls back to RESEND_DM_FROM env default
  from_address TEXT,                                                    -- nullable → falls back to RESEND_DM_FROM env default
  reply_to TEXT,
  redirect_url_template TEXT NOT NULL,                                  -- '{{redirect}}' placeholders replaced per recipient before sendDmEmail
  unsubscribe_url_template TEXT NOT NULL,                               -- usually '{{worker_url}}/u/{{recipient_code}}'
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','dispatching','sent','paused')),
  dispatch_started_at TEXT,
  dispatch_finished_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS email_dm_recipients (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES email_dm_campaigns (id) ON DELETE CASCADE,
  recipient_code TEXT NOT NULL UNIQUE,                                  -- opaque id used in /goe/{code} and /u/{code}
  email TEXT NOT NULL,
  office_name TEXT,
  representative TEXT,
  fax_code TEXT,                                                        -- maps to existing /demo-{faxCode}.html landing page
  variables TEXT NOT NULL DEFAULT '{}',                                 -- JSON: per-recipient template substitution map
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','bounced','unsubscribed','complained','suppressed')),
  resend_message_id TEXT,
  sent_at TEXT,
  first_click_at TEXT,
  click_count INTEGER NOT NULL DEFAULT 0,
  unsubscribed_at TEXT,
  bounced_at TEXT,
  bounce_reason TEXT,
  complained_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_email_dm_recipients_campaign ON email_dm_recipients (campaign_id);
CREATE INDEX IF NOT EXISTS idx_email_dm_recipients_status ON email_dm_recipients (campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_email_dm_recipients_email ON email_dm_recipients (email);

CREATE TABLE IF NOT EXISTS email_dm_events (
  id TEXT PRIMARY KEY,
  recipient_id TEXT NOT NULL REFERENCES email_dm_recipients (id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('sent','delivered','opened','clicked','bounced','complained','unsubscribed','failed')),
  metadata TEXT NOT NULL DEFAULT '{}',                                  -- JSON: ua / ip / referrer / bounce sub-type / etc.
  occurred_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_email_dm_events_recipient ON email_dm_events (recipient_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_email_dm_events_type ON email_dm_events (event_type, occurred_at);

-- Suppression list: hard-bounced or complained addresses get auto-added by webhook (PR-C).
-- Any future campaign send must check this before queueing.
CREATE TABLE IF NOT EXISTS email_dm_suppression (
  email TEXT PRIMARY KEY,
  reason TEXT NOT NULL CHECK (reason IN ('bounce','complaint','unsubscribe','manual')),
  source_recipient_id TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
