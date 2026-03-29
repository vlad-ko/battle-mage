import { NextRequest, NextResponse } from "next/server";

/**
 * Slack Events API webhook handler.
 *
 * Handles:
 * - URL verification challenge (Slack app setup)
 * - app_mention events (@bm invocation)
 *
 * Slack requires a 200 OK within 3 seconds. We ack immediately
 * and process the AI + GitHub calls asynchronously.
 */
export async function POST(request: NextRequest) {
  const body = await request.json();

  // Slack URL verification challenge (one-time during app setup)
  if (body.type === "url_verification") {
    return NextResponse.json({ challenge: body.challenge });
  }

  // TODO Phase 2: Verify Slack signature (HMAC-SHA256)
  // TODO Phase 2: Handle app_mention events
  // TODO Phase 3: Async Claude AI processing
  // TODO Phase 4: GitHub tool calls

  return NextResponse.json({ ok: true });
}
