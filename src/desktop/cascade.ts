import * as crypto from "node:crypto";
import { buildMetadata } from "../cloud-direct/metadata.js";
import {
	encodeMessage,
	encodeString,
	encodeVarintField,
	iterFields,
} from "../cloud-direct/wire.js";
import type { DesktopLanguageServer } from "./language-server.js";

const WINDSURF_VERSION = "3.4.27";
const CASCADE_CLIENT_SOURCE = 1;

export interface DesktopCascade {
	id: string;
}

export interface DesktopCascadeClient {
	start(signal?: AbortSignal): Promise<DesktopCascade>;
	send(
		cascadeId: string,
		modelUid: string,
		text: string,
		toolNames?: string[],
		signal?: AbortSignal,
	): Promise<void>;
	getTrajectory(cascadeId: string, signal?: AbortSignal): Promise<Buffer>;
	delete(cascadeId: string, signal?: AbortSignal): Promise<void>;
}

function metadata(apiKey: string): Buffer {
	return buildMetadata({
		apiKey,
		sessionId: crypto.randomUUID(),
		requestId: BigInt(Date.now()),
		triggerId: crypto.randomUUID(),
		windsurfVersion: WINDSURF_VERSION,
	});
}

/**
 * CascadeToolConfig with MCP enabled. Field #16 is McpToolConfig; an empty
 * message preserves server defaults while making MCP availability explicit.
 */
function encodeToolConfig(toolNames: string[]): Buffer {
	const parts: Buffer[] = [];
	if (toolNames.includes("view_file")) {
		parts.push(encodeMessage(10, Buffer.alloc(0)));
	}
	return Buffer.concat(parts);
}

/**
 * CascadePlannerConfig:
 *   #2  conversational planner config
 *   #13 tool config
 *   #35 requested model UID
 */
function encodePlannerConfig(modelUid: string, toolNames: string[]): Buffer {
	// CascadeConversationalPlannerConfig #4 planner_mode. READ_ONLY=2 keeps
	// native file inspection available without enabling shell or edit tools.
	const conversationalMode = toolNames.includes("view_file") ? 2 : 3;
	return Buffer.concat([
		encodeMessage(2, encodeVarintField(4, conversationalMode)),
		encodeMessage(13, encodeToolConfig(toolNames)),
		encodeString(35, modelUid),
	]);
}

/**
 * CascadeConfig:
 *   #1 planner config
 *   #6 apply_model_default_override=true
 */
function encodeCascadeConfig(modelUid: string, toolNames: string[]): Buffer {
	return Buffer.concat([
		encodeMessage(1, encodePlannerConfig(modelUid, toolNames)),
		encodeVarintField(6, 1),
	]);
}

function decodeStringField(
	body: Buffer,
	fieldNumber: number,
): string | undefined {
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

/** Build a native Cascade client on top of an authenticated local LS. */
export function createDesktopCascadeClient(
	languageServer: DesktopLanguageServer,
	apiKey: string,
): DesktopCascadeClient {
	return {
		async start(signal) {
			// StartCascadeRequest:
			//   #1 metadata
			//   #4 source = CASCADE_CLIENT
			const request = Buffer.concat([
				encodeMessage(1, metadata(apiKey)),
				encodeVarintField(4, CASCADE_CLIENT_SOURCE),
			]);
			const response = await languageServer.request(
				"StartCascade",
				request,
				signal,
			);
			const id = decodeStringField(response, 1);
			if (!id) throw new Error("StartCascade response omitted cascade_id.");
			return { id };
		},

		async send(cascadeId, modelUid, text, toolNames = [], signal) {
			// TextOrScopeItem { #1 text }
			const item = encodeString(1, text);
			// SendUserCascadeMessageRequest:
			//   #1 cascade_id
			//   #2 items
			//   #3 metadata
			//   #5 cascade_config
			const request = Buffer.concat([
				encodeString(1, cascadeId),
				encodeMessage(2, item),
				encodeMessage(3, metadata(apiKey)),
				encodeMessage(5, encodeCascadeConfig(modelUid, toolNames)),
			]);
			await languageServer.request("SendUserCascadeMessage", request, signal);
		},

		async getTrajectory(cascadeId, signal) {
			return languageServer.request(
				"GetCascadeTrajectory",
				encodeString(1, cascadeId),
				signal,
			);
		},

		async delete(cascadeId, signal) {
			await languageServer.request(
				"DeleteCascadeTrajectory",
				encodeString(1, cascadeId),
				signal,
			);
		},
	};
}
