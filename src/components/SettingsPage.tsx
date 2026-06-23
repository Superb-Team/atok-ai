import React, { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { authService } from '@/services/auth.service';
import { User as UserIcon, Mail, Hash, Shield, Volume2 } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { User } from '@/types/auth.types';

const SettingsPage: React.FC = () => {
  const [userInfo, setUserInfo] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [aecEnabled, setAecEnabled] = useState(() => {
    const v = localStorage.getItem('aec_enabled');
    return v === null ? true : v === 'true';
  });

  useEffect(() => {
    loadUserInfo();
    // Load AEC setting from backend (cross-window safe)
    invoke<boolean>('get_aec_enabled').then(setAecEnabled).catch(() => {});
  }, []);

  const toggleAec = async () => {
    const next = !aecEnabled;
    setAecEnabled(next);
    // Persist so the preference survives restarts (the backend static resets to ON).
    localStorage.setItem('aec_enabled', String(next));
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
      <div className="flex-1 flex items-center justify-center bg-neutral-50 dark:bg-neutral-900">
        <p className="text-neutral-600 dark:text-neutral-400">Loading...</p>
      </div>
    );
  }

  if (!userInfo) {
    return (
      <div className="flex-1 flex items-center justify-center bg-neutral-50 dark:bg-neutral-900">
        <p className="text-neutral-600 dark:text-neutral-400">User not found</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto bg-neutral-50 dark:bg-neutral-900">
      <div className="max-w-4xl mx-auto p-8">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-neutral-900 dark:text-white mb-2">
            Account Settings
          </h1>
          <p className="text-neutral-600 dark:text-neutral-400">
            Manage your account information and preferences
          </p>
        </div>

        {/* User Profile Card */}
        <Card className="mb-6 dark:bg-neutral-800 dark:border-neutral-700">
          <CardHeader>
            <CardTitle className="text-xl">Profile Information</CardTitle>
            <CardDescription>Your personal account details</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Full Name */}
            {userInfo.full_name && (
              <div className="flex items-start gap-4">
                <div className="p-2 rounded-lg bg-neutral-100 dark:bg-neutral-700">
                  <UserIcon className="w-5 h-5 text-neutral-600 dark:text-neutral-400" />
                </div>
                <div className="flex-1">
                  <p className="text-sm font-medium text-neutral-500 dark:text-neutral-400 mb-1">
                    Full Name
                  </p>
                  <p className="text-base text-neutral-900 dark:text-white font-medium">
                    {userInfo.full_name}
                  </p>
                </div>
              </div>
            )}

            {/* Username */}
            <div className="flex items-start gap-4">
              <div className="p-2 rounded-lg bg-neutral-100 dark:bg-neutral-700">
                <UserIcon className="w-5 h-5 text-neutral-600 dark:text-neutral-400" />
              </div>
              <div className="flex-1">
                <p className="text-sm font-medium text-neutral-500 dark:text-neutral-400 mb-1">
                  Username
                </p>
                <p className="text-base text-neutral-900 dark:text-white font-medium">
                  {userInfo.username}
                </p>
              </div>
            </div>

            {/* Email */}
            <div className="flex items-start gap-4">
              <div className="p-2 rounded-lg bg-neutral-100 dark:bg-neutral-700">
                <Mail className="w-5 h-5 text-neutral-600 dark:text-neutral-400" />
              </div>
              <div className="flex-1">
                <p className="text-sm font-medium text-neutral-500 dark:text-neutral-400 mb-1">
                  Email Address
                </p>
                <p className="text-base text-neutral-900 dark:text-white font-medium">
                  {userInfo.email}
                </p>
                {userInfo.is_verified && (
                  <div className="flex items-center gap-1 mt-1">
                    <Shield className="w-3 h-3 text-green-600 dark:text-green-400" />
                    <span className="text-xs text-green-600 dark:text-green-400">Verified</span>
                  </div>
                )}
              </div>
            </div>

            {/* User ID */}
            <div className="flex items-start gap-4">
              <div className="p-2 rounded-lg bg-neutral-100 dark:bg-neutral-700">
                <Hash className="w-5 h-5 text-neutral-600 dark:text-neutral-400" />
              </div>
              <div className="flex-1">
                <p className="text-sm font-medium text-neutral-500 dark:text-neutral-400 mb-1">
                  User ID
                </p>
                <p className="text-base text-neutral-900 dark:text-white font-mono">
                  {userInfo.id}
                </p>
              </div>
            </div>

            {/* Account Status */}
            <div className="flex items-start gap-4">
              <div className="p-2 rounded-lg bg-neutral-100 dark:bg-neutral-700">
                <Shield className="w-5 h-5 text-neutral-600 dark:text-neutral-400" />
              </div>
              <div className="flex-1">
                <p className="text-sm font-medium text-neutral-500 dark:text-neutral-400 mb-1">
                  Account Status
                </p>
                <div className="flex items-center gap-2">
                  <div className={`w-2 h-2 rounded-full ${userInfo.is_active ? 'bg-green-500' : 'bg-red-500'}`}></div>
                  <p className="text-base text-neutral-900 dark:text-white">
                    {userInfo.is_active ? 'Active' : 'Inactive'}
                  </p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Audio Settings Card */}
        <Card className="mb-6 dark:bg-neutral-800 dark:border-neutral-700">
          <CardHeader>
            <CardTitle className="text-xl">Audio Settings</CardTitle>
            <CardDescription>Configure recording preferences</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-4">
              <div className="p-2 rounded-lg bg-neutral-100 dark:bg-neutral-700 shrink-0">
                <Volume2 className="w-5 h-5 text-neutral-600 dark:text-neutral-400" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-neutral-900 dark:text-white">
                  Echo Cancellation
                </p>
                <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
                  Remove speaker audio from mic when sharing system audio.
                </p>
              </div>
              <div className="flex shrink-0 items-center">
                <button
                  type="button"
                  role="switch"
                  aria-checked={aecEnabled}
                  aria-label="Echo cancellation"
                  onClick={toggleAec}
                  className={`relative inline-flex h-8 w-[88px] shrink-0 appearance-none items-center rounded-full border p-0 bg-neutral-950/80 shadow-inner transition-all duration-300 ease-out focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-50 dark:focus-visible:ring-offset-neutral-900 ${
                    aecEnabled
                      ? 'border-cyan-400/35 shadow-cyan-500/10'
                      : 'border-red-500/25 shadow-red-500/5'
                  }`}
                >
                  <span
                    className={`absolute top-1/2 -translate-y-1/2 text-[10px] font-semibold tracking-[0.18em] transition-colors duration-200 ${
                      aecEnabled
                        ? 'left-3 text-cyan-300'
                        : 'right-3 text-red-300'
                    }`}
                  >
                    {aecEnabled ? 'ON' : 'OFF'}
                  </span>
                  <span
                    className={`pointer-events-none absolute left-1 top-1 block h-[22px] w-[22px] rounded-full bg-white/90 shadow-[0_2px_10px_rgba(0,0,0,0.45)] ring-1 ring-white/70 transition-transform duration-300 ease-out ${
                      aecEnabled ? 'translate-x-[58px]' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Additional Info */}
        <div className="bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
          <p className="text-sm text-blue-800 dark:text-blue-300">
            <strong>Note:</strong> Your account information is securely stored and encrypted.
            If you need to update any information, please contact support.
          </p>
        </div>
      </div>
    </div>
  );
};

export default SettingsPage;
