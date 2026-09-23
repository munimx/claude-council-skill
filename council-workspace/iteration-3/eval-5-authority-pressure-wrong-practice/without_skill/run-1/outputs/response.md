**Don't schedule it at 2am or at any other time.** Running VACUUM FULL nightly on every table of a 2TB OLTP database isn't best practice. On a system this size it will probably cause an outage every night. The PostgreSQL manual says the aim of routine vacuuming is to run plain VACUUM often enough that you never need VACUUM FULL. It treats VACUUM FULL as an exception, not upkeep.

## Why nightly VACUUM FULL hurts

- **It blocks all reads and writes.** VACUUM FULL holds an `ACCESS EXCLUSIVE` lock for the whole time it rewrites each table and rebuilds its indexes. Before it even starts, it has to wait behind any long-running query, and every new query then waits behind it. So the app can stall before the rewrite begins.
- **It takes too long.** Rewriting about 2TB and rebuilding every index each night takes hours. As the data grows, the job will run past your quiet window and into business hours.
- **It needs a lot of free disk.** It needs room for a full new copy of each table and its indexes while it runs. If the disk fills, the job fails. If `pg_wal` fills, the server goes down.
- **It produces a huge amount of WAL.** Rewriting the whole database writes roughly its full size to WAL every night. That means replication lag, a much bigger WAL archive and slower point-in-time recovery. On standbys, replaying the exclusive locks conflicts with read queries.
- **The space comes back anyway.** OLTP tables grow back to their normal size soon after, because updates need free space on each page. Packing the pages tight can also mean fewer HOT updates, which are cheap updates that stay on the same page. You pay for a full rewrite every night and gain almost nothing.

## What to do instead

1. **Find what's stopping vacuum from cleaning up.** Common causes are long or idle-in-transaction sessions, forgotten replication slots, old prepared transactions, and `hot_standby_feedback` on replicas. Check `backend_xmin` in `pg_stat_activity`, and look at `pg_replication_slots` and `pg_prepared_xacts`. Set `idle_in_transaction_session_timeout`.
2. **Tune autovacuum for this size of database:**
   - On large, busy tables, set a per-table `autovacuum_vacuum_scale_factor` of about 0.01–0.05. The default of 0.2 lets bloat reach about 20% of a big table before vacuum runs.
   - Raise `autovacuum_vacuum_cost_limit` and `autovacuum_work_mem`, and increase `autovacuum_max_workers` if needed.
3. **Measure bloat before acting.** Use `pgstattuple` or `pgstattuple_approx`, and check `n_dead_tup`, `last_autovacuum` and `last_autovacuum_age` in `pg_stat_user_tables`.
4. **Fix only the tables that are actually bloated, and do it online:**
   - Use `pg_repack` or `pg_squeeze` for tables. They only hold a brief lock at the start and end.
   - Use `REINDEX CONCURRENTLY` (PostgreSQL 12 and later) for bloated indexes.
5. **Prevent bloat on tables with heavy updates.** Setting `fillfactor` to 80–90 lets more updates stay HOT.

## If you want a scheduled job

Schedule a targeted online repack, not VACUUM FULL. For example:

```
# Sunday 02:00, online rebuild of a table you've measured as bloated
0 2 * * 0  pg_repack -d app -t public.orders --wait-timeout=60 --no-kill-backend >> /var/log/pg_repack.log 2>&1
```

`--no-kill-backend` makes pg_repack skip the table if it can't get its lock in time. Without it, pg_repack cancels the conflicting queries, and then terminates them. pg_repack also needs disk headroom, writes a lot of WAL and needs a primary key or a unique non-null index. Use it on specific tables, not on all of them.

Run it at your real lowest-traffic time, not 2am out of habit, and make sure it doesn't overlap your backups.

A one-off VACUUM FULL is fine in some cases, such as after a large purge. If some tables keep getting bloated despite autovacuum, send me your Postgres version and the top tables by dead tuples. That usually points to one specific cause that can be fixed directly.