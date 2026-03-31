import { Octokit } from "@octokit/rest";

// ── GitHub client ─────────────────────────────────────────────────────
const octokit = new Octokit({ auth: process.env.GITHUB_PAT_BM });

const owner = () => process.env.GITHUB_OWNER!;
const repo = () => process.env.GITHUB_REPO!;

// ── Code search ───────────────────────────────────────────────────────
export async function searchCode(query: string) {
  const q = `${query} repo:${owner()}/${repo()}`;
  const { data } = await octokit.rest.search.code({ q, per_page: 10 });
  return data.items.map((item) => ({
    path: item.path,
    url: item.html_url,
    score: item.score,
  }));
}

// ── Read file contents ────────────────────────────────────────────────
export async function readFile(path: string, ref?: string) {
  const params: { owner: string; repo: string; path: string; ref?: string } = {
    owner: owner(),
    repo: repo(),
    path,
  };
  if (ref) params.ref = ref;

  const { data } = await octokit.rest.repos.getContent(params);

  if ("content" in data && data.type === "file") {
    const content = Buffer.from(data.content, "base64").toString("utf-8");
    return { path: data.path, content, size: data.size, url: data.html_url };
  }

  // Directory listing
  if (Array.isArray(data)) {
    return {
      path,
      entries: data.map((e) => ({ name: e.name, type: e.type, path: e.path })),
    };
  }

  throw new Error(`Unexpected content type at ${path}`);
}

// ── List issues ───────────────────────────────────────────────────────
export async function listIssues(
  state: "open" | "closed" | "all" = "open",
  labels?: string,
) {
  const params: {
    owner: string;
    repo: string;
    state: "open" | "closed" | "all";
    sort: "updated";
    direction: "desc";
    per_page: number;
    labels?: string;
  } = {
    owner: owner(),
    repo: repo(),
    state,
    sort: "updated",
    direction: "desc",
    per_page: 20,
  };
  if (labels) params.labels = labels;

  const { data } = await octokit.rest.issues.listForRepo(params);
  return data.map((issue) => ({
    number: issue.number,
    title: issue.title,
    state: issue.state,
    labels: issue.labels.map((l) => (typeof l === "string" ? l : l.name)),
    url: issue.html_url,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
  }));
}

// ── Get single issue ──────────────────────────────────────────────────
export async function getIssue(issueNumber: number) {
  const { data } = await octokit.rest.issues.get({
    owner: owner(),
    repo: repo(),
    issue_number: issueNumber,
  });
  return {
    number: data.number,
    title: data.title,
    body: data.body,
    state: data.state,
    labels: data.labels.map((l) => (typeof l === "string" ? l : l.name)),
    url: data.html_url,
  };
}

// ── Create issue (requires confirmation flow) ─────────────────────────
export async function createIssue(
  title: string,
  body: string,
  labels?: string[],
) {
  const { data } = await octokit.rest.issues.create({
    owner: owner(),
    repo: repo(),
    title,
    body,
    labels,
  });
  return {
    number: data.number,
    title: data.title,
    url: data.html_url,
  };
}

// Knowledge base moved to Vercel KV — see src/lib/knowledge.ts
// GitHub PAT no longer needs Contents: Write permission

// ── Read PR details ───────────────────────────────────────────────────
export async function getPullRequest(prNumber: number) {
  const { data } = await octokit.rest.pulls.get({
    owner: owner(),
    repo: repo(),
    pull_number: prNumber,
  });
  return {
    number: data.number,
    title: data.title,
    body: data.body,
    state: data.state,
    merged: data.merged,
    head: data.head.ref,
    base: data.base.ref,
    url: data.html_url,
    changed_files: data.changed_files,
    additions: data.additions,
    deletions: data.deletions,
  };
}

// ── Repo tree (for index building) ───────────────────────────────────
export async function getRepoTree(): Promise<{ path: string; type: string }[]> {
  const sha = await getHeadSha();
  const { data } = await octokit.rest.git.getTree({
    owner: owner(),
    repo: repo(),
    tree_sha: sha,
    recursive: "true",
  });
  return data.tree
    .filter((e) => e.path && e.type)
    .map((e) => ({ path: e.path!, type: e.type! }));
}

export async function getHeadSha(): Promise<string> {
  const { data } = await octokit.rest.repos.getBranch({
    owner: owner(),
    repo: repo(),
    branch: "main",
  });
  return data.commit.sha;
}
