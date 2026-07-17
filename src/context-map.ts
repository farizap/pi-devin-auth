/**
 * Pure mapping module that converts pi's conversation model
 * (`Message[]`, `Tool[]`, `systemPrompt`) into the `ChatHistoryItem[]` +
 * `ToolDef[]` shapes that the cloud-direct gRPC layer expects.
 *
 * No side effects, no I/O — trivially unit-testable.
 */
import type { Context, Message, Tool } from '@earendil-works/pi-ai';
import type { ChatHistoryItem, ContentPart, ToolDef } from './cloud-direct/chat.js';

/** Result of mapping a pi {@link Context} into cloud-direct shapes. */
export interface MappedChat {
    messages: ChatHistoryItem[];
    tools: ToolDef[];
}

/** pi content-part shapes we care about for mapping. */
interface TextContent {
    type: 'text';
    text: string;
}
interface ImageContent {
    type: 'image';
    data: string;
    mimeType: string;
}
interface ThinkingContent {
    type: 'thinking';
    thinking: string;
}
interface ToolCallContent {
    type: 'toolCall';
    id: string;
    name: string;
    arguments: Record<string, unknown>;
}

/** Discriminated union of assistant content parts. */
type AssistantContentPart = TextContent | ThinkingContent | ToolCallContent;

/** User/toolResult content parts (no thinking, no toolCall). */
type UserContentPart = TextContent | ImageContent;

/**
 * Map pi user/toolResult content (string or array of text/image parts)
 * into the cloud-direct `ContentPart[]` form. String content is passed
 * through as-is (ChatHistoryItem.content accepts the string shorthand).
 */
function mapContent(
    content: string | UserContentPart[],
): string | ContentPart[] {
    if (typeof content === 'string') return content;
    const out: ContentPart[] = [];
    for (const part of content) {
        if (part.type === 'text') {
            out.push({ type: 'text', text: part.text });
        } else if (part.type === 'image') {
            out.push({
                type: 'image',
                mimeType: part.mimeType,
                base64Data: part.data,
            });
        }
        // Unknown part types are skipped.
    }
    return out;
}

/**
 * Extract visible text from an assistant message's content array.
 * Joins all `TextContent` entries with `\n`. `ThinkingContent` and
 * `ToolCall` entries are skipped — thinking is internal to the model
 * and tool calls are surfaced separately via {@link extractToolCalls}.
 */
function extractText(content: AssistantContentPart[]): string {
    const texts: string[] = [];
    for (const part of content) {
        if (part.type === 'text') texts.push(part.text);
    }
    return texts.join('\n');
}

/**
 * Extract tool calls from an assistant message's content array into the
 * cloud-direct `tool_calls` shape. `arguments` is serialized to a JSON
 * string (the cloud proto expects `arguments_json`). Returns `undefined`
 * when there are no tool calls so the `tool_calls` field stays absent on
 * the resulting {@link ChatHistoryItem}.
 */
function extractToolCalls(
    content: AssistantContentPart[],
): Array<{ id: string; name: string; arguments: string }> | undefined {
    const calls: Array<{ id: string; name: string; arguments: string }> = [];
    for (const part of content) {
        if (part.type === 'toolCall') {
            calls.push({
                id: part.id,
                name: part.name,
                arguments: JSON.stringify(part.arguments),
            });
        }
    }
    return calls.length > 0 ? calls : undefined;
}

/**
 * Map a single pi {@link Message} into a cloud-direct {@link ChatHistoryItem}.
 *
 * - `UserMessage`        -> `{ role: 'user', content: mapContent(...) }`
 * - `AssistantMessage`   -> `{ role: 'assistant', content: extractText(...),
 *                              tool_calls: extractToolCalls(...) }`
 * - `ToolResultMessage`  -> `{ role: 'tool', content: mapContent(...),
 *                              tool_call_id: msg.toolCallId }`
 */
function mapMessage(msg: Message): ChatHistoryItem {
    if (msg.role === 'user') {
        return {
            role: 'user',
            content: mapContent(msg.content as string | UserContentPart[]),
        };
    }
    if (msg.role === 'assistant') {
        const parts = msg.content as AssistantContentPart[];
        const toolCalls = extractToolCalls(parts);
        const item: ChatHistoryItem = {
            role: 'assistant',
            content: extractText(parts),
        };
        if (toolCalls !== undefined) item.tool_calls = toolCalls;
        return item;
    }
    // role === 'toolResult'
    return {
        role: 'tool',
        content: mapContent(msg.content as UserContentPart[]),
        tool_call_id: msg.toolCallId,
    };
}

/**
 * Convert a pi {@link Context} (systemPrompt + messages + tools) into the
 * `ChatHistoryItem[]` + `ToolDef[]` shapes consumed by the cloud-direct
 * gRPC chat layer.
 *
 * If `context.systemPrompt` is present it is prepended as a `system`
 * message; cloud-direct's `collapseSystemIntoUser` will inline it into
 * the next user turn downstream — we just pass it through here.
 */
export function mapContextToChat(context: Context): MappedChat {
    const messages: ChatHistoryItem[] = [];

    if (context.systemPrompt) {
        messages.push({ role: 'system', content: context.systemPrompt });
    }

    for (const msg of context.messages) {
        messages.push(mapMessage(msg));
    }

    const tools: ToolDef[] = (context.tools ?? []).map(
        (tool: Tool): ToolDef => ({
            name: tool.name,
            description: tool.description,
            // tool.parameters is a TSchema (JSON Schema object) — pass through.
            parameters: tool.parameters as unknown,
        }),
    );

    return { messages, tools };
}
