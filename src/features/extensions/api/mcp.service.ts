import { invokeCommand } from '@/lib/ipc';

export interface McpAuthConnection {
  id: number;
  user_id: string;
  provider: string;
  provider_user_id: string;
  provider_username?: string;
  access_token: string;
  refresh_token?: string;
  token_expires_at?: string;
  provider_data?: any;
  created_at: string;
  updated_at: string;
}

export interface CreateMcpAuthRequest {
  provider: string;
  provider_user_id: string;
  provider_username?: string;
  access_token: string;
  refresh_token?: string;
  token_expires_at?: string;
  provider_data: any;
}

export interface UpdateMcpAuthRequest {
  access_token?: string;
  refresh_token?: string;
  token_expires_at?: string;
  provider_data?: any;
}

export class McpService {
  /**
   * Get all MCP connections for a user
   */
  static async getConnections(userId: string): Promise<McpAuthConnection[]> {
    const connections = await invokeCommand<McpAuthConnection[]>('get_mcp_connections', {
      userId,
    });
    return connections;
  }

  /**
   * Get a specific MCP connection
   */
  static async getConnection(
    userId: string,
    provider: string
  ): Promise<McpAuthConnection | null> {
    const connection = await invokeCommand<McpAuthConnection | null>('get_mcp_connection', {
      userId,
      provider,
    });
    return connection;
  }

  /**
   * Create a new MCP connection
   */
  static async createConnection(
    userId: string,
    request: CreateMcpAuthRequest
  ): Promise<McpAuthConnection> {
    const connection = await invokeCommand<McpAuthConnection>('create_mcp_connection', {
      userId,
      request,
    });
    return connection;
  }

  /**
   * Update an existing MCP connection
   */
  static async updateConnection(
    userId: string,
    provider: string,
    request: UpdateMcpAuthRequest
  ): Promise<McpAuthConnection> {
    const connection = await invokeCommand<McpAuthConnection>('update_mcp_connection', {
      userId,
      provider,
      request,
    });
    return connection;
  }

  /**
   * Delete an MCP connection
   */
  static async deleteConnection(userId: string, provider: string): Promise<string> {
    const message = await invokeCommand<string>('delete_mcp_connection', {
      userId,
      provider,
    });
    return message;
  }

  /**
   * Test an MCP connection
   */
  static async testConnection(provider: string, accessToken: string): Promise<boolean> {
    try {
      const isValid = await invokeCommand<boolean>('test_mcp_connection', {
        provider,
        accessToken,
      });
      return isValid;
    } catch {
      return false;
    }
  }

  /**
   * Connect to GitHub
   */
  static async connectGitHub(userId: string, accessToken: string): Promise<McpAuthConnection> {
    const isValid = await this.testConnection('github', accessToken);
    if (!isValid) {
      throw new Error('Invalid GitHub token');
    }

    const response = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': 'atok-ai',
      },
    });

    if (!response.ok) {
      throw new Error('Failed to fetch GitHub user info');
    }

    const githubUser = await response.json();

    return await this.createConnection(userId, {
      provider: 'github',
      provider_user_id: githubUser.id.toString(),
      provider_username: githubUser.login,
      access_token: accessToken,
      provider_data: {
        login: githubUser.login,
        name: githubUser.name,
        email: githubUser.email,
        avatar_url: githubUser.avatar_url,
      },
    });
  }

  /**
   * Disconnect from a provider
   */
  static async disconnect(userId: string, provider: string): Promise<void> {
    await this.deleteConnection(userId, provider);
  }
}

export const mcpService = McpService;
