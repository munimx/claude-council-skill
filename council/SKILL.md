---
name: council
description: >-
  Convene a multi-model council (Claude Fable, Opus and Sonnet as blind, independent voters, plus
  optional opt-in GPT/Gemini seats) that first works out what is really being asked (literal ask vs
  underlying goal, hidden premises, ambiguity) and then returns a verdict that is neither a yes-man
  nor a reflexive no-man: it checks the asker's premises with tools, keeps dissent as a minority
  report, and says "you're right" plainly when they are. Use whenever the user asks for a council,
  a second opinion, a sanity or gut check, to pressure-test, red-team, poke holes in or stress-test
  a plan, decision or premise, "am I wrong?", "be brutally honest", "don't just agree with me",
  "play devil's advocate", "is this actually a good idea", or wants something checked by more than
  one model, and when an ultracode task hits a judgement call that deserves independent scrutiny.
  Not for plain lookups nobody asked to scrutinise.
argument-hint: "[quick|deep] [--outside[=provider/model,...]] [--interpret-only] <question>"
allowed-tools: Workflow, Read, Grep, Glob, AskUserQuestion
---

# Council

**Created by Munim Ahmad.** MIT licensed. Feedback and issues: https://github.com/munimx/claude-council-skill/issues

The council answers two questions, in order: *what is actually being asked?* and *what is the
honest answer?* It runs as a Workflow script (`workflows/council.js`, in this skill's base
directory) so that the parts that keep it honest are enforced in code, not left to good intentions:

- A separate **framer** is the only agent that sees how the user phrased things. It rewrites the
  request as a neutral question with symmetric, shuffled options, and turns every belief the user
  stated into a neutral claim to check, attributed to nobody. Everything the voters read is then
  linted for leftover leaning and repaired. The people-pleasing trigger (a stated, confident
  opinion) never reaches a voter, and if it might have, the report says so.
- **Blind ballots**: Fable, Opus and Sonnet vote independently, each with tools to check claims.
  Everything after that (verification, one critique round, red team, audit) runs only when a
  measured signal calls for it: a split vote, low confidence, unverified load-bearing claims,
  or unanimous agreement with the user, which is exactly when a yes-man is hardest to spot.
- A vote can change only by citing a verification record. A **non-voting chair** rules on the
  evidence. Code caps its confidence, rejects overrides that aren't backed by a verification record,
  and requires a minority report. The workflow then renders the report itself, so it reaches the
  user without being softened.

Your job as the main session is intake, the call, and faithful delivery. Do not deliberate on
the council's behalf.

## 1. Parse the invocation

The invocation arguments were: `$ARGUMENTS`. They may start with a mode (`quick`, `deep`) and flags:
- `--outside` or `--outside=opencode/gpt-5.5,opencode/gemini-3.1-pro`: add non-Claude seats (see §4).
- `--interpret-only`: only report how the request reads (readings, premises, ambiguity). No verdict.

The rest is the question. If there is no question text, the question is the user's most recent
substantive request or decision in this conversation. Say which one you picked in one line.

## 2. Resolve references before spending anything

If the question leans on a referent you cannot resolve ("the new approach", "it", "this plan",
"what we have") from the conversation, open files, or a quick look at the repo, **ask now** and
stop. Don't call the Workflow. Ask for exactly what is missing: each option in a line or two, the
problem it is meant to solve, and any hard constraint. A council on a guess is worse than no
council. Missing *background facts* (versions, measurements, root causes) are different. The
council answers those conditionally, so they are not a reason to ask first.

## 3. Build `args` (the intake)

