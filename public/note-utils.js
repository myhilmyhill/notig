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
      data[key] = value;
    }
    listKey = null;
  });

  return data;
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
 * @param {string} filepath
 * @returns {Promise<number | undefined>}
 */
export async function getLatestCommitTimestamp(filepath) {
  try {
    const commits = await logFileChanges(filepath);
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
  return [];
}
