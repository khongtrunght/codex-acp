---
date: 2026-04-17
researcher: duyphung.ai@gmail.com
topic: "Hermes-agent — one concrete end-to-end example per feature"
tags: [research, hermes-agent, examples, walkthrough]
status: complete
companion_to:
  - 2026-04-17-hermes-vs-openclaw-learning-cron-delegation.md
  - 2026-04-17-hermes-vs-openclaw-ascii-atlas.md
---

# Hermes Features — One Concrete Example Each

Each section walks a realistic scenario through the real code paths, with file:line refs.

---

## EXAMPLE 1 — Agent-Curated Memory (MEMORY.md write)

**Scenario:** Chi says "btw I always deploy to staging first, never prod directly — remember that"

```
  User (Discord) ──────────────────────────────────────────────────────
      "btw I always deploy to staging first, never prod directly —
       remember that"
                                │
                                ▼
  ┌────────────────────────────────────────────────────────────────┐
  │  MAIN AGENT turn                                                │
  │                                                                 │
  │  assistant reasoning:                                           │
  │   "this is a durable user preference → save to USER.md"         │
  │                                                                 │
  │  tool_call:  memory                                             │
  │  args:                                                          │
  │    action: "add"                                                │
  │    target: "user"                                               │
  │    content: "deploys to staging first, never prod directly.     │
  │              Why: lost data once by force-pushing to prod.      │
  │              How to apply: when user says 'deploy' without      │
  │              qualifier, assume staging."                        │
  └────────────┬────────────────────────────────────────────────────┘
               │
               ▼
  ┌─ tools/memory_tool.py:463-501 ──────────────────────────────────┐
  │  handle_call(action="add", target="user", content=<entry>)       │
  │                                                                  │
  │  1. injection scan             memory_tool.py:65-102             │
  │     grep for "ignore previous", invisible unicode…               │
  │     PASS                                                         │
  │                                                                  │
  │  2. char-budget check          memory_tool.py:116                │
  │     current USER.md = 842 chars                                  │
  │     new entry       = 172 chars                                  │
  │     total           = 1014 / 1375 cap  ✓                         │
  │                                                                  │
  │  3. append to live entries (in-process)                          │
  │                                                                  │
  │  4. atomic write               memory_tool.py:432-460            │
  │     ├── fd = tempfile.mkstemp(dir=~/.hermes/memories/)           │
  │     ├── write all entries joined by "\n§\n"                      │
  │     ├── f.flush() + os.fsync(fd)                                 │
  │     ├── os.replace(tmp, USER.md)                                 │
  │     └── os.chmod(USER.md, 0o600)                                 │
  │                                                                  │
  │  5. fcntl.flock released                                         │
  │                                                                  │
  │  6. return "✓ Added to USER.md"                                  │
  └──────────────────────────┬───────────────────────────────────────┘
                             │
                             │ BUT: _system_prompt_snapshot UNCHANGED
                             │ (prefix cache stays hot — next turn
                             │  still uses frozen snapshot)
                             ▼
                    ┌──────────────────────┐
                    │ memory_manager       │
                    │  .on_memory_write(   │
                    │    "add", "user",    │
                    │    <content>)        │
                    │  run_agent.py:7858   │
                    └──────────┬───────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │  Honcho plugin sees  │
                    │  the write, updates  │
                    │  its own dialogical  │
                    │  model of Chi        │
                    └──────────────────────┘

  Assistant ──► user: "Got it, locked in: staging-first, always."

  ── NEXT SESSION ────────────────────────────────────────────────
  Chi: "deploy the auth service"
       │
       ▼
  load USER.md on boot → snapshot now contains the preference
       │
       ▼
  agent defaults to `staging`, no re-asking
```

---

## EXAMPLE 2 — Periodic Nudge → Background Skill Creation

**Scenario:** Chi spent 40 minutes debugging a weird Docker DNS issue. Trial and error, eventually solved by setting `--dns 8.8.8.8` on container startup.

