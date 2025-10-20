import React, { useState, useEffect } from 'react';
import { mcpService, McpAuthConnection } from '@/services/mcp.service';
import { authService } from '@/services/auth.service';
import { Github, Plug, Trash2, CheckCircle, XCircle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';

const ExtensionsPage: React.FC = () => {
  const [connections, setConnections] = useState<McpAuthConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [githubToken, setGithubToken] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    loadConnections();
  }, []);

  const loadConnections = async () => {
    try {
      setLoading(true);
      const user = authService.getCurrentUserData();
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

      const user = authService.getCurrentUserData();
      if (!user) {
        setError('User not authenticated');
        return;
      }

      await mcpService.connectGitHub(user.id, githubToken);
      setSuccess('GitHub connected successfully!');
      setGithubToken('');
      await loadConnections();
    } catch (err: any) {
      console.error('Failed to connect GitHub:', err);
      setError(err.message || 'Failed to connect GitHub');
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = async (provider: string) => {
    if (!confirm(`Are you sure you want to disconnect ${provider}?`)) {
      return;
    }

    try {
      const user = authService.getCurrentUserData();
      if (!user) {
        setError('User not authenticated');
        return;
      }

      await mcpService.disconnect(user.id, provider);
      setSuccess(`${provider} disconnected successfully`);
      await loadConnections();
    } catch (err: any) {
      console.error(`Failed to disconnect ${provider}:`, err);
      setError(err.message || `Failed to disconnect ${provider}`);
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
      <div className="flex-1 flex items-center justify-center bg-white dark:bg-neutral-900">
        <Loader2 className="w-8 h-8 animate-spin text-neutral-600 dark:text-neutral-400" />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto bg-white dark:bg-neutral-900">
      <div className="max-w-4xl mx-auto p-8">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-neutral-900 dark:text-white mb-2">
            Extensions
          </h1>
          <p className="text-neutral-600 dark:text-neutral-400">
            Connect external services to enhance your workflow
          </p>
        </div>

        {/* Alerts */}
        {error && (
          <Alert variant="destructive" className="mb-6">
            <XCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {success && (
          <Alert className="mb-6 border-green-500 bg-green-50 dark:bg-green-950">
            <CheckCircle className="h-4 w-4 text-green-600 dark:text-green-400" />
            <AlertDescription className="text-green-600 dark:text-green-400">
              {success}
            </AlertDescription>
          </Alert>
        )}

        {/* Connected Services */}
        {connections.length > 0 && (
          <div className="mb-8">
            <h2 className="text-xl font-semibold text-neutral-900 dark:text-white mb-4">
              Connected Services
            </h2>
            <div className="space-y-3">
              {connections.map((conn) => (
                <Card key={conn.id} className="dark:bg-neutral-800 dark:border-neutral-700">
                  <CardContent className="flex items-center justify-between p-4">
                    <div className="flex items-center gap-3">
                      <div className="p-2 rounded-lg bg-neutral-100 dark:bg-neutral-700">
                        {getProviderIcon(conn.provider)}
                      </div>
                      <div>
                        <p className="font-medium text-neutral-900 dark:text-white capitalize">
                          {conn.provider}
                        </p>
                        <p className="text-sm text-neutral-600 dark:text-neutral-400">
                          @{conn.provider_username || conn.provider_user_id}
                        </p>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDisconnect(conn.provider)}
                      className="text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950"
                    >
                      <Trash2 className="w-4 h-4 mr-2" />
                      Disconnect
                    </Button>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        )}

        {/* Available Services */}
        <div>
          <h2 className="text-xl font-semibold text-neutral-900 dark:text-white mb-4">
            Available Services
          </h2>
          <div className="space-y-4">
            {/* GitHub */}
            <Card className="dark:bg-neutral-800 dark:border-neutral-700">
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-neutral-100 dark:bg-neutral-700">
                    <Github className="w-6 h-6" />
                  </div>
                  <div>
                    <CardTitle className="text-lg">GitHub</CardTitle>
                    <CardDescription>
                      Connect your GitHub account to access repositories and code
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                {isGitHubConnected ? (
                  <div className="flex items-center gap-2 text-green-600 dark:text-green-400">
                    <CheckCircle className="w-4 h-4" />
                    <span className="text-sm font-medium">Connected</span>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <Input
                      type="password"
                      placeholder="Enter GitHub Personal Access Token"
                      value={githubToken}
                      onChange={(e) => setGithubToken(e.target.value)}
                      className="dark:bg-neutral-700 dark:border-neutral-600"
                    />
                    <div className="flex items-start gap-2">
                      <Button
                        onClick={handleConnectGitHub}
                        disabled={connecting || !githubToken.trim()}
                        className="bg-neutral-900 hover:bg-neutral-800 dark:bg-white dark:hover:bg-neutral-200 dark:text-neutral-900"
                      >
                        {connecting ? (
                          <>
                            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                            Connecting...
                          </>
                        ) : (
                          'Connect GitHub'
                        )}
                      </Button>
                      <a
                        href="https://github.com/settings/tokens/new?scopes=repo,user"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-blue-600 dark:text-blue-400 hover:underline mt-2"
                      >
                        Get a token →
                      </a>
                    </div>
                    <p className="text-xs text-neutral-500 dark:text-neutral-400">
                      Required scopes: <code className="bg-neutral-100 dark:bg-neutral-700 px-1 py-0.5 rounded">repo</code>, <code className="bg-neutral-100 dark:bg-neutral-700 px-1 py-0.5 rounded">user</code>
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* More services can be added here */}
          </div>
        </div>
      </div>
    </div>
  );
};

export default ExtensionsPage;
