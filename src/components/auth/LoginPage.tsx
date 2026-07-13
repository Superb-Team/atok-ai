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
    <div className="flex min-h-screen bg-background">
      {/* Brand panel: always ink-dark, independent of the app theme. */}
      <div className="relative hidden flex-col justify-between overflow-hidden bg-[oklch(0.19_0.0095_55)] p-12 lg:flex lg:w-[44%]">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.05]"
          style={{
            backgroundImage: `radial-gradient(circle at 1px 1px, white 1px, transparent 0)`,
            backgroundSize: "28px 28px",
          }}
        />

        <div className="relative flex items-center gap-3">
          <img src="/logo-atok.png" alt="Atok.ai" className="h-9 w-9 rounded-lg" />
          <span className="font-display text-lg font-semibold text-[oklch(0.93_0.0075_78)]">
            Atok.ai
          </span>
        </div>

        <div className="relative">
          <h2 className="font-display text-[2.6rem] font-semibold leading-[1.12] tracking-tight text-[oklch(0.93_0.0075_78)]">
            Speak it once.
            <br />
            Keep it <span className="text-[oklch(0.7050_0.1280_48)]">forever.</span>
          </h2>
          <p className="mt-5 max-w-sm text-[15px] leading-7 text-[oklch(0.72_0.009_65)]">
            Atok records, transcribes, and turns your voice into notes you can search, tag, and ask questions about.
          </p>
        </div>

        <p className="relative font-mono text-xs text-[oklch(0.55_0.009_60)]">
          © 2025 Atok.ai
        </p>
      </div>

      {/* Form */}
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="w-full max-w-sm">
          <div className="mb-10 flex items-center gap-3 lg:hidden">
            <img src="/logo-atok.png" alt="Atok.ai" className="h-9 w-9 rounded-lg" />
            <span className="font-display text-lg font-semibold text-foreground">Atok.ai</span>
          </div>

          <h1 className="font-display text-[1.7rem] font-semibold tracking-tight text-foreground">
            Welcome back
          </h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Sign in to open your workspace.
          </p>

          <form onSubmit={handleSubmit} className="mt-8 space-y-5">
            {error && (
              <div className="rounded-lg border border-destructive/25 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                {error}
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="email">Email or username</Label>
              <Input
                id="email"
                type="text"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
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
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Your password"
                required
                disabled={loading}
                className="h-11"
              />
            </div>

            <Button
              type="submit"
              disabled={loading}
              className="h-11 w-full text-[15px] font-medium active:scale-[0.99]"
            >
              {loading ? (
                "Signing in…"
              ) : (
                <span className="flex items-center justify-center gap-2">
                  Sign in
                  <ArrowRight className="h-4 w-4" />
                </span>
              )}
            </Button>
          </form>

          <p className="mt-8 text-sm text-muted-foreground">
            No account yet?{" "}
            <button
              onClick={onSwitchToSignup}
              className="font-medium text-primary hover:underline"
            >
              Create one
            </button>
          </p>
        </div>
      </div>
    </div>
  );
}
