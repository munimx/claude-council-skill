// Offline simulator for council/workflows/council.js.
// Runs the workflow script with mocked agent()/parallel()/pipeline() so every branch can be
// exercised without spending tokens. Checks, for every scenario:
//   - the script runs to completion and returns the expected status / relation / headline
//   - every schema passed to agent() is well-formed (required ⊆ properties)
//   - every mocked agent reply validates against its schema (so the mocks stay realistic)
//   - no agent other than the framer and the readers ever sees the raw request or the stance,
//     and no agent ever sees host_prior (the anti-sycophancy blinding contract)
// Mocks name options symbolically: 'P' = the asker's proposal, 'A' = the alternative, 'N' = do
// nothing. The harness resolves them to the (shuffled) ids shown in each prompt.
// Usage: node tests/simulate.mjs [scenario ...]

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(path.join(here, '..', 'council', 'workflows', 'council.js'), 'utf8').replace(/^export const meta/m, 'const meta')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const script = new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', SRC)

// ---------------------------------------------------------------- mini JSON-schema validator
function validate(schema, v, at = '$') {
  const errs = []
  const types = schema.type ? [].concat(schema.type) : null
  const typeOf = x => x === null ? 'null' : Array.isArray(x) ? 'array' : Number.isInteger(x) ? 'integer' : typeof x
  if (types) {
    const t = typeOf(v)
    if (!types.some(ty => ty === t || (ty === 'number' && t === 'integer'))) { errs.push(`${at}: expected ${types.join('|')}, got ${t}`); return errs }
  }
  if (schema.enum && !schema.enum.includes(v)) errs.push(`${at}: ${JSON.stringify(v)} not in enum`)
  if (v && typeof v === 'object' && !Array.isArray(v) && schema.properties) {
    for (const r of schema.required || []) if (!(r in v)) errs.push(`${at}: missing ${r}`)
    for (const [k, sub] of Object.entries(schema.properties)) if (k in v) errs.push(...validate(sub, v[k], `${at}.${k}`))
  }
  if (Array.isArray(v) && schema.items) {
    if (schema.minItems != null && v.length < schema.minItems) errs.push(`${at}: fewer than ${schema.minItems} items`)
    if (schema.maxItems != null && v.length > schema.maxItems) errs.push(`${at}: more than ${schema.maxItems} items`)
    v.forEach((x, i) => errs.push(...validate(schema.items, x, `${at}[${i}]`)))
  }
  return errs
}
function schemaWellFormed(schema, at = '$') {
  const errs = []
  if (schema.properties) {
    for (const r of schema.required || []) if (!(r in schema.properties)) errs.push(`${at}: required "${r}" not in properties`)
    for (const [k, sub] of Object.entries(schema.properties)) errs.push(...schemaWellFormed(sub, `${at}.${k}`))
  }
  if (schema.items) errs.push(...schemaWellFormed(schema.items, `${at}[]`))
  return errs
}