| field | what to put there |
|---|---|
| `question_raw` | The user's request **verbatim**, including "right?", "I'm sure", typos. Only the framer sees it. |
| `user_stance` | `{present, verbatim, position, certainty}` where `verbatim` is the sentence(s) stating their view, `position` their preferred course in a few words, `certainty` one of `none / tentative / confident / certain`. `null` if they stated no view. |
| `context` | `{summary, files, urls, repo}`. `summary` holds **facts only, third person, no evaluative words** ("Django 5.1 monolith; dashboard endpoint p95 is 800 ms per the user"). Never "the user thinks". `files` and `urls` are pointers that seats will read themselves; do not paste contents. Set `repo: true` only when the question is about the repository in the current working directory. Otherwise the council is told to leave the working directory alone, apart from any files you list, so an unrelated repo is never mistaken for the user's system. Include what the conversation has established; skip what is irrelevant. `null` if none. |
| `mode` | `quick`, `standard` or `deep` if the user named one; otherwise omit it (auto). |
| `ultracode` | `true` only if a system reminder says ultracode is on. This selects deep mode. |
| `stakes_hint` | `low / medium / high`, only if the user stated the stakes. |
| `allow_clarification` | `false` only if the user said "just answer" or declined to clarify. |
| `seed` | Any string unique to this question, e.g. `${CLAUDE_SESSION_ID}` plus its first 40 characters. It drives the deterministic shuffles. |
| `skill_dir` | This skill's base directory (`${CLAUDE_SKILL_DIR}`; also shown as "Base directory for this skill"). |
| `host_prior` | **Before** calling: your own honest one-line take. No council agent ever sees it. Writing it first keeps you from quietly anchoring the intake, and it lets you notice afterwards whether the council overruled you (§7). |
| `outside` | Only with this run's explicit consent (§4): `{enabled: true, models: [...], consent_quote: "<their words>"}`. |
| `interpret_only` | `true` for `--interpret-only`. |

Pre-flight check before the call. Re-read `args` and confirm:
(1) `question_raw` is verbatim;
(2) the stance lives only in `user_stance` and `question_raw`, not in `context.summary`;
(3) `context.summary` has no adjectives that grade the options ("obvious", "clearly better", "hacky");
(4) `host_prior` is written;
(5) `outside` is absent unless the user opted in for this run.

## 4. Outside (non-Claude) seats: opt-in per run only

