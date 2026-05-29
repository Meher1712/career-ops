// fix-linkedin-labels.mjs — re-fetches each LinkedIn URL in pipeline.md
// and rewrites company/role/location from the page's <title> tag.
//
// The headless MCP agent fabricated some labels during the scan. Public
// LinkedIn job pages don't need auth for the title; they return the
// canonical "{Company} hiring {Role} in {Location} | LinkedIn" string.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '.');
const PIPELINE = path.join(ROOT, 'data/pipeline.md');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

async function fetchTitle(url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' } });
    if (!r.ok) return { ok: false, status: r.status };
    const html = await r.text();
    const m = html.match(/<title>([^<]*)<\/title>/i);
    if (!m) return { ok: false, status: 200, reason: 'no <title>' };
    const title = m[1].replace(/&amp;/g, '&').trim();

    // LinkedIn's public unauth page shows the MAIN job's date as relative text
    // ("2 hours ago", "1 week ago") inside <span class="posted-time-ago__text...">.
    // The --new modifier on the class is LinkedIn highlighting a fresh posting —
    // NOT a refresh of an older job. The only reliable "reposted" indicator is
    // the literal word "Reposted" prefixed before the relative time.
    let posted_at = null;
    let posted_ts = null;
    let reposted = false;

    const span = html.match(/<span class="(posted-time-ago__text[^"]*)"[^>]*>([\s\S]{0,300}?)<\/span>/);
    if (span) {
      const inner = span[2];
      if (/Reposted/i.test(inner)) reposted = true;

      const rel = inner.match(/(\d+)\s+(day|week|month|hour)s?\s+ago/i);
      if (rel) {
        const n = parseInt(rel[1], 10);
        const unit = rel[2].toLowerCase();
        const d = new Date();
        if (unit === 'hour')       d.setHours(d.getHours() - n);
        else if (unit === 'day')   d.setDate(d.getDate() - n);
        else if (unit === 'week')  d.setDate(d.getDate() - n * 7);
        else if (unit === 'month') d.setMonth(d.getMonth() - n);
        posted_at = d.toISOString().slice(0, 10);
        // Hour-resolution timestamp for sub-day ordering. LinkedIn's "X hours ago"
        // drifts by up to ~30 min — fine for sorting, don't quote as exact.
        posted_ts = d.toISOString().slice(0, 13) + ':00Z';
      } else if (/yesterday/i.test(inner)) {
        const d = new Date(); d.setDate(d.getDate() - 1);
        posted_at = d.toISOString().slice(0, 10);
        posted_ts = d.toISOString().slice(0, 13) + ':00Z';
      }
    }

    // Fallback when the page exists but exposes no posted-time element
    // (some fresh jobs, regional variants). Use the fetch time so the
    // entry has a sort key — labelled "seen X ago" not "posted X ago"
    // so the user knows it's our discovery date, not LinkedIn's.
    let seen_ts = null;
    if (!posted_ts) {
      seen_ts = new Date().toISOString().slice(0, 13) + ':00Z';
    }

    return { ok: true, title, posted_at, posted_ts, seen_ts, reposted };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Parse "<Company> hiring <Role> in <Location> | LinkedIn"
function parseTitle(title) {
  const m = title.match(/^(.+?)\s+hiring\s+(.+?)\s+in\s+(.+?)\s*\|\s*LinkedIn\b/);
  if (!m) return null;
  return { company: m[1].trim(), role: m[2].trim(), location: m[3].trim() };
}

// Mirror of the Group B title filter in run-scan.sh Step B. Used to prune
// jobs that slipped through Group A (past_24_hours, no title filter at
// scan time) but turn out not to be PM/Product Owner roles per the
// canonical page title fetched here.
function isPmRole(role) {
  if (!role) return false;
  const r = role.toLowerCase();
  // Match "product" + manager/management/owner/ops/lead/strategy/marketing-adjacent
  if (/\bproduct\s+(manager|management|owner|ops|lead|strategy)/.test(r)) return true;
  // Titles where "product" is the noun: "Director of Product", "Head of Product",
  // "VP Product", "Group Product", "Principal Product", "Founding Product", etc.
  if (/\b(senior|sr\.?|lead|director|principal|head|vp|group|chief|founding|staff)\b[^,;]*?\bproduct\b/.test(r)) return true;
  // AI PM phrasing
  if (/\bai\s+pm\b/.test(r)) return true;
  // Standalone "PM" token (case-sensitive intent, but we already lowercased — accept either)
  if (/^pm\b/.test(r) || /\spm\b/.test(r)) return true;
  return false;
}

