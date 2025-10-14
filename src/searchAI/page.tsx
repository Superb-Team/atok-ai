"use client";

import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ui/shadcn-io/ai/conversation";
import {
  Message,
  MessageAvatar,
  MessageContent,
} from "@/components/ui/shadcn-io/ai/message";
import {
  PromptInput,
  PromptInputModelSelect,
  PromptInputModelSelectContent,
  PromptInputModelSelectItem,
  PromptInputModelSelectTrigger,
  PromptInputModelSelectValue,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputToolbar,
  PromptInputTools,
} from "@/components/ui/shadcn-io/ai/prompt-input";
import { sendMessageStream, type ChatMessage } from "@/services/bedrock";
import React, { useEffect, useRef, useState } from "react";

// Status untuk chat
type ChatStatus = "ready" | "submitted" | "streaming" | "error";
type ChatMode = "chat" | "agent";

// Start with empty conversation - Bedrock requires conversation to start with user message
const initialMessages: ChatMessage[] = [];

export default function AIChatInterface() {
  const [input, setInput] = useState("");
  const [chatMode, setChatMode] = useState<ChatMode>("chat");
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [status, setStatus] = useState<ChatStatus>("ready");
  const abortControllerRef = useRef<AbortController | null>(null);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!input.trim() || status !== "ready") return;

    // Add user message
    const userMessage: ChatMessage = {
      id: Date.now().toString(),
      role: "user",
      content: input.trim(),
      timestamp: new Date(),
    };

    const updatedMessages = [...messages, userMessage];
    setMessages(updatedMessages);
    setStatus("submitted");

    setInput("");

    // Create abort controller for this request
    abortControllerRef.current = new AbortController();

    try {
    // Start streaming
      setStatus("streaming");

      // Create a temporary message for the AI response that we'll update as chunks arrive
      const aiMessageId = (Date.now() + 1).toString();
      let accumulatedContent = "";

      // Add empty AI message
      const aiMessage: ChatMessage = {
        id: aiMessageId,
        role: "assistant",
        content: "",
        timestamp: new Date(),
      };
      setMessages([...updatedMessages, aiMessage]);

      // Stream the response
      for await (const chunk of sendMessageStream(updatedMessages)) {
        // Check if aborted
        if (abortControllerRef.current?.signal.aborted) {
          break;
        }

        // Accumulate the content
        accumulatedContent += chunk;

        // Update the AI message with accumulated content
        setMessages((prev) => {
          const newMessages = [...prev];
          const lastMessage = newMessages[newMessages.length - 1];
          if (lastMessage && lastMessage.id === aiMessageId) {
            lastMessage.content = accumulatedContent;
          }
          return newMessages;
        });
      }

      setStatus("ready");
    } catch (error) {
      console.error("Error sending message:", error);
      setStatus("error");

      const errorMsg = error instanceof Error ? error.message : "An unknown error occurred";

      // Add error message to chat
      const errorChatMessage: ChatMessage = {
        id: (Date.now() + 2).toString(),
        role: "assistant",
        content: `⚠️ Error: ${errorMsg}\n\nPlease check your AWS credentials and try again.`,
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, errorChatMessage]);

      // Reset to ready after showing error
      setTimeout(() => {
        setStatus("ready");
      }, 3000);
    } finally {
      abortControllerRef.current = null;
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Handle Shift+Enter for new line, Enter for submit
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  return (
    <div className="flex flex-col h-full flex-1 bg-background">
      {/* Header - Clean version */}
      <div className="border-b p-2 bg-card">
        {/* Empty header for clean look */}
      </div>

      {/* Chat Container */}
      <div className="flex-1 overflow-hidden">
        <Conversation className="h-full">
          <ConversationContent className="h-full flex flex-col">
            <div className="max-w-4xl mx-auto w-full px-4 sm:px-6 lg:px-8 py-4 flex-1 overflow-y-auto">
              {messages.map((message) => (
                <Message from={message.role} key={message.id} className="mb-4">
                  <MessageAvatar
                    src={message.role === "user" ? "" : ""}
                    name={message.role === "user" ? "You" : "AI"}
                    className="bg-gradient-to-r from-blue-500 to-purple-600 text-white"
                  />
                  <MessageContent className="prose prose-sm dark:prose-invert max-w-none">
                    {message.content}
                  </MessageContent>
                </Message>
              ))}

              {/* Loading state */}
              {(status === "submitted" || status === "streaming") && (
                <Message from="assistant" className="mb-4">
                  <MessageAvatar
                    src=""
                    name="AI"
                    className="bg-gradient-to-r from-green-500 to-teal-600 text-white"
                  />
                  <MessageContent>
                    <div className="flex items-center space-x-2">
                      <div className="flex space-x-1">
                        <div className="w-2 h-2 bg-primary rounded-full animate-bounce [animation-delay:-0.3s]"></div>
                        <div className="w-2 h-2 bg-primary rounded-full animate-bounce [animation-delay:-0.15s]"></div>
                        <div className="w-2 h-2 bg-primary rounded-full animate-bounce"></div>
                      </div>
                      <span className="text-muted-foreground text-sm">
                        {status === "submitted" ? "Processing..." : "Generating response..."}
                      </span>
                    </div>
                  </MessageContent>
                </Message>
              )}
            </div>
          </ConversationContent>

          <ConversationScrollButton />
        </Conversation>
      </div>

      {/* Input Section */}
      <div className="border-t bg-background">
        <div className="max-w-4xl mx-auto w-full px-4 sm:px-6 lg:px-8 py-4">
          <PromptInput onSubmit={handleSubmit} className="max-w-none">
            <PromptInputTextarea
              value={input}
              onChange={(e) => setInput(e.currentTarget.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type here what you gonna do with your notes..."
              minHeight={48}
              maxHeight={200}
              className="resize-none"
            />

            <PromptInputToolbar>
              <PromptInputTools>
                {/* Chat/Agent Select Dropdown - Clean Design */}
                <PromptInputModelSelect value={chatMode} onValueChange={(value: ChatMode) => setChatMode(value)}>
                  <PromptInputModelSelectTrigger className="w-auto min-w-[100px]">
                    <PromptInputModelSelectValue />
                  </PromptInputModelSelectTrigger>
                  <PromptInputModelSelectContent>
                    <PromptInputModelSelectItem value="chat">Chat</PromptInputModelSelectItem>
                    <PromptInputModelSelectItem value="agent">Agent</PromptInputModelSelectItem>
                  </PromptInputModelSelectContent>
                </PromptInputModelSelect>
              </PromptInputTools>

              <PromptInputSubmit
                disabled={!input.trim() || status !== "ready"}
                status={status}
                variant="ghost"
                className="bg-transparent hover:bg-transparent text-foreground hover:text-foreground/80 dark:bg-transparent dark:hover:bg-transparent"
              />
            </PromptInputToolbar>
          </PromptInput>

          {/* Status Footer */}
          <div className="flex justify-between items-center mt-2 text-xs text-muted-foreground">
            <div className="flex items-center space-x-4">
              <span>Press Enter to send, Shift+Enter for new line</span>
              {status !== "ready" && (
                <span className="flex items-center space-x-1">
                  <div className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse"></div>
                  <span>AI is {status === "submitted" ? "processing" : "generating"}</span>
                </span>
              )}
            </div>
            <div className="hidden sm:block">
              {messages.length} messages
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
