// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Keka provider — India HRMS, per-tenant subdomain.
// careers_url pattern: https://<tenant>.keka.com/careers/
// API:                 https://<tenant>.keka.com/careers/api/jobs?pageNumber=1&pageSize=100

function resolveTenant(entry) {
  const url = entry.careers_url || '';
  const m = url.match(/https?:\/\/([a-z0-9-]+)\.keka\.com/i);
  return m ? m[1] : null;
}

/** @type {Provider} */
export default {
  id: 'keka',

  detect(entry) {
    const tenant = resolveTenant(entry);
    return tenant ? { url: `https://${tenant}.keka.com/careers/api/jobs?pageNumber=1&pageSize=100` } : null;
  },

  async fetch(entry, ctx) {
    const tenant = resolveTenant(entry);
    if (!tenant) throw new Error(`keka: cannot derive tenant for ${entry.name}`);
    const apiUrl = `https://${tenant}.keka.com/careers/api/jobs?pageNumber=1&pageSize=100`;
    const json = await ctx.fetchJson(apiUrl);
    // Keka response shape varies; try common keys.
    const items = Array.isArray(json?.data) ? json.data
      : Array.isArray(json?.results) ? json.results
      : Array.isArray(json) ? json
      : [];
    return items.map(j => {
      const id = j.id || j.jobId || j.publicJobId || '';
      const slug = (j.title || j.jobTitle || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const location = j.location || j.locationName ||
        (Array.isArray(j.locations) ? j.locations.map(l => l.name || l.city).filter(Boolean).join(', ') : '');
      return {
        title: j.title || j.jobTitle || '',
        url: id ? `https://${tenant}.keka.com/careers/jobdetails/${id}` : '',
        company: entry.name,
        location: location || '',
        posted_at: typeof (j.publishedOn || j.createdOn || j.postedOn) === 'string'
          ? (j.publishedOn || j.createdOn || j.postedOn).slice(0, 10) : null,
      };
    }).filter(j => j.url && j.title);
  },
};
