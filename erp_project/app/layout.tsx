import type { Metadata } from "next";
import { Geist, Geist_Mono, Outfit, Merriweather } from "next/font/google";
import "./globals.css";
import { cn } from "@/lib/utils";
import { auth } from "@/lib/auth";
import { resolveAccess, type AccessLevel } from "@/lib/permissions";
import { NAV_SLUGS } from "@/lib/pages";
import { getUserScope, scopeParams, UNRESTRICTED } from "@/lib/scope";
import ClientLayout from "@/components/ClientLayout";
import { ThemeProvider } from "@/components/ThemeProvider";
import { timedQuery } from "@/lib/query-timing";
import { manufacturingSql } from "@/lib/queries/manufacturing";

// Every sidebar destination that should be individually lockable. Masters
// pages and manufacturers each get their own slug (see lib/permissions.ts'
// parent-slug fallback) so access can be granted per-page/per-manufacturer,
// not just for the section as a whole.
// Keyed by the EXACT href each sidebar item/child links to (not just the
// page_permissions slug the destination page itself checks) — resolveAccess's
// parent-slug fallback means e.g. "/po-tracking/po-procurement" naturally
// inherits whatever's granted at "/po-tracking" if it has no override of its
// own, so listing the real hrefs here doesn't require separate seeding.
//
// Comes from lib/pages.ts, which is also what the /admin permissions grid
// renders — one list, so a new page can't be lockable in one place and
// invisible in the other.
const SIDEBAR_SLUGS = NAV_SLUGS;

const merriweatherHeading = Merriweather({ subsets: ["latin"], variable: "--font-heading" });
const outfit = Outfit({ subsets: ["latin"], variable: "--font-sans" });
const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "ERP System",
  description: "Enterprise Resource Planning System",
  icons: {
    icon: [
      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
  manifest: "/site.webmanifest",
};

const themeScript = `(function(){try{var t=localStorage.getItem('theme');if(t==='dark'||(!t&&window.matchMedia('(prefers-color-scheme: dark)').matches)){document.documentElement.classList.add('dark')}}catch(e){}})();`

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  const user = session?.user
    ? { name: session.user.name, email: session.user.email }
    : undefined;
  // Entity-scoped: out-of-scope manufacturers are absent from the sidebar
  // entirely, not locked — the lock icon would still disclose the name.
  const scope = session ? await getUserScope(Number(session.user.id)) : UNRESTRICTED;
  const mfgs = session
    ? await timedQuery<{ id: number; name: string }>(manufacturingSql.selectActiveForNav, scopeParams(scope.mfgIds), { label: "manufacturing.selectActiveForNav" })
    : [];

  // Resolve access for every sidebar destination up front (server-side, one
  // pass) so the sidebar can lock items the user can't reach instead of
  // showing a dead link that bounces to /auth/unauthorized after a click.
  let access: Record<string, AccessLevel> = {};
  if (session?.user) {
    const userId = Number(session.user.id);
    const roles = session.user.roles ?? [];
    const staticSlugs = [...SIDEBAR_SLUGS, ...mfgs.map((m) => `/manufacturing/${m.id}`)];
    const levels = await Promise.all(staticSlugs.map((slug) => resolveAccess(userId, roles, slug)));
    access = Object.fromEntries(staticSlugs.map((slug, i) => [slug, levels[i]]));
  }

  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={cn(
        "h-full antialiased",
        geistSans.variable,
        geistMono.variable,
        outfit.variable,
        merriweatherHeading.variable,
        "font-sans"
      )}
    >
      <head>
        {/* <script dangerouslySetInnerHTML={{ __html: themeScript }} /> */}
      </head>
      <body className="h-full">
        <ThemeProvider>
          <ClientLayout user={user} mfgs={mfgs} access={access}>{children}</ClientLayout>
        </ThemeProvider>
      </body>
    </html>
  );
}
