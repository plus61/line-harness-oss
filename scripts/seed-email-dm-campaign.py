#!/usr/bin/env python3
"""
Seed an email DM campaign (Phase 1 / Campaign A wayback) into D1.

Reads:
  - data/email-dm/wayback-tier-a.csv
  - data/email-dm/wayback-tier-unknown.csv  (always-deliverable subset, per Campaign A spec)

Writes:
  - data/email-dm/seed-campaign-{id}.sql  (campaign + recipient INSERTs)
  - data/email-dm/recipient-codes-{id}.csv  (mapping email → recipient_code, for QA)

Apply with:
  wrangler d1 execute <DB_NAME> --file data/email-dm/seed-campaign-{id}.sql

Re-running with the same --campaign-id is a no-op via INSERT OR IGNORE.
"""
from __future__ import annotations

import argparse
import csv
import secrets
import sys
import uuid
from datetime import datetime
from pathlib import Path
from typing import Iterable

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = REPO_ROOT / "data" / "email-dm"
DEFAULT_TIER_A = DATA_DIR / "wayback-tier-a.csv"
DEFAULT_TIER_UNKNOWN = DATA_DIR / "wayback-tier-unknown.csv"

# Worker route that wraps every clickthrough; per-recipient code interpolated below.
REDIRECT_TARGET_TEMPLATE = "https://demo.dragon-ai.jp/demo-{{fax_code}}.html"

# 第二 CTA: 「demo HP を見る」より一段深い意向の読者向けに、直接 web ミーティングの
# 予約画面を提示する。fax_code を渡すと crm-backend が source 別の流入計測に使える。
# (= line-harness FAX DM と同じ流入計測テーブルに乗る)
# 注: HTML/TEXT テンプレート内に直接埋め込んでいる。dispatcher の applyTemplate が
# {{recipient_code}} / {{fax_code}} を per-recipient 値で置換する。

DEFAULT_SUBJECT = (
    "【社労士事務所専用】AI チャットボット付きホームページを無料でご案内"
)

HTML_TEMPLATE = """\
<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>{{office_name}} 御中</title>
</head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Hiragino Sans',sans-serif;color:#222;line-height:1.7;max-width:600px;margin:0 auto;padding:16px;">
<p>{{office_name}} 御中</p>

<p>突然のご連絡を失礼いたします。<br>
株式会社 DRAGON AI（サービス名: AI 社労士パートナー）の佐藤と申します。</p>

<p>私たちは全国の社労士事務所様向けに、<strong>AI チャットボット付きの無料ホームページ</strong>
と、顧問先からの労務相談を 24 時間自動応答する AI アシスタント機能を提供しております。</p>

<p>{{office_name}} 様の現状の HP を拝見し、リニューアルと組み合わせて
ご活用いただける可能性があると感じご連絡差し上げました。</p>

<p style="margin:24px 0;">
  <a href="{{redirect_url}}" style="display:inline-block;padding:12px 24px;background:#0d6efd;color:#fff;text-decoration:none;border-radius:6px;">
    {{office_name}} 様向けのデモ HP を見る
  </a>
</p>

<p>導入費用ゼロ、月額 1,980 円〜のトライアルプランからご利用いただけます。<br>
ご興味をお持ちいただけましたら、上のボタンより 1 分で生成済みのデモ HP をご覧ください。</p>

<div style="margin:32px 0;padding:20px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;">
  <p style="margin:0 0 12px 0;color:#166534;font-weight:bold;font-size:15px;">
    📅 直接ご相談されたい方はこちら
  </p>
  <p style="margin:0 0 14px 0;color:#166534;font-size:14px;">
    {{office_name}} 様の活用方法を 30 分の web ミーティングで具体的にご提案します（無料）。
    ご希望日時を画面でお選びいただけます。
  </p>
  <a href="https://web-booking-psi.vercel.app/dragon-ai?source=email_dm&amp;recipient_code={{recipient_code}}&amp;fax_code={{fax_code}}" style="display:inline-block;padding:12px 24px;background:#16a34a;color:#fff;text-decoration:none;border-radius:6px;font-weight:bold;">
    無料 web ミーティングを予約する
  </a>
</div>

<p>不躾なご連絡となり申し訳ありません。<br>
今後のご案内をご希望されない場合は、<a href="{{unsubscribe_url}}">こちら</a> から
ワンクリックで配信停止が可能です。</p>

<hr style="border:none;border-top:1px solid #eee;margin:32px 0 16px;">
<p style="font-size:12px;color:#888;">
  株式会社 DRAGON AI<br>
  クリエイティブ＆マーケティングディレクター 佐藤 有一郎<br>
  Mail: sato@dragon-ai.jp / Web: https://dragon-ai.jp
</p>
</body>
</html>
"""

