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

module.exports = { auditDmTurn, formatWarnings, logAuditTrace };
