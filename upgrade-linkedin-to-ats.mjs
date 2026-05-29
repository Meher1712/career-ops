// upgrade-linkedin-to-ats.mjs — for each unique company we discovered via
// LinkedIn or Instahyre that ISN'T already in portals.yml:
//
//   1. Probe Greenhouse / Ashby / Lever public boards. Hits become first-class
//      tracked_companies entries — next `npm run scan` pulls jobs canonically.
//   2. If no ATS hit, probe common careers-page URL patterns
//      (https://{slug}.com/careers, .in, .co, .io variants). Hits become
//      `scan_method: websearch` entries with their real careers_url, so the
//      user can later enable them or invoke /career-ops scan for coverage.
//   3. If both miss, log and skip — too uncertain to add a fabricated URL.
//
// Run after a scan, or as Step D in run-scan.sh.
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '.');
const PIPELINE = path.join(ROOT, 'data/pipeline.md');
const PORTALS = path.join(ROOT, 'portals.yml');

// ── Load existing tracked_companies (lowercased names for dedup) ────────────
const portals = yaml.load(fs.readFileSync(PORTALS, 'utf8'));
const existingNames = new Set(
  (portals.tracked_companies || []).map(c => (c.name || '').toLowerCase().trim())
);

// Source of candidate companies:
//   --from-queue : just the names listed in data/.ats-probe-queue.txt (used
//                  by sync-saved.mjs + add-by-url to incrementally probe
//                  new companies as they arrive). Clears the queue when done.
//   default     : full scan of pipeline.md (LinkedIn + Instahyre rows).
const FROM_QUEUE = process.argv.includes('--from-queue');
const ATS_QUEUE = path.join(ROOT, 'data/.ats-probe-queue.txt');

const discoveredCompanies = new Set();
if (FROM_QUEUE) {
  if (!fs.existsSync(ATS_QUEUE)) {
    console.log(`(no queue file at ${ATS_QUEUE} — nothing to probe)`);
    process.exit(0);
  }
  for (const line of fs.readFileSync(ATS_QUEUE, 'utf8').split('\n')) {
    const name = line.trim();
    if (name) discoveredCompanies.add(name);
  }
  console.log(`from-queue mode: ${discoveredCompanies.size} companies queued`);
} else {
  const text = fs.readFileSync(PIPELINE, 'utf8');
  for (const line of text.split('\n')) {
    const lk = line.match(/^- \[[ x]\] https:\/\/www\.linkedin\.com\/jobs\/view\/\d+\/?\s*\|\s*([^|]+?)\s*\|/);
    if (lk) { discoveredCompanies.add(lk[1].trim()); continue; }
    const ih = line.match(/^- \[[ x]\] https:\/\/www\.instahyre\.com\/\S+\s*\|\s*([^|]+?)\s*\|/);
    if (ih) { discoveredCompanies.add(ih[1].trim()); continue; }
  }
  console.log(`Pipeline-discovered unique companies (LinkedIn + Instahyre): ${discoveredCompanies.size}`);
}

const candidates = [...discoveredCompanies].filter(n => !existingNames.has(n.toLowerCase().trim()));
console.log(`Not yet in portals.yml: ${candidates.length}`);
if (!candidates.length) {
  console.log('Nothing to upgrade.');
  // Even with nothing to do, clear the queue file in --from-queue mode so it
  // doesn't grow unbounded.
  if (FROM_QUEUE) try { fs.unlinkSync(ATS_QUEUE); } catch {}
  process.exit(0);
}

// ── ATS probe ────────────────────────────────────────────────────────────────
const TIMEOUT_MS = 5000;
const slugify = (s) => (s || '')
  .toLowerCase()
  .replace(/&/g, 'and')
  .replace(/\([^)]*\)/g, '')         // drop "(YC W21)" etc.
  .replace(/\s+yc\s+w?\d+/gi, '')
  .replace(/[\s_.+|\/]+/g, '-')
  .replace(/[^a-z0-9-]/g, '')
  .replace(/-+/g, '-')
  .replace(/^-|-$/g, '');

const candidatesFor = (name) => {
  const base = slugify(name);
  const variants = new Set([base, base.replace(/-/g, '')]);
  const first = base.split('-')[0];
  if (first && first.length >= 3) variants.add(first);
  return [...variants];
};

async function fetchJSON(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'career-ops-upgrade/1.0' } });
    clearTimeout(t);
    if (!r.ok) return null;
    const text = await r.text();
    try { return JSON.parse(text); } catch { return null; }
  } catch { clearTimeout(t); return null; }
}

async function probeATS(name) {
  for (const slug of candidatesFor(name)) {
    const gh = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`;
    const ghj = await fetchJSON(gh);
    if (ghj && Array.isArray(ghj.jobs)) {
      return { kind: 'ats', provider: 'greenhouse', slug, careers_url: `https://job-boards.greenhouse.io/${slug}`, api: gh, jobs: ghj.jobs.length };
    }
    const ash = `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=false`;
    const ashj = await fetchJSON(ash);
    if (ashj && Array.isArray(ashj.jobs)) {
      return { kind: 'ats', provider: 'ashby', slug, careers_url: `https://jobs.ashbyhq.com/${slug}`, jobs: ashj.jobs.length };
    }
    const lev = `https://api.lever.co/v0/postings/${slug}?mode=json`;
    const levj = await fetchJSON(lev);
    if (Array.isArray(levj)) {
      return { kind: 'ats', provider: 'lever', slug, careers_url: `https://jobs.lever.co/${slug}`, jobs: levj.length };
    }
  }
  return null;
}

