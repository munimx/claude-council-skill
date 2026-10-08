# council

A second opinion for Claude Code that is neither a yes-man nor a reflexive no-man.

`/council <question>` first works out what you are actually asking: the literal ask, the goal behind
it, the premises it rests on, and anything ambiguous. Then Claude Fable, Opus and Sonnet vote on it
blind and independently, and a non-voting chair writes a verdict from the evidence.

- **Your opinion never reaches a voter.** A separate framer rewrites your request as a neutral
  question with shuffled options. Each belief you stated becomes a neutral claim, and the council
  checks it with tools.
- **Debate only when it earns its cost.** Claim checks, a critique round and a red team run only on
  measured signals: a split vote, low confidence, unchecked load-bearing claims, or unanimous
  agreement with you.
- **Evidence beats persuasion.** A vote can change only by citing a verification record. The chair
  can't overrule the majority without one, confidence is capped in code, and dissent is kept as a
  minority report.
- **Honest in both directions.** When you're right, the report opens with "Yes, you're right." When
  you're not, it shows where you and the council disagree and what being wrong would cost.

`examples/sample-report.md` is the full report from a real run.

## Requirements

- **Claude Code** with the Workflow tool. The council is a Workflow script
  (`workflows/council.js`) that runs its agents in the background.
- Access to Claude Fable, Opus and Sonnet. If a seat can't run on its model, it falls back to
  another one, and the report says so and caps its confidence.
- Optional: an authenticated `opencode` or `gemini` CLI for GPT or Gemini seats (see
  Privacy below).

In other agents (Cursor, Codex CLI, Copilot and so on) there is no Workflow tool. There the skill
says so in one line and gives a single model's answer, clearly labelled as not a council verdict.

## One-time setup

The skill calls its workflow by name, and Claude Code loads saved workflows from
`~/.claude/workflows/`. Copy it there once:

```bash
mkdir -p ~/.claude/workflows && cp ~/.claude/skills/council/workflows/council.js ~/.claude/workflows/council-run.js
```

Adjust the first path if the skill was installed somewhere else. Then start a new Claude Code
session, because a session loads saved workflows when it starts. If you skip this step, the first
`/council` offers to run the same copy for you and asks before it does.

## Use

```
/council should we move the nightly batch to a queue? I'm sure cron is the problem
/council quick is this migration safe to run during business hours?
/council deep which of these two designs should we ship?
/council --interpret-only what is this ticket actually asking for?
```

It also triggers on requests like "sanity check this", "poke holes in my plan", "am I wrong?",
"be brutally honest" or "play devil's advocate".

| | quick | standard (default) | deep (or ultracode) |
|---|---|---|---|
| Blind seats | Fable, Opus, Sonnet | the same three, at higher effort | plus an outsider and a forecaster |
| Claims checked with tools | up to 3 | up to 5 | up to 10, two checkers each |
| Typical run | 5–10 agents | 9–18 agents | 18–30 agents, often 20+ minutes |

Each agent is a Claude Code subagent, so a run uses tokens accordingly. A "+Nk" token budget in the
request caps the run, and anything skipped is listed in the report. For questions about code, start
the session in that repository and say so ("in this repo, is X safe?").

## Privacy and security

- **Nothing leaves your machine by default** beyond your normal Claude Code session. The skill
  contains no URLs it calls and no API keys.
- **Outside seats are opt-in per run.** Only when you ask in that run (`--outside`, "include
  GPT/Gemini"), `scripts/outside-seat.sh` sends the neutral question, the options and a neutral
  summary of the context to your `opencode` or `gemini` CLI, billed to your account with that
  provider. Your original wording, your stated opinion and the other seats' answers are never sent.
  The outside model runs with every tool denied, in an empty temporary directory, under a hard
  timeout. This path has been tested only against stand-in CLIs, not yet against a live provider.
- **Environment variables:** `outside-seat.sh` checks whether `GEMINI_API_KEY` or
  `GOOGLE_GENAI_USE_VERTEXAI` is set, to tell whether the Gemini CLI can run. It never reads, prints
  or sends their values.
- **Files:** council agents are told not to edit files, install anything or run commands with side
  effects. The only deletions are of temporary directories the council itself creates. The
  one-time setup above writes a single file, and only with your yes.

## What's in this folder

```
SKILL.md                     what Claude follows: intake, the call, faithful delivery
workflows/council.js         the council: interpret, blind vote, escalate on signals, chair, report
scripts/outside-seat.sh      opt-in, sandboxed, time-limited call to opencode or gemini
references/evidence.md       why each mechanism exists, with the research behind it
references/outside-seats.md  consent, safety envelope and test status of outside seats
examples/sample-report.md    a full report from a real run
```

## License and support

MIT, see `LICENSE`. Created by Munim Ahmad. Source, tests and issues:
https://github.com/munimx/claude-council-skill
