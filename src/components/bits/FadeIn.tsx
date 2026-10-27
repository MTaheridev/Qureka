'use client';

import type { CSSProperties, ReactNode } from 'react';

export function FadeIn({
  children,
  className = '',
  delayMs = 0,
  style,
}: {
  children: ReactNode;
  className?: string;
  delayMs?: number;
  style?: CSSProperties;
}) {
  return (
    <div
      className={`fade-in ${className}`.trim()}
      style={{ animationDelay: `${delayMs}ms`, ...style }}
    >
      {children}
    </div>
  );
}
