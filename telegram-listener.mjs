#!/usr/bin/env node
/**
 * telegram-listener.mjs
 *
 * Polls Telegram for "apply to [URL]" messages and adds them to the apply queue.
 * Telegram holds messages for 24h — send commands from your phone anytime,
 * even when Mac is asleep. Start this script when you open your laptop and
 * it will process everything you queued overnight.
 *
 * Usage:
 *   TELEGRAM_BOT_TOKEN=xxx TELEGRAM_CHAT_ID=xxx node telegram-listener.mjs
 *
 * Or set them in .env and run:
 *   node telegram-listener.mjs
 *
 * Supported commands (send in Telegram):
 *   apply to https://...              → queue one job
 *   apply to https://... https://...  → queue multiple jobs
 *   queue                             → show pending count
 *   clear queue                       → remove all pending jobs
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';

// ── Load .env if present ────────────────────────────────────────────
if (existsSync('.env')) {
  const lines = readFileSync('.env', 'utf-8').split('\n');
  for (const line of lines) {
    const [key, ...rest] = line.split('=');
    if (key && rest.length && !process.env[key.trim()]) {
      process.env[key.trim()] = rest.join('=').trim();
    }
  }
}

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = String(process.env.TELEGRAM_CHAT_ID || '');
const QUEUE_PATH = 'data/apply-queue.json';

if (!BOT_TOKEN || !CHAT_ID) {
  console.error('Error: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set.');
  console.error('Add them to .env or export them before running.');
  process.exit(1);
}

mkdirSync('data', { recursive: true });

// ── Queue helpers ───────────────────────────────────────────────────

function loadQueue() {
  if (!existsSync(QUEUE_PATH)) return [];
  try { return JSON.parse(readFileSync(QUEUE_PATH, 'utf-8')); }
  catch { return []; }
}

function saveQueue(queue) {
  writeFileSync(QUEUE_PATH, JSON.stringify(queue, null, 2), 'utf-8');
}

// ── Telegram helpers ────────────────────────────────────────────────

async function sendMessage(text) {
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'Markdown' }),
    });
  } catch (err) {
    console.error('Failed to send message:', err.message);
  }
}

async function getUpdates(offset) {
  const res = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${offset}&timeout=25`,
    { signal: AbortSignal.timeout(30_000) }
  );
  const data = await res.json();
  return data.result || [];
}

function extractUrls(text) {
  return [...text.matchAll(/https?:\/\/[^\s]+/g)].map(m => m[0]);
}

// ── Main loop ───────────────────────────────────────────────────────

let offset = 0;

console.log('🎯 Telegram listener running.');
console.log(`   Watching chat: ${CHAT_ID}`);
console.log('   Send "apply to [URL]" from your phone to queue jobs.');
console.log('   Press Ctrl+C to stop.\n');

async function poll() {
  while (true) {
    try {
      const updates = await getUpdates(offset);

      for (const update of updates) {
        offset = update.update_id + 1;
        const msg  = update.message;
        if (!msg) continue;

        const text   = msg.text || '';
        const fromId = String(msg.chat?.id || '');
        if (fromId !== CHAT_ID) continue;

        // ── "apply to [URLs]" ───────────────────────────────────
        if (/apply\s+to\s+/i.test(text)) {
          const urls = extractUrls(text);

          if (urls.length === 0) {
            await sendMessage('⚠️ No URL found.\nSend: `apply to https://...`');
            continue;
          }

          const queue = loadQueue();
          const added = [];
          const dupes = [];

          for (const url of urls) {
            if (queue.find(j => j.url === url)) {
              dupes.push(url);
            } else {
              queue.push({ url, added_at: new Date().toISOString(), status: 'pending' });
              added.push(url);
            }
          }

          saveQueue(queue);

          const pending = queue.filter(j => j.status === 'pending').length;
          const lines   = [];
          added.forEach((u, i) => lines.push(`${i + 1}. ${u}`));

          let reply = added.length > 0
            ? `✅ *${added.length} job(s) queued*\n\n${lines.join('\n')}\n\nQueue: *${pending} pending*\n\nOpen your laptop and run:\n\`node apply-queue.mjs\``
            : `ℹ️ All URLs already in queue (${dupes.length} duplicate${dupes.length > 1 ? 's' : ''}).\nQueue: *${pending} pending*`;

          await sendMessage(reply);
          console.log(`Queued: ${added.join(', ')}`);
        }

        // ── "queue" / "status" ─────────────────────────────────
        else if (/^(queue|status)$/i.test(text.trim())) {
          const queue   = loadQueue();
          const pending = queue.filter(j => j.status === 'pending');
          const applied = queue.filter(j => j.status === 'applied');
          const failed  = queue.filter(j => j.status === 'failed');

          const lines = pending.map((j, i) => `${i + 1}. ${j.url}`);
          const summary = pending.length > 0
            ? `*${pending.length} pending:*\n${lines.join('\n')}`
            : '_No pending jobs._';

          await sendMessage(
            `📋 *Queue status*\n\n${summary}\n\n✅ ${applied.length} applied  ❌ ${failed.length} failed`
          );
        }

        // ── "clear queue" ──────────────────────────────────────
        else if (/clear\s+queue/i.test(text)) {
          const queue = loadQueue();
          const cleared = queue.filter(j => j.status === 'pending').length;
          saveQueue(queue.filter(j => j.status !== 'pending'));
          await sendMessage(`🗑️ Cleared ${cleared} pending job(s) from queue.`);
          console.log(`Cleared ${cleared} pending jobs.`);
        }
      }
    } catch (err) {
      if (err.name !== 'TimeoutError') {
        console.error('Poll error:', err.message);
        await new Promise(r => setTimeout(r, 5_000));
      }
    }
  }
}

poll();
