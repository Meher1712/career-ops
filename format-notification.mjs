#!/usr/bin/env node
/**
 * format-notification.mjs
 * Reads new-jobs.json written by scan.mjs and:
 *   1. Writes data/last-notification-jobs.json — bridge file for KiloClaw so it
 *      can resolve "apply to JoVE Product Manager" or a pasted URL to the full
 *      job record. Committed to GitHub after each scan.
 *   2. Prints a numbered Telegram message body (bare URLs auto-link in Telegram).
 *
 * Output uses Telegram Markdown v1 syntax:  *bold*  _italic_  [text](url)
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';

const jobs = JSON.parse(readFileSync('new-jobs.json', 'utf-8'));
const MAX = 15;            // keep messages under Telegram's 4096-char limit
const shown = jobs.slice(0, MAX);

// ── Bridge file for KiloClaw ────────────────────────────────────────
// KiloClaw fetches this from GitHub raw URL (with a read-only PAT) to
// resolve which job the user is referring to when they say "apply to X".
mkdirSync('data', { recursive: true });
writeFileSync('data/last-notification-jobs.json', JSON.stringify({
  generated_at: new Date().toISOString(),
  jobs: shown.map((j, i) => ({
    n: i + 1,
    title: j.title,
    company: j.company,
    location: j.location || '',
    url: j.url,
  })),
}, null, 2), 'utf-8');

const lines = shown.map((j, i) => {
  const loc = j.location ? ` • ${j.location}` : '';
  // Two-line format: number+label on line 1, bare URL on line 2 (Telegram auto-links it)
  return `${i + 1}. ${j.title} • ${j.company}${loc}\n${j.url}`;
});

if (jobs.length > MAX) {
  lines.push(`_…and ${jobs.length - MAX} more_`);
}

process.stdout.write(lines.join('\n'));