async function probeCareers(name) {
  // Try common domain + path combinations for the company's own careers page.
  // HEAD requests with redirects allowed; accept 200/3xx as "page exists".
  const baseSlug = slugify(name);
  if (!baseSlug || baseSlug.length < 2) return null;
  const slugVariants = new Set([baseSlug, baseSlug.replace(/-/g, '')]);
  // also try first word (e.g., "Deutsche Telekom Digital Labs" → "deutsche")
  const firstWord = baseSlug.split('-')[0];
  if (firstWord && firstWord.length >= 4) slugVariants.add(firstWord);
  // for companies with descriptive long names, try first two words joined
  const firstTwo = baseSlug.split('-').slice(0, 2).join('');
  if (firstTwo && firstTwo.length >= 5) slugVariants.add(firstTwo);

  const TLDs = ['.com', '.in', '.co', '.io', '.ai'];
  const PATHs = ['/careers', '/careers/', '/jobs', '/jobs/', '/career', '/about/careers', '/company/careers'];

  for (const slug of slugVariants) {
    for (const tld of TLDs) {
      for (const path of PATHs) {
        const url = `https://${slug}${tld}${path}`;
        try {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 4000);
          // Try HEAD first (cheap); fall back to GET on 405.
          let r = await fetch(url, { method: 'HEAD', signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': 'career-ops-probe/1.0' } }).catch(() => null);
          if (r && r.status === 405) {
            r = await fetch(url, { method: 'GET', signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': 'career-ops-probe/1.0' } }).catch(() => null);
          }
          clearTimeout(t);
          if (r && r.ok && r.url) {
            // Sanity: must end up at a URL containing 'career' or 'job' to avoid
            // landing on homepage redirects.
            const final = r.url.toLowerCase();
            if (final.includes('career') || final.includes('jobs')) {
              return { kind: 'careers', careers_url: r.url };
            }
          }
        } catch {}
      }
    }
  }
  return null;
}

async function probe(name) {
  const a = await probeATS(name);
  if (a) return a;
  return await probeCareers(name);
}

async function pMap(items, fn, limit = 10) {
  const out = new Array(items.length);
  let i = 0;
  const w = async () => { while (true) { const idx = i++; if (idx >= items.length) return; out[idx] = await fn(items[idx]); } };
  await Promise.all(Array.from({ length: limit }, w));
  return out;
}

const results = await pMap(candidates, async (name) => {
  const hit = await probe(name);
  if (hit) {
    if (hit.kind === 'ats') process.stderr.write(`✓ ATS    ${name} → ${hit.provider}/${hit.slug} (${hit.jobs} jobs)\n`);
    else process.stderr.write(`✓ Career ${name} → ${hit.careers_url}\n`);
  }
  return [name, hit];
}, 10);

const atsHits = results.filter(([, v]) => v?.kind === 'ats');
const careerHits = results.filter(([, v]) => v?.kind === 'careers');
const totalHits = atsHits.length + careerHits.length;
console.log(`\nATS hits:    ${atsHits.length}`);
console.log(`Career hits: ${careerHits.length}`);
console.log(`Total:       ${totalHits} / ${candidates.length}`);

if (!totalHits) {
  console.log('No new trackable companies discovered.');
  process.exit(0);
}

// ── Append to portals.yml under a clearly-tagged section ────────────────────
const today = new Date().toISOString().slice(0, 10);
let block = `\n  # ── promoted from pipeline discovery (auto, ${today}) ──\n`;

for (const [name, hit] of atsHits) {
  block += `\n  - name: "${name.replace(/"/g, '\\"')}"\n`;
  block += `    careers_url: ${hit.careers_url}\n`;
  if (hit.api) block += `    api: ${hit.api}\n`;
  block += `    notes: "auto-promoted (ATS hit) from pipeline-discovered entry"\n`;
  block += `    enabled: true\n`;
}

// Careers-page-only promotions are PAUSED — they hit a `websearch` scan method
// that doesn't pull JDs reliably and just bloats portals.yml. Only ATS hits
// (Greenhouse / Ashby / Lever) get added, since those have real JSON APIs
// in scan.mjs and contribute actual pipeline entries on each run.
// To re-enable, restore the careerHits loop and the related console output.

const original = fs.readFileSync(PORTALS, 'utf8');
fs.writeFileSync(PORTALS + '.bak', original);
fs.writeFileSync(PORTALS, original.replace(/\n*$/, '\n') + block);

const final = yaml.load(fs.readFileSync(PORTALS, 'utf8'));
console.log(`\nportals.yml now has ${final.tracked_companies.length} tracked_companies (added ${atsHits.length} ATS).`);
console.log(`ATS hits are enabled and will be scanned next run.`);
console.log(`Careers-page hits (${careerHits.length}) found but SKIPPED — websearch promotions are paused.`);
console.log(`Backup at ${PORTALS}.bak`);

// In --from-queue mode, clear the queue file now that we've processed it.
// Names that did NOT resolve to an ATS get logged but are NOT re-queued
// — they'd just churn forever otherwise. User can re-run a full scan if
// they want to retry.
if (FROM_QUEUE) {
  try { fs.unlinkSync(ATS_QUEUE); console.log(`Queue cleared: ${ATS_QUEUE}`); } catch {}
}
