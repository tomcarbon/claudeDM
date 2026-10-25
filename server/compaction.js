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
const { getSessionFilePath, updateSessionFile } = require('./player-data');

const DEFAULT_THRESHOLD = 500;        // live messages before a cycle is considered
const HARD_CEILING_MULTIPLIER = 2;    // force a cut even without a boundary past this
const KEEP_TAIL_ON_FORCED_CUT = 100;  // messages kept live when force-cutting
const MIN_KEEP_TAIL = 20;             // a boundary must leave at least this much live
const CHAPTER_SUMMARY_PATTERN = /## 📜 Chapter Summary:/;

// Serialize compaction per session within this process.
//
// ── What this set means now, which is less than it used to look like (WO-0017) ────────────────
// It has never excluded anything except a second compaction, and it never excluded the writers
// that share session.json — the DM turn's persistence, the world-state tool, a companion claim,
// an override audit record. Sitting at the top of the file next to the word "serialize", it read
// as though it did. It did not, and that was the bug.
//
// Since the commit moved inside updateSessionFile it is no longer what makes compaction safe. Two
// concurrent compactions are now safe without it: each takes the session queue in turn, and the
// second finds the archived span is no longer a prefix of the live array and aborts before it
// appends anything. What the set still buys is that the second one never pays for an LLM summary
// it was always going to throw away. It is an optimisation now, not a guarantee.
//
// It is per-process, as it always was. Nothing here — including updateSessionFile — is safe
// against a second Node process writing the same session directory.
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
    return `Condense the following ${summaries.length} chapter summaries from a single tabletop RPG campaign arc into one flowing recap. Preserve names, locations, decisions, rewards, and unresolved threads.\n\n${summaries.join('\n\n---\n\n')}`;
  }
  // Forced cut with no summaries — fall back to the raw transcript.
  const lines = span
    .filter(m => m.type === 'player' || m.type === 'dm' || m.type === 'companion')
    .map(formatForSummary);
  return `Condense the following tabletop RPG session transcript into one flowing arc recap. Preserve names, locations, decisions, rewards, and unresolved threads.\n\n${lines.join('\n\n')}`;
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
 * Is `fresh` still the array whose prefix we archived?
 *
 * True only when the first `span.length` entries of `fresh` are identical to `span`. Messages are
 * appended during play, so the expected shape after an LLM call has run is "the same span, plus
 * whatever arrived since" — and the tail is then everything after the prefix, taken from `fresh`.
 *
 * ── Why this is compared rather than assumed (WO-0017) ────────────────────────────────────────
 * The live array is not append-only. `persistCanonicalTurn` truncates it back to the current
 * turn's player message and rewrites the tail when it reconciles a partial client save, and
 * `PUT /sessions/:id` replaces `messages` wholesale from the client's in-memory copy. Either can
 * land during the summarize window. If one has, the prefix will not match, and the only safe
 * answer is to abort: a compaction committed against an array it does not recognise trims
 * messages it never archived. `CHANGELOG.md` records this subsystem blanking a 554-message
 * session once already, which is the entire reason this function refuses rather than guesses.
 *
 * Compared by serialisation, not by identity or by length: these are plain JSON records read from
 * two different reads of the same file, so there is no object identity to use, and a length check
 * alone would accept a rewritten prefix of the same size.
 */
