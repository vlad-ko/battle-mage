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
    per_page: number;
    labels?: string;
  } = {
    owner: owner(),
    repo: repo(),
    state,
    per_page: 20,
  };
  if (labels) params.labels = labels;

  const { data } = await octokit.rest.issues.list(params);
  return data.map((issue) => ({
    number: issue.number,
    title: issue.title,
    state: issue.state,
    labels: issue.labels.map((l) => (typeof l === "string" ? l : l.name)),
    url: issue.html_url,
    created_at: issue.created_at,
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

// ── Append to knowledge base ──────────────────────────────────────────
const KNOWLEDGE_PATH = ".battle-mage/knowledge.md";

export async function appendKnowledge(entry: string): Promise<string> {
  let existingContent = "";
  let sha: string | undefined;

  // Try to read existing file
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner: owner(),
      repo: repo(),
      path: KNOWLEDGE_PATH,
    });
    if ("content" in data && data.type === "file") {
      existingContent = Buffer.from(data.content, "base64").toString("utf-8");
      sha = data.sha;
    }
  } catch {
    // File doesn't exist yet — will be created
  }

  const timestamp = new Date().toISOString().split("T")[0];
  const newEntry = `\n- [${timestamp}] ${entry}\n`;
  const updatedContent = existingContent
    ? existingContent.trimEnd() + "\n" + newEntry
    : `# Battle Mage Knowledge Base\n\nCorrections and learnings from Slack conversations.\n${newEntry}`;

  const params: {
    owner: string;
    repo: string;
    path: string;
    message: string;
    content: string;
    sha?: string;
  } = {
    owner: owner(),
    repo: repo(),
    path: KNOWLEDGE_PATH,
    message: `knowledge: ${entry.slice(0, 60)}`,
    content: Buffer.from(updatedContent).toString("base64"),
  };
  if (sha) params.sha = sha;

  await octokit.rest.repos.createOrUpdateFileContents(params);
  return KNOWLEDGE_PATH;
}

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
