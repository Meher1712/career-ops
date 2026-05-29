// career-ops web dashboard — Trello-style board UI
// Reads data/pipeline.md, data/applications.md, reports/* and serves them.
// Board lane overlay lives in data/board.json (system-layer, machine-managed).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 4242;

const LANES = ['new', 'shortlisted', 'applied', 'interview', 'rejected', 'skipped'];
const BOARD_FILE = path.join(ROOT, 'data/board.json');
const PIPELINE_FILE = path.join(ROOT, 'data/pipeline.md');

function atomicWrite(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function readBoardOverlay() {
  if (!fs.existsSync(BOARD_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(BOARD_FILE, 'utf8')) || {}; }
  catch { return {}; }
}

function writeBoardOverlay(map) {
  atomicWrite(BOARD_FILE, JSON.stringify(map, null, 2) + '\n');
}

function laneForApplication(status = '') {
  const k = status.toLowerCase();
  if (k.includes('interview') || k.includes('offer')) return 'interview';
  // Rejected (from Gmail Step E — ATS / LinkedIn / corporate email rejections):
  // gets its own lane so the user can see the pattern at a glance.
  if (k.includes('reject')) return 'rejected';
  // Discarded by user / SKIP / not-a-fit → skipped lane.
  if (k.includes('discard') || k === 'skip') return 'skipped';
  if (k.includes('applied') || k.includes('evaluated') || k.includes('responded')) return 'applied';
  return 'applied';
}

let scanInProgress = false;
let scanChild = null; // active child_process handle while a scan is running

function readScanHistory() {
  // url → { first_seen, company, title, location }
  const file = path.join(ROOT, 'data/scan-history.tsv');
  const map = new Map();
  if (!fs.existsSync(file)) return map;
  const text = fs.readFileSync(file, 'utf8');
  let header = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const cols = line.split('\t');
    if (!header) { header = cols; continue; }
    const rec = Object.fromEntries(header.map((h, i) => [h, cols[i]]));
    if (rec.url) map.set(rec.url, rec);
  }
  return map;
}

function readPipeline() {
  const file = path.join(ROOT, 'data/pipeline.md');
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8');
  const history = readScanHistory();
  const items = [];
  let order = 0;
  for (const line of text.split('\n')) {
    const m = line.match(/^- \[([ x])\] (\S+)(?:\s*\|\s*(.+))?$/);
    if (!m) continue;
    const [, mark, url, meta = ''] = m;
    const parts = meta.split('|').map(s => s.trim());
    const hist = history.get(url);
    let role = parts[1] || hist?.title || '';
    let location = hist?.location || '';

    // Pull `posted=YYYY-MM-DD` out of any pipe-separated extra field on the line.
    // fix-linkedin-labels.mjs writes this for LinkedIn entries.
    let inlinePosted = null;
    let inlinePostedTs = null;
    let inlineSeenTs = null;
    let inlineReposted = false;
    const extras = parts.slice(2);
    const keepNotes = [];
    for (const e of extras) {
      const pm = e.match(/^posted=(\d{4}-\d{2}-\d{2})$/);
      if (pm) { inlinePosted = pm[1]; continue; }
      const pt = e.match(/^posted_ts=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z)$/);
      if (pt) { inlinePostedTs = pt[1]; continue; }
      const st = e.match(/^seen_ts=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z)$/);
      if (st) { inlineSeenTs = st[1]; continue; }
      if (/^reposted=1$/.test(e)) { inlineReposted = true; continue; }
      keepNotes.push(e);
    }

    // LinkedIn entries from the headless agent encode location inside the role
    // string after an em-dash or " - ". Split it back out so the row layout
    // can show location as its own badge instead of crowding the role.
    if (!location) {
      const sep = role.match(/^(.+?)\s+[—–-]\s+(.+)$/);
      if (sep && sep[2].length < 80) {
        role = sep[1].trim();
        location = sep[2].trim();
      }
    }

    const posted_at = inlinePosted || hist?.posted_at || null;

    // Feed-post entries (from get_feed): meta starts with "FEED: <author>".
    // Strip the "FEED:" prefix so the company chip shows clean author/company
    // name, and flag source as "feed-post" so the dashboard can style it.
    let company = parts[0] || hist?.company || extractHost(url);
    let isFeedPost = false;
    if (/^FEED:\s*/i.test(company)) {
      company = company.replace(/^FEED:\s*/i, '').trim();
      isFeedPost = true;
    }
    const source = isFeedPost
      ? 'feed-post'
      : (hist?.portal || (url.includes('linkedin.com') ? 'linkedin' : 'unknown'));

    items.push({
      done: mark === 'x',
      url,
      company,
      role,
      note: keepNotes.join(' | '),
      location,
      first_seen: hist?.first_seen || inlineSeenTs || null,
      posted_at,
      posted_ts: inlinePostedTs,
      reposted: inlineReposted,
      source,
      order: order++,
    });
  }
  return items;
}

function extractHost(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

function readApplications() {
  const file = path.join(ROOT, 'data/applications.md');
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8');
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('|')) continue;
    if (/^\|\s*[-:|\s]+\|$/.test(line)) continue;
    const cells = line.split('|').slice(1, -1).map(s => s.trim());
    if (cells.length < 9) continue;
    if (cells[0] === '#' || cells[0] === '') continue;
    const [num, date, company, role, score, status, pdf, report, notes] = cells;
    rows.push({ num, date, company, role, score, status, pdf, report, notes });
  }
  return rows;
}

