import { createElement } from 'react';

const INLINE_MARKDOWN_PATTERN = '(`[^`]+`|\\[[^\\]]+\\]\\([^)]+\\)|\\*\\*[^*]+\\*\\*|__[^_]+__|\\*[^*\\n]+\\*|_[^_\\n]+_)';

function normalizeUrl(rawUrl) {
  const cleaned = (rawUrl || '').trim().replace(/^<|>$/g, '');
  if (!cleaned) return null;

  if (cleaned.startsWith('/') || cleaned.startsWith('#')) {
    return cleaned;
  }

  try {
    const parsed = new URL(cleaned, window.location.origin);
    const protocol = parsed.protocol.toLowerCase();
    if (protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:' || protocol === 'tel:') {
      return parsed.href;
    }
  } catch {
    return null;
  }

  return null;
}

function parseInline(text, keyPrefix) {
  const nodes = [];
  let lastIndex = 0;
  let tokenIndex = 0;
  // Use a fresh regex per parse call so recursive calls cannot reset iterator state.
  const inlineMarkdownRe = new RegExp(INLINE_MARKDOWN_PATTERN, 'g');

  let match;
  while ((match = inlineMarkdownRe.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }

    const token = match[0];
    const key = `${keyPrefix}-${tokenIndex++}`;

    if (token.startsWith('`')) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith('[')) {
      const linkMatch = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      const label = linkMatch?.[1] || token;
      const href = normalizeUrl(linkMatch?.[2] || '');
      if (href) {
        const isLocal = href.startsWith('/') || href.startsWith('#');
        nodes.push(
          <a
            key={key}
            href={href}
            target={isLocal ? undefined : '_blank'}
            rel={isLocal ? undefined : 'noopener noreferrer'}
          >
            {parseInline(label, `${key}-label`)}
          </a>
        );
      } else {
        nodes.push(label);
      }
    } else if (token.startsWith('**') || token.startsWith('__')) {
      nodes.push(
        <strong key={key}>
          {parseInline(token.slice(2, -2), `${key}-strong`)}
        </strong>
      );
    } else if (token.startsWith('*') || token.startsWith('_')) {
      nodes.push(
        <em key={key}>
          {parseInline(token.slice(1, -1), `${key}-em`)}
        </em>
      );
    } else {
      nodes.push(token);
    }

    lastIndex = inlineMarkdownRe.lastIndex;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

export default function RichText({ text, className, as }) {
  const value = typeof text === 'string' ? text : (text == null ? '' : String(text));
  const elementType = as || 'span';
  const lines = value.split('\n');
  const content = [];

  lines.forEach((line, lineIndex) => {
    if (lineIndex > 0) {
      content.push(<br key={`br-${lineIndex}`} />);
    }
    content.push(...parseInline(line, `line-${lineIndex}`));
  });

  return createElement(elementType, { className }, content);
}
