# "What's new" popup after each release

Status: plan, awaiting go-ahead. 2026-10-30.

## What Ajay asked for
- **Automatic,** like a flash-sale banner: nobody writes notes by hand.
- **Same list for everyone,** so people can see whether the thing they reported was fixed.
- **Shows once per new batch:** on a user's first visit after a release, then not again.

## How it works
1. **The notes come from the commits.** When a **prod** release is deployed, the deploy workflow already cuts the new tag (`deploy.yml`, step `version`). One new step then reads `git log <previous tag>..<new tag>` and writes `release-notes.json` into the build: version, date, and the items.
2. **Only user-facing commits are kept:**
   - `feat` becomes **New**.
   - `fix` and `perf` become **Fixed**.
   - `refactor`, `chore`, `docs`, `ci`, `test`, `deps` and freeform messages ("Minor chnage") are dropped.
3. **Commit wording is turned into plain text.**
   - `fix(po): refuse to mail POs that aren't approved` becomes **PO Tracking** · "Refuse to mail POs that aren't approved".
   - The scope maps to the screen's name (`po` → PO Tracking, `invoice` → Invoices, `masters` → Masters, and so on).
   - Two optional commit trailers let a commit control its note:
     - `Release-note: <plain sentence>` replaces the text.
     - `Release-note: skip` hides the commit.
4. **The popup.**
   - A dialog in the app shell opens on load when the release is newer than what this user last saw.
   - **Layout:** a headline "What's new — v0.1.27 · 30 Oct", with "New" and "Fixed" groups each listing the screen name and the sentence, and one **Got it** button.
   - **Got it** records the version against the user, so it does not show again on any browser.
5. **Seen-state per user:**
   - **New column:** `users.whats_new_seen VARCHAR(20) NULL`, dev first. Prod is a separate go-ahead and must land before the deploy.
   - **New route:** `POST /api/v1/me/whats-new-seen` (`withGateway`, no page access needed) writes it.
6. **Nothing shows when there is nothing to show:**
   - test/dev builds, which have no tag, so no notes file;
   - a release whose commits were all internal.

## Sequencing and gates
| # | Step | Gate |
|---|---|---|
| 1 | Parser + generator in one plain-node file, `deploy/release-notes.mjs` (commit → note or skip, scope → screen map); unit tests in `tests/unit/release-notes.test.ts`. **Built 2026-10-30.** | `npm test`, plus a dry run over `v0.1.25..v0.1.26` and `v0.1.26..HEAD` that Ajay reads for tone |
| 2 | Workflow step running it to write `release-notes.json` into the build | A dry run in the workflow on a test deploy prints the JSON; it is not shipped |
| 3 | DDL `users.whats_new_seen` on **dev** | Stop; prod needs its own go-ahead |
| 4 | Popup in the app shell + the seen route | Dev: fake a notes file, open the app, click Got it, reload, and it stays closed |
| 5 | Prod DDL, then a prod release | Ajay |

## Option (b): reviewed notes (Ajay, 2026-10-30)

Notes are drafted from commits, rewritten in plain words, and approved before they ship. Nothing auto-generated reaches users.

**Before each prod release:**
1. Run `node deploy/release-notes.mjs draft`. It writes `release-notes/next.json` (`from` = the last tag, plus the drafted items).
2. Claude rewrites each item in plain words. Ajay approves, then commits.
3. Run the prod deploy. The **Stamp release notes** step in `deploy.yml` copies the items into `lib/release-notes/current.json` with the new tag.
   - It does this **only if `from` equals the previous tag**.
   - Stale or missing notes ship nothing, with a warning on the run. The deploy never fails.

**What decides whether the popup shows:**
- The committed `lib/release-notes/current.json` is empty, so local and test builds never show the popup.
- `users.whats_new_seen` holds the dismissed version. Any close counts as seen.
- If reading the seen-state fails, for example because the column is missing, the shell renders without the popup.

**Seen-state moved to the browser (Ajay, 2026-10-30, option 1):**
- **Where it lives:** `localStorage["whats-new-seen"]` holds the dismissed version.
- **What it costs:** no DB column, route or prod migration. A second browser or PC shows a release's popup once more.
- **Superseded:** the `users.whats_new_seen` column and the `/api/v1/me/whats-new` route described above. Both await cleanup.

**Progress 2026-10-30:**
- Built: steps 1–4, plus `users.whats_new_seen` on dev.
- Drafted: the v0.1.26.. notes, which Ajay still has to approve.
- Not yet: prod DDL and a prod release.

## Risks
- **Commit quality decides the note quality.** About a quarter of past commits are freeform and would be dropped silently. The `Release-note:` trailer is the escape hatch, and step 1's dry run shows what users would actually read.
- **Developer words may leak through** ("NDJSON", "scope", table names). The dry run is the check. A note that reads badly is fixed with the trailer on the next commit, not by editing the build.
- **First release after this ships** shows only that release's commits, not the whole backlog.
- **"Has my issue been solved?"** is answered only as well as the commit says it. Issues that aren't fixed yet don't appear, because nothing records them in the app.
