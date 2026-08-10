// Mints a NextAuth session cookie for a local user, so API routes can be tested
// with curl or Postman without going through the Google OAuth handshake.
//
//   node --env-file=.env tests/postman/mint-session.mjs                  # first active user
//   node --env-file=.env tests/postman/mint-session.mjs qa@mcaffeine.com # a specific one
//   node --env-file=.env tests/postman/mint-session.mjs --cookie         # ready to paste into a curl -H
//
// This is the same JWT the app issues on sign-in: NextAuth's own encode(), your
// AUTH_SECRET, salted with the cookie name. The app cannot tell the difference,
// which is the point — and also why this refuses to run against prod. Minting a
// session for an arbitrary user is a developer convenience on a dev schema and
// nothing else.
//
// It reads users/user_roles directly rather than through lib/db.ts because
// lib/env.ts would demand the app's full env just to open one connection.
// Also importable: `import { mintSession } from "./mint-session.mjs"` — smoke.mjs
// uses it so there is one definition of "a valid session" rather than two.
import { encode } from "next-auth/jwt"
import mysql from "mysql2/promise"
import { pathToFileURL } from "node:url"

/** The cookie the app sets on sign-in. Behind HTTPS it gains a __Secure- prefix. */
export const COOKIE_NAME = "authjs.session-token"
export const SECURE_COOKIE_NAME = "__Secure-authjs.session-token"

/** Which cookie a given origin uses. https ⇒ the __Secure- variant. */
export const cookieNameFor = (baseUrl) =>
  baseUrl.startsWith("https:") ? SECURE_COOKIE_NAME : COOKIE_NAME

/**
 * The session a test run should use: a cookie you supply, or a freshly minted one.
 *
 * Supply one (`--cookie` / `ERP_COOKIE`, copied from a browser you're signed into)
 * when testing a deployed environment — minting needs that environment's own
 * AUTH_SECRET and DB, which the local .env only happens to match while dev points
 * at the same RDS.
 */
export async function resolveSession({ base, cookie, as }) {
  const supplied = cookie ?? process.env.ERP_COOKIE
  if (supplied) {
    const value = supplied.includes("=") ? supplied : `${cookieNameFor(base)}=${supplied}`
    // A cookie copied out of a wrapped terminal or DevTools row carries newlines,
    // and a header value containing one is rejected outright.
    return { cookie: value.replace(/\s+/g, ""), userId: "?", email: "(supplied cookie)", roles: [], scope: "unknown — cookie was supplied, not minted" }
  }
  return mintSession(as, cookieNameFor(base))
}

export async function mintSession(email, cookieName = COOKIE_NAME) {
  if ((process.env.APP_ENV ?? "test") === "prod") {
    throw new Error("Refusing to mint a session token against prod. Unset APP_ENV.")
  }
  if (!process.env.AUTH_SECRET) {
    throw new Error("AUTH_SECRET is empty — run this with `node --env-file=.env`, not a bare node.")
  }

  // Matches lib/env.ts: the dev app runs on DB_NAME_TEST, so a token minted from
  // any other schema would carry a user id that doesn't exist where it's used.
  const database = process.env.DB_NAME_TEST
  if (!database) throw new Error("DB_NAME_TEST is not set — the .env file was not loaded.")

  const connect = () =>
    mysql.createConnection({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT ?? 3306),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database,
    })

  // RDS hands out a transient `connect ETIMEDOUT` often enough that a tool you
  // run repeatedly needs to ride it out — the same timeout lib/db.ts's withRetry
  // was extended to cover (docs/qa-audit-2026-08.md #7). One retry after a beat.
  let conn
  try {
    conn = await connect()
  } catch (err) {
    if (err.code !== "ETIMEDOUT") throw err
    await new Promise((r) => setTimeout(r, 500))
    conn = await connect()
  }

  try {
    const [users] = email
      ? await conn.execute("SELECT id, email, status FROM users WHERE email = ?", [email])
      : await conn.execute("SELECT id, email, status FROM users WHERE status = 'active' ORDER BY id LIMIT 1")
    const user = users[0]
    if (!user) {
      throw new Error(email ? `No user with email ${email} in ${database}` : `No active user in ${database}`)
    }
    // The real signIn callback refuses inactive users, so a token for one would
    // test nothing.
    if (user.status === "inactive") {
      throw new Error(`User ${user.email} is inactive — the app would reject this sign-in.`)
    }

    const [roleRows] = await conn.execute("SELECT role FROM user_roles WHERE user_id = ?", [user.id])
    const [scopeRows] = await conn.execute(
      "SELECT entity_type, COUNT(*) AS n FROM user_entity_scope WHERE user_id = ? GROUP BY entity_type",
      [user.id]
    )
    const roles = roleRows.map((r) => r.role)

    const token = await encode({
      token: { name: user.email, email: user.email, sub: String(user.id), userId: user.id, roles },
      secret: process.env.AUTH_SECRET,
      // The salt IS the cookie name — a token salted with the wrong one decodes
      // to null, i.e. a silent 401. Behind HTTPS that name gains a __Secure-
      // prefix, so a token minted for localhost will not work against
      // https://dev.erp.mcaffeine.com and vice versa.
      salt: cookieName,
    })

    // Scope decides what the token can actually see: no rows for an entity type
    // means UNRESTRICTED (lib/scope.ts), so a developer account proves nothing
    // about the out-of-scope 403 paths.
    const scope = scopeRows.length
      ? scopeRows.map((r) => `${r.entity_type}=${r.n}`).join(" ")
      : "UNRESTRICTED (no user_entity_scope rows — sees everything)"

    return { userId: user.id, email: user.email, roles, scope, token, cookie: `${cookieName}=${token}` }
  } finally {
    await conn.end()
  }
}

// CLI
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  // --secure mints for an HTTPS origin (dev.erp.mcaffeine.com), which needs the
  // __Secure- cookie name as the salt. Only works if that environment shares this
  // .env's AUTH_SECRET and DB.
  const s = await mintSession(
    args.find((a) => !a.startsWith("--")),
    args.includes("--secure") ? SECURE_COOKIE_NAME : COOKIE_NAME
  )
  if (args.includes("--cookie")) {
    console.log(s.cookie)
  } else {
    console.error(`user ${s.userId} <${s.email}>  roles: ${s.roles.join(", ") || "(none)"}  scope: ${s.scope}`)
    console.log(s.token)
  }
}
