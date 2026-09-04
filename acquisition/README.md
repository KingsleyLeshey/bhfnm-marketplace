# BHFNM Acquisition Engine

Autonomous marketplace supply-acquisition engine — discovers hemp businesses
that fill the marketplace's supply gaps, researches them from their public
sites, scores them, and (later) runs compliant outreach.

**Cloudflare-native:** Workers, D1, R2, Queues, Workers AI, Cron Triggers,
with Cloudflare Access fronting the internal dashboard.

## Relationship to the marketplace

This lives in the marketplace repo for build convenience but is **completely
isolated**: its own `package.json`, dependencies, build and deploy. It imports
nothing from `../src`, and it never writes to the marketplace database.

To split it into its own repo later:

```bash
git subtree split --prefix=acquisition -b acquisition-only
# then push that branch to a new empty repo
```

## Develop

```bash
cd acquisition
pnpm install
npx vitest run        # 74 tests
npx tsc --noEmit
```

## Deploy (needs the accounts listed in PROGRESS.md)

```bash
wrangler d1 create bhfnm-acquisition     # put database_id into wrangler.toml
wrangler r2 bucket create bhfnm-acquisition-raw
wrangler queues create bhfnm-crawl
wrangler queues create bhfnm-crawl-dlq
pnpm run db:remote
wrangler deploy
```

Then put Cloudflare Access in front of the Worker route before exposing it.

## Status

See `PROGRESS.md` — it is the live build state and the task queue.
