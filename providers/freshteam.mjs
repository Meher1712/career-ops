// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Freshteam provider — HTML scrape of public job board.
// careers_url pattern: https://<tenant>.freshteam.com/jobs
// No public JSON API (v2 requires API key). Jobs are embedded in the HTML page.

function resolveTenant(entry) {
  const url = entry.careers_url || '';
  const m = url.match(/https?:\/\/([a-z0-9-]+)\.freshteam\.com/i);
  return m ? m[1] : null;
}

/** @type {Provider} */
export default {
  id: 'freshteam',

  detect(entry) {
    const tenant = resolveTenant(entry);
    return tenant ? { url: `https://${tenant}.freshteam.com/jobs` } : null;
  },

  async fetch(entry, ctx) {
    const tenant = resolveTenant(entry);
    if (!tenant) throw new Error(`freshteam: cannot derive tenant for ${entry.name}`);

    const baseUrl = `https://${tenant}.freshteam.com`;
    const html = await ctx.fetchText(`${baseUrl}/jobs`, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'accept': 'text/html',
      },
    });

    const jobs = [];
    // Each job is: <a href="/jobs/{id}/{slug}" class="heading" ...>
    //   <div class="job-title">Title</div>
    //   ...
    //   <div class="location-info">City, State\nFull Time</div>
    // </a>
    const jobRe = /<a\s+href="(\/jobs\/[^"]+)"\s+class="heading"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = jobRe.exec(html)) !== null) {
      const path = m[1];
      const block = m[2];

      const titleMatch = block.match(/<div\s+class="job-title">\s*([^<]+?)\s*<\/div>/i);
      const locMatch = block.match(/<div\s+class="location-info">\s*([\s\S]*?)\s*<\/div>/i);

      if (!titleMatch) continue;
      const title = titleMatch[1].trim();
      const locRaw = locMatch ? locMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
      // Location block contains "City, State\nFull Time" — take first line
      const location = locRaw.split(/\n|<br\s*\/?>/i)[0].trim();

      jobs.push({
        title,
        url: `${baseUrl}${path}`,
        company: entry.name,
        location,
        posted_at: null, // Freshteam doesn't expose post dates on the listing page
      });
    }

    return jobs;
  },
};
