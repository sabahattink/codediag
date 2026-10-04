import { readFileSync } from "node:fs";
import { PR_COMMENT_MARKER } from "../reporters/pr-comment.js";

export interface PullRequestContext {
  apiUrl: string;
  repository: string;
  number: number;
  token: string;
}

type Fetch = typeof fetch;

const PULL_REQUEST_EVENTS = new Set(["pull_request", "pull_request_target"]);
const PER_PAGE = 100;
/** GitHub lists at most 3,000 files for a pull request. */
const MAX_PAGES = 30;

/** The pull request a workflow run belongs to, or null outside one. */
export function pullRequestContext(
  env: NodeJS.ProcessEnv,
  token: string,
): PullRequestContext | null {
  if (!PULL_REQUEST_EVENTS.has(env.GITHUB_EVENT_NAME ?? "")) return null;
  if (!env.GITHUB_EVENT_PATH || !env.GITHUB_REPOSITORY) return null;
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")) as {
    pull_request?: { number?: unknown };
  };
  const number = event.pull_request?.number;
  if (typeof number !== "number") return null;
  return {
    apiUrl: (env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, ""),
    repository: env.GITHUB_REPOSITORY,
    number,
    token,
  };
}

export class GitHubRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(
  context: PullRequestContext,
  fetchImpl: Fetch,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetchImpl(`${context.apiUrl}${path}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${context.token}`,
      "x-github-api-version": "2022-11-28",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    throw new GitHubRequestError(
      response.status,
      `GitHub API ${method} ${path} returned ${response.status}`,
    );
  }
  return (await response.json()) as T;
}

async function paginate<T>(
  context: PullRequestContext,
  fetchImpl: Fetch,
  path: string,
): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const batch = await request<T[]>(
      context,
      fetchImpl,
      "GET",
      `${path}?per_page=${PER_PAGE}&page=${page}`,
    );
    items.push(...batch);
    if (batch.length < PER_PAGE) break;
  }
  return items;
}

/** Repository-relative paths the pull request adds, modifies, or renames. */
export async function changedFiles(
  context: PullRequestContext,
  fetchImpl: Fetch = fetch,
): Promise<Set<string>> {
  const files = await paginate<{ filename: string; status: string }>(
    context,
    fetchImpl,
    `/repos/${context.repository}/pulls/${context.number}/files`,
  );
  return new Set(
    files
      .filter((file) => file.status !== "removed")
      .map((file) => file.filename),
  );
}

/**
 * Creates CodeDiag's comment on the pull request, or updates the one an
 * earlier run created. `render` receives that earlier comment's body.
 */
export async function upsertComment(
  context: PullRequestContext,
  render: (previousBody: string | undefined) => string,
  fetchImpl: Fetch = fetch,
): Promise<"created" | "updated"> {
  const commentsPath = `/repos/${context.repository}/issues/${context.number}/comments`;
  const comments = await paginate<{ id: number; body?: string }>(
    context,
    fetchImpl,
    commentsPath,
  );
  const existing = [...comments]
    .reverse()
    .find((comment) => comment.body?.includes(PR_COMMENT_MARKER));
  const body = render(existing?.body);

  if (existing) {
    await request(
      context,
      fetchImpl,
      "PATCH",
      `/repos/${context.repository}/issues/comments/${existing.id}`,
      { body },
    );
    return "updated";
  }
  await request(context, fetchImpl, "POST", commentsPath, { body });
  return "created";
}
