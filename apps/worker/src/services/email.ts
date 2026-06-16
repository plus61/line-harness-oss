/**
 * Email dispatcher.
 *
 * Currently backed by Resend (https://resend.com/). If RESEND_API_KEY is
 * not configured, falls back to the Discord webhook so local / dev envs
 * still surface the email body for inspection.
 */

export interface EmailPayload {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export interface EmailEnv {
  RESEND_API_KEY?: string;
  RESEND_FROM?: string;
  RESEND_DM_FROM?: string;
  BOOKING_NOTIFY_EMAIL?: string;
}

interface SendResult {
  ok: boolean;
  channel: 'resend' | 'discord-fallback' | 'none';
  /** Resend message id, when channel === 'resend' and the API returned one. */
  id?: string;
  error?: string;
}

const DEFAULT_FROM = 'DRAGON AI <noreply@dragon-ai-tr.com>';
const DEFAULT_DM_FROM = '佐藤有一郎 / DRAGON AI <sato@dragon-ai.jp>';
const DISCORD_FALLBACK_WEBHOOK =
  'https://discord.com/api/webhooks/1485577312820002816/RoZMujcD9KLVeMjjV1LXZ9HcfuSUzCXcsDADHMVyqTwneFMChnJRMRNsSiET_SaWMzw8';

interface ResendOptions {
  fromOverride?: string;
  headers?: Record<string, string>;
  replyTo?: string;
}

async function postToResend(
  env: EmailEnv,
  payload: EmailPayload,
  defaultFrom: string,
  options: ResendOptions = {},
): Promise<SendResult> {
  if (env.RESEND_API_KEY) {
    try {
      const body: Record<string, unknown> = {
        from: options.fromOverride || defaultFrom,
        to: [payload.to],
        subject: payload.subject,
        html: payload.html,
        text: payload.text,
      };
      if (options.headers && Object.keys(options.headers).length > 0) {
        body.headers = options.headers;
      }
      if (options.replyTo) {
        body.reply_to = options.replyTo;
      }
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errorBody = await res.text().catch(() => '');
        return {
          ok: false,
          channel: 'resend',
          error: `Resend HTTP ${res.status}: ${errorBody.slice(0, 500)}`,
        };
      }
      const responseBody = await res.json<{ id?: string }>().catch(() => ({}) as { id?: string });
      return {
        ok: true,
        channel: 'resend',
        id: typeof responseBody?.id === 'string' ? responseBody.id : undefined,
      };
    } catch (err) {
      return {
        ok: false,
        channel: 'resend',
        error: err instanceof Error ? err.message : 'Unknown error',
      };
    }
  }

