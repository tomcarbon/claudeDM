/**
 * Extract gold amount from an equipment array.
 * Handles formats like "Belt pouch containing 10 gp", "15 gp", "10 gold pieces", etc.
 */
export function parseGold(equipment) {
  if (!Array.isArray(equipment)) return 0;
  let total = 0;
  for (const item of equipment) {
    const match = String(item).match(/(\d+)\s*gp/i);
    if (match) total += parseInt(match[1], 10);
  }
  return total;
}
