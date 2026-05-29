// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Workable provider — public widget API.
// careers_url pattern: https://apply.workable.com/<slug>/  or  https://<slug>.workable.com/
// API:                 https://apply.workable.com/api/v1/widget/accounts/<slug>?details=true

function resolveSlug(entry) {
  const url = entry.careers_url || '';
  let m = url.match(/apply\.workable\.com\/([^/?#]+)/);
  if (m) return m[1];
  m = url.match(/([a-z0-9-]+)\.workable\.com/i);
  return m ? m[1] : null;
}

/** @type {Provider} */
export default {
  id: 'workable',

  detect(entry) {
    const slug = resolveSlug(entry);
    return slug ? { url: `https://apply.workable.com/api/v1/widget/accounts/${slug}?details=true` } : null;
  },

  async fetch(entry, ctx) {
    const slug = resolveSlug(entry);
    if (!slug) throw new Error(`workable: cannot derive slug for ${entry.name}`);
    const apiUrl = `https://apply.workable.com/api/v1/widget/accounts/${slug}?details=true`;
    const json = await ctx.fetchJson(apiUrl);
    const jobs = Array.isArray(json?.jobs) ? json.jobs : [];
    return jobs.map(j => {
      const locs = Array.isArray(j.locations) && j.locations.length
        ? j.locations.map(l => [l.city, l.country].filter(Boolean).join(', ')).join(' / ')
        : [j.city, j.state, j.country].filter(Boolean).join(', ');
      return {
        title: j.title || '',
        url: j.url || j.shortlink || (j.shortcode ? `https://apply.workable.com/j/${j.shortcode}` : ''),
        company: entry.name,
        location: locs || (j.telecommuting ? 'Remote' : ''),
        posted_at: typeof j.published_on === 'string' ? j.published_on.slice(0, 10) : null,
      };
    }).filter(j => j.url);
  },
};
