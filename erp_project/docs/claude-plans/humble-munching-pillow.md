# Scheduled jobs on the existing EC2 box

## Context

Two Uniware sweeps run today only when somebody clicks a button on /po-tracking:
the PO status refresh ([uniware-status/route.ts](erp_project/app/api/v1/purchase-orders/uniware-status/route.ts))
and the GRN pull ([uniware-grn/route.ts](erp_project/app/api/v1/purchase-orders/uniware-grn/route.ts)).
Both were written knowing this day would come — `lib/uniware/grn-sync.ts` says so
in its header ("manual button today and a scheduled sweep later; keeping the work
here means the scheduler calls the same code path rather than a second copy") and
both `MAX_PER_RUN` caps name "the scheduled sweep" as the answer when the mirrored
set outgrows them.

You want these running every few hours in business hours, and you have **more jobs
coming**. So the thing being designed here is not "a cron job for GRN sync" — it is
**the place a job gets registered**, such that job #7 costs one array entry and a
normal deploy, with no SSM command, no bootstrap re-run, and nobody SSH-ing into
the box.

The outcome: one systemd timer installed once, never touched again; a job list that
lives in the app and ships through CI like any other code change.

---

## The way

### Why the schedule lives in the app, not in the crontab

The obvious move is a crontab line per job on the box. It is wrong here for one
concrete reason: **there is no repo checkout on the EC2 instance.** CI
([deploy.yml](.github/workflows/deploy.yml)) inlines its rollout commands into an
`ssm send-command` and only ever pulls an image — nothing on the host is
version-controlled after bootstrap. Every new crontab line would be a hand-run SSM
command, drifting between test and prod, invisible in git, and forgotten at the
next reprovision. With "many more to set up", that friction compounds every time.

So the box gets **one** dumb hourly trigger that never changes, and the app answers
"which jobs are due right now". The schedule becomes reviewable code.

Second-order win, free: the container already runs `TZ=Asia/Kolkata` (Dockerfile,
with a comment explaining why). Ask the app for the hour and you get IST. The host's
UTC clock never enters the picture — the classic "cron fired at 09:00 UTC = 14:30
IST" bug cannot happen.

### Why systemd timer, not cron

`deploy/bootstrap-instance.sh:133-155` already installs `certbot-renew.timer` this
exact way. Amazon Linux 2023 ships systemd but not `cronie`. Reusing the pattern
that is already in the file beats installing a package.

### Why the jobs are extracted into `lib/`, not called over HTTP

The GRN sweep is already a callable (`runGrnSync`). The status sweep is not — its
work sits inline in the route handler. The scheduler calling the same callable the
button calls is the whole point of that design note; going over HTTP instead would
mean minting a session for cron and punching a bypass through
[with-gateway.ts](erp_project/lib/gateway/with-gateway.ts) — a new authn path on
the trust boundary of every route in the app, to save one refactor. Not worth it.

**The registration contract, for every future job:** move the work into a callable
in `lib/`, make the route a thin wrapper over it, add one line to the job array.

### Order is load-bearing

Status sync must run **before** GRN sync. It writes `grn_count` per PO
(`uniwareGrn.setGrnCount`), and that is exactly what lets the GRN sweep walk only
POs that actually have receipts (`uniwareGrn.selectForGrnSync`). Run them the other
way round and the GRN sweep works off yesterday's counts. Sequential execution in
array order gives this for free — do not parallelise the job runner.

### Gates

1. Ships to **test** first (a push to main goes to test by default). Watch a full
   business day of runs in CloudWatch.
2. Promote to prod via `workflow_dispatch`, and push `CRON_KEY` to `/erp-app/prod`
   in the same sitting — a missing key must fail closed (see below), so prod would
   simply refuse to run until it is there.

### Risks and what absorbs them

| Risk | Absorbed by |
|---|---|
| Route is internet-reachable — nginx proxies `/` to the app | Shared secret, constant-time compare, **plus** an nginx `deny all` on the path. Cron curls `127.0.0.1:3000` directly and never traverses nginx, so the deny costs nothing. |
| Missing/empty `CRON_KEY` silently disabling auth | Route returns 503 when the env var is unset. Fail closed, never "no key = no check". |
| A slow sweep overlapping the next hour's trigger | systemd will not start a second instance of an active oneshot unit; the route also refuses a concurrent run. |
| Uniware tenant contention with warehouse staff | Business-hours-only window, existing `MAX_PER_RUN` caps (150 status / 40 GRN) unchanged. |
| A job throwing and killing the rest of the run | Runner catches per job, reports, continues — same never-throw-for-one contract the sweeps already use internally. |

---

## Changes

### 1. Extract the status sweep into a callable — `lib/uniware/status-sync.ts` (new)

Move the body of the handler in
[uniware-status/route.ts](erp_project/app/api/v1/purchase-orders/uniware-status/route.ts)
into `runStatusSync(ctx)`, returning the same object the route returns today.
Move `MAX_PER_RUN = 150` and its `ponytail:` comment across with it. Mirror
`grn-sync.ts`: `export async function runStatusSync(ctx: RequestContext)`.

The route then becomes the same three lines `uniware-grn/route.ts` already is:

```ts
handler: async ({ ctx }) => {
  if (!uniwareEnabled()) {
    throw new ApiError(400, "uniware_unconfigured", "Uniware is not configured on this environment.")
  }
  return NextResponse.json(await runStatusSync(ctx))
},
```

No behaviour change; the UI contract is identical.

### 2. The job registry — `lib/cron/jobs.ts` (new)

The only file that changes when a job is added. Plain array, no cron parser, no DB
table:

```ts
import { runStatusSync } from "@/lib/uniware/status-sync"
import { runGrnSync } from "@/lib/uniware/grn-sync"

// ORDER IS EXECUTION ORDER, and it matters: the status sweep writes grn_count,
// which is what lets the GRN sweep walk only POs that have receipts. Reversing
// these makes the GRN sweep work off the previous run's counts.
//
// `hours` are IST hours — the container runs TZ=Asia/Kolkata (see Dockerfile),
// so getHours() is already IST and the host's UTC clock never enters into it.
export const CRON_JOBS = [
  { name: "uniware-status", hours: [9, 12, 15, 18, 21], run: runStatusSync },
  { name: "uniware-grn",    hours: [9, 12, 15, 18, 21], run: runGrnSync },
]
```

### 3. The trigger route — `app/api/v1/cron/run/route.ts` (new)

Deliberately **not** wrapped in `withGateway` — there is no user, no session, and
no page slug. Its own auth, and nothing else's.

- `export const runtime = "nodejs"`, no `maxDuration` (it is a Vercel-only hint and
  a no-op on self-host; curl's `--max-time` is the real bound).
- Reject unless `CRON_KEY` is set (503) and the `x-cron-key` header matches under
  `crypto.timingSafeEqual` — compare hashes so lengths cannot differ.
- Module-level `running` boolean → 409 on overlap.
  `// ponytail: single-process flag; a DB lock if we ever run more than one container.`
- Select `CRON_JOBS.filter(j => j.hours.includes(new Date().getHours()))`, run them
  in array order, `try/catch` each so one failure does not cost the rest.
- `logger.info` per job with name / ms / result, and return the summary as JSON.
  Logs land in `/app/logs` → `/var/log/erp` → CloudWatch, already configured.

### 4. Secret — `deploy/push-secrets.mjs`

Add `"CRON_KEY"` to the `KEYS` array (line ~36). Generate with
`openssl rand -hex 32`, put it in `.env`, then `node deploy/push-secrets.mjs test`.
`redeploy-app.sh` counts SSM params against what it parses, so the new key flows to
`/etc/erp/env` on the next deploy with no extra step.

### 5. Host units — `deploy/bootstrap-instance.sh`

Append after the certbot timer block (line ~155), copying its shape exactly:

```bash
cat > /etc/systemd/system/erp-cron.service <<'EOF'
[Unit]
Description=ERP scheduled jobs (the app decides which are due)
After=docker.service

[Service]
Type=oneshot
EnvironmentFile=/etc/erp/env
ExecStart=/usr/bin/curl -sS --fail-with-body --max-time 1800 -X POST \
  -H "x-cron-key: ${CRON_KEY}" http://127.0.0.1:3000/api/v1/cron/run
EOF

cat > /etc/systemd/system/erp-cron.timer <<'EOF'
[Unit]
Description=Trigger ERP scheduled jobs hourly

[Timer]
OnCalendar=*-*-* *:00:00
# The app decides what is due, so a few minutes of jitter costs nothing and keeps
# test and prod from hitting the Uniware tenant on the same second.
RandomizedDelaySec=300
# Deliberately NOT Persistent: a missed window is skipped, not replayed on boot.
EOF

systemctl daemon-reload
systemctl enable --now erp-cron.timer
```

And in the nginx `server` block (~line 106), above `location /`:

```nginx
    location /api/v1/cron { allow 127.0.0.1; deny all; }
```

### 6. One check — `tests/unit/cron-jobs.test.ts` (new)

Not a suite. Asserts what actually breaks silently: `uniware-status` precedes
`uniware-grn` in `CRON_JOBS`, names are unique, and every `hours` entry is 0–23.
Ordering is the failure that produces stale-but-plausible data rather than an error.

---

## Verification

**Local**

1. `npm test` — the ordering check passes.
2. `CRON_KEY=x npm run dev`, then:
   - `curl -X POST localhost:3000/api/v1/cron/run` → 401
   - with `-H "x-cron-key: x"` → 200, and the body lists only jobs due this IST hour
   - drop `CRON_KEY` from the env → 503, not 200
3. Temporarily widen one job's `hours` to the current hour and confirm the sweep
   actually runs and its result matches what the /po-tracking button returns.

**On test**

4. Push to main (CI deploys to test). Then over SSM:
   - `systemctl list-timers erp-cron.timer` — next fire time is sane
   - `systemctl start erp-cron.service; journalctl -u erp-cron.service -n 50` — the
     curl returned 200 and the body is in the journal
   - CloudWatch: one log line per job with its result
5. Confirm the route is not reachable from outside: `curl -X POST
   https://dev.erp.mcaffeine.com/api/v1/cron/run` → 403 from nginx.
6. Leave it a full business day. Check the five windows fired and that
   `truncated` is false — if it is true, that is the signal the caps need raising,
   which is a separate decision.

**Promote**

7. `workflow_dispatch` → prod, with `CRON_KEY` pushed to `/erp-app/prod` first.

---

## Explicitly out of scope

- Per-job schedules finer than "which IST hours" (no minutes, no weekday rules).
  Add a `days` field to the array entry when a job actually needs it.
- Alerting on a failed run — the results are in CloudWatch; a metric filter and
  alarm is the follow-up once we know what a normal run looks like.
- `scripts/sync-skus-from-dwh.ts` and the other `tsx` scripts. They are not in the
  production image (standalone build, no source, no tsx). Scheduling one means
  porting it to a `lib/` callable first — the same contract as everything else.
- Any change to `with-gateway.ts` or to how the existing buttons authenticate.

---
---

# Part 2 — Automatic application versioning

*Searched for an earlier versioning plan first: `docs/` (only `/api/v1/` URL versioning
and BOM `<sku>RM<n>PM<n>` codes), all 31 files in `.claude/plans/`, git history (no
deleted docs), and memory. Nothing. The one lead — the EC2 deploy plan named in the
`project-ec2-docker-deploy` memory as `enumerated-gathering-tulip.md` — no longer
exists on disk. Planned fresh.*

## Context

Nothing currently running can identify itself:

- `app/api/health/route.ts` returns `{status:"ok"}` and nothing else
- `package.json` has said `"version": "1.0.0"` since the first commit
- the repo has **zero git tags**
- the box pulls the **moving** `:test` / `:prod` tag, so `docker images` on the
  instance says `prod` and nothing about which commit that is

So "what is actually on prod right now" currently takes an ECR digest comparison to
answer — during an incident, which is exactly when nobody wants to be doing that.

The good news is this is mostly already solved and just not surfaced: CI already
pushes an immutable `:<env>-<sha>` tag alongside the moving one. The identity exists
in ECR; it evaporates the moment the container starts.

**Goal:** `curl /api/health` answers "which commit is this", automatically on every
deploy, with no version-bump commits and no new tooling.

## Decisions

| # | Decision | Consequence |
|---|---|---|
| 1 | Version = **git SHA**, baked at image build time | no bump commits, no merge conflicts on a version field, never drifts from reality |
| 2 | Surfaced on the **existing** `/api/health` | no new route, no new auth surface |
| 3 | **No `semantic-release`** | see below — the commit history can't carry it yet |
| 4 | **SemVer**, auto-incremented by CI, stored in **git tags** | `package.json` stays `1.0.0` and is ignored; no commit written back to the repo |
| 5 | Patch/minor/major chosen from a **`workflow_dispatch` dropdown** | the prod deploy is already a manual dispatch — the decision goes where a human already is |
| 6 | Only **prod** deploys bump the version | test builds are SHA-identified; a release is what a prod deploy *is* |
| 7 | Deploy mechanics unchanged — the box keeps pulling the moving tag | rollback stays a manual `docker run :<env>-<sha>`; deliberately out of scope |

### Why not `semantic-release`

It derives the version bump from commit messages. The last 20 commits are ~75%
Conventional Commits (`feat(uniware):`, `fix(gateway):`) with real holdouts:
*"Modified multiple files."*, *"Minor chnage in uinware."*, *"Fixed the Silent
Breaking of the Forbidden page access."*

Those parse as **no release**. A deploy carrying real changes would ship under an
unchanged version number — worse than no versioning, because it is confidently
wrong. Making it safe means enforcing commit format with a `commit-msg` hook first:
a team behaviour change that has to land *before* any value arrives. Revisit once
the history has been clean for a month.

### Who decides patch vs minor

No machine can read a diff and know whether it is a bugfix or a feature — that is a
judgment about intent. Every semver automation is just a different answer to "who
tells us": commit messages, PR labels, a committed changeset file, or a human at
release time.

The prod deploy is **already** a manual `workflow_dispatch` where someone picks an
environment from a dropdown. That person knows what they are shipping. Adding a
second dropdown costs one input block and needs no commit discipline, no hooks, no
PR workflow, and no new dependency.

### Why git tags and not `package.json`

Storing the number in `package.json` forces CI to commit back to the repo on every
release: a commit nobody authored on main, which re-triggers CI (needing `[skip ci]`
guards), conflicts whenever two branches touch the version line, and becomes a second
source of truth that can disagree with the tag. Tags are read-only from CI's side —
compute `latest + 1`, create, push. Nothing to conflict.

## Changes

### 1. `Dockerfile`

Immediately before `CMD`, and **not earlier**. `ARG` invalidates the layer cache for
everything below it and every build carries a fresh SHA, so late placement keeps the
expensive `COPY` layers cached:

```dockerfile
ARG APP_VERSION=dev
ARG GIT_SHA=dev
ARG BUILD_TIME=unknown
ENV APP_VERSION=$APP_VERSION
ENV GIT_SHA=$GIT_SHA
ENV BUILD_TIME=$BUILD_TIME

CMD ["node", "server.js"]
```

Both are carried, and they answer different questions: `APP_VERSION` is the release
name a person says out loud (`v1.2.0`, or the raw SHA on test); `GIT_SHA` is forensic
— a tag can be moved or deleted, a SHA cannot lie. `ARG` is build-time only and
vanishes with the build; `ENV` is what survives into the running container. Both are
needed — `ARG` to receive, `ENV` to keep.

### 2. `app/api/health/route.ts`

Replace the file:

```ts
import { NextResponse } from "next/server"

// force-dynamic so this reports the RUNNING container. Without it Next can
// statically evaluate a GET that touches no request data at build time, and the
// endpoint would answer with whatever it saw then rather than what is deployed.
export const dynamic = "force-dynamic"

export async function GET() {
  return NextResponse.json({
    status: "ok",
    // On prod this is a release tag (v1.2.0). On test it is the raw SHA, which
    // correctly signals "not a release".
    version: process.env.APP_VERSION ?? "dev",
    // Short SHA, not the full 40. Enough to identify a build, and this route is
    // public — nginx proxies / to the app and there is no withGateway here.
    commit: (process.env.GIT_SHA ?? "dev").slice(0, 7),
    builtAt: process.env.BUILD_TIME ?? null,
  })
}
```

`force-dynamic` is defensive rather than required on Next 16, where GET route
handlers are already dynamic by default. Keep it as documentation of intent — the
failure it guards against (the value being frozen at build time, when `APP_VERSION`
is not yet set because the `ENV` lives in the runner stage) is silent and would
otherwise only surface on the second deploy.

### 3. `.github/workflows/deploy.yml`

**3a. The bump dropdown**, beside the existing `environment` input:

```yaml
      bump:
        description: "Version bump (prod only)"
        required: true
        default: patch
        type: choice
        options: [patch, minor, major, none]
```

`none` redeploys the current release without burning a number — an infra fix, or
retrying a failed rollout.

**3b. Job prerequisites.** Three settings on `build-and-push`, each of which fails
silently rather than loudly if missed:

- `permissions: contents: write` (currently `read`) — otherwise the tag push 403s.
- `actions/checkout` needs `fetch-depth: 0` — the default shallow clone fetches **no
  tags**, so `git tag -l` comes back empty and every release computes as `v0.0.1`.
- The step below must run **before** the docker build.

**3c. Compute and push the tag:**

```yaml
      - name: Compute version
        id: version
        if: steps.target.outputs.environment == 'prod' && github.event.inputs.bump != 'none'
        run: |
          # --sort=-v:refname is LOAD-BEARING: it sorts by version, not lexically.
          # Lexically, v1.10.0 sorts BEFORE v1.9.0, so past version 9 every release
          # computes from the wrong base and the sequence silently goes backwards.
          LATEST=$(git tag -l 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname | head -n1)
          if [ -z "$LATEST" ]; then
            # First release ever starts at v1.0.0, whatever `bump` says — the app has
            # been in production for months and package.json has claimed 1.0.0 since
            # the first commit, so v0.0.1 would read as a step backwards.
            NEW="v1.0.0"
          else
            IFS=. read -r MAJOR MINOR PATCH <<< "${LATEST#v}"
            case "${{ github.event.inputs.bump }}" in
              major) MAJOR=$((MAJOR+1)); MINOR=0; PATCH=0 ;;
              minor) MINOR=$((MINOR+1)); PATCH=0 ;;
              patch) PATCH=$((PATCH+1)) ;;
            esac
            NEW="v$MAJOR.$MINOR.$PATCH"
          fi
          echo "Releasing ${LATEST:-<none>} -> $NEW"
          # Pushed BEFORE the build on purpose: if two prod deploys race, both read
          # the same LATEST and the loser's push is rejected here in seconds rather
          # than after a full build. Monotonic by construction.
          git tag "$NEW" && git push origin "$NEW"
          echo "version=$NEW" >> "$GITHUB_OUTPUT"
```

Lower components always reset to zero, which is what keeps it monotonic:
`1.0.5 --minor--> 1.1.0`, never `1.1.5`.

**3d. Pass both values into the build.** The `||` fallback is what makes test builds
SHA-identified without a second code path:

```yaml
          docker build \
            --build-arg APP_VERSION="${{ steps.version.outputs.version || github.sha }}" \
            --build-arg GIT_SHA="${{ github.sha }}" \
            --build-arg BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
            -t "$REGISTRY/$ECR_REPOSITORY:$ENVIRONMENT-$IMAGE_TAG" \
            -t "$REGISTRY/$ECR_REPOSITORY:$ENVIRONMENT" \
            erp_project
```

**That is the whole feature.** The step below is optional.

### 4. (Optional) Make the version earn its keep — verify the rollout

Today the deploy step fires `aws ssm send-command`, receives a `CommandId`, and the
workflow goes green whether or not the container ever came up. A SHA on
`/api/health` lets the last step prove it did:

```yaml
      - name: Verify rollout
        env:
          ENVIRONMENT: ${{ steps.target.outputs.environment }}
        run: |
          HOST=$([ "$ENVIRONMENT" = prod ] && echo erp || echo dev.erp)
          EXPECTED=$(echo "${{ github.sha }}" | cut -c1-7)
          for i in $(seq 1 30); do
            # .commit, not .version — on prod `version` is a release tag, so the SHA
            # is the only field that proves THIS build is the one now serving.
            GOT=$(curl -sf --max-time 10 "https://$HOST.mcaffeine.com/api/health" | jq -r .commit || true)
            [ "$GOT" = "$EXPECTED" ] && echo "live: $GOT" && exit 0
            sleep 10
          done
          echo "Timed out. /api/health reports '${GOT:-unreachable}', expected $EXPECTED" >&2
          exit 1
```

Turns "deploy dispatched" into "deploy verified", which is the more valuable half.
Host names match `deploy/push-secrets.mjs` (`erp.` for prod, `dev.erp.` for test).

## Verification

1. **Local build:** `docker build --build-arg APP_VERSION=v9.9.9 --build-arg
   GIT_SHA=abc1234def -t erp:t erp_project`, run it, curl `/api/health` →
   `version: "v9.9.9"`, `commit: "abc1234"`.
2. **Unset path:** `npm run dev` → `version: "dev"`. Confirms nothing crashes when
   the ARGs were never passed.
3. **Test deploy:** push to main, then curl `https://dev.erp.mcaffeine.com/api/health`
   → `version` is the raw SHA (no tag was cut), `commit` matches what you pushed.
4. **Not a stale bake:** deploy a second, different commit to test and confirm both
   `commit` and `builtAt` move. Without this, step 3 passes once and then reports the
   same value forever — the failure mode `force-dynamic` guards against.
5. **First prod release:** dispatch prod with any `bump`. With no tags in the repo
   this must produce **`v1.0.0`** — the workflow special-cases the empty case rather
   than bumping v0.0.0 to v0.0.1. `git tag -l` must show it on the remote.
6. **The increment is real:** dispatch prod again with `bump: minor` → **`v1.1.0`**,
   not `v1.0.1`. Then `bump: none` → no new tag, `version` unchanged. This is also
   what catches the `fetch-depth: 0` bug: with a shallow clone the tag lookup stays
   empty forever, so *every* release re-runs the first-release branch and comes out
   `v1.0.0` — which looks like it worked until you notice it never moves.
7. **Sort ordering** (do once, cheaply): `git tag v1.9.0 && git tag v1.10.0` locally,
   then `git tag -l 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname | head -n1` must print
   `v1.10.0`. Delete both afterwards. Proves the version sort, not the lexical one.
8. **If §4 is adopted:** push a commit that breaks container startup and confirm the
   workflow goes **red** rather than green.

## Out of scope

- `semantic-release` / `release-please`, changesets, CHANGELOG generation. Revisit
  commit-driven bumps once a `commit-msg` hook has been in place for a month — the
  tags are the store either way, so switching later is a small change. The signal
  that it is safe: you notice you have been picking `patch` without thinking for
  months.
- Bumping `package.json`'s `version` field. Left at `1.0.0` deliberately — nothing
  reads it, and a second source of truth would drift from the tags.
- Changing which image tag the box pulls, and automated rollback. The immutable
  `:<env>-<sha>` tags already in ECR make a manual rollback possible today;
  automating it is a separate decision.
