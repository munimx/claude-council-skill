**Verdict: yes, add it.** Your duplicates are exactly the kind of rule the database should enforce, because checks in application code can race. But a plain unique index on `users.email`, as you described it, has three problems. It probably won't build yet, it may not catch the duplicates you actually had, and built the default way it blocks writes while it runs.

One note: I reviewed this myself rather than asking several separate models. I've laid it out the way a council would, with the verdict, the objections and the dissent.

## What the plan as stated misses

**1. The build will fail on your existing duplicates.** You've already had two bugs that created duplicates, so there are almost certainly more you haven't found. Find them first:

```sql
SELECT lower(btrim(email)) AS norm, count(*), array_agg(id ORDER BY created_at)
FROM users
GROUP BY 1
HAVING count(*) > 1;
```

Merging them is the real work. You have to decide which account survives, move the rows in other tables that point at the losing account, and keep an audit trail. That's a product decision as much as a database one.

**2. Uniqueness is case-sensitive by default.** A plain unique index treats `Bob@x.com` and `bob@x.com` as different emails, and that is one of the most common ways duplicate accounts happen. There are two fixes:
- **Option A: normalize on write.** Store `lower(btrim(email))`, backfill the existing rows in batches, and put a plain unique index on `email`. Your existing `WHERE email = $1` queries and `ON CONFLICT (email)` keep working unchanged.
- **Option B: an expression index** on `lower(email)`. There's no backfill, but every login query must use `WHERE lower(email) = lower($1)`. Any code path that doesn't will quietly scan all 4M rows.

Before you choose, look at your two actual duplicate pairs and compare the emails exactly. That tells you whether case or spacing was the cause.

**3. A plain `CREATE INDEX` blocks writes.** It blocks inserts, updates and deletes (but not reads) for the whole build. If your login code updates a column like `last_login_at`, blocking writes effectively blocks logins. Use `CREATE UNIQUE INDEX CONCURRENTLY`, and know what comes with it:
- It can't run inside a transaction. Most migration tools wrap each migration in one, so turn that off for this migration.
- If it fails partway, for example because a new duplicate appeared during the build, it leaves behind an INVALID index. That index still slows writes and can reject inserts. Drop it, fix the duplicate and retry.
- It waits for any long-running transactions to finish before it can complete.

## Also check

- **Soft deletes.** If you have a column like `deleted_at`, use a partial index (`WHERE deleted_at IS NULL`). Otherwise a deleted account blocks the same person from signing up again.
- **Multiple tenants.** If the same email can legitimately belong to users in different organizations, the index should be on `(tenant_id, lower(email))`.
- **App handling.** After this change, a signup race raises Postgres error `23505` (unique violation) instead of creating a duplicate. Catch it and treat it as "account already exists", or use `INSERT ... ON CONFLICT DO NOTHING RETURNING id`.
- **Your existing email index.** Every login looks up by email on 4M rows, so there's probably an index on email already. The unique index serves those lookups just as well, so drop the old one afterwards rather than maintaining both.

## Suggested order

1. Deploy the email normalization in the app, plus handling for the unique-violation error.
2. Find and merge the duplicates, and backfill the normalized emails if you chose Option A.
3. Build the index:
   ```sql
   CREATE UNIQUE INDEX CONCURRENTLY users_email_uniq ON users (lower(email));
   -- add WHERE deleted_at IS NULL if you soft-delete
   ```
   For Option A, index plain `(email)` instead.
4. Confirm it built: `SELECT indisvalid FROM pg_index WHERE indexrelid = 'users_email_uniq'::regclass;`
5. Drop the old index with `DROP INDEX CONCURRENTLY`.

At 4M rows the index itself is modest, likely a few hundred MB at most, and the concurrent build should take minutes, not hours. Neither the lookup cost nor the extra write cost is a real concern.

## Dissent

- **It may not fix your actual bugs.** An index catches signups that race each other and, once normalized, case and spacing differences. It does nothing when the same person has two different emails, such as a sign-in through Google or Apple using another address, Apple's "Hide My Email" relay addresses, or an email change. Check which kind your two bugs were. If they were the different-email kind, you also need logic that links a new sign-in to an existing account.
- **Email squatting.** If uniqueness also covers unverified emails, someone can register an address that isn't theirs and block the real owner. The usual fix is to send a "you already have an account, reset your password?" email to that address when a second signup tries it, rather than showing an error.
- **Don't treat Gmail dots and `+tags` as the same address.** They are different addresses at other providers, and merging them causes more trouble than it prevents.

**Bottom line:** do it, but with case-insensitive matching, built concurrently, after you merge the existing duplicates, and with the app handling the new error. Look at your two duplicate pairs first; they'll tell you whether the index alone is enough.