const text = fs.readFileSync(PIPELINE, 'utf8');
const lines = text.split('\n');
let fixed = 0, kept = 0, failed = 0, pruned = 0, nonLinkedIn = 0;
const failures = [];

for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/^- \[([ x])\] (https:\/\/www\.linkedin\.com\/jobs\/view\/\d+\/?)\s*(?:\|\s*(.+))?$/);
  if (!m) { nonLinkedIn++; continue; }
  const [, mark, url, oldMeta = ''] = m;
  // Skip lines that already have a date stamp — they were processed in a prior run.
  // Only re-fetch lines with no metadata at all (freshly added by LinkedIn scan).
  if (oldMeta && (oldMeta.includes('posted=') || oldMeta.includes('seen_ts=') || oldMeta.includes('posted_ts='))) {
    kept++; continue;
  }
  process.stdout.write(`[${i+1}] ${url} … `);
  const r = await fetchTitle(url);
  if (!r.ok) {
    failed++;
    process.stdout.write(`FAIL (${r.status || r.error || '?'})\n`);
    failures.push({ url, reason: r.status || r.error });
    continue;
  }
  const parsed = parseTitle(r.title);
  if (!parsed) {
    failed++;
    process.stdout.write(`UNPARSED: ${r.title}\n`);
    failures.push({ url, reason: 'unparsed: ' + r.title.slice(0, 80) });
    continue;
  }
  // Auto-prune: if the canonical role isn't a PM/Product Owner title, mark the
  // line as done so it lands in the dashboard's "skipped" lane. Preserves the
  // entry (avoids re-adding on next scan) and records why via prune=role-mismatch.
  // Only auto-prune entries that are still [ ] — don't disturb user choices.
  const isPm = isPmRole(parsed.role);
  const autoPrune = !isPm && mark === ' ';
  const newMark = autoPrune ? 'x' : mark;
  // Preserve any existing seen_ts on the line so we don't drift the date
  // forward every time we re-fetch a page that has no posted-time element.
  const existingSeenTs = oldMeta.match(/\|\s*seen_ts=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z)/)?.[1] || null;
  const seenTsToWrite = (!r.posted_ts && !r.posted_at) ? (existingSeenTs || r.seen_ts) : null;
  const newMeta = `${parsed.company} | ${parsed.role} — ${parsed.location}${r.posted_at ? ` | posted=${r.posted_at}` : ''}${r.posted_ts ? ` | posted_ts=${r.posted_ts}` : ''}${seenTsToWrite ? ` | seen_ts=${seenTsToWrite}` : ''}${r.reposted ? ` | reposted=1` : ''}${autoPrune ? ` | prune=role-mismatch` : ''}`;
  if (newMeta === oldMeta && newMark === mark) { kept++; process.stdout.write('unchanged\n'); }
  else {
    lines[i] = `- [${newMark}] ${url} | ${newMeta}`;
    if (autoPrune) {
      pruned++;
      process.stdout.write(`PRUNED → not a PM role: ${parsed.role}\n`);
    } else {
      fixed++;
      process.stdout.write(`FIXED → ${parsed.company} | ${parsed.role}${r.posted_at ? ` (posted ${r.posted_at})` : ''}\n`);
    }
  }
  await new Promise(r => setTimeout(r, 400)); // rate-limit politely
}

fs.writeFileSync(PIPELINE + '.bak', text);
fs.writeFileSync(PIPELINE, lines.join('\n'));

console.log(`\nFixed: ${fixed}  Kept: ${kept}  Pruned: ${pruned}  Failed: ${failed}  (non-LinkedIn lines untouched: ${nonLinkedIn - 1})`);
if (failures.length) {
  console.log('\nFailures:');
  failures.forEach(f => console.log(`  ${f.url} → ${f.reason}`));
}
console.log(`\nBackup saved to ${PIPELINE}.bak`);
