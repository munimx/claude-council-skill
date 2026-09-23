**Council verdict: Yes, with changes.** Add a database-level unique index on the normalised email (lower-cased, trimmed), built concurrently after removing existing duplicates. A plain unique index on the raw email column still lets case variants through.
Confidence: **medium**. The mechanics are verified: the case-sensitivity of a plain index, the behaviour of a concurrent build, and the application-level race. What caused the two bugs is still unknown, and it decides whether an email index alone fixes them.

**What you asked:** Whether adding a unique index on the users.email column in a ~4M-row Postgres table, which is looked up on every login, is a good change, given that the same person has ended up with duplicate accounts twice this… → **what you're after:** Prevent duplicate accounts for the same person going forward while keeping per-login email lookups fast at the table's current and growing scale.

### Answer
Adding a unique index is the right fix. Put it on the normalised email, not the raw column. All three analysts agreed, and the evidence supports them.

1. Diagnose (read-only, a few minutes). Run:
- `\d users` to see existing indexes, and whether there are deleted_at, tenant or NULL/blank email columns
- `SELECT lower(btrim(email)), count(*) FROM users GROUP BY 1 HAVING count(*)>1;`
- `SELECT version();`
- EXPLAIN on the real login query

Also find out what caused the two bugs. If each person got two rows from different sign-in methods (password and Google/SSO, with different, NULL or relay emails), an email index will not catch it. In that case you also need an identities table with UNIQUE(provider, subject).

2. Normalise on write. Every write path (signup, SSO provisioning, email change, admin tools, imports) should store `lower(btrim(email))`.

3. Merge the existing duplicates. Keep the verified or most recently used row, move every foreign key to it before deleting anything, invalidate sessions and passwords on unverified losing rows, and do a dry run on a copy first.

4. Preferred shape (keeps queries simple):
- Backfill `email = lower(btrim(email))`.
- `ADD CONSTRAINT... CHECK (email = lower(btrim(email))) NOT VALID`, then `VALIDATE CONSTRAINT`.
- `CREATE UNIQUE INDEX CONCURRENTLY users_email_uq ON users (email)`, then `ADD CONSTRAINT... UNIQUE USING INDEX`.
- Login stays `WHERE email = lower(btrim($1))`, and `ON CONFLICT (email)` keeps working.

Alternative: an expression index on `(lower(btrim(email)))`. Then every query and upsert must use exactly that expression; `lower(email)` alone will not use the index.

Add `WHERE deleted_at IS NULL` if soft-deleted users keep their email. Scope the index by tenant if accounts are per organisation.

