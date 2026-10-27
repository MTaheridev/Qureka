'use client';

import type { CSSProperties } from 'react';
import './SoftAurora.css';

/**
 * CSS Soft Aurora — inspired by React Bits SoftAurora / Aurora
 * (https://reactbits.dev/backgrounds/aurora) without WebGL deps.
 */
export function SoftAurora({
  className = '',
  style,
}: {
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div className={`soft-aurora ${className}`.trim()} style={style} aria-hidden="true">
      <span className="soft-aurora__blob soft-aurora__blob--a" />
      <span className="soft-aurora__blob soft-aurora__blob--b" />
      <span className="soft-aurora__blob soft-aurora__blob--c" />
      <span className="soft-aurora__grid" />
      <span className="soft-aurora__vignette" />
    </div>
  );
}
