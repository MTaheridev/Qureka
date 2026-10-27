'use client';

import { AgentShell } from '@/components/AgentShell';
import { SettingsProvider } from '@/lib/settings';

export default function HomePage() {
  return (
    <SettingsProvider>
      <AgentShell />
    </SettingsProvider>
  );
}
