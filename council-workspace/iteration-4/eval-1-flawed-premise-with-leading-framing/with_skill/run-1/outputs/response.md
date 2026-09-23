**Council verdict: No.** Profile the endpoint first, then optimize the existing Django code path, with precomputing or caching as the planned next step. Neither Rust rewrite is justified on current evidence.
Confidence: **medium**. All three analysts agreed, and measurements back the key points: Python overhead is small, and a service boundary costs little latency. But nobody has profiled this system, so the actual source of the 800 ms is still unknown, and confidence is capped at medium.

**What you asked:** Whether rewriting the hot paths of the Django dashboard endpoint as Rust microservices, versus other possible remediation options, is the correct course of action to address a p95 latency of roughly 800ms. → **what you're after:** Bring the dashboard endpoint's p95 latency down to an acceptable level at reasonable engineering and operational cost, via an approach that addresses the actual bottleneck rather than one that merely appears decisive.

### Answer
Profiling first and then optimizing the existing Django code is the right course. Treat caching or precomputation as the planned next step, not an afterthought. Do this in order:

1. Agree on a target and a deadline before touching code. For example: p95 under 300 ms, with a decision by the end of week 2. Also collect the current p50 and p99 and the traffic volume. If 800 ms doesn't breach any agreed target, the work may not be urgent.

2. Get a per-request breakdown from production, not only from staging:
- Run `py-spy record --idle --gil --subprocesses -o dash.svg --pid <worker>` for about 60 s under real load. Without `--idle`, time spent waiting on the database mostly disappears from the flame graph, and Python can look like the bottleneck when it isn't.
- In Docker or Kubernetes, py-spy needs SYS_PTRACE or root. Check that before week 1.
- Add django-silk or debug-toolbar for query count and SQL time.
- Add OpenTelemetry spans tagged with tenant and date range, plus queue time from the load balancer, so you can see where the slow tail comes from.

3. Fix what the profile shows:
- More than about 20 queries per request, or repeated query patterns: that's an N+1. Fix it with select_related/prefetch_related.
- Any query over about 100 ms: run EXPLAIN (ANALYZE, BUFFERS) on it and add indexes. On large Postgres tables, use AddIndexConcurrently in a non-atomic migration.
- Push aggregation into the database with annotate/aggregate.
- Use values() or only() instead of building full model objects, and use plain dicts or orjson instead of per-row serializers.
- Check CONN_MAX_AGE (it defaults to 0, meaning a new DB connection per request) and whether workers are saturated.
- Add assertNumQueries tests so the fixes don't regress.

4. Re-measure p95. If it's still over target because one aggregate is inherently expensive, move to precomputation. First find out how stale the data may be. Then either build rollup tables or a materialized view refreshed by a background job, or use the low-level cache keyed per user and tenant with a 1–5 minute TTL and invalidation on write. Don't use a bare cache_page on an authenticated dashboard.

5. Consider Rust only if the correct profile shows more than half the wall time is pure-Python computation that can't go into SQL or a precompute job. Even then, try NumPy or Polars first, then an in-process PyO3 extension. A separate Rust service is not warranted for a single endpoint.

### Why
- No evidence says the 800 ms is Python CPU time. A measured benchmark put typical request-handling overhead in Python at single-digit milliseconds, including building and serializing a 200-row payload. So 800 ms of pure interpreter work would mean very large in-memory workloads per request. Those belong in SQL or a precompute job.
- Django's own performance and database-optimization guides say to measure before optimizing. They say most slow Django sites are slowed by database access, caching and templates, not by Python execution. Rewriting in another language doesn't remove N+1 query patterns or slow scans.
- Profiling costs hours to days and carries almost no risk, and it confirms or rules out the Rust premise directly. Both rewrites commit weeks of work, and the separate-service version also adds a permanent deployable, before anyone knows where the time goes.
- A dashboard is the typical case of an expensive, rarely-changing calculation. That's why precomputing or caching is the natural fallback when query fixes reach a floor.

### Options weighed
1. ◐ Rewrite hot paths as in-process Rust extensions called from Python: partly sound. Consider this only if a profile run with idle threads included shows that most of the wall time is on-CPU Python on in-memory data that can't be moved into SQL or precomputed.
2. ✅ Optimize the existing Django code path guided by profiling (queries, ORM access patterns, indexes, serialization): **recommended**
3. ❌ Rewrite hot paths as separate Rust microservices: unsound. It carries the highest cost and operational burden: a new deployable, versioning, monitoring and new failure modes. It aims at a bottleneck nobody has found.
4. ❌ Keep the current implementation unchanged: unsound. It doesn't reduce latency at all. It is only defensible if 800 ms p95 turns out not to breach any agreed target, and nobody has checked that yet.
5. ✅ Precompute or cache dashboard data off the request path (background jobs, materialized aggregates, response caching): sound with changes. This is the strongest second step, and it becomes the main plan if the profile shows one expensive aggregate that indexes can't fix. It needs one change from the naive version: authenticated or per-tenant dashboards…

