**Council verdict: Partly.** Add a unique index on lower(email), built with CREATE UNIQUE INDEX CONCURRENTLY after merging existing duplicates, and make the login query use the same lower(email) expression.
Confidence: **medium**. The mechanisms are verified: the race was reproduced (V5), and the docs confirm the expression index behaviour (V3) and the concurrent-build behaviour. All three analysts agreed independently. But the root cause of the two incidents, the current duplicate counts and the uniqueness scope are unknown, and any of these could shrink O2 from "the fix" to "a necessary backstop". The confidence ceiling is medium.

**What you asked:** Whether adding a unique index (constraint) on the users.email column in the ~4M-row Postgres users table is the right way to prevent the same person from ending up with duplicate accounts, given that email is looked up on every login and two duplicate-account incidents occurred this quarter. → **what you're after:** Prevent duplicate accounts per person at the data layer, with a safe rollout on a live, heavily-queried table.
_Reading check:_ R1/R3/R4 aren't really separable here: the four options already encode "is a unique index right" (R1/R2), "is it sufficient alone" (R4), and "how to build it safely" (R3) as a single choice. I answere

**Recommendation:** O2: Add a unique index on a normalised form of the email (e.g. lower(email) expression index or citext column), after reconciling existing duplicates

### Answer
O2 is the right fix, and all three analysts reached it independently. A unique index on lower(email) enforces uniqueness in the database, which application logic cannot do. A test run reproduced the race: two concurrent checks both saw no row and both inserted, while a constraint allowed exactly one insert (V5). A lower() unique index also rejects addresses that differ only in case, which O1's plain index lets through, and it can serve logins when the query uses the same expression (V3).

Do these first, in order:
1. Measure. Run GROUP BY email and GROUP BY lower(trim(email)) HAVING count(*)>1, and check pg_indexes to see which indexes users already has.
2. Pull the rows from the two incidents and classify each: exact duplicate (a race), a case or whitespace variant, or two different emails.
3. Deploy write-time normalisation (lower and trim in one shared function), plus handling for SQLSTATE 23505 (unique violation) on signup, OAuth callback and email change.
4. Merge the existing duplicates. Treat this as a product and security decision: auto-merge only where both sides are verified.
5. Re-run the duplicate check, then run CREATE UNIQUE INDEX CONCURRENTLY ... ON users (lower(email)) outside any transaction.
6. Confirm pg_index.indisvalid is true. Run EXPLAIN on the login SQL the ORM actually generates before dropping the old plain email index.

The incident classification is the fact that changes the scope. If either incident involved two different emails (OAuth relay addresses, a work and a personal address, or an email change), O2 is still worth shipping but will not stop that kind of duplicate. That needs separate account linking keyed on verified email or the provider's user ID. Auth0 documents that the same person signing up through different providers becomes separate users by default (V4). If rows are soft-deleted or scoped by tenant, make the index partial (WHERE deleted_at IS NULL) or composite (tenant_id, lower(email)), and give the login query the same predicate.

### Why
- A test run confirmed that application-only check-then-insert is racy: two concurrent checks both saw no row and both inserted. A unique constraint allowed exactly one insert, so enforcement belongs in the database (V5).
- The PostgreSQL docs confirm that a unique index on lower(col) rejects rows that differ only in case, and that the planner uses it when the query matches the same expression. So O2 prevents more duplicates than O1 and still serves logins (V3).
- All three analysts chose O2 independently, and the red team found it holds up with changes. No verification record contradicts a load-bearing claim behind it.
- The PostgreSQL docs, fetched by all three analysts, say CREATE UNIQUE INDEX CONCURRENTLY does not block writes during the build. It must run outside a transaction, and it leaves an INVALID index behind if duplicates remain. That makes the migration safe at 4M rows once the data is reconciled.

### Your premises, checked
| Claim | Verdict | Evidence |
|---|---|---|
| The asker states the database is PostgreSQL. | ✅ holds | /Users/munimahmad/Liftoff/claude-council-skill/evals/evals.json:14: "prompt": "get a council on this: we look users up by email on every login in Postgres, the users table is ~4M rows, and we've had two bugs  |
| The asker states the users table has about 4 million rows. | ? unknown | not checked |
| The asker states users are looked up by email on every login. | ? unknown | not checked |
| The asker states there were two bugs this quarter in which the same person ended up with duplicate accounts. | ✅ holds | /Users/munimahmad/Liftoff/claude-council-skill/evals/evals.json:14: "prompt": "get a council on this: we look users up by email on every login in Postgres, the users table is ~4M rows, and we've had two bugs  / /Users/munimahmad/Liftoff/claude-council-skill/co |

