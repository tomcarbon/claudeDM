const fs = require('fs');
const path = require('path');

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function slugify(value) {
  return normalize(value).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function listJsonFiles(dir) {
  try {
    return fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  } catch {
    return [];
  }
}

function collectMatches(dataDir, characterRef) {
  const ref = normalize(characterRef);
  const refSlug = slugify(characterRef);
  const candidateDirs = [
    { kind: 'character', dir: path.join(dataDir, 'characters') },
    { kind: 'npc', dir: path.join(dataDir, 'npcs') },
  ];

  const exactIdMatches = [];
  const looseMatches = [];

  for (const candidate of candidateDirs) {
    const files = listJsonFiles(candidate.dir);
    for (const file of files) {
      const fullPath = path.join(candidate.dir, file);
      const data = loadJson(fullPath);
      if (!data) continue;

      if (data.id === characterRef) {
        exactIdMatches.push({ ...candidate, file, data });
        continue;
      }

      const id = normalize(data.id);
      const name = normalize(data.name);
      const fileStem = normalize(path.basename(file, '.json'));

      if (id === ref || name === ref || fileStem === ref) {
        looseMatches.push({ ...candidate, file, data });
        continue;
      }

      const nameSlug = slugify(data.name);
      if (nameSlug && nameSlug === refSlug) {
        looseMatches.push({ ...candidate, file, data });
      }
    }
  }

  if (exactIdMatches.length > 0) return exactIdMatches;
  return looseMatches;
}

function findCharacterOrNpcFile(dataDir, characterRef) {
  const matches = collectMatches(dataDir, characterRef);
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    const options = matches.map(m => `${m.data.name} (${m.data.id})`).join(', ');
    throw new Error(`Ambiguous character reference "${characterRef}". Matches: ${options}`);
  }
  return matches[0];
}

function awardXp(dataDir, characterId, xpAmount) {
  const result = findCharacterOrNpcFile(dataDir, characterId);
  if (!result) {
    throw new Error(`Character not found: ${characterId}`);
  }

  const awardedXp = Number(xpAmount);
  if (!Number.isFinite(awardedXp)) {
    throw new Error(`Invalid XP amount: ${xpAmount}`);
  }

  const { data: character, dir, file: filename, kind } = result;
  const previousXp = Number(character.experience) || 0;
  const previousLevel = character.level || 1;
  const newXp = Math.max(0, previousXp + awardedXp);

  // Load leveling thresholds
  const leveling = loadJson(path.join(dataDir, 'rules', 'leveling.json'));
  const thresholds = Array.isArray(leveling?.xp_thresholds) ? leveling.xp_thresholds : [];
  if (thresholds.length === 0) {
    throw new Error('Could not load XP thresholds from rules/leveling.json');
  }

  // Determine new level: find highest threshold the new XP meets
  let newLevel = previousLevel;
  let newProficiencyBonus = character.proficiencyBonus || 2;
  for (const t of thresholds.sort((a, b) => a.xp_required - b.xp_required)) {
    if (newXp >= t.xp_required) {
      newLevel = t.level;
      newProficiencyBonus = t.proficiency_bonus;
    }
  }

  // Update character
  character.experience = newXp;
  character.level = newLevel;
  character.proficiencyBonus = newProficiencyBonus;

  fs.writeFileSync(
    path.join(dir, filename),
    JSON.stringify(character, null, 2)
  );

  return {
    kind,
    id: character.id,
    name: character.name,
    awardedXp,
    previousXp,
    newXp,
    previousLevel,
    newLevel,
    leveledUp: newLevel > previousLevel,
  };
}

module.exports = { awardXp };