function readReports() {
  const dir = path.join(ROOT, 'reports');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .sort()
    .map(f => ({ name: f, path: `reports/${f}` }));
}

function readProfile() {
  const file = path.join(ROOT, 'config/profile.yml');
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8');
  const name = text.match(/full_name:\s*"?([^"\n]+)"?/)?.[1]?.trim();
  const headline = text.match(/headline:\s*"?([^"\n]+)"?/)?.[1]?.trim();
  return { name, headline };
}

function buildBoard(pipeline, applications, overlay) {
  const cards = [];
  // Build a (company,role) → applications.md row map so we can attach
  // tracker metadata to pipeline cards AND dedup so the same job doesn't
  // appear twice (once as the pipeline card, once as an apps card).
  const appByKey = new Map();
  for (const a of applications) {
    const k = `${(a.company || '').toLowerCase().trim()}::${(a.role || '').toLowerCase().trim()}`;
    appByKey.set(k, a);
  }
  for (const it of pipeline) {
    const ak = `${(it.company || '').toLowerCase().trim()}::${(it.role || '').toLowerCase().trim()}`;
    const matchedApp = appByKey.get(ak);
    if (matchedApp) {
      // Tracker row exists for this pipeline entry — attach its metadata
      // and mark the app key as consumed so it doesn't render a duplicate.
      appByKey.delete(ak);
    }
    // Lane resolution priority:
    //   1. overlay[url]                 (user's explicit drag)
    //   2. laneForApplication(status)   (tracker says this is Applied/Interview/Rejected)
    //   3. done ? skipped : new         (default for fresh pipeline rows)
    const base = it.done ? 'skipped' : 'new';
    const trackerLane = matchedApp ? laneForApplication(matchedApp.status) : null;
    const lane = overlay[it.url] || trackerLane || base;
    cards.push({
      url: it.url,
      company: it.company,
      role: it.role,
      location: it.location,
      source: it.source,
      first_seen: it.first_seen,
      posted_at: it.posted_at,
      posted_ts: it.posted_ts,
      reposted: it.reposted,
      note: it.note,
      origin: 'pipeline',
      done: it.done,
      // Pull through tracker fields if matched, so cards show the
      // canonical status/score/report alongside their pipeline data.
      status: matchedApp?.status || null,
      score: matchedApp?.score || null,
      report: matchedApp?.report || null,
      lane,
    });
  }
  // Render remaining application rows (ones that aren't paired with a
  // pipeline entry — e.g. manually-added applications, or pipeline cards
  // that have been removed but the tracker row remains).
  const seenUrls = new Set(cards.map(c => c.url));
  for (const [_, a] of appByKey) {
    const key = `app::${a.company}::${a.role}`;
    if (seenUrls.has(key)) continue;
    seenUrls.add(key);
    const base = laneForApplication(a.status);
    const lane = overlay[key] || base;
    cards.push({
      url: key,
      company: a.company,
      role: a.role,
      location: '',
      source: 'applications',
      first_seen: a.date || null,
      posted_at: null,
      note: a.notes || '',
      origin: 'application',
      status: a.status,
      score: a.score,
      report: a.report,
      done: false,
      lane,
    });
  }
  return cards;
}

function api(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const pipeline = readPipeline();
  const applications = readApplications();
  const overlay = readBoardOverlay();
  res.end(JSON.stringify({
    profile: readProfile(),
    pipeline,
    applications,
    board: buildBoard(pipeline, applications, overlay),
    reports: readReports(),
    generated_at: new Date().toISOString(),
  }, null, 2));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 1e6) { req.destroy(); reject(new Error('body too large')); } });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function flipPipelineCheckbox(url, checked) {
  if (!fs.existsSync(PIPELINE_FILE)) return false;
  const text = fs.readFileSync(PIPELINE_FILE, 'utf8');
  const lines = text.split('\n');
  let touched = false;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^- \[([ x])\] (\S+)(.*)$/);
    if (!m) continue;
    if (m[2] !== url) continue;
    const mark = checked ? 'x' : ' ';
    if (m[1] === mark) return true;
    lines[i] = `- [${mark}] ${m[2]}${m[3]}`;
    touched = true;
    break;
  }
  if (touched) atomicWrite(PIPELINE_FILE, lines.join('\n'));
  return touched;
}

// Lane → applications.md Status mapping. Used when a card is moved on the board
// so the tracker stays in sync with the user's manual triage decisions.
// `new` returns null because moving back to New shouldn't auto-create a tracker
// row — the card might just be triage-in-progress, not a real application.
function laneToStatus(lane) {
  switch (lane) {
    case 'shortlisted': return 'Evaluated';
    case 'applied':     return 'Applied';
    case 'interview':   return 'Interview';
    case 'rejected':    return 'Rejected';
    case 'skipped':     return 'Discarded';
    default:            return null; // 'new' → no tracker change
  }
}

