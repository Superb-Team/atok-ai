import * as React from "react";
import { AlertCircle, AlertTriangle } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Mode = "confirm" | "alert";
type Variant = "default" | "destructive";

interface ConfirmDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    description?: React.ReactNode;
    confirmText?: string;
    cancelText?: string;
    onConfirm?: () => void | Promise<void>;
    variant?: Variant;
    mode?: Mode;
    loading?: boolean;
}

export function ConfirmDialog({
    open,
    onOpenChange,
    title,
    description,
    confirmText = "OK",
    cancelText = "Cancel",
    onConfirm,
    variant = "default",
    mode = "confirm",
    loading = false,
}: ConfirmDialogProps) {
    const handleConfirm = async () => {
        if (onConfirm) {
            await onConfirm();
        }
        if (!loading) {
            onOpenChange(false);
        }
    };

    const Icon = variant === "destructive" ? AlertTriangle : AlertCircle;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-[420px]">
                <DialogHeader>
                    <div className="flex items-start gap-3">
                        <div
                            className={cn(
                                "flex h-10 w-10 shrink-0 items-center justify-center rounded-full",
                                variant === "destructive"
                                    ? "bg-red-100 dark:bg-red-900/30"
                                    : "bg-neutral-100 dark:bg-neutral-800",
                            )}
                        >
                            <Icon
                                className={cn(
                                    "h-5 w-5",
                                    variant === "destructive"
                                        ? "text-red-600 dark:text-red-400"
                                        : "text-neutral-600 dark:text-neutral-300",
                                )}
                            />
                        </div>
                        <div className="flex-1 min-w-0 space-y-1.5 pt-0.5">
                            <DialogTitle>{title}</DialogTitle>
                            {description && (
                                <DialogDescription className="whitespace-pre-wrap break-words">
                                    {description}
                                </DialogDescription>
                            )}
                        </div>
                    </div>
                </DialogHeader>
                <DialogFooter className="gap-2 sm:gap-2">
                    {mode === "confirm" && (
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => onOpenChange(false)}
                            disabled={loading}
                        >
                            {cancelText}
                        </Button>
                    )}
                    <Button
                        type="button"
                        variant={variant === "destructive" ? "destructive" : "default"}
                        onClick={handleConfirm}
                        disabled={loading}
                    >
                        {loading ? "Loading..." : confirmText}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
