// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// LinkedIn provider — public guest jobs API. No auth, no cookies, no MCP.
// API: GET https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search
//   ?keywords=Product+Manager&location=India&f_TPR=r86400&sortBy=DD&start=0
//
// Returns 10 results per page. Paginate via start=0,10,20,...
// Dates come back as ISO strings in datetime="YYYY-MM-DD" attributes.
//
// portals.yml entry (explicit provider, no careers_url needed):
//   - name: LinkedIn India PM
//     provider: linkedin
//     keywords: "Product Manager"
//     location: "India"
//     time_filter: r86400   # r3600=1h, r86400=24h, r604800=7d
//     max_pages: 10         # 10 results/page → 100 jobs max
//     enabled: true

const GUEST_API = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';
const PAGE_SIZE = 10;

const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function parseJobs(html) {
  const jobs = [];
  const liRe = /<li>([\s\S]*?)<\/li>/g;
  let m;
  while ((m = liRe.exec(html)) !== null) {
    const block = m[1];

    const titleM = block.match(/<h3 class="base-search-card__title">\s*([\s\S]*?)\s*<\/h3>/);
    const companyM = block.match(/<h4 class="base-search-card__subtitle"[\s\S]*?href[^>]+>([^<]+)<\/a>/);
    const locationM = block.match(/class="job-search-card__location"[^>]*>\s*([^<]+?)\s*</);
    const dateM = block.match(/datetime="([^"]+)"/);
    const idM = block.match(/data-entity-urn="urn:li:jobPosting:(\d+)"/);

    if (!titleM || !idM) continue;

    jobs.push({
      title: titleM[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim(),
      company: companyM ? companyM[1].replace(/&amp;/g, '&').trim() : '',
      location: locationM ? locationM[1].trim() : '',
      posted_at: dateM ? dateM[1].slice(0, 10) : null,
      url: `https://www.linkedin.com/jobs/view/${idM[1]}`,
    });
  }
  return jobs;
}

/** @type {Provider} */
export default {
  id: 'linkedin',

  // Never auto-detect from careers_url — always configured explicitly.
  detect: () => null,

  async fetch(entry, ctx) {
    const keywords = entry.keywords || 'Product Manager';
    const location = entry.location || 'India';
    const tpr = entry.time_filter || 'r86400'; // default: past 24h
    const maxPages = entry.max_pages ?? 10;

    const headers = {
      'user-agent': CHROME_UA,
      'accept': 'text/html,application/xhtml+xml',
      'accept-language': 'en-US,en;q=0.9',
    };

    const allJobs = [];
    for (let page = 0; page < maxPages; page++) {
      const start = page * PAGE_SIZE;
      const params = new URLSearchParams({
        keywords,
        location,
        f_TPR: tpr,
        sortBy: 'DD',
        start: String(start),
      });

      let html;
      try {
        html = await ctx.fetchText(`${GUEST_API}?${params}`, { headers });
      } catch (err) {
        // 429 = rate limited — stop paginating gracefully
        if (err.status === 429) break;
        throw err;
      }

      const page_jobs = parseJobs(html);
      allJobs.push(...page_jobs);
      if (page_jobs.length < PAGE_SIZE) break; // last page
    }

    // Fill in company from entry.name for jobs where LinkedIn didn't return one
    return allJobs.map(j => ({
      ...j,
      company: j.company || entry.name,
    }));
  },
};