```
  TURN 1..N  (main conversation)
  ──────────
  Chi: "my container can't reach postgres.foo.internal"
  Agent: runs terminal… docker inspect… nslookup… edits compose…
         [30 tool calls over 40 min]
  Agent: "fixed — needed --dns 8.8.8.8 because corp DNS blocks
         .internal resolution inside bridge network"
  Chi:   "nice, thanks"

                    _iters_since_skill reaches 10 ✓

  ── end of Chi's turn ─────────────────────────────────────────────
     run_agent.py:11319
       _should_review_skills = True
       _iters_since_skill = 0
       │
       ▼
     run_agent.py:11338  →  _spawn_background_review(
                               messages_snapshot=msgs,
                               review_memory=False,
                               review_skills=True)
       │
       │   (daemon thread starts; main loop returns response to Chi)
       ▼

   ╔════════════ BACKGROUND REVIEW AGENT ════════════╗
   ║  run_agent.py:2375-2474                          ║
   ║                                                  ║
   ║  AIAgent(                                        ║
   ║    model=same as parent,                         ║
   ║    quiet_mode=True,       ◄── no spinner         ║
   ║    _memory_nudge_interval=0,  ◄── no recursion   ║
   ║    _skill_nudge_interval=0,                      ║
   ║    max_iterations=8)                             ║
   ║                                                  ║
   ║  input messages:                                 ║
   ║    [ ... entire conversation history ... ]       ║
   ║    user: <_SKILL_REVIEW_PROMPT>                  ║
   ║      run_agent.py:2351-2359                      ║
   ║                                                  ║
   ║      "Review the conversation above and consider ║
   ║       saving or updating a skill if appropriate. ║
   ║       Focus on: non-trivial approach, trial and  ║
   ║       error, experiential findings…"             ║
   ║                                                  ║
   ║  review-agent reasoning:                         ║
   ║    "this Docker DNS thing is reusable. No        ║
   ║     existing skill matches. Create one."         ║
   ║                                                  ║
   ║  tool_call: skill_manage                         ║
   ║    action: "create"                              ║
   ║    category: "devops"                            ║
   ║    name: "docker-internal-dns-fix"               ║
   ║    content: <<<                                  ║
   ║      ---                                         ║
   ║      name: docker-internal-dns-fix               ║
   ║      description: Fix .internal DNS resolution   ║
   ║        failures inside docker bridge networks    ║
   ║      version: 1.0.0                              ║
   ║      platforms: [linux, macos]                   ║
   ║      metadata:                                   ║
   ║        hermes:                                   ║
   ║          tags: [docker, dns, networking]         ║
   ║      ---                                         ║
   ║                                                  ║
   ║      # Trigger                                   ║
   ║      When a container can't resolve              ║
   ║      *.internal hostnames but the host can.      ║
   ║                                                  ║
   ║      # Diagnosis                                 ║
   ║      1. docker exec <c> nslookup X → fails       ║
   ║      2. docker inspect <c> | grep Dns → empty    ║
   ║         or points to 127.0.0.11                  ║
   ║      3. Host /etc/resolv.conf shows corp DNS     ║
   ║         that bridge network doesn't inherit      ║
   ║                                                  ║
   ║      # Fix                                       ║
   ║      Add to docker-compose.yml service:          ║
   ║      ```yaml                                     ║
   ║      dns:                                        ║
   ║        - 8.8.8.8                                 ║
   ║        - <corp-dns-ip>                           ║
   ║      ```                                         ║
   ║      or run with --dns 8.8.8.8                   ║
   ║    >>>                                           ║
   ╚══════════════════════════════════════════════════╝
                         │
                         ▼
   ┌── tools/skill_manager_tool.py:304-358 ─────────┐
   │ validate frontmatter  (name ≤ 64, desc ≤ 1024) │
   │ check name collision in ~/.hermes/skills/       │
   │ mkdir -p ~/.hermes/skills/devops/               │
   │                docker-internal-dns-fix/         │
   │ atomic write SKILL.md                           │
   │ security scan (source="agent-created")          │
   │   tirith/scan_skill → PASS                      │
   │ return success                                  │
   └──────────────────────┬──────────────────────────┘
                          │
                          ▼
   ┌─────────────────────────────────────────────────┐
   │ parent's stdout (above spinner):                │
   │                                                 │
   │   💾 Skill 'docker-internal-dns-fix' created.   │
   │                                                 │
   │ Chi sees it 8 seconds after getting the reply,  │
   │ no interaction required.                        │
   └─────────────────────────────────────────────────┘

  ── TWO WEEKS LATER ───────────────────────────────────────────────
  Chi: "container can't reach metrics.foo.internal"
  Agent (main): inspects skills list → matches skill by tag
                → follows exact diagnosis steps → fix in 90s
```

---

## EXAMPLE 3 — Skill Self-Patch During Use

**Scenario:** The same skill worked on Linux but Chi's new Macbook uses Docker Desktop which handles DNS differently. Skill says `--dns 8.8.8.8` but that corrupts Docker Desktop's vpnkit DNS.

