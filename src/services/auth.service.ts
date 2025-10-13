import { invoke } from "@tauri-apps/api/core";

// ==================== Types ====================

export interface User {
  id: string;
  email: string;
  name: string;
  is_verified: boolean;
  is_active: boolean;
}

export interface AuthResponse {
  token: string;
  user: User;
}

export interface MessageResponse {
  message: string;
}

// ==================== Tauri Invoke Auth Service ====================

export const authService = {
  // Register new user
  async register(
    name: string,
    email: string,
    password: string
  ): Promise<AuthResponse> {
    try {
      const response = await invoke<AuthResponse>("register", {
        request: { name, email, password },
      });
      return response;
    } catch (error) {
      throw new Error(error as string);
    }
  },

  // Login user
  async login(email: string, password: string): Promise<AuthResponse> {
    try {
      const response = await invoke<AuthResponse>("login", {
        request: { email, password },
      });
      return response;
    } catch (error) {
      throw new Error(error as string);
    }
  },

  // Forgot password
  async forgotPassword(email: string): Promise<MessageResponse> {
    try {
      const response = await invoke<MessageResponse>("forgot_password", {
        request: { email },
      });
      return response;
    } catch (error) {
      throw new Error(error as string);
    }
  },

  // Reset password
  async resetPassword(
    token: string,
    password: string
  ): Promise<MessageResponse> {
    try {
      const response = await invoke<MessageResponse>("reset_password", {
        request: { token, password },
      });
      return response;
    } catch (error) {
      throw new Error(error as string);
    }
  },

  // Get current user
  async getCurrentUser(token: string): Promise<User> {
    try {
      const response = await invoke<User>("get_current_user", {
        token,
      });
      return response;
    } catch (error) {
      throw new Error(error as string);
    }
  },
};

// ==================== LocalStorage Helpers ====================

export const saveToken = (token: string) => {
  localStorage.setItem("token", token);
};

export const getToken = (): string | null => {
  return localStorage.getItem("token");
};

export const removeToken = () => {
  localStorage.removeItem("token");
};

export const saveUser = (user: User) => {
  localStorage.setItem("user", JSON.stringify(user));
};

export const getUser = (): User | null => {
  const user = localStorage.getItem("user");
  return user ? JSON.parse(user) : null;
};

export const removeUser = () => {
  localStorage.removeItem("user");
};

export const logout = () => {
  removeToken();
  removeUser();
};
