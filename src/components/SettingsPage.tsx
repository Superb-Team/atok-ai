import React, { useState, useEffect } from 'react';
import { authService } from '@/services/auth.service';
import { User as UserIcon, Mail, Hash, Shield } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { User } from '@/types/auth.types';

const SettingsPage: React.FC = () => {
  const [userInfo, setUserInfo] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadUserInfo();
  }, []);

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