```
  Chi (macOS):  "container can't reach api.foo.internal"
  Agent: [loads docker-internal-dns-fix skill]
         applies --dns 8.8.8.8
         runs test → now EVEN BROKER, host DNS also failing
         diagnoses → Docker Desktop vpnkit issue
         fixes properly by using host.docker.internal routing

  Chi: "worked, great"

  ── nudge cycle fires eventually ──────────────────────────────────

  review agent sees: skill was USED and partially FAILED on macos.
  review prompt: "If you used a skill and hit issues not covered
                  by it, patch it immediately."

  review agent decides: PATCH (not rewrite, not delete)

  tool_call: skill_manage
    action:  "patch"
    skill:   "docker-internal-dns-fix"
    old_string: |
      # Fix
      Add to docker-compose.yml service:
      ```yaml
      dns:
        - 8.8.8.8
    new_string: |
      # Fix (Linux)
      Add to docker-compose.yml service:
      ```yaml
      dns:
        - 8.8.8.8

      # Fix (macOS — Docker Desktop)
      DO NOT use --dns 8.8.8.8; it breaks vpnkit routing.
      Instead, use host.docker.internal:
      ```yaml
      extra_hosts:
        - "api.foo.internal:host-gateway"
      ```

                   │
                   ▼
  ┌── skill_manager_tool.py:397-485 ──────────────┐
  │ load existing SKILL.md                         │
  │ fuzzy_match(old_string, content)               │
  │   ├─ exact match?  no (trailing whitespace)    │
  │   ├─ normalize whitespace & retry              │
  │   └─ match at offset 412                       │
  │ splice in new_string                           │
  │ re-validate frontmatter                        │
  │ security scan the patched version              │
  │ atomic write                                   │
  │ return "✓ patched"                             │
  └────────────────────────────────────────────────┘

  Chi's terminal shows:
    💾 Skill 'docker-internal-dns-fix' patched.

  ── skill is now OS-aware. Never fails that way again. ────────
```

---

## EXAMPLE 4 — FTS5 Session Search with LLM Summary

**Scenario:** Chi: "what was that redis eviction trick we figured out last month?"

```
  Chi: "what was that redis eviction trick we figured out last month?"
       │
       ▼
  agent reasoning: query is vague ("last month"), fuzzy ("trick") →
                   session_search is the right tool
       │
       ▼
  tool_call: session_search
    query:        "redis eviction"
    role_filter:  null
    limit:        3

       │
       ▼
  ┌── tools/session_search_tool.py:297-489 ──────────────────────┐
  │                                                               │
  │  Step 1: FTS5 match                                           │
  │  ─────────────────                                            │
  │    db.search_messages("redis eviction")                       │
  │                                                               │
  │    ┌─ internally: ─────────────────────────────────────────┐  │
  │    │ SELECT session_id, role, content,                     │  │
  │    │   bm25(messages_fts) AS rank                          │  │
  │    │ FROM messages_fts                                     │  │
  │    │ WHERE messages_fts MATCH 'redis eviction'             │  │
  │    │ ORDER BY rank                                         │  │
  │    │ LIMIT 50                                              │  │
  │    └───────────────────────────────────────────────────────┘  │
  │                                                               │
  │    hits: 23 messages across 6 sessions                        │
  │                                                               │
  │  Step 2: group by session, skip current lineage               │
  │  ────────────────────────────────────────────                 │
  │    skip: current session_id + its ancestor chain              │
  │    score: max bm25 per session                                │
  │    top 3:                                                     │
  │      session_id=s_0318_ops_debug   (7 hits, 2026-03-18)      │
  │      session_id=s_0402_infra_mtg   (4 hits, 2026-04-02)      │
  │      session_id=s_0226_prod_issue  (3 hits, 2026-02-26)      │
  │                                                               │
  │  Step 3: per session, load conversation centered on matches   │
  │  ───────────────────────────────────────────────────────────  │
  │    load all messages for session                              │
  │    truncate to 100k chars centered on first match             │
  │                                                               │
  │  Step 4: summarize each (PARALLEL)                            │
  │  ─────────────────────────────────                            │
  │    async.gather(                                              │
  │      summarize(s_0318_ops_debug,   query),                    │
  │      summarize(s_0402_infra_mtg,   query),                    │
  │      summarize(s_0226_prod_issue,  query))                    │
  │                                                               │
  │    each call:                                                 │
  │      model = Gemini Flash                                     │
  │      task  = "session_search"                                 │
  │      prompt:                                                  │
  │        "Summarize this conversation with focus on 'redis      │
  │         eviction'. Preserve technical details, commands,      │
  │         config values. Skip small talk."                      │
  │      max_tokens: 10_000                                       │
  │                                                               │
  └────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼

  tool result returned to main agent:

  [
    {
      "session_id": "s_0318_ops_debug",
      "title": "Prod Redis OOM",
      "when": "2026-03-18",
      "cost_usd": 0.41,
      "summary": "Redis at 14GB was evicting hot session keys.
                  We switched maxmemory-policy from allkeys-lru
                  to volatile-lru + added TTLs to rate-limit
                  keys (they were unbounded). CONFIG SET
                  maxmemory-policy volatile-lru, then
                  CONFIG REWRITE. Also noted that noeviction is
                  dangerous for user-facing caches — use
                  allkeys-lfu if you can't add TTLs."
    },
    {
      "session_id": "s_0402_infra_mtg",
      "title": "Cache sizing for checkout",
      "when": "2026-04-02",
      "summary": "Discussed eviction policies conceptually…"
    },
    {...}
  ]

                           │
                           ▼
  agent synthesizes reply to Chi:

    "March 18th — you switched maxmemory-policy from
     allkeys-lru to volatile-lru because hot rate-limit
     keys had no TTL and were getting evicted along with
     cold ones. Fix was:
       1. add TTLs to rate-limit keys
       2. CONFIG SET maxmemory-policy volatile-lru
       3. CONFIG REWRITE
     Also noted: for a pure read cache where you can't
     add TTLs, use allkeys-lfu not allkeys-lru.

     Want me to pull up the exact redis-cli commands?"
```