TEXT_TEMPLATE = """\
{{office_name}} 御中

突然のご連絡を失礼いたします。
株式会社 DRAGON AI（サービス名: AI 社労士パートナー）の佐藤と申します。

私たちは全国の社労士事務所様向けに、AI チャットボット付きの無料ホームページと、
顧問先からの労務相談を 24 時間自動応答する AI アシスタント機能を提供しております。

{{office_name}} 様の現状の HP を拝見し、リニューアルと組み合わせてご活用いただける
可能性があると感じご連絡差し上げました。

▼ {{office_name}} 様向けのデモ HP を見る
{{redirect_url}}

導入費用ゼロ、月額 1,980 円〜のトライアルプランからご利用いただけます。
上のリンクから 1 分で生成済みのデモ HP をご覧いただけます。

──────────────────
▼ 直接ご相談されたい方はこちら（無料 30 分 web ミーティング）
https://web-booking-psi.vercel.app/dragon-ai?source=email_dm&recipient_code={{recipient_code}}&fax_code={{fax_code}}

ご希望の日時を画面でお選びいただけます。
──────────────────

今後のご案内をご希望されない場合は、下記 URL からワンクリックで配信停止が可能です。
{{unsubscribe_url}}
──────────────────

株式会社 DRAGON AI
クリエイティブ＆マーケティングディレクター 佐藤 有一郎
Mail: sato@dragon-ai.jp / Web: https://dragon-ai.jp
"""


def sql_escape(value: str) -> str:
    return value.replace("'", "''")


def sql_value(value: str | None) -> str:
    if value is None or value == "":
        return "NULL"
    return f"'{sql_escape(value)}'"


def gen_recipient_code() -> str:
    # 12 chars of url-safe base64 → 72 bits entropy. Sufficient and short for email URLs.
    return secrets.token_urlsafe(9)


def derive_fax_code(row: dict[str, str]) -> str:
    master_id = (row.get("master_id") or "").strip()
    if master_id.startswith("srm-"):
        return master_id[len("srm-") :]
    return master_id or row.get("email", "")


def load_recipients(paths: Iterable[Path]) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    seen: set[str] = set()
    for path in paths:
        if not path.exists():
            print(f"[seed] WARN: source not found: {path}", file=sys.stderr)
            continue
        with path.open(encoding="utf-8") as fh:
            reader = csv.DictReader(fh)
            for row in reader:
                email = (row.get("email") or "").strip().lower()
                if not email or email in seen:
                    continue
                seen.add(email)
                normalized = {k: (v.strip() if isinstance(v, str) else v) for k, v in row.items()}
                normalized["email"] = email
                rows.append(normalized)
    return rows


def render_campaign_insert(
    *,
    campaign_id: str,
    name: str,
    subject: str,
    from_name: str | None,
    from_address: str | None,
    reply_to: str | None,
) -> str:
    return (
        "INSERT OR IGNORE INTO email_dm_campaigns "
        "(id, name, subject, html_template, text_template, from_name, from_address, "
        "reply_to, redirect_url_template, unsubscribe_url_template, status) VALUES (\n"
        f"  {sql_value(campaign_id)},\n"
        f"  {sql_value(name)},\n"
        f"  {sql_value(subject)},\n"
        f"  {sql_value(HTML_TEMPLATE)},\n"
        f"  {sql_value(TEXT_TEMPLATE)},\n"
        f"  {sql_value(from_name)},\n"
        f"  {sql_value(from_address)},\n"
        f"  {sql_value(reply_to)},\n"
        f"  {sql_value(REDIRECT_TARGET_TEMPLATE)},\n"
        f"  {sql_value('{{worker_url}}/u/{{recipient_code}}')},\n"
        f"  'draft'\n"
        ");"
    )


