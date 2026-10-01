# Deploy verification — plan

**Problem.** `.github/workflows/deploy.yml` "Roll out to EC2 via SSM" calls `aws ssm send-command`
and exits with the command id. SSM runs it asynchronously, so the job is green whether the
container came up, crash-looped, failed to pull, or the tag matched **no instance at all**.

**Goal.** The job goes red when the box isn't serving the commit just built, and the log says why.

## Approach — two checks, one inside the box, one outside

| Check | Where | Proves |
|---|---|---|
| A. In-box | appended to the SSM script | container up, `/api/health` on `127.0.0.1:3000` reports this SHA, `RestartCount` still 0 after a soak |
| B. Runner | new CI step after send-command | the SSM command finished `Success` on every targeted instance (≥1) |
| C. Public (optional) | same CI step | `https://{dev.,}erp.mcaffeine.com/api/health` reports this SHA, i.e. nginx + TLS + DNS are fine |

A does the real work: it runs where the container is, needs no network path from GitHub, and
`set -euo pipefail` already makes any failed line fail the SSM command. B is what makes CI
*read* that result. C catches the nginx/cert layer, which A cannot see.

### A. In-box steps
0. **Pull by digest, not by the mutable `:<env>` tag.** CI takes the digest from `docker push`
   and the box runs `erp-app@sha256:…`. Two pushes racing can no longer hand the box the other
   build's image, and the running digest is checked against CI's rather than trusted.
   Prune still works: a digest-pulled image has no tag, so once the old container is gone the
   old image is dangling. Verify that on test before relying on it.
1. Poll `curl -fsS 127.0.0.1:3000/api/health` every 3s for up to ~90s until the response has
   `status = "ok"`, `commit` = first 7 chars of `github.sha`, **and** `env` = the deploy target.
   The `env` check catches the prod box reading test's env file, which would silently point it
   at the dev schema (`lib/env.ts` picks `DB_NAME_*` from `APP_ENV`; `push-secrets.mjs` sets it
   for both). Timeout ⇒ fail.
2. Soak ~20s, then require `docker inspect -f '{{.RestartCount}}' erp` = 0. A process that
   answers once and then dies (bad env, DB pool crash) would otherwise pass step 1 between restarts.
3. **Always print, pass or fail:** container `State.Status`, `RestartCount`, running image
   digest, the health body, and `docker logs --tail 80 erp`. A green run then records what
   actually went live, and a red one says why.
4. Only then `docker image prune -f`.

### B. Runner step
- Capture the command id; `list-command-invocations` until it has entries (fail if 0 after
  ~30s — tag matched nothing).
- Poll `get-command-invocation` per instance until terminal, with our own loop
  (~6 min ceiling). Not `aws ssm wait command-executed`: its waiter gives up at ~100s,
  shorter than a cold `docker pull`.
- Print `StandardOutputContent` / `StandardErrorContent` either way, so the failure reason is
  in the Actions log, not only in the SSM console.

### Also
- Add `concurrency: { group: deploy-<env>, cancel-in-progress: false }` — two pushes in quick
  succession currently race `docker rm -f erp` on the same box.

## Phases and gates

| Phase | Scope | Exit gate |
|---|---|---|
| 0 | Confirm the GitHub OIDC role (`AWS_DEPLOY_ROLE_ARN`) has `ssm:GetCommandInvocation` + `ListCommandInvocations`. `deploy/iam-policy-erp-app-deploy.json` grants them, but that may be the laptop user's policy, not the role's | read the role's attached policies — **owner: Ajay** (AWS console) |
| 1 | A + B + concurrency, on **test only** (push to main) | one green deploy, then two deliberate failures on test, both red with logs: (i) a container that won't start, (ii) a **wrong SHA** — run the in-box check by hand over SSM with a bogus expected SHA against a healthy container. (ii) proves the comparison can fail at all (an empty `commit` parse matching an empty expectation would pass forever). No test-only input added to the workflow |
| 2 | C (public probe) + one smoke check: `GET /api/auth/providers` returns Google | green on test. Unauthenticated, read-only, and exercises the NextAuth config that broke sign-in in prod once (`AUTH_URL`) |
| 3 | Same workflow on a prod dispatch | **separate go-ahead** |
| 4 (decision) | Auto-rollback | see below |

## Decision gate — what happens on red (owner: Ajay)

Today `docker rm -f erp` runs before the new container starts, so a failed deploy leaves the
box **down**, not on the old version. Options:

- **(a) Red only.** Simplest; a human redeploys the last good SHA via dispatch. Downtime until then.
- **(b) Auto-rollback.** Before pulling, tag the running image `erp-app:<env>-previous`; on
  failure of A, start that instead and still exit 1. Box stays up on the old build, CI still red.

Decided: (a) in Phase 1. (b) is considered only after Phase 1 has run cleanly for a week —
rollback logic is itself deploy code that needs to be proven. With digest pulls, (b) keeps the
previous digest in a file on the box instead of a `-previous` tag.

## Risks

| Risk | Mitigation |
|---|---|
| Builds that were "green" turn red — the reason this was deferred | That is the point; generous timeouts (90s health, 6 min SSM) keep it to real failures |
| SSM agent slow to pick up the command | invocation-list retry before declaring "no target" |
| Health passes but DB is unreachable (`/api/health` has no DB call, by design) | out of scope; a `/api/health?deep=1` is a later, separate change |
| Escaped JSON inside `--parameters` grows hard to edit | move the remote script into a heredoc'd file sent via `commands` lines, or `deploy/remote-deploy.sh` baked into the step |