---

## EXAMPLE 5 — Scheduled Automation (Daily Report with Script)

**Scenario:** Chi: "every weekday 9am, analyze yesterday's error logs and send me a summary to #oncall on discord"

```
  ── creation ───────────────────────────────────────────────────────
  Chi (via Discord #dev-chi):
    "every weekday 9am, analyze yesterday's error logs from
     prod-k8s and send me a summary to #oncall on discord.
     Use the log-fetcher script to pull them first."

        │
        ▼
  agent understands, drafts tool call:

    tool_call: cronjob
    args:
      action:  "create"
      name:    "Daily Prod Error Summary"
      prompt:  "Analyze yesterday's errors from prod-k8s. Group
                by service, count occurrences, identify new error
                signatures (not seen in the last 7 days), and
                output a concise markdown report. If zero errors,
                respond with exactly [SILENT]."
      schedule: "0 9 * * 1-5"
      skills:  ["log-triage"]
      script:  "fetch_yesterday_logs.py"    ◄── lives under
                                                ~/.hermes/scripts/
      deliver: "discord:#oncall"

        │
        ▼
  ┌── tools/cronjob_tools.py:221-290 ────────────────────────────┐
  │  security scan the PROMPT: no injection patterns     PASS    │
  │  validate script path:                                       │
  │    - relative ✓                                              │
  │    - resolves under ~/.hermes/scripts/ ✓            PASS    │
  │  capture origin from gateway context:                        │
  │    platform="discord", chat_id="#dev-chi",                  │
  │    thread_id=None                                            │
  │  (but deliver="discord:#oncall" overrides origin at run-time)│
  └──────────────────────┬───────────────────────────────────────┘
                         │
                         ▼
  ┌── cron/jobs.py:349-365 ──────────────────────────────────────┐
  │  generate id = "a1b2c3d4e5f6"                                │
  │  parse_schedule("0 9 * * 1-5")                               │
  │    → validate via croniter → OK                              │
  │    → {kind: "cron", expr: "0 9 * * 1-5",                     │
  │       display: "0 9 * * 1-5"}                                │
  │  compute next_run_at                                         │
  │    today is Fri 2026-04-17 14:30 → next = Mon 2026-04-20 09:00│
  │  atomic write to ~/.hermes/cron/jobs.json (0600)             │
  └──────────────────────┬───────────────────────────────────────┘

  Chi gets: "✓ Scheduled 'Daily Prod Error Summary'.
             Next run: Mon 2026-04-20 09:00 → discord:#oncall"

  ══════════════════════════════════════════════════════════════

  ── Monday 2026-04-20, 09:00:00 ──────────────────────────────────

  gateway tick (every 60s) at 09:00:03
    gateway/run.py:9577 → cron_tick()
      cron/scheduler.py:909
      get_due_jobs() → [a1b2c3d4e5f6]
      advance_next_run("a1b2c3d4e5f6")
        → next_run_at = 2026-04-21 09:00  (tomorrow, cron-computed)
      run_job(job)
        │
        ▼
     ┌─ _build_job_prompt ─ scheduler.py:490-577 ─────────────────┐
     │                                                             │
     │ 1. run ~/.hermes/scripts/fetch_yesterday_logs.py             │
     │    (timeout 120s, stdout captured)                          │
     │    stdout = <JSON with 2,143 log lines across 8 services>   │
     │                                                             │
     │ 2. load skill 'log-triage'                                  │
     │    SKILL.md content                                         │
     │                                                             │
     │ 3. final prompt to agent:                                   │
     │                                                             │
     │    [SYSTEM: scheduled cron job. Your final response is      │
     │     auto-delivered. Do NOT use send_message. Respond        │
     │     "[SILENT]" to suppress delivery.]                       │
     │                                                             │
     │    [SYSTEM: user invoked skill 'log-triage']                │
     │    <skill body…>                                            │
     │                                                             │
     │    ## Script Output                                         │
     │    ```stdout                                                │
     │    <2143 lines of JSON log data>                            │
     │    ```                                                      │
     │                                                             │
     │    Analyze yesterday's errors from prod-k8s. Group by       │
     │    service, count occurrences, identify new error           │
     │    signatures (not seen in the last 7 days), and output     │
     │    a concise markdown report. If zero errors, respond       │
     │    with exactly [SILENT].                                   │
     └─────────────────────────────────────────────────────────────┘
        │
        ▼
     AIAgent spun up with:
       disabled_toolsets = {cronjob, messaging, clarify}
       skip_context_files = True
       skip_memory        = True
       platform           = "cron"
       session_id         = "cron_a1b2c3d4e5f6_20260420_090003"
       inactivity timeout = 600s

     agent runs 14 tool calls (parse, dedupe, compare to last-7-days,
     render markdown) in 47 seconds. Produces:

        # Prod errors — Fri 2026-04-17

        **Total:** 2,143 errors across 8 services.

        | Service | Count | Status |
        |---------|-------|--------|
        | auth-svc | 1,241 | known (rate-limit 429s) |
        | payments | 412 | known (stripe webhook retries) |
        | search   | 87 | 🆕 new signature |
        | …        | … | … |

        ## 🆕 New signatures worth looking at
        - `search/embed.go:142  panic: vector dim mismatch 768 vs 1536`
          (first seen 2026-04-17 22:14, 87 occurrences)
          Likely cause: model upgrade without reindex.
        …
        │
        ▼
     save to ~/.hermes/cron/output/a1b2c3d4e5f6/2026-04-20_09-00-03.md
        │
        ▼
    ┌─ _deliver_result (scheduler.py:201-368) ───────────────┐
    │                                                         │
    │ check first chars: not "[SILENT]"  → deliver            │
    │                                                         │
    │ resolve_delivery_target(deliver="discord:#oncall")      │
    │   → parse → {platform: "discord", name: "#oncall"}      │
    │   → resolve_channel_name → {chat_id: "934821...00"}     │
    │                                                         │
    │ no MEDIA: tags in output → text-only send               │
    │                                                         │
    │ gateway running?  yes                                   │
    │   → live discord adapter                                │
    │   → wraps output:                                       │
    │                                                         │
    │     Cronjob Response: Daily Prod Error Summary          │
    │     (job_id: a1b2c3d4e5f6)                              │
    │     ─────────────                                       │
    │     # Prod errors — Fri 2026-04-17                      │
    │     …                                                   │
    │     To stop/manage this job, send me a message.         │
    │                                                         │
    │   → adapter.send("#oncall", text, timeout=60s)          │
    │   → success                                             │
    └─────────────────────────────────────────────────────────┘
        │
        ▼
    mark_job_run(success=True, error=None)
      repeat.completed += 1
      next_run_at already set → nothing more to compute
      state = "scheduled"
      save atomically

  ══════════════════════════════════════════════════════════════

  ── Saturday + Sunday ────────────────────────────────────────────
  cron expr "0 9 * * 1-5" skips weekends automatically.

  ── Tuesday (gateway was down Mon night → Tue 10:30 boot) ────────
  tick fires at 10:30:08
    get_due_jobs sees next_run_at = Tue 09:00  → (past, missed by 90min)
    fast-forward check: grace = clamp(period/2, 120s, 2h)
      period = 1440 min (daily) → period/2 = 12h → clamp → 2h
      now - next_run = 90min  < 2h  → STILL ELIGIBLE, do not skip
    runs job, reports Tue 09:00's missed summary
    advance → Wed 09:00

  ── If gateway had been down 3 hours → (now - next_run) > 2h ─────
  → fast-forward to Wed 09:00, skip Tue to avoid burst / stale data.
```

