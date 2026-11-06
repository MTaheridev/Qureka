'use client';

import { ReportWindow } from '@/components/ReportWindow';
import { SettingsProvider } from '@/lib/settings';

export default function ReportRoute() {
  return (
    <SettingsProvider>
      <ReportWindow />
    </SettingsProvider>
  );
}
