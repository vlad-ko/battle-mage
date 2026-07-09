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
    getDocsVectorNamespaceSpy.mockResolvedValue("acme/backend:docs:sha1");
    vectorQuerySpy.mockResolvedValue([
      docMatch("docs/x.md#0", 0.9, "X Heading", "x excerpt"),
      docMatch("docs/y.md#2", 0.8, "Y Heading", "y excerpt"),
    ]);

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
    getDocsVectorNamespaceSpy.mockResolvedValue("acme/backend:docs:sha1");
    vectorQuerySpy.mockResolvedValue([]);
    await executeSearchRepo({ query: "deployment" });
    expect(vectorQuerySpy).toHaveBeenCalledWith(
      "acme/backend:docs:sha1",
      "deployment",
      MAX_ARM_RESULTS,
    );
  });

  it("doc lines carry heading and excerpt from chunk metadata", async () => {
    getDocsVectorNamespaceSpy.mockResolvedValue("ns");
    vectorQuerySpy.mockResolvedValue([
      docMatch("docs/setup.md#3", 0.9, "Vercel Setup", "Deploys go through Vercel."),
    ]);
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

  it("missing namespace pointer → lexical-only, vector store never queried", async () => {
    searchCodeSpy.mockResolvedValue([codeResult("src/a.ts")]);
    getDocsVectorNamespaceSpy.mockResolvedValue(null);
    const result = await executeSearchRepo({ query: "auth" });
    expect(result.text).toContain("src/a.ts");
    expect(vectorQuerySpy).not.toHaveBeenCalled();
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
