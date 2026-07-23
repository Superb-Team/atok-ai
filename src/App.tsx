import ExtensionsPage from "@/components/ExtensionsPage";
import TasksPage from "@/components/TasksPage";
import HomePage from "@/components/HomePage";
import NoteViewPage from "@/components/NoteViewPage";
import SettingsPage from "@/components/SettingsPage";
import CreateNoteDialog from "@/components/CreateNoteDialog";
import ImportAudioDialog from "@/components/ImportAudioDialog";
import LoginPage from "@/components/auth/LoginPage";
import SignUpPage from "@/components/auth/SignUpPage";
import FloatingActionMenu from "@/components/ui/floating-action-menu";
import { AppSidebar, type SidebarItem } from "@/components/ui/sidebar";
import { applyTheme, watchSystemTheme } from "@/lib/theme";
import AIChatInterface from "@/searchAI/page";
import { agentService } from "@/services/agent.service";
import { authService } from "@/services/auth.service";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { invoke } from "@tauri-apps/api/core";
import {
  CheckSquare,
  Eye,
  FileText,
  Home,
  LogOut,
  Puzzle,
  Settings,
  Sparkle,
  Upload,
} from "lucide-react";
import { useState, useEffect } from "react";
import "./App.css";

function App() {
  const [currentPage, setCurrentPage] = useState("home");
  const [selectedNoteId, setSelectedNoteId] = useState<number | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [authView, setAuthView] = useState<"login" | "signup">("login");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    applyTheme();
    const unwatchTheme = watchSystemTheme();
    checkAuth();
    // The backend AEC_ENABLED static defaults to ON every launch; push the user's
    // persisted preference back into it so a disabled setting survives restarts.
    const persistedAec = localStorage.getItem('aec_enabled');
    if (persistedAec !== null) {
      invoke('set_aec_enabled', { enabled: persistedAec === 'true' }).catch(() => {});
    }
    return unwatchTheme;
  }, []);

  const checkAuth = async () => {
    const token = authService.getToken();
    if (token) {
      try {
        await authService.getCurrentUser(token);
        setIsAuthenticated(true);

        const user = authService.getUser();
        if (user) {
          agentService.ensureCollection(user.id).catch(err => {
            console.error("Failed to ensure collection:", err);
          });
        }
      } catch (error) {
        authService.logout();
        setIsAuthenticated(false);
      }
    }
    setLoading(false);
  };

  const [createNoteOpen, setCreateNoteOpen] = useState(false);
  const [importAudioOpen, setImportAudioOpen] = useState(false);
  const [refreshNotes, setRefreshNotes] = useState(0);

  const handleLoginSuccess = async () => {
    setIsAuthenticated(true);
    setCurrentPage("home");

    const user = authService.getUser();
    if (user) {
      agentService.ensureCollection(user.id).catch(() => {});
    }
  };

  const handleLogout = () => {
    authService.logout();
    setIsAuthenticated(false);
    setCurrentPage("home");
  };

  const handleOpenPopup = async () => {
    try {
      const existing = await WebviewWindow.getByLabel('recording-popup');
      if (existing) {
        await existing.show();
        await existing.setFocus();
        return;
      }

      const webview = new WebviewWindow('recording-popup', {
        url: 'recording-popup.html',
        title: 'Atok.ai Recording Studio',
        width: 1040,
        height: 88,
        x: 100,
        y: 50,
        minWidth: 920,
        minHeight: 88,
        maxWidth: 1120,
        maxHeight: 88,
        center: false,
        resizable: false,
        decorations: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        transparent: true,
        shadow: false,
        visible: false,
        dragDropEnabled: false,
      });

      webview.once('tauri://created', async () => {
        await webview.show();
        await webview.setFocus();
      });
      webview.once('tauri://error', (e) => {
        console.error('Failed to create recording popup:', e);
      });
    } catch (error) {
      console.error('Failed to create recording popup:', error);
    }
  };

  const handleCreateNote = () => {
    setCreateNoteOpen(true);
  };

  const handleImportAudio = () => {
    setImportAudioOpen(true);
  };

  const handleNoteCreated = () => {
    setRefreshNotes(prev => prev + 1);
  };

  // Navigating from the sidebar always leaves an open note; otherwise the
  // note view keeps covering every page.
  const navigate = (page: string) => {
    setSelectedNoteId(null);
    setCurrentPage(page);
  };

  if (loading) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 bg-background">
        <img src="/logo-atok.png" alt="Atok.ai" className="h-12 w-12 rounded-xl" />
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
          Opening your workspace
        </div>
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

  const links: SidebarItem[] = [
    { key: "home", label: "Notes", icon: Home, onClick: () => navigate("home") },
    { key: "search", label: "Agents", icon: Sparkle, onClick: () => navigate("search") },
    { key: "extensions", label: "Extensions", icon: Puzzle, onClick: () => navigate("extensions") },
    { key: "tasks", label: "Tasks", icon: CheckSquare, onClick: () => navigate("tasks") },
  ];

  const bottomLinks: SidebarItem[] = [
    { key: "settings", label: "Settings", icon: Settings, onClick: () => navigate("settings") },
    { key: "logout", label: "Log out", icon: LogOut, onClick: handleLogout },
  ];

  const floatingMenuOptions = [
    {
      label: "Open pop-up view",
      Icon: <Eye className="w-4 h-4" />,
      onClick: handleOpenPopup,
    },
    {
      label: "Create note",
      Icon: <FileText className="w-4 h-4" />,
      onClick: handleCreateNote,
    },
    {
      label: "Import audio",
      Icon: <Upload className="w-4 h-4" />,
      onClick: handleImportAudio,
    },
  ];

  const user = authService.getUser();

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background">
      <AppSidebar
        items={links}
        bottomItems={bottomLinks}
        activeKey={currentPage}
        footer={
          user ? (
            <div className="flex items-center gap-2.5">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/12 font-display text-[13px] font-semibold text-primary">
                {(user.full_name || user.username || "?").charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0 leading-tight">
                <p className="truncate text-[12.5px] font-medium text-sidebar-foreground">
                  {user.full_name || user.username}
                </p>
                <p className="truncate font-mono text-[10.5px] text-sidebar-foreground/45">
                  @{user.username}
                </p>
              </div>
            </div>
          ) : undefined
        }
      />

      {/* Main content area, one page at a time. */}
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

      <FloatingActionMenu options={floatingMenuOptions} />

      <CreateNoteDialog
        open={createNoteOpen}
        onOpenChange={setCreateNoteOpen}
        onNoteCreated={handleNoteCreated}
      />

      <ImportAudioDialog open={importAudioOpen} onOpenChange={setImportAudioOpen} />
    </div>
  );
}

export default App;
