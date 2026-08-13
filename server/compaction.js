// Rolling campaign compaction.
//
// Once a session's live message array crosses a threshold, the older span (up to the
// last completed chapter-summary boundary) is moved out to an append-only archive file
// and replaced by a single condensed "arc summary" blurb. The trimmed session keeps only
// the recent tail, so the DM can load an entire long campaign cheaply and the on-disk
// session file / auto-save payload stays bounded.
//
// Compaction is invoked at SESSION RESUME — the one moment the client's in-memory history
// is known to equal the file (it just loaded from it), so the server can trim
// authoritatively without racing the client's full-array auto-save. (There are no stable
// per-message IDs to reconcile a mid-turn trim by; resume is the race-free checkpoint.)

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { getSessionFilePath } = require('./player-data');

const DEFAULT_THRESHOLD = 500;        // live messages before a cycle is considered
const HARD_CEILING_MULTIPLIER = 2;    // force a cut even without a boundary past this
const KEEP_TAIL_ON_FORCED_CUT = 100;  // messages kept live when force-cutting
const MIN_KEEP_TAIL = 20;             // a boundary must leave at least this much live
const CHAPTER_SUMMARY_PATTERN = /## 📜 Chapter Summary:/;

// Serialize compaction per session within this process.
const inFlight = new Set();

function archivePathFor(sessionFilePath) {
  return path.join(path.dirname(sessionFilePath), 'archive.jsonl');
}

function isChapterSummary(m) {
  return !!m && m.type === 'dm' && typeof m.text === 'string' && CHAPTER_SUMMARY_PATTERN.test(m.text);
}

/**
 * Decide where to cut. Returns { cutIdx, forced } or null for no compaction.
 * cutIdx is inclusive: messages[0..cutIdx] are archived, messages[cutIdx+1..] stay live.
 */
function decideCut(messages, threshold) {
  if (!Array.isArray(messages) || messages.length < threshold) return null;

  // Prefer the last chapter-summary boundary (a clean arc end), mirroring buildSmartRecap —
  // but only one that still leaves a usable live tail. A summary is typically the newest
  // message right after the DM closes a chapter, and cutting there would archive the whole
  // array and leave the session with an empty transcript. Skip back to an older boundary
  // (or wait) instead; the tail catches up as play continues.
  let lastSummaryIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    if (isChapterSummary(messages[i]) && messages.length - (i + 1) >= MIN_KEEP_TAIL) {
      lastSummaryIdx = i;
    }
  }
  if (lastSummaryIdx >= 0) return { cutIdx: lastSummaryIdx, forced: false };

  // No boundary yet — the DM is already being nudged hard to write one (the summary
  // counter is far past its threshold). Only force a cut once we blow past the ceiling,
  // and then keep a generous recent tail so the live story stays coherent.
  if (messages.length >= threshold * HARD_CEILING_MULTIPLIER) {
    const cutIdx = messages.length - KEEP_TAIL_ON_FORCED_CUT - 1;
    if (cutIdx >= 0) return { cutIdx, forced: true };
  }
  return null;
}

function formatForSummary(m) {
  switch (m.type) {
    case 'player': return `[PLAYER] ${m.text}`;
    case 'dm': return `[DM] ${m.text}`;
    case 'companion': return `[COMPANION ${m.characterName || ''}] ${m.text}`;
    case 'system': return `[SYSTEM] ${m.text}`;
    default: return `[${(m.type || 'MSG').toUpperCase()}] ${m.text || ''}`;
  }
}

/** Build the summarizer input: prefer the chapter summaries in the span (already distilled). */
function buildSummaryInput(span) {
  const summaries = span.filter(isChapterSummary).map(m => m.text);
  if (summaries.length > 0) {
    return `Condense the following ${summaries.length} chapter summaries from a single D&D campaign arc into one flowing recap. Preserve names, locations, decisions, rewards, and unresolved threads.\n\n${summaries.join('\n\n---\n\n')}`;
  }
  // Forced cut with no summaries — fall back to the raw transcript.
  const lines = span
    .filter(m => m.type === 'player' || m.type === 'dm' || m.type === 'companion')
    .map(formatForSummary);
  return `Condense the following D&D session transcript into one flowing arc recap. Preserve names, locations, decisions, rewards, and unresolved threads.\n\n${lines.join('\n\n')}`;
}

