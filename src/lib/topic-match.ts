import type { TopicMap } from "./repo-index";

/**
 * Topic Pre-Matching — match questions to the repo index before calling the agent.
 *
 * Instead of relying on Claude to check the repo map (which it often ignores),
 * we match the question against topics at the code level and inject file paths
 * directly into the user message. This gives Claude concrete starting points.
 */

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "can", "shall", "to", "of", "in", "for",
  "on", "with", "at", "by", "from", "as", "into", "about", "between",
  "through", "after", "before", "above", "below", "up", "down", "out",
  "off", "over", "under", "again", "further", "then", "once", "here",
  "there", "when", "where", "why", "how", "all", "each", "every",
  "both", "few", "more", "most", "other", "some", "such", "no", "not",
  "only", "own", "same", "so", "than", "too", "very", "just", "because",
  "but", "and", "or", "if", "while", "that", "this", "what", "which",
  "who", "whom", "me", "my", "our", "your", "its", "we", "you", "they",
  "us", "it", "i", "he", "she", "tell", "give", "show", "explain",
]);

const MAX_PATHS_PER_TOPIC = 3;

function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

export interface TopicMatch {
  topic: string;
  paths: string[];
}

export function matchTopicsToQuestion(
  question: string,
  topics: TopicMap,
): TopicMatch[] {
  if (!question || Object.keys(topics).length === 0) return [];

  const questionKeywords = extractKeywords(question);
  if (questionKeywords.length === 0) return [];

  const matches: TopicMatch[] = [];

  for (const [topic, paths] of Object.entries(topics)) {
    // Skip pseudo-topics (_historic, _vendor)
    if (topic.startsWith("_")) continue;

    // Build keyword set from topic name + file paths
    const topicKeywords = new Set<string>();
    for (const keyword of extractKeywords(topic)) {
      topicKeywords.add(keyword);
    }
    for (const path of paths) {
      for (const keyword of extractKeywords(path)) {
        topicKeywords.add(keyword);
      }
    }

    // Count keyword overlap
    const overlap = questionKeywords.filter((k) => topicKeywords.has(k));
    if (overlap.length >= 1) {
      matches.push({
        topic,
        paths: paths.slice(0, MAX_PATHS_PER_TOPIC),
      });
    }
  }

  // Sort by relevance — more keyword overlap first
  matches.sort((a, b) => {
    const aOverlap = questionKeywords.filter((k) =>
      extractKeywords(a.topic).includes(k) ||
      a.paths.some((p) => extractKeywords(p).includes(k)),
    ).length;
    const bOverlap = questionKeywords.filter((k) =>
      extractKeywords(b.topic).includes(k) ||
      b.paths.some((p) => extractKeywords(p).includes(k)),
    ).length;
    return bOverlap - aOverlap;
  });

  return matches.slice(0, 3); // Max 3 topics
}

export function buildQuestionHints(
  question: string,
  matches: TopicMatch[],
): string {
  if (matches.length === 0) return question;

  const hints = matches
    .map((m) => m.paths.map((p) => `- ${p} (${m.topic})`).join("\n"))
    .join("\n");

  return `${question}\n\n[CONTEXT] The repo index suggests these files are relevant:\n${hints}\nStart with read_file on these. Only use search_code if these don't answer the question.`;
}
