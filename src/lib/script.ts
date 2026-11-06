export function hasPersian(value: string): boolean {
  return /[\u0600-\u06FF]/.test(value);
}

export function resultDir(columns: string[], uiDir: 'ltr' | 'rtl'): 'ltr' | 'rtl' {
  if (uiDir === 'rtl' || columns.some(hasPersian)) return 'rtl';
  return 'ltr';
}
