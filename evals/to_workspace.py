#!/usr/bin/env python3
"""Turn an eval-workflow output file into the skill-creator workspace layout.

    python3 evals/to_workspace.py <workflow-output.json> <workspace>/iteration-N

Writes, per eval:  eval-<id>-<name>/{with_skill,without_skill}/run-1/{outputs/response.md, grading.json}
plus eval_metadata.json, so skill-creator's aggregate_benchmark.py and generate_review.py can read it.
Each run's expectations merge both graders (an assertion passes only if every grader passed it).
"""
import json
import os
import sys


def expectations(grades):
    grades = [g for g in grades if g]
    if not grades:
        return []
    out = []
    for i, first in enumerate(grades[0]['results']):
        rows = [g['results'][i] for g in grades if i < len(g['results'])]
        out.append({
            'text': first['assertion'],
            'passed': all(r['passed'] for r in rows),
            'evidence': ' | '.join(f"grader {k + 1}: {r['evidence']}" for k, r in enumerate(rows)),
        })
    return out


def main(src, dest):
    data = json.load(open(src))
    prompts = {e['id']: e['prompt'] for e in json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'evals.json')))['evals']}
    runs = data['result'] if isinstance(data, dict) and 'result' in data else data
    for e in runs:
        edir = os.path.join(dest, f"eval-{e['id']}-{e['name']}")
        os.makedirs(edir, exist_ok=True)
        council = e.get('council') or {}
        prompt = next((a for a in [council.get('interpretation', {}).get('neutral_question')] if a), '')
        grades = e.get('grades', {})
        for cfg, text, g in (
            ('with_skill', council.get('report_markdown') or json.dumps(council, indent=1), grades.get('council', [])),
            ('without_skill', e.get('baseline') or '', grades.get('baseline', [])),
        ):
            rdir = os.path.join(edir, cfg, 'run-1')
            os.makedirs(os.path.join(rdir, 'outputs'), exist_ok=True)
            open(os.path.join(rdir, 'outputs', 'response.md'), 'w').write(text)
            exp = expectations(g)
            passed = sum(1 for x in exp if x['passed'])
            json.dump({
                'expectations': exp,
                'summary': {'passed': passed, 'failed': len(exp) - passed, 'total': len(exp),
                            'pass_rate': round(passed / len(exp), 2) if exp else 0},
                'quality': [x.get('quality') for x in g if x],
                'sycophancy': [x.get('sycophancy') for x in g if x],
                'contrarianism': [x.get('contrarianism') for x in g if x],
                'factual_errors': [f for x in g if x for f in x.get('factual_errors', [])],
            }, open(os.path.join(rdir, 'grading.json'), 'w'), indent=1)
        json.dump({
            'eval_id': e['id'], 'eval_name': e['name'],
            'prompt': prompts.get(e['id']) or prompt,
            'assertions': [x['text'] for x in expectations(grades.get('council', []))],
            'council_status': e.get('council_status'), 'council_relation': e.get('council_relation'),
            'council_agents': e.get('council_agents'), 'pairwise': e.get('pairwise'),
        }, open(os.path.join(edir, 'eval_metadata.json'), 'w'), indent=1)
    print(f"wrote {len(runs)} evals to {dest}")


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
