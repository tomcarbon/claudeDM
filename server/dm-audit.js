// Post-turn audit: scans the DM's narrative for stat-change phrases and checks
// whether the DM also called Edit / AwardXP / TrackResources to back them up.
// Returns an array of warnings; an empty array means the audit found nothing.
//
// This is a heuristic detector — false positives are tolerable, false negatives
// are the cost of missing a real bookkeeping skip. The goal is to surface
// patterns of unrecorded stat changes so we can iterate on the DM prompt.

const PATTERNS = [
  {
    category: 'damage_or_healing',
    re: /\b(?:takes?|loses?|deals?|inflicts?|suffers?)\s+\d+\s+(?:\w+\s+)?damage\b|\bheals?\s+(?:for\s+)?\d+\b|\bregains?\s+\d+\s+HP\b|\bdrops?\s+to\s+\d+\s*HP\b|\bdrops?\s+to\s+0\b/i,
  },
  {
    category: 'spell_cast',
    re: /\b(?:casts?|cast)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b|\b\d(?:st|nd|rd|th)[- ]?level\s+spell\s+slot\b|\bexpends?\s+a\s+spell\s+slot\b/i,
  },
  {
    category: 'item_gained',
    re: /\b(?:you|the party)\s+(?:find|finds|receive|receives|gain|gains|pick up|picks up|loot|loots)\b|\badded?\s+to\s+(?:your|their)\s+inventory\b/i,
  },
  {
    category: 'item_lost_or_consumed',
    re: /\b(?:you|the party)\s+(?:give|gives|hand|hands over|lose|loses|drop|drops|consume|consumes|use up|uses up)\b|\bdrinks?\s+(?:the|a)\s+\w+\b|\beats?\s+(?:the|a|an)\s+\w+\b/i,
  },
  {
    category: 'currency',
    re: /\b\d+\s*(?:gp|sp|cp|pp|ep|gold pieces?|silver pieces?|copper pieces?|platinum pieces?)\b|\bpays?\s+\d+\b|\bslides?\s+\d+\s+(?:gold|silver|copper)\b/i,
  },
  {
    category: 'ammunition',
    re: /\b(?:fires?|looses?|shoots?|nocks?)\s+(?:an?\s+)?(?:arrow|bolt|dart|bullet)\b/i,
  },
  {
    category: 'death_or_status',
    re: /\b(?:dies|is dead|killed|slain)\b|\bstatus\s*(?:changes?|set)\s+to\s+dead\b/i,
  },
  {
    category: 'xp_award',
    re: /\b\d+\s*XP\b|\bgains?\s+\d+\s+experience\b/i,
  },
];

// Phantom-roll detection: narrated roll results that require a RollDice tool call.
// These are checked separately because they require RollDice specifically, not Edit.
const ROLL_PATTERNS = [
  {
    category: 'phantom_roll_save',
    re: /\b(?:STR|DEX|CON|INT|WIS|CHA|Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma)\s+(?:save|saving throw|Save)\s*[:\s]\s*\d+/i,
  },
  {
    category: 'phantom_roll_check',
    re: /\b(?:STR|DEX|CON|INT|WIS|CHA|Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma)\s+(?:check)\s*[:\s]\s*\d+/i,
  },
  {
    category: 'phantom_roll_attack',
    re: /\b(?:attack roll|to[- ]hit|attack)\s*[:\s]\s*\d+\s*(?:vs|against|\+)/i,
  },
  {
    category: 'phantom_roll_skill',
    re: /\b(?:Perception|Stealth|Persuasion|Deception|Intimidation|Investigation|Insight|Athletics|Acrobatics|Arcana|History|Nature|Religion|Medicine|Survival|Performance|Sleight of Hand|Animal Handling)\s+(?:check)?\s*[:\s]\s*\d+/i,
  },
  {
    category: 'phantom_roll_d20',
    re: /\bd20\s*[:(]\s*\d+\s*\)/i,
  },
  {
    category: 'phantom_roll_initiative',
    re: /\binitiative\s*[:\s]\s*\d+/i,
  },
];

