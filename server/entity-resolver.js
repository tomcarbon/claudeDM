const fs = require('fs');
const path = require('path');
const {
  getPlayerCharactersDir,
  getSessionCharactersDir,
  getSessionNpcsDir,
} = require('./player-data');

// The single canonical character/NPC file resolver. During play the session
// snapshot is the source of truth, so the same id legitimately exists in the
// session dir AND the player library AND campaign defaults — that is normal,
// not ambiguous. Resolution is strictly first-tier-wins.

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function slugify(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function listJsonFiles(dir) {
  try {
    return fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  } catch {
    return [];
  }
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function mtimeMs(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

// Ordered search tiers: session characters → session npcs → player library →
// campaign defaults. (Legacy flat dirs are gone — see git history.)
function candidateTiers(dataDir, playerEmail, campaignId, sessionId) {
  const tiers = [];
  if (sessionId) {
    tiers.push(
      { kind: 'character', dir: getSessionCharactersDir(dataDir, sessionId) },
      { kind: 'npc', dir: getSessionNpcsDir(dataDir, sessionId) },
    );
  }
  if (playerEmail) {
    tiers.push({ kind: 'character', dir: getPlayerCharactersDir(dataDir, playerEmail, campaignId) });
  }
  tiers.push(
    { kind: 'character', dir: path.join(dataDir, 'defaults', campaignId || 'demo', 'characters') },
    { kind: 'npc', dir: path.join(dataDir, 'defaults', campaignId || 'demo', 'npcs') },
  );
  return tiers;
}

function scanTier(tier, characterRef) {
  const ref = normalize(characterRef);
  const refSlug = slugify(characterRef);
  const exact = [];
  const loose = [];

  for (const file of listJsonFiles(tier.dir)) {
    const fullPath = path.join(tier.dir, file);
    const data = readJsonSafe(fullPath);
    if (!data) continue;

    if (data.id === characterRef) {
      exact.push({ ...tier, file, filePath: fullPath, data });
      continue;
    }

    const fileStem = normalize(path.basename(file, '.json'));
    if (normalize(data.id) === ref || normalize(data.name) === ref || fileStem === ref) {
      loose.push({ ...tier, file, filePath: fullPath, data });
      continue;
    }
    const nameSlug = slugify(data.name);
    if (nameSlug && nameSlug === refSlug) {
      loose.push({ ...tier, file, filePath: fullPath, data });
    }
  }
  return { exact, loose };
}

// Within-tier duplicates (same id under two filenames — e.g. a stale slug copy)
// resolve to the newest file, loudly, instead of throwing.
function pickNewest(matches, characterRef) {
  if (matches.length === 1) return matches[0];
  const sorted = [...matches].sort((a, b) => mtimeMs(b.filePath) - mtimeMs(a.filePath));
  console.warn(
    `[RESOLVER:DUPLICATE] "${characterRef}" matches ${matches.length} files in ${sorted[0].dir}: ` +
    `${sorted.map(m => m.file).join(', ')} — using newest (${sorted[0].file})`
  );
  return sorted[0];
}

/**
 * Resolve a character/NPC reference (id, name, or filename slug) to a single file.
 * First tier containing an exact-id match wins; if no tier has an exact-id match,
 * the first tier containing a loose (name/slug) match wins.
 * Returns { kind, dir, file, filePath, data } or null.
 */
function findCharacterOrNpcFile(dataDir, characterRef, playerEmail, campaignId, sessionId) {
  const tiers = candidateTiers(dataDir, playerEmail, campaignId, sessionId);
  const scans = tiers.map(tier => scanTier(tier, characterRef));

  for (const scan of scans) {
    if (scan.exact.length > 0) return pickNewest(scan.exact, characterRef);
  }
  for (const scan of scans) {
    if (scan.loose.length > 0) return pickNewest(scan.loose, characterRef);
  }
  return null;
}

// Human-readable roster of what actually exists, so a failed lookup is
// actionable in-band for the DM instead of a dead-end "not found".
function describeRoster(dataDir, playerEmail, campaignId, sessionId) {
  const seen = new Set();
  const entries = [];
  for (const tier of candidateTiers(dataDir, playerEmail, campaignId, sessionId)) {
    for (const file of listJsonFiles(tier.dir)) {
      const data = readJsonSafe(path.join(tier.dir, file));
      if (!data || !data.id || seen.has(data.id)) continue;
      seen.add(data.id);
      entries.push(`${data.name || file} (${tier.kind}, id ${data.id})`);
    }
  }
  return entries.join(', ') || '(no character or NPC files found)';
}

/** Like findCharacterOrNpcFile but throws a roster-listing error when unresolved. */
function requireCharacterOrNpcFile(dataDir, characterRef, playerEmail, campaignId, sessionId) {
  const result = findCharacterOrNpcFile(dataDir, characterRef, playerEmail, campaignId, sessionId);
  if (!result) {
    throw new Error(
      `Character not found: "${characterRef}". Known party: ` +
      describeRoster(dataDir, playerEmail, campaignId, sessionId)
    );
  }
  return result;
}

/**
 * Ensure a session's character bindings resolve to real files in the session dir.
 * - Binding that resolves only by name/slug (stale or non-id ref) → heal the stored id.
 * - Binding whose file exists in library/defaults but not the session dir → copy in.
 * - Unresolvable binding → return a warning for the caller to surface visibly.
 * Mutates `session` in place (characterId heal); caller persists session.json.
 * Returns { changed, healedCharacterId, warnings: string[] }.
 */
function verifySessionIntegrity(dataDir, session) {
  const warnings = [];
  let changed = false;
  let healedCharacterId = null;

  if (!session || !session.id) return { changed, healedCharacterId, warnings };
  const sessionId = session.id;
  const campaignId = session.campaignId || 'demo';
  const playerEmail = session.playerEmail || session.ownerEmail || null;
  const sessionCharsDir = getSessionCharactersDir(dataDir, sessionId);
  const sessionsRoot = path.join(dataDir, 'sessions');

  const bindings = [];
  if (session.characterId) {
    bindings.push({
      ref: session.characterId,
      label: 'player character',
      healId: (id) => { session.characterId = id; healedCharacterId = id; },
    });
  }
  for (const [npcId, claim] of Object.entries(session.companionPlayers || {})) {
    if (!claim) continue;
    bindings.push({ ref: npcId, label: `companion slot (${claim.email || 'unknown'})` });
    if (claim.characterId) {
      bindings.push({
        ref: claim.characterId,
        label: `companion character (${claim.email || 'unknown'})`,
        healId: (id) => { claim.characterId = id; },
      });
    }
  }

  for (const binding of bindings) {
    const match = findCharacterOrNpcFile(dataDir, binding.ref, playerEmail, campaignId, sessionId);

    if (!match) {
      warnings.push(
        `Session binding for ${binding.label} (ref "${binding.ref}") matches no character file. ` +
        `Known party: ${describeRoster(dataDir, playerEmail, campaignId, sessionId)}`
      );
      continue;
    }

    // Ref resolved but isn't the file's actual id (name/slug or drifted id) → heal.
    if (binding.healId && match.data.id && match.data.id !== binding.ref) {
      console.warn(`[SESSION:BINDING_HEALED] Session ${sessionId} ${binding.label}: "${binding.ref}" → ${match.data.id} ("${match.data.name}")`);
      binding.healId(match.data.id);
      changed = true;
    }

    // File lives outside the session snapshot → copy it in so play edits land there.
    if (!match.dir.startsWith(sessionsRoot)) {
      const destDir = match.kind === 'npc' ? getSessionNpcsDir(dataDir, sessionId) : sessionCharsDir;
      fs.mkdirSync(destDir, { recursive: true });
      const dest = path.join(destDir, match.file);
      if (!fs.existsSync(dest)) {
        fs.copyFileSync(match.filePath, dest);
        console.warn(`[SESSION:BINDING_HEALED] Copied ${match.file} into session ${sessionId} for ${binding.label}`);
        changed = true;
      }
    }
  }

  return { changed, healedCharacterId, warnings };
}

module.exports = {
  slugify,
  normalize,
  findCharacterOrNpcFile,
  requireCharacterOrNpcFile,
  describeRoster,
  verifySessionIntegrity,
};
