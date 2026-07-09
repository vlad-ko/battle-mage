// ── Behavioral contract assertions (#137) ────────────────────────────
// Pure helpers over the world state a scenario run produces. Same
// {pass, detail} shape as src/evals/rubric.ts so failures read uniformly.

export interface ContractResult {
  pass: boolean;
  detail?: string;
}

/** One recorded fake-Slack API call. */
export interface SlackCallLike {
  method: string;
  args: Record<string, unknown>;
}

/** One recorded semantic GitHub-boundary call. */
export interface GithubCallLike {
  fn: string;
  args: unknown[];
}

/** One captured structured-log event. */
export interface LogEventLike {
  event: string;
  data?: Record<string, unknown>;
}

/** Slack methods that mutate channel state. Everything else is a read. */
export const SLACK_WRITE_METHODS: ReadonlySet<string> = new Set([
  "chat.postMessage",
  "chat.update",
  "chat.delete",
  "chat.postEphemeral",
  "reactions.add",
  "reactions.remove",
]);

export function isSlackWrite(call: SlackCallLike): boolean {
  return SLACK_WRITE_METHODS.has(call.method);
}

/**
 * Key design decision #3: the bot NEVER posts at channel root. Every
 * chat.postMessage must carry a non-empty thread_ts. Vacuously true on
 * zero calls (silent declines post nothing).
 */
export function assertThreadOnly(calls: SlackCallLike[]): ContractResult {
  for (const call of calls) {
    if (call.method !== "chat.postMessage") continue;
    const threadTs = call.args.thread_ts;
    if (typeof threadTs !== "string" || threadTs.length === 0) {
      const text = String(call.args.text ?? "").slice(0, 80);
      return {
        pass: false,
        detail: `chat.postMessage without thread_ts (channel-root post): "${text}"`,
      };
    }
  }
  return { pass: true };
}

const REFERENCES_FOOTER_MARKER = "*References:*";
const REFERENCE_BULLET = /^\s*•\s/;

/**
 * Count bullet lines in the references footer of one Slack message.
 * Mirrors formatReferences (src/lib/references.ts): a `*References:*`
 * line followed by `  • <emoji> <url|label>` bullets. Bullets before the
 * footer are ignored; counting stops at the first non-bullet line.
 */
export function countReferenceLines(text: string): number {
  const markerAt = text.lastIndexOf(REFERENCES_FOOTER_MARKER);
  if (markerAt === -1) return 0;
  const afterMarker = text.slice(markerAt + REFERENCES_FOOTER_MARKER.length);
  const lines = afterMarker.split("\n").slice(1); // drop remainder of marker line
  let count = 0;
  for (const line of lines) {
    if (REFERENCE_BULLET.test(line)) count++;
    else break;
  }
  return count;
}

/** Reference cap contract (MAX_REFERENCES in src/lib/references.ts). */
export function assertMaxReferences(
  messageTexts: string[],
  max: number,
): ContractResult {
  for (const text of messageTexts) {
    const count = countReferenceLines(text);
    if (count > max) {
      return {
        pass: false,
        detail: `message carries ${count} references, cap is ${max}`,
      };
    }
  }
  return { pass: true };
}

/** Key design decision #5: no GitHub issue creation without approval. */
export function assertNoIssueCreated(calls: GithubCallLike[]): ContractResult {
  const create = calls.find((c) => c.fn === "createIssue");
  if (create) {
    return {
      pass: false,
      detail: `createIssue was called without approval: "${String(create.args[0])}"`,
    };
  }
  return { pass: true };
}

/**
 * Follow-up decline contract (#126): a decline means BOTH zero Slack
 * writes (reads like conversations.replies are fine) AND an explicit
 * `followup_reply_declined` log event — silence caused by a crash is a
 * failure, not a decline.
 */
export function assertSilentDecline(
  slackCalls: SlackCallLike[],
  logEvents: LogEventLike[],
): ContractResult {
  const write = slackCalls.find(isSlackWrite);
  if (write) {
    return {
      pass: false,
      detail: `expected zero Slack writes but saw ${write.method}: "${String(write.args.text ?? "").slice(0, 80)}"`,
    };
  }
  const declined = logEvents.some((e) => e.event === "followup_reply_declined");
  if (!declined) {
    return {
      pass: false,
      detail:
        "zero Slack writes but no followup_reply_declined event was logged — a crash is not a decline",
    };
  }
  return { pass: true };
}
