// GET /api/health — liveness plus build provenance. Stays unversioned: this is
// the path the ALB target group and the deploy scripts address by URL.
//
// The build fields answer "what is actually running right now", which previously
// took an ECR digest comparison — during an incident, which is exactly when nobody
// wants to be doing that. The values are baked into the image by the Dockerfile,
// so they describe the image itself and cannot disagree with it.

import { NextResponse } from "next/server"

// Defensive on Next 16, where GET route handlers are already dynamic by default.
// Kept because the failure it guards against is silent: APP_VERSION is set by an
// ENV in the runner stage, so anything evaluated during `next build` (the builder
// stage) would see nothing and freeze "dev" in place for the life of the image.
export const dynamic = "force-dynamic"

export async function GET() {
  return NextResponse.json({
    status: "ok",
    // A release tag on prod ("v1.2.0"); the raw SHA on test, which correctly
    // signals "this is not a release".
    version: process.env.APP_VERSION ?? "dev",
    // Short SHA, not the full 40 — enough to identify a build. This route is
    // public: nginx proxies / to the app and there is no withGateway here.
    commit: (process.env.GIT_SHA ?? "dev").slice(0, 7),
    builtAt: process.env.BUILD_TIME ?? null,
  })
}
