// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// SmartRecruiters provider — public postings API.
// careers_url pattern: https://jobs.smartrecruiters.com/<slug>
// API:                 https://api.smartrecruiters.com/v1/companies/<slug>/postings?limit=100

function resolveSlug(entry) {
  const url = entry.careers_url || '';
  const m = url.match(/(?:jobs|careers)\.smartrecruiters\.com\/([^/?#]+)/);
  return m ? m[1] : null;
}

/** @type {Provider} */
export default {
  id: 'smartrecruiters',

  detect(entry) {
    const slug = resolveSlug(entry);
    return slug ? { url: `https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=100` } : null;
  },

  async fetch(entry, ctx) {
    const slug = resolveSlug(entry);
    if (!slug) throw new Error(`smartrecruiters: cannot derive slug for ${entry.name}`);
    const apiUrl = `https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=100`;
    const json = await ctx.fetchJson(apiUrl);
    const items = Array.isArray(json?.content) ? json.content : [];
    return items.map(j => {
      const city = j.location?.city || '';
      const country = j.location?.country || '';
      const location = [city, country].filter(Boolean).join(', ');
      return {
        title: j.name || '',
        url: j.ref || `https://jobs.smartrecruiters.com/${slug}/${j.id}`,
        company: entry.name,
        location,
        posted_at: typeof j.releasedDate === 'string' ? j.releasedDate.slice(0, 10) : null,
      };
    }).filter(j => j.url);
  },
};
