**Council verdict: No.** Profile the endpoint in production and fix it inside Django, with caching or precomputation as the next step. Do not rewrite it in Rust, and separate Rust microservices in particular are the wrong tool.
Confidence: **medium**. All three analysts agreed, and the checks refute the premises behind the Rust options. But the root cause of this endpoint's latency is still unmeasured, so the verdict rests on documented base rates, not a diagnosis.

**What you asked:** Which course of action should be taken to reduce p95 latency (roughly 800ms) on the Django dashboard endpoint, including whether to rewrite hot paths as Rust microservices. → **what you're after:** Bring the dashboard endpoint's latency down to an acceptable level via a technical approach whose cost, risk, and maintenance burden are proportionate to the gain.

### Answer
Optimizing within Django is the right course; all three analysts agree and the evidence supports it. In order:

1. Ask whether a production profile already exists. If one shows pure-Python CPU as the main cost, go to step 5.
2. Measure the real slow tail, not staging. Use APM or OpenTelemetry traces that keep requests over about 500 ms, and run `py-spy record -o prof.svg --pid <gunicorn worker>` against one production worker. Split each slow request into SQL count and time, Python CPU, serialization, external calls and queue time, which is the load balancer's time minus the app's time. Pull p50, p95 and p99 by tenant or data size. If you use django-silk in production, set SILKY_INTERCEPT_PERCENT and SILKY_MAX_RECORDED_REQUESTS. Never expose debug-toolbar in production. Run `EXPLAIN (ANALYZE, BUFFERS)` on the top 3 queries. At the same time, get a p95 target (for example under 300 ms) and a freshness tolerance from the product owner. If 800 ms is acceptable, stop.
3. If SQL is more than half the time or there are more than about 20-30 queries, fix the queries: select_related/prefetch_related, annotate()/aggregate() instead of Python loops, values()/only(), and indexes. Heavy DRF ModelSerializer cost gets a lighter serializer or values(). If queue time dominates, change the worker count, concurrency or connection pool, not the code. Re-measure p95 after every change and timebox this step to 1-2 weeks.
4. If what remains is aggregation you can't avoid, and the data can be 30 s to 15 min stale, precompute. Options are rollup tables or materialized views refreshed by Celery or cron, or a low-level cache.set keyed per user or tenant with a TTL and stampede protection. Don't use cache_page on an authenticated dashboard. For large tenants, compute payloads in advance rather than caching them lazily, and check the hit rate on the slow requests.
5. Only if a profile taken after these fixes shows more than about 50-60% of time in pure-Python computation over already-loaded data should you consider an in-process PyO3 extension. Try numpy or Cython first. A separate Rust service is the last resort.

### Why
- Nothing shows that Python execution speed causes the 800 ms, and that is the premise both Rust options depend on. Django's own performance guide says most problems in well-written sites come from database querying, caching and templates, not Python execution.
- The claim that Python can't serve this endpoint fast enough however it is optimized was checked and found false as stated. The claim that separate services would lower end-to-end p95 was also found false: communication overhead often takes a large share of a service's latency, and the service would still pay the same database cost.
- Measuring first is cheap, reversible and needed anyway. It is the only way to tell apart the real candidates: database time, serialization, queueing and genuine CPU work. It is also what would justify any later native code.
- A dashboard is a natural candidate for precomputation. Django already has the caching tools, so the cheap second step needs no new services or languages.

### Options weighed
1. ◐ Rewrite the hot paths as Rust extension modules called in-process from Python: partly sound. This is only justified if a production profile shows more than about 50-60% of request time in pure-Python computation that can't move to SQL, numpy or a precomputed table. There is no evidence of that today.
2. ✅ Optimize the endpoint within the Django monolith (profiling-driven query, ORM, serialization and code fixes): **recommended**
3. ❌ Rewrite the hot paths as separate Rust microservices: unsound. The added network hop, serialization and duplicated data access eat into any speedup, and a separate service does nothing for database time. The check found no general case where this lowers end-to-end p95.
4. ◐ Keep the endpoint as it is: partly sound. This is acceptable only if the business confirms that 800 ms meets its target. Nobody has stated a target yet.
5. ✅ Precompute or cache dashboard data (response caching, materialized views, background aggregation jobs): sound with changes. This is a strong second step for aggregation cost that remains after the query fixes. Caching must be keyed per user or tenant, which rules out whole-page caching on an authenticated dashboard.

