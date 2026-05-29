#!/usr/bin/env bash
# run-scan.sh — career-ops one-shot scanner
#   Step A: free ATS scan (npm run scan)
#   Step B: LinkedIn scan via headless Claude + LinkedIn MCP
# Outputs to stdout AND tees to logs/scan-YYYY-MM-DD-HHMMSS.log.
# Last line is `SCAN_DONE before=<n> after=<n> added=<n>` for callers to parse.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Ensure uvx (LinkedIn MCP) and claude are findable under non-login shells
export PATH="$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"

LOG_DIR="$SCRIPT_DIR/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/scan-$(date +%Y-%m-%d-%H%M%S).log"
PIPELINE="$SCRIPT_DIR/data/pipeline.md"

log()  { printf '%s\n' "$*" | tee -a "$LOG_FILE"; }
header(){ log ""; log "── $* ──"; }

count_pipeline() {
  [[ -f "$PIPELINE" ]] && grep -c '^- \[' "$PIPELINE" 2>/dev/null || echo 0
}

BEFORE=$(count_pipeline)
header "career-ops scan @ $(date '+%Y-%m-%d %H:%M:%S')"
log "pipeline before: $BEFORE entries"
log "log file:        $LOG_FILE"

header "Step A — free ATS scan (npm run scan)"
if [[ "${SKIP_ATS:-0}" == "1" ]]; then
  log "Step A: skipping ATS scan (SKIP_ATS=1)"
elif ! command -v npm >/dev/null 2>&1; then
  log "ERROR: npm not on PATH; skipping Step A"
else
  npm run scan 2>&1 | tee -a "$LOG_FILE" || log "(Step A exited non-zero; continuing)"
fi

if [[ "${SKIP_INSTAHYRE:-1}" != "1" ]]; then
  header "Step A2 — Instahyre PM feed (public JSON API, no auth)"
  # Walks instahyre.com/api/v1/job_search paginated. Returns generic Indian
  # job feed (anonymous can't filter by company). We client-side filter for
  # PM titles + India locations and append unique URLs.
  if [[ -f "$SCRIPT_DIR/scan-instahyre.mjs" ]]; then
    node scan-instahyre.mjs 2>&1 | tee -a "$LOG_FILE" \
      || log "(Step A2 exited non-zero; continuing)"
  else
    log "scan-instahyre.mjs missing; skipping Step A2"
  fi
else
  log "Step A2: Instahyre disabled (SKIP_INSTAHYRE=1 default); set SKIP_INSTAHYRE=0 to re-enable"
fi

header "Step B — LinkedIn scan (claude -p, headless)"
# LinkedIn runs once per day (morning slot only) to avoid pattern-detection.
# The 6pm ATS+Instahyre re-scan is sufficient for afternoon freshness.
# SCAN_MODE=quick (set by dashboard button) → minimal 1-search Product Manager
# India past_24h scan; cron uses default (full) mode.
SCAN_MODE="${SCAN_MODE:-full}"
log "Step B: SCAN_MODE=$SCAN_MODE"
if [[ "${SKIP_LINKEDIN:-0}" == "1" ]]; then
  log "Step B: skipping LinkedIn (SKIP_LINKEDIN=1 — ATS-only slot)"
elif ! command -v claude >/dev/null 2>&1; then
  log "ERROR: claude CLI not on PATH; skipping Step B"
elif [[ ! -f "$SCRIPT_DIR/.mcp.json" ]]; then
  log "ERROR: .mcp.json missing; skipping Step B"
else
  # Quick mode: skip jitter (user is watching live), full mode: jitter to avoid bot patterns.
  if [[ "$SCAN_MODE" != "quick" ]]; then
    JITTER=$(( (RANDOM % 180) + 60 ))
    log "Step B: jitter ${JITTER}s before LinkedIn search…"
    sleep "$JITTER"
  fi
  PROMPT_TMP="$LOG_DIR/.linkedin-prompt-$$.txt"
  if [[ "$SCAN_MODE" == "quick" ]]; then
    # Quick mode (dashboard button): single Product Manager India past_24h search.
    cat > "$PROMPT_TMP" <<'QUICK_PROMPT_EOF'
