import { jstNow } from './utils.js';

// =============================================================================
// Email DM — campaigns, recipients, events, suppression
// =============================================================================
//
// Phase 1 Campaign A targets 44 wayback-derived sr-list emails via
// sato@dragon-ai.jp. Click tracking through /goe/:code, one-click
// unsubscribe through /u/:code (RFC 8058).

export type EmailDmCampaignStatus = 'draft' | 'dispatching' | 'sent' | 'paused';
export type EmailDmRecipientStatus =
  | 'pending'
  | 'sent'
  | 'bounced'
  | 'unsubscribed'
  | 'complained'
  | 'suppressed';
export type EmailDmEventType =
  | 'sent'
  | 'delivered'
  | 'opened'
  | 'clicked'
  | 'bounced'
  | 'complained'
  | 'unsubscribed'
  | 'failed';
export type EmailDmSuppressionReason = 'bounce' | 'complaint' | 'unsubscribe' | 'manual';

export interface EmailDmCampaign {
  id: string;
  name: string;
  subject: string;
  html_template: string;
  text_template: string;
  from_name: string | null;
  from_address: string | null;
  reply_to: string | null;
  redirect_url_template: string;
  unsubscribe_url_template: string;
  status: EmailDmCampaignStatus;
  dispatch_started_at: string | null;
  dispatch_finished_at: string | null;
  report_24h_sent_at: string | null;
  report_48h_sent_at: string | null;
  report_1w_sent_at: string | null;
  created_at: string;
  updated_at: string;
}

export type EmailDmReportKind = '24h' | '48h' | '1w';

