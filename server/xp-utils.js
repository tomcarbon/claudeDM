const fs = require('fs');
const path = require('path');

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function findCharacterFile(charDir, characterId) {
  const files = fs.readdirSync(charDir).filter(f => f.endsWith('.json'));
  for (const file of files) {
    const data = loadJson(path.join(charDir, file));
    if (data && data.id === characterId) {
      return { data, file };
    }
  }
  return null;
}

function awardXp(dataDir, characterId, xpAmount) {
  const charDir = path.join(dataDir, 'characters');
  const result = findCharacterFile(charDir, characterId);
  if (!result) {
    throw new Error(`Character not found: ${characterId}`);
  }

  const { data: character, file: filename } = result;
  const previousXp = character.experience || 0;
  const previousLevel = character.level || 1;
  const newXp = previousXp + xpAmount;

  // Load leveling thresholds
  const leveling = loadJson(path.join(dataDir, 'rules', 'leveling.json'));
  const thresholds = leveling.xp_thresholds;

  // Determine new level: find highest threshold the new XP meets
  let newLevel = previousLevel;
  let newProficiencyBonus = character.proficiencyBonus || 2;
  for (const t of thresholds) {
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
    path.join(charDir, filename),
    JSON.stringify(character, null, 2)
  );

  return {
    name: character.name,
    previousXp,
    newXp,
    previousLevel,
    newLevel,
    leveledUp: newLevel > previousLevel,
  };
}

module.exports = { awardXp };