You are running in headless mode for career-ops. Your single job is to
discover new LinkedIn job listings and append them to data/pipeline.md.

STRICT RULES:
- ONLY use these tools: Read, Write, Edit, mcp__linkedin__search_jobs.
  Do NOT call get_job_details, get_feed, send_message, search_people, or
  any other tool.
- Run EXACTLY ONE search:
    keywords="Product Manager", location="India", date_posted="past_24_hours",
    sort_by="date", max_pages=10
- Read data/pipeline.md first. Build a set of existing URLs (lowercased).
  Skip any candidate whose URL already exists.
- Do NOT apply a title filter (LinkedIn keyword filter is already applied).
- Location filter: discard if location clearly states a non-India country
  (e.g. "United States", "United Kingdom", "Canada", "Europe", "Singapore",
  "Australia"). Accept if location mentions India, any Indian city, or is
  blank/unclear.
- Write new entries to data/pipeline.md in batches of 5 as you find them.
  After every 5 new qualifying entries, append them immediately to
  data/pipeline.md using Edit (add lines at end).
  Format for each line (EXACTLY):
    - [ ] URL | Company | Role
  Preserve all existing lines in pipeline.md unchanged.
- ALWAYS finish with a final assistant text message — even if you added 0 entries.
  The final message MUST be a single line: "LINKEDIN_DONE added=<N>"
  where <N> is the total number of new lines you appended.
  Do NOT end on a tool call; produce that text line as your last action.
QUICK_PROMPT_EOF
  else
    # Full mode (cron): 6 searches + feed scan, with title filtering on past_week.
    cat > "$PROMPT_TMP" <<'PROMPT_EOF'
You are running in headless mode for career-ops. Your single job is to
discover new LinkedIn job listings and append them to data/pipeline.md.

STRICT RULES:
- ONLY use these tools: Read, Write, Edit, mcp__linkedin__search_jobs,
  mcp__linkedin__get_job_details, mcp__linkedin__get_feed. Do NOT call
  mcp__linkedin__send_message, mcp__linkedin__search_people, or any other tool.
- Keep LinkedIn API volume LOW. Run AT MOST these 7 searches plus 1 feed scan:
    A. PAST 24 HOURS — fresh-catch (top priority, run first; sort_by="date"):
       1. keywords="Product Manager",    location="India",     date_posted="past_24_hours", sort_by="date", max_pages=10
       2. keywords="Product Manager",    location="Bengaluru", date_posted="past_24_hours", sort_by="date", max_pages=5
       3. keywords="AI Product Manager", location="India",     date_posted="past_24_hours", sort_by="date", max_pages=3
       4. keywords="Product Owner",      location="India",     date_posted="past_24_hours", sort_by="date", max_pages=3
    B. PAST WEEK — broader sweep (max_pages=3 each):
       5. keywords="AI Product Manager", location="India", date_posted="past_week",     max_pages=3
       6. keywords="Product Owner",      location="India", date_posted="past_week",     max_pages=3
       7. keywords="Product Manager",    location="India", work_type="remote", date_posted="past_week", max_pages=3
    C. FEED SCAN — informal "we are hiring" posts (run LAST, once):
       8. mcp__linkedin__get_feed(num_posts=30)
- Do NOT call get_job_details on every match — it is expensive. Skip it entirely
  unless you cannot determine the company or role from the search result.
- Read data/pipeline.md first. Build a set of existing URLs and existing
  "company::role" keys (both lowercased). Skip any candidate whose URL OR
  company+role key already exists.

