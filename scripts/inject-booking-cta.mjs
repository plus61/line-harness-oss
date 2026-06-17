#!/usr/bin/env node
// Phase Z-1: Replace the legacy "/lp.html" floating CTA on every demo-{faxCode}.html
// with a "web meeting 予約" CTA that points at the production web-booking page.
//
// Source of truth: apps/worker/public/demo-*.html (dist/client/ is a build-time
// copy and gets re-generated). Run this script after each batch update,
// idempotent via the data-dragon-ai-booking-cta marker.
//
// Rationale: pre-existing scripts/inject-demo-cta.mjs put a green floating
// button that took curious visitors to the SaaS LP /lp.html. For Phase Z
// (line-harness → crm-backend booking funnel integration) we want the
// PRIMARY CTA on the demo HP to be "book a web meeting" so warm prospects
// reach the closer faster. The top sticky banner (LP shortcut) and the
// existing line-bridge button stay in place as secondary / softer paths.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '..', 'apps', 'worker', 'public');

const NEW_MARKER = 'data-dragon-ai-booking-cta';
const LEGACY_FLOATING_MARKER_VALUE = 'data-dragon-ai-signup-cta="floating"';

const BOOKING_BASE_URL = 'https://web-booking-psi.vercel.app/dragon-ai';

function buildFloatingCta(faxCode) {
  const params = new URLSearchParams({
    source: 'fax_dm',
    fax_code: faxCode,
  });
  const href = `${BOOKING_BASE_URL}?${params.toString()}`;
  return (
    `<a ${NEW_MARKER}="floating" href="${href}" target="_blank" rel="noopener" ` +
    `style="position:fixed;right:16px;bottom:16px;z-index:9999;background:linear-gradient(135deg,#0d6efd,#0a58ca);` +
    `color:#fff;padding:14px 22px;border-radius:32px;text-decoration:none;font-weight:700;font-size:14px;` +
    `box-shadow:0 8px 24px rgba(13,110,253,0.4);font-family:'Hiragino Sans','Noto Sans JP',system-ui,sans-serif;` +
    `display:inline-flex;align-items:center;gap:8px;">` +
    `📅 無料 web ミーティングを予約` +
    `</a>`
  );
}

function extractFaxCode(filename) {
  const m = filename.match(/^demo-(\d+)\.html$/);
  return m ? m[1] : null;
}

function removeLegacyFloatingCta(html) {
  // Strip the previous "/lp.html" floating button if it's still around so we
  // don't end up with two stacked floating elements at the same screen corner.
  const pattern = new RegExp(`<a\\s+${LEGACY_FLOATING_MARKER_VALUE}[^>]*>[\\s\\S]*?</a>\\s*`, 'g');
  return html.replace(pattern, '');
}

function removeOurOwnFloatingCta(html) {
  // Idempotency: if we already injected our marker, remove it before re-injecting.
  const pattern = new RegExp(`<a\\s+${NEW_MARKER}="floating"[^>]*>[\\s\\S]*?</a>\\s*`, 'g');
  return html.replace(pattern, '');
}

function injectFloatingCta(html, ctaHtml) {
  const bodyCloseIdx = html.lastIndexOf('</body>');
  if (bodyCloseIdx === -1) {
    return html + '\n' + ctaHtml + '\n';
  }
  return html.slice(0, bodyCloseIdx) + ctaHtml + '\n' + html.slice(bodyCloseIdx);
}

function processFile(filePath, filename) {
  const faxCode = extractFaxCode(filename);
  if (!faxCode) {
    return { status: 'skipped-bad-name' };
  }

  const src = fs.readFileSync(filePath, 'utf8');
  const stripped = removeOurOwnFloatingCta(removeLegacyFloatingCta(src));
  const next = injectFloatingCta(stripped, buildFloatingCta(faxCode));

  if (next === src) {
    return { status: 'unchanged' };
  }

  fs.writeFileSync(filePath, next);
  return { status: 'updated', faxCode };
}

function main() {
  if (!fs.existsSync(PUBLIC_DIR)) {
    console.error(`[inject-booking-cta] PUBLIC_DIR not found: ${PUBLIC_DIR}`);
    process.exit(1);
  }

  const files = fs
    .readdirSync(PUBLIC_DIR)
    .filter((f) => f.startsWith('demo-') && f.endsWith('.html'));

  const stats = { updated: 0, unchanged: 0, skipped: 0 };
  const sampleFaxCodes = [];

  for (const file of files) {
    const result = processFile(path.join(PUBLIC_DIR, file), file);
    if (result.status === 'updated') {
      stats.updated += 1;
      if (sampleFaxCodes.length < 3) sampleFaxCodes.push(result.faxCode);
    } else if (result.status === 'unchanged') {
      stats.unchanged += 1;
    } else {
      stats.skipped += 1;
    }
  }

  console.log('[inject-booking-cta] done');
  console.log(`  total scanned: ${files.length}`);
  console.log(`  updated:       ${stats.updated}`);
  console.log(`  unchanged:     ${stats.unchanged}`);
  console.log(`  skipped:       ${stats.skipped}`);
  if (sampleFaxCodes.length > 0) {
    console.log(`  sample CTA: ${BOOKING_BASE_URL}?source=fax_dm&fax_code=${sampleFaxCodes[0]}`);
  }
}

main();
