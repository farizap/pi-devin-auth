import type { Context } from "@earendil-works/pi-ai";
import type { CloudChatEvent } from "../cloud-direct/chat.js";
import { iterFields } from "../cloud-direct/wire.js";
import { createDesktopCascadeClient } from "./cascade.js";
import { startDesktopLanguageServer } from "./language-server.js";

const POLL_INTERVAL_MS = 250;
const CASCADE_TIMEOUT_MS = 180_000;

const CASCADE_TOOL_BY_PI_TOOL: Record<string, string> = {
	read: "view_file",
};

interface TrajectoryState {
	status: number;
	response: string;
	thinking: string;
	allStepsDone: boolean;
	error?: string;
}

function stringField(body: Buffer, fieldNumber: number): string | undefined {
	for (const field of iterFields(body)) {
		if (
			field.num === fieldNumber &&
			field.wire === 2 &&
			Buffer.isBuffer(field.value)
		) {
			return field.value.toString("utf8");
		}
	}
	return undefined;
}

function parseTrajectory(body: Buffer): TrajectoryState {
	let status = 0;
	let trajectory: Buffer | undefined;
	for (const field of iterFields(body)) {
		if (field.num === 1 && field.wire === 2 && Buffer.isBuffer(field.value)) {
			trajectory = field.value;
		} else if (
			field.num === 2 &&
			field.wire === 0 &&
			typeof field.value === "bigint"
		) {
			status = Number(field.value);
		}
	}

	let response = "";
	let thinking = "";
	let sawStep = false;
	let allStepsDone = true;
	let error: string | undefined;
	if (trajectory) {
		for (const trajectoryField of iterFields(trajectory)) {
			if (
				trajectoryField.num !== 2 ||
				trajectoryField.wire !== 2 ||
				!Buffer.isBuffer(trajectoryField.value)
			) {
				continue;
			}
			sawStep = true;
			const stepFields = [...iterFields(trajectoryField.value)];
			const stepStatus = stepFields.find(
				(field) => field.num === 4 && field.wire === 0,
			);
			if (stepStatus?.value !== 3n) allStepsDone = false;
			for (const stepField of stepFields) {
				if (
					stepField.num === 20 &&
					stepField.wire === 2 &&
					Buffer.isBuffer(stepField.value)
				) {
					response =
						stringField(stepField.value, 8) ??
						stringField(stepField.value, 1) ??
						response;
					thinking = stringField(stepField.value, 3) ?? thinking;
				} else if (
					stepField.num === 24 &&
					stepField.wire === 2 &&
					Buffer.isBuffer(stepField.value)
				) {
					error = stringField(stepField.value, 1) ?? "Cascade failed.";
				}
			}
		}
	}
	return {
		status,
		response,
		thinking,
		allStepsDone: sawStep && allStepsDone,
		error,
	};
}

function delta(previous: string, current: string): string {
	return current.startsWith(previous)
		? current.slice(previous.length)
		: current;
}

function textOfContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } =>
			Boolean(
				part &&
					typeof part === "object" &&
					(part as { type?: unknown }).type === "text" &&
					typeof (part as { text?: unknown }).text === "string",
			),
		)
		.map((part) => part.text)
		.join("\n");
}

function contextPrompt(context: Context): string {
	const parts: string[] = [];
	if (context.systemPrompt)
		parts.push(`<system>\n${context.systemPrompt}\n</system>`);
	for (const message of context.messages) {
		if (message.role === "user") {
			parts.push(`User:\n${textOfContent(message.content)}`);
		} else if (message.role === "assistant") {
			parts.push(`Assistant:\n${textOfContent(message.content)}`);
		} else {
			parts.push(`Tool result:\n${textOfContent(message.content)}`);
		}
	}
	return parts.join("\n\n");
}

function mapTools(context: Context): string[] {
	const tools = context.tools ?? [];
	const unsupported = tools
		.map((tool) => tool.name)
		.filter((name) => CASCADE_TOOL_BY_PI_TOOL[name] === undefined);
	if (unsupported.length > 0) {
		throw new Error(
			`Native Claude Cascade does not yet support pi tool(s): ${unsupported.join(", ")}. ` +
				"Supported tool: read.",
		);
	}
	return tools.map((tool) => CASCADE_TOOL_BY_PI_TOOL[tool.name]);
}

export function shouldUseDesktopCascade(
	modelUid: string,
	context: Context,
): boolean {
	return modelUid.startsWith("claude-") && (context.tools?.length ?? 0) > 0;
}

/**
 * Run one pi turn through native Devin Cascade. Cascade executes its allowed
 * built-in tools internally; this stream surfaces planner text/reasoning only.
 */
export async function* streamDesktopCascade(
	apiKey: string,
	modelUid: string,
	context: Context,
	signal?: AbortSignal,
): AsyncGenerator<CloudChatEvent> {
	const toolNames = mapTools(context);
	const languageServer = await startDesktopLanguageServer(apiKey);
	const client = createDesktopCascadeClient(languageServer, apiKey);
	let cascadeId: string | undefined;
	try {
		const cascade = await client.start(signal);
		cascadeId = cascade.id;
		await client.send(
			cascade.id,
			modelUid,
			contextPrompt(context),
			toolNames,
			signal,
		);

		const deadline = Date.now() + CASCADE_TIMEOUT_MS;
		let previousThinking = "";
		while (Date.now() < deadline) {
			if (signal?.aborted) throw signal.reason ?? new Error("Cascade aborted.");
			const state = parseTrajectory(
				await client.getTrajectory(cascade.id, signal),
			);
			if (state.error) throw new Error(state.error);

			const thinkingDelta = delta(previousThinking, state.thinking);
			if (thinkingDelta) yield { kind: "reasoning", text: thinkingDelta };
			previousThinking = state.thinking;

			// IDLE can occur between planner and tool steps. Completion is
			// IDLE with every trajectory step in DONE status.
			if (state.status === 1 && state.allStepsDone) {
				if (state.response) yield { kind: "text", text: state.response };
				yield { kind: "finish", reason: "stop" };
				return;
			}
			await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
		}
		throw new Error(
			`Native Claude Cascade timed out after ${CASCADE_TIMEOUT_MS}ms.`,
		);
	} finally {
		if (cascadeId) await client.delete(cascadeId).catch(() => undefined);
		await languageServer.close();
	}
}
