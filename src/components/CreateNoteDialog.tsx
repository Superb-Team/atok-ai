import { useState } from "react";
import { noteService } from "@/services/note.service";
import { authService } from "@/services/auth.service";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

interface CreateNoteDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onNoteCreated: () => void;
}

const COLORS = [
    { name: "Gray", value: "#E5E7EB" },
    { name: "Red", value: "#FCA5A5" },
    { name: "Orange", value: "#FED7AA" },
    { name: "Yellow", value: "#FDE68A" },
    { name: "Green", value: "#BBF7D0" },
    { name: "Blue", value: "#BFDBFE" },
    { name: "Purple", value: "#DDD6FE" },
    { name: "Pink", value: "#FBCFE8" },
];

export default function CreateNoteDialog({ open, onOpenChange, onNoteCreated }: CreateNoteDialogProps) {
    const [title, setTitle] = useState("");
    const [content, setContent] = useState("");
    const [selectedColor, setSelectedColor] = useState(COLORS[0].value);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError("");

        if (!title.trim()) {
            setError("Title is required");
            return;
        }

        setLoading(true);

        try {
            const user = authService.getUser();
            if (!user) {
                setError("User not authenticated");
                return;
            }

            await noteService.createNote(user.id, {
                title: title.trim(),
                content: content.trim() || undefined,
                color: selectedColor,
            });

            setTitle("");
            setContent("");
            setSelectedColor(COLORS[0].value);
            onNoteCreated();
            onOpenChange(false);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to create note");
        } finally {
            setLoading(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-lg overflow-hidden">
                <DialogHeader>
                    <DialogTitle>Create New Note</DialogTitle>
                </DialogHeader>

                <form onSubmit={handleSubmit} className="space-y-4">
                    {error && (
                        <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded text-red-600 dark:text-red-400 text-sm">
                            {error}
                        </div>
                    )}

                    <div className="space-y-2">
                        <Label htmlFor="title">Title *</Label>
                        <Input
                            id="title"
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                            placeholder="Enter note title"
                            disabled={loading}
                            required
                        />
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor="content">Content</Label>
                        <Textarea
                            id="content"
                            value={content}
                            onChange={(e) => setContent(e.target.value)}
                            placeholder="Enter note content (optional)"
                            disabled={loading}
                            rows={5}
                            className="resize-none max-h-40"
                        />
                    </div>

                    <div className="space-y-2">
                        <Label>Color</Label>
                        <div className="flex gap-2 flex-wrap">
                            {COLORS.map((color) => (
                                <button
                                    key={color.value}
                                    type="button"
                                    onClick={() => setSelectedColor(color.value)}
                                    className={`w-10 h-10 rounded-full border-2 transition-all ${selectedColor === color.value
                                        ? "border-neutral-800 dark:border-neutral-200 scale-110"
                                        : "border-transparent hover:scale-105"
                                        }`}
                                    style={{ backgroundColor: color.value }}
                                    title={color.name}
                                    disabled={loading}
                                />
                            ))}
                        </div>
                    </div>

                    <div className="flex justify-end gap-2 pt-4">
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => onOpenChange(false)}
                            disabled={loading}
                        >
                            Cancel
                        </Button>
                        <Button type="submit" disabled={loading}>
                            {loading ? "Creating..." : "Create Note"}
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}
