import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../api/client';
import { useCampaign } from '../context/CampaignContext';
import { CATEGORIES, categoryOf } from '../utils/gameCategories';

// SRD 5.1 attribution. The wording below is fixed — see NOTICE at the project root.
// Do not reword, shorten or "improve" it: it is what satisfies CC BY 4.0 section 3(a).
const SRD_URL = 'https://dnd.wizards.com/resources/systems-reference-document';
const CC_BY_URL = 'https://creativecommons.org/licenses/by/4.0/legalcode';

const SHORT_NOTICE =
  'Rules content includes material from the System Reference Document 5.1 by Wizards of ' +
  'the Coast LLC, licensed under CC BY 4.0. Modified (reformatted, abridged and ' +
  'reorganised) for use in this app. Full notice: ';

const NOTICE_P1_BEFORE =
  'This work includes material taken from the System Reference Document 5.1 ("SRD 5.1") ' +
  'by Wizards of the Coast LLC and available at ';
const NOTICE_P1_MIDDLE =
  '. The SRD 5.1 is licensed under the Creative Commons Attribution 4.0 International ' +
  'License available at ';
const NOTICE_P1_AFTER = '.';
const NOTICE_P2 =
  'The SRD 5.1 material used here has been modified: it has been reformatted into JSON, ' +
  'abridged, reorganised, and selectively excerpted for use by this application.';
const NOTICE_P3 =
  'The SRD 5.1 is provided "as is" and without warranties of any kind, to the extent ' +
  'permitted by the licence.';

function SrdNotice() {
  return (
    <section
      id="srd-notice"
      className="card"
      style={{ marginTop: '2rem', color: 'var(--text-muted)', fontSize: '0.85em' }}
    >
      <h3 style={{ fontSize: '1em', marginBottom: '0.5rem' }}>Attribution</h3>
      <p style={{ marginBottom: '0.5rem' }}>
        {NOTICE_P1_BEFORE}
        <a href={SRD_URL} target="_blank" rel="noopener noreferrer">{SRD_URL}</a>
        {NOTICE_P1_MIDDLE}
        <a href={CC_BY_URL} target="_blank" rel="noopener noreferrer">{CC_BY_URL}</a>
        {NOTICE_P1_AFTER}
      </p>
      <p style={{ marginBottom: '0.5rem' }}>{NOTICE_P2}</p>
      <p style={{ marginBottom: 0 }}>{NOTICE_P3}</p>
    </section>
  );
}

// What each ruleset is, in a sentence. Fantasy carries the SRD notice; Sci-Fi is original content.
const RULESET_BLURB = {
  fantasy: 'Fantasy rules database (SRD 5.1). Select a category below.',
  scifi: 'Sci-Fi rules database — the same d20 core with gunplay, technology and no magic. Original content. Select a category below.',
  noir: 'Noir rules database — the same d20 core with fists, period firearms and the rules for working a case. Original content. Select a category below.',
  western: 'Western rules database — the same d20 core with six-guns, horses, showdowns and the trail. Original content. Select a category below.',
  horror: 'Horror rules database — the same d20 core with fear, Dread, creatures that follow rules, and no magic for the characters. Original content. Select a category below.',
};

