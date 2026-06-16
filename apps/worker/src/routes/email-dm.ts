import { Hono } from 'hono';
import {
  getEmailDmCampaign,
  getEmailDmCampaignMetrics,
  getEmailDmRecipient,
  getEmailDmRecipientByCode,
  listEmailDmCampaigns,
  listEmailDmRecipientsByCampaign,
  markEmailDmRecipientUnsubscribed,
  recordEmailDmEvent,
  recordEmailDmRecipientClick,
  addEmailDmSuppression,
} from '@line-crm/db';
import { dispatchEmailDmCampaign } from '../services/email-dm.js';
import type { Env } from '../index.js';

const emailDm = new Hono<Env>();

// ── Public click-tracking redirect ────────────────────────────────────────────

// GET /goe/:code — records the click and 302-redirects to the campaign's
// target URL (carried in `?u=`). No auth; designed to be the link inside
// every DM email body.
emailDm.get('/goe/:code', async (c) => {
  const code = c.req.param('code');
  const target = c.req.query('u');

  if (!target) {
    return c.text('Missing redirect target', 400);
  }

  const validated = validateRedirectTarget(target);
  if (!validated) {
    return c.text('Invalid redirect target', 400);
  }

  const recipient = await getEmailDmRecipientByCode(c.env.DB, code);
  if (!recipient) {
    return c.redirect(validated, 302);
  }

  const ctx = c.executionCtx as ExecutionContext;
  ctx.waitUntil(
    (async () => {
      try {
        await recordEmailDmRecipientClick(c.env.DB, recipient.id);
        await recordEmailDmEvent(c.env.DB, {
          recipientId: recipient.id,
          eventType: 'clicked',
          metadata: {
            url: validated,
            ua: c.req.header('user-agent') ?? null,
            referer: c.req.header('referer') ?? null,
            cf_country: c.req.header('cf-ipcountry') ?? null,
          },
        });
      } catch (err) {
        console.error(`/goe/${code} async tracking error:`, err);
      }
    })(),
  );

  return c.redirect(validated, 302);
});

// ── Public one-click unsubscribe (RFC 8058) ──────────────────────────────────

// GET /u/:code — landing page for human unsubscribe flow.
emailDm.get('/u/:code', async (c) => {
  const code = c.req.param('code');
  const recipient = await getEmailDmRecipientByCode(c.env.DB, code);
  if (!recipient) {
    return c.html(renderUnsubscribePage('not_found', null), 404);
  }
  return c.html(renderUnsubscribePage('confirm', recipient.email));
});

// POST /u/:code — RFC 8058 one-click endpoint (used by Gmail/Yahoo bulk-sender
// `List-Unsubscribe-Post: List-Unsubscribe=One-Click`). Also used by the
// confirm-page form submit. Idempotent: re-unsubscribing returns 200.
emailDm.post('/u/:code', async (c) => {
  const code = c.req.param('code');
  const recipient = await getEmailDmRecipientByCode(c.env.DB, code);
  if (!recipient) {
    return c.html(renderUnsubscribePage('not_found', null), 404);
  }

  await markEmailDmRecipientUnsubscribed(c.env.DB, recipient.id);
  await addEmailDmSuppression(c.env.DB, {
    email: recipient.email,
    reason: 'unsubscribe',
    sourceRecipientId: recipient.id,
    notes: 'user clicked unsubscribe',
  });
  await recordEmailDmEvent(c.env.DB, {
    recipientId: recipient.id,
    eventType: 'unsubscribed',
    metadata: {
      ua: c.req.header('user-agent') ?? null,
      cf_country: c.req.header('cf-ipcountry') ?? null,
    },
  });

  return c.html(renderUnsubscribePage('done', recipient.email));
});

// ── Admin: campaigns ─────────────────────────────────────────────────────────

emailDm.get('/api/email-dm/campaigns', async (c) => {
  const campaigns = await listEmailDmCampaigns(c.env.DB);
  return c.json({ success: true, data: campaigns });
});

emailDm.get('/api/email-dm/campaigns/:id', async (c) => {
  const campaign = await getEmailDmCampaign(c.env.DB, c.req.param('id'));
  if (!campaign) {
    return c.json({ success: false, error: 'Campaign not found' }, 404);
  }
  return c.json({ success: true, data: campaign });
});

emailDm.get('/api/email-dm/campaigns/:id/metrics', async (c) => {
  const campaign = await getEmailDmCampaign(c.env.DB, c.req.param('id'));
  if (!campaign) {
    return c.json({ success: false, error: 'Campaign not found' }, 404);
  }
  const metrics = await getEmailDmCampaignMetrics(c.env.DB, campaign.id);
  return c.json({ success: true, data: { campaign, metrics } });
});