// Find a pipeline row by URL and return parsed { company, role }. Returns null
// if the URL isn't in pipeline.md (e.g. for app::company::role synthetic URLs).
function pipelineRowFor(url) {
  if (!fs.existsSync(PIPELINE_FILE)) return null;
  const text = fs.readFileSync(PIPELINE_FILE, 'utf8');
  for (const line of text.split('\n')) {
    const m = line.match(/^- \[[ x]\] (\S+)\s*\|\s*(.+)$/);
    if (!m || m[1] !== url) continue;
    const parts = m[2].split('|').map(s => s.trim());
    let company = parts[0] || '';
    // Strip FEED: prefix from feed-post entries.
    company = company.replace(/^FEED:\s*/i, '').trim();
    let role = parts[1] || '';
    // Strip trailing " — Location" from role (LinkedIn entries encode it inline).
    const sep = role.match(/^(.+?)\s+[—–-]\s+/);
    if (sep) role = sep[1].trim();
    return { company, role };
  }
  return null;
}

// Update applications.md in place: if a row matches company+role (case-insensitive),
// update its Status column. If no match exists AND createIfMissing is true, append
// a new row. Returns one of: 'updated', 'created', 'skipped', 'no-file'.
function upsertApplicationRow({ company, role, status, createIfMissing, sourceNote }) {
  const file = path.join(ROOT, 'data/applications.md');
  if (!fs.existsSync(file)) return 'no-file';
  if (!company || !role || !status) return 'skipped';
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const wantCompany = company.toLowerCase().trim();
  const wantRole = role.toLowerCase().trim();
  let maxNum = 0;
  let updatedIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('|')) continue;
    if (/^\|\s*[-:|\s]+\|$/.test(line)) continue;
    const cells = line.split('|').slice(1, -1).map(s => s.trim());
    if (cells.length < 9) continue;
    if (cells[0] === '#' || cells[0] === '') continue;
    const n = parseInt(cells[0], 10);
    if (Number.isFinite(n)) maxNum = Math.max(maxNum, n);
    const rowCompany = (cells[2] || '').toLowerCase();
    const rowRole = (cells[3] || '').toLowerCase();
    if (rowCompany === wantCompany && rowRole === wantRole) {
      // Update Status (col 5) in place. Preserve other columns.
      if (cells[5] === status) return 'skipped'; // already at target
      cells[5] = status;
      lines[i] = `| ${cells.join(' | ')} |`;
      updatedIdx = i;
      break;
    }
  }

  if (updatedIdx >= 0) {
    atomicWrite(file, lines.join('\n'));
    return 'updated';
  }
  if (!createIfMissing) return 'skipped';

  // Append a new row. Date = today. Score, PDF, Report blank/em-dash placeholders.
  const today = new Date().toISOString().slice(0, 10);
  const newRow = `| ${maxNum + 1} | ${today} | ${company} | ${role} | —/5 | ${status} | ❌ | — | ${sourceNote || 'source: dashboard-move'} |`;
  // Find the last non-empty line and insert after it; if file ends with blank,
  // just append. Either way preserve trailing newline.
  const trimmed = text.replace(/\n*$/, '');
  atomicWrite(file, trimmed + '\n' + newRow + '\n');
  return 'created';
}

