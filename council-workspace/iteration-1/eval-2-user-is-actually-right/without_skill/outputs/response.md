I couldn't get a council together. The council skill runs as a Workflow script, and this session doesn't have the Workflow tool, so no council members voted. Below is my own take, not a council verdict. I checked the Postgres details against the current docs (PostgreSQL 18). The rest is my judgement.

## Short answer

Yes, having the database enforce unique emails is the right fix. It's the only thing that stops two signups for the same email that arrive at the same time. Checking in app code before inserting can't do that.

But a unique index on `users.email`, exactly as you describe it, may not fix your bugs, and it won't build if duplicates already exist. Check four things first.

**1. Upper and lower case.** If your duplicates look like `Foo@x.com` and `foo@x.com`, a plain unique index on `email` allows both. Index `lower(email)` instead, and change the login query to `WHERE lower(email) = lower($1)` so it uses that index. Another option is to lowercase and trim emails every time you write them, then keep a plain index. The `lower(email)` index is safer because it doesn't depend on every code path doing that.

**2. Duplicates you already have.** Building a unique index fails if any duplicates exist. Find them first:
```sql
SELECT lower(email), count(*) FROM users GROUP BY 1 HAVING count(*) > 1;
```
Merging those accounts is usually most of the work: deciding which one survives and pointing its related rows at it.

**3. How you build it on 4M rows.** A plain `CREATE INDEX` blocks inserts, updates and deletes on `users` until the build finishes. Reads still work. Use `CREATE UNIQUE INDEX CONCURRENTLY` instead, which has two catches:
- It can't run inside a transaction. Most migration tools wrap each migration in one, so turn that off for this migration.
- If it fails partway, for example because a duplicate arrives during the build, it leaves behind an INVALID index that still enforces uniqueness. Drop it and retry.

**4. What the two bugs actually were.** If they came from two signups arriving together or from case differences, this fixes them. If the person signed up with two different addresses (an alias, a typo, a changed email), no index on email will help.

## Login speed isn't a reason for this change

A 4M-row table that you query by email on every login almost certainly has an index on `email` already. Check with `\d users`. A unique index doesn't make lookups meaningfully faster than a normal one. Once the new one is built, drop the old one so you aren't maintaining both.

## Smaller points

- Your app has to catch the duplicate error (SQLSTATE `23505`) and show "account already exists" rather than a 500 error. For insert-or-update statements, `ON CONFLICT ((lower(email)))` works with the new index.
- If you soft-delete users and want them to be able to sign up again, add `WHERE deleted_at IS NULL` so the index only covers active users.
- Users with no email (phone-only or single sign-on) are fine. By default a unique index allows any number of NULLs.
- You can't turn a `lower(email)` index or a `WHERE`-limited index into a named `UNIQUE` constraint, because `ALTER TABLE ... USING INDEX` rejects both. The index still enforces uniqueness; it just won't show up as a constraint.

## Suggested order

```sql
-- 1. Find and merge existing duplicates.
-- 2. Deploy app code that lowercases/trims emails on write and handles 23505.
-- 3. Outside a transaction:
CREATE UNIQUE INDEX CONCURRENTLY users_email_lower_key ON users (lower(email));
-- 4. Switch the login query to lower(email) = lower($1), then:
DROP INDEX CONCURRENTLY <old_email_index>;
```

For a real council verdict, run the council from a main Claude Code session that has the Workflow tool.