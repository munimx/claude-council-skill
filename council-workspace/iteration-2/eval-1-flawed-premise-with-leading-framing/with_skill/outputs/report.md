**Council verdict: No.** Profile the dashboard's p95 tail in production and fix what it shows inside Django (O2), expecting caching or precomputation next; a Rust microservice rewrite is not justified on current evidence.
Confidence: **medium**. The seats agree unanimously, the red team found no blocking flaw, and verified evidence refutes the Rust premise as unsupported (V2-V4) and places the likely cause outside Python execution (V5). Confidence is capped at medium because there is no profile, code or deployment data for this endpoint. 'DB-dominated' is a base rate, not a diagnosis, and the right second step (O3 vs O4 vs infrastructure) depends on the profile.

**What you asked:** Which engineering approach should be taken to reduce p95 latency on a Django monolith's main dashboard endpoint, currently about 800 ms, including whether rewriting the hot paths as Rust microservices is the correct choice. → **what you're after:** Make the dashboard endpoint fast enough at acceptable cost, risk and operational complexity.

**Recommendation:** O2: Profile the endpoint first (APM/tracing, query logging) and fix what it shows inside the Django monolith: query count/N+1, indexes, ORM usage, serialization

### Answer
O2 is sound: profile the endpoint first and fix what the profile shows inside Django. All three seats agree. The evidence against the Rust-microservice premise is one-sided. Nothing shows the 800 ms is Python CPU time (V2, V3), and nobody has identified the 'hot paths' (V4). Django's own performance docs say most problems in well-written Django sites are in DB querying, caching and templates, not Python execution (V5). A separate Rust service would run the same queries and add a network hop, serialization, a second deploy and more on-call work.

Do first (1-2 days): agree a p95 target and how fresh the dashboard data must be. Then profile the slow tail in production with APM or OpenTelemetry (keep requests over about 500 ms) and py-spy on one worker. Split the time into DB, external calls, Python CPU, serialization and queue time. Compare p50 with p95, and look at latency by tenant or data size.

What the profile decides:
- DB time or query count dominates (most likely): select_related/prefetch_related, indexes checked with EXPLAIN ANALYZE, and aggregation in SQL.
- What's left is aggregation the dashboard can't avoid, or the tail comes from large tenants: move to O3 (cache the payload, rollup tables or materialized views, background jobs). Timebox the ORM tuning at 1-2 weeks.
- Queue time or worker saturation dominates: tune concurrency or capacity, not code.
- A few pure-Python functions dominate the CPU: SQL pushdown or a faster serializer first, then in-process PyO3 or Cython (O4). A separate Rust service only if the team already runs multi-service infrastructure and the work needs independent scaling.

Rust is not ruled out for good. The profile decides whether it is needed, and where.

### Why
- The load-bearing premise behind O1, that Python CPU time dominates, is only implied and has no measurement behind it (V2, V3). Nobody has identified the hot paths (V4).
- Django's official docs place most performance problems in DB querying, caching and templates, and say to find indexes by profiling first (V5).
- A separate service can't reduce DB wait time and adds a network hop, serialization and operational cost. That is architectural inference, and all three seats agree on it.
- Profiling costs little, can be undone, and is needed anyway to scope any later rewrite, so it comes first whatever the outcome.

### Your premises, checked
| Claim | Verdict | Evidence |
|---|---|---|
| The asker states that the application is a Django monolith. | ✅ holds | analysts' assessment, not tool-verified |
| The asker states that the main dashboard endpoint has a p95 latency of about 800 ms. | ✅ holds | /Users/munimahmad/Liftoff/claude-council-skill/evals/evals.json:7: "prompt": "council this for me: our Django monolith has p95 latency around 800ms on the main dashboard endpoint. I'm pretty sure the right m / /Users/munimahmad/Liftoff/claude-council-skill/cou |
| The asker states that Python is too slow for this workload, which implies that the latency is dominated by CPU-bound Python execution rather than I/O, database  | ◐ partly | Accurate version: The asker does say "Python is just too slow for this" about a Django dashboard endpoint with about 800ms p95. That statement takes for granted that the latency comes mostly from CPU-bound Python execution. The asker gives no evidence for this |
| The asker predicts that rewriting the hot paths as Rust microservices would meaningfully reduce the endpoint's latency. | ◐ partly | Accurate version: The asker does propose rewriting the hot paths as Rust microservices and attributes the 800ms p95 to Python being "just too slow", so the prediction is implied, not stated word for word. Whether that rewrite would actually cut the endpoint's  |
| The asker states that the endpoint has identifiable 'hot paths' that could be pulled out on their own. | ◐ partly | Accurate version: The asker does not state that the endpoint has identifiable hot paths that could be pulled out on their own. They only mention "the hot paths" in passing, in "rewrite the hot paths as Rust microservices". The definite article assumes that suc |

