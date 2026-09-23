# Why the council works the way it does

Load this when the user asks why the council behaves as it does, or before changing
`workflows/council.js`. Each mechanism names the failure it prevents and the evidence behind it.
The evidence was gathered on 2026-09-23. Most debate and conformity numbers come from multiple-choice
or maths benchmarks, so treat transfer to open-ended decisions as likely, not proven.

## The failures a council falls into

| Failure | What happens | Where the council blocks it |
|---|---|---|
| Sycophancy to the asker | Voters agree with an opinion the asker stated, more so when it is first-person and confident | Framer-only stance; symmetric options re-keyed by seeded shuffle; claims attributed to nobody; leak lint + repair over every text a voter reads (question, readings, options, claims, missing facts, context summary); leaks that survive are disclosed and cap confidence |
| Herding / conformity | Voters flip to the majority; correct-to-wrong flips outnumber wrong-to-correct | Blind ballots; justified-flip rule (a record must cut against the old position); a seat that moves drops the claims it made for its old position; ≤1–2 short critique rounds |
| False confidence from unanimity | Same-family models share blind spots, so agreement is weak evidence | Red team on unanimity; confidence ceiling; diversity note |
| Persuasiveness beats correctness | Longest, most fluent or most citation-heavy answer wins | Verification with quoted trails that must be independent of the question; schema-only, length-capped peer rendering; a flip or chair override counts only if its record cuts against the old position (citing a record that confirmed your own claim is herding) |
| Judge bias | Position, verbosity and self-preference bias in whoever synthesises | Anonymised, seed-shuffled ballots; non-voting chair; audit by a different tier |
| Suppressed minority | Chair defaults to the majority and drops a correct dissent | Minority claims verified first; the dissenter's own statement is rendered verbatim by code (never the chair's paraphrase); an outside dissenter is quoted from its own ballot |
| Performative contrarianism | A mandated devil's advocate invents objections | No devil's-advocate seat; "an invented objection is an error"; recalled caveats cannot block |
| Premise capture | The council answers the question as framed, false premises included | Premise audit with tools in every mode; a premise table whenever a claim was settled, and a list of the load-bearing ones nobody could check |
| Wrong question | The council answers a reading the asker didn't mean | Framer + blind readers + reconciler; clarification round-trip; per-seat reading check |

## Mechanism → evidence

1. **Neutralise framing in a separate stage** (framer; voters never see the stance, the certainty,
   or which option is the asker's). A stated user belief is the main sycophancy trigger, and
   first-person certainty is worse than third-person (+13.6 points). Claimed expertise barely
   matters (<4.4 points). Rewriting the input as a neutral question by a separate step worked better
   than telling the model "don't be sycophantic". Sources: Sharma et al. 2023
   (arXiv 2310.13548); arXiv 2508.02087; "Ask Don't Tell", UK AISI (arXiv 2602.23971).
2. **Blind first ballots are the main signal.** Majority voting explains most gains credited to
   debate, and debate alone is a martingale over belief. Choi, Zhu & Li, "Debate or Vote", NeurIPS
   2025 (arXiv 2508.17536); Smit et al. 2023 (arXiv 2311.17371).
3. **Short, gated deliberation; flips must cite evidence.** Correct-to-incorrect flips dominate, and
   one weaker agent cut MMLU accuracy from 51.8% to 43.6% (Wynn et al. 2025, arXiv 2509.05396).
   Peer text framed as assistant output triggers flips at a mere majority ("Not Just RLHF",
   arXiv 2605.12991). That is why peers are quoted as material in the user turn.
4. **Seek truth, not agreement. No forced contrarianism.** MAD level 2 ("seek truth") beat forced
   consensus and forced disagreement (Liang et al., arXiv 2305.19118). Instructed disagreement
   changes what models say more than what they conclude (arXiv 2609.08016).
5. **Authentic dissent, not a scripted devil's advocate.** One correct dissenter cut yielding to a
   wrong majority by 54–73 points (2605.12991). Authentic minority dissent beat role-played devil's
   advocacy in humans (Nemeth, Brown & Rogers 2001).
6. **Different models, but no weak voters.** Models that both err pick the same wrong answer about
   60% of the time, and more so within one provider (Kim et al., ICML 2025, arXiv 2506.07962).
   Model diversity was critical in ReConcile (arXiv 2309.13007). Weak proposers hurt mixtures
   (Self-MoA, arXiv 2502.00674), so Haiku never votes or judges.
7. **Distinct lenses per seat.** Identical role prompts added nothing over a single agent in
   ChatEval (arXiv 2308.07201). Lenses help independence, not deliberation.
8. **Anonymise and shuffle for every reader.** Position consistency ran as low as 23.8%, and
   verbosity attacks fooled some judges 91% of the time (Zheng et al., arXiv 2306.05685). Reordering
   alone flipped 66 of 80 comparisons (arXiv 2305.17926). Self-recognition tracks self-preference
   (arXiv 2404.13076).
9. **The chair adjudicates cruxes by verification; the minority is protected.** In 2:1 splits the
   minority was right 25.5% of the time. A naive LLM adjudicator lost accuracy (-1.37%) trying to
   overturn majorities ("Minority Sentinel", arXiv 2606.29270). So the chair can depart from the
   leader only with a verification record, and code enforces it.
10. **Coarse, capped confidence.** Verbalised confidence clusters high (Xiong et al., arXiv
    2306.13063). Citation-style pushback causes the most regressive sycophancy (SycEval,
    arXiv 2502.08177), so citations inside claims are themselves claims to verify.
11. **Red team on unanimity.** Pre-mortems raise the number of failure reasons found by about 30%
    and cut overconfidence (Mitchell et al. 1989; Veinott et al. 2010). Field evidence is thin,
    so it runs only on the signals where groupthink is hardest to see.
12. **Interpretation as its own stage.** Models accept the asker's framing and false premises
    (mimicry in Sharma et al.; social sycophancy in ELEPHANT, arXiv 2505.13995). No existing council
    tool interprets intent independently, which is why this one does.

## Prior art this borrows from and fixes

- Karpathy's llm-council gave the three-stage shape (blind answers, anonymised review, chair). It
  does not shuffle labels, and its chairman is also a member.
- PAL/zen `consensus` gave per-seat stances. Its issue #162 showed the host's framing leaking into
  every seat, which is why a separate framer exists here.
- ECC council gave host pre-commit (`host_prior`) and a premise check.
- boshu2 agentops council gave the caller-challenge block ("what we may be missing / cost if we're
  wrong / your call stays the default") and discounting agreement by independence.
- trailofbits second-opinion gave "a failed outside review is a missing seat, never a pass."

## Known limits (be honest about these)

- The thresholds (reading probability < 0.6, red-team triggers, confidence ceilings) are bets.
  Tune them with `evals/` and the offline simulator.
- The framer is a single point of failure for the option list. Seats can propose an alternative,
  which softens this but does not remove it.
- With Claude-only seats, errors are still correlated. The report says so every time.
- The justified-flip rule and the claim carry-through check are design inferences from the
  literature, not interventions anyone has tested.