FILTERING RULES — apply differently per search group:

  GROUP A (past_24_hours searches): LinkedIn keyword filter is already applied.
  Do NOT apply a title filter — accept ALL results from these searches.
  Only location-filter: discard if location clearly states a non-India country
  (e.g. "United States", "United Kingdom", "Canada", "Europe", "Singapore", "Australia").
  Accept if location mentions India, any Indian city, or is blank/unclear.

  GROUP B (past_week searches): Apply strict title + location filter.
  Title must contain "Product Manager", "Product Owner", "AI PM", "Lead Product",
  "Principal Product", "Group Product", "Head of Product", "Founding",
  or start with "PM " or contain " PM " or end with " PM".
  Location must mention India, Bengaluru, Bangalore, Mumbai, Delhi, Gurgaon, Gurugram,
  Noida, Hyderabad, Pune, Chennai, Kolkata, or Ahmedabad, OR be "Remote, India".
  Discard if location is any non-India geography.

  GROUP C (feed scan): The get_feed tool returns sections.feed as raw text
  (posts concatenated together) plus references.feed (a list of permalinks).
  YOU DO NOT NEED grep — just READ the sections.feed text top-to-bottom and
  visually pattern-match for these hiring signals (case-insensitive):
    "we are hiring", "we're hiring", "looking for", "open role",
    "open position", "DM me", "[hiring]", "now hiring", "join our team",
    "apply at", "applications open", "join us", "we have an opening"
  For each match, extract the surrounding context (the post). Accept the
  post ONLY if BOTH:
    (a) hiring signal AND mentions Product Manager / Product Owner / PM /
        AI PM / "product role" / "product lead" in same post
    (b) mentions India, an Indian city, OR is from an India-based author
        (check name/location cues; if unclear, be liberal — better to
        include marginal posts than miss them)
  Match each accepted post to its permalink in references.feed (the URL
  closest to the post text in the feed structure).
  Format for feed entries (meta starts with "FEED:"; ALWAYS include today's
  date so the entry sorts at the top of the dashboard, not the bottom):
    - [ ] <permalink> | FEED: <author or company name> | <one-line role summary> | posted=YYYY-MM-DD
  EXAMPLE (use TODAY's actual date — get it from `date +%Y-%m-%d` mentally
  based on the current session):
    - [ ] https://www.linkedin.com/posts/jane-doe_123 | FEED: Acme Corp | Hiring Senior PM for AI team, Bengaluru | posted=2026-05-18
  If you genuinely cannot find any qualifying posts, that's fine — just
  don't add anything from feed and continue.  Do NOT skip the feed step
  entirely just because parsing is tedious.

- Write new entries to data/pipeline.md in batches of 5 as you find them — do NOT
  wait until all searches are done. After every 5 new qualifying entries, append them
  immediately to data/pipeline.md using Edit (add lines at end). This gives live
  feedback that jobs are being added. Keep a running total across batches.
  Format for each line (EXACTLY):
    - [ ] URL | Company | Role
  Preserve all existing lines in pipeline.md unchanged.
- ALWAYS finish with a final assistant text message — even if you added 0 entries.
  The final message MUST be a single line: "LINKEDIN_DONE added=<N>"
  where <N> is the total number of new lines you appended across all searches.
  Do NOT end on a tool call; you MUST produce that text line as your last action.
  If you run low on remaining turns, stop searching and print LINKEDIN_DONE immediately
  with the count so far.