function RulesPage() {
  const { campaign } = useCampaign();
  // Opens on the ruleset of the campaign the player is in; the tabs switch freely after that.
  const [ruleset, setRuleset] = useState(() => categoryOf(campaign));
  const [categories, setCategories] = useState([]);
  const [selected, setSelected] = useState(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingRule, setLoadingRule] = useState(false);

  // Only the latest request may land: switching rulesets quickly must not paint the previous
  // ruleset's file under the new tab.
  const latestRequest = useRef(0);
  const selectCategory = useCallback((cat, set) => {
    const ticket = ++latestRequest.current;
    setSelected(cat);
    setLoadingRule(true);
    api.getRule(cat, set)
      .then(d => { if (ticket === latestRequest.current) setData(d); })
      .catch(() => { if (ticket === latestRequest.current) setData(null); })
      .finally(() => { if (ticket === latestRequest.current) setLoadingRule(false); });
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.getRuleCategories(ruleset)
      .then(cats => {
        if (cancelled) return;
        setCategories(cats);
        if (cats.length > 0) selectCategory(cats[0], ruleset);
        else { setSelected(null); setData(null); }
      })
      .catch(() => { if (!cancelled) setCategories([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [ruleset, selectCategory]);

  // The Sci-Fi ruleset keeps the Fantasy file names so one reader serves both; label them for what they hold.
  const MODERN_LABELS = { races: 'Origins', adversaries: 'Adversaries' };
  const formatLabel = (s) => (ruleset !== 'fantasy' && MODERN_LABELS[s]) || s.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const isFantasy = ruleset === 'fantasy';

  if (loading) return <div className="loading">Loading rules...</div>;

  return (
    <div>
      <h2>Rules Reference</h2>
      <div className="rules-nav ruleset-tabs" role="tablist" aria-label="Ruleset" style={{ marginTop: '0.75rem' }}>
        {CATEGORIES.map(cat => (
          <button
            key={cat.id}
            role="tab"
            aria-selected={ruleset === cat.id}
            className={ruleset === cat.id ? 'active' : ''}
            onClick={() => setRuleset(cat.id)}
          >
            {cat.icon} {cat.label}
          </button>
        ))}
      </div>
      <p style={{ color: 'var(--text-muted)', margin: '0.5rem 0 0.5rem' }}>
        {RULESET_BLURB[ruleset] || RULESET_BLURB.fantasy}
      </p>
      {isFantasy && (
        <p style={{ color: 'var(--text-muted)', fontSize: '0.85em', margin: '0 0 1rem' }}>
          {SHORT_NOTICE}
          <a href="#srd-notice">below on this page</a>
        </p>
      )}

      <div className="rules-nav">
        {categories.map(cat => (
          <button
            key={cat}
            className={selected === cat ? 'active' : ''}
            onClick={() => selectCategory(cat, ruleset)}
          >
            {formatLabel(cat)}
          </button>
        ))}
      </div>

      <div className="rules-content">
        {loadingRule ? (
          <div className="loading">Loading...</div>
        ) : data ? (
          <RuleViewer data={data} />
        ) : (
          <div className="error">No data available</div>
        )}
      </div>

      {/* The SRD 5.1 notice is owed by the Fantasy rules. It stays on the page whichever tab is
          open, because the Fantasy rules are still served by this app either way. */}
      <SrdNotice />
    </div>
  );
}

function RuleViewer({ data }) {
  if (Array.isArray(data)) {
    return (
      <div>
        {data.map((item, i) => (
          <RuleItem key={i} item={item} />
        ))}
      </div>
    );
  }
  if (typeof data === 'object') {
    return (
      <div>
        {Object.entries(data).map(([key, value]) => (
          <div key={key} className="card" style={{ marginBottom: '0.75rem' }}>
            <h3 style={{ fontSize: '1em', marginBottom: '0.5rem' }}>
              {key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
            </h3>
            {typeof value === 'string' ? (
              <p style={{ fontSize: '0.9em' }}>{value}</p>
            ) : Array.isArray(value) ? (
              <div>
                {value.map((item, i) => (
                  <RuleItem key={i} item={item} />
                ))}
              </div>
            ) : (
              <pre>{JSON.stringify(value, null, 2)}</pre>
            )}
          </div>
        ))}
      </div>
    );
  }
  return <pre>{JSON.stringify(data, null, 2)}</pre>;
}

function RuleItem({ item }) {
  const [expanded, setExpanded] = useState(false);

  if (typeof item === 'string') {
    return <span className="tag">{item}</span>;
  }

  const name = item.name || item.title || Object.values(item).find(v => typeof v === 'string') || 'Item';

  return (
    <div className="card" style={{ padding: '0.75rem', marginBottom: '0.5rem' }}>
      <div
        onClick={() => setExpanded(!expanded)}
        style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
      >
        <strong>{name}</strong>
        <span style={{ color: 'var(--text-muted)' }}>{expanded ? '▼' : '▶'}</span>
      </div>
      {expanded && (
        <pre style={{ marginTop: '0.5rem', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {JSON.stringify(item, null, 2)}
        </pre>
      )}
    </div>
  );
}

export default RulesPage;