  // Fallback: Discord webhook (dev / before secret is configured).
  try {
    await fetch(DISCORD_FALLBACK_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'Email Fallback',
        content: `📧 **${payload.subject}**\n**To:** ${payload.to}\n\n${payload.text || payload.html.replace(/<[^>]+>/g, '').slice(0, 1500)}`,
      }),
    });
    return { ok: true, channel: 'discord-fallback' };
  } catch (err) {
    return {
      ok: false,
      channel: 'none',
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

/**
 * Send a transactional email (magic link, urgent lead, booking notice, etc.).
 *
 * Uses RESEND_FROM (default `noreply@dragon-ai-tr.com`) to keep transactional
 * traffic on the historically reliable transactional domain. DM/marketing
 * traffic must use {@link sendDmEmail} to avoid contaminating the
 * transactional sender's reputation.
 */
export async function sendEmail(env: EmailEnv, payload: EmailPayload): Promise<SendResult> {
  return postToResend(env, payload, DEFAULT_FROM, {
    fromOverride: env.RESEND_FROM,
  });
}

export interface DmEmailOptions {
  /**
   * Override the From header for this call. If omitted, falls back to
   * `env.RESEND_DM_FROM`, then {@link DEFAULT_DM_FROM}.
   */
  from?: string;
  /** Optional Reply-To. Defaults to the sender's email address. */
  replyTo?: string;
  /**
   * 1-click List-Unsubscribe support. Provide a unique
   * `mailto:` or `https://` endpoint per recipient if available.
   */
  listUnsubscribe?: string;
}

/**
 * Send a marketing / DM email from the dedicated DM sender (`sato@dragon-ai.jp`
 * by default). Kept separate from {@link sendEmail} so that the transactional
 * domain's reputation cannot be damaged by bulk-send mistakes here.
 *
 * Per RFC 8058, supplying `listUnsubscribe` also opts the message into the
 * `List-Unsubscribe-Post: List-Unsubscribe=One-Click` header that Gmail and
 * Yahoo require for senders sending bulk email.
 */
export async function sendDmEmail(
  env: EmailEnv,
  payload: EmailPayload,
  options: DmEmailOptions = {},
): Promise<SendResult> {
  const headers: Record<string, string> = {};
  if (options.listUnsubscribe) {
    headers['List-Unsubscribe'] = options.listUnsubscribe.startsWith('http') || options.listUnsubscribe.startsWith('mailto:')
      ? `<${options.listUnsubscribe}>`
      : options.listUnsubscribe;
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }
  return postToResend(env, payload, DEFAULT_DM_FROM, {
    fromOverride: options.from ?? env.RESEND_DM_FROM,
    replyTo: options.replyTo,
    headers,
  });
}

// ============================================================
// Templates
// ============================================================

export function magicLinkEmail(params: {
  officeName: string;
  verifyUrl: string;
  expiresInMinutes: number;
}): { subject: string; html: string; text: string } {
  const { officeName, verifyUrl, expiresInMinutes } = params;
  const subject = `[SR Dashboard] ログインリンク`;
  const text = `${officeName} ご担当者様

SR Dashboard のログインリンクをお送りします。
下記URLにアクセスしてログインしてください。

${verifyUrl}

このリンクの有効期限は ${expiresInMinutes} 分です。
心当たりのない場合はこのメールを破棄してください。

---
DRAGON AI / SR Dashboard
https://dragon-ai-tr.com/
`;
  const html = `<!DOCTYPE html>
<html lang="ja">
<body style="font-family:'Hiragino Sans',system-ui,sans-serif;background:#f8fafc;padding:24px;color:#1e293b;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:32px;">
    <div style="font-size:12px;font-weight:600;color:#0369a1;letter-spacing:0.2em;">DRAGON AI</div>
    <h1 style="margin:8px 0 16px;font-size:20px;">SR Dashboard ログインリンク</h1>
    <p style="margin:0 0 12px;font-size:14px;line-height:1.7;">${escapeHtml(officeName)} ご担当者様</p>
    <p style="margin:0 0 20px;font-size:14px;line-height:1.7;">
      下のボタンからログインしてください。
    </p>
    <div style="text-align:center;margin:24px 0;">
      <a href="${verifyUrl}" style="display:inline-block;background:#0369a1;color:#fff;text-decoration:none;font-weight:700;padding:14px 32px;border-radius:10px;">ログインする</a>
    </div>
    <p style="margin:16px 0 0;font-size:12px;color:#64748b;line-height:1.6;">
      ボタンが機能しない場合は以下URLをブラウザに貼り付けてください:<br>
      <span style="word-break:break-all;color:#0369a1;">${verifyUrl}</span>
    </p>
    <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;">
    <p style="margin:0;font-size:11px;color:#94a3b8;line-height:1.6;">
      このリンクの有効期限は ${expiresInMinutes} 分です。<br>
      心当たりのない場合はこのメールを破棄してください。
    </p>
  </div>
  <div style="text-align:center;font-size:11px;color:#94a3b8;margin-top:16px;">
    DRAGON AI / SR Dashboard &middot; <a href="https://dragon-ai-tr.com/" style="color:#94a3b8;">dragon-ai-tr.com</a>
  </div>
</body>
</html>`;
  return { subject, html, text };
}

export function urgentLeadEmail(params: {
  officeName: string;
  contactName: string;
  companyName: string | null;
  phone: string | null;
  question: string | null;
  dashboardUrl: string;
}): { subject: string; html: string; text: string } {
  const { officeName, contactName, companyName, phone, question, dashboardUrl } = params;
  const subject = `[緊急] 未対応リード発生 (Level 3)`;
  const text = `${officeName} ご担当者様

AI チャットボット経由で緊急度 Level 3 のリードが発生しました。

■ 担当者: ${contactName}
■ 会社名: ${companyName || '(未入力)'}
■ 電話: ${phone || '(未入力)'}
■ 最終質問: ${(question || '').slice(0, 500)}

ダッシュボードで詳細を確認してください:
${dashboardUrl}

---
DRAGON AI / SR Dashboard
`;
  const html = `<!DOCTYPE html>
<html lang="ja">
<body style="font-family:'Hiragino Sans',system-ui,sans-serif;background:#fef2f2;padding:24px;color:#1e293b;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border:2px solid #dc2626;border-radius:16px;padding:32px;">
    <div style="font-size:12px;font-weight:700;color:#dc2626;letter-spacing:0.2em;">🚨 緊急リード発生</div>
    <h1 style="margin:8px 0 16px;font-size:20px;">Level 3 / ${escapeHtml(officeName)}</h1>
    <table style="width:100%;border-collapse:collapse;font-size:14px;">
      <tr><td style="padding:6px 0;color:#64748b;width:80px;">担当者</td><td style="padding:6px 0;font-weight:600;">${escapeHtml(contactName)}</td></tr>
      <tr><td style="padding:6px 0;color:#64748b;">会社名</td><td style="padding:6px 0;font-weight:600;">${escapeHtml(companyName || '(未入力)')}</td></tr>
      <tr><td style="padding:6px 0;color:#64748b;">電話</td><td style="padding:6px 0;font-weight:600;">${escapeHtml(phone || '(未入力)')}</td></tr>
    </table>
    <div style="margin-top:16px;padding:12px;background:#fef9c3;border-radius:8px;font-size:13px;">
      <div style="font-weight:600;margin-bottom:4px;">最終質問</div>
      ${escapeHtml((question || '').slice(0, 500))}
    </div>
    <div style="text-align:center;margin:24px 0;">
      <a href="${dashboardUrl}" style="display:inline-block;background:#dc2626;color:#fff;text-decoration:none;font-weight:700;padding:14px 32px;border-radius:10px;">ダッシュボードで確認</a>
    </div>
  </div>
</body>
</html>`;
  return { subject, html, text };
}

export function bookingCreatedEmail(params: {
  displayName: string | null;
  title: string;
  startAt: string;
  endAt: string;
  meetUrl?: string | null;
  friendId?: string | null;
  connectionId?: string | null;
  bookingId: string;
}): { subject: string; html: string; text: string } {
  const { displayName, title, startAt, endAt, meetUrl, friendId, connectionId, bookingId } = params;
  const displayLabel = displayName?.trim() ? displayName : '(LINE名未取得)';
  const jstRange = formatJstRange(startAt, endAt);
  const subject = `[予約] ${displayLabel} 様 — ${jstRange}`;

  const text = `新規予約が入りました。

■ 予約者: ${displayLabel}
■ 日時: ${jstRange}
■ 件名: ${title}
■ Meet URL: ${meetUrl || '(発行されませんでした)'}

---
booking_id: ${bookingId}
friend_id: ${friendId || '(なし)'}
connection_id: ${connectionId || '(なし)'}

DRAGON AI / LINE 予約通知
`;
  const html = `<!DOCTYPE html>
<html lang="ja">
<body style="font-family:'Hiragino Sans',system-ui,sans-serif;background:#f0f9ff;padding:24px;color:#1e293b;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border:2px solid #0284c7;border-radius:16px;padding:32px;">
    <div style="font-size:12px;font-weight:700;color:#0284c7;letter-spacing:0.2em;">📅 新規予約受付</div>
    <h1 style="margin:8px 0 16px;font-size:20px;">${escapeHtml(displayLabel)} 様</h1>
    <table style="width:100%;border-collapse:collapse;font-size:14px;">
      <tr><td style="padding:6px 0;color:#64748b;width:90px;">日時</td><td style="padding:6px 0;font-weight:700;color:#0f172a;">${escapeHtml(jstRange)}</td></tr>
      <tr><td style="padding:6px 0;color:#64748b;">件名</td><td style="padding:6px 0;">${escapeHtml(title)}</td></tr>
      ${meetUrl ? `<tr><td style="padding:6px 0;color:#64748b;">Meet</td><td style="padding:6px 0;"><a href="${escapeHtml(meetUrl)}" style="color:#0284c7;">${escapeHtml(meetUrl)}</a></td></tr>` : ''}
    </table>
    <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;">
    <p style="margin:0;font-size:11px;color:#94a3b8;line-height:1.6;">
      booking_id: ${escapeHtml(bookingId)}<br>
      friend_id: ${escapeHtml(friendId || '(なし)')}<br>
      connection_id: ${escapeHtml(connectionId || '(なし)')}
    </p>
  </div>
  <div style="text-align:center;font-size:11px;color:#94a3b8;margin-top:16px;">
    DRAGON AI / LINE 予約通知
  </div>
</body>
</html>`;
  return { subject, html, text };
}

function formatJstRange(startAt: string, endAt: string): string {
  const fmt = (iso: string) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
    const y = jst.getUTCFullYear();
    const m = String(jst.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(jst.getUTCDate()).padStart(2, '0');
    const hh = String(jst.getUTCHours()).padStart(2, '0');
    const mm = String(jst.getUTCMinutes()).padStart(2, '0');
    return `${y}-${m}-${dd} ${hh}:${mm}`;
  };
  const startStr = fmt(startAt);
  const endStr = fmt(endAt);
  const startTimeOnly = endStr.slice(0, 10) === startStr.slice(0, 10) ? endStr.slice(11) : endStr;
  return `${startStr} 〜 ${startTimeOnly} (JST)`;
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
