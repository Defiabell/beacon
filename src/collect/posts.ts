import type { Platform, PostMetrics } from "../types";
import type { FetchFn } from "./github";

const USER_AGENT = "beacon (+https://github.com/Defiabell/beacon)";

function hostMatches(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

export function detectPlatform(url: string): Platform | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const hostname = parsed.hostname;
  if (hostMatches(hostname, "v2ex.com")) return "v2ex";
  if (hostMatches(hostname, "linux.do")) return "linuxdo";
  if (hostMatches(hostname, "news.ycombinator.com")) return "hn";
  if (hostMatches(hostname, "reddit.com")) return "reddit";
  // Exact host (not hostMatches): github.com subdomains are distinct products
  // (gist/api/raw), unlike reddit's www./old. mirrors. Only issue/PR pages —
  // repo/profile URLs have no comment metrics, so they stay unregistrable.
  if ((hostname === "github.com" || hostname === "www.github.com") && GITHUB_ISSUE_PATH.test(parsed.pathname)) return "github";
  return null;
}

async function fetchJson<T>(url: string, fetchFn: FetchFn, extraHeaders?: Record<string, string>): Promise<T> {
  const res = await fetchFn(url, { headers: { "User-Agent": USER_AGENT, ...extraHeaders } });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

// Numeric id trailing the pathname, e.g. "/t/1229945" -> "1229945" or
// "/t/example-topic/12345" -> "12345". Throws when no trailing digits are found.
function trailingNumericId(pathname: string): string {
  const match = pathname.match(/(\d+)\/?$/);
  if (!match) throw new Error(`could not extract numeric id from pathname: ${pathname}`);
  return match[1];
}

interface V2exTopic {
  replies: number;
}

async function fetchV2exMetrics(url: string, fetchFn: FetchFn): Promise<PostMetrics> {
  const id = trailingNumericId(new URL(url).pathname);
  const [topic] = await fetchJson<V2exTopic[]>(
    `https://www.v2ex.com/api/topics/show.json?id=${id}`,
    fetchFn
  );
  return { views: null, replies: topic.replies, likes: null, score: null };
}

interface LinuxDoTopic {
  views: number;
  like_count: number;
  posts_count: number;
}

async function fetchLinuxDoMetrics(url: string, fetchFn: FetchFn): Promise<PostMetrics> {
  const id = trailingNumericId(new URL(url).pathname);
  const topic = await fetchJson<LinuxDoTopic>(`https://linux.do/t/${id}.json`, fetchFn);
  return { views: topic.views, replies: topic.posts_count - 1, likes: topic.like_count, score: null };
}

interface HnItem {
  score: number;
  descendants: number;
}

async function fetchHnMetrics(url: string, fetchFn: FetchFn): Promise<PostMetrics> {
  const id = new URL(url).searchParams.get("id");
  if (!id) throw new Error(`could not extract id from url: ${url}`);
  const item = await fetchJson<HnItem>(
    `https://hacker-news.firebaseio.com/v0/item/${id}.json`,
    fetchFn
  );
  return { views: null, replies: item.descendants, likes: null, score: item.score };
}

interface RedditListing {
  data: { children: { data: { score: number; num_comments: number } }[] };
}

// Reddit's own permalink + ".json" returns [postListing, commentsListing].
function redditJsonUrl(url: string): string {
  const u = new URL(url);
  const path = u.pathname.endsWith("/") ? u.pathname.slice(0, -1) : u.pathname;
  return `${u.origin}${path}.json`;
}

async function fetchRedditMetrics(url: string, fetchFn: FetchFn): Promise<PostMetrics> {
  const [listing] = await fetchJson<RedditListing[]>(redditJsonUrl(url), fetchFn);
  const post = listing.data.children[0].data;
  return { views: null, replies: post.num_comments, likes: null, score: post.score };
}

// Matches /{owner}/{repo}/issues/{n} and /{owner}/{repo}/pull/{n} — the
// /repos/{owner}/{repo}/issues/{n} REST endpoint serves both kinds.
const GITHUB_ISSUE_PATH = /^\/([^/]+)\/([^/]+)\/(?:issues|pull)\/(\d+)/;

interface GithubIssue {
  comments: number;
  reactions?: { total_count: number };
}

// Unauthenticated api.github.com allows only 60 req/h per IP — Workers share
// egress IPs, so that quota is effectively always exhausted. Send the token.
async function fetchGithubMetrics(url: string, fetchFn: FetchFn, token?: string): Promise<PostMetrics> {
  const m = new URL(url).pathname.match(GITHUB_ISSUE_PATH);
  if (!m) throw new Error(`not a github issue/pull url: ${url}`);
  const issue = await fetchJson<GithubIssue>(
    `https://api.github.com/repos/${m[1]}/${m[2]}/issues/${m[3]}`,
    fetchFn,
    token ? { Authorization: `Bearer ${token}` } : undefined
  );
  return { views: null, replies: issue.comments, likes: issue.reactions?.total_count ?? null, score: null };
}

export async function fetchPostMetrics(
  url: string,
  platform: Platform,
  fetchFn: FetchFn = fetch,
  githubToken?: string
): Promise<PostMetrics> {
  switch (platform) {
    case "v2ex":
      return fetchV2exMetrics(url, fetchFn);
    case "linuxdo":
      return fetchLinuxDoMetrics(url, fetchFn);
    case "hn":
      return fetchHnMetrics(url, fetchFn);
    case "reddit":
      return fetchRedditMetrics(url, fetchFn);
    case "github":
      return fetchGithubMetrics(url, fetchFn, githubToken);
    default:
      throw new Error(`unknown platform: ${platform}`);
  }
}