async function boardMove(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ error: 'use POST' })); }
  let body;
  try { body = await readJsonBody(req); }
  catch (e) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'bad json: ' + e.message })); }
  const { url, lane } = body || {};
  if (!url || typeof url !== 'string') { res.statusCode = 400; return res.end(JSON.stringify({ error: 'url required' })); }
  if (!LANES.includes(lane)) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'invalid lane' })); }
  const overlay = readBoardOverlay();
  overlay[url] = lane;
  writeBoardOverlay(overlay);
  // Side-effect: SKIPPED on a pipeline row also flips the markdown checkbox to [x].
  // NEW on a pipeline row clears it back to [ ] in case it had been marked done.
  let pipelineUpdated = false;
  if (!url.startsWith('app::')) {
    if (lane === 'skipped') pipelineUpdated = flipPipelineCheckbox(url, true);
    else if (lane === 'new') pipelineUpdated = flipPipelineCheckbox(url, false);
  }

  // Sync applications.md so the dashboard's manual triage matches the tracker.
  // - Moving a pipeline card to applied/interview/rejected/shortlisted creates
  //   a new tracker row if one doesn't exist (so Gmail Step E can later flip
  //   it to Rejected when an email arrives).
  // - Moving the same kind of card to skipped only UPDATES existing rows; we
  //   don't create a tracker row for a job the user explicitly discarded.
  // - Moving an applications.md card (app::company::role) always updates the
  //   existing row in place — never creates a duplicate.
  let trackerAction = 'no-change';
  const status = laneToStatus(lane);
  if (status) {
    let company = null, role = null;
    if (url.startsWith('app::')) {
      const parts = url.slice(5).split('::');
      company = parts[0]; role = parts.slice(1).join('::');
    } else {
      const row = pipelineRowFor(url);
      if (row) { company = row.company; role = row.role; }
    }
    if (company && role) {
      // Don't auto-create rows for the Skipped lane (negative-signal moves
      // shouldn't pollute the tracker with new entries).
      const createIfMissing = lane !== 'skipped';
      trackerAction = upsertApplicationRow({
        company, role, status, createIfMissing,
        sourceNote: `source: dashboard-move (${lane})`,
      });
    }
  }

  // CANCELLATION: if user moves a card AWAY from Shortlisted while its prep
  // is in flight, kill the prep. Saves tokens on a card you no longer want.
  // SIGTERM the process group; SIGKILL after 2s; write a `cancelled.flag`
  // as a backup signal in case the SIGTERM misses a child.
  let prepCancelled = null;
  if (lane !== 'shortlisted' && !url.startsWith('app::')) {
    const row = pipelineRowFor(url);
    const slug = row ? (row.company || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') : null;
    if (slug) {
      const lockPath = path.join(ROOT, 'output', slug, '.prep.lock');
      if (fs.existsSync(lockPath)) {
        try {
          const lockText = fs.readFileSync(lockPath, 'utf8');
          const pidMatch = lockText.match(/^pid=(\d+)/m);
          if (pidMatch) {
            const lockPid = parseInt(pidMatch[1], 10);
            // Drop a cancellation flag first — surviving children check this on next step.
            fs.writeFileSync(path.join(ROOT, 'output', slug, 'cancelled.flag'),
              `cancelled_at=${new Date().toISOString()}\nreason=lane-moved-to-${lane}\n`);
            // SIGTERM the process group (bash + its claude -p children share one)
            try { process.kill(-lockPid, 'SIGTERM'); } catch {
              try { process.kill(lockPid, 'SIGTERM'); } catch {}
            }
            setTimeout(() => {
              try { process.kill(-lockPid, 'SIGKILL'); } catch {
                try { process.kill(lockPid, 'SIGKILL'); } catch {}
              }
              try { fs.unlinkSync(lockPath); } catch {}
            }, 2000);
            prepCancelled = { slug, pid: lockPid, target_lane: lane };
          }
        } catch (e) {
          prepCancelled = { error: e.message };
        }
      }
    }
  }

  // PAUSED 2026-05-19: shortlist-prep auto-spawn disabled per user request.
  // The full pipeline (fit-check + alumni + outreach + CV tailor + answers)
  // is too token-heavy and not reliable enough to justify running on every
  // shortlist move. Existing output/<slug>/ artifacts are preserved and the
  // dashboard's apply / referral buttons keep working for cards that
  // already have prep data; we just don't generate NEW artifacts.
  //
  // To re-enable in the future: restore the spawn block from git history,
  // or run `bash shortlist-prep.sh <url>` manually for a specific card.
  let prepSpawned = false;
  let prepSkipped = lane === 'shortlisted' && !url.startsWith('app::')
    ? 'auto-prep paused (run shortlist-prep.sh manually if needed)'
    : null;

  res.end(JSON.stringify({ ok: true, url, lane, pipelineUpdated, trackerAction, prepSpawned, prepSkipped, prepCancelled }));
}

// --- Apply & fill ----------------------------------------------------------
// Called when user clicks "Approve & fill" in the side panel. Body must
// include url + edited answers object. Writes a tmp JSON file with the
// answers and spawns fill-form.mjs in detached mode. The HTTP response
// returns immediately; fill-form opens a visible Chrome and stops at Submit.
async function applyFill(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ error: 'use POST' })); }
  let body;
  try { body = await readJsonBody(req); }
  catch (e) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'bad json: ' + e.message })); }
  const { url, answers } = body || {};
  if (!url || typeof url !== 'string') { res.statusCode = 400; return res.end(JSON.stringify({ error: 'url required' })); }
  if (!answers || typeof answers !== 'object') { res.statusCode = 400; return res.end(JSON.stringify({ error: 'answers object required' })); }
  const row = pipelineRowFor(url);
  if (!row) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'url not in pipeline' })); }
  const slug = (row.company || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const outDir = path.join(ROOT, 'output', slug);
  if (!fs.existsSync(outDir)) {
    res.statusCode = 412;
    return res.end(JSON.stringify({ error: `no prep artifacts yet for ${slug}; move card to Shortlisted first` }));
  }
  // Write the edited answers to a tmp JSON for fill-form to read.
  const answersTmp = path.join(outDir, '.answers-edited.json');
  fs.writeFileSync(answersTmp, JSON.stringify(answers, null, 2));
  const cvPath = path.join(outDir, 'cv-tailored.pdf');
  const linkedinSlow = url.includes('linkedin.com');

  const fillArgs = ['fill-form.mjs', '--url', url, '--answers-file', answersTmp];
  if (fs.existsSync(cvPath)) fillArgs.push('--cv', cvPath);
  if (linkedinSlow) fillArgs.push('--linkedin-slow');

  try {
    const proc = spawn('node', fillArgs, {
      cwd: ROOT,
      detached: true,
      stdio: 'ignore',
    });
    proc.unref();
    res.end(JSON.stringify({ ok: true, slug, pid: proc.pid, linkedinSlow }));
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: 'spawn failed: ' + e.message }));
  }
}

