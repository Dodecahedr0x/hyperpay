import type { CSSProperties } from 'react'

/** Optional visual tokens. Components are unstyled by default; apply these via `style`/`className`. */
export const tokens = {
  bg: '#0b0d10',
  panel: '#14181e',
  line: '#2a313a',
  text: '#f4f6f8',
  muted: '#9aa3ad',
  accent: '#3dff9a',
  accentText: '#06140c',
  danger: '#ff6b6b',
  radius: 12,
  font: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif',
}

export const buttonStyle: CSSProperties = {
  appearance: 'none',
  border: 'none',
  background: tokens.accent,
  color: tokens.accentText,
  fontFamily: tokens.font,
  fontWeight: 600,
  fontSize: 15,
  lineHeight: '20px',
  padding: '12px 18px',
  borderRadius: 999,
  cursor: 'pointer',
}

export const ghostButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: 'transparent',
  color: tokens.text,
  boxShadow: `inset 0 0 0 1px ${tokens.line}`,
}

export const panelStyle: CSSProperties = {
  background: tokens.panel,
  color: tokens.text,
  fontFamily: tokens.font,
  borderRadius: tokens.radius,
  border: `1px solid ${tokens.line}`,
  padding: 20,
}

export const overlayStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(6, 8, 10, 0.64)',
  display: 'grid',
  placeItems: 'center',
  zIndex: 1000,
  padding: 16,
}
