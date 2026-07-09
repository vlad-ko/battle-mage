import { describe, it, expect, vi, beforeEach } from "vitest";

const { searchCodeSpy, vectorQuerySpy, getDocsVectorNamespaceSpy } = vi.hoisted(
  () => ({
    searchCodeSpy: vi.fn(),
    vectorQuerySpy: vi.fn(),
    getDocsVectorNamespaceSpy: vi.fn(),
  }),
);

vi.mock("@/lib/github", () => ({
  searchCode: (...a: unknown[]) => searchCodeSpy(...a),
}));
vi.mock("@/lib/vector", () => ({
  vectorQuery: (...a: unknown[]) => vectorQuerySpy(...a),
  srcNamespace: () => "acme_backend:src",
}));
vi.mock("@/lib/repo-index", () => ({
  getDocsVectorNamespace: (...a: unknown[]) => getDocsVectorNamespaceSpy(...a),
}));

import { searchRepoTool, executeSearchRepo } from "./search-repo";
import { MAX_ARM_RESULTS } from "@/lib/retrieval";

function codeResult(path: string, score = 1) {
  return { path, url: `https://github.com/acme/backend/blob/main/${path}`, score };
}

function docMatch(chunkId: string, score: number, heading: string, excerpt: string) {
  const path = chunkId.split("#")[0];
  return { id: chunkId, score, metadata: { path, heading, excerpt } };
}

interface FakeMatch {
  id: string;
  score: number;
  metadata: Record<string, unknown>;
}

function srcMatch(
  chunkId: string,
  score: number,
  startLine: number,
  endLine: number,
  excerpt: string,
): FakeMatch {
  const path = chunkId.split("#")[0];
  return { id: chunkId, score, metadata: { path, startLine, endLine, excerpt } };
}

/** vectorQuerySpy dispatches on its namespace arg: the stable src
 * namespace serves src chunks, anything else serves the docs arm. */
function mockVectorArms(arms: {
  docs?: FakeMatch[] | null;
  src?: FakeMatch[] | null;
}): void {
  vectorQuerySpy.mockImplementation(async (namespace: string) =>
    namespace === "acme_backend:src" ? arms.src ?? null : arms.docs ?? null,
  );
}

beforeEach(() => {
  searchCodeSpy.mockReset().mockResolvedValue([]);
  vectorQuerySpy.mockReset().mockResolvedValue(null);
  getDocsVectorNamespaceSpy.mockReset().mockResolvedValue(null);
});

describe("searchRepoTool definition", () => {
  it("is named search_repo and requires a query", () => {
    expect(searchRepoTool.name).toBe("search_repo");
    expect(searchRepoTool.input_schema.required).toEqual(["query"]);
  });
});