// Serve the parsed answers for a slug (used by the side panel to populate
// the textareas). Reads output/{slug}/answers.md and parses heading-per-field.
function readAnswers(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const url = new URL(req.url, 'http://x').searchParams.get('url');
  if (!url) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'url query param required' })); }
  const row = pipelineRowFor(url);
  if (!row) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'url not in pipeline' })); }
  const slug = (row.company || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const file = path.join(ROOT, 'output', slug, 'answers.md');
  if (!fs.existsSync(file)) {
    return res.end(JSON.stringify({ slug, answers: null, ready: false }));
  }
  const text = fs.readFileSync(file, 'utf8');
  // Parse "## key\n<body>\n\n## key\n..." blocks
  const answers = {};
  const blocks = text.split(/^##\s+/m).slice(1); // first chunk is preamble
  for (const block of blocks) {
    const nl = block.indexOf('\n');
    if (nl < 0) continue;
    const key = block.slice(0, nl).trim().split(/\s+/)[0];
    const body = block.slice(nl + 1).trim();
    if (key) answers[key] = body;
  }
  res.end(JSON.stringify({ slug, answers, ready: true }));
}

// --- Fit info -------------------------------------------------------------
// Returns the cv-fit.json contents for a slug. Dashboard uses this to render
// the "★ 0.xx fit" score and rationale chip on the card.
function fitInfo(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const url = new URL(req.url, 'http://x').searchParams.get('url');
  if (!url) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'url query param required' })); }
  const row = pipelineRowFor(url);
  if (!row) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'url not in pipeline' })); }
  const slug = (row.company || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const file = path.join(ROOT, 'output', slug, 'cv-fit.json');
  if (!fs.existsSync(file)) return res.end(JSON.stringify({ slug, ready: false }));
  try {
    const fit = JSON.parse(fs.readFileSync(file, 'utf8'));
    res.end(JSON.stringify({ slug, ready: true, ...fit }));
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: 'parse failed: ' + e.message }));
  }
}

// --- Outreach -------------------------------------------------------------
// Returns parsed outreach.md as { alums: [{ name, profile, headline, message }] }
// so the side panel can render one card per alum with the prefilled message.
function readOutreach(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const url = new URL(req.url, 'http://x').searchParams.get('url');
  if (!url) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'url query param required' })); }
  const row = pipelineRowFor(url);
  if (!row) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'url not in pipeline' })); }
  const slug = (row.company || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const file = path.join(ROOT, 'output', slug, 'outreach.md');
  if (!fs.existsSync(file)) return res.end(JSON.stringify({ slug, alums: [], ready: false }));
  const text = fs.readFileSync(file, 'utf8');
  // Parse "## Alum N: <name>\n**Profile:** <url>\n**Headline:** <hl>\n\n<body>"
  const alums = [];
  const blocks = text.split(/^##\s+Alum\s+\d+:\s*/m).slice(1);
  for (const block of blocks) {
    const lines = block.split('\n');
    const name = lines[0].trim();
    const profileMatch = block.match(/\*\*Profile:\*\*\s*<?(https:\/\/[^\s>]+)/);
    const headlineMatch = block.match(/\*\*Headline:\*\*\s*([^\n]+)/);
    const bodyStart = block.indexOf('\n\n', block.indexOf('**Headline:**'));
    const body = bodyStart > 0 ? block.slice(bodyStart + 2).split(/^---/m)[0].trim() : '';
    if (name && profileMatch) {
      alums.push({
        name,
        profile: profileMatch[1].replace(/[>)]+$/, ''),
        headline: headlineMatch ? headlineMatch[1].trim() : '',
        message: body,
      });
    }
  }
  res.end(JSON.stringify({ slug, alums, ready: alums.length > 0 }));
}

// --- Send referral via Playwright -----------------------------------------
// Called when user clicks "send to <alum>" in the outreach panel. Spawns
// send-referral.mjs with the profile URL + message file. Opens visible
// Chrome, types message, stops at Send.
async function sendReferral(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ error: 'use POST' })); }
  let body;
  try { body = await readJsonBody(req); }
  catch (e) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'bad json: ' + e.message })); }
  const { profile, message } = body || {};
  if (!profile || !/^https:\/\/(www\.)?linkedin\.com\/in\//.test(profile)) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: 'profile must be a linkedin.com/in/ URL' }));
  }
  if (!message || typeof message !== 'string') {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: 'message required' }));
  }
  // Write message to a tmp file
  const tmpDir = path.join(ROOT, 'logs');
  fs.mkdirSync(tmpDir, { recursive: true });
  const msgFile = path.join(tmpDir, `.referral-msg-${Date.now()}.txt`);
  fs.writeFileSync(msgFile, message);
  try {
    const proc = spawn('node', ['send-referral.mjs', '--profile', profile, '--message-file', msgFile], {
      cwd: ROOT,
      detached: true,
      stdio: 'ignore',
    });
    proc.unref();
    res.end(JSON.stringify({ ok: true, pid: proc.pid, profile }));
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: 'spawn failed: ' + e.message }));
  }
}

