I couldn't run the council. It needs the Workflow tool, and this session doesn't have it, so no blind votes were cast and nothing was checked by more than one model. Everything below is my own opinion. If you want the real multi-model verdict, run `/council` from a normal Claude Code session.

**My answer: no, it isn't the obvious call.** It could still turn out to be right, but only after you've tested the belief that "Python is just too slow." For a Django dashboard endpoint at 800 ms p95, that belief is usually wrong.

**Why I doubt the premise**

- **Dashboard endpoints are usually slow because of the database and I/O, not the language.** The usual causes are:
  - repeated per-row queries (N+1)
  - missing indexes
  - pulling whole tables into memory and adding them up in Python
  - external calls made one after another
  - serializing very large responses
- **A Rust service would wait on the same database.** It also adds a network hop, a second serialization step, a new deploy target, a second language, and more to support on call. It could end up slower.
- **It's p95, not p50.** If your median is much lower, the slow tail comes from specific conditions: large accounts, cache misses, lock contention, or requests queuing behind busy workers. A faster language doesn't fix any of those.

**What I'd do first (a few days, not a quarter)**

1. **Measure where the 800 ms goes on the slow requests themselves.** Use APM tracing (Sentry, Datadog, OpenTelemetry, whatever you have) to split the time into database, Python CPU, external calls and time spent waiting for a worker. Add django-silk or debug-toolbar for query counts, and run py-spy on a production-like worker for a flame graph.
2. **Fix what the measurements show.** Likely fixes:
   - `select_related` / `prefetch_related` for repeated queries
   - indexes
   - doing aggregation in SQL instead of Python
   - `.only()` / `.values()` to fetch fewer columns
   - caching or pre-computing the dashboard totals
   - running external calls in parallel
   - loading dashboard widgets separately

   Fixes like these often cut latency many times over, with no rewrite.

**When Rust would make sense**

If the profile shows most of the request time is CPU work in Python that no better algorithm fixes, Rust can be right. Even then:
- try numpy or polars first;
- then a PyO3 extension called directly from Django (no network hop) before a separate microservice.

Splitting into microservices is a decision about how you organize teams and deploys. It isn't a performance fix.

**What would change my mind:** a profile showing that more than half the time on the slow requests is Python CPU, not waiting on the database or other I/O, and that stays true after the query and caching fixes.

If you can share a trace or the view code, I can point at the likely culprit.