### Do these first
- **blocking** (seat consensus): Merge or rename existing exact and case/whitespace duplicates, and re-check immediately before the build. Otherwise the unique build fails and leaves an INVALID index that still enforces uniqueness and slows writes.
- **blocking** (seat consensus): Run CREATE UNIQUE INDEX CONCURRENTLY outside a transaction block. Most migration tools wrap migrations in one by default, so turn that off (Rails disable_ddl_transaction!, Django atomic=False). Set a statement timeout and watch for idle-in-transaction sessions, because the build waits for them.
- **do alongside** (verified, V3): Make the login query and every write path use the same expression as the index, lower(email) = lower($1). Otherwise the index is not used and logins may fall back to a sequential scan. Django iexact generates UPPER(), which will not use a lower() index. Run EXPLAIN on the real generated SQL before dropping the old index.
- **do alongside** (verified, V4): Classify the two incidents. If either involved different email addresses (OAuth or relay addresses, email changes), O2 will not prevent that kind of duplicate. Add account linking keyed on verified email or the provider's user ID.
- **do alongside** (seat consensus): Handle SQLSTATE 23505 (unique violation) at signup, OAuth callback and email change. Show 'account exists' or a link flow, not a 500. Ship this before the index goes in.
- **do alongside** (seat consensus): If rows are soft-deleted, scoped by tenant, or can have a null email, use a partial index (WHERE deleted_at IS NULL) or a composite one (tenant_id, lower(email)), and give the login query the same predicate.

### Where you and the council disagree
You said: "I want to add a unique index on users.email. Good idea?"
Council recommends: O2: Add a unique index on a normalised form of the email (e.g. lower(email) expression index or citext column), after reconciling existing duplicates
Why: A test run confirmed that application-only check-then-insert is racy: two concurrent checks both saw no row and both inserted. A unique constraint allowed exactly one insert, so enforcement belongs in the database (V5). The PostgreSQL docs confirm that a unique index on lower(col) rejects rows that differ only in case, and that the planner uses it when the query matches the same expression. So O2 prevents more duplicates than O1 and still serves logins (V3). All three analysts chose O2 independently, and the red team found it holds up with changes. No verification record contradicts a load-bearing claim behind it. The PostgreSQL docs, fetched by all three analysts, say CREATE UNIQUE INDEX CONCURRENTLY does not block writes during the build. It must run outside a transaction, and it leaves an INVALID index behind if duplicates remain. That makes the migration safe at 4M rows once the data is reconciled.
What the council may be missing: No analyst saw the actual schema, data, login query, ORM or incident reports. So it is unconfirmed whether email is nullable, soft-deleted or tenant-scoped, whether an index already exists, how many duplicates exist, and what caused the two bugs. The recommendation rests on general PostgreSQL behaviour, not on this system.
Cost if the council is wrong: If the incidents came from identity-provider or different-address signups, the team spends a merge and migration effort and still gets a third duplicate-account bug. If the rollout is careless, the costs are login latency regressions, users locked out by case-sensitive matching, 500 errors on signup, or data lost or accounts exposed through careless merging.
Your call stays the default until you decide otherwise.

### Minority report
None: the analysts reached the same answer independently (all Claude models, so treat it as one model family's view).

### Where the council may be wrong
- The two incidents may not involve email equality at all (OAuth relay addresses, different addresses, email changes). Then O2 is good hygiene but does not fix the bugs that actually happened.
- Email may not be a one-per-account identity key (shared B2B inboxes, phone-only accounts, several emails per user). A global unique index on email would then be the wrong shape.
- The legacy duplicates may be too many or too tangled to merge soon, which delays the full index.

### What would change this verdict
- The incident rows show different email addresses for the same person, not addresses equal under lower(trim(email)). Account linking then becomes the primary fix, with O2 as a secondary backstop.
- GROUP BY lower(trim(email)) HAVING count(*)>1 returns zero rows, every write path already normalises email, and both incidents were exact-match races. O1 would then be simpler and just as good.
- The users DDL or product rules show email is not a one-per-account key (shared inboxes, several emails per user). A global unique index would then be the wrong design.

#### How the council ran
- Mode: standard. Seats: first_principles (Claude fable): O2: Add a unique index on a normalised form of the email (e., high; premise_auditor (Claude opus): O2: Add a unique index on a normalised form of the email (e., high; practitioner (Claude sonnet): O2: Add a unique index on a normalised form of the email (e., medium.
- Blind vote: O2: Add a unique index on a normalised form of the 3. Final: O2: Add a unique index on a normalised form of the 3.
- Claims verified with tools: 5 (4 true, 1 partly).
- Escalations run: premise_audit, verify, red_team, audit.
- Red team (Claude opus): withstands_with_changes.
- Diversity: All voting seats were Claude models, so their agreement is one model family's view. Audit: passed.
- Agents: 15.
- Claude's own view before the council (never shown to the council): Yes: add it, but case-insensitively (lower(email) or citext), dedupe existing rows first, build CONCURRENTLY, and handle the unique violation in the app.