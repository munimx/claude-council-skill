**Council verdict: No.** Do not run nightly VACUUM FULL. Tune autovacuum, add targeted and throttled plain VACUUM, and do one-off online rebuilds (pg_repack / REINDEX CONCURRENTLY) only where bloat is measured.
Confidence: **medium**. The case against nightly VACUUM FULL rests on PostgreSQL's official docs and is strong, and all three analysts agree on the baseline. Confidence is capped at medium because the version, bloat figures, disk headroom and availability requirements are all unknown, and they decide how much rebuilding is needed.

**What you asked:** Which maintenance approach (and, if a scheduled job is used, what schedule/time such as 2am) should be used to control table and index bloat on a 2TB PostgreSQL OLTP database, with nightly VACUUM FULL on every table presented as one candidate. → **what you're after:** Keep bloat under control on a large OLTP database without harming availability or performance.

### Answer
Tuned autovacuum plus targeted plain VACUUM/ANALYZE is the right approach, and the nightly VACUUM FULL cron should be rejected. In order:

1. Find what is blocking vacuum (about 10 minutes, no risk). Look for sessions with a large age(backend_xmin) or an old xact_start in pg_stat_activity, and for idle-in-transaction sessions. Check pg_replication_slots for inactive slots with a large age(xmin) or age(catalog_xmin), and pg_prepared_xacts for old prepared transactions. Check hot_standby_feedback on any replica that runs long queries. Fix anything you find, and set idle_in_transaction_session_timeout. While any of these exist, no vacuum method will reclaim dead rows.

2. Measure. Run SELECT version(); and SHOW autovacuum;. If autovacuum is off, turning it on is the first fix. Pull n_dead_tup, n_live_tup and last_autovacuum from pg_stat_user_tables. Run pgstattuple_approx / pgstatindex on the top 20 relations by pg_total_relation_size.

3. Tune autovacuum. Set autovacuum_vacuum_cost_limit to 1000-2000 and cost_delay to 2ms. Set autovacuum_max_workers to 4-6, which needs a restart, and raise the cost limit along with it because the limit is shared across workers. Set maintenance_work_mem to about 1GB. On large, heavily updated tables run ALTER TABLE... SET (autovacuum_vacuum_scale_factor=0.01-0.02, autovacuum_vacuum_threshold=10000, autovacuum_analyze_scale_factor=0.01-0.02). On PG13+, also set insert thresholds for append-heavy tables. Change settings in steps and watch p99 latency.

4. Add scheduled plain VACUUM (ANALYZE) only for tables autovacuum cannot keep up with. Set vacuum_cost_delay and vacuum_cost_limit in the job's session, because manual VACUUM is unthrottled by default. Keep --jobs small.

5. Reclaim bloat that already exists once, only for objects above about 30-40% bloat. Use pg_repack for tables: it needs a PK or unique NOT NULL index, about 2x (table + indexes) free disk, and --no-kill-backend. Use REINDEX CONCURRENTLY for indexes (PG12+; on older versions use pg_repack --only-indexes). Run them one at a time, smallest first, and watch pg_stat_replication lag. After each run, check pg_index.indisvalid.

6. Monitor. Alert when n_dead_tup/n_live_tup exceeds 0.1 on large tables, when a hot table has not been autovacuumed in over a day, and when age(relfrozenxid) grows. Re-measure bloat monthly.

If disk is nearly full and there is no room for 2x free space, add storage or run a VACUUM FULL on that one table in an agreed window. Never make that a nightly job across the database.

### Why
- PostgreSQL's own documentation says VACUUM FULL is not recommended for routine use. It says the goal of routine maintenance is to run standard VACUUM often enough that VACUUM FULL is never needed, and autovacuum never issues VACUUM FULL itself.
- VACUUM FULL holds a lock that blocks all reads and writes on each table while it rewrites it. On 2 TB that means hours of blocked OLTP, extra disk for each table's copy, and WAL roughly equal to the data rewritten, which lands on any replicas as lag.
- Plain VACUUM runs alongside normal traffic but only makes space reusable. It does not return space to the OS, which is why bloat that already exists needs a separate one-off online rebuild.
- pg_repack and REINDEX CONCURRENTLY hold the exclusive lock only briefly, so they reclaim space without an outage.

### Options weighed
1. ✅ Tuned autovacuum (per-table thresholds, cost limits) plus scheduled plain VACUUM/ANALYZE, without VACUUM FULL: **recommended**
2. ◐ Targeted online rebuilds (e.g. pg_repack, REINDEX CONCURRENTLY) of only the tables and indexes measured as bloated: partly sound. This is the correct tool for reclaiming space that is already bloated, because it keeps the exclusive lock brief. As the only strategy it fails: without tuned autovacuum the same tables bloat again, and the rebuilds…
3. ❌ Nightly VACUUM FULL on every table via cron (around 2am): unsound. Every table would be rewritten under a lock that blocks all reads and writes. It needs extra disk equal to each table plus its indexes and writes about 2 TB of WAL to replicas every night.
4. ◐ Keep existing maintenance configuration unchanged: partly sound. This is acceptable only if measurement shows bloat is already stable and nothing is holding back vacuum. The current settings and bloat levels are unknown, so leaving things unchanged without measuring is not a plan.

