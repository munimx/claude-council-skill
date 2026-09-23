# council: a multi-model council skill for Claude Code

`/council <question>` works out what you are actually asking, then convenes Claude Fable, Opus and
Sonnet as blind, independent voters, with optional opt-in GPT or Gemini seats. It returns a
verdict built to be neither a yes-man nor a reflexive no-man:

- **Your opinion never reaches a voter.** A separate framer rewrites the request as a neutral
  question with symmetric options. Every belief you stated becomes a third-person claim, and the
  council checks each one with tools.
- **Blind first, debate only when it earns its cost.** Extra seats, claim verification, one critique
  round and a red team run only on measured signals: a split vote, low confidence, unverified
  load-bearing claims, or unanimous agreement with you.
- **Evidence beats persuasion.** A position change counts only when it cites a verification record.
  The chair doesn't vote and can't override the majority without one. The minority report is kept
  verbatim. Confidence is capped in code.
- **Honest in both directions.** When you're right, it opens with "Yes, you're right." When you're
  not, it shows where you and the council disagree, what the council may be missing, and what
  being wrong would cost. Your call stays the default.

It runs through Claude Code's Workflow tool. Under ultracode it switches to deep mode: 5 seats, 2
verifiers per claim, and the red team and audit always run.

## Install

```bash
./install.sh
```

This symlinks `council/` to `~/.claude/skills/council` and copies the workflow to
`~/.claude/workflows/council-run.js`. The Workflow tool only opens scripts by path inside the current
project, so the skill calls the saved workflow by name. Re-run `./install.sh` after editing
`council/workflows/council.js`, then start a new session: a session keeps the copy of the saved
workflow it first loaded, so edits don't reach sessions that are already open.

## Use

```
/council should we move the nightly batch to a queue? I'm sure cron is the problem
/council quick is this migration safe to run during business hours?
/council deep --outside which of these two designs should we ship?
/council --interpret-only what is this ticket actually asking for?
```

`--outside` adds non-Claude seats through a locally authenticated `opencode` or `gemini` CLI.
It is opt-in per run because it sends the neutral question and context summary to a third-party
provider. See `council/references/outside-seats.md`.

## Layout

```
council/
  SKILL.md                    intake, the call, faithful delivery (what the main session follows)
  workflows/council.js        the council: interpret -> blind vote -> escalate on signals -> chair -> report
  scripts/outside-seat.sh     sandboxed, time-limited one-shot call to opencode / gemini (opt-in only)
  references/evidence.md      why each mechanism exists, with the research behind it
  references/outside-seats.md consent, safety envelope, verification status of outside seats
tests/simulate.mjs            offline simulator: runs council.js with mocked agents, 50 scenarios
evals/evals.json              test prompts, intake args, assertions
evals/run-evals.js            Workflow script: council vs baseline, graded blind
evals/to_workspace.py         converts eval output to the skill-creator workspace layout
council-workspace/            eval results by iteration
install.sh
```

## Test

```bash
node tests/simulate.mjs              # all branches, no tokens spent
node tests/simulate.mjs agree_user_right   # one scenario, prints its report
```

The simulator runs `council.js` with mocked agents across 50 scenarios. It checks that the script
completes on every branch, that every schema is well formed, and that every mocked reply validates.
It also checks the blinding contract: no agent other than the framer and readers ever sees the raw
request or your stance, and no agent ever sees Claude's own prior. Every defect found in real runs
or review has a scenario here.

Real evals (spends tokens; run from this repo so the script path is allowed). Ask Claude Code to
run the Workflow tool with `scriptPath: evals/run-evals.js` and `args: {evals: <contents of
evals/evals.json>.evals}`. Each eval runs the real council and a skill-free single-model baseline.
Two graders on different models check the assertions, and two judges compare the answers blind.
`python3 evals/to_workspace.py <workflow output file> council-workspace/iteration-N` converts the
results for skill-creator's `aggregate_benchmark.py` and `generate_review.py`.

Results so far (`council-workspace/`): on the five evals, the final iterations pass 100% of
assertions with no sycophancy, no manufactured disagreement and no factual errors flagged. The
baseline is Opus 5.5 at high effort, and it also passes these assertions, so they don't separate
the two. Blind pairwise judges (Fable and Sonnet) are split, mostly by slight margins. The Fable
judge more often credits the council's verification; the Sonnet judge prefers the baseline's brevity.
