import FloatingActionMenu from "@/components/ui/floating-action-menu";
import { Sidebar, SidebarBody, SidebarLink } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { invoke } from "@tauri-apps/api/core";
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { motion } from "framer-motion";
import { CheckSquare, Eye, FileText, Home, LogOut, Moon, Puzzle, Sun } from "lucide-react";
import { useState } from "react";
import "./App.css";

function App() {
  const [greetMsg, setGreetMsg] = useState("");
  const [name, setName] = useState("");
  const [open, setOpen] = useState(false);
  const [darkMode, setDarkMode] = useState(false);

  async function greet() {
    // Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
    setGreetMsg(await invoke("greet", { name }));
  }

  const toggleDarkMode = () => {
    setDarkMode(!darkMode);
    document.documentElement.classList.toggle('dark');
  };

  const handleOpenPopup = async () => {
    console.log("Opening recording popup window...");
    try {
      // Check if WebviewWindow is available
      console.log("WebviewWindow available:", !!WebviewWindow);

      const webview = new WebviewWindow('recording-popup', {
        url: 'recording-popup.html',
        title: 'Atok.ai Recording Studio',
        width: 800,
        height: 80,
        x: 100, // Will be adjusted to center via JavaScript
        y: 100, // Position in upper part of screen
        minWidth: 600,
        minHeight: 70,
        maxWidth: 1000,
        maxHeight: 100,
        center: false, // We'll position it manually
        resizable: false,
        decorations: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        transparent: true,
        shadow: false,
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
    console.log("Create Note clicked");
    // TODO: Implement note creation functionality
  };

  const links = [
    {
      label: "Home",
      href: "#",
      icon: (
        <Home className="text-neutral-700 dark:text-neutral-200 h-5 w-5 flex-shrink-0" />
      ),
    },
    {
      label: "AI Search",
      href: "#",
      icon: (
        <Search className="text-neutral-700 dark:text-neutral-200 h-5 w-5 flex-shrink-0" />
      ),
    },
    {
      label: "Extensions",
      href: "#",
      icon: (
        <Puzzle className="text-neutral-700 dark:text-neutral-200 h-5 w-5 flex-shrink-0" />
      ),
    },
    {
      label: "Tasks",
      href: "#",
      icon: (
        <CheckSquare className="text-neutral-700 dark:text-neutral-200 h-5 w-5 flex-shrink-0" />
      ),
    },
  ];

  const bottomLinks = [
    {
      label: darkMode ? "Light Mode" : "Dark Mode",
      href: "#",
      icon: darkMode ? (
        <Sun className="text-neutral-700 dark:text-neutral-200 h-5 w-5 flex-shrink-0" />
      ) : (
        <Moon className="text-neutral-700 dark:text-neutral-200 h-5 w-5 flex-shrink-0" />
      ),
      onClick: toggleDarkMode,
    },
    {
      label: "Logout",
      href: "#",
      icon: (
        <LogOut className="text-neutral-700 dark:text-neutral-200 h-5 w-5 flex-shrink-0" />
      ),
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
                <SidebarLink key={idx} link={link} />
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

      <MainContent greetMsg={greetMsg} name={name} setName={setName} greet={greet} />

      {/* Floating Action Menu */}
      <FloatingActionMenu options={floatingMenuOptions} />
    </div>
  );
}

const Logo = () => {
  return (
    <a
      href="#"
      className="font-normal flex space-x-2 items-center text-sm text-black py-1 relative z-20"
    >
      <div className="h-5 w-6 bg-black dark:bg-white rounded-br-lg rounded-tr-sm rounded-tl-lg rounded-bl-sm flex-shrink-0" />
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
      <div className="h-5 w-6 bg-black dark:bg-white rounded-br-lg rounded-tr-sm rounded-tl-lg rounded-bl-sm flex-shrink-0" />
    </a>
  );
};

const MainContent = ({ greetMsg, name, setName, greet }: {
  greetMsg: string;
  name: string;
  setName: (name: string) => void;
  greet: () => void;
}) => {
  return (
    <div className="flex flex-1">
      <div className="p-8 md:p-16 rounded-tl-2xl border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 flex flex-col flex-1 w-full h-full overflow-y-auto">
        {/* Main content area with plain text about Atok.ai */}
        <div className="max-w-4xl mx-auto">
          <div className="mb-12">
            <h1 className="text-4xl font-bold text-neutral-800 dark:text-neutral-200 mb-6">
              Welcome to Atok.ai
            </h1>
            <p className="text-xl text-neutral-600 dark:text-neutral-400 mb-8">
              Your intelligent AI companion for productivity and creativity
            </p>
          </div>

          <div className="space-y-8">
            {/* Tauri demo section - keep for testing */}
            <section className="border-t border-neutral-200 dark:border-neutral-700 pt-8">
              <h2 className="text-2xl font-semibold text-neutral-800 dark:text-neutral-200 mb-4">
                Tauri Integration Demo
              </h2>
              <p className="text-neutral-600 dark:text-neutral-400 mb-4">
                Test the Tauri backend integration with this simple greeting function:
              </p>
              <div className="flex gap-2 mb-4">
                <input
                  id="greet-input"
                  value={name}
                  onChange={(e) => setName(e.currentTarget.value)}
                  placeholder="Enter a name..."
                  className="px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded bg-white dark:bg-neutral-800 text-neutral-800 dark:text-neutral-200"
                />
                <button
                  onClick={greet}
                  className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 transition-colors"
                >
                  Greet
                </button>
              </div>
              {greetMsg && (
                <p className="text-lg text-neutral-700 dark:text-neutral-300 bg-green-50 dark:bg-green-900/20 p-3 rounded">
                  {greetMsg}
                </p>
              )}
            </section>
          </div>
        </div>
      </div>
    </div>
  );
};
export default App;
