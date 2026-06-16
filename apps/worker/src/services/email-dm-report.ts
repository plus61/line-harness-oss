import {
  getEmailDmCampaignMetrics,
  listEmailDmCampaignsDueForReport,
  markEmailDmCampaignReportSent,
  type EmailDmCampaign,
  type EmailDmCampaignMetrics,
  type EmailDmReportKind,
} from '@line-crm/db';

// =============================================================================
// Cron-driven Discord metrics push for email DM campaigns.
//
// Mirrors the FAX DM 2弾目 v2 report cadence (24h / 48h / 1w post-dispatch).
// Each campaign emits at most one report per kind — guarded by the
// report_*_sent_at columns + COALESCE in markEmailDmCampaignReportSent.
// =============================================================================

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const REPORT_DELAYS: Record<EmailDmReportKind, number> = {
  '24h': DAY_MS,
  '48h': 2 * DAY_MS,
  '1w': 7 * DAY_MS,
};

export interface EmailDmReportEnv {
  DB: D1Database;
  EMAIL_DM_REPORT_DISCORD_WEBHOOK?: string;
  WORKER_URL?: string;
}

export interface EmailDmReportSummary {
  scanned: number;
  posted: Array<{ campaignId: string; kind: EmailDmReportKind }>;
  skipped: Array<{ campaignId: string; kind: EmailDmReportKind; reason: string }>;
  errors: Array<{ campaignId: string; kind: EmailDmReportKind; error: string }>;
}

export async function runEmailDmReportSweep(
  env: EmailDmReportEnv,
  now: Date = new Date(),
): Promise<EmailDmReportSummary> {
  const summary: EmailDmReportSummary = { scanned: 0, posted: [], skipped: [], errors: [] };

  const webhookUrl = env.EMAIL_DM_REPORT_DISCORD_WEBHOOK;
  const campaigns = await listEmailDmCampaignsDueForReport(env.DB);
  summary.scanned = campaigns.length;
  if (campaigns.length === 0) return summary;

  for (const campaign of campaigns) {
    for (const kind of ['24h', '48h', '1w'] as const) {
      const sentAt = pickSentColumn(campaign, kind);
      if (sentAt) continue;
      if (!isReportDue(campaign, kind, now)) {
        continue;
      }

      if (!webhookUrl) {
        summary.skipped.push({
          campaignId: campaign.id,
          kind,
          reason: 'EMAIL_DM_REPORT_DISCORD_WEBHOOK not configured',
        });
        continue;
      }

      try {
        const metrics = await getEmailDmCampaignMetrics(env.DB, campaign.id);
        const payload = buildReportPayload(campaign, kind, metrics, env.WORKER_URL);
        await postToDiscord(webhookUrl, payload);
        await markEmailDmCampaignReportSent(env.DB, campaign.id, kind);
        summary.posted.push({ campaignId: campaign.id, kind });
      } catch (err) {
        summary.errors.push({
          campaignId: campaign.id,
          kind,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return summary;
}

function pickSentColumn(campaign: EmailDmCampaign, kind: EmailDmReportKind): string | null {
  if (kind === '24h') return campaign.report_24h_sent_at;
  if (kind === '48h') return campaign.report_48h_sent_at;
  return campaign.report_1w_sent_at;
}

function isReportDue(
  campaign: EmailDmCampaign,
  kind: EmailDmReportKind,
  now: Date,
): boolean {
  if (!campaign.dispatch_finished_at) return false;
  const baseline = Date.parse(campaign.dispatch_finished_at);
  if (Number.isNaN(baseline)) return false;
  return now.getTime() - baseline >= REPORT_DELAYS[kind];
}

interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

interface DiscordEmbed {
  title: string;
  description?: string;
  color?: number;
  fields?: DiscordEmbedField[];
  footer?: { text: string };
}

interface DiscordWebhookPayload {
  username?: string;
  avatar_url?: string;
  content?: string;
  embeds?: DiscordEmbed[];
}

const REPORT_COLORS: Record<EmailDmReportKind, number> = {
  '24h': 0x0d6efd,
  '48h': 0xfd7e14,
  '1w': 0x20c997,
};

export function buildReportPayload(
  campaign: EmailDmCampaign,
  kind: EmailDmReportKind,
  metrics: EmailDmCampaignMetrics,
  workerUrl: string | undefined,
): DiscordWebhookPayload {
  const reachable = metrics.total - metrics.suppressed;
  const ctrBase = metrics.delivered > 0 ? metrics.delivered : metrics.sent;
  const ctrPct = ctrBase > 0 ? ((metrics.unique_clickers / ctrBase) * 100).toFixed(1) : '0.0';
  const bouncePct = metrics.sent + metrics.bounced > 0
    ? ((metrics.bounced / (metrics.sent + metrics.bounced)) * 100).toFixed(1)
    : '0.0';
  const unsubPct = metrics.sent > 0
    ? ((metrics.unsubscribed / metrics.sent) * 100).toFixed(2)
    : '0.00';

  const fields: DiscordEmbedField[] = [
    {
      name: '📤 配信',
      value: [
        `送信完了: **${metrics.sent}** / ${reachable} 件`,
        `配信 (delivered): **${metrics.delivered}** 件`,
        `pending: ${metrics.pending} / suppressed: ${metrics.suppressed}`,
      ].join('\n'),
      inline: false,
    },
    {
      name: '👀 反応',
      value: [
        `unique click: **${metrics.unique_clickers}** 件 (CTR ${ctrPct}%)`,
        `total click: ${metrics.total_clicks} 回`,
        `unique open: ${metrics.unique_openers} 件 / total open: ${metrics.total_opens} 回`,
      ].join('\n'),
      inline: false,
    },
    {
      name: '⚠️ deliverability',
      value: [
        `bounce: **${metrics.bounced}** 件 (${bouncePct}%)`,
        `complaint: ${metrics.complained} 件`,
        `unsubscribe: ${metrics.unsubscribed} 件 (${unsubPct}%)`,
      ].join('\n'),
      inline: false,
    },
  ];

  if (metrics.first_sent_at) {
    fields.push({
      name: '🕒 timeline',
      value: [
        `first sent_at:  ${metrics.first_sent_at}`,
        `last  sent_at:  ${metrics.last_sent_at ?? '-'}`,
        `first click_at: ${metrics.first_click_at ?? '-'}`,
      ].join('\n'),
      inline: false,
    });
  }

  const description = workerUrl
    ? `metrics API: ${trimTrailingSlash(workerUrl)}/api/email-dm/campaigns/${campaign.id}/metrics`
    : undefined;

  return {
    username: 'email DM レポート',
    embeds: [
      {
        title: `📧 ${campaign.name} — ${kind} レポート`,
        description,
        color: REPORT_COLORS[kind],
        fields,
        footer: {
          text: `dispatch_finished_at: ${campaign.dispatch_finished_at ?? '-'}`,
        },
      },
    ],
  };
}

async function postToDiscord(webhookUrl: string, payload: DiscordWebhookPayload): Promise<void> {
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Discord webhook HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
}

function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}
