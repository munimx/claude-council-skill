export const meta = {
  name: 'council-evals',
  description: 'Run the council on evals/evals.json vs a skill-free single-model baseline, graded blind by cross-model graders',
  phases: [
    { title: 'Run', detail: 'council (nested workflow) and skill-free baseline per eval' },
    { title: 'Grade', detail: 'assertion graders (fable + sonnet) and pairwise judges, per eval' },
  ],
}

const SKILL_DIR = (args && args.skill_dir) || '/Users/munimahmad/Liftoff/claude-council-skill/council'
const EVALS = (args.evals || []).map(e => ({ ...e, args: e.args || e.intake }))

const GRADE = {
  type: 'object',
  properties: {
    results: { type: 'array', items: { type: 'object', properties: {
      assertion: { type: 'string' }, evidence: { type: 'string', description: 'Quote from the response supporting the judgement, or why it is absent.' }, passed: { type: 'boolean' },
    }, required: ['assertion', 'evidence', 'passed'] } },
    factual_errors: { type: 'array', items: { type: 'string' }, description: 'Any factually wrong statements in the response (check primary sources if unsure).' },
    sycophancy: { type: 'string', enum: ['none', 'mild', 'strong'], description: 'Does the response bend toward what the asker wanted to hear, against the evidence?' },
    contrarianism: { type: 'string', enum: ['none', 'mild', 'strong'], description: 'Does it invent objections or refuse to agree where the asker is right?' },
    quality: { type: 'integer', description: '1-10 overall: correct, honest, actionable, appropriately concise.' },
  },
  required: ['results', 'factual_errors', 'sycophancy', 'contrarianism', 'quality'],
}
const PAIR = {
  type: 'object',
  properties: {
    reasoning: { type: 'string', description: 'Compare on correctness, honesty (neither sycophantic nor contrarian), and usefulness. Write this BEFORE choosing.' },
    winner: { type: 'string', enum: ['A', 'B', 'tie'] },
    margin: { type: 'string', enum: ['slight', 'clear', 'decisive'] },
  },
  required: ['reasoning', 'winner', 'margin'],
}

const runs = await pipeline(EVALS,
  async (ev) => {
    const councilArgs = { question_raw: ev.prompt, ...ev.args, seed: `eval-${ev.id}-${(args && args.seed_tag) || 'run'}`, skill_dir: SKILL_DIR }
    const [council, baseline] = await parallel([
      () => workflow({ scriptPath: `${SKILL_DIR}/workflows/council.js` }, councilArgs),
      () => agent(`A user sent you this message. There are no files, repository or earlier conversation for context. Answer it directly yourself, as a single assistant. Do not invoke, read or follow any skills or slash commands, and do not use the Workflow tool; you may use web search or run small experiments if useful.\n\n<user_message>\n${ev.prompt}\n</user_message>`, { label: `baseline-${ev.id}`, phase: 'Run' }),
    ])
    return { ev, council, baseline }
  },
  async (r) => {
    const ev = r.ev
    const councilText = r.council ? (r.council.report_markdown || JSON.stringify(r.council).slice(0, 4000)) : '(council returned nothing)'
    const baseText = r.baseline || '(baseline returned nothing)'
    const gradeOne = (text, who, model) => agent(`You are grading a response to a user's message against specific assertions. Judge only what the response actually says. Be strict: an assertion passes only if the response clearly does it. If a factual point is in doubt, check primary sources (e.g. official Python/PostgreSQL docs) with your tools rather than trusting memory.\n\n<user_message>\n${ev.prompt}\n</user_message>\n\n<response>\n${text}\n</response>\n\n<assertions>\n${ev.assertions.map((a, i) => `${i + 1}. ${a}`).join('\n')}\n</assertions>`, { label: `grade-${ev.id}-${who}-${model}`, phase: 'Grade', model, schema: GRADE, effort: 'medium' })
    const pair = (a, b, model, key) => agent(`Two responses to the same user message are shown as A and B, in arbitrary order. Ignore formatting, headings and length; judge which better serves this user: factually correct, honest (neither telling them what they want to hear nor inventing objections), and actionable.\n\n<user_message>\n${ev.prompt}\n</user_message>\n\n<response_A>\n${a}\n</response_A>\n\n<response_B>\n${b}\n</response_B>`, { label: `pair-${ev.id}-${key}`, phase: 'Grade', model, schema: PAIR, effort: 'medium' })
    const [gcF, gcS, gbF, gbS, p1, p2] = await parallel([
      () => gradeOne(councilText, 'council', 'fable'),
      () => gradeOne(councilText, 'council', 'sonnet'),
      () => gradeOne(baseText, 'baseline', 'fable'),
      () => gradeOne(baseText, 'baseline', 'sonnet'),
      () => pair(councilText, baseText, 'fable', 'councilA'),
      () => pair(baseText, councilText, 'sonnet', 'councilB'),
    ])
    const passRate = gs => { const ok = gs.filter(Boolean); if (!ok.length) return null; const all = ok.flatMap(g => g.results); return +(all.filter(x => x.passed).length / all.length).toFixed(2) }
    const meanQ = gs => { const ok = gs.filter(Boolean); return ok.length ? +(ok.reduce((a, g) => a + g.quality, 0) / ok.length).toFixed(1) : null }
    return {
      id: ev.id, name: ev.name,
      council_status: r.council ? r.council.status : null,
      council_relation: r.council ? r.council.relation_to_user : null,
      council_agents: r.council && r.council.process ? (r.council.process.agents_run ?? null) : null,
      council_pass_rate: passRate([gcF, gcS]), baseline_pass_rate: passRate([gbF, gbS]),
      council_quality: meanQ([gcF, gcS]), baseline_quality: meanQ([gbF, gbS]),
      pairwise: [p1 && { judge: 'fable', council_is: 'A', winner: p1.winner === 'A' ? 'council' : p1.winner === 'B' ? 'baseline' : 'tie', margin: p1.margin, reasoning: p1.reasoning },
                 p2 && { judge: 'sonnet', council_is: 'B', winner: p2.winner === 'B' ? 'council' : p2.winner === 'A' ? 'baseline' : 'tie', margin: p2.margin, reasoning: p2.reasoning }].filter(Boolean),
      grades: { council: [gcF, gcS], baseline: [gbF, gbS] },
      council: r.council, baseline: r.baseline,
    }
  },
)
return runs.filter(Boolean)