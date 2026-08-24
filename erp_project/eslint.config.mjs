import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/**
 * The UI ↔ data boundary.
 *
 * 25 files under app/ (every masters page, all of PO tracking, admin, approvals,
 * even app/layout.tsx) read the database directly from Server Components, and
 * several resolve entity scope inline in the page body. So authorization lives
 * in 74 API routes AND 25 pages — which is how three id-addressed routes ended
 * up reading across scope without anything failing (see the 2026-08-24 audit and
 * docs/module-boundaries-and-tally-plan.md §4).
 *
 * This rule stops the set growing. It does not fix the 25: `npm run lint` will
 * report them, and `npm run lint:changed` — the gate CI actually runs — fails
 * only on files you touched, so they convert as they are edited rather than in
 * one enormous untestable diff. Same ratchet already carrying the ~238
 * pre-existing errors.
 *
 * The intended destination is `lib/services/*` — one function per read owning
 * both the query and its authorization, called by the route AND the page. NOT
 * `fetch()` from a Server Component to our own API: that needs absolute URLs and
 * manual cookie forwarding, adds a network hop, and only pays off in a
 * frontend-only architecture that has not been committed to.
 *
 * Four modules are blocked, and all four are needed — `lib/db` and `lib/db-sku`
 * are the pools, `lib/queries/*` holds the SQL, and `lib/query-timing` wraps the
 * pool with `timedQuery`, which would otherwise let a page run an inline SQL
 * string straight past this rule.
 *
 * `allowTypeImports` is deliberate: `import type { AdminUser } from
 * "@/lib/queries/users"` compiles away entirely and carries no DB dependency, so
 * blocking it would force a pointless type relocation. Two files rely on it.
 *
 * app/api/** is exempt — that IS the data layer's entry point. app/actions/** is
 * deliberately NOT exempt: server actions touch no SQL today, and if that
 * changes they should go through lib/services too.
 */
const uiDataBoundary = {
  name: "erp/ui-data-boundary",
  files: ["app/**/*.{ts,tsx}"],
  ignores: ["app/api/**"],
  rules: {
    "@typescript-eslint/no-restricted-imports": ["error", {
      paths: [
        "@/lib/uniware", "@/lib/uniware/index",
        "@/lib/uniware/auth", "@/lib/uniware/facility", "@/lib/uniware/endpoints",
        "@/lib/uniware/po-builder", "@/lib/uniware/envelope",
        "@/lib/uniware/purchase-order", "@/lib/uniware/export-jobs",
        "@/lib/uniware/vendor-items",
      ].map((name) => ({
        name,
        message:
          "UI must not import the Uniware transport — it reaches @/lib/env, and so " +
          "UNIWARE_PASSWORD. For user-facing failure text use \"@/lib/uniware/errors\", " +
          "which imports nothing. Anything else belongs behind an API route.",
      })),
      patterns: [
        {
          group: ["@/lib/db", "@/lib/db-sku", "@/lib/query-timing", "@/lib/queries/*"],
          allowTypeImports: true,
          message:
            "UI must not read the database directly. Move the query and its scope check into " +
            "lib/services/* and call that from both the page and the API route, so authorization " +
            "has one home. See docs/module-boundaries-and-tally-plan.md §4.",
        },
      ],
    }],
  },
};

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  uiDataBoundary,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Generated Prisma client -- never hand-edited, see AGENTS.md.
    "app/generated/**",
  ]),
]);

export default eslintConfig;
