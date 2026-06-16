import {
  addEmailDmSuppression,
  getEmailDmRecipientByResendMessageId,
  markEmailDmRecipientBounced,
  markEmailDmRecipientComplained,
  markEmailDmRecipientDelivered,
  markEmailDmRecipientOpened,
  recordEmailDmEvent,
  type EmailDmEventType,
} from '@line-crm/db';

// =============================================================================
// Resend webhook ingestion (Svix-signed).
//
// Verifies the Svix signature on the raw request body, parses the event, and
// applies the appropriate recipient/suppression update. Idempotent at the
// recipient level — events get appended to email_dm_events even on replays,
// but the recipient state transitions are protected by COALESCE / status
// guards in the db helpers.
// =============================================================================

const SVIX_WHSEC_PREFIX = 'whsec_';
const MAX_CLOCK_SKEW_SECONDS = 5 * 60;
const SIG_VERSION = 'v1';

export interface ResendWebhookEnv {
  DB: D1Database;
  RESEND_WEBHOOK_SECRET?: string;
}

export type ResendWebhookOutcome =
  | { ok: true; status: 'applied' | 'unknown_message' | 'ignored_type'; eventType: string; recipientId?: string }
  | { ok: false; reason: string };

interface ResendEventBounce {
  type?: string;
  sub_type?: string;
  message?: string;
}

interface ResendEventEnvelope {
  type?: string;
  created_at?: string;
  data?: {
    email_id?: string;
    from?: string;
    to?: string[] | string;
    subject?: string;
    bounce?: ResendEventBounce;
    click?: { link?: string; ip_address?: string; user_agent?: string };
    open?: { ip_address?: string; user_agent?: string };
    [k: string]: unknown;
  };
}

export async function handleResendWebhook(
  env: ResendWebhookEnv,
  rawBody: string,
  headers: {
    svixId: string | null;
    svixTimestamp: string | null;
    svixSignature: string | null;
  },
): Promise<ResendWebhookOutcome> {
  const secret = env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    return { ok: false, reason: 'RESEND_WEBHOOK_SECRET not configured' };
  }
  if (!headers.svixId || !headers.svixTimestamp || !headers.svixSignature) {
    return { ok: false, reason: 'missing Svix headers' };
  }

  const timestampSec = Number(headers.svixTimestamp);
  if (!Number.isFinite(timestampSec)) {
    return { ok: false, reason: 'invalid svix-timestamp' };
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - timestampSec) > MAX_CLOCK_SKEW_SECONDS) {
    return { ok: false, reason: 'svix-timestamp outside allowed skew' };
  }

  const verified = await verifySvixSignature({
    secret,
    svixId: headers.svixId,
    svixTimestamp: headers.svixTimestamp,
    svixSignature: headers.svixSignature,
    rawBody,
  });
  if (!verified) {
    return { ok: false, reason: 'svix signature mismatch' };
  }

  let event: ResendEventEnvelope;
  try {
    event = JSON.parse(rawBody) as ResendEventEnvelope;
  } catch {
    return { ok: false, reason: 'invalid JSON body' };
  }

  const eventType = (event.type ?? '').toLowerCase();
  if (!eventType.startsWith('email.')) {
    return { ok: true, status: 'ignored_type', eventType };
  }

  const messageId = event.data?.email_id;
  if (!messageId) {
    return { ok: true, status: 'ignored_type', eventType };
  }

  const recipient = await getEmailDmRecipientByResendMessageId(env.DB, messageId);
  if (!recipient) {
    return { ok: true, status: 'unknown_message', eventType };
  }

  const eventDbType = mapResendEventToDbType(eventType);

  switch (eventType) {
    case 'email.delivered':
      await markEmailDmRecipientDelivered(env.DB, recipient.id);
      break;
    case 'email.opened':
      await markEmailDmRecipientOpened(env.DB, recipient.id);
      break;
    case 'email.clicked':
      // Click events from Resend's own tracking are informational; our /goe
      // redirect remains the source of truth for click_count.
      break;
    case 'email.bounced': {
      const bounceMsg = formatBounce(event.data?.bounce);
      await markEmailDmRecipientBounced(env.DB, recipient.id, bounceMsg);
      if (isPermanentBounce(event.data?.bounce)) {
        await addEmailDmSuppression(env.DB, {
          email: recipient.email,
          reason: 'bounce',
          sourceRecipientId: recipient.id,
          notes: bounceMsg,
        });
      }
      break;
    }
    case 'email.complained': {
      await markEmailDmRecipientComplained(env.DB, recipient.id, 'resend complaint');
      await addEmailDmSuppression(env.DB, {
        email: recipient.email,
        reason: 'complaint',
        sourceRecipientId: recipient.id,
        notes: 'resend webhook: complaint',
      });
      break;
    }
    case 'email.failed':
    case 'email.delivery_delayed':
    case 'email.sent':
      // sent/failed/delayed: just append to event log, no recipient mutation
      break;
    default:
      return { ok: true, status: 'ignored_type', eventType };
  }

  if (eventDbType) {
    await recordEmailDmEvent(env.DB, {
      recipientId: recipient.id,
      eventType: eventDbType,
      metadata: extractEventMetadata(event),
    });
  }

  return { ok: true, status: 'applied', eventType, recipientId: recipient.id };
}