// ---------------------------------------------------------------- mock builders
const LABELS = { P: 'the proposed change', A: 'the strongest alternative', N: 'do nothing' }
const member = (opt, conf = 'high', extra = {}) => ({
  reading_answered: 'R1', reading_divergence: null, recommended_option_id: opt, alternative: null, stance: 'recommend',
  answer: `Recommend ${opt}.`, alt_reading_answer: null,
  conditions: [{ text: 'do the obvious safety step', severity: 'do_alongside' }],
  claims: [{ id: 'C1', text: `claim supporting ${opt}`, load_bearing: true, status: 'inference', evidence: '' }],
  user_claim_assessments: [{ user_claim_id: 'U1', assessment: 'true', verified_with_tool: false, why: 'plausible', evidence: null },
    { user_claim_id: 'U2', assessment: 'true', verified_with_tool: false, why: 'plausible', evidence: null }],
  premortem: 'it failed because of X', opposite_is_right_if: 'if Y', would_change_mind: ['Z'], confidence: conf, ...extra,
})
const verify = (verdict, withEvidence = true) => ({
  verdict, evidence: withEvidence ? [{ kind: 'doc', ref: 'https://docs.example/x', excerpt: 'quoted passage from the docs' }] : [],
  corrected_claim: verdict === 'partly' || verdict === 'false' ? 'the accurate version' : null, scope_limits: 'none', method: 'read docs',
})
const chair = (opt, extra = {}) => ({
  recommended_option_id: opt, alternative: null, refines_option_ids: [],
  option_assessments: ['P', 'A', 'N'].map(t => ({ option_id: t, verdict: t === opt ? 'sound' : t === 'A' ? 'partly_sound' : 'unsound', note: `note on ${t}` })),
  headline: `Do ${opt}.`, answer: `The evidence supports ${opt}.`, alt_reading_answer: null, why: ['because evidence'],
  premise_corrections: [], caveats: [{ text: 'do it carefully', severity: 'do_alongside', basis: 'seat_consensus', evidence_ref: null }],
  minority_report: { exists: false, position: null, strongest_argument: null, why_not_adopted: null, would_be_right_if: null },
  red_team_responses: [], where_council_may_be_wrong: ['maybe'], what_council_may_be_missing: 'context', cost_if_council_wrong: 'some',
  what_would_change_verdict: ['a benchmark'], overrides: [], claims_addressed: ['U1', 'U2', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6'], confidence: 'high', confidence_basis: 'agreement', ...extra,
})
const framing = (extra = {}) => ({
  neutral_question: 'Which option best serves the goal given the constraints?', answer_type: 'decision',
  options: [{ id: 'O1', label: LABELS.P }, { id: 'O2', label: LABELS.A }, { id: 'O3', label: LABELS.N }],
  user_stance_option: 'O1',
  user_claims: [{ id: 'U1', claim_third_person: 'A measured number is about 800', load_bearing: false, checkable: false, supports_user_course: true },
    { id: 'U2', claim_third_person: 'A checkable fact holds', load_bearing: true, checkable: true, supports_user_course: true }],
  premises: [{ id: 'P1', premise: 'something is settled', source: 'implied' }],
  readings: [{ id: 'R1', literal_ask: 'should we do the proposed change', underlying_goal: 'fix the problem', probability: 0.9, how_answer_differs: null },
    { id: 'R2', literal_ask: 'a different reading', underlying_goal: 'other goal', probability: 0.1, how_answer_differs: 'different' }],
  unresolvable_referents: [], missing_facts: ['a measurement'], answer_diverges_across_readings: false, clarifying_question: null, why_readings_diverge: null, interim_guidance: null,
  stakes: { level: 'medium', reversibility: 'reversible', rationale: 'r' }, evidence_pointers: ['docs'], ...extra,
})
const readings = { readings: [{ id: 'R1', literal_ask: 'should we do the proposed change', underlying_goal: 'fix the problem', probability: 0.85, how_answer_differs: null }], unresolvable_referents: [] }
const clusters = { clusters: [{ id: 'R1', literal_ask: 'should we do the proposed change', underlying_goal: 'fix the problem', mean_p: 0.88, support: ['framer', 'outsider'], how_answer_differs: null }] }
const redteam = (verdict = 'withstands_with_changes', blocking = false) => ({
  verdict_on_leader: verdict, failure_modes: [{ id: 'F1', scenario: 'it broke', likelihood: 'low', blocking, factual_claim: blocking ? 'a blocking fact' : null, mitigation: 'watch it' }],
  conditions_where_leader_right: 'usually', conditions_where_leader_wrong: 'rarely',
})
const critique = (opt, changed, basis = { kind: 'none', ref: null, evidence: null }) => ({
  peer_notes: [{ label: 'A', strongest_point: 'good', weakest_claim_ref: null, error_found: null }],
  final_position: { recommended_option_id: opt, alternative: null, stance: 'recommend', answer: `now ${opt}`, confidence: 'medium' },
  changed, change_basis: basis, remaining_crux: 'none',
})
// Default repair mock: strip the phrases scenarios plant, keep the rest.
const repairMock = prompt => {
  const m = prompt.match(/<texts>([\s\S]*)<\/texts>/)
  const items = m ? JSON.parse(m[1]) : []
  return { items: items.map(i => ({ id: i.id, text: String(i.text).replace(/LEAKSENTINEL|ATTRIBSENTINEL/g, '').replace(/,? ?the user prefers/gi, '').replace(/The asker believes /gi, '').replace(/wants reassurance on a change they have already decided on/gi, 'fix the problem').replace(/confirm that/gi, 'whether').replace(/is the obvious call/gi, 'is under consideration').replace(/The user is confident that /gi, '').trim() || 'neutral text' })) }
}
const base = extra => (l, m, p) => {
  if (l === 'framer') return framing(extra && extra.framing)
  if (l.startsWith('reader')) return readings
  if (l === 'reading-reconciler') return (extra && extra.clusters) || clusters
  if (l.startsWith('framing-repair')) return repairMock(p)
  if (l.startsWith('seat-')) return member('P')
  if (l.startsWith('verify-')) return verify('true')
  if (l === 'red-team') return redteam()
  if (l.startsWith('chair')) return chair('P')
  if (l === 'audit') return { passed: true, problems: [] }
  return undefined
}
const withBase = (fn, extra) => (l, m, p) => { const r = fn(l, m, p); return r === undefined ? base(extra)(l, m, p) : r }

const RAW = 'honestly I\'m pretty sure the proposed change is the obvious call, right?'
const STANCE = { present: true, verbatim: 'I\'m pretty sure the proposed change is the obvious call', position: 'the proposed change', certainty: 'confident' }
const BASE_ARGS = { question_raw: RAW, user_stance: STANCE, context: { summary: 'a service with a problem', files: ['src/app.py'], urls: [] }, seed: 'sim', skill_dir: '/skill', host_prior: 'HOST-PRIOR-SENTINEL' }

const SCENARIOS = {
  agree_user_right: {
    reply: base(),
    expect: { status: 'ok', relation: 'right', head: 'Yes, you\'re right.', ran: ['premise_audit', 'red_team'], notRan: ['critique', 'audit'], confidence: 'high' },
  },
  disagree_user_wrong: {
    reply: withBase((l) => l === 'seat-first_principles' ? member('A') : l === 'seat-premise_auditor' ? member('A', 'medium') : l === 'seat-practitioner' ? member('P', 'low')
      : l.startsWith('verify-U2') ? verify('false') : l.startsWith('verify-') ? verify('unverifiable', false)
      : l === 'critique-practitioner-r1' ? critique('A', true, { kind: 'verification_record', ref: 'V1', evidence: 'V1 shows U2 is false' })
      : l.startsWith('critique-') ? critique('A', false)
      : l.startsWith('chair') ? chair('A', { claims_addressed: ['U2', 'V1', 'V2', 'V3', 'V4', 'V5'] }) : undefined),
    expect: { status: 'ok', relation: 'wrong', head: 'No.', ran: ['premise_audit', 'verify', 'critique', 'audit'], challenge: true, flipsJustified: 1 },
  },
  split_keeps_dissent_verbatim: {
    reply: withBase((l) => l === 'framer' ? framing({ user_stance_option: null })
      : l === 'seat-practitioner' ? member('N', 'high') : l.startsWith('seat-') ? member('A')
      : l.startsWith('verify-') ? verify('unverifiable', false)
      : l.startsWith('critique-') ? critique('A', l.includes('practitioner'), { kind: 'peer_argument', ref: 'A.C1', evidence: 'they convinced me' })
      : l.startsWith('dissent-') ? { statement: 'DISSENT-VERBATIM: doing nothing is right because X', still_holds: true, evidence_refs: [], would_be_right_if: 'if X', concession_record: null }
      : l.startsWith('chair') ? chair('A', { minority_report: { exists: true, position: 'N', strongest_argument: 'one analyst had mild reservations', why_not_adopted: 'outvoted on evidence', would_be_right_if: 'if X' } })
      : undefined),
    expect: { status: 'ok', relation: 'no_stated_position', head: 'Answer:', ran: ['dissent_lead', 'critique'], minority: true, flipsUnjustified: 1, reportIncludes: 'DISSENT-VERBATIM', reportExcludes: 'mild reservations' },
  },
  chair_drops_minority_report: {
    reply: withBase((l) => l === 'seat-practitioner' ? member('N', 'high') : l.startsWith('seat-') ? member('A')
      : l.startsWith('verify-') ? verify('unverifiable', false) : l.startsWith('critique-') ? critique(l.includes('practitioner') ? 'N' : 'A', false)
      : l.startsWith('dissent-') ? { statement: 'DISSENT-VERBATIM: N is right', still_holds: true, evidence_refs: [], would_be_right_if: 'if X', concession_record: null }
      : l.startsWith('chair') ? chair('A') : undefined),
    expect: { status: 'ok', minority: true, reportIncludes: 'DISSENT-VERBATIM' },
  },
  needs_clarification_referents: {
    args: { question_raw: 'should we go with the new approach or keep what we have?', user_stance: null, context: null },
    reply: withBase((l) => l === 'framer' ? framing({ user_stance_option: null, user_claims: [], unresolvable_referents: ['the new approach', 'what we have'], answer_diverges_across_readings: true, clarifying_question: 'What are the new approach and the current one?', readings: [{ id: 'R1', literal_ask: 'adopt approach A', underlying_goal: 'g', probability: 0.4, how_answer_differs: 'x' }, { id: 'R2', literal_ask: 'adopt approach B', underlying_goal: 'g2', probability: 0.35, how_answer_differs: 'y' }] })
      : l === 'reading-reconciler' ? { clusters: [{ id: 'R1', literal_ask: 'adopt approach A', underlying_goal: 'g', mean_p: 0.4, support: ['framer'], how_answer_differs: 'x' }, { id: 'R2', literal_ask: 'adopt approach B', underlying_goal: 'g2', mean_p: 0.35, support: ['framer', 'outsider'], how_answer_differs: 'y' }] } : undefined),
    expect: { status: 'needs_clarification', maxAgents: 3, reportIncludes: 'the new approach', reportExcludes: 'Reply with a number' },
  },
  genuine_divergence_clarifies: {
    reply: withBase((l) => l === 'framer' ? framing({ answer_diverges_across_readings: true, clarifying_question: 'Which do you mean?' })
      : l === 'reading-reconciler' ? { clusters: [{ id: 'R1', literal_ask: 'a', underlying_goal: 'g', mean_p: 0.5, support: ['framer'], how_answer_differs: 'x' }, { id: 'R2', literal_ask: 'b', underlying_goal: 'g2', mean_p: 0.4, support: ['outsider'], how_answer_differs: 'y' }] } : undefined),
    expect: { status: 'needs_clarification', maxAgents: 3, reportIncludes: 'Reply with a number' },
  },
  clarified_resume_no_loop: {
    args: { question_raw: 'should we go with the new approach or keep what we have?', user_stance: null, context: null, clarification: { reading_id: 2 }, clarification_round: 1 },
    reply: withBase((l) => l === 'framer' ? framing({ user_stance_option: null, user_claims: [], unresolvable_referents: ['the new approach'], answer_diverges_across_readings: true })
      : l === 'reading-reconciler' ? { clusters: [{ id: 'R1', literal_ask: 'a', underlying_goal: 'g', mean_p: 0.5, support: ['framer'], how_answer_differs: 'x' }, { id: 'R2', literal_ask: 'b', underlying_goal: 'g2', mean_p: 0.5, support: ['framer'], how_answer_differs: 'y' }] }
      : l.startsWith('seat-') ? member('A') : l.startsWith('chair') ? chair('A') : undefined),
    expect: { status: 'ok', readingUsed: 'R2' },
  },
  missing_facts_do_not_block: {
    reply: withBase((l) => l === 'framer' ? framing({ missing_facts: ['whether the endpoint was profiled', 'the Python build'], answer_diverges_across_readings: true })
      : l === 'reading-reconciler' ? { clusters: [{ id: 'R1', literal_ask: 'whether to do the proposed change', underlying_goal: 'g', mean_p: 0.55, support: ['framer'], how_answer_differs: null }, { id: 'R2', literal_ask: 'b', underlying_goal: 'g2', mean_p: 0.15, support: ['outsider'], how_answer_differs: 'y' }] } : undefined),
    expect: { status: 'ok', relation: 'right', seatPromptIncludes: 'whether the endpoint was profiled' },
  },
  divergent_reading_gets_alt_answer: {
    reply: withBase((l) => l === 'framer' ? framing({ answer_diverges_across_readings: true })
      : l === 'reading-reconciler' ? { clusters: [{ id: 'R1', literal_ask: 'whether to do the proposed change', underlying_goal: 'g', mean_p: 0.65, support: ['framer', 'outsider'], how_answer_differs: null }, { id: 'R2', literal_ask: 'the other reading', underlying_goal: 'g2', mean_p: 0.35, support: ['outsider'], how_answer_differs: 'y' }] }
      : l.startsWith('chair') ? chair('P', { alt_reading_answer: 'ALT-ANSWER for the other reading' }) : undefined),
    expect: { status: 'ok', seatPromptIncludes: 'alt_reading_answer for R2', reportIncludes: 'ALT-ANSWER' },
  },
  fable_unavailable_fallback: {
    reply: (l, m, p) => m === 'fable' ? null : base()(l, m, p),
    expect: { status: 'ok', relation: 'right', confidenceMax: 'medium', degraded: true },
  },
  deep_mode_not_degraded_by_design: {
    args: { ultracode: true },
    reply: withBase((l) => l.startsWith('seat-') ? member('P', 'high', { claims: [{ id: 'C1', text: 'checked claim', load_bearing: true, status: 'verified_tool', evidence: 'file.py:12' }] }) : l === 'red-team' ? redteam('withstands') : undefined),
    expect: { status: 'ok', mode: 'deep', seats: 5, degraded: false, confidence: 'high', ran: ['red_team', 'audit'] },
  },
  seat_failing_everywhere_is_degraded: {
    reply: (l, m, p) => l === 'seat-practitioner' ? null : base()(l, m, p),
    expect: { status: 'ok', degraded: true, confidenceMax: 'medium' },
  },
  override_fixed_by_chair: {
    reply: withBase((l) => l === 'chair' || l === 'chair-repair' ? chair('N') : l === 'chair-fix' ? chair('P', { headline: 'FIXED-HEADLINE' }) : undefined),
    expect: { status: 'ok', relation: 'right', addendum: true, recommended: 'P', reportIncludes: 'FIXED-HEADLINE', reportExcludes: 'Do N.' },
  },
  override_synthesised_when_chair_refuses: {
    reply: withBase((l) => l.startsWith('chair') ? chair('N') : undefined),
    expect: { status: 'ok', relation: 'right', addendum: true, recommended: 'P', reportIncludes: 'leading position is', reportExcludes: '**Council verdict: Yes, you\'re right.** Do N.' },
  },
  override_with_record_that_supports_leader_is_rejected: {
    reply: withBase((l) => l.startsWith('chair') && l !== 'chair-fix' ? chair('A', { overrides: [{ departs_from: 'P', basis_ref: 'V2' }] }) : l === 'chair-fix' ? chair('P') : undefined),
    expect: { status: 'ok', addendum: true, recommended: 'P' },
  },
  leader_claims_verified_false_caps_confidence: {
    reply: withBase((l) => l.startsWith('verify-claim') ? verify('false') : undefined),
    expect: { status: 'ok', confidence: 'low', ran: ['audit'] },
  },
  herding_flip_is_not_justified: {
    reply: withBase((l) => l === 'framer' ? framing({ user_stance_option: null })
      : l === 'seat-practitioner' ? member('N') : l.startsWith('seat-') ? member('A')
      : l.startsWith('verify-U2') ? verify('unverifiable', false) : l.startsWith('verify-') ? verify('true')
      : l === 'critique-practitioner-r1' ? critique('A', true, { kind: 'verification_record', ref: 'V2', evidence: 'V2' })
      : l.startsWith('critique-') ? critique('A', false)
      : l.startsWith('dissent-') ? { statement: 'N is still right', still_holds: true, evidence_refs: [], would_be_right_if: 'if', concession_record: null }
      : l.startsWith('chair') ? chair('A') : undefined),
    expect: { status: 'ok', flipsUnjustified: 1, minority: true },
  },
  refined_proposal_is_yes_with_changes: {
    reply: withBase((l) => l.startsWith('seat-') ? member('A') : l.startsWith('chair') ? chair('A', { refines_option_ids: ['P'] }) : l === 'audit' ? { passed: true, problems: [] } : undefined),
    expect: { status: 'ok', relation: 'right_with_changes', head: 'Yes, with changes.', noChallenge: true },
  },
  unbacked_blockers_are_demoted: {
    reply: withBase((l) => l.startsWith('chair') ? chair('P', { caveats: [{ text: 'fake verified blocker', severity: 'blocking', basis: 'verified', evidence_ref: 'V99' }, { text: 'lone consensus blocker', severity: 'blocking', basis: 'seat_consensus', evidence_ref: null }] }) : undefined),
    expect: { status: 'ok', relation: 'right', head: 'Yes, you\'re right.' },
  },
  red_team_fails_but_refuted_does_not_floor_confidence: {
    reply: withBase((l) => l === 'red-team' ? redteam('fails', true) : l.startsWith('verify-RT') ? verify('false') : l.startsWith('seat-') ? member('P', 'high', { claims: [{ id: 'C1', text: 'checked', load_bearing: true, status: 'verified_tool', evidence: 'f.py:1' }] }) : undefined),
    expect: { status: 'ok', confidence: 'high' },
  },
  outside_seat_votes_only: {
    args: { outside: { enabled: true, models: ['opencode/gpt-5.5'], consent_quote: 'yes include gpt' } },
    reply: withBase((l) => l === 'outside-seat-1' ? { status: 'ok', model: 'opencode/gpt-5.5', exit_code: 0, text: 'RECOMMENDATION: O1\nCONFIDENCE: high\nANSWER: do it', error: null }
      : l === 'outside-seat-1-extract' ? member('P', 'medium') : undefined),
    expect: { status: 'ok', relation: 'right', families: 2, outsideCalls: 1, redTeamModel: 'opus', noLabelPrefix: 'outside-red' },
  },
  outside_absent_is_disclosed: {
    args: { outside: { enabled: true, models: ['opencode/gpt-5.5'] } },
    reply: withBase((l) => l === 'outside-seat-1' ? { status: 'absent', model: 'opencode/gpt-5.5', exit_code: 3, text: '', error: 'timed out after 240s' } : undefined),
    expect: { status: 'ok', relation: 'right', families: 1, reportIncludes: 'opencode/gpt-5.5 absent' },
  },
  outside_dissenter_is_quoted_not_ventriloquised: {
    args: { outside: { enabled: true, models: ['opencode/gpt-5.5'] } },
    reply: withBase((l) => l === 'outside-seat-1' ? { status: 'ok', model: 'opencode/gpt-5.5', exit_code: 0, text: 'RECOMMENDATION: O3', error: null }
      : l === 'outside-seat-1-extract' ? member('N', 'high', { answer: 'OUTSIDE-OWN-WORDS' }) : l.startsWith('critique-') ? critique('P', false) : undefined),
    expect: { status: 'ok', reportIncludes: 'OUTSIDE-OWN-WORDS', noLabelPrefix: 'dissent-outside' },
  },
  quorum_failure: {
    reply: withBase((l) => l.startsWith('seat-') ? null : undefined),
    expect: { status: 'insufficient' },
  },
  budget_forces_quick: {
    budget: 120000,
    reply: base(),
    expect: { status: 'ok', mode: 'quick', notRan: ['red_team'] },
  },
  agent_throws_then_recovers: {
    reply: (l, m, p) => { if (l === 'seat-practitioner' && m === 'sonnet') throw new Error('schema retries exhausted'); return base()(l, m, p) },
    expect: { status: 'ok', relation: 'right', degraded: true },
  },
  alternatives_clustered: {
    reply: withBase((l) => l === 'seat-practitioner' ? member(null, 'high', { alternative: 'profile the endpoint first' })
      : l === 'seat-first_principles' ? member(null, 'high', { alternative: 'measure before rewriting anything' })
      : l === 'alt-clusterer' ? { clusters: [{ member_keys: ['K1', 'K2'], label: 'measure first', maps_to_option: 'A' }] }
      : l.startsWith('critique-') ? critique(l.includes('premise') ? 'P' : 'A', false)
      : l.startsWith('dissent-') ? { statement: 'P because', still_holds: true, evidence_refs: [], would_be_right_if: 'if', concession_record: null }
      : l.startsWith('chair') ? chair('A') : undefined),
    expect: { status: 'ok', relation: 'wrong', recommended: 'A' },
  },
  unrelated_working_directory_is_off_limits: {
    args: { context: { summary: 'a service with a problem', files: [], urls: [] } },
    reply: base(),
    expect: { status: 'ok', seatPromptIncludes: 'current working directory is NOT the system', seatPromptExcludes: 'read the code, run' },
  },
  repo_question_allows_reading_code: {
    args: { context: { summary: 'this repository', files: ['src/app.py'], urls: [], repo: true } },
    reply: base(),
    expect: { status: 'ok', seatPromptIncludes: 'read the code, run', seatPromptExcludes: 'is NOT the system' },
  },
  false_premise_right_plan_is_wrong_reason: {
    reply: withBase((l) => l.startsWith('verify-U2') ? verify('false') : l.startsWith('chair') ? chair('P', { option_assessments: [{ option_id: 'P', verdict: 'sound_with_changes', note: 'n' }, { option_id: 'A', verdict: 'partly_sound', note: 'n' }, { option_id: 'N', verdict: 'unsound', note: 'n' }] }) : undefined),
    expect: { status: 'ok', relation: 'right_conclusion_wrong_reason', head: 'Yes, but not for the reason you gave.' },
  },
  clarification_offers_interim_guidance: {
    args: { question_raw: 'should we go with the new approach or keep what we have?', user_stance: null, context: null },
    reply: withBase((l) => l === 'framer' ? framing({ user_stance_option: null, user_claims: [], unresolvable_referents: ['the new approach'], clarifying_question: 'What is the new approach?', interim_guidance: 'INTERIM: keep what you have unless the new approach fixes a named problem.' }) : undefined),
    expect: { status: 'needs_clarification', reportIncludes: 'INTERIM: keep what you have' },
  },
  flipped_seat_claims_do_not_back_the_new_position: {
    reply: withBase((l) => l === 'seat-practitioner' ? member('P') : l.startsWith('seat-') ? member('A')
      : l.startsWith('verify-U2') ? verify('true') : l === 'verify-claim-1' ? verify('false') : l.startsWith('verify-') ? verify('true')
      : l === 'critique-practitioner-r1' ? critique('A', true, { kind: 'verification_record', ref: 'V2', evidence: 'V2 refutes my C1' })
      : l.startsWith('critique-') ? critique('A', false)
      : l.startsWith('chair') && l !== 'chair-fix' ? chair('P', { overrides: [{ departs_from: 'A', basis_ref: 'V2' }] }) : l === 'chair-fix' ? chair('A') : undefined),
    expect: { status: 'ok', recommended: 'A', addendum: true, flipsJustified: 1, notRan: [] },
  },
  valid_override_reports_the_real_minority: {
    reply: withBase((l) => l === 'framer' ? framing({ user_stance_option: null })
      : l === 'seat-practitioner' ? member('A', 'high', { answer: 'MINORITY-A-ARG' }) : l.startsWith('seat-') ? member('P', 'high', { answer: 'MAJORITY-P-ARG' })
      : l.startsWith('verify-U2') ? verify('true') : l === 'verify-claim-1' ? verify('true') : l.startsWith('verify-claim') ? verify('false') : l.startsWith('verify-') ? verify('true')
      : l.startsWith('critique-') ? critique(l.includes('practitioner') ? 'A' : 'P', false)
      : l.startsWith('dissent-') ? { statement: 'MINORITY-A-ARG', still_holds: true, evidence_refs: [], would_be_right_if: 'if', concession_record: null }
      : l.startsWith('chair') ? chair('A', { overrides: [{ departs_from: 'P', basis_ref: 'V3' }] }) : undefined),
    expect: { status: 'ok', recommended: 'A', minority: true, reportIncludes: 'MAJORITY-P-ARG' },
  },
  synthesised_verdict_uses_leader_reasons_only: {
    reply: withBase((l) => l.startsWith('seat-') ? member('P', 'high', { answer: 'LEADER-REASON' }) : l.startsWith('chair') ? chair('N', { why: ['N-WHY-SENTINEL'], confidence_basis: 'N-BASIS-SENTINEL' }) : undefined),
    expect: { status: 'ok', recommended: 'P', addendum: true, reportIncludes: 'LEADER-REASON', reportExcludesInWhy: 'N-WHY-SENTINEL', reportExcludes: 'N-BASIS-SENTINEL' },
  },
  audit_repair_cannot_reintroduce_unbacked_blockers: {
    args: { ultracode: true },
    reply: withBase((l) => l === 'audit' ? { passed: false, problems: [{ check: 'fact_attrition', detail: 'missing a claim' }] }
      : l === 'chair-audit-repair' ? chair('P', { caveats: [{ text: 'FAKE-VERIFIED-BLOCKER', severity: 'blocking', basis: 'verified', evidence_ref: 'V99' }, { text: 'FAKE-CONSENSUS-BLOCKER', severity: 'blocking', basis: 'seat_consensus', evidence_ref: null }] }) : undefined),
    expect: { status: 'ok', relation: 'right', head: 'Yes, you\'re right.', auditRepaired: true },
  },
  clarification_number_means_displayed_position: {
    args: { question_raw: 'should we go with the new approach or keep what we have?', user_stance: null, context: null, clarification: { reading_id: 1 }, clarification_round: 1 },
    reply: withBase((l) => l === 'framer' ? framing({ user_stance_option: null, user_claims: [], answer_diverges_across_readings: true })
      : l === 'reading-reconciler' ? { clusters: [{ id: 'R1', literal_ask: 'READING-ALPHA', underlying_goal: 'g', mean_p: 0.4, support: ['framer'], how_answer_differs: 'x' }, { id: 'R2', literal_ask: 'READING-BETA', underlying_goal: 'g2', mean_p: 0.5, support: ['framer'], how_answer_differs: 'y' }] }
      : l.startsWith('seat-') ? member('A') : l.startsWith('chair') ? chair('A') : undefined),
    expect: { status: 'ok', readingAsk: 'READING-BETA' },
  },
  chair_cannot_swap_leading_alternative_for_its_own: {
    reply: withBase((l) => l === 'seat-practitioner' ? member(null, 'high', { alternative: 'profile the endpoint first' })
      : l === 'seat-first_principles' ? member(null, 'high', { alternative: 'measure before rewriting anything' })
      : l === 'alt-clusterer' ? { clusters: [{ member_keys: ['K1', 'K2'], label: 'measure first before changing anything', maps_to_option: null }] }
      : l.startsWith('critique-') ? critique(l.includes('premise') ? 'P' : null, false)
      : l.startsWith('dissent-') ? { statement: 'P because', still_holds: true, evidence_refs: [], would_be_right_if: 'if', concession_record: null }
      : l === 'chair' || l === 'chair-repair' ? chair(null, { headline: 'Rewrite it in Go.', answer: 'Go.', alternative: 'rewrite the whole service in Go', option_assessments: [{ option_id: 'P', verdict: 'unsound', note: 'n' }, { option_id: 'A', verdict: 'unsound', note: 'n' }, { option_id: 'N', verdict: 'unsound', note: 'n' }] })
      : l === 'chair-fix' ? chair(null, { headline: 'Measure first.', answer: 'Measure before changing anything.', alternative: 'measure first before changing anything', option_assessments: [{ option_id: 'P', verdict: 'partly_sound', note: 'n' }, { option_id: 'A', verdict: 'partly_sound', note: 'n' }, { option_id: 'N', verdict: 'unsound', note: 'n' }] }) : undefined),
    expect: { status: 'ok', addendum: true, reportExcludes: 'rewrite the whole service in Go**' },
  },
  red_team_unfalsifiable_blocker_does_not_floor_confidence: {
    reply: withBase((l) => l === 'red-team' ? { verdict_on_leader: 'fails', failure_modes: [{ id: 'F1', scenario: 'vague doom', likelihood: 'high', blocking: true, factual_claim: null, mitigation: null }], conditions_where_leader_right: 'x', conditions_where_leader_wrong: 'y' }
      : l.startsWith('seat-') ? member('P', 'high', { claims: [{ id: 'C1', text: 'checked', load_bearing: true, status: 'verified_tool', evidence: 'f.py:1' }] }) : undefined),
    expect: { status: 'ok', confidence: 'high' },
  },
  abstention_is_visible_and_caps_confidence: {
    reply: withBase((l) => l === 'seat-practitioner' ? member(null, 'low', { stance: 'insufficient_information', answer: 'ABSTAIN-REASON: need the profile' }) : l.startsWith('seat-') ? member('P', 'high', { claims: [{ id: 'C1', text: 'checked', load_bearing: true, status: 'verified_tool', evidence: 'f.py:1' }] }) : undefined),
    expect: { status: 'ok', confidenceMax: 'medium', reportIncludes: '1 abstained', reportIncludes2: 'ABSTAIN-REASON' },
  },
  conceding_dissenter_is_labelled: {
    reply: withBase((l) => l === 'seat-practitioner' ? member('N', 'high', { answer: 'ORIGINAL-N-CASE' }) : l.startsWith('seat-') ? member('A')
      : l.startsWith('verify-') ? verify('unverifiable', false) : l.startsWith('critique-') ? critique(l.includes('practitioner') ? 'N' : 'A', false)
      : l.startsWith('dissent-') ? { statement: 'I CONCEDE', still_holds: false, evidence_refs: [], would_be_right_if: 'n/a', concession_record: 'V1' }
      : l.startsWith('chair') ? chair('A') : undefined),
    expect: { status: 'ok', reportIncludes: 'ORIGINAL-N-CASE', reportIncludes2: 'withdrew the position', reportExcludes: 'I CONCEDE' },
  },
  false_claim_against_users_course_is_not_wrong_reason: {
    reply: withBase((l) => l === 'framer' ? framing({ user_claims: [{ id: 'U1', claim_third_person: 'A cost of the proposal', load_bearing: true, checkable: true, supports_user_course: false }] })
      : l.startsWith('verify-U1') ? verify('false') : undefined),
    expect: { status: 'ok', relation: 'right', head: 'Yes, you\'re right.' },
  },
  ballot_quoting_the_stance_is_scrubbed: {
    reply: withBase((l) => l === 'seat-practitioner' ? member('P', 'high', { claims: [{ id: 'C1', text: 'the plan doc says so', load_bearing: true, status: 'verified_tool', evidence: 'docs/plan.md:3 "I\'m pretty sure the proposed change is the obvious call"' }] }) : undefined),
    expect: { status: 'ok' },
  },
  skipped_steps_are_reported: {
    budget: 120000,
    reply: withBase((l) => l.startsWith('verify-claim') ? verify('unverifiable', false) : undefined),
    expect: { status: 'ok', mode: 'quick', reportIncludes: 'quick mode' },
  },
  audit_catches_manufactured_disagreement: {
    reply: withBase((l) => l.startsWith('seat-') ? member('A') : l === 'chair' ? chair('A') : l.startsWith('chair') ? chair('A', { headline: 'repaired' })
      : l === 'audit' ? { passed: false, problems: [{ check: 'manufactured_disagreement', detail: 'rejects P on recalled claims only' }] } : undefined),
    expect: { status: 'ok', relation: 'wrong', confidenceMax: 'medium', auditRepaired: true },
  },
  leaky_reading_is_repaired_before_seats: {
    reply: withBase((l) => l === 'reading-reconciler' ? { clusters: [{ id: 'R1', literal_ask: 'confirm that the proposed change is right', underlying_goal: 'wants reassurance on a change they have already decided on LEAKSENTINEL', mean_p: 0.9, support: ['framer', 'outsider'], how_answer_differs: null }] } : undefined),
    expect: { status: 'ok', relation: 'right', sentinelOnlyIn: { LEAKSENTINEL: ['framer', 'reader-', 'reading-reconciler', 'framing-repair'] } },
  },
  attributed_claims_and_labels_are_neutralised: {
    reply: withBase((l) => l === 'framer' ? framing({ user_claims: [{ id: 'U1', claim_third_person: 'The asker believes the proposed change is right ATTRIBSENTINEL', load_bearing: true, checkable: false, supports_user_course: true }], options: [{ id: 'O1', label: 'the proposed change, the user prefers' }, { id: 'O2', label: LABELS.A }, { id: 'O3', label: LABELS.N }] }) : undefined),
    expect: { status: 'ok', sentinelOnlyIn: { ATTRIBSENTINEL: ['framer', 'framing-repair'], 'the user prefers': ['framer', 'framing-repair'] } },
  },
  leaky_context_summary_is_repaired: {
    args: { context: { summary: 'The user is confident that the proposed change is the obvious call. SUMMARYSENTINEL', files: [], urls: [] } },
    reply: base(),
    expect: { status: 'ok', sentinelOnlyIn: { 'obvious call': ['framer', 'reader-', 'framing-repair'] } },
  },
  blinding_failure_is_disclosed: {
    reply: withBase((l, m, p) => l.startsWith('framing-repair') ? { items: [...p.matchAll(/"id": "([^"]+)"/g)].map(x => ({ id: x[1], text: 'I think this is obviously right' })) } : l === 'framer' ? framing({ neutral_question: 'I think the proposed change is obviously right?' }) : undefined),
    expect: { status: 'ok', confidence: 'low', reportIncludes: 'Caution: some of your stated view' },
  },
  string_args_are_parsed: {
    argsRaw: JSON.stringify({ ...BASE_ARGS, mode: 'quick' }),
    reply: base(),
    expect: { status: 'ok', mode: 'quick' },
  },
  internal_ids_do_not_reach_the_report: {
    reply: withBase((l) => l.startsWith('chair') ? chair('P', { answer: 'Do P now (V1, V2). The A.C1 claim was wrong; see U2.', why: ['Because V1 holds (V1)'] }) : undefined),
    expect: { status: 'ok', reportExcludes: '(V1, V2)', reportExcludes2: 'A.C1' },
  },
}

const BANDS = ['low', 'medium', 'high']
async function runScenario(name, sc) {
  const args = sc.argsRaw || { ...BASE_ARGS, ...(sc.args || {}) }
  const argObj = typeof args === 'string' ? JSON.parse(args) : args
  const calls = [], problems = []
  let spent = 0
  const budget = { total: sc.budget ?? null, spent: () => spent, remaining: () => (sc.budget == null ? Infinity : Math.max(0, sc.budget - spent)) }
  const idsIn = prompt => {
    const m = new Map()
    for (const x of prompt.matchAll(/(?:^|\| )(O\d+): ([^|\n]+)/gm)) m.set(x[2].trim(), x[1])
    for (const x of prompt.matchAll(/"id": "(O\d+)",\s*"label": "([^"]+)"/g)) m.set(x[2].trim(), x[1])
    return m
  }
  const resolveTokens = (obj, prompt) => {
    const ids = idsIn(prompt)
    const tok = t => (typeof t === 'string' && LABELS[t]) ? (ids.get(LABELS[t]) || [...ids.entries()].find(([k]) => k.startsWith(LABELS[t]))?.[1] || t) : t
    const walk = o => {
      if (Array.isArray(o)) return o.map(walk)
      if (!o || typeof o !== 'object') return o
      const r = {}
      for (const [k, v] of Object.entries(o)) r[k] = ['recommended_option_id', 'option_id', 'maps_to_option'].includes(k) ? tok(v) : k === 'refines_option_ids' ? v.map(tok) : walk(v)
      return r
    }
    return walk(obj)
  }
  const agent = async (prompt, opts) => {
    calls.push({ label: opts.label, model: opts.model, prompt })
    spent += 3000
    for (const e of schemaWellFormed(opts.schema || {})) problems.push(`schema for ${opts.label}: ${e}`)
    const blindOK = opts.label === 'framer' || opts.label.startsWith('reader-')
    if (!blindOK && prompt.includes(argObj.question_raw)) problems.push(`${opts.label} saw the raw request`)
    if (!blindOK && argObj.user_stance && argObj.user_stance.verbatim && prompt.includes(argObj.user_stance.verbatim) && !opts.label.startsWith('framing-repair')) problems.push(`${opts.label} saw the stance`)
    if (prompt.includes('HOST-PRIOR-SENTINEL')) problems.push(`${opts.label} saw host_prior`)
    if (/\bright\?/.test(prompt) && !blindOK && !opts.label.startsWith('framing-repair')) problems.push(`${opts.label} prompt contains "right?"`)
    let out = sc.reply(opts.label, opts.model, prompt)
    if (out === undefined && opts.label === 'crux-dedupe') out = { keep_refs: [...prompt.matchAll(/"ref": "([^"]+)"/g)].map(m => m[1]).slice(0, 3) }
    if (out === undefined) { problems.push(`no mock for ${opts.label} (${opts.model})`); return null }
    if (out === null) return null
    const copy = resolveTokens(JSON.parse(JSON.stringify(out)), prompt)
    for (const e of validate(opts.schema, copy)) problems.push(`mock for ${opts.label} invalid: ${e}`)
    return copy
  }
  const parallel = thunks => Promise.all(thunks.map(t => Promise.resolve().then(t).catch(e => { problems.push('thunk threw: ' + e.message); return null })))
  const pipeline = (items, ...stages) => Promise.all(items.map(async (it, i) => {
    let r = it
    for (const st of stages) { try { r = await st(r, it, i) } catch (e) { problems.push('stage threw: ' + e.message); return null } }
    return r
  }))
  let result
  try { result = await script(agent, parallel, pipeline, () => {}, () => {}, args, budget) } catch (e) { return { name, ok: false, problems: [`SCRIPT THREW: ${e.stack}`], calls } }
  const x = sc.expect
  const fail = m => problems.push(m)
  const idOf = t => { const o = (result.interpretation && result.interpretation.options || []).find(o => o.label.startsWith(LABELS[t])); return o ? o.id : null }
  const rep = result.report_markdown || ''
  if (x.status && result.status !== x.status) fail(`status ${result.status} != ${x.status} ${result.error || result.reason || ''}`)
  if (x.mode && result.mode !== x.mode) fail(`mode ${result.mode} != ${x.mode}`)
  if (x.relation && result.relation_to_user !== x.relation) fail(`relation ${result.relation_to_user} != ${x.relation}`)
  if (x.head && !rep.startsWith(`**Council verdict: ${x.head}**`)) fail(`headline wrong: ${rep.split('\n')[0]}`)
  const ranNames = (result.process && result.process.ran || []).map(r => r.name)
  for (const r of x.ran || []) if (!ranNames.includes(r)) fail(`expected ${r} to run; ran: ${ranNames.join(',')}`)
  for (const r of x.notRan || []) if (ranNames.includes(r)) fail(`expected ${r} NOT to run`)
  if (x.challenge && !result.caller_challenge) fail('expected caller_challenge')
  if (x.noChallenge && result.caller_challenge) fail('unexpected caller_challenge')
  if (x.minority && !(result.minority_report && result.minority_report.exists)) fail('expected minority report')
  if (x.flipsJustified != null && result.flips.filter(f => f.justified).length !== x.flipsJustified) fail(`justified flips ${result.flips.filter(f => f.justified).length}`)
  if (x.flipsUnjustified != null && result.flips.filter(f => f.changed && !f.justified).length !== x.flipsUnjustified) fail(`unjustified flips ${result.flips.filter(f => f.changed && !f.justified).length}`)
  if (x.maxAgents != null && calls.length > x.maxAgents) fail(`${calls.length} agents > ${x.maxAgents}`)
  if (x.readingUsed && result.interpretation.reading_used.id !== x.readingUsed) fail(`reading ${result.interpretation.reading_used.id}`)
  if (x.confidence && result.verdict.confidence !== x.confidence) fail(`confidence ${result.verdict.confidence} != ${x.confidence}`)
  if (x.confidenceMax && BANDS.indexOf(result.verdict.confidence) > BANDS.indexOf(x.confidenceMax)) fail(`confidence ${result.verdict.confidence} > ${x.confidenceMax}`)
  if (x.degraded != null && result.process.diversity.degraded !== x.degraded) fail(`degraded ${result.process.diversity.degraded}`)
  if (x.addendum && !result.chair_addendum) fail('expected chair addendum')
  if (x.recommended && result.verdict.recommended_option_id !== idOf(x.recommended)) fail(`recommended ${result.verdict.recommended_option_id}, expected ${x.recommended}=${idOf(x.recommended)}`)
  if (x.families != null && result.tally.families.length !== x.families) fail(`families ${result.tally.families}`)
  if (x.outsideCalls != null && result.process.outside.calls.length !== x.outsideCalls) fail(`outside calls ${result.process.outside.calls.length}`)
  if (x.redTeamModel && (!result.red_team || result.red_team.model !== x.redTeamModel)) fail(`red team model ${result.red_team && result.red_team.model}`)
  if (x.noLabelPrefix && calls.some(c => c.label.startsWith(x.noLabelPrefix))) fail(`an agent labelled ${x.noLabelPrefix}* ran`)
  if (x.seats != null && result.ballots.length !== x.seats) fail(`seats ${result.ballots.length}`)
  if (x.auditRepaired && !(result.audit && result.audit.repaired)) fail('expected audit repair')
  if (x.seatPromptIncludes && !calls.some(c => c.label.startsWith('seat-') && c.prompt.includes(x.seatPromptIncludes))) fail(`seat prompts lack "${x.seatPromptIncludes}"`)
  if (x.seatPromptExcludes && calls.some(c => c.label.startsWith('seat-') && c.prompt.includes(x.seatPromptExcludes))) fail(`seat prompts contain "${x.seatPromptExcludes}"`)
  if (x.reportIncludes && !rep.includes(x.reportIncludes)) fail(`report lacks "${x.reportIncludes}"`)
  if (x.reportIncludes2 && !rep.includes(x.reportIncludes2)) fail(`report lacks "${x.reportIncludes2}"`)
  if (x.reportExcludesInWhy && (rep.split('### Why')[1] || '').split('###')[0].includes(x.reportExcludesInWhy)) fail(`Why section contains "${x.reportExcludesInWhy}"`)
  if (x.readingAsk && result.interpretation.reading_used.literal_ask !== x.readingAsk) fail(`reading used "${result.interpretation.reading_used.literal_ask}"`)
  for (const k of ['reportExcludes', 'reportExcludes2']) if (x[k] && rep.includes(x[k])) fail(`report contains "${x[k]}"`)
  if (x.sentinelOnlyIn) for (const [s, allowed] of Object.entries(x.sentinelOnlyIn)) for (const c of calls) if (c.prompt.includes(s) && !allowed.some(p => c.label.startsWith(p))) fail(`${c.label} saw "${s}"`)
  if (result.status === 'ok' && (/\bundefined\b/.test(rep) || rep.includes('[object Object]') || rep.includes('null'))) fail('report contains undefined/null/[object Object]')
  if (result.status === 'ok' && calls.some(c => c.label === 'chair' && /\b(first_principles|premise_auditor|practitioner|outside_\d)\b/.test(c.prompt))) fail('chair prompt reveals seat names')
  return { name, ok: problems.length === 0, problems, calls, result }
}

const only = process.argv.slice(2)
let failed = 0
for (const [name, sc] of Object.entries(SCENARIOS)) {
  if (only.length && !only.includes(name)) continue
  const r = await runScenario(name, sc)
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${name}  (${r.calls.length} agents${r.result ? `, status ${r.result.status}` : ''})`)
  if (!r.ok) { failed++; for (const p of [...new Set(r.problems)].slice(0, 12)) console.log('   - ' + p) }
  if (only.length && r.result && r.result.report_markdown) console.log('\n' + r.result.report_markdown + '\n')
}
console.log(failed ? `\n${failed} scenario(s) failed` : '\nall scenarios passed')
// The installed saved workflow is a copy (see install.sh); flag it when it has drifted from the repo.
try {
  const home = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME, '.claude')
  const installed = readFileSync(path.join(home, 'workflows', 'council-run.js'), 'utf8')
  const repo = readFileSync(path.join(here, '..', 'council', 'workflows', 'council.js'), 'utf8')
  console.log(installed === repo ? 'installed workflow copy is in sync' : 'WARNING: ~/.claude/workflows/council-run.js differs from the repo; run ./install.sh')
} catch { console.log('note: council-run.js is not installed (run ./install.sh)') }
process.exit(failed ? 1 : 0)
