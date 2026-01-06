'use strict';
import { logFileChanges } from './git-api.js';

const DATE_FORMATTER = new Intl.DateTimeFormat('ja-JP', {
  dateStyle: 'medium',
  timeStyle: 'medium',
});

/**
 * @param {string[]} lines
 * @returns {Record<string, string | string[]>}
 */
export function parseFrontMatter(lines) {
  /** @type {Record<string, string | string[]>} */
  const data = {};
  /** @type {string | null} */
  let listKey = null;

  lines.forEach((line) => {
    if (!line.trim()) return;

    const listMatch = line.match(/^\s*-\s+(.*)$/);
    if (listMatch && listKey) {
      const entry = listMatch[1].trim();
      if (entry) {
        /** @type {string[]} */ (data[listKey]).push(entry);
      }
      return;
    }

    const kvMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kvMatch) {
      listKey = null;
      return;
    }

    const key = kvMatch[1];
    const value = kvMatch[2].trim();
    if (!value) {
      data[key] = [];
      listKey = key;
      return;
    }

    if (value.startsWith('[') && value.endsWith(']')) {
      data[key] = value
        .slice(1, -1)
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
    } else {
      let normalizedValue = value;
      if (key === 'title' || key === 'Title') {
        normalizedValue = stripYamlDoubleQuotes(value);
      }
      data[key] = normalizedValue;
    }
    listKey = null;
  });

  return data;
}

/**
 * @param {string} value
 * @returns {string}
 */
function stripYamlDoubleQuotes(value) {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"');
  }
  return value;
}

/**
 * @param {string} value
 * @returns {number | undefined}
 */
function parseFrontMatterTimestamp(value) {
  const trimmed = stripYamlDoubleQuotes(value.trim());
  if (!trimmed) return undefined;
  if (/^\d+$/.test(trimmed)) {
    const num = Number(trimmed);
    if (!Number.isFinite(num)) return undefined;
    return num < 1e12 ? num * 1000 : num;
  }
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return undefined;
  return parsed;
}

/**
 * @param {number | undefined} timestamp
 * @returns {string}
 */
export function formatUpdatedAt(timestamp) {
  if (!timestamp) return 'unknown';
  return DATE_FORMATTER.format(new Date(timestamp));
}

/**
 * @param {number | undefined} timestamp
 * @param {number} [now]
 * @returns {string}
 */
export function getUpdatedAtGroupLabel(timestamp, now = Date.now()) {
  if (!timestamp) return 'Unknown';
  const startOfDay = (value) => {
    const date = new Date(value);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  };
  const dayMs = 24 * 60 * 60 * 1000;
  const diffDays = Math.max(
    0,
    Math.floor((startOfDay(now) - startOfDay(timestamp)) / dayMs)
  );
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return '1 day ago';
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffDays < 30) {
    const weeks = Math.floor(diffDays / 7);
    return weeks === 1 ? '1 week ago' : `${weeks} weeks ago`;
  }
  if (diffDays < 365) {
    const months = Math.floor(diffDays / 30);
    return months === 1 ? '1 month ago' : `${months} months ago`;
  }
  const years = Math.floor(diffDays / 365);
  return years === 1 ? '1 year ago' : `${years} years ago`;
}

/**
 * @param {{frontMatter: Record<string, string | string[]>}} parsed
 * @returns {number | undefined}
 */
export function getNoteUpdatedAt(parsed) {
  const modified = parsed.frontMatter.modified;
  if (typeof modified === 'string') {
    const ts = parseFrontMatterTimestamp(modified);
    if (typeof ts === 'number') return ts;
  }
  const Modified = parsed.frontMatter.Modified;
  if (typeof Modified === 'string') {
    const ts = parseFrontMatterTimestamp(Modified);
    if (typeof ts === 'number') return ts;
  }
  return undefined;
}

/**
 * @param {string} filepath
 * @param {number} [depth]
 * @returns {Promise<number | undefined>}
 */
export async function getLatestCommitTimestamp(filepath, depth) {
  try {
    const commits = await logFileChanges(filepath, depth);
    const ts = commits[0]?.commit?.author?.timestamp;
    if (typeof ts !== 'number') return undefined;
    return ts * 1000;
  } catch (err) {
    return undefined;
  }
}

/**
 * @param {string | null | undefined} body
 * @returns {{frontMatter: Record<string, string | string[]>; frontMatterRaw: string | null; content: string}}
 */
export function parseNoteBody(body) {
  const safeBody = typeof body === 'string' ? body : '';
  const lines = safeBody.split(/\r?\n/);
  if (lines[0] !== '---') {
    return { frontMatter: {}, frontMatterRaw: null, content: safeBody };
  }

  let endIndex = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === '---') {
      endIndex = i;
      break;
    }
  }

  if (endIndex === -1) {
    return { frontMatter: {}, frontMatterRaw: null, content: safeBody };
  }

  const frontMatterLines = lines.slice(1, endIndex);
  const content = lines.slice(endIndex + 1).join('\n');
  return {
    frontMatter: parseFrontMatter(frontMatterLines),
    frontMatterRaw: lines.slice(0, endIndex + 1).join('\n'),
    content,
  };
}

/**
 * @param {{frontMatter: Record<string, string | string[]>; content: string}} parsed
 * @returns {string}
 */
export function getNoteTitle(parsed) {
  if (typeof parsed.frontMatter.title === 'string') {
    const title = parsed.frontMatter.title.trim();
    if (title) return title;
  }
  if (typeof parsed.frontMatter.Title === 'string') {
    const title = parsed.frontMatter.Title.trim();
    if (title) return title;
  }
  const fallback = parsed.content
    .split(/\r?\n/)
    .find((line) => line.trim());
  return fallback ? fallback.trim() : 'Untitled';
}

/**
 * @param {{frontMatter: Record<string, string | string[]>}} parsed
 * @returns {string[]}
 */
export function getNoteTags(parsed) {
  const tags = parsed.frontMatter.tags;
  if (Array.isArray(tags)) {
    return tags.filter((tag) => typeof tag === 'string' && tag.trim());
  }
  if (typeof tags === 'string' && tags.trim()) {
    return [tags.trim()];
  }
  const Tags = parsed.frontMatter.Tags;
  if (Array.isArray(Tags)) {
    return Tags.filter((tag) => typeof tag === 'string' && tag.trim());
  }
  if (typeof Tags === 'string' && Tags.trim()) {
    return [Tags.trim()];
  }
  return [];
}