PROMPT_EOF
  fi
  PROMPT=$(cat "$PROMPT_TMP")
  rm -f "$PROMPT_TMP"
  # Default timeout: full mode = 35 min (6 queries + feed); quick mode = 10 min (1 query).
  # Override via `CLAUDE_TIMEOUT_SECS=N`.
  if [[ "$SCAN_MODE" == "quick" ]]; then
    CLAUDE_TIMEOUT_SECS=${CLAUDE_TIMEOUT_SECS:-600}
  else
    CLAUDE_TIMEOUT_SECS=${CLAUDE_TIMEOUT_SECS:-2100}
  fi
  log "claude -p timeout: ${CLAUDE_TIMEOUT_SECS}s"

  # Launch claude in background so we can watchdog it.
  # `env -u CLAUDECODE` is required so the child doesn't see itself as nested
  # when this script is launched from inside another Claude Code session
  # (e.g. via the dashboard server that you started from a Claude Code terminal).
  # --output-format json: single JSON blob at exit; we parse it afterwards for
  # result text and token counts (LINKEDIN_TOKENS line for the dashboard).
  CLAUDE_JSON_TMP="$LOG_DIR/.claude-$$-out.json"
  # --max-turns 80: agent needs many turns for 6 searches + feed + batched
  #   Edits to pipeline.md + final summary. Default ~25 was too low and cut
  #   the agent off mid-task (LINKEDIN_DONE never printed in past runs).
  # --max-budget-usd 1.50: safety cap; previous 0.50 wasn't hit but bumping
  #   to leave headroom now that we allow more turns.
  env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT claude -p "$PROMPT" \
      --mcp-config .mcp.json \
      --permission-mode bypassPermissions \
      --max-turns 80 \
      --max-budget-usd 1.50 \
      --model sonnet \
      --output-format json \
      >"$CLAUDE_JSON_TMP" 2>&1 &
  CLAUDE_PID=$!
  log "LinkedIn search running (pid $CLAUDE_PID, up to ${CLAUDE_TIMEOUT_SECS}s)…"

  # Watchdog
  (
    sleep "$CLAUDE_TIMEOUT_SECS"
    if kill -0 "$CLAUDE_PID" 2>/dev/null; then
      echo "── WATCHDOG: claude -p exceeded ${CLAUDE_TIMEOUT_SECS}s, killing ──" | tee -a "$LOG_FILE"
      pkill -P "$CLAUDE_PID" 2>/dev/null
      kill -TERM "$CLAUDE_PID" 2>/dev/null
      sleep 2
      kill -KILL "$CLAUDE_PID" 2>/dev/null
    fi
  ) &
  WATCHDOG_PID=$!

  # Heartbeat: print a progress line every 30s so the dashboard console
  # doesn't appear frozen while claude runs silently in the background.
  (
    elapsed=0
    while kill -0 "$CLAUDE_PID" 2>/dev/null; do
      sleep 30
      elapsed=$(( elapsed + 30 ))
      printf "  … LinkedIn searching (%ds elapsed)\n" "$elapsed" | tee -a "$LOG_FILE"
    done
  ) &
  HEARTBEAT_PID=$!

  wait "$CLAUDE_PID" 2>/dev/null
  CLAUDE_EXIT=$?
  kill "$WATCHDOG_PID" 2>/dev/null
  kill "$HEARTBEAT_PID" 2>/dev/null
  wait "$WATCHDOG_PID" 2>/dev/null
  wait "$HEARTBEAT_PID" 2>/dev/null

  log "claude -p exited with status $CLAUDE_EXIT"

  # Parse JSON output: print result text + emit LINKEDIN_TOKENS for dashboard.
  # Also detect MCP connection failures and log a clear re-auth hint.
  if [[ -f "$CLAUDE_JSON_TMP" ]]; then
    node -e "
const fs = require('fs');
const raw = fs.readFileSync('$CLAUDE_JSON_TMP', 'utf8');
try {
  const j = JSON.parse(raw);
  if (j.result) process.stdout.write(j.result.trimEnd() + '\n');
  // Surface MCP failures as an actionable hint
  if (raw.includes('connection timed out') || raw.includes('MCP server') || (j.result || '').includes('not available')) {
    process.stdout.write('LINKEDIN_MCP_FAIL hint=\"re-run: uvx linkedin-scraper-mcp==4.13.0 --login --no-headless --user-data-dir ~/.linkedin-mcp/profile\"\n');
  }
  const u = j.usage || {};
  const inp = u.input_tokens || 0, out = u.output_tokens || 0;
  const cost = ((inp * 3 + out * 15) / 1e7).toFixed(4);
  process.stdout.write('LINKEDIN_TOKENS input=' + inp + ' output=' + out + ' cost_usd=' + cost + '\n');
} catch(e) {
  process.stdout.write(raw);
}
" | tee -a "$LOG_FILE"
    rm -f "$CLAUDE_JSON_TMP"
  fi
fi

