import { invoke } from '@tauri-apps/api/core';

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
    try {
      const connections = await invoke<McpAuthConnection[]>('get_mcp_connections', {
        userId,
      });
      return connections;
    } catch (error) {
      console.error('Failed to get MCP connections:', error);
      throw error;
    }
  }

  /**
   * Get a specific MCP connection
   */
  static async getConnection(
    userId: string,
    provider: string
  ): Promise<McpAuthConnection | null> {
    try {
      const connection = await invoke<McpAuthConnection | null>('get_mcp_connection', {
        userId,
        provider,
      });
      return connection;
    } catch (error) {
      console.error(`Failed to get ${provider} connection:`, error);
      throw error;
    }
  }

  /**
   * Create a new MCP connection
   */
  static async createConnection(
    userId: string,
    request: CreateMcpAuthRequest
  ): Promise<McpAuthConnection> {
    try {
      const connection = await invoke<McpAuthConnection>('create_mcp_connection', {
        userId,
        request,
      });
      return connection;
    } catch (error) {
      console.error('Failed to create MCP connection:', error);
      throw error;
    }
  }

  /**
   * Update an existing MCP connection
   */
  static async updateConnection(
    userId: string,
    provider: string,
    request: UpdateMcpAuthRequest
  ): Promise<McpAuthConnection> {
    try {
      const connection = await invoke<McpAuthConnection>('update_mcp_connection', {
        userId,
        provider,
        request,
      });
      return connection;
    } catch (error) {
      console.error(`Failed to update ${provider} connection:`, error);
      throw error;
    }
  }

  /**
   * Delete an MCP connection
   */
  static async deleteConnection(userId: string, provider: string): Promise<string> {
    try {
      const message = await invoke<string>('delete_mcp_connection', {
        userId,
        provider,
      });
      return message;
    } catch (error) {
      console.error(`Failed to delete ${provider} connection:`, error);
      throw error;
    }
  }

  /**
   * Test an MCP connection
   */
  static async testConnection(provider: string, accessToken: string): Promise<boolean> {
    try {
      const isValid = await invoke<boolean>('test_mcp_connection', {
        provider,
        accessToken,
      });
      return isValid;
    } catch (error) {
      console.error(`Failed to test ${provider} connection:`, error);
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
