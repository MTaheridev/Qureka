'use client';

import { useEffect, useState } from 'react';
import { useSettings } from '@/lib/settings';

const THINKING_EN = [
  'Thinking',
  'Reading your question',
  'Checking what we know',
  'Planning a safe query',
  'Looking through the schema',
  'Gathering the right tables',
  'Double-checking the numbers',
];

const THINKING_FA = [
  'در حال فکر کردن',
  'در حال خواندن سؤالت',
  'بررسی دانش موجود',
  'طراحی کوئری امن',
  'نگاه به اسکیما',
  'انتخاب جدول‌های درست',
  'بازبینی اعداد',
];

const ANALYZING_EN = [
  'Analyzing the database',
  'Checking read-only access',
  'Reading tables and columns',
  'Mapping relationships',
  'Sampling a few rows',
  'Learning the structure',
];

const ANALYZING_FA = [
  'در حال تحلیل دیتابیس',
  'بررسی دسترسی فقط‌خواندنی',
  'خواندن جدول‌ها و ستون‌ها',
  'نقشه‌برداری روابط',
  'نمونه‌گیری از ردیف‌ها',
  'یادگیری ساختار',
];

export function ThinkingIndicator({
  mode,
  detail,
}: {
  mode: 'thinking' | 'analyzing';
  detail?: string | null;
}) {
  const { language } = useSettings();
  const phrases =
    mode === 'thinking'
      ? language === 'fa'
        ? THINKING_FA
        : THINKING_EN
      : language === 'fa'
        ? ANALYZING_FA
        : ANALYZING_EN;

  const [index, setIndex] = useState(0);

  useEffect(() => {
    setIndex(0);
    const reduced =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) return;
    const timer = window.setInterval(() => {
      setIndex((current) => (current + 1) % phrases.length);
    }, 2200);
    return () => window.clearInterval(timer);
  }, [phrases.length, mode, language]);

  return (
    <div className={`thinking-indicator thinking-${mode}`} role="status" aria-live="polite">
      <span className="thinking-orb" aria-hidden="true" />
      <div className="thinking-copy">
        <strong className="thinking-phrase" key={`${mode}-${index}`}>
          {phrases[index]}
          <span className="thinking-dots" aria-hidden="true">
            <span>.</span>
            <span>.</span>
            <span>.</span>
          </span>
        </strong>
        {detail ? <span className="thinking-detail">{detail}</span> : null}
      </div>
    </div>
  );
}
