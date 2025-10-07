import React, { useState } from 'react';
import { Search } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Extension {
  id: string;
  name: string;
  author: string;
  description: string;
  image?: string;
  configuration?: {
    username?: boolean;
    apiKey?: boolean;
  };
  videoWalkthrough?: {
    step1?: string;
    step2?: string;
  };
}

const ExtensionsPage: React.FC = () => {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedExtension, setSelectedExtension] = useState<Extension | null>(null);
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  const [extensions] = useState<Extension[]>([
    {
      id: '1',
      name: 'Google Calendar MCP',
      author: '@Samsedin',
      description: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.',
      configuration: {
        username: true,
        apiKey: true,
      },
      videoWalkthrough: {
        step1: 'Video placeholder 1',
        step2: 'Video placeholder 2',
      }
    },
    {
      id: '2',
      name: 'Google Drive MCP',
      author: '@Samsedin',
      description: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.',
      configuration: {
        username: true,
        apiKey: true,
      }
    },
    {
      id: '3',
      name: 'Google Photos MCP',
      author: '@Samsedin',
      description: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.',
      configuration: {
        apiKey: true,
      }
    },
  ]);

  const filteredExtensions = extensions.filter(ext =>
    ext.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    ext.description.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleExtensionClick = (extension: Extension) => {
    setSelectedExtension(extension);
    setIsDialogOpen(true);
  };

  return (
    <div className="flex-1 p-8 bg-background min-h-screen">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-4xl font-bold text-foreground mb-4">Extensions</h1>
          <p className="text-muted-foreground text-base">
            In this menu, you can choose our diverse collections of{' '}
            <span className="font-semibold">MCP Servers</span> called{' '}
            <span className="font-semibold">Extensions</span>. This MCPs, can help your AI Agent to become more sentient.{' '}
            <span className="font-bold">HAHAHA!</span>
          </p>
        </div>

        {/* Search Bar */}
        <div className="mb-8 relative">
          <div className="relative">
            <Input
              type="text"
              placeholder="Type to search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-4 pr-12 py-6 text-base bg-secondary/30 border-border/50 focus:border-primary"
            />
            <button className="absolute right-3 top-1/2 -translate-y-1/2 p-2 hover:bg-accent rounded-full transition-colors">
              <Search className="w-5 h-5 text-muted-foreground" />
            </button>
          </div>
        </div>

        {/* Extensions Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredExtensions.map((extension) => (
            <div
              key={extension.id}
              onClick={() => handleExtensionClick(extension)}
              className="bg-card rounded-xl p-6 shadow-sm border border-border hover:shadow-lg hover:border-primary/50 transition-all cursor-pointer group"
            >
              {/* Extension Image/Placeholder */}
              <div className="w-full h-40 bg-secondary/50 rounded-lg mb-4 flex items-center justify-center group-hover:bg-secondary/70 transition-colors">
                <div className="text-muted-foreground text-sm">Extension Preview</div>
              </div>

              {/* Extension Info */}
              <div>
                <h3 className="text-lg font-bold text-foreground mb-1 group-hover:text-primary transition-colors">
                  {extension.name}
                </h3>
                <p className="text-xs text-muted-foreground mb-3">
                  by {extension.author}
                </p>
                <p className="text-sm text-muted-foreground line-clamp-3">
                  {extension.description}
                </p>
              </div>
            </div>
          ))}
        </div>

        {/* No Results */}
        {filteredExtensions.length === 0 && (
          <div className="text-center py-16">
            <p className="text-muted-foreground text-lg">No extensions found matching your search.</p>
          </div>
        )}
      </div>

      {/* Extension Detail Dialog */}
      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            {/* Image with X lines pattern */}
            <div className="w-full h-24 bg-secondary/30 rounded-lg mb-4 flex items-center justify-center relative overflow-hidden">
              <svg className="absolute inset-0 w-full h-full" viewBox="0 0 100 30" preserveAspectRatio="none">
                <line x1="0" y1="0" x2="100" y2="30" stroke="currentColor" strokeWidth="0.5" className="text-border" />
                <line x1="0" y1="30" x2="100" y2="0" stroke="currentColor" strokeWidth="0.5" className="text-border" />
              </svg>
            </div>
            <DialogTitle className="text-2xl font-bold text-left">
              {selectedExtension?.name}
            </DialogTitle>
            <DialogDescription className="text-sm text-left leading-relaxed pt-2">
              Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Lorem ipsum dolor sit amet, consectetur adipiscing elit.
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mt-6">
            {/* Configuration Section */}
            <div>
              <h3 className="text-base font-bold mb-4">Configuration</h3>
              <div className="space-y-4">
                {selectedExtension?.configuration?.username && (
                  <div className="space-y-2">
                    <Label htmlFor="username" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      USERNAME
                    </Label>
                    <div className="h-10 bg-secondary/50 rounded border border-border"></div>
                  </div>
                )}
                {selectedExtension?.configuration?.apiKey && (
                  <div className="space-y-2">
                    <Label htmlFor="apiKey" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      API KEY
                    </Label>
                    <div className="h-10 bg-secondary/50 rounded border border-border"></div>
                  </div>
                )}
              </div>
            </div>

            {/* Video Walkthrough Section */}
            <div>
              <h3 className="text-base font-bold mb-4">Video Walkthrough</h3>
              <div className="space-y-4">
                {selectedExtension?.videoWalkthrough?.step1 && (
                  <div className="relative pl-8">
                    <div className="absolute left-0 top-3 w-6 h-6 rounded-full bg-muted border border-border flex items-center justify-center">
                      <span className="text-xs font-semibold text-muted-foreground">1</span>
                    </div>
                    <div className="w-full h-28 bg-secondary/50 rounded-lg border border-border"></div>
                  </div>
                )}
                {selectedExtension?.videoWalkthrough?.step2 && (
                  <div className="relative pl-8">
                    <div className="absolute left-0 top-3 w-6 h-6 rounded-full bg-muted border border-border flex items-center justify-center">
                      <span className="text-xs font-semibold text-muted-foreground">2</span>
                    </div>
                    <div className="w-full h-28 bg-secondary/50 rounded-lg border border-border"></div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Action Buttons - No border top, just spacing */}
          <div className="flex justify-end gap-3 mt-8">
            <button
              onClick={() => setIsDialogOpen(false)}
              className="px-6 py-2 rounded-lg border border-border hover:bg-accent transition-colors text-sm font-medium"
            >
              Cancel
            </button>
            <button
              onClick={() => {
                // Handle install logic here
                console.log('Installing extension:', selectedExtension?.name);
                setIsDialogOpen(false);
              }}
              className="px-6 py-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors font-medium text-sm"
            >
              Install Extension
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default ExtensionsPage;
