import { useState, useRef, useEffect } from 'react';
import { getCollapseThreshold } from '../utils/displaySettings';

const COLLAPSED_LINES = 6;
const LINE_HEIGHT_ESTIMATE = 1.5; // em

export default function CollapsibleMessage({ text, children, lineThreshold }) {
  const [collapsed, setCollapsed] = useState(true);
  const [isLong, setIsLong] = useState(false);
  const contentRef = useRef(null);

  const threshold = lineThreshold ?? getCollapseThreshold();

  // 0 = disabled (never collapse)
  const textLineCount = typeof text === 'string' ? text.split('\n').length : 0;

  // Also measure rendered height to catch wrapped lines
  useEffect(() => {
    if (!threshold) { setIsLong(false); return; }
    if (textLineCount > threshold) {
      setIsLong(true);
      return;
    }
    // Fallback: measure rendered content height vs threshold
    const el = contentRef.current;
    if (el) {
      const style = window.getComputedStyle(el);
      const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * LINE_HEIGHT_ESTIMATE;
      const renderedLines = el.scrollHeight / lineHeight;
      setIsLong(renderedLines > threshold);
    }
  }, [text, textLineCount, threshold]);

  if (!isLong) {
    return <div ref={contentRef}>{children}</div>;
  }

  const collapsedMaxHeight = `${COLLAPSED_LINES * LINE_HEIGHT_ESTIMATE}em`;

  return (
    <div className="collapsible-message">
      <div
        ref={contentRef}
        className="collapsible-content"
        style={{
          maxHeight: collapsed ? collapsedMaxHeight : 'none',
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        {children}
        {collapsed && (
          <div
            className="collapsible-fade"
            style={{
              position: 'absolute',
              bottom: 0,
              left: 0,
              right: 0,
              height: '3em',
              background: 'linear-gradient(transparent, var(--bg-card, #1a1a2e))',
              pointerEvents: 'none',
            }}
          />
        )}
      </div>
      <button
        className="collapsible-toggle"
        onClick={() => setCollapsed(c => !c)}
        style={{
          background: 'none',
          border: 'none',
          color: 'var(--accent, #6366f1)',
          cursor: 'pointer',
          padding: '0.25rem 0',
          fontSize: '0.85rem',
          textAlign: 'left',
        }}
      >
        {collapsed ? `Show more ▼` : `Show less ▲`}
      </button>
    </div>
  );
}
