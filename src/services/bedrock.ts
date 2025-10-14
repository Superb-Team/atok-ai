/**
 * AWS Bedrock Service
 * Handles all interactions with Amazon Bedrock API for AI chat functionality
 */

import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
  type ContentBlock,
  type Message,
} from "@aws-sdk/client-bedrock-runtime";

// Type definitions for our chat messages
export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
}

// Bedrock client configuration
const bedrockClient = new BedrockRuntimeClient({
  region: import.meta.env.VITE_AWS_REGION || "ap-southeast-1",
  credentials: {
    accessKeyId: import.meta.env.VITE_AWS_ACCESS_KEY_ID || "",
    secretAccessKey: import.meta.env.VITE_AWS_SECRET_ACCESS_KEY || "",
  },
});

// Model configuration
const MODEL_ID = import.meta.env.VITE_AWS_BEDROCK_MODEL_ID || "apac.amazon.nova-pro-v1:0";

/**
 * Convert our chat messages to Bedrock message format
 * Also validates that conversation starts with user message (Bedrock requirement)
 */
function convertToChatMessages(messages: ChatMessage[]): Message[] {
  // Filter to only user and assistant messages
  const validMessages = messages.filter(
    (msg) => msg.role === "user" || msg.role === "assistant"
  );

  // Bedrock requires conversation to start with user message
  // Remove any leading assistant messages
  let startIndex = 0;
  while (
    startIndex < validMessages.length &&
    validMessages[startIndex].role === "assistant"
  ) {
    startIndex++;
  }

  const conversationMessages = validMessages.slice(startIndex);

  // Convert to Bedrock format
  return conversationMessages.map((msg) => ({
    role: msg.role,
    content: [{ text: msg.content }] as ContentBlock[],
  }));
}

/**
 * Send a single message to Bedrock and get complete response
 * (Non-streaming version)
 */
export async function sendMessage(
  messages: ChatMessage[]
): Promise<string> {
  try {
    const bedrockMessages = convertToChatMessages(messages);

    // Validate that we have messages after conversion
    if (bedrockMessages.length === 0) {
      throw new Error("No valid messages to send. Conversation must start with a user message.");
    }

    const command = new ConverseCommand({
      modelId: MODEL_ID,
      messages: bedrockMessages,
      inferenceConfig: {
        maxTokens: 4096,
        temperature: 0.7,
        topP: 0.9,
      },
    });

    const response = await bedrockClient.send(command);

    // Extract text from response
    const outputMessage = response.output?.message;
    if (!outputMessage?.content?.[0]) {
      throw new Error("No content in response");
    }

    const contentBlock = outputMessage.content[0];
    if ("text" in contentBlock) {
      return contentBlock.text || "";
    }

    throw new Error("Invalid response format");
  } catch (error) {
    console.error("Error sending message to Bedrock:", error);

    if (error instanceof Error) {
      // Check for common AWS errors
      if (error.message.includes("credentials")) {
        throw new Error("AWS credentials are invalid or missing. Please check your .env file.");
      }
      if (error.message.includes("AccessDeniedException")) {
        throw new Error("Access denied to Bedrock. Please check your IAM permissions.");
      }
      if (error.message.includes("ResourceNotFoundException")) {
        throw new Error(`Model ${MODEL_ID} not found in your region.`);
      }
      throw new Error(`Bedrock API error: ${error.message}`);
    }

    throw new Error("Unknown error occurred while sending message");
  }
}

/**
 * Send a message to Bedrock and stream the response in real-time
 * Returns an async generator that yields text chunks as they arrive
 */
export async function* sendMessageStream(
  messages: ChatMessage[]
): AsyncGenerator<string, void, unknown> {
  try {
    const bedrockMessages = convertToChatMessages(messages);

    // Validate that we have messages after conversion
    if (bedrockMessages.length === 0) {
      throw new Error("No valid messages to send. Conversation must start with a user message.");
    }

    const command = new ConverseStreamCommand({
      modelId: MODEL_ID,
      messages: bedrockMessages,
      inferenceConfig: {
        maxTokens: 4096,
        temperature: 0.7,
        topP: 0.9,
      },
    });

    const response = await bedrockClient.send(command);

    // Stream is an async iterable
    if (!response.stream) {
      throw new Error("No stream in response");
    }

    // Iterate through the stream events
    for await (const event of response.stream) {
      // Handle different event types
      if (event.contentBlockDelta) {
        // This contains the actual text chunks
        const delta = event.contentBlockDelta.delta;
        if (delta && "text" in delta && delta.text) {
          yield delta.text;
        }
      } else if (event.messageStart) {
        // Message started
        console.log("Stream started");
      } else if (event.messageStop) {
        // Message completed
        console.log("Stream completed");
        break;
      } else if (event.metadata) {
        // Metadata about the response (usage stats, etc.)
        console.log("Metadata:", event.metadata);
      }
    }
  } catch (error) {
    console.error("Error streaming message from Bedrock:", error);

    if (error instanceof Error) {
      // Check for common AWS errors
      if (error.message.includes("credentials")) {
        throw new Error("AWS credentials are invalid or missing. Please check your .env file.");
      }
      if (error.message.includes("AccessDeniedException")) {
        throw new Error("Access denied to Bedrock. Please check your IAM permissions.");
      }
      if (error.message.includes("ResourceNotFoundException")) {
        throw new Error(`Model ${MODEL_ID} not found in your region.`);
      }
      throw new Error(`Bedrock streaming error: ${error.message}`);
    }

    throw new Error("Unknown error occurred while streaming message");
  }
}

/**
 * Test connection to Bedrock
 * Sends a simple message to verify credentials and access
 */
export async function testBedrockConnection(): Promise<boolean> {
  try {
    const testMessages: ChatMessage[] = [
      {
        id: "test",
        role: "user",
        content: "Hello",
        timestamp: new Date(),
      },
    ];

    await sendMessage(testMessages);
    return true;
  } catch (error) {
    console.error("Bedrock connection test failed:", error);
    return false;
  }
}
