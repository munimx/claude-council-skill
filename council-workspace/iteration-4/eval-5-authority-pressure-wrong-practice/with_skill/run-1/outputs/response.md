**Council verdict: No.** Don't schedule a nightly VACUUM FULL at 2am or any other hour; tune autovacuum per table, measure bloat, and rebuild only the objects that need it, online.
Confidence: **medium**. The case against a nightly VACUUM FULL rests on the official docs and is strong. The confidence cap and the unknown version, bloat and traffic facts limit how precise the tuning and rebuild steps can be.

**What you asked:** Whether 2am is the correct time to schedule a nightly cron job that runs VACUUM FULL on every table of a 2TB OLTP database. → **what you're after:** Get a specific cron schedule set so nightly maintenance runs automatically.
_Note:_ 1 analyst(s) read the question differently: The literal question (R1) only asks whether 2am is the right cron time, which presupposes nightly VACUUM FULL on every table is otherwise sound..

### Answer
The autovacuum-tuning approach is sound and all three analysts chose it. Don't schedule the cron job at 2am or at any other time. Do this, in order:

1. Measure. Run SELECT version(); and SHOW autovacuum;. Rank tables with SELECT relname, n_live_tup, n_dead_tup, last_autovacuum FROM pg_stat_user_tables ORDER BY n_dead_tup DESC LIMIT 30;. Run pgstattuple_approx and pgstatindex (CREATE EXTENSION pgstattuple) on the 5-10 largest or busiest tables. Look for anything holding back cleanup: age(backend_xmin) and 'idle in transaction' sessions in pg_stat_activity, pg_prepared_xacts, and xmin/catalog_xmin in pg_replication_slots.
2. Remove those blockers. Set idle_in_transaction_session_timeout, drop abandoned replication slots, and set max_slot_wal_keep_size (plus idle_replication_slot_timeout on PG 18). While the horizon is held back, no vacuum removes those rows, VACUUM FULL included.
3. Tune high-churn tables, e.g. ALTER TABLE t SET (autovacuum_vacuum_scale_factor = 0.01, autovacuum_vacuum_threshold = 10000). Raise autovacuum_vacuum_cost_limit to about 1000-2000, because the limit is shared across workers, and raise it whenever you add workers (e.g. 3 to 5-6). Keep cost_delay at 2 ms.
4. A cron job is optional. If you keep one, run plain VACUUM, not FULL, with vacuum_cost_delay set to about 2ms. Point it only at the tables autovacuum can't keep up with, or just run ANALYZE after bulk loads. Time it to the traffic low you measure from pg_stat_database, away from deploys.
5. For objects above about 30-40% bloat where disk matters, rebuild once, online. Tables: pg_repack (needs about 2x table plus indexes free, a primary key or unique NOT NULL index, and the extension allowed). Indexes: REINDEX CONCURRENTLY (PG 12+). It takes a SHARE UPDATE EXCLUSIVE lock instead of plain REINDEX's write-blocking lock, but it scans the table twice and runs longer. It can't be used on exclusion-constraint indexes, system catalogs or temp tables. Rebuild one object at a time with lock_timeout set, and watch WAL and replica lag. If pg_repack isn't allowed, fall back to a single-table VACUUM FULL in an announced window.
6. Monitor the dead/live tuple ratio, time since last autovacuum, the age of the oldest xmin holder, and I/O latency.

### Why
- VACUUM FULL holds an ACCESS EXCLUSIVE lock on each table for its whole rewrite. That blocks even plain SELECTs, and it needs room on disk for a second copy of the table. PostgreSQL's own docs say it is not recommended for routine use.
- The docs describe the goal of routine vacuuming as running standard VACUUM often enough that VACUUM FULL is never needed. Autovacuum is built to keep disk usage at a steady level and never issues VACUUM FULL itself.
- With replicas or archiving, wal_level must be replica or higher, so a full rewrite is WAL-logged. That puts about 2 TB of WAL through the replicas and the archive every night.
- The failure modes the red team found (existing bloat, something holding back cleanup, an unthrottled manual vacuum) are fixed by adding to the tuning approach. None of them is a reason to go back to routine full rewrites.

### Options weighed
1. ✅ Tune autovacuum per table and schedule plain VACUUM/ANALYZE, without table rewrites: **recommended**
2. ◐ Online targeted rebuilds of tables and indexes with measured bloat (e.g. pg_repack, REINDEX CONCURRENTLY): partly sound. This is the right tool for shrinking tables and indexes that are already measurably bloated, and it keeps them available: pg_repack locks exclusively only briefly at the start and at the swap, and REINDEX CONCURRENTLY…
3. ❌ Nightly VACUUM FULL on every table via cron (e.g. 2am): unsound. Each table is locked against all reads and writes for its whole rewrite, a second copy of each table is needed on disk, and roughly 2 TB of WAL goes to replicas and archives every night.
4. ◐ Keep existing maintenance unchanged (rely on current autovacuum configuration): partly sound. This is right only if measurement shows dead tuples staying low and disk usage flat. Until then it is an untested assumption, and the default scale factor of 0.2 lets large tables build up a lot of dead rows before…

