'use client';

import type { ReactNode } from 'react';

export type GuidedStep = {
  id: string;
  title: string;
  detail: string;
  done?: boolean;
  active?: boolean;
};

export function GuidedSteps({
  steps,
  title = 'How it works',
}: {
  steps: GuidedStep[];
  title?: string;
}) {
  return (
    <section className="guided-steps" aria-label={title}>
      <p className="guided-steps__title">{title}</p>
      <ol className="guided-steps__list">
        {steps.map((step, index) => (
          <li
            key={step.id}
            className={[
              'guided-steps__item',
              step.done ? 'is-done' : '',
              step.active ? 'is-active' : '',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            <span className="guided-steps__num" aria-hidden="true">
              {step.done ? '✓' : index + 1}
            </span>
            <span className="guided-steps__copy">
              <strong>{step.title}</strong>
              <span>{step.detail}</span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function WizardSteps({
  steps,
  current,
}: {
  steps: string[];
  current: number;
}) {
  return (
    <nav className="wizard-steps" aria-label="Form steps">
      {steps.map((label, index) => {
        const state = index < current ? 'done' : index === current ? 'active' : 'todo';
        return (
          <div key={label} className={`wizard-steps__item is-${state}`}>
            <span className="wizard-steps__dot">{index < current ? '✓' : index + 1}</span>
            <span className="wizard-steps__label">{label}</span>
            {index < steps.length - 1 ? <span className="wizard-steps__rail" aria-hidden="true" /> : null}
          </div>
        );
      })}
    </nav>
  );
}

export function SuggestionChips({
  items,
  onPick,
}: {
  items: string[];
  onPick: (value: string) => void;
}) {
  return (
    <div className="suggestion-chips">
      {items.map((item) => (
        <button key={item} type="button" className="suggestion-chip" onClick={() => onPick(item)}>
          {item}
        </button>
      ))}
    </div>
  );
}

export function StartHereCard({
  children,
  eyebrow = 'Start here',
  title,
  description,
}: {
  children?: ReactNode;
  eyebrow?: string;
  title: string;
  description: string;
}) {
  return (
    <div className="start-here">
      <span className="eyebrow">{eyebrow}</span>
      <h2>{title}</h2>
      <p>{description}</p>
      {children}
    </div>
  );
}