---

## EXAMPLE 6 — Delegation (Parallel Fan-Out)

**Scenario:** Chi: "search github for the top 5 Go projects that use sqlx, for each read their README and migration docs, summarize how each handles schema migrations"

```
  Chi: [above prompt]
       │
       ▼
  agent reasoning:
    "5 independent research tasks. Parallelize with delegate_task.
     Each child reads multiple docs — many tool calls, but only the
     summary needs to come back."

  tool_call: delegate_task
    tasks: [
      {goal: "Research github.com/X/app — how it uses sqlx for
              migrations. Read README + docs/*. Return: approach,
              migration tool, any gotchas. <300 words."},
      {goal: "Research github.com/Y/api — ..."},
      {goal: "Research github.com/Z/svc — ..."},
      {goal: "Research github.com/A/bot — ..."},
      {goal: "Research github.com/B/job — ..."}
    ]
    max_children: 3   ◄── config default

       │
       ▼
  ┌── tools/delegate_tool.py:238-397 ──────────────────────────┐
  │ depth check: parent._delegate_depth = 0, OK (max 2)         │
  │                                                             │
  │ for each task:                                              │
  │   _build_child_agent:                                       │
  │     task_id = f"delegate_{uuid}"  (own terminal sandbox)    │
  │     child_toolsets = parent_toolsets                        │
  │                       - {delegate_task, clarify, memory,    │
  │                          send_message, execute_code}        │
  │     credential = pool.lease()  (rotating OpenRouter key)    │
  │     model_override = "anthropic/claude-haiku-4-5"           │
  │                      (cheaper for bulk web work)            │
  │     ephemeral_system_prompt = <focused goal prompt>         │
  │     AIAgent(skip_memory=True, skip_context_files=True,      │
  │             parent_session_id=…, _delegate_depth=1)         │
  └─────────────────────────┬───────────────────────────────────┘
                            │
                            ▼
   ┌── ThreadPoolExecutor(max_workers=3) ───────────────────────┐
   │                                                            │
   │    T=0s    ┌──────┐  ┌──────┐  ┌──────┐                   │
   │            │ ch 0 │  │ ch 1 │  │ ch 2 │ running            │
   │            │  X   │  │  Y   │  │  Z   │                   │
   │            └──────┘  └──────┘  └──────┘                   │
   │                                                            │
   │    T=12s   ch 1 finishes (12 tool calls, 28s wall? no…)   │
   │            executor submits ch 3 to freed slot             │
   │                                                            │
   │            ┌──────┐  ┌──────┐  ┌──────┐                   │
   │            │ ch 0 │  │ ch 3 │  │ ch 2 │                   │
   │            │  X   │  │  A   │  │  Z   │                   │
   │            └──────┘  └──────┘  └──────┘                   │
   │                                                            │
   │    T=18s   ch 0 done → ch 4 starts                         │
   │    T=24s   ch 2 done                                       │
   │    T=31s   ch 3 done                                       │
   │    T=42s   ch 4 done                                       │
   │                                                            │
   │    MEANWHILE, every 500ms:                                 │
   │      parent polls futures + checks interrupt flag          │
   │      heartbeat thread touches parent activity (so          │
   │      gateway inactivity timeout doesn't fire on 42s)       │
   │      delegate_tool.py:437-469                              │
   │                                                            │
   │    Progress line printed above spinner after each:         │
   │      ✓ [1/5] research-Y  (12s)                             │
   │      ✓ [2/5] research-X  (18s)                             │
   │      …                                                     │
   └────────────────────────┬───────────────────────────────────┘
                            │
                            ▼
   aggregate result JSON (delegate_tool.py:549-853):

   {
     "results": [
       {
         "task_index": 0,
         "status": "completed",
         "summary": "X uses goose for migrations, invokes from
                     main() before server boot. sqlx used only
                     for query exec, not schema. Gotcha: …",
         "api_calls": 14,
         "duration_seconds": 18.2,
         "model": "anthropic/claude-haiku-4-5",
         "exit_reason": "completed",
         "tokens": {"input": 38412, "output": 4120},
         "tool_trace": [ … 14 entries … ]
       },
       { "task_index": 1, …Y… },
       { "task_index": 2, …Z… },
       { "task_index": 3, …A… },
       { "task_index": 4, …B… }
     ],
     "total_duration_seconds": 42.7
   }

                            │
                            ▼
   parent's context received just this ONE tool result.
   The 70+ internal tool calls across the 5 children:
   ──► NEVER entered parent's context window. ◄──

   memory_manager.on_delegation(task, summary, child_session_id)
     × 5 → Honcho plugin sees the research events too.

                            │
                            ▼
   parent agent synthesizes the final comparison table and
   writes the reply — one pass over 5 compact summaries.
```

