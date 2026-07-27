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
    <div className="flex min-h-screen bg-background">
      <div className="relative hidden flex-col justify-between overflow-hidden border-r border-white/10 bg-black p-14 lg:flex lg:w-[46%]">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.05]"
          style={{
            backgroundImage: `linear-gradient(rgba(255,255,255,.55) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.55) 1px, transparent 1px)`,
            backgroundSize: "64px 64px",
          }}
        />

        <div className="relative flex items-center gap-3">
          <img src="/logo-atok.png" alt="Atok.ai" className="h-8 w-8 rounded-md invert" />
          <span className="font-display text-lg font-semibold text-[oklch(0.93_0.0075_78)]">
            Atok.ai
          </span>
        </div>

        <div className="relative">
          <p className="mb-5 font-mono text-[10px] uppercase tracking-[.24em] text-white/40">A quieter place for ideas</p>
          <h2 className="font-display text-[3.15rem] font-medium leading-[1.02] tracking-[-.055em] text-white">
            Think out loud.
            <br />
            Find it instantly.
          </h2>
          <p className="mt-7 max-w-sm text-[15px] leading-7 text-white/50">
            Record meetings and ideas, get clean transcripts, and let the agent answer from everything you keep here.
          </p>
        </div>

        <p className="relative font-mono text-xs text-[oklch(0.55_0.009_60)]">
          ATOK / 2026
        </p>
      </div>

      {/* Form */}
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="w-full max-w-[380px]">
          <div className="mb-10 flex items-center gap-3 lg:hidden">
            <img src="/logo-atok.png" alt="Atok.ai" className="h-9 w-9 rounded-lg" />
            <span className="font-display text-lg font-semibold text-foreground">Atok.ai</span>
          </div>

          <p className="mb-4 font-mono text-[10px] uppercase tracking-[.2em] text-muted-foreground">New workspace</p>
          <h1 className="font-display text-[2rem] font-semibold tracking-[-.04em] text-foreground">
            Create your account
          </h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            A minute of setup, then everything is yours.
          </p>

          <form onSubmit={handleSubmit} className="mt-8 space-y-4">
            {error && (
              <div className="rounded-lg border border-destructive/25 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                {error}
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="fullName">Full name <span className="font-normal text-muted-foreground">(optional)</span></Label>
              <Input
                id="fullName"
                type="text"
                value={formData.fullName}
                onChange={(e) => handleChange("fullName", e.target.value)}
                placeholder="Your name"
                disabled={loading}
                className="h-11"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="username">Username</Label>
              <Input
                id="username"
                type="text"
                value={formData.username}
                onChange={(e) => handleChange("username", e.target.value)}
                placeholder="Pick a username"
                required
                disabled={loading}
                className="h-11"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={formData.email}
                onChange={(e) => handleChange("email", e.target.value)}
                placeholder="you@example.com"
                required
                disabled={loading}
                className="h-11"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                value={formData.password}
                onChange={(e) => handleChange("password", e.target.value)}
                placeholder="Create a password"
                required
                disabled={loading}
                className="h-11"
              />
            </div>

            <Button
              type="submit"
              disabled={loading}
              className="mt-2 h-11 w-full text-[15px] font-medium active:scale-[0.99]"
            >
              {loading ? (
                "Creating account…"
              ) : (
                <span className="flex items-center justify-center gap-2">
                  Create account
                  <ArrowRight className="h-4 w-4" />
                </span>
              )}
            </Button>
          </form>

          <p className="mt-8 text-sm text-muted-foreground">
            Already have an account?{" "}
            <button
              onClick={onSwitchToLogin}
              className="font-medium text-primary hover:underline"
            >
              Sign in
            </button>
          </p>
        </div>
      </div>
    </div>
  );
}
