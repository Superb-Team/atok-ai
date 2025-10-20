import { invoke } from "@tauri-apps/api/core";
import type { AuthResponse, LoginCredentials, RegisterData, User } from "@/types/auth.types";

export const authService = {
  async register(data: RegisterData): Promise<AuthResponse> {
    try {
      const response = await invoke<AuthResponse>("register", { request: data });
      return response;
    } catch (error) {
      throw new Error(error as string);
    }
  },

  async login(credentials: LoginCredentials): Promise<AuthResponse> {
    try {
      const response = await invoke<AuthResponse>("login", { request: credentials });
      return response;
    } catch (error) {
      throw new Error(error as string);
    }
  },

  async getCurrentUser(token: string): Promise<User> {
    try {
      const response = await invoke<User>("get_current_user", { token });
      return response;
    } catch (error) {
      throw new Error(error as string);
    }
  },

  // Local storage helpers
  saveToken(token: string): void {
    localStorage.setItem("auth_token", token);
  },

  getToken(): string | null {
    return localStorage.getItem("auth_token");
  },

  removeToken(): void {
    localStorage.removeItem("auth_token");
  },

  saveUser(user: User): void {
    localStorage.setItem("user", JSON.stringify(user));
  },

  getUser(): User | null {
    const userStr = localStorage.getItem("user");
    return userStr ? JSON.parse(userStr) : null;
  },

  removeUser(): void {
    localStorage.removeItem("user");
  },

  logout(): void {
    this.removeToken();
    this.removeUser();
  },
};