Outside seats send the neutral question, the options, the claims to check, the missing facts and
the neutralised `context.summary` to a third-party provider through a local CLI, billed to the
user's account. They vote only. They never see the other seats' answers or any verification
evidence. Enable them only when the user asks in this run (`--outside`, "include GPT/Gemini", "get
another vendor's view"). Ultracode never implies consent.

When enabled:
1. Probe availability. This sends nothing: `bash "${CLAUDE_SKILL_DIR}/scripts/outside-seat.sh" probe`.
2. Pick at most two models from `suggested_models`, or the user's named ones.
3. Tell the user in one line what will be sent and to whom, then call the Workflow.

Details (safety envelope, supported CLIs, failure handling): `references/outside-seats.md`.

## 5. Call the Workflow

Call the installed workflow by name. This works from any project:

```
Workflow({ name: "council-run", args: { ...args } })
```

If that returns "not found" (the workflow isn't installed, or was installed after this session
started), fall back to the script path. That only works when the skill directory is inside the
current project or in a directory added to this session:

```
Workflow({ scriptPath: "${CLAUDE_SKILL_DIR}/workflows/council.js", args: { ...args } })
```

A session keeps the saved workflow it first loaded. After `install.sh` updates it, only new sessions
run the new version.

If both fail, tell the user the council isn't installed for this session. Running `install.sh`
from the skill's repository copies the workflow to `~/.claude/workflows/council-run.js`, and a new
session will pick it up. Do not improvise a council some other way.

If the Workflow tool itself is unavailable (for example, you are a subagent), say so in one line and
give your own answer, clearly labelled as one model's view and not a council verdict. Keep the
council's discipline: judge the question, not the user's stated preference; check load-bearing
premises with tools; commit to a verdict; and state what would change it.

Pass `args` as a JSON object, not a string. The workflow runs in the background. Tell the user
in a sentence that the council is convened, which mode, and roughly what runs. Keep the returned
run ID. When the completion notification arrives, the inline result is often truncated, so read the
full result from the notification's output file:

```bash
jq -r '.result.status, .result.report_markdown // empty' "<output-file from the notification>"
```

Other fields you may need: `.result.clarification`, `.result.reason`, `.result.relation_to_user`,
`.result.verdict`, `.result.ballots`, `.result.verification`.

## 6. Handle the result

- **`ok`** means a verdict. Present `report_markdown` verbatim (§7).
- **`needs_clarification`**: the question can't be pinned down. Present `report_markdown` (it is the
  clarifying question). If `clarification.options` is non-empty, you may ask with AskUserQuestion
  instead, one option per reading, with `how_answer_differs` as the description. Then:
  - They picked a listed reading: call the Workflow again the same way, with the **same** args
    plus `clarification: {reading_id}`, `clarification_round: 1` and `mode` set to the result's
    `mode` (so a different token budget can't change the interpretation step), and pass
    `resumeFromRunId` (the run ID from the first call). The interpretation phase replays from cache.
  - They described something, or answered an unclear reference: start a fresh run. Append
    `"\n\nClarification from the asker: <their words>"` to `question_raw`, add the facts to
    `context.summary`, and set `clarification_round: 1`.
  - They said "just answer": re-run with `allow_clarification: false`. The council answers the
    most likely reading and notes the alternative.
  The round guard means the council never asks twice.
- **`interpretation`** (`--interpret-only`): present `report_markdown`.
- **`insufficient` / `error`**: say so plainly with `reason` / `error` and which seats failed
  (`process.roster`). Offer a retry (quick mode, or without outside seats). **Never** substitute your
  own answer and present it as the council's.

## 7. Deliver the verdict without softening it

The report is already written. The workflow built it from the chair's checked verdict, so your
job is delivery:

- Output `report_markdown` exactly as returned. Do not add a preamble, compliments, or hedges the
  chair did not write. Do not turn a "No." into "Partly", and do not demote a blocking caveat.
- If you have **evidence** the council missed (something in this conversation it could not see),
  add it after the report under a heading **"Claude's own note"**. Cite the evidence, and keep it
  separate from the verdict. Disagreeing without new evidence is not a note.
- If your `host_prior` differed materially from the verdict, add one line after the report:
  "Before the council I leaned toward X; the evidence above says otherwise." Don't relitigate.

**Pushback afterwards.** "Are you sure?" or displeasure alone never changes the verdict. Restate it
and name the evidence that would change it (the report's "What would change this verdict" list).
If the user brings a **new fact or argument**, re-run the council (quick mode is usually enough),
adding it to `context.summary` and the new claim to `question_raw`, so it gets verified like any
other claim. Capitulating to repetition is the exact failure this skill exists to prevent.

## 8. Modes, models, and ultracode

| | quick | standard (default) | deep (ultracode, or budget ≥ 800k) |
|---|---|---|---|
| Interpret | framer (+1 reader if unsure) | framer + blind reader + reconciler | framer + 2 readers + reconciler |
| Blind seats | Fable, Opus, Sonnet at medium effort | same, high effort (+outside if opted in) | + outsider (Opus, no context) + forecaster (Fable) |
| Premise audit | ≤3 claims | ≤5 claims | ≤10 claims, 2 verifiers each |
| Critique rounds | 0 | ≤1, only if split survives verification | ≤2, adaptive |
| Red team | when unanimous and agreeing with the user on a high-stakes call | when unanimous and (agrees with user, or high stakes, or unverified claims) | always |
| Chair / audit | Sonnet / on disagreement | Opus / on disagreement | Fable xhigh / always |
| Typical agents | 5–10 | 9–18 | 18–30 |

- Model choice follows the research on councils. Haiku never votes or judges, because weak members
  pull a council toward errors. Sonnet, Opus and Fable give three different perspectives. Seats that
  fall back to another model are disclosed, and they cap the confidence.
- **Ultracode.** When a system reminder says ultracode is on, set `ultracode: true` to get deep mode,
  since token cost is not the constraint there. The council is also the natural "decide" step inside
  a larger ultracode task. When the work reaches a real judgement call (which design, whether a
  finding is real, whether a migration is safe), convene the council on that decision instead of
  deciding alone. Pass the relevant file paths in `context.files`.
- **Budgets.** A "+Nk" token directive reaches the workflow as `budget`. Below 150k it runs quick,
  below 400k it never runs deep, and every escalation checks the remaining budget first. Anything
  skipped is listed in the report.

Why each mechanism exists, with the research behind it: `references/evidence.md`.
