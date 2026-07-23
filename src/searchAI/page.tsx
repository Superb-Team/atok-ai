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
import { Check, Sparkle, Wrench } from "lucide-react";
import React, { useEffect, useRef, useState } from "react";

type ChatStatus = "ready" | "submitted" | "streaming" | "error";

/** One entry in an assistant turn's activity trail (thinking, tool calls). */
interface ActivityStep {
  id: string;
  kind: "thinking" | "tool";
  label: string;
  status: "running" | "done";
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
  steps?: ActivityStep[];
}

const SUGGESTIONS = [
  "Summarize this week's notes",
  "Which tasks are still open?",
  "What did we decide in the last meeting?",
];

// Turns backend tool identifiers like "search_notes" into readable labels.
function toolLabel(event: { tool_name?: string; content?: string }) {
  const raw = event.tool_name || event.content;
  if (!raw) return "Running a tool";
  return raw.replace(/[_-]+/g, " ").trim();
}

export default function AIChatInterface() {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<ChatStatus>("ready");
  const abortControllerRef = useRef<AbortController | null>(null);

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

    const user = authService.getUser();
    if (!user) {
      console.error("User not authenticated");
      return;
    }

    const userMessage: ChatMessage = {
      id: Date.now().toString(),
      role: "user",
      content: input.trim(),
      timestamp: new Date(),
    };

    const aiMessageId = (Date.now() + 1).toString();
    let stepCounter = 0;

    const updatedMessages = [...messages, userMessage];
    // The assistant turn exists from the start, opening with a thinking step;
    // stream events then rewrite it in place.
    setMessages([
      ...updatedMessages,
      {
        id: aiMessageId,
        role: "assistant",
        content: "",
        timestamp: new Date(),
        steps: [{ id: "s0", kind: "thinking", label: "Thinking", status: "running" }],
      },
    ]);
    setStatus("submitted");
    setInput("");

    const updateAssistant = (patch: (msg: ChatMessage) => ChatMessage) => {
      setMessages((prev) =>
        prev.map((msg) => (msg.id === aiMessageId ? patch({ ...msg }) : msg))
      );
    };

    const settleSteps = (msg: ChatMessage): ActivityStep[] =>
      (msg.steps ?? []).map((s) => ({ ...s, status: "done" as const }));

    abortControllerRef.current = new AbortController();

    try {
      setStatus("streaming");

      let accumulatedContent = "";

      const conversationHistory: AgentMessage[] = updatedMessages.map((msg) => ({
        role: msg.role,
        content: msg.content,
      }));

      for await (const event of agentService.streamAgent({
        prompt: userMessage.content,
        user_id: user.id,
        conversation_history: conversationHistory.slice(0, -1), // Exclude current message
        system_prompt:
          "You are Atok AI, an intelligent assistant integrated into the Atok.ai workspace. You help users manage their notes, tasks, and answer questions based on their stored knowledge. Be helpful, concise, and accurate. When referencing notes or tasks, provide specific details.",
      })) {
        if (abortControllerRef.current?.signal.aborted) {
          break;
        }

        if (event.type === "thinking") {
          updateAssistant((msg) => ({
            ...msg,
            steps: [
              ...settleSteps(msg),
              { id: `s${++stepCounter}`, kind: "thinking", label: "Thinking", status: "running" },
            ],
          }));
        } else if (event.type === "tool") {
          updateAssistant((msg) => ({
            ...msg,
            steps: [
              ...settleSteps(msg),
              { id: `s${++stepCounter}`, kind: "tool", label: toolLabel(event), status: "running" },
            ],
          }));
        } else if (event.type === "content") {
          accumulatedContent += event.content || "";
          const content = accumulatedContent;
          updateAssistant((msg) => ({ ...msg, content, steps: settleSteps(msg) }));
        } else if (event.type === "error") {
          throw new Error(event.content || "Unknown error");
        }
      }

      if (accumulatedContent === "") {
        updateAssistant((msg) => ({
          ...msg,
          content:
            "I processed your request but didn't generate a response. Please try rephrasing your question.",
          steps: settleSteps(msg),
        }));
      }

      setStatus("ready");
    } catch (error) {
      console.error("Error sending message:", error);
      setStatus("error");

      const errorMsg = error instanceof Error ? error.message : "An unknown error occurred";

      updateAssistant((msg) => ({
        ...msg,
        content: `Something went wrong: ${errorMsg}\n\nMake sure the agent API is running, then try again.`,
        steps: settleSteps(msg),
      }));

      setTimeout(() => {
        setStatus("ready");
      }, 3000);
    } finally {
      abortControllerRef.current = null;
    }
  };

  return (
    <div className="flex flex-col h-full flex-1 bg-background">
      {/* Chat Container */}
      <div className="flex-1 overflow-hidden flex flex-col">
        <Conversation className="h-full">
          <ConversationContent className="h-full flex flex-col">
            {messages.length === 0 ? (
              <div className="flex-1 overflow-y-auto px-8 pb-16 pt-10 sm:px-12">
                <div className="mx-auto w-full max-w-5xl">
                  <div className="mb-14 flex items-start justify-between gap-8 border-b border-border pb-8">
                    <div>
                      <p className="font-mono text-[10px] uppercase tracking-[.2em] text-muted-foreground">
                        Atok intelligence
                      </p>
                      <h1 className="mt-3 max-w-xl font-display text-[2.6rem] font-semibold leading-[1.05] tracking-[-.045em] text-foreground">
                        Find the signal in everything you captured.
                      </h1>
                    </div>
                    <img src="/logo-atok.png" alt="Atok.ai" className="mt-1 h-10 w-10 rounded-lg opacity-60" />
                  </div>

                  <div className="grid gap-8 lg:grid-cols-[1fr_250px]">
                    <PromptInput onSubmit={handleSubmit} className="max-w-none self-start shadow-sm">
                    <PromptInputTextarea
                      value={input}
                      onChange={(e) => setInput(e.currentTarget.value)}
                      placeholder="Ask across notes, meetings, and tasks…"
                      minHeight={132}
                      maxHeight={260}
                      className="resize-none text-base"
                    />

                    <PromptInputToolbar className="justify-end">
                      <PromptInputSubmit
                        disabled={!input.trim() || status !== "ready"}
                        status={status}
                      />
                    </PromptInputToolbar>
                    </PromptInput>

                    <div className="border-l border-border pl-6">
                      <p className="mb-3 text-xs font-semibold text-foreground">Start with a question</p>
                      <div className="divide-y divide-border border-y border-border">
                        {SUGGESTIONS.map((suggestion, index) => (
                          <button
                            key={suggestion}
                            type="button"
                            onClick={() => setInput(suggestion)}
                            className="group flex w-full items-start gap-3 py-3 text-left text-[13px] leading-5 text-muted-foreground transition-colors hover:text-foreground"
                          >
                            <span className="font-mono text-[10px] text-muted-foreground/50">0{index + 1}</span>
                            <span>{suggestion}</span>
                          </button>
                        ))}
                      </div>
                      <p className="mt-4 text-xs leading-5 text-muted-foreground">
                        Answers are grounded in your private workspace.
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              /* Chat Messages */
              <div className="flex-1 overflow-y-auto">
                <div className="max-w-4xl mx-auto w-full px-4 sm:px-6 lg:px-8 py-8 space-y-7">
                  {messages.map((message) => (
                    <div
                      key={message.id}
                      className={`flex gap-4 ${
                        message.role === "user" ? "justify-end" : "justify-start"
                      }`}
                    >
                      {message.role === "assistant" ? (
                        <>
                          <div className="flex-shrink-0">
                            <img
                              src="/logo-atok.png"
                              alt="Atok.ai"
                              className="h-8 w-8 rounded-lg object-cover"
                            />
                          </div>
                          <div className="min-w-0 flex-1 pt-0.5">
                            {(message.steps?.length ?? 0) > 0 && (
                              <ActivityTrail steps={message.steps!} />
                            )}
                            {message.content && (
                              /* Assistant replies read as document text, not a boxed bubble. */
                              <div className="text-sm">
                                <MarkdownRenderer content={message.content} />
                              </div>
                            )}
                          </div>
                        </>
                      ) : (
                        <div className="max-w-[75%] rounded-xl rounded-br-sm bg-foreground px-4 py-2.5 text-background shadow-xs">
                          <p className="m-0 whitespace-pre-wrap text-sm leading-6">{message.content}</p>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </ConversationContent>

          <ConversationScrollButton />
        </Conversation>

        {/* Input Section - Only show when there are messages */}
        {messages.length > 0 && (
          <div className="border-t border-border bg-background/90 backdrop-blur-sm">
            <div className="max-w-4xl mx-auto w-full px-4 sm:px-6 lg:px-8 py-4">
              <PromptInput onSubmit={handleSubmit} className="max-w-none shadow-md">
                <PromptInputTextarea
                  value={input}
                  onChange={(e) => setInput(e.currentTarget.value)}
                  placeholder="Reply to the agent"
                  minHeight={48}
                  maxHeight={200}
                  className="resize-none"
                />

                <PromptInputToolbar className="justify-end">
                  <PromptInputSubmit
                    disabled={!input.trim() || status !== "ready"}
                    status={status}
                  />
                </PromptInputToolbar>
              </PromptInput>

              <div className="flex justify-between items-center mt-2 font-mono text-[11px] text-muted-foreground/70">
                <span>Enter to send, Shift+Enter for a new line</span>
                {status !== "ready" && (
                  <span className="flex items-center gap-1.5">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary"></span>
                    {status === "submitted" ? "thinking" : "working"}
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

/**
 * The agent's visible reasoning trail: thinking phases and tool calls, in
 * order. Running steps shimmer; finished steps settle into quiet mono rows.
 */
function ActivityTrail({ steps }: { steps: ActivityStep[] }) {
  const allDone = steps.every((s) => s.status === "done");

  return (
    <div className={`mb-3 flex flex-col gap-1.5 border-l-2 border-border pl-3.5 ${allDone ? "opacity-70" : ""}`}>
      {steps.map((step) => {
        const Icon = step.kind === "tool" ? Wrench : Sparkle;
        const running = step.status === "running";
        return (
          <div key={step.id} className="flex items-center gap-2">
            <Icon
              className={`h-3.5 w-3.5 shrink-0 ${running ? "animate-pulse text-primary" : "text-muted-foreground/60"}`}
              strokeWidth={1.75}
            />
            <span
              className={`font-mono text-[11.5px] capitalize ${
                running ? "shimmer-text" : "text-muted-foreground"
              }`}
            >
              {step.label}
            </span>
            {!running && (
              <Check className="h-3 w-3 shrink-0 text-primary/70" strokeWidth={2} />
            )}
          </div>
        );
      })}
    </div>
  );
}