function mapResendEventToDbType(type: string): EmailDmEventType | null {
  switch (type) {
    case 'email.sent':
      return 'sent';
    case 'email.delivered':
      return 'delivered';
    case 'email.opened':
      return 'opened';
    case 'email.clicked':
      return 'clicked';
    case 'email.bounced':
      return 'bounced';
    case 'email.complained':
      return 'complained';
    case 'email.failed':
    case 'email.delivery_delayed':
      return 'failed';
    default:
      return null;
  }
}

function isPermanentBounce(bounce: ResendEventBounce | undefined): boolean {
  if (!bounce) return false;
  const type = (bounce.type ?? '').toLowerCase();
  return type === 'permanent' || type === 'hard';
}

function formatBounce(bounce: ResendEventBounce | undefined): string {
  if (!bounce) return 'unknown bounce';
  const parts: string[] = [];
  if (bounce.type) parts.push(bounce.type);
  if (bounce.sub_type) parts.push(bounce.sub_type);
  if (bounce.message) parts.push(bounce.message);
  return parts.length > 0 ? parts.join(' / ') : 'unspecified';
}

function extractEventMetadata(event: ResendEventEnvelope): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  if (event.created_at) meta.resend_created_at = event.created_at;
  if (event.data?.bounce) meta.bounce = event.data.bounce;
  if (event.data?.click) meta.click = event.data.click;
  if (event.data?.open) meta.open = event.data.open;
  if (event.data?.from) meta.from = event.data.from;
  return meta;
}

// ── Svix signature ───────────────────────────────────────────────────────────

async function verifySvixSignature(args: {
  secret: string;
  svixId: string;
  svixTimestamp: string;
  svixSignature: string;
  rawBody: string;
}): Promise<boolean> {
  const rawSecret = args.secret.startsWith(SVIX_WHSEC_PREFIX)
    ? args.secret.slice(SVIX_WHSEC_PREFIX.length)
    : args.secret;

  let secretBytes: Uint8Array;
  try {
    secretBytes = base64ToBytes(rawSecret);
  } catch {
    return false;
  }

  const signedPayload = `${args.svixId}.${args.svixTimestamp}.${args.rawBody}`;
  const key = await crypto.subtle.importKey(
    'raw',
    secretBytes as unknown as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(signedPayload),
  );
  const expected = bytesToBase64(new Uint8Array(signature));

  // svix-signature header format: "v1,<base64> v1,<base64-rotated>"
  for (const part of args.svixSignature.split(' ')) {
    const [version, b64] = part.split(',');
    if (version !== SIG_VERSION || !b64) continue;
    if (constantTimeStringEqual(expected, b64)) {
      return true;
    }
  }
  return false;
}

function constantTimeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
