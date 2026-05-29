// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// BambooHR provider — per-tenant subdomain.
// careers_url pattern: https://<tenant>.bamboohr.com/careers
// API:                 https://<tenant>.bamboohr.com/careers/list

function resolveTenant(entry) {
  const url = entry.careers_url || '';
  const m = url.match(/https?:\/\/([a-z0-9-]+)\.bamboohr\.com/i);
  return m ? m[1] : null;
}

/** @type {Provider} */
export default {
  id: 'bamboohr',

  detect(entry) {
    const tenant = resolveTenant(entry);
    return tenant ? { url: `https://${tenant}.bamboohr.com/careers/list` } : null;
  },

  async fetch(entry, ctx) {
    const tenant = resolveTenant(entry);
    if (!tenant) throw new Error(`bamboohr: cannot derive tenant for ${entry.name}`);
    const apiUrl = `https://${tenant}.bamboohr.com/careers/list`;
    const json = await ctx.fetchJson(apiUrl, { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' } });
    const items = Array.isArray(json?.result) ? json.result
      : Array.isArray(json?.jobs) ? json.jobs
      : Array.isArray(json) ? json : [];
    return items.map(j => {
      const id = j.id || j.jobOpeningId || '';
      const location = j.location?.city
        ? [j.location.city, j.location.state, j.location.country].filter(Boolean).join(', ')
        : (typeof j.location === 'string' ? j.location : '');
      return {
        title: j.jobOpeningName || j.title || '',
        url: id ? `https://${tenant}.bamboohr.com/careers/${id}` : '',
        company: entry.name,
        location,
        posted_at: typeof (j.datePosted || j.postedDate) === 'string'
          ? (j.datePosted || j.postedDate).slice(0, 10) : null,
      };
    }).filter(j => j.url && j.title);
  },
};