header "Step C — verify LinkedIn labels against canonical page titles"
# The headless agent in Step B sometimes confabulates company/role/location
# from search snippets. This step re-fetches each LinkedIn URL added since
# Step B and rewrites the metadata from the page's <title> (deterministic,
# zero-token, no auth required).
if [[ -f "$SCRIPT_DIR/fix-linkedin-labels.mjs" ]]; then
  node fix-linkedin-labels.mjs 2>&1 | tee -a "$LOG_FILE" \
    || log "(Step C exited non-zero; pipeline labels may be stale)"
else
  log "fix-linkedin-labels.mjs missing; skipping Step C"
fi

header "Step D — promote LinkedIn-discovered companies to ATS tracking"
# For each unique company we found via LinkedIn that we haven't already
# tracked, probe Greenhouse/Ashby/Lever public boards. Hits get added to
# portals.yml so future free scans pull canonical job data instead of
# routing through LinkedIn each time.
if [[ "${SKIP_UPGRADE:-0}" == "1" ]]; then
  log "Step D: skipping ATS upgrade (SKIP_UPGRADE=1)"
elif [[ -f "$SCRIPT_DIR/upgrade-linkedin-to-ats.mjs" ]]; then
  node upgrade-linkedin-to-ats.mjs --from-queue 2>&1 | tee -a "$LOG_FILE" \
    || log "(Step D exited non-zero; no new ATS promotions)"
else
  log "upgrade-linkedin-to-ats.mjs missing; skipping Step D"
fi

header "Step E — Gmail inbox sync (claude -p, headless)"
# Reads inbox since last run, classifies hiring-related emails into tiers,
# updates data/applications.md (in-place edits for existing rows) and writes
# new rows as TSVs in batch/tracker-additions/ for merge-tracker.mjs to fold in.
# Ambiguous items go to data/inbox-suggestions.md for manual review.
if [[ "${SKIP_GMAIL:-0}" == "1" ]]; then
  log "Step E: skipping Gmail (SKIP_GMAIL=1)"
elif ! command -v claude >/dev/null 2>&1; then
  log "ERROR: claude CLI not on PATH; skipping Step E"
elif [[ ! -f "$SCRIPT_DIR/.mcp.json" ]]; then
  log "ERROR: .mcp.json missing; skipping Step E"
elif [[ ! -f "$HOME/.gmail-mcp/credentials.json" ]]; then
  log "Step E: gmail MCP not authorised yet; see docs/gmail-setup.md"
