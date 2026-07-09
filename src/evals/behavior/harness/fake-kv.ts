// ── In-memory KV fake for behavior evals (#137) ──────────────────────
// Lifts the in-memory idiom from knowledge.test.ts / recovery.test.ts
// into a reusable factory covering the full src/lib/kv.ts surface.
//
// Semantics mirror @upstash/redis where behavior is observable:
// - values JSON-round-trip (auto-stringify on set, auto-parse on get)
// - SET NX returns null when the key exists (recovery.test.ts idiom)
// - DEL returns 0 on a missing key — the double-approve boundary in the
//   issue-approval scenario depends on this exact Redis semantic (the
//   del-claim race in executeBatchCreation).

export interface FakeKV {
  kv: {
    get<T>(key: string): Promise<T | null>;
    set(
      key: string,
      value: unknown,
      options?: { ex?: number; nx?: boolean; xx?: boolean },
    ): Promise<unknown>;
    del(key: string): Promise<number>;
    zadd(key: string, entry: { score: number; member: string }): Promise<number | null>;
    zrem(key: string, member: string): Promise<number>;
    zscore(key: string, member: string): Promise<number | null>;
    zrange(
      key: string,
      start: number,
      stop: number,
      options?: { rev?: boolean; withScores?: boolean },
    ): Promise<unknown[]>;
  };
  /** All plain keys currently set that start with `prefix`. */
  keysWithPrefix(prefix: string): string[];
}

function parseMember(member: string): unknown {
  try {
    return JSON.parse(member);
  } catch {
    return member;
  }
}

export function createFakeKV(): FakeKV {
  const store = new Map<string, string>(); // key → JSON payload
  const zsets = new Map<string, Map<string, number>>(); // key → member → score

  const zsetFor = (key: string): Map<string, number> => {
    let z = zsets.get(key);
    if (!z) {
      z = new Map();
      zsets.set(key, z);
    }
    return z;
  };

  return {
    kv: {
      async get<T>(key: string): Promise<T | null> {
        const raw = store.get(key);
        if (raw === undefined) return null;
        return parseMember(raw) as T;
      },

      async set(
        key: string,
        value: unknown,
        options?: { ex?: number; nx?: boolean; xx?: boolean },
      ): Promise<unknown> {
        if (options?.nx && store.has(key)) return null;
        if (options?.xx && !store.has(key)) return null;
        store.set(key, JSON.stringify(value));
        return "OK";
      },

      async del(key: string): Promise<number> {
        return store.delete(key) ? 1 : 0;
      },

      async zadd(
        key: string,
        entry: { score: number; member: string },
      ): Promise<number | null> {
        const z = zsetFor(key);
        const isNew = !z.has(entry.member);
        z.set(entry.member, entry.score);
        return isNew ? 1 : 0;
      },

      async zrem(key: string, member: string): Promise<number> {
        return zsetFor(key).delete(member) ? 1 : 0;
      },

      async zscore(key: string, member: string): Promise<number | null> {
        const z = zsetFor(key);
        return z.has(member) ? z.get(member)! : null;
      },

      async zrange(
        key: string,
        start: number,
        stop: number,
        options?: { rev?: boolean; withScores?: boolean },
      ): Promise<unknown[]> {
        const sorted = [...zsetFor(key).entries()].sort((a, b) => a[1] - b[1]);
        if (options?.rev) sorted.reverse();
        const end = stop === -1 ? sorted.length : stop + 1;
        const slice = sorted.slice(start, end);
        if (options?.withScores) {
          return slice.flatMap(([member, score]) => [parseMember(member), score]);
        }
        // Mimic @upstash/redis auto-deserialization: JSON members come
        // back as objects, non-JSON members as raw strings (see #124).
        return slice.map(([member]) => parseMember(member));
      },
    },

    keysWithPrefix(prefix: string): string[] {
      return [...store.keys()].filter((k) => k.startsWith(prefix));
    },
  };
}