---

## EXAMPLE 7 — RPC Tool Gateway (Script collapses 100 calls → 1 turn)

**Scenario:** Chi: "scrape the top HN stories from the last 7 days, dedupe by domain, fetch each URL, extract the title + first paragraph, save as CSV".

```
  Agent decides: this is a loop over ~200 items. If I do 200 tool
                 calls from the LLM, that's 200 round-trips + huge
                 context. Write a Python script instead — one turn.

  tool_call: execute_code
    language: python
    code: <see below>

  ══════════════════════════════════════════════════════════════════

  PARENT PROCESS (local backend, TERMINAL_ENV=local)
  ──────────────────────────────────────────────────
  code_execution_tool.py:205-425

  1. generate hermes_tools.py stub in workdir:       (:130-162)

     # ~/.hermes/tasks/<id>/hermes_tools.py
     import socket, os, json
     _SOCK = os.environ["HERMES_RPC_SOCK"]

     def _call(tool, args):
       s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
       s.connect(_SOCK)
       s.sendall((json.dumps({"tool":tool,"args":args})+"\n").encode())
       buf = b""
       while not buf.endswith(b"\n"):
         buf += s.recv(4096)
       s.close()
       return json.loads(buf.decode().strip())

     def web_search(query, limit=5):
       return _call("web_search", {"query": query, "limit": limit})
     def web_extract(url):
       return _call("web_extract", {"url": url})
     def read_file(path): return _call("read_file", {"path": path})
     def write_file(path, content):
       return _call("write_file", {"path": path, "content": content})
     def search_files(pattern, path="."):
       return _call("search_files", {"pattern": pattern, "path": path})
     def patch(path, old, new):
       return _call("patch", {"path": path, "old_string": old,
                              "new_string": new})
     def terminal(cmd, timeout=30):
       return _call("terminal", {"cmd": cmd, "timeout": timeout})

  2. open UDS server on $HERMES_RPC_SOCK          (:979-981)
     server_sock = socket.socket(AF_UNIX, SOCK_STREAM)
     server_sock.bind("/tmp/hermes_rpc_<uuid>.sock")
     server_sock.listen(1)

  3. start _rpc_server_loop in background thread   (:307-425)

  4. exec script as subprocess with env:
       HERMES_RPC_SOCK=/tmp/…
       max_tool_calls=200  (budget)

  ══════════════════════════════════════════════════════════════════

  SCRIPT (runs as normal python subprocess, NOT in LLM):

  from hermes_tools import web_search, web_extract, write_file
  from urllib.parse import urlparse
  import csv, io

  # 1 RPC call
  hits = web_search("site:news.ycombinator.com top stories last 7 days",
                    limit=50)

  urls = list({h["url"] for h in hits["data"]["web"]})
  seen_domains = set()
  rows = []

  for url in urls:
      domain = urlparse(url).netloc
      if domain in seen_domains:
          continue
      seen_domains.add(domain)

      try:
          # 1 RPC call per URL
          content = web_extract(url)
      except Exception as e:
          rows.append([url, "", f"ERROR: {e}"])
          continue

      text = content["data"]["content"]
      title = content["data"].get("title", "")
      para  = next((line for line in text.split("\n\n")
                    if len(line) > 100), "")[:500]
      rows.append([url, title, para])

  buf = io.StringIO()
  w = csv.writer(buf)
  w.writerow(["url", "title", "first_para"])
  w.writerows(rows)

  # 1 RPC call
  write_file("/tmp/hn_7d.csv", buf.getvalue())

  print(f"DONE: {len(rows)} rows → /tmp/hn_7d.csv")

  ══════════════════════════════════════════════════════════════════

  RPC SERVER (parent-side, running in background thread)
  ──────────────────────────────────────────────────────
  for each incoming request on socket:

    ── allow-list ──
    tool in {web_search, web_extract, read_file, write_file,
             search_files, patch, terminal}  ✓

    ── budget ──
    tool_call_counter[0] += 1
    if > 200 → return {"error": "budget exceeded"}

    ── sanitize (if terminal) ──
    strip: background, pty, notify_on_complete, watch_patterns

    ── dispatch (same as agent tool calls) ──
    result = handle_function_call(tool, args, task_id=<id>)
    conn.sendall((json.dumps(result) + "\n").encode())

  ══════════════════════════════════════════════════════════════════

  What the LLM actually saw:

    TURN N:
      tool_call: execute_code(…)
      tool_result: "DONE: 34 rows → /tmp/hn_7d.csv\n" (1 line stdout)

  What actually happened:
      83 tool calls (1 search + 81 extracts + 1 write)
      ~7 minutes wall clock
      ~140K tokens of HTML processed ── ALL OUTSIDE the LLM context.

  ══════════════════════════════════════════════════════════════════

  Remote backend variant (TERMINAL_ENV=docker or modal):
    same script, same hermes_tools.py, but _call() writes
    to $RPC_DIR/req_NNNNNN instead of UDS. Parent polling
    thread watches $RPC_DIR with `ls`, reads, dispatches,
    writes $RPC_DIR/res_NNNNNN. Same allow-list + budget.
    Script's adaptive backoff: 50ms → 250ms poll.
    code_execution_tool.py:248-704
```

