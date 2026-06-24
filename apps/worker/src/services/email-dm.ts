import {
  addEmailDmSuppression,
  getEmailDmCampaign,
  isEmailDmSuppressed,
  listEmailDmRecipientsByCampaign,
  markEmailDmRecipientFailed,
  markEmailDmRecipientSent,
  recordEmailDmEvent,
  updateEmailDmCampaignStatus,
  jstNow,
  type EmailDmCampaign,
  type EmailDmRecipient,
} from '@line-crm/db';
import { sendDmEmail, type EmailEnv } from './email.js';

// =============================================================================
// Email DM dispatch — batches recipients through sendDmEmail with rate limiting,
// per-recipient template substitution, click/unsubscribe URL wrapping, and
// auto-suppression on hard failures.
// =============================================================================

export interface EmailDmEnv extends EmailEnv {
  WORKER_URL?: string;
}

const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_INTER_BATCH_MS = 1100;     // ≤10 req/s → Resend free-tier safe; 1.1s gives ~9 req/s sustained
const DEFAULT_INTER_MESSAGE_MS = 150;    // gentle pacing within a batch

export interface DispatchOptions {
  batchSize?: number;
  interBatchMs?: number;
  interMessageMs?: number;
  workerUrl?: string;
  dryRun?: boolean;
}

export interface DispatchSummary {
  campaignId: string;
  attempted: number;
  sent: number;
  failed: number;
  skipped: number;
  errors: Array<{ recipientId: string; email: string; message: string }>;
}

export async function dispatchEmailDmCampaign(
  db: D1Database,
  env: EmailDmEnv,
  campaignId: string,
  options: DispatchOptions = {},
): Promise<DispatchSummary> {
  const campaign = await getEmailDmCampaign(db, campaignId);
  if (!campaign) {
    throw new Error(`campaign ${campaignId} not found`);
  }

  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const interBatchMs = options.interBatchMs ?? DEFAULT_INTER_BATCH_MS;
  const interMessageMs = options.interMessageMs ?? DEFAULT_INTER_MESSAGE_MS;
  const workerUrl = options.workerUrl ?? env.WORKER_URL ?? '';

  if (!workerUrl) {
    throw new Error('workerUrl is required for link wrap; set WORKER_URL secret or pass via options');
  }

  const pending = await listEmailDmRecipientsByCampaign(db, campaignId, { status: 'pending' });
  const summary: DispatchSummary = {
    campaignId,
    attempted: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    errors: [],
  };

  if (pending.length === 0) {
    return summary;
  }

  if (!options.dryRun) {
    await updateEmailDmCampaignStatus(db, campaignId, 'dispatching', {
      dispatchStartedAt: jstNow(),
    });
  }

  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);

    for (const recipient of batch) {
      summary.attempted += 1;

      if (await isEmailDmSuppressed(db, recipient.email)) {
        summary.skipped += 1;
        await recordEmailDmEvent(db, {
          recipientId: recipient.id,
          eventType: 'failed',
          metadata: { reason: 'suppression_list' },
        });
        continue;
      }

      try {
        const rendered = renderRecipientEmail(campaign, recipient, workerUrl);
        if (options.dryRun) {
          summary.sent += 1;
          continue;
        }

        const result = await sendDmEmail(
          env,
          {
            to: recipient.email,
            subject: rendered.subject,
            html: rendered.html,
            text: rendered.text,
          },
          {
            from: campaign.from_address
              ? formatFromAddress(campaign.from_name, campaign.from_address)
              : undefined,
            replyTo: campaign.reply_to ?? undefined,
            listUnsubscribe: rendered.unsubscribeUrl,
          },
        );

        await markEmailDmRecipientSent(db, recipient.id, result.id ?? null);
        await recordEmailDmEvent(db, {
          recipientId: recipient.id,
          eventType: 'sent',
          metadata: { resend_message_id: result.id ?? null },
        });
        summary.sent += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        summary.failed += 1;
        summary.errors.push({ recipientId: recipient.id, email: recipient.email, message });
        await markEmailDmRecipientFailed(db, recipient.id, message);
        await recordEmailDmEvent(db, {
          recipientId: recipient.id,
          eventType: 'failed',
          metadata: { error: message },
        });
        if (isPermanentSendError(message)) {
          await addEmailDmSuppression(db, {
            email: recipient.email,
            reason: 'bounce',
            sourceRecipientId: recipient.id,
            notes: `auto-suppressed at dispatch: ${message.slice(0, 200)}`,
          });
        }
      }

      if (interMessageMs > 0) {
        await sleep(interMessageMs);
      }
    }

    if (i + batchSize < pending.length && interBatchMs > 0) {
      await sleep(interBatchMs);
    }
  }

  if (!options.dryRun) {
    const remaining = await listEmailDmRecipientsByCampaign(db, campaignId, { status: 'pending' });
    const finalStatus = remaining.length === 0 ? 'sent' : 'paused';
    await updateEmailDmCampaignStatus(db, campaignId, finalStatus, {
      dispatchFinishedAt: jstNow(),
    });
  }

  return summary;
}

// ── Template rendering ───────────────────────────────────────────────────────

export interface RenderedRecipientEmail {
  subject: string;
  html: string;
  text: string;
  redirectUrl: string;
  unsubscribeUrl: string;
}

export function renderRecipientEmail(
  campaign: EmailDmCampaign,
  recipient: EmailDmRecipient,
  workerUrl: string,
): RenderedRecipientEmail {
  const baseVars = safeParseVars(recipient.variables);
  const redirectUrl = applyTemplate(campaign.redirect_url_template, {
    ...baseVars,
    worker_url: workerUrl,
    recipient_code: recipient.recipient_code,
    fax_code: recipient.fax_code ?? '',
    email: recipient.email,
    office_name: recipient.office_name ?? '',
    representative: recipient.representative ?? '',
  });
  const goRedirectUrl = `${trimTrailingSlash(workerUrl)}/goe/${encodeURIComponent(recipient.recipient_code)}?u=${encodeURIComponent(redirectUrl)}`;
  const unsubscribeUrl = applyTemplate(campaign.unsubscribe_url_template, {
    ...baseVars,
    worker_url: workerUrl,
    recipient_code: recipient.recipient_code,
    email: recipient.email,
  });

  const vars = {
    ...baseVars,
    recipient_code: recipient.recipient_code,
    email: recipient.email,
    office_name: recipient.office_name ?? '',
    representative: recipient.representative ?? '',
    fax_code: recipient.fax_code ?? '',
    redirect_url: goRedirectUrl,
    unsubscribe_url: unsubscribeUrl,
    worker_url: workerUrl,
  };

  return {
    subject: applyTemplate(campaign.subject, vars),
    html: applyTemplate(campaign.html_template, vars),
    text: applyTemplate(campaign.text_template, vars),
    redirectUrl: goRedirectUrl,
    unsubscribeUrl,
  };
}

function safeParseVars(raw: string): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        out[k] = v == null ? '' : String(v);
      }
      return out;
    }
  } catch {
    // ignore malformed JSON; treat as empty
  }
  return {};
}

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

function applyTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(PLACEHOLDER_RE, (_, key: string) => {
    const value = vars[key];
    return value == null ? '' : String(value);
  });
}

function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

function formatFromAddress(name: string | null, address: string): string {
  if (!name) return address;
  return `${name} <${address}>`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPermanentSendError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('invalid email') ||
    lower.includes('no such user') ||
    lower.includes('mailbox does not exist') ||
    lower.includes('user unknown') ||
    lower.includes('domain not found') ||
    lower.includes('no mx records')
  );
}
