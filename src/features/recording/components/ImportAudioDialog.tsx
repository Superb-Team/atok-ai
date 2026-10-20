import { useRef, useState } from "react";
import { audioImportService } from "@/features/recording/api/audio-import.service";
import { generateNoteTitle } from "@/features/note-generation/audio-processor.service";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { ChevronDown } from "lucide-react";
import { authService } from "@/features/auth/api/auth.service";
import { parseImportRecordingContext, toLocalDateTimeInput } from "@/features/recording/lib/import-recording-context";
import { errorMessage } from "@/lib/logger";
import { parseTranscriptionGlossary } from "@/features/recording/lib/transcription-glossary";

interface ImportAudioDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

// Same option set as RecordingPopupApp's transcription-language picker.
const LANGUAGES: { code: string; label: string }[] = [
    { code: "id", label: "Bahasa Indonesia" },
    { code: "en", label: "English" },
    { code: "ja", label: "Japanese" },
    { code: "ko", label: "Korean" },
    { code: "zh", label: "Chinese" },
    { code: "es", label: "Spanish" },
    { code: "ar", label: "Arabic" },
    { code: "", label: "Auto-detect" },
];

export default function ImportAudioDialog({ open, onOpenChange }: ImportAudioDialogProps) {
    const [filePath, setFilePath] = useState("");
    const [fileName, setFileName] = useState("");
    const [title, setTitle] = useState("");
    const [language, setLanguage] = useState("id");
    const [glossaryInput, setGlossaryInput] = useState("");
    const [recordedAt, setRecordedAt] = useState(() => toLocalDateTimeInput());
    const [queuedPath, setQueuedPath] = useState("");
    const submitting = useRef(false);
    const pickerActive = useRef(false);
    const [picking, setPicking] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");

    const reset = () => {
        setQueuedPath("");
        setRecordedAt(toLocalDateTimeInput());
        setFilePath("");
        setFileName("");
        setTitle("");
        setLanguage("id");
        setGlossaryInput("");
        setError("");
    };

    const handlePickFile = async () => {
        if (pickerActive.current || submitting.current) return;
        pickerActive.current = true;
        setPicking(true);
        setError("");
        try {
            const picked = await audioImportService.pickAudioFile();
            if (!picked) return;

            const name = picked.split(/[/\\]/).pop() ?? picked;
            setQueuedPath("");
            setFilePath(picked);
            setFileName(name);
            if (!title.trim()) {
                setTitle(name.replace(/\.[^.]+$/, ""));
            }
        } catch (err) {
            setError(errorMessage(err));
        } finally {
            pickerActive.current = false;
            setPicking(false);
        }
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (submitting.current || pickerActive.current) return;
        setError("");

        if (!filePath) {
            setError("Choose an audio file first");
            return;
        }

        submitting.current = true;
        setLoading(true);
        try {
            const user = authService.getUser();
            if (!user) throw new Error("Sign in before importing audio.");
            const glossary = parseTranscriptionGlossary(glossaryInput);
            const context = parseImportRecordingContext(recordedAt, Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
            const audioPath = queuedPath || await audioImportService.allocateImportPath();
            setQueuedPath(audioPath);
            await audioImportService.queueImportedAudio(filePath, audioPath, title.trim() || generateNoteTitle(), language,
                glossary, context, user.id);
            reset();
            onOpenChange(false);
        } catch (err) {
            setError(errorMessage(err));
        } finally {
            submitting.current = false;
            setLoading(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={(next) => { if (!loading && !picking) { onOpenChange(next); if (!next) reset(); } }}>
            <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>Import an audio recording</DialogTitle>
                </DialogHeader>

                <form onSubmit={handleSubmit} className="space-y-4">
                    {error && (
                        <div role="alert" className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded text-red-600 dark:text-red-400 text-sm">
                            {error}
                        </div>
                    )}

                    <div className="space-y-2">
                        <Label htmlFor="import-file">Audio file</Label>
                        <div className="flex gap-2">
                            <Button id="import-file" type="button" variant="outline" onClick={handlePickFile} disabled={loading || picking}>
                                Choose File
                            </Button>
                            <span className="flex items-center text-sm text-neutral-500 dark:text-neutral-400 truncate">
                                {fileName || "No file selected"}
                            </span>
                        </div>
                        <p className="text-xs text-neutral-500 dark:text-neutral-400">
                            Supports mp3, wav, m4a, flac, aac. Keep the source file available until background import finishes.
                        </p>
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor="import-title">Title</Label>
                        <Input
                            id="import-title"
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                            placeholder="Enter note title"
                            disabled={loading}
                        />
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor="import-recorded-at">Recording date and time</Label>
                        <Input id="import-recorded-at" type="datetime-local" value={recordedAt}
                            onChange={event => setRecordedAt(event.target.value)} disabled={loading} required
                            aria-describedby="import-date-help" />
                        <p id="import-date-help" className="text-xs text-muted-foreground">
                            Set the original meeting time in your timezone ({Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"}).
                        </p>
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor="import-language">Transcription language</Label>
                        <div className="relative">
                            <select
                                id="import-language"
                                value={language}
                                onChange={(e) => setLanguage(e.target.value)}
                                disabled={loading}
                                className={cn(
                                    "appearance-none bg-background border-input text-foreground h-9 w-full rounded-md border pl-3 pr-8 py-1 text-sm shadow-xs outline-none disabled:pointer-events-none disabled:opacity-50",
                                    "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
                                )}
                            >
                                {LANGUAGES.map((lang) => (
                                    <option
                                        key={lang.code}
                                        value={lang.code}
                                        style={{ backgroundColor: "var(--background)", color: "var(--foreground)" }}
                                    >
                                        {lang.label}
                                    </option>
                                ))}
                            </select>
                            <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500 dark:text-neutral-400" />
                        </div>
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor="import-glossary">Important names and terms (optional)</Label>
                        <Input
                            id="import-glossary"
                            value={glossaryInput}
                            onChange={(e) => setGlossaryInput(e.target.value)}
                            placeholder="Acme Fiber, Siti Aminah, project codename"
                            disabled={loading}
                        />
                        <p className="text-xs text-neutral-500 dark:text-neutral-400">
                            Separate terms with commas. They apply only to this recording.
                        </p>
                    </div>

                    <div className="flex justify-end gap-2 pt-4">
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => { reset(); onOpenChange(false); }}
                            disabled={loading || picking}
                        >
                            Cancel
                        </Button>
                        <Button type="submit" disabled={loading || picking || !filePath}>
                            {loading ? "Queueing…" : "Import and transcribe"}
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}
