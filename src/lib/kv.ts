// ── KV wrapper with Sentry observability ─────────────────────────────
// Single chokepoint for every persistent-state operation. Every call
// emits a structured `kv_op` log line with latency + outcome metadata,
// and every error emits `kv_error` + Sentry.captureException with the
// operation tagged, so dashboard filters by `kv.op` / `kv.keyPrefix`
// work naturally.
//
// Why the wrapper:
// 1. Deprecation insulation — the last migration (#117) touched 26
//    call sites across 6 files. Next time, only this file changes.
// 2. Observability — KV failures today bubble up as generic route
//    errors; the wrapper tags them so "Upstash is flaky" shows up as
//    a distinct signal.
// 3. Migration diagnostic — the `kv_possible_double_stringify` canary
//    on `get` flags pre-migration writes that manually JSON.stringify'd
//    objects (the old @vercel/kv pattern). Upstash auto-parses JSON on
//    get, so a mixed-write KB is consistent on read but confusing in
//    logs; the canary surfaces it.
//
// See #117 for the migration context, docs/observability.md for the
// `kv_op` / `kv_error` event schema.

import { Redis } from "@upstash/redis";
import * as Sentry from "@sentry/nextjs";
import { log } from "./logger";

const client = Redis.fromEnv();

// One-shot init log so the deploy can verify the new client is loaded.
log("kv_client_init", { library: "@upstash/redis" });

/**
 * Bucket a full KV key into a prefix suitable for log aggregation.
 * Returns the first colon-separated segment only (e.g.
 * `feedback:context:C01:ts` → `feedback`). Combined with the `op`
 * field (get/set/del/zadd/zrange), this distinguishes different KV
 * access patterns on the same namespace without risking channel-ID
 * or timestamp leakage into logs.
 *
 * Pure function.
 */
export function keyPrefix(key: string): string {
  const idx = key.indexOf(":");
  return idx === -1 ? key : key.slice(0, idx);
}

// ── Core wrap helpers (private) ──────────────────────────────────────

type KVOp = "get" | "set" | "del" | "zadd" | "zrange" | "zrem";

function sentryTags(op: KVOp, prefix: string): Sentry.CaptureContext {
  return { tags: { "kv.op": op, "kv.keyPrefix": prefix } };
}

function logError(op: KVOp, prefix: string, startedAt: number, err: unknown): void {
  const errorMessage = err instanceof Error ? err.message : String(err);
  const errorClass = err instanceof Error ? err.constructor.name : "Unknown";
  log("kv_error", {
    op,
    keyPrefix: prefix,
    durationMs: Date.now() - startedAt,
    errorClass,
    errorMessage: errorMessage.slice(0, 200),
  });
  Sentry.captureException(err, sentryTags(op, prefix));
}

// ── Double-stringify canary ──────────────────────────────────────────
// If a get returns a STRING that happens to parse as valid JSON, the
// value was most likely written by pre-migration code that called
// `kv.set(k, JSON.stringify(obj))`. Upstash's auto-deserialize would
// normally return the parsed object if the library wrote it; a string
// coming back means it was stored as a literal string. Flag it.
function maybeFlagDoubleStringify(key: string, result: unknown): void {
  if (typeof result !== "string") return;
  try {
    const parsed = JSON.parse(result);
    // Only flag if the parse actually produces something structured —
    // `"42"` or `"true"` parse to primitives but aren't double-stringified
    // objects worth flagging.
    if (parsed !== null && typeof parsed === "object") {
      log("kv_possible_double_stringify", { keyPrefix: keyPrefix(key) });
    }
  } catch {
    // Not JSON — nothing to do.
  }
}

// ── Public wrapper ───────────────────────────────────────────────────
// Mirrors @upstash/redis surface for the 5 ops we use. Same signatures
// so callers switching from @vercel/kv need only update the import path.

export const kv = {
  async get<T>(key: string): Promise<T | null> {
    const prefix = keyPrefix(key);
    const startedAt = Date.now();
    try {
      const result = await client.get<T>(key);
      log("kv_op", {
        op: "get",
        keyPrefix: prefix,
        durationMs: Date.now() - startedAt,
        hit: result !== null && result !== undefined,
      });
      maybeFlagDoubleStringify(key, result);
      return result;
    } catch (err) {
      logError("get", prefix, startedAt, err);
      throw err;
    }
  },

  async set(
    key: string,
    value: unknown,
    options?: { ex?: number; nx?: boolean; xx?: boolean },
  ): Promise<unknown> {
    const prefix = keyPrefix(key);
    const startedAt = Date.now();
    // Approximate payload size for observability. For strings it's the
    // length; for objects we measure the JSON-stringified length. Never
    // logs the value itself.
    const valueSize =
      typeof value === "string"
        ? value.length
        : value === null || value === undefined
        ? 0
        : JSON.stringify(value).length;
    try {
      const result = options
        ? await client.set(key, value, options as Parameters<typeof client.set>[2])
        : await client.set(key, value);
      log("kv_op", {
        op: "set",
        keyPrefix: prefix,
        durationMs: Date.now() - startedAt,
        valueSize,
        ttlSec: options?.ex,
      });
      return result;
    } catch (err) {
      logError("set", prefix, startedAt, err);
      throw err;
    }
  },

  async del(key: string): Promise<number> {
    const prefix = keyPrefix(key);
    const startedAt = Date.now();
    try {
      const result = await client.del(key);
      log("kv_op", {
        op: "del",
        keyPrefix: prefix,
        durationMs: Date.now() - startedAt,
        deleted: result,
      });
      return result;
    } catch (err) {
      logError("del", prefix, startedAt, err);
      throw err;
    }
  },

  async zadd(
    key: string,
    entry: { score: number; member: string },
  ): Promise<number | null> {
    const prefix = keyPrefix(key);
    const startedAt = Date.now();
    try {
      const result = await client.zadd(key, entry);
      log("kv_op", {
        op: "zadd",
        keyPrefix: prefix,
        durationMs: Date.now() - startedAt,
      });
      return result;
    } catch (err) {
      logError("zadd", prefix, startedAt, err);
      throw err;
    }
  },

  async zrem(key: string, member: string): Promise<number> {
    const prefix = keyPrefix(key);
    const startedAt = Date.now();
    try {
      const result = await client.zrem(key, member);
      log("kv_op", {
        op: "zrem",
        keyPrefix: prefix,
        durationMs: Date.now() - startedAt,
        removed: result,
      });
      return result;
    } catch (err) {
      logError("zrem", prefix, startedAt, err);
      throw err;
    }
  },

  async zrange(
    key: string,
    start: number,
    stop: number,
    options?: { rev?: boolean; withScores?: boolean },
  ): Promise<unknown[]> {
    const prefix = keyPrefix(key);
    const startedAt = Date.now();
    try {
      const result = options
        ? await client.zrange(
            key,
            start,
            stop,
            options as Parameters<typeof client.zrange>[3],
          )
        : await client.zrange(key, start, stop);
      log("kv_op", {
        op: "zrange",
        keyPrefix: prefix,
        durationMs: Date.now() - startedAt,
        rangeSize: Array.isArray(result) ? result.length : 0,
      });
      return result as unknown[];
    } catch (err) {
      logError("zrange", prefix, startedAt, err);
      throw err;
    }
  },
};
