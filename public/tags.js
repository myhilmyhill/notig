import { parseNoteBody, getNoteTags } from './note-utils.js';

/** @typedef {{id: Readonly<string>; body: string; updatedAt?: number; edited?: boolean}} Note */

let currentTagFilter = '';

/**
 * @param {Note} note
 * @returns {string[]}
 */
export function getTagsForNote(note) {
  const parsed = parseNoteBody(note.body);
  return getNoteTags(parsed);
}

/**
 * @param {Note[]} sourceNotes
 * @returns {string[]}
 */
export function collectTagsFromNotes(sourceNotes) {
  const tags = new Set();
  sourceNotes.forEach((note) => {
    getTagsForNote(note).forEach((tag) => {
      tags.add(tag);
    });
  });
  return Array.from(tags).sort((a, b) => a.localeCompare(b));
}

/**
 * @param {Note[]} sourceNotes
 * @param {(tags: string[], current: string) => void} renderTagFilterOptions
 */
export function updateTagFilterOptions(sourceNotes, renderTagFilterOptions) {
  const tags = collectTagsFromNotes(sourceNotes);
  if (currentTagFilter && !tags.includes(currentTagFilter)) {
    currentTagFilter = '';
  }
  renderTagFilterOptions(tags, currentTagFilter);
}

/**
 * @param {Note[]} sourceNotes
 * @returns {Note[]}
 */
export function getFilteredNotes(sourceNotes) {
  if (!currentTagFilter) return sourceNotes;
  return sourceNotes.filter((note) => getTagsForNote(note).includes(currentTagFilter));
}

/**
 * @param {string} value
 */
export function setCurrentTagFilter(value) {
  currentTagFilter = value;
}