---

## EXAMPLE 8 — Honcho Dialectic User Model (cross-session drift)

**Scenario:** Over a week, Chi complains 3 times about being over-explained to.

```
  Session 1, Tue
  ──────────────
  Agent: "I'll now walk you through each step. First, we run git
          status, which shows the working tree state. Then…"
  Chi:   "dude i know git, just do it"

  Session 3, Thu
  ──────────────
  Agent: "To add a dependency, we use npm install. The package
          manager will resolve…"
  Chi:   "pls stop explaining basics"

  Session 5, Sat
  ──────────────
  Agent: "First let me explain what rebase does conceptually…"
  Chi:   "jfc just rebase"

  ══════════════════════════════════════════════════════════════════

  What Honcho observed (via memory_provider hooks):
  ─────────────────────────────────────────────────

    on_turn_start(message=<chi's corrections>)
        agent/memory_provider.py:22
    sync_turn(user, assistant)  after every turn
    on_memory_write(...)  if agent wrote anything

    Honcho runs its own mini-pipeline:
      extract: sentiment = irritation
      extract: pattern = "corrects when over-explained"
      dialectic: compare to its prior model of Chi
                 → promote hypothesis "prefers terse answers"
                 → confidence 0.62 → 0.78 → 0.91 (over 3 sessions)
      persist in Honcho's own backend

  Session 7, Mon (no new user complaint yet)
  ──────────────────────────────────────────
  SESSION START:
    memory_manager.initialize_all()
    memory_manager.build_system_prompt()  run_agent.py:3444

    returns merged block:
      [BUILTIN]
        MEMORY.md content (frozen snapshot)
        USER.md content
      [HONCHO]
        Inferred user preferences (confidence ≥ 0.8):
        - Prefers terse replies; do NOT over-explain basics
          assumed known.
        - Responds to push-back bluntly; don't apologize,
          just correct course.

  Chi: "rebase feature-x onto main"

  Agent (main, system prompt now includes Honcho block):
    [reasoning suppressed]
    reply: "git checkout feature-x && git rebase main"
    (no preamble, no explanation)

  Chi: "ok"  ← no correction → Honcho raises confidence

  ══════════════════════════════════════════════════════════════════

  The closed-loop part:

    • Builtin MEMORY.md/USER.md = agent's explicit curation (fast).
    • Honcho user-model          = silent pattern inference over
                                   dialogue (slow, high-confidence).

  Both feed the prompt at session start, and both observe:
    - every turn (sync_turn)
    - every memory write (on_memory_write)
    - every delegation (on_delegation)
    - session end (on_session_end)
    - pre-compression (on_pre_compress)

  memory_provider.py:16-31 lists all 10 hook points.
```