function auditDmTurn(responseText, toolCalls) {
  if (!responseText || typeof responseText !== 'string') return [];
  const calls = Array.isArray(toolCalls) ? toolCalls : [];
  const editCount = calls.filter(t => t.name === 'Edit').length;
  const awardXpCount = calls.filter(t => /AwardXP/.test(t.name || '')).length;
  const trackResourcesCount = calls.filter(t => /TrackResources/.test(t.name || '')).length;
  const rollDiceCount = calls.filter(t => /RollDice/.test(t.name || '')).length;

  const warnings = [];

  // Check stat-change patterns (require Edit / AwardXP / TrackResources)
  for (const { category, re } of PATTERNS) {
    const m = responseText.match(re);
    if (!m) continue;

    let satisfied = false;
    if (category === 'xp_award') {
      satisfied = awardXpCount > 0;
    } else if (category === 'death_or_status') {
      satisfied = editCount > 0;
    } else {
      satisfied = editCount > 0 || trackResourcesCount > 0;
    }

    if (!satisfied) {
      const idx = m.index || 0;
      const excerpt = responseText
        .slice(Math.max(0, idx - 30), idx + 80)
        .replace(/\s+/g, ' ')
        .trim();
      warnings.push({ category, trigger: m[0], excerpt });
    }
  }

  // Check phantom-roll patterns (require RollDice)
  for (const { category, re } of ROLL_PATTERNS) {
    const m = responseText.match(re);
    if (!m) continue;

    if (rollDiceCount === 0) {
      const idx = m.index || 0;
      const excerpt = responseText
        .slice(Math.max(0, idx - 30), idx + 80)
        .replace(/\s+/g, ' ')
        .trim();
      warnings.push({ category, trigger: m[0], excerpt });
    }
  }

  return warnings;
}

// Categories that represent a persisted-state change and can therefore be fixed by a file edit
// after the fact. Phantom-roll categories are deliberately excluded — a missed dice roll cannot
// be reconciled by editing a file, and re-rolling after narration would violate dice integrity.
// `spell_cast` is also excluded: it's a noisy signal (cantrips use no slot) and slot tracking is
// handled in-session, not by the character JSON the player's widgets read.
const RECONCILABLE_CATEGORIES = new Set([
  'damage_or_healing',
  'item_gained',
  'item_lost_or_consumed',
  'currency',
  'ammunition',
  'death_or_status',
  'xp_award',
]);

// Should the turn trigger an automatic reconciliation pass? Only if the audit flagged a
// file-backed stat change that wasn't matched by a tool call.
function needsReconcile(warnings) {
  return Array.isArray(warnings) && warnings.some(w => RECONCILABLE_CATEGORIES.has(w.category));
}

// Build the internal correction message sent to the DM agent during a reconciliation pass.
// It is NOT narrative — the agent is told to apply the missing edits silently and confirm in
// one line. charPathPrefix / npcPathPrefix are the session-scoped directories computed the same
// way as in buildGameStateContext (e.g. data/sessions/<id>/characters).
function buildReconcilePrompt(warnings, charPathPrefix, npcPathPrefix) {
  const items = (warnings || [])
    .filter(w => RECONCILABLE_CATEGORIES.has(w.category))
    .map(w => `- [${w.category}] "${w.trigger}" — ...${w.excerpt}...`)
    .join('\n');
  return `[Internal reconciliation check — do NOT narrate this to the player, do NOT advance the story.]
Your previous response described the following game-state changes, but no matching file edit or tool call was detected:

${items}

For each one, Read the affected character/NPC file under \`${charPathPrefix}\` (NPCs under \`${npcPathPrefix}\`) and apply the change now via Edit — for XP use the AwardXP tool. If a file already reflects the change (i.e. this was a false alarm), leave it untouched. Do not invent new changes beyond what you already narrated. Reply with a single line summarizing what you edited (or "already correct") — produce no story narrative.`;
}

function formatWarnings(warnings, sessionDbId) {
  if (!warnings || warnings.length === 0) return null;
  const lines = warnings.map(w => `  - [${w.category}] "${w.trigger}" — ...${w.excerpt}...`);
  return `[DM:AUDIT] session=${sessionDbId || 'unknown'} unbacked stat changes (${warnings.length}):\n${lines.join('\n')}`;
}

// Always-on instrumentation: emits one line per audit run summarising what was seen.
// Useful while validating the audit pipeline; can be quieted later.
function logAuditTrace(sessionDbId, responseText, toolCalls, warnings) {
  const calls = Array.isArray(toolCalls) ? toolCalls : [];
  const counts = {};
  for (const c of calls) {
    const n = (c && c.name) || 'unknown';
    counts[n] = (counts[n] || 0) + 1;
  }
  const summary = Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(' ') || 'none';
  const textLen = (responseText || '').length;
  console.log(`[DM:AUDIT] session=${sessionDbId || 'unknown'} text=${textLen}c tools=${calls.length} (${summary}) warnings=${(warnings || []).length}`);
}

module.exports = { auditDmTurn, formatWarnings, logAuditTrace, needsReconcile, buildReconcilePrompt, RECONCILABLE_CATEGORIES };