5. Build safely:
- Run it outside any transaction (turn off your migration tool's transaction wrapper), with `SET lock_timeout='5s'`.
- Re-run the duplicate query just before the build.
- Afterwards check `pg_index.indisvalid`. If the index is INVALID, `DROP INDEX CONCURRENTLY`, fix the duplicates and retry. Do not leave it in place: an invalid index still enforces uniqueness and slows writes.

At 4M rows, expect seconds to minutes without blocking writes. Never drop CONCURRENTLY to make the migration pass: without it the build blocks writes to users for its whole duration.

6. Check EXPLAIN shows login using the new index. Only then drop any old email index, concurrently.

7. At signup, catch SQLSTATE 23505 and return the same neutral message as a normal signup ("check your email"). Never sign the user in on a conflict. Map 23505 in email-change, admin and import paths too, and watch 23505 rates and login latency after rollout.

### Why
- Only a database constraint closes the race between checking for an email and inserting it. A scratch test showed two concurrent check-then-insert requests both inserting. With a unique constraint the second insert failed, and the PostgreSQL Read Committed docs describe the same behaviour.
- Under the default collation a plain unique index compares case-sensitively. The PostgreSQL citext docs say such an index won't enforce uniqueness case-insensitively, so indexing the raw column would miss the most common kind of same-person duplicate.
- Building the index concurrently is documented as not blocking inserts, updates or deletes, which is what a live login table needs. The docs are equally clear that it fails and leaves an INVALID index if duplicates exist or arrive during the build, so removing duplicates first is part of the fix.
- Storing a normalised email guarded by a CHECK constraint lets you use an ordinary unique constraint. That avoids the two expression-index traps: queries that don't match the index expression fall back to full-table scans, and existing upserts break.

### Options weighed
1. ❌ Keep the schema unchanged and periodically detect and merge duplicate accounts: unsound. Finding and merging duplicates later does not prevent them. Users still end up with two accounts until the next cleanup run, and each merge carries data-loss and account-takeover risk.
2. ❌ Enforce email uniqueness in application code only, with no database constraint: unsound. A check-then-insert in application code races under Read Committed: two requests both see no row and both insert. A scratch test reproduced this, and the PostgreSQL isolation docs confirm it.
3. ✅ Add a unique index on users.email: **recommended**
4. ◐ Move login identities (emails or provider identities) into a separate table with uniqueness enforced there: partly sound. This is the right structure only if one person legitimately has several sign-in identities (password plus OAuth/SSO). It is a larger migration and still needs the same database uniqueness constraint on the identity…

### Your premises, checked
| Claim | Verdict | Basis |
|---|---|---|
| A plain unique B-tree index on a PostgreSQL text/varchar column treats values that differ only in letter case as distinct. | ◐ partly | Accurate version: A plain unique B-tree index on a PostgreSQL text/varchar column treats values differing only in letter case as distinct only when the column uses its default/ordinary deterministic collation (the normal case, e.g. |
| A unique index can be built on a live ~4M-row PostgreSQL table without blocking writes (CREATE UNIQUE INDEX CONCURRENTLY), but the build fails and leaves an INVALID index if… | ✅ holds | https://www.postgresql.org/docs/current/sql-createindex.html: will build the index without taking any locks that prevent concurrent inserts, updates, or deletes on the table; |
| The planner uses a unique index on users.email for the login lookup only if the query's predicate matches the indexed expression (e.g. email = $1 vs lower(email) = $1). | ✅ holds | the analysts' assessment, not tool-verified |
| Uniqueness checks done only in application code (check-then-insert) can still produce duplicates under concurrent requests unless serialized by locking or a constraint. | ✅ holds | python3 race_demo.py (scratch test, /private/tmp/.../scratchpad/race_test/race_demo.py): Thread outcomes: ['thread inserted (delay=0.2) saw count=0', 'thread inserted (delay=0.2) saw count=0'] Rows with that email after both 'req / python3… |

_Not settled (nobody here could check):_ The duplicate accounts from the two bugs had exactly the same stored email value, not values that differ by case, whitespace,…

### Do these first
- **must change** (verified): Put the uniqueness on the normalised email: either a column normalised on write and guarded by a CHECK, or an index on lower(btrim(email)). A plain unique index on the raw column lets case variants through and does not fix case-driven duplicates.
- **do first**: Before building, find the root cause of the two bugs. If they came from different sign-in providers creating rows with different or empty emails, an email index won't catch them, and you also need an identities table keyed by provider and subject.
- **do first** (verified): Merge existing duplicates, then build the index concurrently outside any transaction and confirm it is valid. A failed build leaves an INVALID index that still enforces uniqueness and slows writes. Drop it concurrently and retry.
- **do alongside**: Every login query, lookup and upsert must use the same expression as the index (confirm with EXPLAIN). A mismatch such as lower(email) against an index on lower(btrim(email)) makes every login scan all 4M rows, and ON CONFLICT (email) raises an error when the only unique index is on an expression.
- **do alongside**: When signup hits a unique violation, return a neutral response and email the address a sign-in or reset link. Never sign the user in on a conflict, because anyone who only knows the email address would get in.
- **minor**: Scope the index to your rules. Use WHERE deleted_at IS NULL if soft-deleted users keep their email, store missing emails as NULL rather than '', and include the tenant/org key if one person can have an account in each organisation.

### Corrections to the premises
- A plain unique B-tree index on text is case-sensitive only under the default (deterministic) collation, which almost every database uses. If the column uses a nondeterministic ICU collation set to ignore case, the same plain index treats 'g' and 'G' as equal. So a plain unique index is case-sensitive in the usual setup, not in every setup.

### Where this could be wrong
- The two bugs may not be same-email duplicates at all (for example separate sign-in providers, or login picking the wrong row), in which case the index fixes neither bug.
- The product may legitimately allow repeated emails (per-tenant accounts, shared addresses), making a global uniqueness rule the wrong invariant.
- Merging 4M rows' worth of existing duplicates may be harder or riskier than assumed if many exist or they carry conflicting data.
- **What would change the verdict:** Investigating the two bugs shows the duplicate rows had different or empty emails created by separate OAuth/SSO providers, so the main fix becomes an identities table with UNIQUE(provider, subject).; The duplicate query or product rules show that one person legitimately needs several accounts with the same email (for example one per tenant), so the key becomes (tenant_id, normalised email) or uniqueness moves elsewhere.; The duplicate-detection query returns zero rows and the code already normalises and serializes signup, which would point to a different root cause than a missing constraint.

_Council: 3 blind seats (Fable, Opus, Sonnet) · blind vote 3–0 · 5 claim(s) settled with tools · red team: withstands with changes. All voting seats were Claude models, so their agreement is one model family's view._