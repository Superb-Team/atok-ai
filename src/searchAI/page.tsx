"use client";

import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ui/shadcn-io/ai/conversation";
import {
  PromptInput,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputToolbar,
} from "@/components/ui/shadcn-io/ai/prompt-input";
import { agentService, type AgentMessage } from "@/services/agent.service";
import { authService } from "@/services/auth.service";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";
import { User as UserIcon } from "lucide-react";
import React, { useEffect, useRef, useState } from "react";

// Status untuk chat
type ChatStatus = "ready" | "submitted" | "streaming" | "error";

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

// Start with empty conversation
const initialMessages: ChatMessage[] = [];

export default function AIChatInterface() {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [status, setStatus] = useState<ChatStatus>("ready");
  const [isUsingTool, setIsUsingTool] = useState(false);
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

    // Get user info
    const user = authService.getUser();
    if (!user) {
      console.error("User not authenticated");
      return;
    }

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

      // Prepare for AI response
      const aiMessageId = (Date.now() + 1).toString();
      let accumulatedContent = "";

      // Prepare conversation history for agent
      const conversationHistory: AgentMessage[] = updatedMessages.map(msg => ({
        role: msg.role,
        content: msg.content,
      }));

      // Stream the response from agent
      for await (const event of agentService.streamAgent({
        prompt: userMessage.content,
        user_id: user.id,
        conversation_history: conversationHistory.slice(0, -1), // Exclude current message
      })) {
        // Check if aborted
        if (abortControllerRef.current?.signal.aborted) {
          break;
        }

        // Handle different event types
        if (event.type === 'tool') {
          // Tool is being used
          setIsUsingTool(true);
        } else if (event.type === 'content') {
          // Content chunk received
          setIsUsingTool(false);
          accumulatedContent += event.content || '';

          // Update the AI message
          setMessages((prev) => {
            const newMessages = [...prev];
            const lastMessage = newMessages[newMessages.length - 1];

            // If last message is from assistant with same ID, update it
            if (lastMessage && lastMessage.role === 'assistant' && lastMessage.id === aiMessageId) {
              lastMessage.content = accumulatedContent;
              return newMessages;
            } else {
              // Otherwise, add new message
              return [...prev, {
                id: aiMessageId,
                role: "assistant",
                content: accumulatedContent,
                timestamp: new Date(),
              }];
            }
          });
        } else if (event.type === 'error') {
          throw new Error(event.content || 'Unknown error');
        }
      }

      setIsUsingTool(false);

      setStatus("ready");
    } catch (error) {
      console.error("Error sending message:", error);
      setStatus("error");

      const errorMsg = error instanceof Error ? error.message : "An unknown error occurred";

      // Add error message to chat
      const errorChatMessage: ChatMessage = {
        id: (Date.now() + 2).toString(),
        role: "assistant",
        content: `⚠️ Error: ${errorMsg}\n\nPlease make sure the agent API is running at base_url`,
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
    <div className="flex flex-col h-full flex-1 bg-neutral-50 dark:bg-neutral-900">
      {/* Chat Container */}
      <div className="flex-1 overflow-hidden flex flex-col">
        <Conversation className="h-full">
          <ConversationContent className="h-full flex flex-col">
            {messages.length === 0 ? (
              /* Empty State - Centered Search */
              <div className="flex-1 flex flex-col items-center justify-center px-4 sm:px-6 lg:px-8 pb-32">
                <div className="text-center mb-8 space-y-4">
                  <div className="inline-flex items-center justify-center w-20 h-20 rounded-2xl mb-4">
                    <img src="/logo-atok.png" alt="Atok.ai" className="w-20 h-20 rounded-2xl" />
                  </div>
                  <h1 className="text-4xl font-bold text-neutral-900 dark:text-white mb-2">
                    Atok Agents
                  </h1>
                  <p className="text-lg text-neutral-600 dark:text-neutral-400 max-w-md">
                    Ask me anything about your notes, tasks, or let me help you organize your thoughts
                  </p>
                </div>

                {/* Centered Search Input */}
                <div className="w-full max-w-3xl">
                  <PromptInput onSubmit={handleSubmit} className="max-w-none shadow-xl">
                    <PromptInputTextarea
                      value={input}
                      onChange={(e) => setInput(e.currentTarget.value)}
                      onKeyDown={handleKeyDown}
                      placeholder="What would you like to know about your notes?"
                      minHeight={56}
                      maxHeight={200}
                      className="resize-none text-base"
                    />

                    <PromptInputToolbar className="justify-end">
                      <PromptInputSubmit
                        disabled={!input.trim() || status !== "ready"}
                        status={status}
                        className="bg-neutral-900 hover:bg-neutral-800 dark:bg-white dark:hover:bg-neutral-200 text-white dark:text-neutral-900"
                      />
                    </PromptInputToolbar>
                  </PromptInput>

                  <p className="text-center text-xs text-neutral-500 dark:text-neutral-500 mt-3">
                    Press Enter to send • Shift+Enter for new line
                  </p>
                </div>
              </div>
            ) : (
              /* Chat Messages */
              <div className="flex-1 overflow-y-auto">
                <div className="max-w-4xl mx-auto w-full px-4 sm:px-6 lg:px-8 py-8 space-y-6">
                  {messages.map((message) => (
                    <div
                      key={message.id}
                      className={`flex gap-4 ${message.role === "user" ? "justify-end" : "justify-start"
                        }`}
                    >
                      {message.role === "assistant" && (
                        <div className="flex-shrink-0">
                          <div className="w-10 h-10 rounded-full overflow-hidden">
                            <img src="/logo-atok.png" alt="Atok.ai" className="w-full h-full object-cover" />
                          </div>
                        </div>
                      )}

                      <div
                        className={`max-w-[80%] rounded-2xl px-5 py-3 ${message.role === "user"
                          ? "bg-neutral-900 dark:bg-white text-white dark:text-neutral-900"
                          : "bg-white dark:bg-neutral-800 text-neutral-900 dark:text-white border border-neutral-200 dark:border-neutral-700"
                          }`}
                      >
                        <div className="prose prose-sm dark:prose-invert max-w-none">
                          {message.role === 'assistant' ? (
                            <MarkdownRenderer content={message.content} />
                          ) : (
                            <p className="whitespace-pre-wrap m-0">{message.content}</p>
                          )}
                        </div>
                      </div>

                      {message.role === "user" && (
                        <div className="flex-shrink-0">
                          <div className="w-10 h-10 rounded-full bg-neutral-300 dark:bg-neutral-700 flex items-center justify-center">
                            <UserIcon className="w-5 h-5 text-neutral-700 dark:text-neutral-300" />
                          </div>
                        </div>
                      )}
                    </div>
                  ))}

                  {/* Loading state - hide if last message is assistant (content already showing) */}
                  {(status === "submitted" || status === "streaming") &&
                    !(messages.length > 0 && messages[messages.length - 1].role === 'assistant' && messages[messages.length - 1].content) && (
                      <div className="flex gap-4 justify-start">
                        <div className="flex-shrink-0">
                          <div className="w-10 h-10 rounded-full overflow-hidden">
                            <img src="/logo-atok.png" alt="Atok.ai" className="w-full h-full object-cover" />
                          </div>
                        </div>
                        <div className="max-w-[80%] rounded-2xl px-5 py-3 bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700">
                          <div className="flex items-center space-x-3">
                            <div className="flex space-x-1">
                              <div className="w-2 h-2 bg-neutral-500 dark:bg-neutral-400 rounded-full animate-bounce [animation-delay:-0.3s]"></div>
                              <div className="w-2 h-2 bg-neutral-500 dark:bg-neutral-400 rounded-full animate-bounce [animation-delay:-0.15s]"></div>
                              <div className="w-2 h-2 bg-neutral-500 dark:bg-neutral-400 rounded-full animate-bounce"></div>
                            </div>
                            <span className="text-neutral-600 dark:text-neutral-400 text-sm font-medium">
                              {isUsingTool ? "Using tools..." : "Thinking..."}
                            </span>
                          </div>
                        </div>
                      </div>
                    )}
                </div>
              </div>
            )}
          </ConversationContent>

          <ConversationScrollButton />
        </Conversation>

        {/* Input Section - Only show when there are messages */}
        {messages.length > 0 && (
          <div className="border-t border-neutral-200 dark:border-neutral-700 bg-white/80 dark:bg-neutral-900/80 backdrop-blur-sm">
            <div className="max-w-4xl mx-auto w-full px-4 sm:px-6 lg:px-8 py-4">
              <PromptInput onSubmit={handleSubmit} className="max-w-none shadow-lg">
                <PromptInputTextarea
                  value={input}
                  onChange={(e) => setInput(e.currentTarget.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Type your message..."
                  minHeight={48}
                  maxHeight={200}
                  className="resize-none"
                />

                <PromptInputToolbar className="justify-end">
                  <PromptInputSubmit
                    disabled={!input.trim() || status !== "ready"}
                    status={status}
                    className="bg-neutral-900 hover:bg-neutral-800 dark:bg-white dark:hover:bg-neutral-200 text-white dark:text-neutral-900"
                  />
                </PromptInputToolbar>
              </PromptInput>

              {/* Status Footer */}
              <div className="flex justify-between items-center mt-2 text-xs text-neutral-500 dark:text-neutral-500">
                <span>Press Enter to send • Shift+Enter for new line</span>
                {status !== "ready" && (
                  <span className="flex items-center space-x-1">
                    <div className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse"></div>
                    <span>AI is {status === "submitted" ? "thinking" : "typing"}</span>
                  </span>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