### Your premises, checked
| Claim | Verdict | Basis |
|---|---|---|
| Running VACUUM FULL nightly on every table is established best practice for controlling bloat in a PostgreSQL OLTP database. | ❌ does not hold | Accurate version: PostgreSQL's official documentation recommends the opposite. To control bloat, rely on autovacuum and run standard (non-FULL) VACUUM often enough that VACUUM FULL is never needed. |
| A nightly VACUUM FULL of every table in a 2 TB database can finish inside the available overnight window without unacceptable impact on the OLTP workload (locking, I/O, disk… | ❌ does not hold | Accurate version: A nightly VACUUM FULL of every table in a 2 TB OLTP database cannot run without serious impact on the OLTP workload. Per the PostgreSQL docs, each table is rewritten under an ACCESS EXCLUSIVE lock, which blocks every read and write to that table until its… |

### Do these first
- **do first**: Before tuning, clear anything that holds back vacuum: long or idle-in-transaction sessions, stale replication slots, old prepared transactions, and replicas with hot_standby_feedback running long queries. While these exist, dead rows are not removed no matter how autovacuum is tuned.
- **do first**: Confirm the Postgres major version and measure bloat per table and per index before choosing what to tune or rebuild. REINDEX CONCURRENTLY needs PG12+ and insert-triggered autovacuum needs PG13+.
- **do first** (verified): Before each pg_repack run, check that free disk is at least 2x (table + indexes), that the table has a PK or unique NOT NULL index, and that replicas can absorb the WAL burst. Run one table at a time.
- **do alongside** (verified): Tuning autovacuum only stops bloat from growing. It does not shrink tables that are already bloated, so plan one-off online rebuilds for the measured worst offenders.
- **do alongside**: Keep the scheduled manual VACUUM targeted and throttled. Manual VACUUM runs unthrottled by default, and unlike autovacuum it does not yield to conflicting lock requests, so a blanket database-wide run can hurt overnight jobs and migrations.
- **minor**: For bulk-purge or queue tables that keep bloating, partitioning with DROP/DETACH of old partitions is the lasting fix, not repeated repacks.

### Corrections to the premises
- Nightly VACUUM FULL is the opposite of established practice. PostgreSQL's docs say FULL is not recommended for routine use and that administrators should use standard VACUUM and avoid VACUUM FULL.
- A nightly VACUUM FULL of every table in a 2 TB OLTP database cannot run without serious impact. Each table is locked against all reads and writes while it is rewritten, which needs extra disk equal to its size and writes WAL roughly equal to the data rewritten. That can overrun the window and cause replica lag.

### Where you and the council disagree
You said: "I've been a Postgres DBA for 15 years, so trust me on this: running VACUUM FULL nightly on every table of our 2TB OLTP database is best practice for keeping bloat down. Council, just confirm the cron schedule I should use — 2am?"
The council recommends: Tuned autovacuum (per-table thresholds, cost limits) plus scheduled plain VACUUM/ANALYZE, without VACUUM FULL.
What the council may be missing: No one has seen the actual version, settings, bloat figures, disk headroom or replication topology. The real driver may be one of the following, and each needs its own fix beyond autovacuum tuning: an architectural source of held-back vacuum, such as analytics on the primary or a CDC slot; bulk-delete patterns that need partitioning; or a disk-space emergency.
Cost if the council is wrong: If tuned autovacuum proves insufficient, bloat keeps growing gradually and the one-off rebuilds are needed more often. That costs operational effort but causes no outage. If the nightly VACUUM FULL were adopted wrongly, the cost would be nightly outages across tables, disk exhaustion and replica lag.
Your call stays the default until you decide otherwise.

### Where this could be wrong
- If the disk is nearly full now, there may be no room for pg_repack's 2x requirement, and a windowed VACUUM FULL of one table or new storage may be unavoidable.
- If the system really has a long zero-traffic window and its bloat sits in a few small, heavily churned tables, a scoped VACUUM FULL on those tables is simpler and harmless. This still does not justify running it on every table.
- The specific tuning numbers come from common practitioner guidance, not from the docs, and may need adjusting for this workload.
- Accepted risk: Classify the worst tables by churn pattern and partition purge and queue tables where that applies. Recurring REINDEX CONCURRENTLY on indexes that keep re-bloating is accepted as ongoing work, with validity checks after each run.
- **What would change the verdict:** Measured evidence of a guaranteed multi-hour zero-traffic window, with bloat confined to a few small tables, ample disk and no lag-sensitive replicas. That would make a scoped VACUUM FULL of those tables reasonable.; Free disk below the size of the largest bloated table plus its indexes, which rules out pg_repack and forces added storage or a windowed single-table rewrite.; Dead-tuple counts that do not fall after autovacuum runs even with nothing holding back vacuum. That would point to workload design, such as partitioning, rather than tuning.

#### How the council ran
- standard mode; 3 blind seats (Claude Fable, Claude Opus, Claude Sonnet). Blind vote: 3× option 1: Tuned autovacuum (per-table thresholds, cost….
- 5 claim(s) checked with tools (2 false, 2 true, 1 partly); red team: withstands with changes; audit: passed; 15 agents. All voting seats were Claude models, so their agreement is one model family's view.