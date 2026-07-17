import * as crypto from "node:crypto";
import type { Context } from "@earendil-works/pi-ai";
import {
	streamChatEvents,
	type ChatHistoryItem,
	type CloudChatEvent,
} from "./cloud-direct/index.js";
import { mapContextToChat } from "./context-map.js";

const TOOL_PROTOCOL = `You have pi tools available. To call tools, reply with only valid JSON matching this shape:
{"tool_calls":[{"name":"tool_name","arguments":{}}]}

Use only listed tool names. arguments must match each tool JSON Schema. Do not wrap JSON in Markdown. Do not include explanatory text with a tool-call response. Never output <pi_tool_calls> or <pi_tool_result> tags; those are prior-turn history only. After a tool result, continue the task. For a final answer, reply normally without a tool_calls object.`;

interface ToolCallEnvelope {
	tool_calls: Array<{
		name: string;
		arguments: unknown;
	}>;
}

function toolCatalog(context: Context): string {
	return JSON.stringify(
		(context.tools ?? []).map((tool) => ({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		})),
	);
}

function textOf(content: ChatHistoryItem["content"]): string {
	if (typeof content === "string") return content;
	return content
		.filter(
			(part): part is { type: "text"; text: string } => part.type === "text",
		)
		.map((part) => part.text)
		.join("\n");
}

/**
 * Render prior pi tool calls and results as plain text. Claude's direct chat
 * adapter rejects protobuf tool fields, so all tool state must remain prompt
 * text for every continuation turn.
 */
function textToolHistory(messages: ChatHistoryItem[]): ChatHistoryItem[] {
	return messages.map((message) => {
		if (message.role === "assistant" && message.tool_calls?.length) {
			return {
				role: "assistant",
				content: `${textOf(message.content)}\n<pi_tool_calls>${JSON.stringify(message.tool_calls)}</pi_tool_calls>`,
			};
		}
		if (message.role === "tool") {
			return {
				role: "user",
				content: `<pi_tool_result tool_call_id="${message.tool_call_id ?? ""}">\n${textOf(message.content)}\n</pi_tool_result>`,
			};
		}
		return { role: message.role, content: message.content };
	});
}

function parseToolCalls(
	text: string,
	allowedNames: Set<string>,
): ToolCallEnvelope | undefined {
	const trimmed = text.trim();
	const historyMatch = trimmed.match(
		/^<pi_tool_calls>\s*([\s\S]*?)\s*<\/pi_tool_calls>$/,
	);
	const json = historyMatch
		? historyMatch[1]
		: trimmed.startsWith("```")
			? trimmed.replace(/^```(?:json)?\s*|\s*```$/g, "")
			: trimmed;
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		return undefined;
	}
	const calls = Array.isArray(value)
		? value
		: value &&
				typeof value === "object" &&
				Array.isArray((value as ToolCallEnvelope).tool_calls)
			? (value as ToolCallEnvelope).tool_calls
			: undefined;
	if (!calls) return undefined;
	if (
		calls.length === 0 ||
		calls.some(
			(call) =>
				!call ||
				typeof call.name !== "string" ||
				!allowedNames.has(call.name) ||
				!call.arguments ||
				typeof call.arguments !== "object" ||
				Array.isArray(call.arguments),
		)
	) {
		return undefined;
	}
	return { tool_calls: calls };
}

/**
 * Claude compatibility layer for Cognition's direct chat endpoint.
 *
 * The endpoint accepts Claude text generation but rejects native protobuf
 * tools. This wrapper supplies the active pi tool catalog in the prompt,
 * translates a strict JSON response back into normal pi tool-call events, and
 * renders later tool history as text. Any pi tool active in Context is picked
 * up automatically.
 */
export async function* streamClaudeToolShim(
	apiKey: string,
	modelUid: string,
	context: Context,
	signal?: AbortSignal,
	maxOutputTokens?: number,
): AsyncGenerator<CloudChatEvent> {
	const mapped = mapContextToChat(context);
	const tools = context.tools ?? [];
	const allowedNames = new Set(tools.map((tool) => tool.name));
	const messages: ChatHistoryItem[] = [
		{
			role: "system",
			content: `${TOOL_PROTOCOL}\n\n<pi_tools>${toolCatalog(context)}</pi_tools>`,
		},
		...textToolHistory(mapped.messages),
	];

	let response = "";
	let finish: Extract<CloudChatEvent, { kind: "finish" }>["reason"] = "stop";
	for await (const event of streamChatEvents({
		apiKey,
		modelUid,
		messages,
		// Critical: no native protobuf tools for Claude.
		tools: undefined,
		signal,
		completionOpts: { maxOutputTokens },
	})) {
		if (event.kind === "text") {
			response += event.text;
		} else if (event.kind === "finish") {
			finish = event.reason;
		} else if (event.kind === "reasoning" || event.kind === "usage") {
			yield event;
		}
	}

	const envelope = parseToolCalls(response, allowedNames);
	if (envelope) {
		for (const call of envelope.tool_calls) {
			const id = `call_${crypto.randomUUID()}`;
			yield { kind: "tool_call_start", id, name: call.name };
			yield {
				kind: "tool_call_args",
				id,
				argsDelta: JSON.stringify(call.arguments),
			};
		}
		yield { kind: "finish", reason: "tool_calls" };
		return;
	}

	if (response) yield { kind: "text", text: response };
	yield { kind: "finish", reason: finish };
}