def render_recipient_insert(
    *,
    campaign_id: str,
    recipient_id: str,
    recipient_code: str,
    row: dict[str, str],
) -> str:
    fax_code = derive_fax_code(row)
    variables = (
        '{'
        f'"office_name": "{sql_escape(row.get("office_name", ""))}", '
        f'"prefecture": "{sql_escape(row.get("prefecture", ""))}", '
        f'"website_url": "{sql_escape(row.get("website_url", ""))}", '
        f'"rank": "{sql_escape(row.get("rank", ""))}"'
        '}'
    )
    return (
        "INSERT OR IGNORE INTO email_dm_recipients "
        "(id, campaign_id, recipient_code, email, office_name, representative, fax_code, variables) VALUES ("
        f"{sql_value(recipient_id)}, "
        f"{sql_value(campaign_id)}, "
        f"{sql_value(recipient_code)}, "
        f"{sql_value(row['email'])}, "
        f"{sql_value(row.get('office_name'))}, "
        f"{sql_value(row.get('representative'))}, "
        f"{sql_value(fax_code)}, "
        f"'{sql_escape(variables)}'"
        ");"
    )


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Seed an email DM campaign into D1.")
    parser.add_argument("--campaign-id", default=None, help="Override campaign UUID (default: random)")
    parser.add_argument(
        "--name",
        default="Phase 1 / Campaign A — wayback sr-list",
        help="Campaign display name",
    )
    parser.add_argument("--subject", default=DEFAULT_SUBJECT)
    parser.add_argument("--from-name", default="佐藤有一郎 / DRAGON AI")
    parser.add_argument("--from-address", default="sato@dragon-ai.jp")
    parser.add_argument("--reply-to", default="sato@dragon-ai.jp")
    parser.add_argument(
        "--tier-a",
        type=Path,
        default=DEFAULT_TIER_A,
        help=f"Tier A CSV (default: {DEFAULT_TIER_A})",
    )
    parser.add_argument(
        "--tier-unknown",
        type=Path,
        default=DEFAULT_TIER_UNKNOWN,
        help=f"Tier unknown (always-deliverable subset) CSV (default: {DEFAULT_TIER_UNKNOWN})",
    )
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=DATA_DIR,
        help=f"Output directory for SQL + mapping CSV (default: {DATA_DIR})",
    )
    args = parser.parse_args(argv)

    campaign_id = args.campaign_id or str(uuid.uuid4())
    recipients = load_recipients([args.tier_a, args.tier_unknown])
    if not recipients:
        print("[seed] ERROR: no recipients loaded", file=sys.stderr)
        return 1

    args.out_dir.mkdir(parents=True, exist_ok=True)
    sql_path = args.out_dir / f"seed-campaign-{campaign_id}.sql"
    map_path = args.out_dir / f"recipient-codes-{campaign_id}.csv"

    lines: list[str] = [
        f"-- email DM campaign seed",
        f"-- campaign_id: {campaign_id}",
        f"-- generated: {datetime.utcnow().isoformat()}Z",
        f"-- source: {args.tier_a.name} + {args.tier_unknown.name}",
        f"-- recipients: {len(recipients)}",
        "",
        "BEGIN TRANSACTION;",
        render_campaign_insert(
            campaign_id=campaign_id,
            name=args.name,
            subject=args.subject,
            from_name=args.from_name,
            from_address=args.from_address,
            reply_to=args.reply_to,
        ),
        "",
    ]

    mapping_rows: list[tuple[str, str, str]] = []
    for row in recipients:
        recipient_id = str(uuid.uuid4())
        recipient_code = gen_recipient_code()
        mapping_rows.append((row["email"], recipient_id, recipient_code))
        lines.append(
            render_recipient_insert(
                campaign_id=campaign_id,
                recipient_id=recipient_id,
                recipient_code=recipient_code,
                row=row,
            )
        )

    lines.append("COMMIT;")

    sql_path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    with map_path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(["email", "recipient_id", "recipient_code"])
        writer.writerows(mapping_rows)

    print(f"[seed] campaign_id: {campaign_id}")
    print(f"[seed] recipients: {len(recipients)}")
    print(f"[seed] SQL:        {sql_path}")
    print(f"[seed] mapping:    {map_path}")
    print()
    print("Next steps:")
    try:
        sql_rel = sql_path.relative_to(REPO_ROOT)
    except ValueError:
        sql_rel = sql_path
    print(f"  wrangler d1 execute <DB_NAME> --file {sql_rel}")
    print(f"  # then POST /api/email-dm/campaigns/{campaign_id}/dispatch")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
