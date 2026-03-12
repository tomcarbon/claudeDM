import { useState, useEffect, useRef } from 'react';
import { api } from '../api/client';

// Shared spell data cache — loaded once, shared across all SpellTag instances
let spellCache = null;
let spellCachePromise = null;

function loadSpells() {
  if (spellCache) return Promise.resolve(spellCache);
  if (spellCachePromise) return spellCachePromise;
  spellCachePromise = api.getRule('spells').then(data => {
    const map = new Map();
    for (const [, spells] of Object.entries(data || {})) {
      if (!Array.isArray(spells)) continue;
      for (const spell of spells) {
        if (spell.name) map.set(spell.name.toLowerCase(), spell);
      }
    }
    spellCache = map;
    return map;
  }).catch(() => {
    spellCachePromise = null;
    return null;
  });
  return spellCachePromise;
}

function extractSpellName(raw) {
  // Strip parenthetical notes like "Mage Hand (invisible, Arcane Trickster)"
  return raw.replace(/\s*\(.*\)$/, '').trim();
}

export default function SpellTag({ name }) {
  const [spell, setSpell] = useState(null);
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  const cleanName = extractSpellName(name);
  const notes = name.includes('(') ? name.match(/\(([^)]+)\)/)?.[1] : null;

  useEffect(() => {
    loadSpells().then(map => {
      if (map) setSpell(map.get(cleanName.toLowerCase()) || null);
    });
  }, [cleanName]);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    function handleClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  if (!spell) {
    // No match in rules DB — render as plain tag
    return <span className="tag">{name}</span>;
  }

  return (
    <span className="tag spell-tag" ref={ref} style={{ position: 'relative' }}>
      <button
        className="spell-tag-btn"
        onClick={(e) => { e.stopPropagation(); setOpen(o => !o); }}
        title={`Click for ${cleanName} details`}
      >
        {name}
      </button>
      {open && (
        <div className="spell-detail-popup" onClick={e => e.stopPropagation()}>
          <div className="spell-detail-header">
            <strong>{spell.name}</strong>
            <span className="spell-detail-school">
              {spell.level ? `Level ${spell.level}` : 'Cantrip'} {spell.school}
            </span>
          </div>
          <div className="spell-detail-meta">
            <span><strong>Casting Time:</strong> {spell.casting_time}</span>
            <span><strong>Range:</strong> {spell.range}</span>
            <span><strong>Components:</strong> {spell.components}</span>
            <span><strong>Duration:</strong> {spell.duration}</span>
          </div>
          <div className="spell-detail-desc">{spell.description}</div>
          {spell.classes && (
            <div className="spell-detail-classes">
              {spell.classes.join(', ')}
            </div>
          )}
          {notes && (
            <div className="spell-detail-notes">Note: {notes}</div>
          )}
        </div>
      )}
    </span>
  );
}
