// ── Incremental code-index tick (#135) ───────────────────────────────
// Vercel Cron entry point (see vercel.json — every 5 minutes). Each
// invocation runs ONE bounded runCodeIndexTick: diff the repo tree
// against the srcindex:manifest cursor, embed/delete the difference,
// persist progress. All indexing invariants (single writer, budgets,
// truncated-tree guard, degradation) live in src/lib/code-index.ts —
// this route only does auth, dispatch, and observability.
//
// Auth: Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. Exact
// match via isAuthorizedCronRequest — fail closed (unset secret denies
// everything), same contract as the recovery sweep.

import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createRequestLogger, flushLogs } from "@/lib/logger";
import { isAuthorizedCronRequest } from "@/lib/recovery";
import { runCodeIndexTick } from "@/lib/code-index";

// Literal (Next.js segment config must be statically analyzable);
// pinned equal to CODE_INDEX_ROUTE_MAX_DURATION_SEC by the route test.
// SRC_INDEX_CLAIM_TTL_SEC (270) strictly exceeds this, so a live tick
// can never lose its claim mid-run.
export const maxDuration = 240;

export async function GET(request: NextRequest) {
  const rlog = createRequestLogger();

  if (
    !isAuthorizedCronRequest(
      request.headers.get("authorization"),
      process.env.CRON_SECRET,
    )
  ) {
    rlog("src_index_unauthorized");
    return new NextResponse("Unauthorized", { status: 401 });
  }

  try {
    const result = await runCodeIndexTick();
    rlog("src_index_tick_end", { ...result });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    // runCodeIndexTick is non-throwing for expected failures — reaching
    // here means infrastructure (KV) or a contract violation.
    rlog("src_index_tick_failed", {
      errorMessage: err instanceof Error ? err.message.slice(0, 200) : String(err),
    });
    Sentry.captureException(err, { tags: { flow: "cron_code_index" } });
    return NextResponse.json({ ok: false }, { status: 500 });
  } finally {
    // Same tail-drop rule as every after() body (#98): explicitly drain
    // the Sentry buffer before the container freezes.
    await flushLogs(rlog, "cron_code_index");
  }
}
