import React, { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { authService } from '@/services/auth.service';
import { BadgeCheck } from 'lucide-react';
import type { User } from '@/types/auth.types';
import { getThemePreference, setThemePreference, type ThemePreference } from '@/lib/theme';

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
];

/* Fixed swatches for the theme previews; they must not follow the app theme. */
const PAPER = { bg: 'oklch(0.985 0 0)', line: 'oklch(0.84 0 0)', accent: 'oklch(0.16 0 0)' };
const INK = { bg: 'oklch(0.115 0 0)', line: 'oklch(0.30 0 0)', accent: 'oklch(0.92 0 0)' };

function ThemeMiniPreview({ variant }: { variant: ThemePreference }) {
  const half = variant === 'system';
  const palettes = half ? [PAPER, INK] : [variant === 'light' ? PAPER : INK];
  return (
    <div className="flex h-full w-full overflow-hidden rounded-[9px]">
      {palettes.map((p, i) => (
        <div key={i} className="flex flex-1 gap-1.5 p-2" style={{ backgroundColor: p.bg }}>
          <div className="flex w-2.5 flex-col gap-1 pt-0.5">
            <div className="h-1 rounded-full" style={{ backgroundColor: p.accent }} />
            <div className="h-1 rounded-full" style={{ backgroundColor: p.line }} />
            <div className="h-1 rounded-full" style={{ backgroundColor: p.line }} />
          </div>
          <div className="flex flex-1 flex-col gap-1 pt-0.5">
            <div className="h-1.5 w-3/5 rounded-full" style={{ backgroundColor: p.line }} />
            <div className="h-1 rounded-full" style={{ backgroundColor: p.line, opacity: 0.7 }} />
            <div className="h-1 w-4/5 rounded-full" style={{ backgroundColor: p.line, opacity: 0.7 }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function SettingsSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-t border-border py-8 first:border-t-0 first:pt-0">
      <div className="grid gap-6 md:grid-cols-[220px_1fr]">
        <div>
          <h2 className="font-display text-[15px] font-semibold text-foreground">{title}</h2>
          <p className="mt-1 text-[13px] leading-5 text-muted-foreground">{description}</p>
        </div>
        <div className="min-w-0">{children}</div>
      </div>
    </section>
  );
}

function InfoRow({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-6 py-2.5">
      <span className="shrink-0 text-[13px] text-muted-foreground">{label}</span>
      <span
        className={`min-w-0 truncate text-right text-[13px] font-medium text-foreground ${
          mono ? 'font-mono text-xs' : ''
        }`}
      >
        {value}
      </span>
    </div>
  );
}

const SettingsPage: React.FC = () => {
  const [userInfo, setUserInfo] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [aecEnabled, setAecEnabled] = useState(() => {
    const v = localStorage.getItem('aec_enabled');
    return localStorage.getItem('aec_preference_version') === '2' && v === 'true';
  });
  const [theme, setTheme] = useState<ThemePreference>(() => getThemePreference());

  const changeTheme = (next: ThemePreference) => {
    setTheme(next);
    setThemePreference(next);
  };

  useEffect(() => {
    loadUserInfo();
    // Load AEC setting from backend (cross-window safe)
    invoke<boolean>('get_aec_enabled').then(setAecEnabled).catch(() => {});
  }, []);

  const toggleAec = async () => {
    const next = !aecEnabled;
    setAecEnabled(next);
    // Persist so the preference survives restarts.
    localStorage.setItem('aec_enabled', String(next));
    localStorage.setItem('aec_preference_version', '2');
    try {
      await invoke('set_aec_enabled', { enabled: next });
    } catch (err) {
      console.error('Failed to set AEC:', err);
      setAecEnabled(!next);
      localStorage.setItem('aec_enabled', String(!next));
    }
  };

  const loadUserInfo = () => {
    try {
      const user = authService.getUser();
      if (user) {
        setUserInfo(user);
      }
    } catch (err) {
      console.error('Failed to load user info:', err);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex h-screen flex-1 flex-col overflow-hidden bg-background px-10 pt-9">
        <div className="mx-auto w-full max-w-3xl">
          <div className="h-10 w-48 animate-pulse rounded-lg bg-muted" />
          <div className="mt-10 space-y-4">
            <div className="h-24 animate-pulse rounded-xl bg-muted/70" />
            <div className="h-24 animate-pulse rounded-xl bg-muted/70" />
          </div>
        </div>
      </div>
    );
  }

  if (!userInfo) {
    return (
      <div className="flex flex-1 items-center justify-center bg-background">
        <p className="text-sm text-muted-foreground">User not found</p>
      </div>
    );
  }

  return (
    <div className="h-screen flex-1 overflow-y-auto bg-background">
      <div className="mx-auto max-w-3xl px-10 pb-20 pt-9">
        <header className="mb-10">
          <h1 className="font-display text-[2rem] font-semibold leading-tight tracking-tight text-foreground">
            Settings
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Your account, appearance, and recording preferences.
          </p>
        </header>

        <SettingsSection
          title="Profile"
          description="The account this workspace belongs to."
        >
          <div className="overflow-hidden rounded-xl border border-border bg-card">
            <div className="flex items-center gap-4 border-b border-border bg-muted/40 px-5 py-4">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary/12 font-display text-lg font-semibold text-primary">
                {(userInfo.full_name || userInfo.username).charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0 leading-tight">
                <p className="flex items-center gap-1.5 truncate text-[15px] font-semibold text-foreground">
                  {userInfo.full_name || userInfo.username}
                  {userInfo.is_verified && (
                    <BadgeCheck className="h-4 w-4 shrink-0 text-primary" strokeWidth={1.75} />
                  )}
                </p>
                <p className="mt-0.5 truncate text-[13px] text-muted-foreground">{userInfo.email}</p>
              </div>
            </div>
            <div className="px-5 py-2">
              <InfoRow label="Username" value={`@${userInfo.username}`} />
              <InfoRow label="User ID" value={userInfo.id} mono />
              <InfoRow
                label="Status"
                value={
                  <span className={userInfo.is_active ? 'text-foreground' : 'text-destructive'}>
                    {userInfo.is_active ? 'Active' : 'Inactive'}
                  </span>
                }
              />
            </div>
          </div>
        </SettingsSection>

        <SettingsSection
          title="Appearance"
          description="How Atok.ai looks on this device."
        >
          <div className="grid max-w-md grid-cols-3 gap-3">
            {THEME_OPTIONS.map(({ value, label }) => {
              const selected = theme === value;
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => changeTheme(value)}
                  onMouseDown={(e) => e.preventDefault()}
                  aria-pressed={selected}
                  className={`group rounded-xl border p-1.5 text-left transition-all active:scale-[0.98] ${
                    selected
                      ? 'border-primary/60 ring-1 ring-primary/40'
                      : 'border-border hover:border-ring/40'
                  }`}
                >
                  <div className="aspect-[16/10] w-full">
                    <ThemeMiniPreview variant={value} />
                  </div>
                  <div className="flex items-center justify-between px-1.5 pb-1 pt-2">
                    <span className={`text-[12.5px] font-medium ${selected ? 'text-foreground' : 'text-muted-foreground'}`}>
                      {label}
                    </span>
                    <span
                      aria-hidden
                      className={`h-2 w-2 rounded-full transition-colors ${
                        selected ? 'bg-primary' : 'bg-border group-hover:bg-muted-foreground/40'
                      }`}
                    />
                  </div>
                </button>
              );
            })}
          </div>
        </SettingsSection>

        <SettingsSection
          title="Recording"
          description="Applies to the pop-up recording studio."
        >
          <div className="flex items-center justify-between gap-6 rounded-xl border border-border bg-card px-5 py-4">
            <div className="min-w-0">
              <p className="text-[13px] font-medium text-foreground">Echo cancellation</p>
              <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                Removes speaker audio from the microphone while system audio is shared.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={aecEnabled}
              aria-label="Echo cancellation"
              onClick={toggleAec}
              className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border border-transparent transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background ${
                aecEnabled ? 'bg-primary' : 'bg-muted-foreground/25'
              }`}
            >
              <span
                className={`pointer-events-none block h-5 w-5 rounded-full bg-card shadow-sm ring-1 ring-black/5 transition-transform duration-200 ${
                  aecEnabled ? 'translate-x-[22px]' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>
        </SettingsSection>

        <p className="border-t border-border pt-6 text-xs leading-5 text-muted-foreground">
          Account information is stored encrypted. To change any of it, contact support.
        </p>
      </div>
    </div>
  );
};

export default SettingsPage;