describe("executeSearchRepo — hybrid fusion", () => {
  it("fuses both arms with RRF: results interleave code rank 1, doc rank 1, code rank 2, doc rank 2", async () => {
    // Typed ids (code:/doc:) never collide across arms, so fusion here is
    // a pure rank interleave: equal ranks tie and the lexical (code) arm
    // wins ties by enumeration order — hand-computed:
    //   code:a 1/61, doc:x 1/61, code:b 1/62, doc:y 1/62.
    searchCodeSpy.mockResolvedValue([codeResult("src/a.ts"), codeResult("src/b.ts")]);
    getDocsVectorNamespaceSpy.mockResolvedValue("acme_backend:docs:sha1");
    mockVectorArms({
      docs: [
        docMatch("docs/x.md#0", 0.9, "X Heading", "x excerpt"),
        docMatch("docs/y.md#2", 0.8, "Y Heading", "y excerpt"),
      ],
    });

    const result = await executeSearchRepo({ query: "auth flow" });
    const lines = result.text.split("\n");
    expect(lines[0]).toContain("src/a.ts");
    expect(lines[0]).toContain("[code]");
    expect(lines[1]).toContain("docs/x.md");
    expect(lines[1]).toContain("[doc]");
    expect(lines[2]).toContain("src/b.ts");
    expect(lines[3]).toContain("docs/y.md");
  });

  it("queries the docs namespace from the pointer with MAX_ARM_RESULTS", async () => {
    getDocsVectorNamespaceSpy.mockResolvedValue("acme_backend:docs:sha1");
    vectorQuerySpy.mockResolvedValue([]);
    await executeSearchRepo({ query: "deployment" });
    expect(vectorQuerySpy).toHaveBeenCalledWith(
      "acme_backend:docs:sha1",
      "deployment",
      MAX_ARM_RESULTS,
    );
  });

  it("queries the src namespace with MAX_ARM_RESULTS alongside the docs arm", async () => {
    getDocsVectorNamespaceSpy.mockResolvedValue("acme_backend:docs:sha1");
    vectorQuerySpy.mockResolvedValue([]);
    await executeSearchRepo({ query: "auth flow" });
    expect(vectorQuerySpy).toHaveBeenCalledWith(
      "acme_backend:src",
      "auth flow",
      MAX_ARM_RESULTS,
    );
  });

  it("renders embedded code chunks as [src] lines with path:Lstart-end and excerpt", async () => {
    mockVectorArms({
      src: [srcMatch("src/lib/auth.ts#2", 0.9, 40, 71, "verifies the session token")],
    });
    const result = await executeSearchRepo({ query: "session verification" });
    const srcLine = result.text.split("\n").find((l) => l.includes("[src]"));
    expect(srcLine).toBeDefined();
    expect(srcLine).toContain("`src/lib/auth.ts:L40-71`");
    expect(srcLine).toContain("verifies the session token");
  });

  it("src ids never collide with the lexical arm's code: ids — the same path appears as two typed lines", async () => {
    searchCodeSpy.mockResolvedValue([codeResult("src/lib/auth.ts")]);
    mockVectorArms({
      src: [srcMatch("src/lib/auth.ts#0", 0.9, 1, 20, "auth entry point")],
    });
    const result = await executeSearchRepo({ query: "auth" });
    const lines = result.text.split("\n");
    expect(lines.some((l) => l.includes("[code]") && l.includes("src/lib/auth.ts"))).toBe(true);
    expect(lines.some((l) => l.includes("[src]") && l.includes("src/lib/auth.ts"))).toBe(true);
  });

  it("semantic arm merges docs and src by score before fusion", async () => {
    getDocsVectorNamespaceSpy.mockResolvedValue("acme_backend:docs:sha1");
    mockVectorArms({
      docs: [
        docMatch("docs/x.md#0", 0.9, "X Heading", "x excerpt"),
        docMatch("docs/y.md#1", 0.85, "Y Heading", "y excerpt"),
      ],
      src: [srcMatch("src/lib/auth.ts#0", 0.95, 1, 30, "auth core")],
    });
    const result = await executeSearchRepo({ query: "auth" });
    const lines = result.text.split("\n");
    const srcAt = lines.findIndex((l) => l.includes("[src]"));
    const docAt = lines.findIndex((l) => l.includes("docs/x.md"));
    expect(srcAt).toBeGreaterThanOrEqual(0);
    expect(docAt).toBeGreaterThanOrEqual(0);
    expect(srcAt).toBeLessThan(docAt); // 0.95 src outranks the 0.9 doc
  });

  it("src-arm degradation collapses to docs-only; both semantic arms degraded collapses to lexical-only (never throws)", async () => {
    // src arm degraded (null), docs arm healthy → doc lines still present.
    getDocsVectorNamespaceSpy.mockResolvedValue("acme_backend:docs:sha1");
    mockVectorArms({
      docs: [docMatch("docs/x.md#0", 0.9, "X Heading", "x excerpt")],
      src: null,
    });
    const withDocs = await executeSearchRepo({ query: "auth" });
    expect(withDocs.text).toContain("[doc]");
    expect(withDocs.text).not.toContain("[src]");

    // Both semantic arms degraded + lexical results → only [code] lines.
    searchCodeSpy.mockResolvedValue([codeResult("src/a.ts")]);
    mockVectorArms({ docs: null, src: null });
    const lexicalOnly = await executeSearchRepo({ query: "auth" });
    expect(lexicalOnly.text).toContain("[code]");
    expect(lexicalOnly.text).not.toContain("[doc]");
    expect(lexicalOnly.text).not.toContain("[src]");

    // Null everywhere + no lexical → the no-results message.
    searchCodeSpy.mockResolvedValue([]);
    const empty = await executeSearchRepo({ query: "q" });
    expect(empty.text).toBe('No results found for "q".');
  });

  it("doc lines carry heading and excerpt from chunk metadata", async () => {
    getDocsVectorNamespaceSpy.mockResolvedValue("ns");
    mockVectorArms({
      docs: [docMatch("docs/setup.md#3", 0.9, "Vercel Setup", "Deploys go through Vercel.")],
    });
    const result = await executeSearchRepo({ query: "how do we deploy" });
    expect(result.text).toContain("[doc]");
    expect(result.text).toContain("docs/setup.md");
    expect(result.text).toContain("Vercel Setup");
    expect(result.text).toContain("Deploys go through Vercel.");
  });

  it("code lines carry path, score and url", async () => {
    searchCodeSpy.mockResolvedValue([codeResult("src/lib/slack.ts", 7)]);
    const result = await executeSearchRepo({ query: "postReply" });
    expect(result.text).toContain("[code]");
    expect(result.text).toContain("`src/lib/slack.ts`");
    expect(result.text).toContain("score: 7");
    expect(result.text).toContain("https://github.com/acme/backend/blob/main/src/lib/slack.ts");
  });
});