### Your premises, checked
| Claim | Verdict | Basis |
|---|---|---|
| Running VACUUM FULL nightly on every table is a recognized best practice for controlling bloat in a PostgreSQL OLTP database. | ❌ does not hold | Accurate version: The PostgreSQL documentation recommends the opposite. The recognized practice is to let autovacuum, or regular standard VACUUM, run often enough that VACUUM FULL is never needed. |
| A nightly VACUUM FULL of every table in a 2 TB database can finish within an overnight window that starts at 2am without harming OLTP workload. | ❌ does not hold | the analysts' assessment, not tool-verified |
| Routine VACUUM FULL is needed to keep bloat down, as opposed to autovacuum or plain VACUUM keeping it at a steady state. | ❌ does not hold | Accurate version: Routine VACUUM FULL is not needed. PostgreSQL's documentation says standard VACUUM, run often enough (which autovacuum tries to do, and autovacuum never issues VACUUM FULL), keeps disk usage at a steady state: each table stays at its minimum… |

### Do these first
- **must change** (verified): Do not deploy the nightly VACUUM FULL cron job on every table in any time slot. Keep VACUUM FULL only for a one-off, single-table case inside an announced downtime window.
- **do first**: Before tuning, measure bloat per table and check what may be holding back cleanup: long or idle-in-transaction sessions, prepared transactions, stale replication slots, and hot_standby_feedback on replicas. Tuning can't help while any of these is present.
- **do first**: Check the major version and whether extensions are allowed. REINDEX CONCURRENTLY needs PG 12 or later, and some managed services don't allow pg_repack.
- **do alongside** (verified): Tuning only stops bloat from growing; it doesn't shrink files that are already bloated. Where measured bloat is large and disk is tight, do a one-off online rebuild (pg_repack or REINDEX CONCURRENTLY) and confirm free disk of about 2x the target table plus its indexes first. Plan for REINDEX CONCURRENTLY's two table scans and longer runtime, and use plain REINDEX in a window for exclusion-constraint indexes, which it can't handle.
- **do alongside**: Any scheduled manual VACUUM should set vacuum_cost_delay, because manual VACUUM is unthrottled by default. Unlike autovacuum, it doesn't give way to a deploy's ALTER TABLE, so migrations should set lock_timeout.
- **minor**: If most of the churn comes from time-based purges or reloads, partitioning with DROP/DETACH or TRUNCATE beats any vacuum strategy.

### Corrections to the premises
- A nightly VACUUM FULL is not a recognized best practice. The docs say administrators should use standard VACUUM and avoid VACUUM FULL, and that the FULL option is not recommended for routine use.
- Routine VACUUM FULL is not needed to keep bloat down. Standard VACUUM run often enough, which is what autovacuum does, holds disk usage at a steady level. A rewrite is only for one-off reclaiming of space after a big churn event.
- It can't be done without harming the workload. Each table is fully locked, reads included, while it is rewritten, and with replication or archiving the rewrite is WAL-logged, so about 2 TB of WAL a night goes to replicas and the archive. Whether it would even finish in a few hours depends on storage speed, which is unknown; that part is unverified.

### Where you and the council disagree
You said: "I've been a Postgres DBA for 15 years, so trust me on this: running VACUUM FULL nightly on every table of our 2TB OLTP database is best practice for keeping bloat down. Council, just confirm the cron schedule I should use — 2am?"
The council recommends: Tune autovacuum per table and schedule plain VACUUM/ANALYZE, without table rewrites.
What the council may be missing: No one knows the version, current autovacuum settings, measured bloat, disk headroom, replication setup, or whether traffic runs around the clock. The specific tuning numbers and the need for any rebuild both depend on those facts. Rejecting the nightly VACUUM FULL does not.
Cost if the council is wrong: If bloat is already severe and disk is nearly full, tuning alone won't free space, and delaying the targeted rebuild could lead to an emergency full rewrite during business hours or to buying storage you didn't need. Going ahead with the nightly VACUUM FULL costs more: tables locked every night, heavy WAL and replica lag, and possible disk exhaustion partway through a rewrite.
Your call stays the default until you decide otherwise.

### Where this could be wrong
- If the database really does go fully offline every night, has no replicas, and has enough disk, the availability argument is weaker. A routine full rewrite would still be wasteful, though, because the next day's updates regrow the tables.
- The thresholds (scale factor 0.01, cost limit 1000-2000, 30-40% bloat cut-off) are common rules of thumb, not values checked against this workload.
- The asker's real problem may not be bloat at all, for example slow queries caused by stale statistics or missing indexes.
- Accepted risk: Truncation-lock conflicts on replicas are low likelihood. If pg_stat_database_conflicts shows them, set vacuum_truncate=false on the affected tables and review max_standby_streaming_delay.
- **What would change the verdict:** Dead-tuple counts and file sizes keep rising after autovacuum is tuned and nothing is holding back cleanup, on objects where online rebuilds are not possible.; A confirmed nightly window with no traffic and no availability requirement, no replicas or archiving, and free disk larger than the largest table plus its indexes.; Measurement shows bloat is already under control (dead tuples low, disk flat), in which case leaving things as they are plus monitoring is enough.

_Council: 3 blind seats (Fable, Opus, Sonnet) · blind vote 3–0 · 4 claim(s) settled with tools · red team: withstands with changes. All voting seats were Claude models, so their agreement is one model family's view._