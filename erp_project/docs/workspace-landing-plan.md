# Workspace landing page at `/`

**Status:** built locally on 2026-11-02, not committed or deployed.

## Goal

`erp.mcaffeine.com/` becomes one front door for both ERPs. After sign-in, users pick a workspace:

| Card | Opens |
|---|---|
| PRE-FG | `/dashboard`, the pre-FG home that used to sit at `/` |
| POST-FG | `/postfg/`, the post-FG app behind the nginx block (see `post-fg-routing-plan.md`) |
| Need a hand? | `/dashboard`, the "How this system works" guide, until real docs exist |
| Coming next | NPD and Finance. Static, not clickable |

## What changes (pre-FG app only)

| Change | Where |
|---|---|
| The old home page moves to `/dashboard`, with its content unchanged | `app/page.tsx` → `app/dashboard/page.tsx` |
| New landing page at `/`. It requires sign-in and is shown without the sidebar or top bar | `app/page.tsx` |
| `/` renders without the shell, like `/auth/*` | `components/ClientLayout.tsx` |
| The sidebar's "Dashboard" entry points to `/dashboard`. The PEP logo links back to `/` | `components/Sidebar.tsx` |
| The "Dashboard" slug is dropped from the permission list, so the guide is open to every signed-in user | `lib/pages.ts` |
| The "What's new" popup doesn't open on the landing page, only inside pre-FG | `components/WhatsNewDialog.tsx` |

### Unchanged
- The sign-in flow. Its default `redirectTo: "/"` now lands on the picker.
- `/auth/unauthorized`. Its "Home" link now lands on the picker, which is fine.
- nginx, DNS, post-FG code, the database and Uniware.

## Decisions taken

1. **The landing page lives inside pre-FG at `/`.** It is not a separate site. Moving pre-FG under `/prefg` would change every URL, the OAuth callback and every bookmark.
2. **The guide is ungated.** Today the `/` grant only shows or hides a lock icon in the sidebar; the page itself never checked it. A new `/dashboard` slug with no rows would resolve to `none` and lock it for everyone. Leaving it ungated avoids a migration. Old `page_permissions` rows for `/` stay in the DB, unused.
3. **Everyone sees both cards.** Each app enforces its own access.
4. **The post-FG card is a plain `<a>`, not `next/link`.** It's a different app, so the browser has to do a full page load.
5. **Brand marks are styled text for now.** Swap them for the real SVGs when design hands them over.

## Deferred until post-FG goes to prod

- **The POST-FG card links to `/postfg/` everywhere.** It works on `dev.erp`. On prod (and on a local `next dev`) it 404s until the post-FG prod nginx block exists. Agreed to fix it at the post-FG prod move.
- **Sign-in happens twice.** Users sign in again inside post-FG, because it has its own session (`postfg_session`). Shared login is post-FG work (decode the `authjs` JWT with the same `AUTH_SECRET`).
- **There's no "back to workspaces" link inside post-FG yet.** Ask the post-FG team to add `<a href="/">`.

## Rollout

1. **Local:**
   - signing in lands on `/`, with no sidebar;
   - the PRE-FG card opens `/dashboard` with the sidebar, and "Dashboard" is highlighted;
   - the logo returns to `/`;
   - other pre-FG pages are unaffected;
   - `tsc` and lint pass.
2. **Dev (`dev.erp`), via the normal test deploy:**
   - the POST-FG card does a full page load into post-FG;
   - a direct refresh on `/dashboard` works.
3. **Prod:** the normal release, with its own go-ahead. Users there see a POST-FG card that 404s until the deferred item is fixed. Hold the prod release until then if that isn't acceptable.

**Rollback:** revert the commit.

## Risks

| Risk | Mitigation |
|---|---|
| Bookmarks to `/` expecting the guide | Both the PRE-FG card and "Need a hand?" are one click away |
| A role that had `/` = none now sees the guide | It's documentation only. Re-add a `/dashboard` slug plus a grants migration if that matters |
| The POST-FG card is dead on prod | Deferred, see above |
