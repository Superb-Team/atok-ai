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
import React, { useState } from "react";

// Mock status untuk demonstrasi
type ChatStatus = "ready" | "submitted" | "streaming" | "error";
type ChatMode = "chat" | "agent";

// Mock messages untuk demo
const initialMessages = [
  {
    id: "1",
    role: "assistant" as const,
    content: "Hello! I'm your AI assistant. How can I help you today?",
  },
  {
    id: "2",
    role: "user" as const,
    content: "Hi! Can you help me understand React components?",
  },
  {
    id: "3",
    role: "assistant" as const,
    content: "Of course! React components are the building blocks of React applications. They are JavaScript functions or classes that return JSX (JavaScript XML) to describe what should appear on the screen. Components allow you to split the UI into independent, reusable pieces that can be thought about in isolation.",
  },
];

export default function AIChatInterface() {
  const [input, setInput] = useState("");
  const [chatMode, setChatMode] = useState<ChatMode>("chat");
  const [messages, setMessages] = useState(initialMessages);
  const [status, setStatus] = useState<ChatStatus>("ready");

  // Mock function untuk simulate AI response
  const simulateAIResponse = (userMessage: string) => {
    const responses = [
      "That's a great question! Let me help you with that.",
      "I understand what you're asking. Here's what I think...",
      "Based on your question, I'd recommend the following approach:",
      "That's an interesting point. Let me elaborate on that for you.",
      "I can definitely help you with that. Here's my take:",
    ];

    const randomResponse = responses[Math.floor(Math.random() * responses.length)];
    return `${randomResponse}\n\nRegarding "${userMessage}" - this is a simulated response in ${chatMode} mode.`;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (!input.trim()) return;

    // Add user message
    const userMessage = {
      id: Date.now().toString(),
      role: "user" as const,
      content: input.trim(),
    };

    setMessages(prev => [...prev, userMessage]);
    setStatus("submitted");

    const currentInput = input.trim();
    setInput("");

    // Simulate AI processing delay
    setTimeout(() => {
      setStatus("streaming");

      // Simulate streaming delay
      setTimeout(() => {
        const aiResponse = {
          id: (Date.now() + 1).toString(),
          role: "assistant" as const,
          content: simulateAIResponse(currentInput),
        };

        setMessages(prev => [...prev, aiResponse]);
        setStatus("ready");
      }, 1500);
    }, 500);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Handle Shift+Enter for new line, Enter for submit
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  return (
    <div className="flex flex-col h-screen max-w-4xl mx-auto bg-background">
      {/* Header - Clean version */}
      <div className="border-b p-2 bg-card">
        {/* Empty header for clean look */}
      </div>

      {/* Chat Container */}
      <div className="flex-1 overflow-hidden">
        <Conversation className="h-full">
          <ConversationContent className="p-4">
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
          </ConversationContent>

          <ConversationScrollButton />
        </Conversation>
      </div>

      {/* Input Section */}
      <div className="p-4">
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
              className="text-foreground hover:text-foreground/80 hover:bg-transparent"
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
  );
}