else
  # Morning slot looks back 26h; evening slot looks back 11h. Overlap covers
  # cron-skew without double-counting (in-place edits + dedup-by-company are idempotent).
  HOUR=$(date +%H)
  if (( 10#$HOUR < 12 )); then
    LOOKBACK_HOURS=26
  else
    LOOKBACK_HOURS=11
  fi
  log "Step E: lookback=${LOOKBACK_HOURS}h"

  GMAIL_PROMPT_TMP="$LOG_DIR/.gmail-prompt-$$.txt"
  cat > "$GMAIL_PROMPT_TMP" <<'GMAIL_EOF'
You are running in headless mode for career-ops. Your single job is to sync
hiring-related emails from Gmail into data/applications.md and related files.
Be conservative — when in doubt, queue for review.

STRICT TOOL ALLOWLIST:
- Read, Write, Edit, Bash (for `date` and `node`)
- mcp__gmail__search_emails, mcp__gmail__read_email, mcp__gmail__list_emails
- Do NOT use any send/draft/delete/label-modify Gmail tools.

STEP 1 — Load context
- Read templates/states.yml (canonical statuses).
- Read data/applications.md. Build map: lowercased-company → { row_number, role, status, notes }.
- Read data/pipeline.md (lightly — just to know which companies you've seen).

STEP 2 — Pull inbox
- Use mcp__gmail__search_emails with query: newer_than:{{LOOKBACK_HOURS}}h
- For each result, read the email (sender, subject, snippet, body up to ~2000 chars, date, has_calendar_attachment).

STEP 3 — Classify each email into ONE tier

TIER A — APPLIED CONFIRMATION (high confidence)
Triggers (any):
  - Sender domain in: greenhouse.io, lever.co, ashbyhq.com, workable.com,
    smartrecruiters.com, jobvite.com, bamboohr.com, icims.com, myworkday.com,
    successfactors.com, taleo.net, eightfold.ai, gem.com
  - Sender is jobs-noreply@linkedin.com AND subject/body contains
    "Your application was sent to" or "You applied for" or "Application sent"
  - Subject contains: "Thank you for applying", "We received your application",
    "Application received", "Application confirmation"
Extract: company (from sender domain OR subject "...applying to X" / "...at X"),
role (from subject if present, else "Unknown — confirm from email").
Action:
  - If company already has a row in applications.md with status Applied or higher
    (Responded/Interview/Offer/Rejected), skip — already tracked.
  - Else write a TSV row (format below) to batch/tracker-additions/ with status=Applied.

TIER B — INTERVIEW
Triggers:
  - Email contains a calendar attachment (.ics) from a non-personal domain.
  - Subject contains: "interview", "schedule a call", "meeting invitation",
    "calendly", "chat with", "next steps" AND sender is corporate/ATS/LinkedIn domain.
Action:
  - If company has an existing row → in-place edit applications.md, set Status=Interview,
    append " | interview scheduled YYYY-MM-DD" to Notes (date from email).
  - If no existing row → write TSV with status=Interview (cold-recruiter case).

TIER C — RESPONDED (cold recruiter outreach)
Triggers:
  - Sender from a corporate domain (not gmail.com / outlook.com / yahoo.com).
  - Body contains outreach phrasing: "open to a conversation", "exploring opportunities",
    "would love to chat", "saw your profile", "reaching out about a role".
  - You have NOT previously seen this company in applications.md.
Action: write TSV with status=Responded, note "inbound recruiter outreach".

TIER D — REJECTED
Triggers (ALL must hold):
  - Body contains a rejection phrase: "unfortunately", "not moving forward",
    "decided not to proceed", "other candidates", "regret to inform",
    "won't be progressing", "filled this role", "not selected",
    "won't be moving you forward", "decided to pursue other".
  - Sender is ATS domain, LinkedIn (jobs-noreply@linkedin.com), or a corporate domain.
  - The company ALREADY has a row in applications.md with status
    Applied / Responded / Interview. (Safety rail — do not auto-mark Rejected for
    companies you've never applied to; that's spam, not a rejection.)
  - Existing status is NOT Offer (Offer→Rejected always goes to suggestions queue).
Action: in-place edit applications.md, set Status=Rejected, append
  " | rejected YYYY-MM-DD" to Notes.

TIER E — AMBIGUOUS / SUGGESTIONS QUEUE
Anything that:
  - Mentions hiring/jobs/recruiting but doesn't match A-D cleanly
  - Is a rejection from a company NOT already tracked
  - Is from a freelance recruiter on gmail.com / outlook.com
  - Is an Offer→Rejected case (per Tier D safety rail)
  - Looks like a possible offer ("pleased to extend", "offer letter")
Action: append one line to data/inbox-suggestions.md with format:
  - [ ] {date} | {sender} | {subject} | suggested: {action}

IGNORE entirely (do not log):
  - Newsletters (Substack, Lenny's, etc.)
  - Sales pitches that mention "opportunity" but are clearly B2B
  - LinkedIn job alerts / "Jobs you may be interested in"
  - Personal email from gmail.com unless it explicitly mentions a role/interview

STEP 4 — Write changes

For TSV rows (Tier A new, B new, C):
  Path: batch/tracker-additions/gmail-{YYYY-MM-DD}-{n}-{slug}.tsv
  Format (9 tab-separated columns, one line, NO header):
    {num}\t{YYYY-MM-DD}\t{Company}\t{Role}\t{Status}\t{Score}/5\t{pdf}\t{report}\t{notes}
  Where:
    - num: next sequential number across all existing applications.md + TSVs in this run
    - Score: leave as "—/5" (unknown until evaluated)
    - pdf: ❌
    - report: — (em dash, no report yet)
    - notes: short context, e.g. "source: gmail-auto, ATS=greenhouse" or "source: gmail-auto, LinkedIn Easy Apply"

For in-place edits (Tier B existing, Tier D):
  Use Edit tool on data/applications.md. Only change the Status and Notes columns
  of the matching row. Preserve every other row exactly.
  ALWAYS first write a backup: copy data/applications.md → data/applications.md.bak

For Tier E:
  Append to data/inbox-suggestions.md (create with a header if missing):
    # Inbox suggestions — review and act on these manually
    Each line is one unresolved email worth eyeballing.

STEP 5 — After all classifications
- If you created any TSVs, run: node merge-tracker.mjs via Bash to fold them into applications.md.
- Count: A_added, B_updated, B_added, C_added, D_updated, E_suggested.
- Print EXACTLY ONE final line:
    GMAIL_DONE applied_added=A interview_updated=B1 interview_added=B2 responded_added=C rejected_updated=D suggested=E
  Print nothing else after that.

If you encounter an error reading Gmail (auth, network), print:
  GMAIL_FAIL reason="<short reason>"
and exit cleanly without touching any files.
GMAIL_EOF
  GMAIL_PROMPT=$(cat "$GMAIL_PROMPT_TMP")
  rm -f "$GMAIL_PROMPT_TMP"
  # Substitute lookback hours
  GMAIL_PROMPT="${GMAIL_PROMPT//\{\{LOOKBACK_HOURS\}\}/$LOOKBACK_HOURS}"

  GMAIL_TIMEOUT_SECS=${GMAIL_TIMEOUT_SECS:-300}
  log "claude -p timeout: ${GMAIL_TIMEOUT_SECS}s"
  GMAIL_JSON_TMP="$LOG_DIR/.gmail-$$-out.json"

  env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT claude -p "$GMAIL_PROMPT" \
      --mcp-config .mcp.json \
      --permission-mode bypassPermissions \
      --max-budget-usd 0.20 \
      --model sonnet \
      --output-format json \
      >"$GMAIL_JSON_TMP" 2>&1 &
  GMAIL_PID=$!
  log "Gmail sync running (pid $GMAIL_PID, up to ${GMAIL_TIMEOUT_SECS}s)…"

  (
    sleep "$GMAIL_TIMEOUT_SECS"
    if kill -0 "$GMAIL_PID" 2>/dev/null; then
      echo "── WATCHDOG: gmail claude -p exceeded ${GMAIL_TIMEOUT_SECS}s, killing ──" | tee -a "$LOG_FILE"
      pkill -P "$GMAIL_PID" 2>/dev/null
      kill -TERM "$GMAIL_PID" 2>/dev/null
      sleep 2
      kill -KILL "$GMAIL_PID" 2>/dev/null
    fi
  ) &
  GMAIL_WATCHDOG_PID=$!

  wait "$GMAIL_PID" 2>/dev/null
  GMAIL_EXIT=$?
  kill "$GMAIL_WATCHDOG_PID" 2>/dev/null
  wait "$GMAIL_WATCHDOG_PID" 2>/dev/null

  log "gmail claude -p exited with status $GMAIL_EXIT"

  if [[ -f "$GMAIL_JSON_TMP" ]]; then
    node -e "
const fs = require('fs');
const raw = fs.readFileSync('$GMAIL_JSON_TMP', 'utf8');
try {
  const j = JSON.parse(raw);
  if (j.result) process.stdout.write(j.result.trimEnd() + '\n');
  const u = j.usage || {};
  const inp = u.input_tokens || 0, out = u.output_tokens || 0;
  const cost = ((inp * 3 + out * 15) / 1e7).toFixed(4);
  process.stdout.write('GMAIL_TOKENS input=' + inp + ' output=' + out + ' cost_usd=' + cost + '\n');
} catch(e) {
  process.stdout.write(raw);
}
" | tee -a "$LOG_FILE"
    rm -f "$GMAIL_JSON_TMP"
  fi
fi

AFTER=$(count_pipeline)
ADDED=$(( AFTER - BEFORE ))
header "done"
log "pipeline after:  $AFTER entries"
log "added:           $ADDED"
log "SCAN_DONE before=$BEFORE after=$AFTER added=$ADDED"
