// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */
import { execFile } from 'node:child_process';

// Workday provider — per-tenant POST API.
// careers_url pattern: https://<slug>.wd<n>.myworkdayjobs.com/<BoardName>
// API:                 POST https://<slug>.wd<n>.myworkdayjobs.com/wday/cxs/<slug>/<BoardName>/jobs
//
// Note: Workday requires HTTP/2 — Node.js's https/fetch use HTTP/1.1 and get
// blocked after a few requests. We shell out to curl which negotiates HTTP/2.

function resolveParams(entry) {
  const url = entry.careers_url || '';
  const m = url.match(/https?:\/\/([a-z0-9_-]+)\.(wd\d+)\.myworkdayjobs\.com\/([^/?#\s]+)/i);
  if (!m) return null;
  return { slug: m[1], wdNum: m[2], board: m[3] };
}

function curlPost(url, body, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const timeoutSec = Math.ceil(timeoutMs / 1000);
    execFile('curl', [
      '-s', '--max-time', String(timeoutSec),
      '-X', 'POST', url,
      '-H', 'Content-Type: application/json',
      '-H', 'Accept: application/json',
      '-d', bodyStr,
    ], { timeout: timeoutMs + 2000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`curl error: ${err.message}`));
      try {
        const json = JSON.parse(stdout);
        if (json.errorCode || (json.httpStatus && json.httpStatus >= 400)) {
          const e = new Error(`HTTP ${json.httpStatus ?? 400}: ${stdout.slice(0, 200)}`);
          e.status = json.httpStatus ?? 400;
          return reject(e);
        }
        resolve(json);
      } catch {
        reject(new Error(`workday: invalid JSON from ${url}: ${stdout.slice(0, 100)}`));
      }
    });
  });
}

/** @type {Provider} */
export default {
  id: 'workday',

  detect(entry) {
    const p = resolveParams(entry);
    if (!p) return null;
    return { url: `https://${p.slug}.${p.wdNum}.myworkdayjobs.com/wday/cxs/${p.slug}/${p.board}/jobs` };
  },

  async fetch(entry, _ctx) {
    const p = resolveParams(entry);
    if (!p) throw new Error(`workday: cannot parse careers_url for ${entry.name}`);

    const apiUrl = `https://${p.slug}.${p.wdNum}.myworkdayjobs.com/wday/cxs/${p.slug}/${p.board}/jobs`;
    const baseUrl = `https://${p.slug}.${p.wdNum}.myworkdayjobs.com`;

    // Workday caps limit at 20 — paginate until we have all jobs
    const PAGE_SIZE = 20;
    const allPostings = [];
    let offset = 0;
    while (true) {
      const json = await curlPost(apiUrl, { limit: PAGE_SIZE, offset, searchText: '', appliedFacets: {} });
      const page = Array.isArray(json?.jobPostings) ? json.jobPostings : [];
      allPostings.push(...page);
      if (page.length < PAGE_SIZE) break; // last page
      offset += PAGE_SIZE;
      if (offset >= 500) break; // safety cap — no company has 500+ relevant PM jobs
    }

    const today = new Date();
    const parsePostedOn = (s) => {
      if (!s) return null;
      const lower = s.toLowerCase();
      if (lower.includes('today') || lower.includes('just posted')) return today.toISOString().slice(0, 10);
      const m = lower.match(/(\d+)\+?\s+days?\s+ago/);
      if (m) {
        const d = new Date(today);
        d.setDate(d.getDate() - parseInt(m[1], 10));
        return d.toISOString().slice(0, 10);
      }
      return null;
    };

    return allPostings.map(j => ({
      title: j.title || '',
      url: j.externalPath ? `${baseUrl}/${p.board}${j.externalPath}` : '',
      company: entry.name,
      location: j.locationsText || '',
      posted_at: parsePostedOn(j.postedOn),
    })).filter(j => j.url && j.title);
  },
};
