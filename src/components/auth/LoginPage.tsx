import { useState } from "react";
import { authService } from "@/services/auth.service";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ArrowRight } from "lucide-react";

interface LoginPageProps {
  onLoginSuccess: () => void;
  onSwitchToSignup: () => void;
}

export default function LoginPage({ onLoginSuccess, onSwitchToSignup }: LoginPageProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const response = await authService.login({ email, password });
      authService.saveToken(response.token);
      authService.saveUser(response.user);
      onLoginSuccess();
    } catch (err) {
      console.error("Login error:", err);
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex bg-gradient-to-br from-neutral-50 via-neutral-100 to-neutral-200 dark:from-neutral-950 dark:via-neutral-900 dark:to-neutral-800">
      {/* Left Side - Branding */}
      <div className="hidden lg:flex lg:w-1/2 bg-gradient-to-br from-neutral-900 to-neutral-800 dark:from-black dark:to-neutral-900 p-12 flex-col justify-between relative overflow-hidden">
        {/* Background Pattern */}
        <div className="absolute inset-0 opacity-10">
          <div className="absolute inset-0" style={{
            backgroundImage: `radial-gradient(circle at 2px 2px, white 1px, transparent 0)`,
            backgroundSize: '40px 40px'
          }}></div>
        </div>

        <div className="relative z-10">
          <div className="flex items-center gap-3 mb-8">
            <img src="/logo-atok.png" alt="Atok.ai" className="w-12 h-12 rounded-xl" />
            <span className="text-3xl font-bold text-white">Atok.ai</span>
          </div>
          
          <div className="mt-16">
            <h2 className="text-4xl font-bold text-white mb-4">
              Welcome back to your
              <br />
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-purple-400">
                AI-powered workspace
              </span>
            </h2>
            <p className="text-neutral-300 text-lg">
              Manage your notes, tasks, and ideas with intelligent assistance.
            </p>
          </div>
        </div>

        <div className="relative z-10 text-neutral-400 text-sm">
          © 2025 Atok.ai. All rights reserved.
        </div>
      </div>

      {/* Right Side - Login Form */}
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="w-full max-w-md">
          {/* Mobile Logo */}
          <div className="lg:hidden flex items-center justify-center gap-3 mb-8">
            <img src="/logo-atok.png" alt="Atok.ai" className="w-10 h-10 rounded-xl" />
            <span className="text-2xl font-bold text-neutral-900 dark:text-white">Atok.ai</span>
          </div>

          <div className="bg-white dark:bg-neutral-800 rounded-2xl shadow-xl p-8 border border-neutral-200 dark:border-neutral-700">
            <div className="mb-8">
              <h1 className="text-3xl font-bold text-neutral-900 dark:text-white mb-2">
                Sign In
              </h1>
              <p className="text-neutral-600 dark:text-neutral-400">
                Enter your credentials to access your account
              </p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-5">
              {error && (
                <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-red-600 dark:text-red-400 text-sm">
                  {error}
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="email" className="text-neutral-700 dark:text-neutral-300">
                  Email or Username
                </Label>
                <Input
                  id="email"
                  type="text"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="Enter your email or username"
                  required
                  disabled={loading}
                  className="h-12 bg-neutral-50 dark:bg-neutral-900 border-neutral-300 dark:border-neutral-600 focus:border-neutral-900 dark:focus:border-white"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="password" className="text-neutral-700 dark:text-neutral-300">
                  Password
                </Label>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter your password"
                  required
                  disabled={loading}
                  className="h-12 bg-neutral-50 dark:bg-neutral-900 border-neutral-300 dark:border-neutral-600 focus:border-neutral-900 dark:focus:border-white"
                />
              </div>

              <Button
                type="submit"
                disabled={loading}
                className="w-full h-12 bg-neutral-900 hover:bg-neutral-800 dark:bg-white dark:hover:bg-neutral-200 text-white dark:text-neutral-900 font-medium text-base rounded-lg transition-all duration-200 hover:scale-[1.02]"
              >
                {loading ? (
                  "Signing in..."
                ) : (
                  <span className="flex items-center justify-center gap-2">
                    Sign In
                    <ArrowRight className="w-5 h-5" />
                  </span>
                )}
              </Button>
            </form>

            <div className="mt-6 text-center">
              <p className="text-neutral-600 dark:text-neutral-400 text-sm">
                Don't have an account?{" "}
                <button
                  onClick={onSwitchToSignup}
                  className="text-neutral-900 dark:text-white font-semibold hover:underline"
                >
                  Sign Up
                </button>
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