function prefixMatches(fresh, span) {
  if (!Array.isArray(fresh) || !Array.isArray(span)) return false;
  if (fresh.length < span.length) return false;
  for (let i = 0; i < span.length; i++) {
    if (JSON.stringify(fresh[i]) !== JSON.stringify(span[i])) return false;
  }
  return true;
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
    if (span.length === 0) return { compacted: false };
    // Backstop: never trim the live window to nothing. Archiving is a display/context
    // optimization, and a session whose transcript renders empty is worse than one that
    // is merely large, so refuse the cut rather than commit it. Re-checked against the fresh
    // array inside the lock below, because this read is about to become stale.
    if (messages.length - span.length === 0) {
      console.warn(`[Compaction] refusing empty-tail cut for ${sessionDbId}; leaving history intact.`);
      return { compacted: false };
    }

    // 1) Generate the blurb FIRST — the only external/fallible step — before any mutation, and
    //    deliberately OUTSIDE the session lock. It is an LLM call: seconds, not milliseconds, and
    //    holding the per-session queue across it would stall every turn the player takes.
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

    // ── 2) Commit, inside the session queue, against a FRESH read (WO-0017) ────────────────────
    //
    // Everything above ran against `session`, read before an LLM call that takes seconds. That
    // object is now stale, and the previous version of this function wrote it back whole:
    // `session.messages = liveTail; await fsp.writeFile(fp, ...)`. Every server-side write that
    // landed during the window went with it — the DM turn's messages and world state, a companion
    // claim, and `mechanicalOverrides`, which is the only durable record that a player was asked
    // to approve a change to their own hit points and said yes. Compaction runs periodically
    // through long sessions, which is exactly when there is most to lose.
    //
    // **The obvious fix is worse than the bug.** Wrapping this write in updateSessionFile and
    // applying the same mutations to the fresh object does not fix it, it moves it: `liveTail` was
    // computed from the pre-call array, so assigning it discards any message appended since. That
    // trades losing hit points for losing the transcript.
    //
    // So the tail is recomputed here by dropping the archived prefix from the FRESH array, and the
    // assumption that makes that valid — that the fresh array still begins with the span we
    // archived — is checked rather than trusted. If it does not hold, nothing is written and
    // nothing is appended. A skipped compaction costs a slightly longer context on the next turn.
    // A wrong one blanks the adventure, which CHANGELOG.md records this subsystem having done.
    const archiveFp = archivePathFor(fp);
    let abort = null;
    let outcome = null;

    try {
      await updateSessionFile(dataDir, sessionDbId, async (live) => {
        const fresh = Array.isArray(live.messages) ? live.messages : [];
        if (!prefixMatches(fresh, span)) {
          abort = `the live transcript changed under the summary (expected it to still start with the ${span.length} archived messages, found ${fresh.length} messages that do not match)`;
          return false;
        }
        const liveTail = fresh.slice(span.length);
        if (liveTail.length === 0) {
          abort = 'the cut would leave the session with an empty transcript';
          return false;
        }

        // The archive append is inside the lock, and after the check. Outside it, an abort would
        // leave archive.jsonl holding messages the session never committed — and GET /:id/archive
        // reads that file directly, so an export would show them twice, archived and still live,
        // until the next compaction reconciled it away. `committed` is read from the fresh object
        // for the same reason everything else here is: it is the watermark this write is about to
        // move, so it must be the one on disk now, not the one from before the LLM call.
        const committed = Number(live?.archiveMeta?.totalArchived || 0);
        await reconcileAndAppend(archiveFp, span, committed);

        const seq = Number(live.archiveSeq || 0) + 1;
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
        live.arcSummaries = Array.isArray(live.arcSummaries) ? live.arcSummaries : [];
        live.arcSummaries.push(arc);
        live.messages = liveTail;
        live.archiveSeq = seq;
        live.archiveMeta = { file: 'archive.jsonl', totalArchived: committed + span.length };
        // `updatedAt` is stamped by updateSessionFile itself; setting it here as well would be
        // two writers owning one field.

        outcome = {
          compacted: true,
          liveMessages: liveTail,
          arcSummaries: live.arcSummaries,
          archiveSeq: seq,
          archivedCount: span.length,
        };
      });
    } catch (e) {
      // reconcileAndAppend throws on an archive line-count mismatch, and the queue rejects if the
      // session file has gone. Either way nothing was written to session.json: updateSessionFile
      // writes only after the mutator resolves. This runs on the resume path, so it must not
      // become the reason a player cannot get back into their game.
      console.error(`[Compaction] commit failed for ${sessionDbId}, session left untouched: ${e.message}`);
      return { compacted: false };
    }

    if (abort || !outcome) {
      console.warn(`[Compaction] aborted for ${sessionDbId}: ${abort || 'no outcome recorded'}. Nothing archived, nothing trimmed.`);
      return { compacted: false };
    }

    console.log(`[Compaction] session=${sessionDbId} seq=${outcome.archiveSeq} archived=${span.length} live=${outcome.liveMessages.length} forced=${!!cut.forced}`);
    return outcome;
  } finally {
    inFlight.delete(sessionDbId);
  }
}

module.exports = {
  maybeCompact,
  DEFAULT_THRESHOLD,
  // exported for unit tests
  // Exported for unit tests. `inFlight` is here so a test can force the two-compactions-at-once
  // interleaving the set normally short-circuits — without it the claim that the set is now only
  // an optimisation would be an assertion in a comment rather than something a test demonstrates.
  _internal: { decideCut, buildSummaryInput, reconcileAndAppend, archivePathFor, deriveTitle, deriveDaysRange, prefixMatches, inFlight },
};
