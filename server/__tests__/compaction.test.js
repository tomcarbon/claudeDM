import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

const { maybeCompact, _internal } = require('../compaction');

let dataDir;

function writeSession(id, session) {
  const dir = path.join(dataDir, 'sessions', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify(session, null, 2));
}

function readSession(id) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, 'sessions', id, 'session.json'), 'utf-8'));
}

function archiveLines(id) {
  const p = path.join(dataDir, 'sessions', id, 'archive.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf-8').split('\n').filter(l => l.length > 0);
}

function makeMessages(total, summaryAt = []) {
  const msgs = [];
  for (let i = 0; i < total; i++) {
    if (summaryAt.includes(i)) {
      msgs.push({ type: 'dm', text: `## 📜 Chapter Summary: Arc at ${i}\n**Days 1-3** | stuff`, sessionId: 's' });
    } else if (i % 2 === 0) {
      msgs.push({ type: 'player', text: `player action ${i}`, sessionId: 's' });
    } else {
      msgs.push({ type: 'dm', text: `dm narration ${i}`, sessionId: 's' });
    }
  }
  return msgs;
}

const fakeSummarize = async (input) => `ARC BLURB :: ${input.slice(0, 30)}`;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-test-'));
});

afterEach(() => {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('maybeCompact', () => {
  it('cuts at the last chapter-summary boundary and archives the span without loss', async () => {
    const id = 'sess1';
    const messages = makeMessages(520, [100, 300]);
    writeSession(id, { id, dmPersonality: { archiveThreshold: 500 }, messages });

    const res = await maybeCompact(dataDir, id, { summarize: fakeSummarize });
    expect(res.compacted).toBe(true);
    expect(res.archiveSeq).toBe(1);
    expect(res.archivedCount).toBe(301); // 0..300 inclusive
    expect(res.liveMessages.length).toBe(219);

    const sess = readSession(id);
    expect(sess.messages.length).toBe(219);
    expect(sess.archiveSeq).toBe(1);
    expect(sess.archiveMeta.totalArchived).toBe(301);
    expect(sess.arcSummaries.length).toBe(1);
    expect(sess.arcSummaries[0].archiveLineRange).toEqual([0, 300]);
    expect(sess.arcSummaries[0].blurb.startsWith('ARC BLURB')).toBe(true);
    expect(sess.arcSummaries[0].forced).toBe(false);

    const lines = archiveLines(id);
    expect(lines.length).toBe(301);
    expect(lines.length + sess.messages.length).toBe(520); // no message loss
    expect(JSON.parse(lines[0]).text).toBe(messages[0].text);
    expect(sess.messages[sess.messages.length - 1].text).toBe(messages[519].text);
  });

  it('never empties the live window when the newest message is a chapter summary', async () => {
    // Regression: the DM closes a chapter and the player resumes. The only/last boundary
    // is the final message, so cutting there archived all 554 messages and left live=0.
    const id = 'sess-empty-tail';
    const messages = makeMessages(554, [553]);
    writeSession(id, { id, dmPersonality: { archiveThreshold: 500 }, messages });

    const res = await maybeCompact(dataDir, id, { summarize: fakeSummarize });
    expect(res.compacted).toBe(false);

    const sess = readSession(id);
    expect(sess.messages.length).toBe(554); // history left fully intact
    expect(archiveLines(id).length).toBe(0);
  });

  it('falls back to an older boundary when the newest one leaves too small a tail', async () => {
    const id = 'sess-older-boundary';
    const messages = makeMessages(554, [296, 553]);
    writeSession(id, { id, dmPersonality: { archiveThreshold: 500 }, messages });

    const res = await maybeCompact(dataDir, id, { summarize: fakeSummarize });
    expect(res.compacted).toBe(true);
    expect(res.archivedCount).toBe(297);          // cut at 296, not 553
    expect(res.liveMessages.length).toBe(257);
    expect(archiveLines(id).length + res.liveMessages.length).toBe(554); // no loss
  });

  it('does not compact below the threshold', async () => {
    writeSession('s2', { id: 's2', dmPersonality: { archiveThreshold: 500 }, messages: makeMessages(300, [100]) });
    const res = await maybeCompact(dataDir, 's2', { summarize: fakeSummarize });
    expect(res.compacted).toBe(false);
  });

  it('waits for a chapter boundary when over threshold but under the 2x ceiling', async () => {
    writeSession('s3', { id: 's3', dmPersonality: { archiveThreshold: 500 }, messages: makeMessages(600, []) });
    const res = await maybeCompact(dataDir, 's3', { summarize: fakeSummarize });
    expect(res.compacted).toBe(false);
  });

  it('force-cuts past the 2x ceiling when no boundary exists, keeping a recent tail', async () => {
    writeSession('s4', { id: 's4', dmPersonality: { archiveThreshold: 500 }, messages: makeMessages(1000, []) });
    const res = await maybeCompact(dataDir, 's4', { summarize: fakeSummarize });
    expect(res.compacted).toBe(true);
    expect(res.liveMessages.length).toBe(100);
    expect(res.archivedCount).toBe(900);
    expect(readSession('s4').arcSummaries[0].forced).toBe(true);
  });

  it('is disabled when the threshold is 0', async () => {
    writeSession('s5', { id: 's5', dmPersonality: { archiveThreshold: 0 }, messages: makeMessages(1000, [500]) });
    const res = await maybeCompact(dataDir, 's5', { summarize: fakeSummarize });
    expect(res.compacted).toBe(false);
  });

  it('does not mutate state when the summarizer fails', async () => {
    const messages = makeMessages(520, [300]);
    writeSession('s5b', { id: 's5b', dmPersonality: { archiveThreshold: 500 }, messages });
    const failing = async () => { throw new Error('summarizer down'); };
    const res = await maybeCompact(dataDir, 's5b', { summarize: failing });
    expect(res.compacted).toBe(false);
    const sess = readSession('s5b');
    expect(sess.messages.length).toBe(520); // untouched
    expect(sess.arcSummaries).toBeUndefined();
    expect(archiveLines('s5b').length).toBe(0); // nothing archived
  });

  it('accumulates a second arc with cumulative archive line ranges', async () => {
    const id = 's6';
    writeSession(id, { id, dmPersonality: { archiveThreshold: 500 }, messages: makeMessages(520, [100, 300]) });
    await maybeCompact(dataDir, id, { summarize: fakeSummarize }); // seq 1

    const sess = readSession(id);
    sess.messages = sess.messages.concat(makeMessages(400, [50]));
    fs.writeFileSync(path.join(dataDir, 'sessions', id, 'session.json'), JSON.stringify(sess, null, 2));

    const res2 = await maybeCompact(dataDir, id, { summarize: fakeSummarize });
    expect(res2.compacted).toBe(true);
    expect(res2.archiveSeq).toBe(2);
    const after = readSession(id);
    expect(after.arcSummaries.length).toBe(2);
    expect(after.arcSummaries[1].archiveLineRange[0]).toBe(301);
    expect(after.archiveMeta.totalArchived).toBe(archiveLines(id).length);
  });
});

describe('reconcileAndAppend (crash recovery)', () => {
  it('rolls back an uncommitted tail before appending so ranges stay accurate', async () => {
    const dir = path.join(dataDir, 'sessions', 's7');
    fs.mkdirSync(dir, { recursive: true });
    const archiveFp = path.join(dir, 'archive.jsonl');

    await _internal.reconcileAndAppend(archiveFp, makeMessages(5), 0); // committed = 5
    expect(archiveLines('s7').length).toBe(5);

    // Simulate a crash that wrote 3 extra lines before the session commit.
    fs.appendFileSync(archiveFp, 'x\nx\nx\n');
    expect(archiveLines('s7').length).toBe(8);

    // Retry with committed still 5: must roll back to 5 then append 2 => 7.
    await _internal.reconcileAndAppend(archiveFp, makeMessages(2), 5);
    expect(archiveLines('s7').length).toBe(7);
  });
});

// ── WO-0017: compaction commits inside the session queue ──────────────────────────────────────
//
// `maybeCompact` read the session, awaited an LLM call for seconds, then wrote the whole object
// back with `fsp.writeFile`. It used `updateSessionFile` zero times. Everything persisted during
// that window was discarded — the DM turn's messages and world state, a companion claim, and
// `mechanicalOverrides`, which is the only durable record that a player was asked to approve a
// change to their own hit points and agreed.
//
// These tests do not assert that the write is wrapped. Wrapping alone MOVES the bug: `liveTail`
// was computed before the LLM call, so assigning it to a freshly-read session throws away every
// message appended since — losing the transcript instead of the hit points. What is asserted here
// is the interleaving itself. Forced, not sampled: the summarizer is gated so the concurrent write
// lands in the middle of the window every time. A correct serialisation is correct at every
// frequency, so forcing is the right instrument.

const { updateSessionFile } = require('../player-data');

/** A summarizer that stops in the middle so a test can write to the session while it is "thinking". */
function gatedSummarize() {
  let signalEntered;
  let openGate;
  const entered = new Promise(r => { signalEntered = r; });
  const gate = new Promise(r => { openGate = r; });
  return {
    entered,
    release: () => openGate(),
    summarize: async (input) => {
      signalEntered();
      await gate;
      return `ARC BLURB :: ${input.slice(0, 30)}`;
    },
  };
}

function sessionFile(id) {
  return path.join(dataDir, 'sessions', id, 'session.json');
}

function seed(id, total = 520, summaries = [100, 300]) {
  writeSession(id, { id, dmPersonality: { archiveThreshold: 500 }, messages: makeMessages(total, summaries) });
}

describe('a write landing while the summary is being written is not lost', () => {
  it('keeps a message appended during the window, and still archives the span', async () => {
    const id = 'race-messages';
    seed(id);
    const g = gatedSummarize();
    const running = maybeCompact(dataDir, id, { summarize: g.summarize });

    await g.entered;
    await updateSessionFile(dataDir, id, (live) => {
      live.messages.push({ type: 'player', text: 'DURING THE SUMMARY', sessionId: 's' });
    });
    g.release();

    const res = await running;
    expect(res.compacted).toBe(true);
    const saved = readSession(id);
    // 520 - 301 archived = 219 kept, plus the one that arrived mid-window.
    expect(saved.messages).toHaveLength(220);
    expect(saved.messages[saved.messages.length - 1].text).toBe('DURING THE SUMMARY');
    // ...and it is live, not archived: the span is exactly what was cut, no more.
    expect(archiveLines(id)).toHaveLength(301);
    expect(res.liveMessages).toHaveLength(220);
  });

  it('keeps the override audit record — the escape hatch\'s only durable trace', async () => {
    // ADR 0005 §6: mechanicalOverrides is written to session.json through updateSessionFile by
    // OverrideMechanicalState (dm-engine.js), and it is the only place on disk that records a
    // player having been asked to approve a change to their own hit points. Compaction erased it.
    const id = 'race-override';
    seed(id);
    const g = gatedSummarize();
    const running = maybeCompact(dataDir, id, { summarize: g.summarize });

    await g.entered;
    await updateSessionFile(dataDir, id, (live) => {
      live.mechanicalOverrides = [{
        at: new Date().toISOString(),
        entity: 'Kaelara Brightflame',
        pointer: '/hitPoints/current',
        previousValue: 0,
        value: 1,
        reason: 'the player approved it',
      }];
      live.worldState = { location: 'The Sunken Chapel', updatedAt: new Date().toISOString() };
      live.companionPlayers = { 'npc-1': { email: 'friend@test.com', name: 'Sam' } };
    });
    g.release();

    const res = await running;
    expect(res.compacted).toBe(true);
    const saved = readSession(id);
    expect(saved.mechanicalOverrides).toHaveLength(1);
    expect(saved.mechanicalOverrides[0].entity).toBe('Kaelara Brightflame');
    expect(saved.worldState.location).toBe('The Sunken Chapel');
    expect(saved.companionPlayers['npc-1'].email).toBe('friend@test.com');
    // The compaction still happened; nothing was traded away to keep them.
    expect(saved.arcSummaries).toHaveLength(1);
    expect(saved.archiveMeta.totalArchived).toBe(301);
  });

  it('does not lose the concurrent write when the compaction aborts either', async () => {
    const id = 'race-abort-keeps';
    seed(id);
    const g = gatedSummarize();
    const running = maybeCompact(dataDir, id, { summarize: g.summarize });

    await g.entered;
    await updateSessionFile(dataDir, id, (live) => {
      live.messages = makeMessages(60);                       // a client full-array auto-save
      live.worldState = { location: 'Saltmere' };
    });
    g.release();

    expect((await running).compacted).toBe(false);
    const saved = readSession(id);
    expect(saved.worldState.location).toBe('Saltmere');
    expect(saved.messages).toHaveLength(60);
  });
});

describe('the guard: when the transcript changed underneath, nothing happens at all', () => {
  it('aborts on a rewritten prefix and leaves session.json byte-identical', async () => {
    const id = 'guard-rewritten';
    seed(id);
    const g = gatedSummarize();
    const running = maybeCompact(dataDir, id, { summarize: g.summarize });

    await g.entered;
    // PUT /sessions/:id replaces `messages` wholesale from the client's in-memory copy, and
    // persistCanonicalTurn truncates and rewrites the tail when it reconciles a partial save.
    // Either can land here, and then the array this compaction measured no longer exists.
    await updateSessionFile(dataDir, id, (live) => {
      live.messages = makeMessages(520, [100, 300]).map((m, i) =>
        (i < 5 ? { ...m, text: `${m.text} (edited)` } : m));
    });
    const before = fs.readFileSync(sessionFile(id), 'utf-8');
    g.release();

    const res = await running;
    expect(res.compacted).toBe(false);
    expect(fs.readFileSync(sessionFile(id), 'utf-8')).toBe(before);
    // And nothing was appended: the archive write is inside the lock, after the check, so an
    // abort cannot leave archive.jsonl holding messages the session never committed.
    expect(archiveLines(id)).toEqual([]);
  });

  it('aborts when the transcript got shorter than the span it was about to archive', async () => {
    const id = 'guard-truncated';
    seed(id);
    const g = gatedSummarize();
    const running = maybeCompact(dataDir, id, { summarize: g.summarize });

    await g.entered;
    await updateSessionFile(dataDir, id, (live) => { live.messages = live.messages.slice(0, 50); });
    const before = fs.readFileSync(sessionFile(id), 'utf-8');
    g.release();

    expect((await running).compacted).toBe(false);
    expect(fs.readFileSync(sessionFile(id), 'utf-8')).toBe(before);
    expect(archiveLines(id)).toEqual([]);
  });

  it('two compactions racing produce one archive — and it is the guard doing it, not inFlight', async () => {
    // The inFlight set short-circuits the second call, so it is removed here on purpose: what is
    // under test is what protects the data once two compactions really are in flight, which is
    // the claim made in the comment at the top of compaction.js.
    const id = 'race-two-compactions';
    seed(id);
    const a = gatedSummarize();
    const b = gatedSummarize();

    const first = maybeCompact(dataDir, id, { summarize: a.summarize });
    await a.entered;
    _internal.inFlight.delete(id);
    const second = maybeCompact(dataDir, id, { summarize: b.summarize });
    await b.entered;

    a.release();
    const r1 = await first;
    b.release();
    const r2 = await second;

    expect(r1.compacted).toBe(true);
    expect(r2.compacted).toBe(false);          // its span is no longer a prefix of the live array
    expect(archiveLines(id)).toHaveLength(301); // archived once, not twice
    expect(readSession(id).arcSummaries).toHaveLength(1);
    expect(readSession(id).archiveMeta.totalArchived).toBe(301);
  });
});

describe('prefixMatches — the assumption the commit is allowed to make', () => {
  const { prefixMatches } = _internal;
  const span = [{ type: 'player', text: 'a' }, { type: 'dm', text: 'b' }];

  it('accepts the same span with new messages appended after it', () => {
    expect(prefixMatches([...span, { type: 'player', text: 'c' }], span)).toBe(true);
  });

  it('accepts the array unchanged', () => {
    expect(prefixMatches([...span], span)).toBe(true);
  });

  it('rejects a prefix whose content was rewritten, even at the same length', () => {
    expect(prefixMatches([{ type: 'player', text: 'a' }, { type: 'dm', text: 'B!' }], span)).toBe(false);
  });

  it('rejects an array shorter than the span', () => {
    expect(prefixMatches([span[0]], span)).toBe(false);
  });

  it('rejects a reordered prefix', () => {
    expect(prefixMatches([span[1], span[0]], span)).toBe(false);
  });

  it('rejects anything that is not an array', () => {
    expect(prefixMatches(null, span)).toBe(false);
    expect(prefixMatches(undefined, span)).toBe(false);
    expect(prefixMatches({ 0: span[0] }, span)).toBe(false);
  });
});

describe('compaction is wired to the queue, not around it', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'compaction.js'), 'utf-8');
  // Comments stripped before any "the code does not contain X" assertion. The file quotes the
  // line that shipped, in order to explain why it is gone — and the first version of the check
  // below flagged that quotation. A detector that cannot tell code from the comment describing it
  // is the same failure mode QC found in the sanctioned-writer scan, in miniature.
  const code = src.split('\n')
    .filter(l => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

  it('commits through updateSessionFile', () => {
    expect(code).toContain("require('./player-data')");
    expect(code).toMatch(/await updateSessionFile\(dataDir, sessionDbId, async \(live\)/);
  });

  it('no longer writes the session file directly', () => {
    // The line that shipped, verbatim from d02cadd. It is the defect, not a stand-in for it.
    expect(code).not.toContain('await fsp.writeFile(fp, JSON.stringify(session, null, 2));');
    // ...and nothing else writes to the session path either. The archive is a different file.
    const sessionPathWrites = [...code.matchAll(/(?:fsp\.writeFile|fs\.writeFileSync|writeJsonAtomic)\s*\(\s*fp\b/g)];
    expect(sessionPathWrites).toHaveLength(0);
  });

  it('does the expensive call outside the lock and the commit inside it', () => {
    const summarizeAt = code.indexOf('await summarize(buildSummaryInput(span))');
    const lockAt = code.indexOf('await updateSessionFile(dataDir, sessionDbId');
    expect(summarizeAt).toBeGreaterThan(-1);
    expect(lockAt).toBeGreaterThan(summarizeAt);
  });

  it('recomputes the tail from the fresh array rather than assigning the stale one', () => {
    // The whole trap of this work order in one assertion: `liveTail` must be derived from the
    // object the queue just read, never from the array captured before the LLM call.
    expect(code).toContain('const liveTail = fresh.slice(span.length);');
    expect(code).not.toMatch(/const liveTail = messages\.slice/);
  });
});