describe("executeSearchRepo — degradation", () => {
  it("vectorQuery null (vector degraded) → lexical-only output, no throw", async () => {
    searchCodeSpy.mockResolvedValue([codeResult("src/a.ts")]);
    getDocsVectorNamespaceSpy.mockResolvedValue("ns");
    vectorQuerySpy.mockResolvedValue(null);
    const result = await executeSearchRepo({ query: "auth" });
    expect(result.text).toContain("src/a.ts");
    expect(result.text).not.toContain("[doc]");
  });

  it("missing namespace pointer → docs arm skipped (docs namespace never queried); src arm still runs", async () => {
    searchCodeSpy.mockResolvedValue([codeResult("src/a.ts")]);
    getDocsVectorNamespaceSpy.mockResolvedValue(null);
    const result = await executeSearchRepo({ query: "auth" });
    expect(result.text).toContain("src/a.ts");
    // The src arm queries its STABLE namespace regardless of the docs
    // pointer — only the docs namespace must stay untouched (#135).
    for (const call of vectorQuerySpy.mock.calls) {
      expect(call[0]).toBe("acme_backend:src");
    }
  });

  it("both arms empty → No results found message", async () => {
    const result = await executeSearchRepo({ query: "nonexistent thing" });
    expect(result.text).toBe('No results found for "nonexistent thing".');
  });

  it("returns no references — search results are discovery aids", async () => {
    searchCodeSpy.mockResolvedValue([codeResult("src/a.ts")]);
    const result = await executeSearchRepo({ query: "auth" });
    expect(result.references).toEqual([]);
  });

  it("guards a missing query without calling any arm (#127 review)", async () => {
    const result = await executeSearchRepo({});
    expect(result.text).toBe("No search query provided.");
    expect(result.references).toEqual([]);
    expect(searchCodeSpy).not.toHaveBeenCalled();
    expect(getDocsVectorNamespaceSpy).not.toHaveBeenCalled();
  });

  it("guards a blank query without calling any arm (#127 review)", async () => {
    const result = await executeSearchRepo({ query: "   " });
    expect(result.text).toBe("No search query provided.");
    expect(searchCodeSpy).not.toHaveBeenCalled();
  });

  it("guards a non-string query", async () => {
    const result = await executeSearchRepo({ query: 42 });
    expect(result.text).toBe("No search query provided.");
    expect(searchCodeSpy).not.toHaveBeenCalled();
  });

  it("filters tooling paths from the lexical arm", async () => {
    searchCodeSpy.mockResolvedValue([
      codeResult(".claude/skills/wizard/SKILL.md"),
      codeResult("src/a.ts"),
    ]);
    const result = await executeSearchRepo({ query: "wizard" });
    expect(result.text).not.toContain(".claude/");
    expect(result.text).toContain("src/a.ts");
  });
});
