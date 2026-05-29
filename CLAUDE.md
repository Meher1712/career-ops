@AGENTS.md
<!-- Add anything Claude Code specific that other agents don't need -->

## Deployment — Meher Sehgal (mehermsehgal@gmail.com)

Target: AI PM / Senior PM roles in India (Bengaluru, Mumbai, Delhi, Gurugram, Hyderabad, Pune, remote).
User is a non-developer — prefer fixes and direct action over code walkthroughs.

### Pipeline state
- `data/pipeline.md` — 206 entries, format: `- [ ] URL | Company | Role`
- Sources: greenhouse-api, ashby-api, lever-api, instahyre-api, linkedin
- 594 companies tracked in `portals.yml`

### Custom scripts (added to base career-ops)
| Script | Purpose |
|--------|---------|
| `scan-instahyre.mjs` | Instahyre public API scanner (India-specific) |
| `fix-linkedin-labels.mjs` | Fixes LinkedIn titles + posted dates from public HTML |
| `upgrade-linkedin-to-ats.mjs` | Promotes LinkedIn-found companies to ATS tracking |
| `dashboard-web/server.mjs` | Express SSE server for live scan streaming |
| `dashboard-web/index.html` | Single-page dashboard at localhost:4242 |

### Cron schedule (launchd)
- `~/Library/LaunchAgents/com.user.careerops.scan.plist` — 9am daily, full scan (ATS + Instahyre + LinkedIn)
- `~/Library/LaunchAgents/com.user.careerops.scan.evening.plist` — 6pm daily, `SKIP_LINKEDIN=1`

### LinkedIn MCP — known issues
- Package: `linkedin-scraper-mcp==4.13.0` via uvx (pinned — do NOT change to @latest, causes 37s startup timeout)
- Session profile: `~/.linkedin-mcp/profile/` (Playwright Chromium user data dir)
- Each `search_jobs` call takes 3–8 min; 7 searches per scan = up to 30 min → watchdog set to 1800s
- **Re-auth command** (run when searches time out at <10s — session expired):
  ```bash
  /Users/mehersehgal/.local/bin/uvx linkedin-scraper-mcp==4.13.0 \
    --login --no-headless \
    --user-data-dir ~/.linkedin-mcp/profile
  ```
- Sessions last weeks to months; re-auth is not needed daily

### Known issues / watch points
- Instahyre hits 429 rate limit at page 20/30 — `REQ_DELAY_MS=250ms` in `scan-instahyre.mjs`
- ~31 companies time out in ATS scan ("operation aborted") — slow Greenhouse/Lever endpoints, not a bug
- LinkedIn date bug: `main-job-card__listdate--new` (today's date) vs `main-job-card__listdate` (original) — fixed in `fix-linkedin-labels.mjs` with negative lookahead `(?!-)`