### Your premises, checked
| Claim | Verdict | Basis |
|---|---|---|
| Python/CPU execution time, rather than database queries, network I/O, external calls or serialization, accounts for most of the endpoint's 800 ms p95 latency. | ? not settled | could not be verified: This repository (claude-council-skill) contains no application server, no HTTP endpoint, and no profiling/latency instrumentation to check against. |
| Python is too slow to serve this dashboard endpoint at an acceptable latency, regardless of how the Python code and data access are optimized. | ❌ does not hold | Accurate version: The categorical claim "Python is too slow to serve this dashboard endpoint at an acceptable latency, regardless of how the code and data access are optimized" is false as stated: an optimized Python request handler (in-memory cache lookup + JSON serialization,… |
| Moving the hot paths into separate Rust services would lower end-to-end p95 latency, after adding inter-service network hops, serialization and any duplicated data access. | ❌ does not hold | Accurate version: Moving hot paths into separate Rust services does not generally lower end-to-end p95 latency once inter-service network hops, serialization, and any duplicated data access are counted — independent benchmarks and case studies of monolith-to-microservice… |
| The latency-dominant code is concentrated in a small set of identifiable hot paths that can be isolated from the rest of the monolith. | ◐ partly | Accurate version: In this repo (claude-council-skill), every network-latency-inducing operation (the LLM agent calls that dominate wall-clock time) funnels through one function, call() at council/workflows/council.js:110-122, invoked at roughly 20 sites spread across the… |

### Do these first
- **do first**: Profile the production slow tail, broken down by tenant and data size, not a typical user in staging. Otherwise the fixes improve the median and the p95 stays near 800 ms.
- **do first**: Agree a p95 target and a freshness tolerance before starting. The target tells you when to stop, and the freshness tolerance decides whether caching or precomputation is allowed at all.
- **do alongside**: Separate queue time and worker or connection-pool saturation from time spent in code. If queueing dominates, the fix is capacity or concurrency, not code.
- **do alongside**: Key any cache per user or tenant, and add a TTL or explicit invalidation plus stampede protection. Measure the hit rate on slow requests, not overall.
- **do alongside**: Timebox the query tuning to about 1-2 weeks. Commit in advance to precomputation if the remaining cost is aggregation that grows with data volume.
- **minor** (verified): If Rust is ever justified, keep it in-process. A separate service adds hops and serialization that offset the gain.

### Corrections to the premises
- The claim that Python is too slow for this endpoint however it is optimized is not supported. Django's guidance and base rates put most endpoint slowness in data access, which Python code can fix. No profile shows an irreducible Python CPU cost. Note that the check's own benchmark was a generic microbenchmark, not this endpoint.
- Moving the hot paths into separate Rust services does not generally lower end-to-end p95. The network hop, serialization and duplicated data access offset language speedups, and the service still pays any database cost.
- Only partly supported. The check's evidence came from unrelated orchestration code, not a Django endpoint. Whether this endpoint's time sits in a few isolatable hot paths is unknown until it is profiled.

### Where you and the council disagree
You said: "I'm pretty sure the right move is to rewrite the hot paths as Rust microservices — Python is just too slow for this. That's the obvious call, right?"
The council recommends: Optimize the endpoint within the Django monolith (profiling-driven query, ORM, serialization and code fixes).
What the council may be missing: No code, profile, schema or deployment details were available. Two of the checks rested on evidence unrelated to this endpoint: a generic Python microbenchmark, and code from a different repository. The verdict therefore rests on Django's documented guidance and on base rates, not on a diagnosis of this system. The team's Rust skills and any wider strategic reason to adopt Rust are also unknown.
Cost if the council is wrong: The cost is small: one to two weeks of measuring and tuning before moving to a native extension. The profile gathered in that time is needed to scope any native code anyway. If the council is wrong in the other direction, the cost of adopting separate Rust services would be months of work, a new toolchain and operational burden, possibly with no p95 gain.
Your call stays the default until you decide otherwise.

### Where this could be wrong
- The endpoint may really be CPU-bound on pure-Python computation over large in-memory data. In that case the Django work is a detour and an in-process extension should come sooner.
- Data volume may already have outgrown per-request aggregation, so precomputation or a read model should lead from day one.
- The p95 may come from a slow external dependency or from infrastructure, which none of the listed options addresses directly.
- Accepted risk: Confidence is held at medium because the verdict rests on a base rate, not a diagnosis. The answer first asks whether a profile already exists. Serialization-heavy CPU is still fixed inside Django before any in-process extension is considered.
- **What would change the verdict:** A production flame graph showing more than about 50-60% of slow-request time in pure-Python computation that can't move to SQL, numpy or precomputed data. That would make an in-process Rust extension the next step.; Traces showing the p95 is mostly queue time or a slow external call. That would move the work to capacity, concurrency or the dependency.; Latency that grows steadily with tenant row counts even after the query fixes, together with an acceptable freshness window. That would make precomputation the lead.

#### How the council ran
- standard mode; 3 blind seats (Claude Fable, Claude Opus, Claude Sonnet). Blind vote: 3× option 2: Optimize the endpoint within the Django monolith….
- 5 claim(s) checked with tools (1 unverifiable, 2 false, 2 partly); red team: withstands with changes; audit: passed; 15 agents. All voting seats were Claude models, so their agreement is one model family's view.
- Notes: verify overflow skipped (standard mode checks at most 5 claims).