// --- Shortlist-prep status -------------------------------------------------
// Returns which of the prep artifacts exist for a given URL. The dashboard
// polls this every ~10s while a card is in the Shortlisted lane and the
// artifacts are still missing.
function shortlistStatus(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const url = new URL(req.url, 'http://x').searchParams.get('url');
  if (!url) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'url query param required' })); }
  const row = pipelineRowFor(url);
  if (!row) return res.end(JSON.stringify({ slug: null, files: {}, ready: false }));
  const slug = (row.company || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const dir = path.join(ROOT, 'output', slug);

  // HONEST FILE CHECKS — only count an artifact as "ready" if it BOTH
  // exists AND has meaningful content. Stub files with "(no results)" or
  // tiny markdown shells don't count.
  const hasNonEmpty = (p, minBytes) =>
    fs.existsSync(p) && fs.statSync(p).size >= minBytes;
  const hasNonStubBody = (p) => {
    if (!hasNonEmpty(p, 100)) return false;
    const text = fs.readFileSync(p, 'utf8');
    // Strip comment headers and check for substantive body
    const body = text.replace(/^#[^\n]*\n/gm, '').trim();
    if (!body) return false;
    if (/^\(no results|^\(error/i.test(body)) return false;
    return body.length > 50; // arbitrary but excludes one-line stubs
  };

  // CV is ready if EITHER the tailored PDF exists AND has real content,
  // OR the fit-check explicitly decided tailoring wasn't needed.
  const pdfPath = path.join(dir, 'cv-tailored.pdf');
  const notesPath = path.join(dir, 'cv-tailoring-notes.md');
  const pdfReady = hasNonEmpty(pdfPath, 5000); // a real PDF is > 5KB
  let cvSkipped = false;
  let cvReady = pdfReady;
  if (!cvReady && fs.existsSync(notesPath)) {
    const notes = fs.readFileSync(notesPath, 'utf8');
    if (/SKIPPED/.test(notes)) { cvReady = true; cvSkipped = true; }
  }

  // Alumni file: stub if it just says "(no results — ...)". Then outreach
  // is also a stub. Both count as NOT-ready so the dashboard isn't misleading.
  const alumniReady = hasNonStubBody(path.join(dir, 'alumni.md'));
  const outreachReady = hasNonStubBody(path.join(dir, 'outreach.md'));
  const answersReady = hasNonStubBody(path.join(dir, 'answers.md'));
  const fitReady = hasNonEmpty(path.join(dir, 'cv-fit.json'), 50);

  const files = {
    fit: fitReady,
    alumni: alumniReady,
    outreach: outreachReady,
    cv: cvReady,
    cv_skipped: cvSkipped,
    answers: answersReady,
  };
  res.end(JSON.stringify({
    slug,
    files,
    // Apply button enables when CV + answers actually have content.
    ready: cvReady && answersReady,
  }));
}

function serveFile(req, res, rel, contentType) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) { res.statusCode = 404; return res.end('not found'); }
  res.setHeader('Content-Type', contentType);
  fs.createReadStream(file).pipe(res);
}

// --- /api/add-by-url ------------------------------------------------------
// Accepts { urls: string[] } and adds each to pipeline.md (if not already
// present). Used by the desktop bookmarklet and the dashboard paste-textarea.
//
// CORS is wide open on this endpoint because the bookmarklet runs from
// linkedin.com / greenhouse.io / any job page origin. Defense-in-depth:
// we only accept loopback callers (127.0.0.1 / ::1) — non-localhost
// requests must include the token from `~/.career-ops/token`.
function isLoopbackRemote(req) {
  const ip = req.socket?.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}
function readToken() {
  try { return fs.readFileSync(path.join(process.env.HOME || '', '.career-ops/token'), 'utf8').trim(); }
  catch { return null; }
}

async function addByUrl(req, res) {
  // CORS preflight + headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Career-Ops-Token');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ error: 'use POST' })); }
  res.setHeader('Content-Type', 'application/json');

  // Auth: localhost is free, remote requires token
  if (!isLoopbackRemote(req)) {
    const expected = readToken();
    const got = req.headers['x-career-ops-token'];
    if (!expected || got !== expected) {
      res.statusCode = 401;
      return res.end(JSON.stringify({ error: 'unauthorized; loopback or X-Career-Ops-Token required' }));
    }
  }

  let body;
  try { body = await readJsonBody(req); }
  catch (e) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'bad json: ' + e.message })); }

  const urls = Array.isArray(body?.urls) ? body.urls : (body?.url ? [body.url] : []);
  if (!urls.length) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'urls (array) or url (string) required' })); }

  const { parseAnyJobUrl } = await import(path.join(ROOT, 'linkedin-public-parse.mjs'));
  const existingUrls = new Set((readPipeline() || []).map(p => p.url));
  const portalsText = fs.existsSync(path.join(ROOT, 'portals.yml'))
    ? fs.readFileSync(path.join(ROOT, 'portals.yml'), 'utf8') : '';
  const tracked = new Set();
  for (const m of portalsText.matchAll(/^\s*-?\s*name:\s*"?([^"\n]+)"?/gm)) {
    tracked.add(m[1].trim().toLowerCase());
  }
  const atsQueue = path.join(ROOT, 'data/.ats-probe-queue.txt');

  const results = [];
  // Cap concurrency at 5 to be polite to LinkedIn's anon endpoint
  const queue = [...urls];
  async function worker() {
    while (queue.length) {
      const url = queue.shift();
      if (!url || typeof url !== 'string') {
        results.push({ url, status: 'failed', error: 'not a string' });
        continue;
      }
      // Reject loopback / localhost URLs — these are our own dashboard /
      // bookmarklet pages, never real job postings. A bookmarklet click
      // on the bookmarklet page itself would otherwise self-poison pipeline.md.
      try {
        const u = new URL(url);
        if (/^(localhost|127\.0\.0\.1|::1|0\.0\.0\.0)$/.test(u.hostname)) {
          results.push({ url, status: 'failed', error: 'loopback url rejected' });
          continue;
        }
        if (!/^https?:$/.test(u.protocol)) {
          results.push({ url, status: 'failed', error: 'unsupported protocol' });
          continue;
        }
      } catch (e) {
        results.push({ url, status: 'failed', error: 'invalid URL: ' + e.message });
        continue;
      }
      if (existingUrls.has(url) || existingUrls.has(url.replace(/\/$/, ''))) {
        results.push({ url, status: 'duplicate' });
        continue;
      }
      const r = await parseAnyJobUrl(url).catch(e => ({ ok: false, error: e.message }));
      if (!r.ok) { results.push({ url, status: 'failed', error: r.error }); continue; }
      const loc = r.location ? ` — ${r.location}` : '';
      const postedTag = r.posted_at ? ` | posted=${r.posted_at}` : '';
      const repostedTag = r.reposted ? ` | reposted=1` : '';
      const line = `- [ ] ${url} | ${r.company} | ${r.role}${loc}${postedTag}${repostedTag}`;
      // Append + update local set so concurrent workers dedup
      const cur = fs.existsSync(PIPELINE_FILE) ? fs.readFileSync(PIPELINE_FILE, 'utf8') : '# Pipeline\n\n';
      fs.writeFileSync(PIPELINE_FILE, (cur.endsWith('\n') ? cur : cur + '\n') + line + '\n');
      existingUrls.add(url);

      // Queue new company for ATS probing
      if (r.company && !tracked.has(r.company.toLowerCase())) {
        const queueText = fs.existsSync(atsQueue) ? fs.readFileSync(atsQueue, 'utf8') : '';
        if (!queueText.split('\n').some(l => l.trim().toLowerCase() === r.company.toLowerCase())) {
          fs.appendFileSync(atsQueue, r.company.trim() + '\n');
        }
      }
      results.push({ url, status: 'added', meta: { company: r.company, role: r.role, location: r.location, posted_at: r.posted_at } });
    }
  }
  await Promise.all([worker(), worker(), worker(), worker(), worker()]);
  res.end(JSON.stringify({ results }, null, 2));
}

