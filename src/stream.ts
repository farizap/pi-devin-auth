/**
 * pi `streamSimple` implementation for the Devin/Cognition provider.
 *
 * Calls the cloud-direct gRPC streaming layer (`streamChatEvents`) and
 * translates the resulting `CloudChatEvent` stream into pi's
 * `AssistantMessageEventStream` events.
 *
 * The async-IIFE pattern is the standard pi `streamSimple` shape: the
 * function returns a `AssistantMessageEventStream` synchronously and drives
 * the upstream async iterator inside an IIFE, pushing events as they
 * arrive.
 */
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
	calculateCost,
	createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { streamChatEvents, type CloudChatEvent } from "./cloud-direct/index.js";
import { mapContextToChat } from "./context-map.js";
import { streamClaudeToolShim } from "./claude-tool-shim.js";

/**
 * Stream a Devin/Cognition chat completion into pi's assistant-message
 * event stream.
 *
 * @param model     pi model descriptor (id, api, provider, cost, ...).
 * @param context   pi conversation context (systemPrompt, messages, tools).
 * @param options   streaming options (apiKey, maxTokens, signal, ...).
 * @returns an {@link AssistantMessageEventStream} that receives events
 *          as the upstream gRPC stream progresses.
 */
export function streamDevin(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	// Drive the upstream async iterator inside an IIFE so the returned
	// stream is populated asynchronously.
	void (async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		// Block-tracking state. Cognition's wire format has no
		// `tool_call_end` event, so the end of a tool call is implicit:
		// a new `tool_call_start` or stream `finish` closes the prior call.
		let textBlockOpen = false;
		let thinkingBlockOpen = false;
		let currentToolCallIndex = -1;
		let partialJson = "";
		let currentToolCallId = "";
		let currentToolCallName = "";

		try {
			const apiKey = options?.apiKey;
			if (!apiKey) throw new Error("No Devin API key. Run /login devin");

			const { messages, tools } = mapContextToChat(context);
			stream.push({ type: "start", partial: output });

			const events =
				model.id.startsWith("claude-") && tools.length > 0
					? streamClaudeToolShim(
							apiKey,
							model.id,
							context,
							options?.signal,
							options?.maxTokens,
						)
					: streamChatEvents({
							apiKey,
							modelUid: model.id,
							messages,
							tools: tools.length > 0 ? tools : undefined,
							signal: options?.signal,
							completionOpts: {
								maxOutputTokens: options?.maxTokens,
							},
						});
			for await (const ev of events) {
				handleEvent(ev);
			}

			// Safety: close any still-open blocks at stream end.
			closeTextBlock();
			closeThinkingBlock();
			if (currentToolCallIndex >= 0) {
				closeToolCall(
					stream,
					output,
					currentToolCallIndex,
					partialJson,
					currentToolCallId,
					currentToolCallName,
				);
				currentToolCallIndex = -1;
			}

			stream.push({
				type: "done",
				reason: output.stopReason as "stop" | "length" | "toolUse",
				message: output,
			});
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage =
				error instanceof Error ? error.message : String(error);
			stream.push({
				type: "error",
				reason: output.stopReason as "aborted" | "error",
				error: output,
			});
			stream.end();
		}

		/**
		 * Dispatch a single {@link CloudChatEvent} to the appropriate
		 * pi event(s), mutating `output` and the block-tracking state.
		 */
		function handleEvent(ev: CloudChatEvent): void {
			switch (ev.kind) {
				case "text": {
					// A text delta ends any open thinking block.
					closeThinkingBlock();
					if (!textBlockOpen) {
						output.content.push({ type: "text", text: "" });
						stream.push({
							type: "text_start",
							contentIndex: output.content.length - 1,
							partial: output,
						});
						textBlockOpen = true;
					}
					const idx = output.content.length - 1;
					const block = output.content[idx];
					if (block.type === "text") {
						block.text += ev.text;
						stream.push({
							type: "text_delta",
							contentIndex: idx,
							delta: ev.text,
							partial: output,
						});
					}
					break;
				}

				case "reasoning": {
					// A reasoning delta ends any open text block.
					closeTextBlock();
					if (!thinkingBlockOpen) {
						output.content.push({ type: "thinking", thinking: "" });
						stream.push({
							type: "thinking_start",
							contentIndex: output.content.length - 1,
							partial: output,
						});
						thinkingBlockOpen = true;
					}
					const idx = output.content.length - 1;
					const block = output.content[idx];
					if (block.type === "thinking") {
						block.thinking += ev.text;
						stream.push({
							type: "thinking_delta",
							contentIndex: idx,
							delta: ev.text,
							partial: output,
						});
					}
					break;
				}

				case "tool_call_start": {
					// A new tool call ends any open text/thinking block,
					// and implicitly closes the previous tool call.
					closeTextBlock();
					closeThinkingBlock();
					if (currentToolCallIndex >= 0) {
						closeToolCall(
							stream,
							output,
							currentToolCallIndex,
							partialJson,
							currentToolCallId,
							currentToolCallName,
						);
					}
					currentToolCallId = ev.id;
					currentToolCallName = ev.name;
					partialJson = "";
					output.content.push({
						type: "toolCall",
						id: ev.id,
						name: ev.name,
						arguments: {},
					});
					currentToolCallIndex = output.content.length - 1;
					stream.push({
						type: "toolcall_start",
						contentIndex: currentToolCallIndex,
						partial: output,
					});
					break;
				}

				case "tool_call_args": {
					// Defensive: args without a preceding start should not
					// happen on Cognition's wire format — ignore them.
					if (currentToolCallIndex < 0) break;
					partialJson += ev.argsDelta;
					const block = output.content[currentToolCallIndex];
					if (block.type === "toolCall") {
						try {
							block.arguments = JSON.parse(partialJson);
						} catch {
							// Incomplete JSON — keep accumulating deltas.
						}
					}
					stream.push({
						type: "toolcall_delta",
						contentIndex: currentToolCallIndex,
						delta: ev.argsDelta,
						partial: output,
					});
					break;
				}

				case "finish": {
					closeTextBlock();
					closeThinkingBlock();
					if (currentToolCallIndex >= 0) {
						closeToolCall(
							stream,
							output,
							currentToolCallIndex,
							partialJson,
							currentToolCallId,
							currentToolCallName,
						);
						currentToolCallIndex = -1;
					}
					output.stopReason =
						ev.reason === "tool_calls"
							? "toolUse"
							: ev.reason === "length"
								? "length"
								: "stop";
					break;
				}

				case "usage": {
					output.usage.input = ev.promptTokens ?? 0;
					output.usage.output = ev.completionTokens ?? 0;
					output.usage.cacheRead = ev.cachedInputTokens ?? 0;
					output.usage.cacheWrite = ev.cacheCreationInputTokens ?? 0;
					output.usage.totalTokens =
						ev.totalTokens ?? output.usage.input + output.usage.output;
					// calculateCost mutates output.usage.cost in place.
					calculateCost(model, output.usage);
					break;
				}
			}
		}

		/** Close the open text block, if any, emitting `text_end`. */
		function closeTextBlock(): void {
			if (!textBlockOpen) return;
			const idx = output.content.length - 1;
			const block = output.content[idx];
			if (block.type === "text") {
				stream.push({
					type: "text_end",
					contentIndex: idx,
					content: block.text,
					partial: output,
				});
			}
			textBlockOpen = false;
		}

		/** Close the open thinking block, if any, emitting `thinking_end`. */
		function closeThinkingBlock(): void {
			if (!thinkingBlockOpen) return;
			const idx = output.content.length - 1;
			const block = output.content[idx];
			if (block.type === "thinking") {
				stream.push({
					type: "thinking_end",
					contentIndex: idx,
					content: block.thinking,
					partial: output,
				});
			}
			thinkingBlockOpen = false;
		}
	})();

	return stream;
}

/**
 * Close a tool-call block: attempt a final JSON parse of the accumulated
 * args delta and emit `toolcall_end` with the resolved {@link ToolCall}.
 *
 * Defined at module scope so it is hoisted and usable from the IIFE
 * closure without forward-reference concerns.
 */
function closeToolCall(
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	index: number,
	partialJson: string,
	id: string,
	name: string,
): void {
	const block = output.content[index];
	if (block.type !== "toolCall") return;
	// One last parse attempt in case the final delta completed the JSON.
	try {
		block.arguments = JSON.parse(partialJson);
	} catch {
		// Leave arguments as the last successfully-parsed value (or `{}`).
	}
	stream.push({
		type: "toolcall_end",
		contentIndex: index,
		toolCall: { type: "toolCall", id, name, arguments: block.arguments },
		partial: output,
	});
}
