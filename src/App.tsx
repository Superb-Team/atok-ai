import ExtensionsPage from "@/components/ExtensionsPage";
import TasksPage from "@/components/TasksPage";
import HomePage from "@/components/HomePage";
import NoteViewPage from "@/components/NoteViewPage";
import SettingsPage from "@/components/SettingsPage";
import CreateNoteDialog from "@/components/CreateNoteDialog";
import LoginPage from "@/components/auth/LoginPage";
import SignUpPage from "@/components/auth/SignUpPage";
import FloatingActionMenu from "@/components/ui/floating-action-menu";
import { Sidebar, SidebarBody, SidebarLink } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import AIChatInterface from "@/searchAI/page";
import { authService } from "@/services/auth.service";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { motion } from "framer-motion";
import {
  CheckSquare,
  Eye,
  FileText,
  Home,
  LogOut,
  Puzzle,
  Settings,
  Sparkle,
} from "lucide-react";
import { useState, useEffect } from "react";
import "./App.css";

function App() {
  const [open, setOpen] = useState(false);
  const [currentPage, setCurrentPage] = useState("home");
  const [selectedNoteId, setSelectedNoteId] = useState<number | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [authView, setAuthView] = useState<"login" | "signup">("login");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Set dark mode by default
    document.documentElement.classList.add('dark');
    checkAuth();
  }, []);

  const checkAuth = async () => {
    const token = authService.getToken();
    if (token) {
      try {
        await authService.getCurrentUser(token);
        setIsAuthenticated(true);

        // Ensure OpenSearch collection exists for user
        const user = authService.getUser();
        if (user) {
          import("@/services/agent.service").then(({ agentService }) => {
            agentService.ensureCollection(user.id).catch(err => {
              console.error("Failed to ensure collection:", err);
            });
          });
        }
      } catch (error) {
        console.error("Auth check failed:", error);
        authService.logout();
        setIsAuthenticated(false);
      }
    }
    setLoading(false);
  };

  const [createNoteOpen, setCreateNoteOpen] = useState(false);
  const [refreshNotes, setRefreshNotes] = useState(0);

  const handleLoginSuccess = async () => {
    console.log("Login success, checking auth...");
    setIsAuthenticated(true);
    setCurrentPage("home");

    // Ensure OpenSearch collection exists for user
    const user = authService.getUser();
    if (user) {
      // Import agent service dynamically to avoid circular dependency
      import("@/services/agent.service").then(({ agentService }) => {
        agentService.ensureCollection(user.id).catch(err => {
          console.error("Failed to ensure collection:", err);
        });
      });
    }
  };

  const handleLogout = () => {
    authService.logout();
    setIsAuthenticated(false);
    setCurrentPage("home");
  };

  const handleOpenPopup = async () => {
    console.log("Opening recording popup window...");
    try {
      // Check if WebviewWindow is available
      console.log("WebviewWindow available:", !!WebviewWindow);

      const webview = new WebviewWindow('recording-popup', {
        url: 'recording-popup.html',
        title: 'Atok.ai Recording Studio',
        width: 750,
        height: 85,
        x: 100, // Will be adjusted to center via JavaScript
        y: 50, // Position in upper part of screen
        minWidth: 700,
        minHeight: 80,
        maxWidth: 900,
        maxHeight: 100,
        center: false, // We'll position it manually
        resizable: false,
        decorations: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        transparent: true,
        shadow: false,
        dragDropEnabled: false, // Important: disable drag-drop to enable window dragging
      });

      console.log("WebviewWindow created:", webview);

      // Listen for window events
      webview.once('tauri://created', () => {
        console.log('Recording popup window created');
      });

      webview.once('tauri://error', (e) => {
        console.error('Error creating recording popup window:', e);
      });
    } catch (error) {
      console.error('Failed to create recording popup window:', error);
    }
  };

  const handleCreateNote = () => {
    setCreateNoteOpen(true);
  };

  const handleNoteCreated = () => {
    // Trigger refresh by incrementing counter
    setRefreshNotes(prev => prev + 1);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-100 dark:bg-neutral-900">
        <p className="text-neutral-600 dark:text-neutral-400">Loading...</p>
      </div>
    );
  }

  if (!isAuthenticated) {
    if (authView === "signup") {
      return (
        <SignUpPage
          onSignupSuccess={handleLoginSuccess}
          onSwitchToLogin={() => setAuthView("login")}
        />
      );
    }
    return (
      <LoginPage
        onLoginSuccess={handleLoginSuccess}
        onSwitchToSignup={() => setAuthView("signup")}
      />
    );
  }

  const links = [
    {
      label: "Home",
      href: "#",
      icon: (
        <Home className="text-neutral-700 dark:text-neutral-200 h-5 w-5 flex-shrink-0" />
      ),
      onClick: () => setCurrentPage("home"),
    },
    {
      label: "Agents",
      href: "#",
      icon: (
        <Sparkle className="text-neutral-700 dark:text-neutral-200 h-5 w-5 flex-shrink-0" />
      ),
      onClick: () => setCurrentPage("search"),
    },
    {
      label: "Extensions",
      href: "#",
      icon: (
        <Puzzle className="text-neutral-700 dark:text-neutral-200 h-5 w-5 flex-shrink-0" />
      ),
      onClick: () => setCurrentPage("extensions"),
    },
    {
      label: "Tasks",
      href: "#",
      icon: (
        <CheckSquare className="text-neutral-700 dark:text-neutral-200 h-5 w-5 flex-shrink-0" />
      ),
      onClick: () => setCurrentPage("tasks"),
    },
  ];

  const bottomLinks = [
    {
      label: "Settings",
      href: "#",
      icon: (
        <Settings className="text-neutral-700 dark:text-neutral-200 h-5 w-5 flex-shrink-0" />
      ),
      onClick: () => setCurrentPage("settings"),
    },
    {
      label: "Logout",
      href: "#",
      icon: (
        <LogOut className="text-neutral-700 dark:text-neutral-200 h-5 w-5 flex-shrink-0" />
      ),
      onClick: handleLogout,
    },
  ];

  const floatingMenuOptions = [
    {
      label: "Open pop-up view",
      Icon: <Eye className="w-4 h-4" />,
      onClick: handleOpenPopup,
    },
    {
      label: "Create Note",
      Icon: <FileText className="w-4 h-4" />,
      onClick: handleCreateNote,
    },
  ];

  return (
    <div className={cn(
      "flex flex-col md:flex-row bg-gray-100 dark:bg-neutral-800 w-full h-screen overflow-hidden"
    )}>
      <Sidebar open={open} setOpen={setOpen}>
        <SidebarBody className="justify-between gap-10">
          <div className="flex flex-col flex-1 overflow-y-auto overflow-x-hidden">
            {open ? <Logo /> : <LogoIcon />}
            <div className="mt-8 flex flex-col gap-2">
              {links.map((link, idx) => (
                <SidebarLink
                  key={idx}
                  link={link}
                  onClick={link.onClick}
                />
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-2">
            {bottomLinks.map((link, idx) => (
              <SidebarLink
                key={idx}
                link={link}
                onClick={link.onClick}
              />
            ))}
          </div>
        </SidebarBody>
      </Sidebar>

      {/* Main Content Area - Show different pages based on currentPage state */}
      {selectedNoteId ? (
        <NoteViewPage
          noteId={selectedNoteId}
          onBack={() => {
            setSelectedNoteId(null);
            setRefreshNotes(prev => prev + 1);
          }}
        />
      ) : currentPage === "settings" ? (
        <SettingsPage />
      ) : currentPage === "tasks" ? (
        <TasksPage />
      ) : currentPage === "extensions" ? (
        <ExtensionsPage />
      ) : currentPage === "search" ? (
        <AIChatInterface />
      ) : (
        <HomePage key={refreshNotes} onNoteClick={(noteId) => setSelectedNoteId(noteId)} />
      )}

      {/* Floating Action Menu */}
      <FloatingActionMenu options={floatingMenuOptions} />

      {/* Create Note Dialog */}
      <CreateNoteDialog
        open={createNoteOpen}
        onOpenChange={setCreateNoteOpen}
        onNoteCreated={handleNoteCreated}
      />
    </div>
  );
}

const Logo = () => {
  return (
    <a
      href="#"
      className="font-normal flex space-x-2 items-center text-sm text-black py-1 relative z-20"
    >
      <img src="/logo-atok.png" alt="Atok.ai" className="h-8 w-8 flex-shrink-0 rounded-lg" />
      <motion.span
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="font-medium text-black dark:text-white whitespace-pre"
      >
        Atok.ai
      </motion.span>
    </a>
  );
};

const LogoIcon = () => {
  return (
    <a
      href="#"
      className="font-normal flex space-x-2 items-center text-sm text-black py-1 relative z-20"
    >
      <img src="/logo-atok.png" alt="Atok.ai" className="h-8 w-8 flex-shrink-0 rounded-lg" />
    </a>
  );
};

export default App;
