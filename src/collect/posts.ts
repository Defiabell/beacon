import type { Platform, PostMetrics } from "../types";
import type { FetchFn } from "./github";

const USER_AGENT = "beacon (+https://github.com/Defiabell/beacon)";

function hostMatches(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

export function detectPlatform(url: string): Platform | null {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return null;
  }
  if (hostMatches(hostname, "v2ex.com")) return "v2ex";
  if (hostMatches(hostname, "linux.do")) return "linuxdo";
  if (hostMatches(hostname, "news.ycombinator.com")) return "hn";
  if (hostMatches(hostname, "reddit.com")) return "reddit";
  return null;
}

async function fetchJson<T>(url: string, fetchFn: FetchFn): Promise<T> {
  const res = await fetchFn(url, { headers: { "User-Agent": USER_AGENT } });
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

export async function fetchPostMetrics(
  url: string,
  platform: Platform,
  fetchFn: FetchFn = fetch
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
  }
}
