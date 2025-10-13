import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from '@/components/ui/avatar';
import { cn } from '@/lib/utils';
import type { UIMessage } from 'ai';
import type { ComponentProps, HTMLAttributes } from 'react';

// ====================================================================
// 1. Corrected Message Component for Positioning
// ====================================================================
export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: UIMessage['role'];
};

export const Message = ({ className, from, ...props }: MessageProps) => (
  <div
    className={cn(
      // Base flex container styles
      'group flex w-full items-end gap-2 py-4',
      // Position the entire block: right for user, left for assistant
      from === 'user' ? 'is-user justify-end' : 'is-assistant justify-start',
      // Set a max-width for the children
      '[&>div]:max-w-[80%]',
      className
    )}
    {...props}
  />
);

// ====================================================================
// 2. Corrected MessageContent for the Bubble Shape
// ====================================================================
export type MessageContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageContent = ({
  children,
  className,
  ...props
}: MessageContentProps) => (
  <div
    className={cn(
      // Base layout, padding, and text styles
      'flex flex-col gap-2 overflow-hidden px-4 py-3 text-sm text-foreground',
      // Base shape for all bubbles - reduced border radius from 'rounded-lg' to 'rounded-md'
      'rounded-md',
      // Conditional colors
      'group-[.is-user]:bg-primary group-[.is-user]:text-primary-foreground',
      'group-[.is-assistant]:bg-secondary group-[.is-assistant]:text-foreground',
      // *** THE KEY FIX FOR THE BUBBLE "TAIL" ***
      // For the user, make the top-right corner sharp
      'group-[.is-user]:rounded-tr-none',
      // For the assistant, make the top-left corner sharp
      'group-[.is-assistant]:rounded-tl-none',
      className
    )}
    {...props}
  >
    {/* This inner div is not strictly necessary but kept from original code */}
    <div>{children}</div>
  </div>
);

// ====================================================================
// 3. MessageAvatar Component (No changes needed)
// ====================================================================
export type MessageAvatarProps = ComponentProps<typeof Avatar> & {
  src: string;
  name?: string;
};

export const MessageAvatar = ({
  src,
  name,
  className,
  ...props
}: MessageAvatarProps) => (
  <Avatar
    className={cn(
      'size-8 shrink-0 ring-1 ring-border',
      // Avatar user di kanan, assistant di kiri
      'group-[.is-user]:order-last',
      className
    )}
    {...props}
  >
    <AvatarImage alt="" className="mt-0 mb-0" src={src} />
    <AvatarFallback>{name?.slice(0, 2) || 'ME'}</AvatarFallback>
  </Avatar>
);
