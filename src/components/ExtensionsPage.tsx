import React, { useState, useEffect } from 'react';
import { mcpService, McpAuthConnection } from '@/services/mcp.service';
import { authService } from '@/services/auth.service';
import { Github, Plug, Trash2, CheckCircle, XCircle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

const ExtensionsPage: React.FC = () => {
  const [connections, setConnections] = useState<McpAuthConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [githubToken, setGithubToken] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [disconnectProvider, setDisconnectProvider] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);

  useEffect(() => {
    loadConnections();
  }, []);

  const loadConnections = async () => {
    try {
      setLoading(true);
      const user = authService.getUser();
      if (!user) {
        setError('User not authenticated');
        return;
      }

      const conns = await mcpService.getConnections(user.id);
      setConnections(conns);
    } catch (err) {
      console.error('Failed to load connections:', err);
      setError('Failed to load connections');
    } finally {
      setLoading(false);
    }
  };

  const handleConnectGitHub = async () => {
    if (!githubToken.trim()) {
      setError('Please enter a GitHub token');
      return;
    }

    try {
      setConnecting(true);
      setError(null);
      setSuccess(null);

      const user = authService.getUser();
      if (!user) {
        setError('User not authenticated');
        return;
      }

      await mcpService.connectGitHub(user.id, githubToken);
      setSuccess('GitHub connected.');
      setGithubToken('');
      await loadConnections();
    } catch (err: any) {
      console.error('Failed to connect GitHub:', err);
      setError(err.message || 'Failed to connect GitHub');
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = (provider: string) => {
    if (disconnecting) return;
    setDisconnectProvider(provider);
  };

  const confirmDisconnect = async () => {
    if (!disconnectProvider) return;
    const provider = disconnectProvider;
    setDisconnecting(true);
    try {
      const user = authService.getUser();
      if (!user) {
        setError('User not authenticated');
        setDisconnecting(false);
        return;
      }

      await mcpService.disconnect(user.id, provider);
      setSuccess(`${provider} disconnected.`);
      await loadConnections();
    } catch (err: any) {
      console.error(`Failed to disconnect ${provider}:`, err);
      setError(err.message || `Failed to disconnect ${provider}`);
    } finally {
      setDisconnecting(false);
    }
  };

  const getProviderIcon = (provider: string) => {
    switch (provider.toLowerCase()) {
      case 'github':
        return <Github className="w-5 h-5" />;
      default:
        return <Plug className="w-5 h-5" />;
    }
  };

  const isGitHubConnected = connections.some(c => c.provider === 'github');

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <>
      <ConfirmDialog
        open={disconnectProvider !== null}
        onOpenChange={(open) => {
          if (!open && !disconnecting) setDisconnectProvider(null);
        }}
        title={`Disconnect ${disconnectProvider ?? ''}?`}
        description={`Are you sure you want to disconnect ${disconnectProvider ?? ''}? You'll need to re-authenticate to use it again.`}
        confirmText="Disconnect"
        cancelText="Cancel"
        variant="destructive"
        loading={disconnecting}
        onConfirm={confirmDisconnect}
      />
      <div className="h-screen flex-1 overflow-y-auto bg-background">
      <div className="max-w-3xl mx-auto px-10 pb-20 pt-9">
        {/* Header */}
        <header className="mb-10">
          <h1 className="font-display text-[2rem] font-semibold leading-tight tracking-tight text-foreground">
            Extensions
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Connect external services so the agent can reach them.
          </p>
        </header>

        {/* Alerts */}
        {error && (
          <Alert variant="destructive" className="mb-6">
            <XCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {success && (
          <Alert className="mb-6 border-primary/30 bg-primary/5">
            <CheckCircle className="h-4 w-4 text-primary" />
            <AlertDescription className="text-primary">
              {success}
            </AlertDescription>
          </Alert>
        )}

        {/* Connected Services */}
        {connections.length > 0 && (
          <div className="mb-10">
            <h2 className="font-display text-[15px] font-semibold text-foreground mb-3">
              Connected
            </h2>
            <div className="space-y-2.5">
              {connections.map((conn) => (
                <div
                  key={conn.id}
                  className="flex items-center justify-between rounded-xl border border-border bg-card px-4 py-3.5"
                >
                  <div className="flex items-center gap-3">
                    <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent text-foreground">
                      {getProviderIcon(conn.provider)}
                    </div>
                    <div className="leading-tight">
                      <p className="text-[13px] font-medium capitalize text-foreground">
                        {conn.provider}
                      </p>
                      <p className="font-mono text-xs text-muted-foreground">
                        @{conn.provider_username || conn.provider_user_id}
                      </p>
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleDisconnect(conn.provider)}
                    className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  >
                    <Trash2 className="mr-1.5 h-4 w-4" />
                    Disconnect
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Available Services */}
        <div>
          <h2 className="font-display text-[15px] font-semibold text-foreground mb-3">
            Available
          </h2>
          <div className="space-y-3">
            {/* GitHub */}
            <div className="rounded-xl border border-border bg-card p-5">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent text-foreground">
                  <Github className="h-5 w-5" />
                </div>
                <div className="leading-tight">
                  <p className="font-display text-[15px] font-semibold text-foreground">GitHub</p>
                  <p className="mt-0.5 text-[13px] text-muted-foreground">
                    Lets the agent read your repositories and code.
                  </p>
                </div>
              </div>
              <div className="mt-5">
                {isGitHubConnected ? (
                  <div className="inline-flex items-center gap-2 rounded-lg bg-primary/10 px-3 py-1.5 text-primary">
                    <CheckCircle className="h-4 w-4" />
                    <span className="text-[13px] font-medium">Connected</span>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <Input
                      type="password"
                      placeholder="GitHub personal access token"
                      value={githubToken}
                      onChange={(e) => setGithubToken(e.target.value)}
                    />
                    <div className="flex items-center gap-3">
                      <Button
                        onClick={handleConnectGitHub}
                        disabled={connecting || !githubToken.trim()}
                      >
                        {connecting ? (
                          <>
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            Connecting…
                          </>
                        ) : (
                          'Connect GitHub'
                        )}
                      </Button>
                      <a
                        href="https://github.com/settings/tokens/new?scopes=repo,user"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm font-medium text-primary hover:underline"
                      >
                        Get a token
                      </a>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Required scopes: <code className="rounded bg-accent px-1 py-0.5 font-mono text-[11px]">repo</code>, <code className="rounded bg-accent px-1 py-0.5 font-mono text-[11px]">user</code>
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
    </>
  );
};

export default ExtensionsPage;
