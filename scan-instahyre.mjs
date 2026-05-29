// scan-instahyre.mjs — pull PM roles from Instahyre's public JSON API.
// Walks paginated /api/v1/job_search, filters client-side by title + location,
// dedups against data/pipeline.md, appends new entries.
//
// No auth required. ~35 jobs/page; stops on first page with zero PM matches
// past a small fresh window, or after MAX_PAGES (whichever comes first).
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '.');
const PIPELINE = path.join(ROOT, 'data/pipeline.md');
const MAX_PAGES = Number(process.env.INSTAHYRE_MAX_PAGES) || 30; // 30 pages × 35 = 1050 latest jobs scanned
const REQ_DELAY_MS = 250;

const PM_RX = /\b(Product Manager|Product Owner|AI PM|AI Product|Lead Product|Senior Product|Principal Product|Group Product|Staff Product|Head of Product|VP of Product|Founding PM|Founding Product)\b/i;
const NEGATIVE_RX = /\b(Engineer|Developer|Designer|Data Scientist|Analyst|Marketing|Sales|Recruiter|Intern|Junior)\b/i;
const INDIA_RX = /\b(India|Bangalore|Bengaluru|Mumbai|Delhi|New Delhi|Gurgaon|Gurugram|Noida|Hyderabad|Pune|Chennai|Kolkata|Ahmedabad|Remote|Work From Home|WFH|Anywhere)\b/i;

function loadSeenUrls() {
  if (!fs.existsSync(PIPELINE)) return new Set();
  const text = fs.readFileSync(PIPELINE, 'utf8');
  const urls = new Set();
  const roleKeys = new Set();
  for (const line of text.split('\n')) {
    const m = line.match(/^- \[[ x]\] (\S+)(?:\s*\|\s*([^|]+)\s*\|\s*([^|]+))?/);
    if (!m) continue;
    urls.add(m[1]);
    if (m[2] && m[3]) roleKeys.add(`${m[2].trim().toLowerCase()}::${m[3].trim().toLowerCase()}`);
  }
  return { urls, roleKeys };
}

async function fetchPage(offset) {
  const url = `https://www.instahyre.com/api/v1/job_search?limit=35&offset=${offset}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'career-ops-instahyre/1.0', 'Accept': 'application/json' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

const seen = loadSeenUrls();
const newLines = [];
const newEntries = []; // parallel array for scan-history.tsv writes
let pagesWalked = 0, totalJobs = 0, kept = 0, alreadySeen = 0, filteredTitle = 0, filteredLocation = 0, filteredNegative = 0;

for (let page = 0; page < MAX_PAGES; page++) {
  const offset = page * 35;
  let data;
  try {
    data = await fetchPage(offset);
  } catch (e) {
    console.error(`[page ${page}] fetch failed: ${e.message}`);
    break;
  }
  const jobs = data.objects || [];
  if (!jobs.length) break;
  pagesWalked++;
  totalJobs += jobs.length;

  for (const j of jobs) {
    const url = j.public_url;
    const title = j.title || '';
    const company = j.employer?.company_name || 'Unknown';
    const location = j.locations || '';

    if (NEGATIVE_RX.test(title)) { filteredNegative++; continue; }
    if (!PM_RX.test(title)) { filteredTitle++; continue; }
    if (!INDIA_RX.test(location)) { filteredLocation++; continue; }
    if (seen.urls.has(url)) { alreadySeen++; continue; }
    const key = `${company.toLowerCase()}::${title.toLowerCase()}`;
    if (seen.roleKeys.has(key)) { alreadySeen++; continue; }

    seen.urls.add(url);
    seen.roleKeys.add(key);

    const role = `${title} — ${location}`;
    newLines.push(`- [ ] ${url} | ${company} | ${role}`);
    newEntries.push({ url, company, title, location });
    kept++;
  }

  await new Promise(r => setTimeout(r, REQ_DELAY_MS));
}

console.log(`Instahyre scan: ${pagesWalked} pages × 35 = ${totalJobs} jobs scanned`);
console.log(`  filtered (negative): ${filteredNegative}  (title not PM): ${filteredTitle}  (location): ${filteredLocation}  (already known): ${alreadySeen}`);
console.log(`  new entries: ${kept}`);

if (newLines.length) {
  const original = fs.readFileSync(PIPELINE, 'utf8');
  const block = '\n' + newLines.join('\n') + '\n';
  fs.writeFileSync(PIPELINE, original.replace(/\n*$/, '\n') + block);

  // Also write to scan-history.tsv so the dashboard can show first_seen / source.
  // Instahyre's public API doesn't expose a posting date, so posted_at stays blank.
  const HISTORY = path.join(ROOT, 'data/scan-history.tsv');
  const today = new Date().toISOString().slice(0, 10);
  let header = 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\tposted_at\n';
  if (fs.existsSync(HISTORY)) {
    const h = fs.readFileSync(HISTORY, 'utf8').split('\n')[0] || '';
    if (h && !h.includes('posted_at')) {
      const body = fs.readFileSync(HISTORY, 'utf8').split('\n').slice(1).join('\n');
      fs.writeFileSync(HISTORY, h + '\tposted_at\n' + body);
    }
  } else {
    fs.writeFileSync(HISTORY, header);
  }
  const rows = newEntries.map(e =>
    `${e.url}\t${today}\tinstahyre-api\t${e.title}\t${e.company}\tadded\t${e.location}\t`
  ).join('\n') + '\n';
  fs.appendFileSync(HISTORY, rows);

  console.log(`Appended to data/pipeline.md and data/scan-history.tsv`);
} else {
  console.log('Nothing new.');
}
