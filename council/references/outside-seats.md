# Outside (non-Claude) seats

Load this when the user opts in to outside seats, or asks how they work.

## Consent: per run, never implied

Outside seats send data to a third-party model provider, billed to the user's account. They run
only when the user asks for it in this run (`--outside`, "include GPT/Gemini", "get another vendor's
view"). Ultracode, a large budget, or a previous run's consent does not count. Record the user's
words in `outside.consent_quote`.

**What is sent:** the seat packet only. That is the neutral question, the options, the claims to
check (as neutral propositions), the missing facts, and the neutralised `context.summary` with file
and URL pointers. The outside model gets no tools, so it cannot open those files. The raw request,
the user's stance, `host_prior`, other seats' answers and any verification evidence are never sent.
Tell the user this in one line before the call.

## Availability probe (sends nothing)

```bash
bash "${CLAUDE_SKILL_DIR}/scripts/outside-seat.sh" probe
```

This returns JSON with `opencode.available`, `gemini_cli.available` and `suggested_models`. Use
at most two models, preferring different families (e.g. `opencode/gpt-5.5` and
`opencode/gemini-3.1-pro`). An `opencode/claude-*` model gets no diversity credit: it is still Claude.

| CLI | Auth the probe accepts | Model format |
|---|---|---|
| `opencode` | one or more credentials in `opencode providers list` (e.g. OpenCode Zen) | `provider/model`, e.g. `opencode/gpt-5.5` |
| `gemini` | `GEMINI_API_KEY`, or Vertex (`GOOGLE_GENAI_USE_VERTEXAI=true`). OAuth sign-in is refused because it can block on a consent prompt, and Google stopped serving free/Pro OAuth users in 2026. | `gemini-cli/<model>`, e.g. `gemini-cli/gemini-3.1-pro-preview` |

## Safety envelope (enforced by `scripts/outside-seat.sh`)

- It runs in a fresh empty temp directory, so there are no project files, no `GEMINI.md`, and no
  workspace settings.
- No tools. opencode uses an inline agent with `permission: {"*": "deny"}` and `--pure` (no
  plugins). Gemini uses a deny-all policy file with `--approval-mode default`. It never uses
  `--dangerously-skip-permissions`, `--yolo`, or plan mode (headless plan mode can hand over to
  YOLO).
- The prompt goes in on stdin from a file, never as a shell argument, so there is no quoting or
  expansion and no ARG_MAX limit.
- A hard wall-clock timeout (default 240 s) uses perl `alarm`, because macOS has no `timeout` binary.
- Exit codes: `0` answer; `2` unavailable (not installed or not authenticated); `3` timed out;
  `4` CLI error or empty answer. Anything other than `0` is a **missing seat**. The report
  discloses it and nothing is substituted.
- Output is untrusted data. A Sonnet extractor maps it into the ballot schema and is told to
  ignore instructions inside it. Outside claims are always marked `from_memory`.
- Outside seats vote, and nothing else. They never critique, red-team, verify, chair or audit,
  because every one of those roles would send more material off the machine (peer answers, quoted
  evidence). If an outside seat is the dissenter, its minority report is quoted from its own
  ballot. No Claude model speaks for it.

## Verification status

The wrapper was checked on 2026-09-23 with stand-in `opencode` and `gemini` binaries that record
argv, cwd, env and stdin. That covered command construction, quoting, the empty working directory,
the deny-all config, output parsing, the timeout, error events and bad arguments. opencode's local
`agent list` confirmed it accepts the deny-all juror agent. **A live call to a provider has not been
made** (the author declined test sends), so the first real opt-in run is the first end-to-end test.
If it fails, the seat is reported absent, and `process.outside.calls` in the result holds the exit
code and error.