---

## EXAMPLE 9 — [SILENT] Suppression (cron no-news quiet day)

**Scenario:** Same daily error report, but today there were genuinely zero new-or-noteworthy errors.

```
  Wed 09:00 tick fires daily-error-summary job.

  Script runs fetch_yesterday_logs.py → stdout = "<null>" or tiny
  JSON with all known-benign errors.

  Agent processes:
    - total errors: 812 (all known categories)
    - new signatures: 0
    - anomalies: 0

  Agent output:
    [SILENT]

  ┌── cron/scheduler.py:_deliver_result ───────────────────────┐
  │                                                             │
  │ final_response.upper().startswith("[SILENT]")  → True       │
  │                                                             │
  │ skip delivery:                                              │
  │   • no Discord message sent                                 │
  │   • no notification                                         │
  │                                                             │
  │ STILL save output to:                                       │
  │   ~/.hermes/cron/output/a1b2c3d4/2026-04-22_09-00-03.md     │
  │   (auditable — Chi can grep it later if needed)             │
  │                                                             │
  │ mark_job_run(success=True, error=None,                      │
  │              delivery_error=None)                           │
  └─────────────────────────────────────────────────────────────┘

  Chi's Discord #oncall is quiet. No notification fatigue.
  Next news-worthy morning: delivery resumes automatically.
```

---

## EXAMPLE 10 — MEDIA: Tags (chart PDF delivered natively)

**Scenario:** Weekly "revenue digest" cron job that renders a chart PNG and attaches it to Telegram.

```
  Cron job fires Sun 20:00. Prompt tells agent to:
    1. query revenue db
    2. generate chart.png with matplotlib
    3. write short narrative
    4. include MEDIA: tag for the chart

  agent's tools include execute_code, write_file, terminal.
  after running the pipeline, agent outputs:

  ──────────────────────────────────────────────
  # Week 16 Revenue Digest

  Revenue was up 4.2% WoW, driven mostly by the US-east region.
  Two new enterprise deals closed on Fri.

  MEDIA: /tmp/hermes_out/week16_chart.png
  MEDIA: /tmp/hermes_out/week16_table.pdf

  See chart for the breakdown.
  ──────────────────────────────────────────────

  ┌── cron/scheduler.py:163-199 ─ extract MEDIA ──────────────┐
  │                                                            │
  │ scan output for lines matching ^MEDIA:\s*(\S+)$           │
  │                                                            │
  │ collected_paths = [                                        │
  │   "/tmp/hermes_out/week16_chart.png",                      │
  │   "/tmp/hermes_out/week16_table.pdf"                       │
  │ ]                                                          │
  │                                                            │
  │ route each by extension:                                   │
  │   .png  → adapter.send_image_file(chat_id, path)          │
  │   .pdf  → adapter.send_document(chat_id, path)            │
  │                                                            │
  │ clean text (strip MEDIA: lines), send last:                │
  │   adapter.send(chat_id, cleaned_text)                      │
  └────────────────────────────────────────────────────────────┘

  What Chi sees in Telegram:
    [📷 image: week16_chart.png]  ← native preview
    [📎 file:  week16_table.pdf]  ← tap to download
    # Week 16 Revenue Digest
    Revenue was up 4.2% WoW…

  (vs if this were just a text message with URLs, it'd be one
   ugly blob. Native attachments = proper chat UX.)
```

---

## Legend

```
  ✓   passed check
  ✗   failed / blocked
  ─►  flow / call
  ◄── note / annotation
  ══  hot path / key insight
  <>  placeholder for real value
```