function deriveTitle(span, seq) {
  const firstSummary = span.find(isChapterSummary);
  if (firstSummary) {
    const m = firstSummary.text.match(/## 📜 Chapter Summary:\s*(.+)/);
    if (m) return `Arc ${seq} — ${m[1].trim()}`;
  }
  return `Arc ${seq}`;
}

function deriveDaysRange(span) {
  for (const m of span) {
    if (!isChapterSummary(m)) continue;
    const match = m.text.match(/\*\*(Days?[^*]*)\*\*/);
    if (match) return match[1].trim();
  }
  return '';
}

/**
 * Append span to archive.jsonl. If the file already has more lines than the last
 * committed count (a crash between append and session-commit), roll back the
 * uncommitted tail first so the operation is idempotent and line ranges stay accurate.
 */
async function reconcileAndAppend(archiveFp, span, committedCount) {
  let existing = '';
  try { existing = await fsp.readFile(archiveFp, 'utf-8'); } catch { /* new file */ }
  let lines = existing ? existing.split('\n').filter(l => l.length > 0) : [];
  if (lines.length > committedCount) {
    lines = lines.slice(0, committedCount);
    await fsp.writeFile(archiveFp, lines.length ? lines.join('\n') + '\n' : '');
  }
  const append = span.map(m => JSON.stringify(m)).join('\n') + '\n';
  await fsp.appendFile(archiveFp, append);
  // Verify the durable line count before the caller trims the live array.
  const after = (await fsp.readFile(archiveFp, 'utf-8')).split('\n').filter(l => l.length > 0).length;
  if (after !== committedCount + span.length) {
    throw new Error(`archive line count mismatch: expected ${committedCount + span.length}, got ${after}`);
  }
}

/**
 * Archive + condense + trim a session if it has crossed the threshold.
 * @param {string} dataDir
 * @param {string} sessionDbId
 * @param {object} opts
 * @param {(input: string) => Promise<string>} opts.summarize  Produces the arc blurb.
 * @param {number} [opts.thresholdOverride]  Test/override hook.
 * @returns {Promise<{compacted:boolean, liveMessages?:Array, arcSummaries?:Array, archiveSeq?:number, archivedCount?:number}>}
 */
async function maybeCompact(dataDir, sessionDbId, { summarize, thresholdOverride } = {}) {
  if (!sessionDbId || inFlight.has(sessionDbId) || typeof summarize !== 'function') {
    return { compacted: false };
  }
  inFlight.add(sessionDbId);
  try {
    const fp = getSessionFilePath(dataDir, sessionDbId);
    let session;
    try { session = JSON.parse(await fsp.readFile(fp, 'utf-8')); }
    catch { return { compacted: false }; }

    const threshold = Number(
      thresholdOverride ?? session?.dmPersonality?.archiveThreshold ?? DEFAULT_THRESHOLD
    );
    if (!threshold || threshold <= 0) return { compacted: false }; // 0/unset disables

    const messages = Array.isArray(session.messages) ? session.messages : [];
    const cut = decideCut(messages, threshold);
    if (!cut) return { compacted: false };

    const span = messages.slice(0, cut.cutIdx + 1);
    const liveTail = messages.slice(cut.cutIdx + 1);
    if (span.length === 0) return { compacted: false };
    // Backstop: never trim the live window to nothing. Archiving is a display/context
    // optimization, and a session whose transcript renders empty is worse than one that
    // is merely large, so refuse the cut rather than commit it.
    if (liveTail.length === 0) {
      console.warn(`[Compaction] refusing empty-tail cut for ${sessionDbId}; leaving history intact.`);
      return { compacted: false };
    }

    // 1) Generate the blurb FIRST — the only external/fallible step — before any mutation.
    let blurb = '';
    try {
      blurb = await summarize(buildSummaryInput(span));
    } catch (e) {
      console.error(`[Compaction] summarize failed for ${sessionDbId}: ${e.message}`);
      return { compacted: false };
    }
    if (!blurb || !blurb.trim()) {
      console.warn(`[Compaction] empty blurb for ${sessionDbId}; leaving history intact.`);
      return { compacted: false };
    }

    // 2) Durably archive the raw span before trimming anything.
    const archiveFp = archivePathFor(fp);
    const committed = Number(session?.archiveMeta?.totalArchived || 0);
    await reconcileAndAppend(archiveFp, span, committed);

    // 3) Commit: append the arc summary, trim the live array, bump the watermark.
    const seq = Number(session.archiveSeq || 0) + 1;
    const arc = {
      seq,
      title: deriveTitle(span, seq),
      daysRange: deriveDaysRange(span),
      blurb: blurb.trim(),
      archivedMessageCount: span.length,
      archiveLineRange: [committed, committed + span.length - 1],
      forced: !!cut.forced,
      createdAt: new Date().toISOString(),
    };
    session.arcSummaries = Array.isArray(session.arcSummaries) ? session.arcSummaries : [];
    session.arcSummaries.push(arc);
    session.messages = liveTail;
    session.archiveSeq = seq;
    session.archiveMeta = { file: 'archive.jsonl', totalArchived: committed + span.length };
    session.updatedAt = new Date().toISOString();
    await fsp.writeFile(fp, JSON.stringify(session, null, 2));

    console.log(`[Compaction] session=${sessionDbId} seq=${seq} archived=${span.length} live=${liveTail.length} forced=${!!cut.forced}`);
    return {
      compacted: true,
      liveMessages: liveTail,
      arcSummaries: session.arcSummaries,
      archiveSeq: seq,
      archivedCount: span.length,
    };
  } finally {
    inFlight.delete(sessionDbId);
  }
}

module.exports = {
  maybeCompact,
  DEFAULT_THRESHOLD,
  // exported for unit tests
  _internal: { decideCut, buildSummaryInput, reconcileAndAppend, archivePathFor, deriveTitle, deriveDaysRange },
};