export interface EmailDmRecipient {
  id: string;
  campaign_id: string;
  recipient_code: string;
  email: string;
  office_name: string | null;
  representative: string | null;
  fax_code: string | null;
  variables: string;
  status: EmailDmRecipientStatus;
  resend_message_id: string | null;
  sent_at: string | null;
  delivered_at: string | null;
  opened_at: string | null;
  open_count: number;
  first_click_at: string | null;
  click_count: number;
  unsubscribed_at: string | null;
  bounced_at: string | null;
  bounce_reason: string | null;
  complained_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface EmailDmEvent {
  id: string;
  recipient_id: string;
  event_type: EmailDmEventType;
  metadata: string;
  occurred_at: string;
}

export interface EmailDmSuppression {
  email: string;
  reason: EmailDmSuppressionReason;
  source_recipient_id: string | null;
  notes: string | null;
  created_at: string;
}

// ── Campaigns ────────────────────────────────────────────────────────────────

export async function getEmailDmCampaign(
  db: D1Database,
  id: string,
): Promise<EmailDmCampaign | null> {
  return db
    .prepare(`SELECT * FROM email_dm_campaigns WHERE id = ?`)
    .bind(id)
    .first<EmailDmCampaign>();
}

export async function listEmailDmCampaigns(db: D1Database): Promise<EmailDmCampaign[]> {
  const result = await db
    .prepare(`SELECT * FROM email_dm_campaigns ORDER BY created_at DESC`)
    .all<EmailDmCampaign>();
  return result.results;
}

export async function updateEmailDmCampaignStatus(
  db: D1Database,
  id: string,
  status: EmailDmCampaignStatus,
  options: { dispatchStartedAt?: string; dispatchFinishedAt?: string } = {},
): Promise<void> {
  const now = jstNow();
  await db
    .prepare(
      `UPDATE email_dm_campaigns
       SET status = ?,
           dispatch_started_at = COALESCE(?, dispatch_started_at),
           dispatch_finished_at = COALESCE(?, dispatch_finished_at),
           updated_at = ?
       WHERE id = ?`,
    )
    .bind(
      status,
      options.dispatchStartedAt ?? null,
      options.dispatchFinishedAt ?? null,
      now,
      id,
    )
    .run();
}

// ── Recipients ───────────────────────────────────────────────────────────────

export async function getEmailDmRecipient(
  db: D1Database,
  id: string,
): Promise<EmailDmRecipient | null> {
  return db
    .prepare(`SELECT * FROM email_dm_recipients WHERE id = ?`)
    .bind(id)
    .first<EmailDmRecipient>();
}

export async function getEmailDmRecipientByCode(
  db: D1Database,
  recipientCode: string,
): Promise<EmailDmRecipient | null> {
  return db
    .prepare(`SELECT * FROM email_dm_recipients WHERE recipient_code = ?`)
    .bind(recipientCode)
    .first<EmailDmRecipient>();
}

export async function getEmailDmRecipientByResendMessageId(
  db: D1Database,
  resendMessageId: string,
): Promise<EmailDmRecipient | null> {
  return db
    .prepare(`SELECT * FROM email_dm_recipients WHERE resend_message_id = ? LIMIT 1`)
    .bind(resendMessageId)
    .first<EmailDmRecipient>();
}

export async function getEmailDmRecipientByEmail(
  db: D1Database,
  campaignId: string,
  email: string,
): Promise<EmailDmRecipient | null> {
  return db
    .prepare(
      `SELECT * FROM email_dm_recipients WHERE campaign_id = ? AND email = ? LIMIT 1`,
    )
    .bind(campaignId, email.toLowerCase())
    .first<EmailDmRecipient>();
}

export async function listEmailDmRecipientsByCampaign(
  db: D1Database,
  campaignId: string,
  options: { status?: EmailDmRecipientStatus; limit?: number } = {},
): Promise<EmailDmRecipient[]> {
  const params: unknown[] = [campaignId];
  let query = `SELECT * FROM email_dm_recipients WHERE campaign_id = ?`;
  if (options.status) {
    query += ` AND status = ?`;
    params.push(options.status);
  }
  query += ` ORDER BY created_at ASC`;
  if (typeof options.limit === 'number') {
    query += ` LIMIT ?`;
    params.push(options.limit);
  }
  const result = await db
    .prepare(query)
    .bind(...params)
    .all<EmailDmRecipient>();
  return result.results;
}

export async function markEmailDmRecipientSent(
  db: D1Database,
  recipientId: string,
  resendMessageId: string | null,
): Promise<void> {
  const now = jstNow();
  await db
    .prepare(
      `UPDATE email_dm_recipients
       SET status = 'sent',
           resend_message_id = ?,
           sent_at = ?,
           last_error = NULL,
           updated_at = ?
       WHERE id = ?`,
    )
    .bind(resendMessageId, now, now, recipientId)
    .run();
}

export async function markEmailDmRecipientFailed(
  db: D1Database,
  recipientId: string,
  errorMessage: string,
): Promise<void> {
  const now = jstNow();
  await db
    .prepare(
      `UPDATE email_dm_recipients
       SET last_error = ?,
           updated_at = ?
       WHERE id = ?`,
    )
    .bind(errorMessage.slice(0, 1000), now, recipientId)
    .run();
}

export async function markEmailDmRecipientBounced(
  db: D1Database,
  recipientId: string,
  reason: string,
): Promise<void> {
  const now = jstNow();
  await db
    .prepare(
      `UPDATE email_dm_recipients
       SET status = 'bounced',
           bounced_at = ?,
           bounce_reason = ?,
           updated_at = ?
       WHERE id = ?`,
    )
    .bind(now, reason.slice(0, 500), now, recipientId)
    .run();
}

export async function markEmailDmRecipientDelivered(
  db: D1Database,
  recipientId: string,
): Promise<void> {
  const now = jstNow();
  await db
    .prepare(
      `UPDATE email_dm_recipients
       SET delivered_at = COALESCE(delivered_at, ?),
           updated_at = ?
       WHERE id = ?`,
    )
    .bind(now, now, recipientId)
    .run();
}

export async function markEmailDmRecipientOpened(
  db: D1Database,
  recipientId: string,
): Promise<void> {
  const now = jstNow();
  await db
    .prepare(
      `UPDATE email_dm_recipients
       SET opened_at = COALESCE(opened_at, ?),
           open_count = open_count + 1,
           updated_at = ?
       WHERE id = ?`,
    )
    .bind(now, now, recipientId)
    .run();
}

export async function markEmailDmRecipientComplained(
  db: D1Database,
  recipientId: string,
  notes: string | null,
): Promise<void> {
  const now = jstNow();
  await db
    .prepare(
      `UPDATE email_dm_recipients
       SET status = 'complained',
           complained_at = ?,
           last_error = ?,
           updated_at = ?
       WHERE id = ?`,
    )
    .bind(now, notes ? notes.slice(0, 500) : null, now, recipientId)
    .run();
}

export async function markEmailDmRecipientUnsubscribed(
  db: D1Database,
  recipientId: string,
): Promise<void> {
  const now = jstNow();
  await db
    .prepare(
      `UPDATE email_dm_recipients
       SET status = 'unsubscribed',
           unsubscribed_at = ?,
           updated_at = ?
       WHERE id = ? AND status != 'unsubscribed'`,
    )
    .bind(now, now, recipientId)
    .run();
}

export async function recordEmailDmRecipientClick(
  db: D1Database,
  recipientId: string,
): Promise<void> {
  const now = jstNow();
  await db
    .prepare(
      `UPDATE email_dm_recipients
       SET click_count = click_count + 1,
           first_click_at = COALESCE(first_click_at, ?),
           updated_at = ?
       WHERE id = ?`,
    )
    .bind(now, now, recipientId)
    .run();
}

// ── Events ───────────────────────────────────────────────────────────────────

export async function recordEmailDmEvent(
  db: D1Database,
  input: {
    recipientId: string;
    eventType: EmailDmEventType;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  const id = crypto.randomUUID();
  const now = jstNow();
  await db
    .prepare(
      `INSERT INTO email_dm_events (id, recipient_id, event_type, metadata, occurred_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(id, input.recipientId, input.eventType, JSON.stringify(input.metadata ?? {}), now)
    .run();
}

// ── Suppression ──────────────────────────────────────────────────────────────

export async function isEmailDmSuppressed(
  db: D1Database,
  email: string,
): Promise<boolean> {
  const row = await db
    .prepare(`SELECT email FROM email_dm_suppression WHERE email = ? LIMIT 1`)
    .bind(email.toLowerCase())
    .first<{ email: string }>();
  return row !== null;
}

export async function addEmailDmSuppression(
  db: D1Database,
  input: {
    email: string;
    reason: EmailDmSuppressionReason;
    sourceRecipientId?: string | null;
    notes?: string | null;
  },
): Promise<void> {
  const now = jstNow();
  await db
    .prepare(
      `INSERT INTO email_dm_suppression (email, reason, source_recipient_id, notes, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(email) DO UPDATE
         SET reason = excluded.reason,
             source_recipient_id = COALESCE(excluded.source_recipient_id, email_dm_suppression.source_recipient_id),
             notes = COALESCE(excluded.notes, email_dm_suppression.notes)`,
    )
    .bind(
      input.email.toLowerCase(),
      input.reason,
      input.sourceRecipientId ?? null,
      input.notes ?? null,
      now,
    )
    .run();
}

// ── Metrics ──────────────────────────────────────────────────────────────────

export interface EmailDmCampaignMetrics {
  total: number;
  pending: number;
  sent: number;
  delivered: number;
  bounced: number;
  unsubscribed: number;
  complained: number;
  suppressed: number;
  total_clicks: number;
  unique_clickers: number;
  total_opens: number;
  unique_openers: number;
  first_sent_at: string | null;
  last_sent_at: string | null;
  first_click_at: string | null;
}

export async function getEmailDmCampaignMetrics(
  db: D1Database,
  campaignId: string,
): Promise<EmailDmCampaignMetrics> {
  const row = await db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent,
         SUM(CASE WHEN delivered_at IS NOT NULL THEN 1 ELSE 0 END) AS delivered,
         SUM(CASE WHEN status = 'bounced' THEN 1 ELSE 0 END) AS bounced,
         SUM(CASE WHEN status = 'unsubscribed' THEN 1 ELSE 0 END) AS unsubscribed,
         SUM(CASE WHEN status = 'complained' THEN 1 ELSE 0 END) AS complained,
         SUM(CASE WHEN status = 'suppressed' THEN 1 ELSE 0 END) AS suppressed,
         COALESCE(SUM(click_count), 0) AS total_clicks,
         SUM(CASE WHEN click_count > 0 THEN 1 ELSE 0 END) AS unique_clickers,
         COALESCE(SUM(open_count), 0) AS total_opens,
         SUM(CASE WHEN open_count > 0 THEN 1 ELSE 0 END) AS unique_openers,
         MIN(sent_at) AS first_sent_at,
         MAX(sent_at) AS last_sent_at,
         MIN(first_click_at) AS first_click_at
       FROM email_dm_recipients
       WHERE campaign_id = ?`,
    )
    .bind(campaignId)
    .first<EmailDmCampaignMetrics>();

  return (
    row ?? {
      total: 0,
      pending: 0,
      sent: 0,
      delivered: 0,
      bounced: 0,
      unsubscribed: 0,
      complained: 0,
      suppressed: 0,
      total_clicks: 0,
      unique_clickers: 0,
      total_opens: 0,
      unique_openers: 0,
      first_sent_at: null,
      last_sent_at: null,
      first_click_at: null,
    }
  );
}

// ── Reports (cron-driven Discord push) ───────────────────────────────────────

export async function listEmailDmCampaignsDueForReport(
  db: D1Database,
): Promise<EmailDmCampaign[]> {
  // Cron runs every 5min; pull campaigns that have finished dispatching and
  // still have at least one outstanding report (24h / 48h / 1w).
  const result = await db
    .prepare(
      `SELECT * FROM email_dm_campaigns
       WHERE dispatch_finished_at IS NOT NULL
         AND (
           report_24h_sent_at IS NULL
           OR report_48h_sent_at IS NULL
           OR report_1w_sent_at IS NULL
         )`,
    )
    .all<EmailDmCampaign>();
  return result.results;
}

export async function markEmailDmCampaignReportSent(
  db: D1Database,
  campaignId: string,
  kind: EmailDmReportKind,
): Promise<void> {
  const column =
    kind === '24h'
      ? 'report_24h_sent_at'
      : kind === '48h'
        ? 'report_48h_sent_at'
        : 'report_1w_sent_at';
  const now = jstNow();
  await db
    .prepare(
      `UPDATE email_dm_campaigns
       SET ${column} = COALESCE(${column}, ?),
           updated_at = ?
       WHERE id = ?`,
    )
    .bind(now, now, campaignId)
    .run();
}
