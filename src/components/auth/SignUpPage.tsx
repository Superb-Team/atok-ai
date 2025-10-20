import { useState } from "react";
import { authService } from "@/services/auth.service";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ArrowRight } from "lucide-react";

interface SignupPageProps {
  onSignupSuccess: () => void;
  onSwitchToLogin: () => void;
}

export default function SignupPage({ onSignupSuccess, onSwitchToLogin }: SignupPageProps) {
  const [formData, setFormData] = useState({
    username: "",
    email: "",
    password: "",
    fullName: "",
  });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const response = await authService.register({
        username: formData.username,
        email: formData.email,
        password: formData.password,
        full_name: formData.fullName || undefined,
      });
      
      authService.saveToken(response.token);
      authService.saveUser(response.user);
      onSignupSuccess();
    } catch (err) {
      console.error("Signup error:", err);
      setError(err instanceof Error ? err.message : "Signup failed");
    } finally {
      setLoading(false);
    }
  };

  const handleChange = (field: string, value: string) => {
    setFormData(prev => ({ ...prev, [field]: value }));
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
              Start your journey with
              <br />
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-purple-400">
                intelligent productivity
              </span>
            </h2>
            <p className="text-neutral-300 text-lg">
              Join thousands of users who are transforming their workflow with AI.
            </p>
          </div>
        </div>

        <div className="relative z-10 text-neutral-400 text-sm">
          © 2024 Atok.ai. All rights reserved.
        </div>
      </div>

      {/* Right Side - Signup Form */}
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
                Create Account
              </h1>
              <p className="text-neutral-600 dark:text-neutral-400">
                Sign up to get started with Atok.ai
              </p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              {error && (
                <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-red-600 dark:text-red-400 text-sm">
                  {error}
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="fullName" className="text-neutral-700 dark:text-neutral-300">
                  Full Name (Optional)
                </Label>
                <Input
                  id="fullName"
                  type="text"
                  value={formData.fullName}
                  onChange={(e) => handleChange("fullName", e.target.value)}
                  placeholder="Enter your full name"
                  disabled={loading}
                  className="h-11 bg-neutral-50 dark:bg-neutral-900 border-neutral-300 dark:border-neutral-600 focus:border-neutral-900 dark:focus:border-white"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="username" className="text-neutral-700 dark:text-neutral-300">
                  Username *
                </Label>
                <Input
                  id="username"
                  type="text"
                  value={formData.username}
                  onChange={(e) => handleChange("username", e.target.value)}
                  placeholder="Choose a username"
                  required
                  disabled={loading}
                  className="h-11 bg-neutral-50 dark:bg-neutral-900 border-neutral-300 dark:border-neutral-600 focus:border-neutral-900 dark:focus:border-white"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="email" className="text-neutral-700 dark:text-neutral-300">
                  Email *
                </Label>
                <Input
                  id="email"
                  type="email"
                  value={formData.email}
                  onChange={(e) => handleChange("email", e.target.value)}
                  placeholder="Enter your email"
                  required
                  disabled={loading}
                  className="h-11 bg-neutral-50 dark:bg-neutral-900 border-neutral-300 dark:border-neutral-600 focus:border-neutral-900 dark:focus:border-white"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="password" className="text-neutral-700 dark:text-neutral-300">
                  Password *
                </Label>
                <Input
                  id="password"
                  type="password"
                  value={formData.password}
                  onChange={(e) => handleChange("password", e.target.value)}
                  placeholder="Create a password"
                  required
                  disabled={loading}
                  className="h-11 bg-neutral-50 dark:bg-neutral-900 border-neutral-300 dark:border-neutral-600 focus:border-neutral-900 dark:focus:border-white"
                />
              </div>

              <Button
                type="submit"
                disabled={loading}
                className="w-full h-12 bg-neutral-900 hover:bg-neutral-800 dark:bg-white dark:hover:bg-neutral-200 text-white dark:text-neutral-900 font-medium text-base rounded-lg transition-all duration-200 hover:scale-[1.02] mt-6"
              >
                {loading ? (
                  "Creating account..."
                ) : (
                  <span className="flex items-center justify-center gap-2">
                    Create Account
                    <ArrowRight className="w-5 h-5" />
                  </span>
                )}
              </Button>
            </form>

            <div className="mt-6 text-center">
              <p className="text-neutral-600 dark:text-neutral-400 text-sm">
                Already have an account?{" "}
                <button
                  onClick={onSwitchToLogin}
                  className="text-neutral-900 dark:text-white font-semibold hover:underline"
                >
                  Sign In
                </button>
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
