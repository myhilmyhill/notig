import { getFilteredNotes, updateTagFilterOptions } from './tags.js';
import {
  listEl,
  renderNotes,
  renderTagFilterOptions,
} from './ui.js';

let visibleNotesCount = 0;
let hasPendingNotesScroll = false;
const NOTES_PAGE_SIZE = 50;
const NOTES_SCROLL_THRESHOLD_PX = 120;

/**
 * @param {number} total
 */
function clampVisibleNotesCount(total) {
  if (!visibleNotesCount) {
    visibleNotesCount = Math.min(total, NOTES_PAGE_SIZE);
    return;
  }
  visibleNotesCount = Math.min(visibleNotesCount, total);
}

export function getNotesScrollContainer() {
  return listEl.closest('#sidebar') ?? listEl;
}

/**
 * @param {import("./app").Note[]} notes
 * @param {import("./app").Note | null} currentNote
 * @param {(note: import('./app').Note, options?: { source?: "user" | "history" | "system"; }) => Promise<void>} openNote
 */
function maybeLoadMoreNotes(notes, currentNote, openNote) {
  const filteredNotes = getFilteredNotes(notes);
  if (visibleNotesCount >= filteredNotes.length) return;
  const scrollContainer = getNotesScrollContainer();
  const remaining =
    scrollContainer.scrollHeight -
    scrollContainer.scrollTop -
    scrollContainer.clientHeight;
  if (remaining > NOTES_SCROLL_THRESHOLD_PX) return;
  visibleNotesCount = Math.min(filteredNotes.length, visibleNotesCount + NOTES_PAGE_SIZE);
  renderNotesList(filteredNotes, currentNote, openNote, { preserveScroll: true, skipAutoLoad: true });
}

/**
 * @param {import("./app").Note[]} notes
 * @param {import("./app").Note | null} currentNote
 * @param {(note: import('./app').Note, options?: { source?: "user" | "history" | "system"; }) => Promise<void>} openNote
 */
export function handleNotesScroll(notes, currentNote, openNote) {
  if (hasPendingNotesScroll) return;
  hasPendingNotesScroll = true;
  requestAnimationFrame(() => {
    hasPendingNotesScroll = false;
    maybeLoadMoreNotes(notes, currentNote, openNote);
  });
}

/**
 * @param {import("./app").Note[]} notes
 * @param {{preserveScroll?: boolean;resetVisibleCount?: boolean;scrollToTop?: boolean;skipAutoLoad?: boolean;}} options
 * @param {import("./app").Note | null} currentNote
 * @param {(note: import('./app').Note, options?: { source?: "user" | "history" | "system"; }) => Promise<void>} openNote
 */
export function renderNotesList(notes, currentNote, openNote, options = {}) {
  const {
    preserveScroll = false,
    resetVisibleCount = false,
    scrollToTop = false,
    skipAutoLoad = false,
  } = options;
  updateTagFilterOptions(notes, renderTagFilterOptions);
  const filteredNotes = getFilteredNotes(notes);
  if (resetVisibleCount) {
    visibleNotesCount = Math.min(filteredNotes.length, NOTES_PAGE_SIZE);
  } else {
    clampVisibleNotesCount(filteredNotes.length);
  }
  const scrollContainer = getNotesScrollContainer();
  const prevScrollTop = preserveScroll ? scrollContainer.scrollTop : 0;
  renderNotes(
    filteredNotes.slice(0, visibleNotesCount),
    currentNote,
    (note) => openNote(note, { source: 'user' })
  );
  if (preserveScroll) {
    scrollContainer.scrollTop = prevScrollTop;
  } else if (scrollToTop) {
    scrollContainer.scrollTop = 0;
  }
  if (!skipAutoLoad) {
    maybeLoadMoreNotes(notes, currentNote, openNote);
  }
}
