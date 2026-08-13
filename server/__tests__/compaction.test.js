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
