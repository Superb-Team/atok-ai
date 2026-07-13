"use client";

import React, { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Plus } from "lucide-react";
import { cn } from "@/lib/utils";

type FloatingActionMenuProps = {
  options: {
    label: string;
    onClick: () => void;
    Icon?: React.ReactNode;
  }[];
  className?: string;
};

const FloatingActionMenu = ({
  options,
  className,
}: FloatingActionMenuProps) => {
  const [isOpen, setIsOpen] = useState(false);

  const toggleMenu = () => {
    setIsOpen(!isOpen);
  };

  const handleOptionClick = (onClick: () => void) => {
    setIsOpen(false);
    onClick();
  };

  return (
    <div className={cn("fixed bottom-7 right-7 z-40", className)}>
      <button
        type="button"
        onClick={toggleMenu}
        aria-expanded={isOpen}
        aria-label={isOpen ? "Close quick actions" : "Open quick actions"}
        className="flex h-11 w-11 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-transform hover:scale-105 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <motion.div
          animate={{ rotate: isOpen ? 45 : 0 }}
          transition={{ type: "spring", stiffness: 320, damping: 22 }}
        >
          <Plus className="h-5 w-5" strokeWidth={2} />
        </motion.div>
      </button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: 8, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.97 }}
            transition={{ type: "spring", stiffness: 380, damping: 28 }}
            className="absolute bottom-14 right-0 mb-1 w-52 overflow-hidden rounded-xl border border-border bg-popover p-1.5 shadow-xl"
          >
            {options.map((option, index) => (
              <motion.button
                key={option.label}
                type="button"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.18, delay: index * 0.04 }}
                onClick={() => handleOptionClick(option.onClick)}
                className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] font-medium text-popover-foreground transition-colors hover:bg-accent active:scale-[0.98]"
              >
                <span className="text-muted-foreground">{option.Icon}</span>
                {option.label}
              </motion.button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default FloatingActionMenu;