### Your premises, checked
| Claim | Verdict | Basis |
|---|---|---|
| Python is too slow a runtime to serve this dashboard endpoint at acceptable latency. | ❌ does not hold | the analysts' assessment, not tool-verified |
| Rewriting the hot paths in Rust would substantially reduce the endpoint's p95 latency, net of any added network, serialization and coordination overhead introduced by a service… | ◐ partly | the analysts' assessment, not tool-verified |

_Not settled (nobody here could check):_ Python interpreter execution time (CPU-bound work in application code) is the main contributor to the dashboard endpoint's ~800 ms p95…; The latency-critical work is concentrated in identifiable hot paths that can be cleanly separated from the rest of the monolith.

### Do these first
- **do first**: Profile before changing any code, and profile correctly. Include idle threads in py-spy (--idle) so time waiting on the database shows up. Cross-check against SQL timings from silk or tracing. Confirm SYS_PTRACE or root access in the target environment.
- **do first**: Before adding any cache or precompute step, confirm how fresh the dashboard data must be and whether it varies by user or tenant. Key caches explicitly by user and tenant, and add a two-user test that checks one user can't see another's data.
- **do alongside**: Set a numeric p95 target and a decision date before starting, and check p95 after each fix. Otherwise query tuning turns into months of small gains, and precomputation never gets scheduled.
- **do alongside**: The p95 tail may come from things staging won't show: large tenants, a cold database cache, time queued waiting for a worker, or opening a new DB connection on every request. Sample the slowest production requests and check connection reuse and worker saturation before tuning ORM code.
- **minor**: On large, busy Postgres tables, build indexes with AddIndexConcurrently in a non-atomic migration so writes aren't locked out, and check that the index is valid afterwards.
- **minor** (verified): If a Rust rewrite ever becomes justified, the case against a separate service is its operational cost, not added latency. A local round trip measured only about 0.4–1.5 ms.

### Corrections to the premises
- Python's speed isn't shown to be the limit here. Measured interpreter and JSON overhead for a typical dashboard payload was about 5–8 ms per request, which is a small fraction of 800 ms. Where the rest of the time goes is still unmeasured.
- Unverified, and unlikely on base rates. Typical per-request Python overhead is in the single-digit milliseconds, so 800 ms of Python CPU would need very large in-memory workloads. A profile with idle threads included is needed to settle it.
- Partly true. Compiled code ran a pure CPU loop about 65 times faster than Python (1155 ms vs 18 ms), and a local service round trip cost only about 0.4–1.5 ms, so network overhead wouldn't cancel a real CPU saving. But the saving only exists if the time is actually Python CPU, which hasn't been shown, and a rewrite doesn't cut database time.

### Where you and the council disagree
You said: "I'm pretty sure the right move is to rewrite the hot paths as Rust microservices — Python is just too slow for this. That's the obvious call, right?"
The council recommends: Optimize the existing Django code path guided by profiling (queries, ORM access patterns, indexes, serialization).
What the council may be missing: The slow tail may be infrastructure rather than code: workers saturating and requests queueing, connection setup, a database in another region, or noisy neighbours. The data volume may also already have outgrown on-demand OLTP aggregation, in which case a precomputed or columnar store is the real fix. Team skills and constraints are unknown too. A team that already runs Rust services changes the operational cost somewhat, but not the need to profile first.
Cost if the council is wrong: If the time really is CPU-bound Python, starting with profiling costs a few days before moving on to vectorisation or an in-process extension. The profile would then justify that work, so little is lost. The larger risk runs the other way: skipping profiling and building a Rust service could cost weeks of work and a permanent extra deployable, while the real database or queueing bottleneck stays in place.
Your call stays the default until you decide otherwise.

### Where this could be wrong
- One argument against the separate Rust service was that network and serialization overhead could rival any speedup. Measurement shows a local round trip costs about 0.4–1.5 ms, so that argument is weak. The case against it rests on operational cost and on the lack of evidence that the time is CPU.
- The evidence that Python overhead is only a few milliseconds came from a small benchmark (200 rows, standard-library JSON). It doesn't bound the cost of building ORM objects or running per-row serializers over large result sets, which can be substantial.
- The claim that database access is the usual cause is a base rate plus Django's guidance, not a measurement of this system. This endpoint could be the exception.
- **What would change the verdict:** A py-spy profile with idle threads included, taken under production load, showing more than 50–60% of wall time in on-CPU Python on in-memory data, with SQL time under about 100 ms and inputs that must be fresh on every request.; Traces showing most of the p95 is time spent queued for a worker, or connection and network latency, which would point to capacity or configuration changes instead of code changes.; EXPLAIN output showing one irreducible aggregate over a large, growing table that indexes can't bring under target, which would make precomputation the main plan from the start.

_Council: 3 blind seats (Fable, Opus, Sonnet) · blind vote 3–0 · 2 claim(s) settled with tools · red team: withstands with changes. All voting seats were Claude models, so their agreement is one model family's view._