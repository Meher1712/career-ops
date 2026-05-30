#!/usr/bin/env node
/**
 * apply-queue.mjs
 *
 * Reads data/apply-queue.json and applies to each pending job using
 * career-ops apply mode (Claude + browser automation).
 *
 * Usage:
 *   node apply-queue.mjs          # apply to all pending jobs
 *   node apply-queue.mjs --list   # show queue without applying
 *   node apply-queue.mjs --clear  # clear all pending jobs
 *
 * Workflow:
 *   1. Run telegram-listener.mjs to queue jobs from Telegram
 *   2. Open laptop → run this script
 *   3. Claude navigates to each URL, fills the form, stops before Submit
 *   4. You review and confirm each submission
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { spawn }                                               from 'child_process';

const QUEUE_PATH  = 'data/apply-queue.json';
const MEMORY_PATH = 'nanoclaw-memory.md';
const CV_PATH     = 'cv.md';
const args        = process.argv.slice(2);

// ── Queue helpers ───────────────────────────────────────────────────

function loadQueue() {
  if (!existsSync(QUEUE_PATH)) return [];
  try { return JSON.parse(readFileSync(QUEUE_PATH, 'utf-8')); }
  catch { return []; }
}

function saveQueue(queue) {
  mkdirSync('data', { recursive: true });
  writeFileSync(QUEUE_PATH, JSON.stringify(queue, null, 2), 'utf-8');
}

function markJob(queue, url, status) {
  const idx = queue.findIndex(j => j.url === url);
  if (idx !== -1) {
    queue[idx].status = status;
    queue[idx][status === 'applied' ? 'applied_at' : 'failed_at'] = new Date().toISOString();
  }
}

// ── Build apply prompt ──────────────────────────────────────────────

function buildPrompt(url) {
  const memory = existsSync(MEMORY_PATH) ? readFileSync(MEMORY_PATH, 'utf-8') : '';
  const cv     = existsSync(CV_PATH)     ? readFileSync(CV_PATH, 'utf-8')     : '';

  return `You are applying to a job on behalf of Meher Sehgal using career-ops apply mode.

Job URL: ${url}

## Instructions
1. Navigate to the job URL using browser automation
2. Detect the ATS type (Greenhouse, Ashby, Lever, LinkedIn Easy Apply, Workday, or custom)
3. Fill ALL form fields using the profile and memory below
4. For any custom questions ("Why this role?", "Tell us about a project"), write tailored answers using the initiatives in the memory file. Match the tone defined there.
5. Upload the CV if there is a file upload field (use cv.md as the source)
6. STOP before the final Submit / Apply button — do NOT click it
7. Show a summary of what you filled in and ask for confirmation

## Meher's Memory (initiatives, tone, standard answers)
${memory}

## Meher's CV
${cv}

## Hard rules
- Never click Submit without explicit confirmation
- Never fabricate metrics or experience not in the memory/CV above
- Never fill salary fields without asking first
- If you hit a login wall, stop and report it`;
}

// ── --list mode ─────────────────────────────────────────────────────

if (args.includes('--list')) {
  const queue   = loadQueue();
  const pending = queue.filter(j => j.status === 'pending');
  const applied = queue.filter(j => j.status === 'applied');
  const failed  = queue.filter(j => j.status === 'failed');

  console.log(`\n📋 Apply Queue\n${'─'.repeat(50)}`);
  console.log(`Pending: ${pending.length}  Applied: ${applied.length}  Failed: ${failed.length}\n`);

  if (pending.length > 0) {
    console.log('Pending:');
    pending.forEach((j, i) => console.log(`  ${i + 1}. ${j.url}`));
  } else {
    console.log('No pending jobs.');
  }
  process.exit(0);
}

// ── --clear mode ────────────────────────────────────────────────────

if (args.includes('--clear')) {
  const queue   = loadQueue();
  const cleared = queue.filter(j => j.status === 'pending').length;
  saveQueue(queue.filter(j => j.status !== 'pending'));
  console.log(`Cleared ${cleared} pending job(s).`);
  process.exit(0);
}

// ── Main: apply to all pending ──────────────────────────────────────

const queue   = loadQueue();
const pending = queue.filter(j => j.status === 'pending');

if (pending.length === 0) {
  console.log('\n✅ No pending jobs in queue.');
  console.log('   Send "apply to [URL]" in Telegram to queue jobs.\n');
  process.exit(0);
}

console.log(`\n🎯 Apply Queue — ${pending.length} job(s) to apply to`);
console.log('─'.repeat(50));
pending.forEach((j, i) => console.log(`  ${i + 1}. ${j.url}`));
console.log('─'.repeat(50));
console.log('\nStarting now. Claude will fill each form and stop before Submit.\n');

let applied = 0;
let failed  = 0;

for (const job of pending) {
  console.log(`\n${'━'.repeat(50)}`);
  console.log(`Applying to: ${job.url}`);
  console.log('━'.repeat(50) + '\n');

  const prompt = buildPrompt(job.url);

  const exitCode = await new Promise(resolve => {
    const proc = spawn(
      'claude',
      ['-p', prompt],
          { stdio: 'inherit', cwd: process.cwd() }
    );
    proc.on('close', resolve);
    proc.on('error', () => resolve(1));
  });

  if (exitCode === 0) {
    markJob(queue, job.url, 'applied');
    applied++;
    console.log(`\n✅ Done: ${job.url}`);
  } else {
    markJob(queue, job.url, 'failed');
    failed++;
    console.log(`\n❌ Failed: ${job.url}`);
  }

  saveQueue(queue);

  // Brief pause between applications
  if (pending.indexOf(job) < pending.length - 1) {
    console.log('\nStarting next job in 3 seconds...\n');
    await new Promise(r => setTimeout(r, 3_000));
  }
}

console.log(`\n${'━'.repeat(50)}`);
console.log(`Done! Applied: ${applied}  Failed: ${failed}`);
console.log('─'.repeat(50) + '\n');