### Do these first
- **blocking** (seat consensus): Before any rewrite, caching or architecture decision, get a production breakdown of the p95 tail: DB, external calls, Python CPU, serialization and queue time.
- **do alongside** (seat consensus): Agree a p95 target and a freshness requirement for the data before starting. They set when to stop, whether O5 is acceptable, and whether O3 is viable.
- **do alongside** (seat consensus): Timebox the in-ORM fixes (about 1-2 weeks). Agree in advance to move to precomputation (O3) if the remaining time is aggregation the dashboard can't avoid.
- **do alongside** (seat consensus): Check worker CPU saturation and request queue time. If p95 sits far above p50, the cause may be queueing or large tenants, which calls for a capacity or concurrency fix rather than a code fix.
- **minor** (recalled): Don't expose debug-toolbar in production. If silk runs there, sample requests (SILKY_INTERCEPT_PERCENT) and cap stored requests, because it writes to the database that is the suspected bottleneck.
- **minor** (verified, V5): The claim that DB time dominates is a base rate from the Django docs, not a diagnosis of this endpoint. The profile may still show a CPU hot spot, and in that case O4 applies.

### Corrections to the premises
- U3: The asker says Python is 'just too slow', which assumes CPU-bound Python dominates. There is no profile, trace or code showing how the 800 ms splits between Python CPU and DB or I/O, so this is an untested hypothesis, not a fact. (V2)
- U4: The asker implies, without stating it outright, that a Rust microservice rewrite would cut latency. Whether it would is unknown without a latency breakdown. If DB or queue time dominates, a separate service would add latency rather than remove it. (V3)
- U5: The asker mentions 'the hot paths' only in passing and never establishes that any have been identified or can be pulled out. They have not been identified. Only profiling can find them. (V4)

### Where you and the council disagree
You said: "I'm pretty sure the right move is to rewrite the hot paths as Rust microservices — Python is just too slow for this. That's the obvious call, right?"
Council recommends: O2: Profile the endpoint first (APM/tracing, query logging) and fix what it shows inside the Django monolith: query count/N+1, indexes, ORM usage, serialization
Why: The load-bearing premise behind O1, that Python CPU time dominates, is only implied and has no measurement behind it (V2, V3). Nobody has identified the hot paths (V4). Django's official docs place most performance problems in DB querying, caching and templates, and say to find indexes by profiling first (V5). A separate service can't reduce DB wait time and adds a network hop, serialization and operational cost. That is architectural inference, and all three seats agree on it. Profiling costs little, can be undone, and is needed anyway to scope any later rewrite, so it comes first whatever the outcome.
What the council may be missing: A production profile the asker may have and didn't share. Also the team's existing Rust and multi-service operating capability, the actual SLO and business impact of 800 ms, whether the slowness grows with tenant size, and the WSGI/worker setup that decides whether the tail is queueing.
Cost if the council is wrong: Low. If the endpoint is truly CPU-bound, profile-first costs a few days before pointing to O4 or a scoped native component, and that profile is needed anyway to scope the work. The worse risk runs the other way: starting a Rust microservice without data could cost weeks to months and permanent operational overhead for no latency gain.
Your call stays the default until you decide otherwise.

### Minority report
None: the analysts reached the same answer independently (all Claude models, so treat it as one model family's view).

### Where the council may be wrong
- The endpoint may really be CPU-bound, for example heavy in-Python scoring or aggregation over large in-memory data. Then O4, or a scoped Rust component, becomes central rather than a fallback.
- The tail may come from infrastructure (worker saturation, an undersized DB, a slow external dependency). Then 'fix inside Django' points effort at the wrong layer.
- The data volume may already have outgrown per-request OLTP aggregation. Then precomputation or an OLAP store should lead, and ORM tuning is a detour.
- The real decision may be a strategic, organization-wide move to Rust rather than this one endpoint's latency, and this verdict does not address that.

### What would change this verdict
- A production profile shows most p95 wall time in pure-Python CPU inside a few functions, and SQL pushdown or a faster serializer doesn't remove it. That points to O4.
- Worker CPU is saturated on the dashboard's CPU work, the work needs to scale independently, and the team already runs Rust services with CI and on-call. That would make a scoped O1 defensible.
- The trace shows p95 is mostly request queue time or a slow external dependency. The fix would then move to capacity, concurrency or the dependency rather than Django code.

#### How the council ran
- Mode: standard. Seats: first_principles (Claude fable): O2: Profile the endpoint first (APM/tracing, query logging) , high; premise_auditor (Claude opus): O2: Profile the endpoint first (APM/tracing, query logging) , high; practitioner (Claude sonnet): O2: Profile the endpoint first (APM/tracing, query logging) , high.
- Blind vote: O2: Profile the endpoint first (APM/tracing, query 3. Final: O2: Profile the endpoint first (APM/tracing, query 3.
- Claims verified with tools: 5 (1 true, 4 partly).
- Escalations run: premise_audit, verify, red_team, audit.
- Red team (Claude opus): withstands_with_changes.
- Diversity: All voting seats were Claude models, so their agreement is one model family's view. Audit: passed.
- Agents: 15.
- Claude's own view before the council (never shown to the council): Profile first: 800 ms p95 on a dashboard is usually queries/serialization, not the language; a Rust rewrite is not justified on this evidence.