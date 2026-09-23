**No, it isn't the obvious call.** It might turn out to be right, but nothing you've said shows yet that Python is the bottleneck. A Django dashboard endpoint at 800ms p95 is almost never slow because of the language. It's usually slow because of what the request is waiting on.

**Why "Python is too slow" is doubtful**

Where the time goes on slow Django dashboards, most common first:

1. **Database access.** This includes N+1 queries (a missing `select_related`/`prefetch_related`), filters or `ORDER BY` columns with no index, `COUNT(*)` on large tables for pagination, and aggregates computed on every request.
2. **Waiting, not computing.** Examples are external HTTP calls made one after another, cache misses, or opening a new database connection on every request (`CONN_MAX_AGE=0` is the default).
3. **Requests queueing.** If your gunicorn/uwsgi workers are saturated, p95 includes time spent waiting for a free worker. Rust doesn't fix that.
4. **Serialization.** This one really is Python CPU time, e.g. DRF building thousands of model instances. The usual fix is `.values()`, fewer fields or pagination, not a new language.

Here's the arithmetic that matters. If Python CPU time is 15% of your 800ms, an infinitely fast Rust rewrite gets you to about 680ms. And a Rust *microservice* adds a network hop and serialization on both sides. If that service still queries the same database with the same queries, you've moved the bottleneck and added operational overhead: two languages, new deploys, distributed tracing and cross-service failure modes.

**What I'd do this week**

1. **Compare p50 with p95.** If p50 is around 100ms and p95 is 800ms, you have a variance problem: queueing, cold caches, a few customers with huge datasets, or lock contention. If p50 is around 700ms, every request is doing too much work.
2. **Get a breakdown of where the time goes.** Use your APM (Sentry, Datadog, OpenTelemetry spans) to split each request into DB, external calls and Python. Run `py-spy` against a production worker; it's a sampling profiler with low overhead. Run `django-silk` or debug-toolbar locally to count queries.
3. **Fix the cheap things first.** That means query count, indexes, persistent connections and running external calls in parallel. For a dashboard specifically, add caching or precomputation (materialized views, rollup tables refreshed by a background job), and let slow widgets load separately so one widget doesn't hold up the whole page.

In my experience, steps 1–3 usually get endpoints like this well under 200ms in days, not months.

**When you'd be right**

If profiling shows most of the wall time is Python CPU in a specific hot function, and it's real computation that can't move into SQL or be solved with a better algorithm, then native code makes sense. Even then, try these first, cheapest first:

- Push the work into the database.
- Use numpy or polars (polars is Rust underneath already).
- Write a **Rust extension module with PyO3/maturin that runs inside the Django process.** You get Rust speed on the hot loop with no network hop, no new service and no second deployment.

A separate Rust microservice is justified mainly for organizational or scaling reasons: independent scaling, a different team owning it, or very different resource needs. Speed on one endpoint isn't one of those reasons.

**The strongest case against my view**

If your team already knows Rust well, you have several CPU-heavy paths coming (not just this endpoint), and you've *already profiled* and ruled out the database, then starting a Rust service now can be a defensible strategic bet. But that's a different argument from "Python is too slow for this dashboard", and it still needs the profile first.

**Bottom line:** profile before you rewrite. Come back with the time breakdown (DB vs external vs Python vs queueing) and the p50/p95 numbers, and the right move will be obvious. I'd bet it's queries or caching, not Rust.