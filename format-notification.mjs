#!/usr/bin/env node
/**
 * format-notification.mjs
 * Reads new-jobs.json written by scan.mjs and prints a numbered Telegram
 * message body with clickable links — one job per line.
 *
 * Each job gets a stable number so you can say "apply to job 3" to any
 * downstream agent and it knows exactly which posting you mean.
 *
 * Output uses Telegram Markdown v1 syntax:  *bold*  _italic_  [text](url)
 */

import { readFileSync } from 'fs';

const jobs = JSON.parse(readFileSync('new-jobs.json', 'utf-8'));
const MAX = 15;            // keep messages under Telegram's 4096-char limit
const shown = jobs.slice(0, MAX);

const lines = shown.map((j, i) => {
  const loc = j.location ? ` • ${j.location}` : '';
  // Two-line format: number+label on line 1, bare URL on line 2 (Telegram auto-links it)
  return `${i + 1}. ${j.title} • ${j.company}${loc}\n${j.url}`;
});

if (jobs.length > MAX) {
  lines.push(`_…and ${jobs.length - MAX} more_`);
}

process.stdout.write(lines.join('\n'));
