import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api/client';

function ScenarioDetail() {
  const { id } = useParams();
  const [scenario, setScenario] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expandedAct, setExpandedAct] = useState(0);

  useEffect(() => {
    api.getScenario(id)
      .then(setScenario)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) return <div className="loading">Loading scenario...</div>;
  if (error) return <div className="error">Error: {error}</div>;
  if (!scenario) return <div className="error">Scenario not found</div>;

  return (
    <div>
      <div className="detail-header">
        <div>
          <h2>{scenario.title}</h2>
          {scenario.subtitle && (
            <div style={{ color: 'var(--accent)', fontStyle: 'italic', marginTop: '0.3rem' }}>{scenario.subtitle}</div>
          )}
          <div className="detail-meta" style={{ marginTop: '0.3rem' }}>
            Levels {scenario.levelRange} | ~{scenario.estimatedSessions} sessions
          </div>
        </div>
      </div>

      {/* Synopsis & Hook */}
      <div className="detail-section">
        <h3>Synopsis</h3>
        <p style={{ fontSize: '0.95em', lineHeight: 1.6 }}>{scenario.synopsis}</p>
      </div>

      <div className="detail-section">
        <h3>Adventure Hook</h3>
        <div className="read-aloud-box">
          <p>{scenario.hook}</p>
        </div>
      </div>

      {/* Setting */}
      {scenario.setting && (
        <div className="detail-section">
          <h3>Setting: {scenario.setting.name}</h3>
          <p style={{ fontSize: '0.9em', marginBottom: '0.75rem' }}>{scenario.setting.description}</p>
          {scenario.setting.atmosphere && (
            <p style={{ fontSize: '0.85em', color: 'var(--text-muted)', fontStyle: 'italic' }}>Atmosphere: {scenario.setting.atmosphere}</p>
          )}
          {scenario.setting.keyLocations?.length > 0 && (
            <div style={{ marginTop: '1rem' }}>
              <strong style={{ fontSize: '0.9em' }}>Key Locations:</strong>
              {scenario.setting.keyLocations.map((loc, i) => (
                <div key={i} className="card" style={{ marginTop: '0.5rem', padding: '0.75rem' }}>
                  <strong style={{ color: 'var(--gold)' }}>{loc.name}</strong>
                  <p style={{ fontSize: '0.85em', marginTop: '0.25rem' }}>{loc.description}</p>
                  {loc.features?.length > 0 && (
                    <div style={{ marginTop: '0.3rem' }}>{loc.features.map((f, j) => <span key={j} className="tag">{f}</span>)}</div>
                  )}
                  {loc.secrets?.length > 0 && (
                    <div style={{ marginTop: '0.3rem', fontSize: '0.8em', color: 'var(--accent)' }}>
                      Secrets: {loc.secrets.join('; ')}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Acts */}
      {scenario.acts?.length > 0 && (
        <div className="detail-section">
          <h3>Adventure Structure</h3>
          {scenario.acts.map((act, i) => (
            <div key={i} className="card" style={{ marginTop: '0.5rem' }}>
              <div
                onClick={() => setExpandedAct(expandedAct === i ? -1 : i)}
                style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
              >
                <strong style={{ color: 'var(--gold)' }}>Act {i + 1}: {act.title}</strong>
                <span style={{ color: 'var(--text-muted)' }}>{expandedAct === i ? '▼' : '▶'}</span>
              </div>
              <p style={{ fontSize: '0.85em', marginTop: '0.3rem', color: 'var(--text-muted)' }}>{act.description}</p>

              {expandedAct === i && (
                <div style={{ marginTop: '0.75rem' }}>
                  {act.objectives?.length > 0 && (
                    <div style={{ marginBottom: '0.75rem' }}>
                      <strong style={{ fontSize: '0.85em' }}>Objectives:</strong>
                      <ul style={{ marginLeft: '1.2rem', fontSize: '0.85em', marginTop: '0.25rem' }}>
                        {act.objectives.map((obj, j) => <li key={j}>{obj}</li>)}
                      </ul>
                    </div>
                  )}

                  {act.scenes?.map((scene, j) => (
                    <div key={j} style={{ borderLeft: '2px solid var(--border)', paddingLeft: '0.75rem', marginBottom: '0.75rem' }}>
                      <strong style={{ fontSize: '0.9em' }}>{scene.name}</strong>
                      <p style={{ fontSize: '0.85em', marginTop: '0.2rem' }}>{scene.description}</p>

                      {scene.readAloud && (
                        <div className="read-aloud-box" style={{ marginTop: '0.5rem' }}>
                          <p style={{ fontSize: '0.85em' }}>{scene.readAloud}</p>
                        </div>
                      )}

                      {scene.skillChecks?.length > 0 && (
                        <div style={{ marginTop: '0.4rem' }}>
                          {scene.skillChecks.map((sc, k) => (
                            <div key={k} style={{ fontSize: '0.8em', marginBottom: '0.2rem' }}>
                              <span className="tag">{sc.skill} DC {sc.dc}</span>
                              {sc.success && <span style={{ color: '#27ae60' }}> Pass: {sc.success}</span>}
                              {sc.failure && <span style={{ color: 'var(--accent)' }}> | Fail: {sc.failure}</span>}
                            </div>
                          ))}
                        </div>
                      )}

                      {scene.combatEncounters?.length > 0 && (
                        <div style={{ marginTop: '0.4rem' }}>
                          {scene.combatEncounters.map((ce, k) => (
                            <div key={k} style={{ fontSize: '0.8em', background: 'var(--bg-dark)', padding: '0.4rem 0.6rem', borderRadius: '4px', marginBottom: '0.3rem' }}>
                              <strong>Combat ({ce.difficulty}):</strong> {ce.enemies?.join(', ')}
                              {ce.tactics && <div style={{ color: 'var(--text-muted)' }}>Tactics: {ce.tactics}</div>}
                              {ce.terrain && <div style={{ color: 'var(--text-muted)' }}>Terrain: {ce.terrain}</div>}
                            </div>
                          ))}
                        </div>
                      )}

                      {scene.loot?.length > 0 && (
                        <div style={{ marginTop: '0.3rem', fontSize: '0.8em' }}>
                          <strong>Loot:</strong> {scene.loot.join(', ')}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* NPCs */}
      {scenario.npcsInvolved?.length > 0 && (
        <div className="detail-section">
          <h3>Key NPCs</h3>
          {scenario.npcsInvolved.map((npc, i) => (
            <div key={i} className="card" style={{ marginTop: '0.5rem', padding: '0.75rem' }}>
              <strong style={{ color: 'var(--gold)' }}>{npc.name}</strong>
              <span className="tag" style={{ marginLeft: '0.5rem' }}>{npc.role}</span>
              <p style={{ fontSize: '0.85em', marginTop: '0.25rem' }}>{npc.description}</p>
              {npc.motivation && <p style={{ fontSize: '0.8em', color: 'var(--text-muted)', fontStyle: 'italic' }}>Motivation: {npc.motivation}</p>}
            </div>
          ))}
        </div>
      )}

      {/* Rewards */}
      {scenario.rewards && (
        <div className="detail-section">
          <h3>Rewards</h3>
          <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap', fontSize: '0.9em' }}>
            {scenario.rewards.xp > 0 && <div><strong>XP:</strong> {scenario.rewards.xp}</div>}
            {scenario.rewards.gold && <div><strong>Gold:</strong> {scenario.rewards.gold}</div>}
          </div>
          {scenario.rewards.items?.length > 0 && (
            <div style={{ marginTop: '0.3rem' }}>{scenario.rewards.items.map((it, i) => <span key={i} className="tag">{it}</span>)}</div>
          )}
          {scenario.rewards.story && <p style={{ fontSize: '0.85em', marginTop: '0.3rem', color: 'var(--text-muted)' }}>{scenario.rewards.story}</p>}
        </div>
      )}

      {/* Twists */}
      {scenario.twists?.length > 0 && (
        <div className="detail-section">
          <h3>Plot Twists (DM Eyes Only)</h3>
          {scenario.twists.map((t, i) => (
            <div key={i} style={{ fontSize: '0.9em', marginBottom: '0.3rem', paddingLeft: '0.5rem', borderLeft: '2px solid var(--accent)' }}>{t}</div>
          ))}
        </div>
      )}

      {/* DM Tips */}
      {scenario.dmTips?.length > 0 && (
        <div className="detail-section">
          <h3>DM Tips</h3>
          <ul style={{ marginLeft: '1.2rem', fontSize: '0.9em' }}>
            {scenario.dmTips.map((tip, i) => <li key={i} style={{ marginBottom: '0.3rem' }}>{tip}</li>)}
          </ul>
        </div>
      )}

      <div style={{ marginTop: '2rem' }}>
        <Link to="/scenarios">&larr; Back to Scenarios</Link>
      </div>
    </div>
  );
}

export default ScenarioDetail;
