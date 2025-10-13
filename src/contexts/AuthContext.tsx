import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  ReactNode,
} from "react";
import {
  authService,
  User,
  saveToken,
  getToken,
  saveUser,
  getUser,
  logout as logoutService,
} from "@/services/auth.service";

interface AuthContextType {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (name: string, email: string, password: string) => Promise<void>;
  logout: () => void;
  checkAuth: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextType | undefined>(
  undefined
);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
};

interface AuthProviderProps {
  children: ReactNode;
}

export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const isAuthenticated = !!user && !!token;

  // Check authentication on mount
  useEffect(() => {
    checkAuth();
  }, []);

  const checkAuth = async () => {
    setIsLoading(true);
    try {
      const savedToken = getToken();
      const savedUser = getUser();

      console.log("CheckAuth - Token:", savedToken ? "exists" : "null");
      console.log("CheckAuth - User:", savedUser);

      if (savedToken && savedUser) {
        // Verify token is still valid by calling getCurrentUser
        try {
          console.log("Validating token...");
          const userData = await authService.getCurrentUser(savedToken);
          console.log("Token valid, user data:", userData);
          setToken(savedToken);
          setUser(userData);
        } catch (error) {
          // Token is invalid, clear storage
          console.error("Token validation failed:", error);
          logoutService();
          setToken(null);
          setUser(null);
        }
      }
    } catch (error) {
      console.error("Auth check failed:", error);
      logoutService();
      setToken(null);
      setUser(null);
    } finally {
      setIsLoading(false);
    }
  };

  const login = async (email: string, password: string) => {
    try {
      const response = await authService.login(email, password);

      // Save to localStorage
      saveToken(response.token);
      saveUser(response.user);

      // Update state
      setToken(response.token);
      setUser(response.user);
    } catch (error) {
      throw error;
    }
  };

  const register = async (name: string, email: string, password: string) => {
    try {
      const response = await authService.register(name, email, password);

      // Save to localStorage
      saveToken(response.token);
      saveUser(response.user);

      // Update state
      setToken(response.token);
      setUser(response.user);
    } catch (error) {
      throw error;
    }
  };

  const logout = () => {
    logoutService();
    setToken(null);
    setUser(null);
  };

  const value = {
    user,
    token,
    isAuthenticated,
    isLoading,
    login,
    register,
    logout,
    checkAuth,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