emailDm.get('/api/email-dm/campaigns/:id/recipients', async (c) => {
  const campaign = await getEmailDmCampaign(c.env.DB, c.req.param('id'));
  if (!campaign) {
    return c.json({ success: false, error: 'Campaign not found' }, 404);
  }
  const statusParam = c.req.query('status');
  const status = isRecipientStatus(statusParam) ? statusParam : undefined;
  const recipients = await listEmailDmRecipientsByCampaign(c.env.DB, campaign.id, { status });
  return c.json({ success: true, data: recipients });
});

emailDm.post('/api/email-dm/campaigns/:id/dispatch', async (c) => {
  const campaign = await getEmailDmCampaign(c.env.DB, c.req.param('id'));
  if (!campaign) {
    return c.json({ success: false, error: 'Campaign not found' }, 404);
  }

  type DispatchBody = {
    dryRun?: boolean;
    batchSize?: number;
    interBatchMs?: number;
    interMessageMs?: number;
  };
  const body: DispatchBody = await c.req.json<DispatchBody>().catch(() => ({}) as DispatchBody);

  try {
    const summary = await dispatchEmailDmCampaign(c.env.DB, c.env, campaign.id, {
      dryRun: body.dryRun === true,
      batchSize: body.batchSize,
      interBatchMs: body.interBatchMs,
      interMessageMs: body.interMessageMs,
      workerUrl: c.env.WORKER_URL,
    });
    return c.json({ success: true, data: summary });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Dispatch failed';
    return c.json({ success: false, error: message }, 500);
  }
});

// Manual suppression (e.g., from inbound complaint email).
emailDm.post('/api/email-dm/suppression', async (c) => {
  type SuppressionBody = { email?: string; reason?: string; notes?: string };
  const body: SuppressionBody = await c.req
    .json<SuppressionBody>()
    .catch(() => ({}) as SuppressionBody);
  if (!body.email) {
    return c.json({ success: false, error: 'email is required' }, 400);
  }
  const reason: 'bounce' | 'complaint' | 'unsubscribe' | 'manual' =
    body.reason === 'bounce' || body.reason === 'complaint' || body.reason === 'unsubscribe'
      ? body.reason
      : 'manual';
  await addEmailDmSuppression(c.env.DB, {
    email: body.email,
    reason,
    notes: body.notes ?? null,
  });
  return c.json({ success: true });
});

// Manual recipient lookup (debugging support).
emailDm.get('/api/email-dm/recipients/:id', async (c) => {
  const recipient = await getEmailDmRecipient(c.env.DB, c.req.param('id'));
  if (!recipient) {
    return c.json({ success: false, error: 'Recipient not found' }, 404);
  }
  return c.json({ success: true, data: recipient });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

const ALLOWED_REDIRECT_PROTOCOLS = new Set(['http:', 'https:']);

function validateRedirectTarget(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (!ALLOWED_REDIRECT_PROTOCOLS.has(url.protocol)) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function isRecipientStatus(
  value: string | undefined,
): value is 'pending' | 'sent' | 'bounced' | 'unsubscribed' | 'complained' | 'suppressed' {
  return (
    value === 'pending' ||
    value === 'sent' ||
    value === 'bounced' ||
    value === 'unsubscribed' ||
    value === 'complained' ||
    value === 'suppressed'
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderUnsubscribePage(
  state: 'confirm' | 'done' | 'not_found',
  email: string | null,
): string {
  const safeEmail = email ? escapeHtml(email) : '';
  const heading =
    state === 'done'
      ? '配信停止が完了しました'
      : state === 'not_found'
        ? 'リンクが無効です'
        : '配信停止のご確認';
  const body =
    state === 'done'
      ? `<p>${safeEmail} 宛の今後のメールマガジン配信を停止しました。<br>ご対応に時間をいただき申し訳ありませんでした。</p>`
      : state === 'not_found'
        ? '<p>このリンクは無効か、すでに使用済みです。お手数ですが support@dragon-ai.jp までご連絡ください。</p>'
        : `<form method="POST">
             <p>${safeEmail} のメールマガジン配信を停止しますか？</p>
             <button type="submit" style="padding:8px 16px;background:#0d6efd;color:#fff;border:none;border-radius:4px;cursor:pointer;">配信を停止する</button>
           </form>`;

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${heading} — DRAGON AI</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Hiragino Sans', sans-serif; max-width: 520px; margin: 40px auto; padding: 0 16px; color: #222; line-height: 1.6; }
  h1 { font-size: 20px; margin-bottom: 12px; }
  p { margin: 8px 0; }
</style>
</head>
<body>
<h1>${heading}</h1>
${body}
<hr style="margin-top:40px;border:none;border-top:1px solid #eee;">
<p style="font-size:12px;color:#888;">DRAGON AI / 株式会社 DRAGON AI</p>
</body></html>`;
}

export { emailDm };