// --- /api/sync-saved ------------------------------------------------------
// Spawns `node sync-saved.mjs` and returns immediately. The dashboard polls
// /api/sync-saved/status for completion (look for a `data/.sync-saved.pid`
// lock or just check pipeline.md mtime). For now: just spawn detached.
let syncSavedChild = null;
async function syncSaved(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ error: 'use POST' })); }
  if (syncSavedChild && !syncSavedChild.killed && syncSavedChild.exitCode === null) {
    return res.end(JSON.stringify({ ok: false, error: 'sync-saved already running', pid: syncSavedChild.pid }));
  }
  const logFile = path.join(ROOT, 'logs', `sync-saved-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const out = fs.openSync(logFile, 'w');
  syncSavedChild = spawn('node', ['sync-saved.mjs'], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', out, out],
  });
  syncSavedChild.unref();
  res.end(JSON.stringify({ ok: true, pid: syncSavedChild.pid, log: logFile }));
}

// --- /api/sync-saved/status -----------------------------------------------
// Returns the latest sync log's last few lines + whether a child is alive.
function syncSavedStatus(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const running = !!(syncSavedChild && syncSavedChild.exitCode === null && !syncSavedChild.killed);
  // Find the most-recent sync-saved-*.log
  let latest = null;
  try {
    const logs = fs.readdirSync(path.join(ROOT, 'logs'))
      .filter(f => f.startsWith('sync-saved-') && f.endsWith('.log'))
      .map(f => ({ f, mtime: fs.statSync(path.join(ROOT, 'logs', f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (logs[0]) latest = logs[0].f;
  } catch {}
  let tail = '';
  if (latest) {
    try {
      const lines = fs.readFileSync(path.join(ROOT, 'logs', latest), 'utf8').split('\n');
      tail = lines.slice(-12).join('\n');
    } catch {}
  }
  res.end(JSON.stringify({ running, pid: syncSavedChild?.pid || null, log: latest, tail }));
}

const INDEX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html');

function scanStatus(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ running: scanInProgress, pid: scanChild?.pid || null }));
}

async function stopScan(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (!scanInProgress || !scanChild) {
    res.statusCode = 200;
    return res.end(JSON.stringify({ stopped: false, reason: 'no scan running' }));
  }
  const pid = scanChild.pid;
  try {
    // Kill the whole process group (run-scan.sh + its claude/uvx/python children)
    // child was spawned with detached:true, so it has its own process group.
    process.kill(-pid, 'SIGTERM');
    setTimeout(() => {
      try { process.kill(-pid, 'SIGKILL'); } catch {}
    }, 2000);
    res.statusCode = 200;
    res.end(JSON.stringify({ stopped: true, pid }));
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ stopped: false, error: err.message }));
  }
}

function runScan(req, res) {
  if (req.method !== 'POST') { res.statusCode = 405; return res.end('use POST'); }
  if (scanInProgress) {
    res.statusCode = 409;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: 'scan already running' }));
  }
  scanInProgress = true;

  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  send('start', { startedAt: new Date().toISOString() });

  const script = path.join(ROOT, 'run-scan.sh');
  // Dashboard-triggered scans use quick mode: ATS + Instahyre + 1 minimal LinkedIn search
  // (Product Manager India past_24h). Cron (no SCAN_MODE override) runs full mode.
  const child = spawn('bash', [script], {
    cwd: ROOT,
    env: { ...process.env, SCAN_MODE: 'quick' },
    detached: true,
  });
  scanChild = child;
  let summary = null;
  let linkedinTokens = null;
  let gmailTokens = null;
  let gmailSummary = null;

  const emit = (chunk) => {
    const text = chunk.toString('utf8');
    for (const line of text.split('\n')) {
      if (!line) continue;
      const m = line.match(/^SCAN_DONE before=(\d+) after=(\d+) added=(-?\d+)/);
      if (m) summary = { before: +m[1], after: +m[2], added: +m[3] };
      const t = line.match(/^LINKEDIN_TOKENS input=(\d+) output=(\d+) cost_usd=([\d.]+)/);
      if (t) linkedinTokens = { input: +t[1], output: +t[2], costUsd: +t[3] };
      const g = line.match(/^GMAIL_TOKENS input=(\d+) output=(\d+) cost_usd=([\d.]+)/);
      if (g) gmailTokens = { input: +g[1], output: +g[2], costUsd: +g[3] };
      const gd = line.match(/^GMAIL_DONE applied_added=(\d+) interview_updated=(\d+) interview_added=(\d+) responded_added=(\d+) rejected_updated=(\d+) suggested=(\d+)/);
      if (gd) gmailSummary = {
        appliedAdded: +gd[1], interviewUpdated: +gd[2], interviewAdded: +gd[3],
        respondedAdded: +gd[4], rejectedUpdated: +gd[5], suggested: +gd[6],
      };
      send('log', { line });
    }
  };
  child.stdout.on('data', emit);
  child.stderr.on('data', emit);

  child.on('close', (code) => {
    send('done', { exitCode: code, summary, linkedinTokens, gmailTokens, gmailSummary, stopped: code !== 0 && !summary });
    res.end();
    scanInProgress = false;
    scanChild = null;
  });
  child.on('error', (err) => {
    send('done', { exitCode: -1, error: err.message });
    res.end();
    scanInProgress = false;
    scanChild = null;
  });
  req.on('close', () => {
    // Browser disconnected — let the script finish in the background; just stop streaming.
    // (No kill, intentional. User can see results in logs/.)
  });
}

const server = http.createServer((req, res) => {
  const url = req.url || '/';
  if (url === '/' || url === '/index.html') return serveFile(req, res, path.relative(ROOT, INDEX), 'text/html; charset=utf-8');
  if (url === '/bookmarklet' || url === '/bookmarklet.html') {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bookmarklet.html');
    return serveFile(req, res, path.relative(ROOT, file), 'text/html; charset=utf-8');
  }
  if (url === '/api/data') return api(req, res);
  if (url === '/api/board/move') return boardMove(req, res);
  if (url === '/api/scan') return runScan(req, res);
  if (url === '/api/scan/stop') return stopScan(req, res);
  if (url === '/api/scan/status') return scanStatus(req, res);
  if (url.startsWith('/api/shortlist-status')) return shortlistStatus(req, res);
  if (url.startsWith('/api/answers')) return readAnswers(req, res);
  if (url.startsWith('/api/fit')) return fitInfo(req, res);
  if (url.startsWith('/api/outreach')) return readOutreach(req, res);
  if (url === '/api/apply-fill') return applyFill(req, res);
  if (url === '/api/send-referral') return sendReferral(req, res);
  if (url === '/api/add-by-url') return addByUrl(req, res);
  if (url === '/api/sync-saved') return syncSaved(req, res);
  if (url === '/api/sync-saved/status') return syncSavedStatus(req, res);
  if (url.startsWith('/reports/')) {
    const rel = url.replace(/^\//, '').replace(/\.\./g, '');
    if (!rel.startsWith('reports/')) { res.statusCode = 400; return res.end('bad'); }
    return serveFile(req, res, rel, 'text/markdown; charset=utf-8');
  }
  // Serve files under output/ for shortlist-stage artifacts (alumni.md,
  // cv-tailored.pdf, answers.md). Open-in-new-tab links from the dashboard
  // cards point here. Path-traversal guard same as /reports/.
  if (url.startsWith('/output/')) {
    const rel = url.replace(/^\//, '').replace(/\.\./g, '').split('?')[0];
    if (!rel.startsWith('output/')) { res.statusCode = 400; return res.end('bad'); }
    const ext = path.extname(rel).toLowerCase();
    const ctype = ext === '.pdf'  ? 'application/pdf'
              : ext === '.md'   ? 'text/markdown; charset=utf-8'
              : ext === '.html' ? 'text/html; charset=utf-8'
              : ext === '.json' ? 'application/json'
              : 'text/plain; charset=utf-8';
    return serveFile(req, res, rel, ctype);
  }
  res.statusCode = 404;
  res.end('not found');
});

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`career-ops dashboard → ${url}`);
  console.log(`reading: ${ROOT}`);
});
