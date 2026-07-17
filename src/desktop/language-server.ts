import * as crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { buildMetadata } from "../cloud-direct/metadata.js";
import { iterFields } from "../cloud-direct/wire.js";

const DEVIN_APP_ROOT = "/Applications/Devin.app/Contents/Resources/app";
const LANGUAGE_SERVER = `${DEVIN_APP_ROOT}/extensions/windsurf/bin/language_server_macos_arm`;
const WINDSURF_VERSION = "3.4.27";
const STARTUP_TIMEOUT_MS = 60_000;

export interface DesktopLanguageServer {
	port: number;
	request(method: string, body?: Buffer, signal?: AbortSignal): Promise<Buffer>;
	close(): Promise<void>;
}

interface StartedInfo {
	languageServerPort: number;
}

function closeServer(server: http.Server | net.Server): Promise<void> {
	return new Promise((resolve) => server.close(() => resolve()));
}

function waitForExit(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null)
		return Promise.resolve();
	return new Promise((resolve) => child.once("exit", () => resolve()));
}

function decodeStarted(body: Buffer): StartedInfo {
	for (const field of iterFields(body)) {
		if (
			field.num === 1 &&
			field.wire === 0 &&
			typeof field.value === "bigint"
		) {
			return { languageServerPort: Number(field.value) };
		}
	}
	throw new Error("Devin language server startup callback omitted its port.");
}

/**
 * Start an isolated language server shipped with Devin Desktop.
 *
 * The persistent API key is sent only through child stdin as protobuf Metadata.
 * Local RPC authentication uses a random in-memory CSRF token inherited by the
 * child. Neither credential is placed in process arguments or diagnostics.
 */
export async function startDesktopLanguageServer(
	apiKey: string,
): Promise<DesktopLanguageServer> {
	if (process.platform !== "darwin" || process.arch !== "arm64") {
		throw new Error(
			"Devin desktop transport currently supports macOS ARM64 only.",
		);
	}
	if (!fs.existsSync(LANGUAGE_SERVER)) {
		throw new Error(
			`Devin Desktop language server not found at ${LANGUAGE_SERVER}`,
		);
	}

	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-devin-ls-"));
	const parentPipePath = path.join(tempDir, "parent.sock");
	const csrfToken = crypto.randomUUID();
	const extensionServer = http.createServer();
	const parentPipe = net.createServer();
	let child: ChildProcess | undefined;
	let closed = false;

	const started = new Promise<StartedInfo>((resolve, reject) => {
		const timer = setTimeout(
			() =>
				reject(
					new Error("Timed out waiting for Devin language server startup."),
				),
			STARTUP_TIMEOUT_MS,
		);
		extensionServer.on("request", async (request, response) => {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			if (
				request.method !== "POST" ||
				request.url !==
					"/exa.extension_server_pb.ExtensionServerService/LanguageServerStarted" ||
				request.headers["x-codeium-csrf-token"] !== csrfToken
			) {
				response.writeHead(404).end();
				return;
			}
			try {
				const info = decodeStarted(Buffer.concat(chunks));
				response.writeHead(200, { "content-type": "application/proto" }).end();
				clearTimeout(timer);
				resolve(info);
			} catch (error) {
				response.writeHead(400).end();
				clearTimeout(timer);
				reject(error);
			}
		});
	});

	try {
		await Promise.all([
			new Promise<void>((resolve, reject) => {
				extensionServer.once("error", reject);
				extensionServer.listen(0, "127.0.0.1", () => resolve());
			}),
			new Promise<void>((resolve, reject) => {
				parentPipe.once("error", reject);
				parentPipe.listen(parentPipePath, () => resolve());
			}),
		]);

		const address = extensionServer.address();
		if (!address || typeof address === "string") {
			throw new Error("Failed to allocate Devin extension callback port.");
		}

		child = spawn(
			LANGUAGE_SERVER,
			[
				"--api_server_url",
				"https://server.codeium.com",
				"--run_child",
				"--enable_lsp",
				"--extension_server_port",
				String(address.port),
				"--ide_name",
				"windsurf",
				"--random_port",
				"--inference_api_server_url",
				"https://inference.codeium.com",
				"--database_dir",
				path.join(tempDir, "database"),
				"--codeium_dir",
				".codeium/windsurf",
				"--extensions_dir",
				path.join(DEVIN_APP_ROOT, "extensions"),
				"--parent_pipe_path",
				parentPipePath,
				"--windsurf_version",
				WINDSURF_VERSION,
				"--stdin_initial_metadata",
				"--detect_proxy=false",
			],
			{
				env: {
					...process.env,
					CODEIUM_EDITOR_APP_ROOT: DEVIN_APP_ROOT,
					WINDSURF_CSRF_TOKEN: csrfToken,
				},
				stdio: ["pipe", "ignore", "pipe"],
			},
		);
		let stderr = "";
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString("utf8")).slice(-4000);
		});
		child.stdin?.end(
			buildMetadata({
				apiKey,
				sessionId: crypto.randomUUID(),
				requestId: BigInt(Date.now()),
				triggerId: crypto.randomUUID(),
				windsurfVersion: WINDSURF_VERSION,
			}),
		);
		child.once("exit", (code, signal) => {
			if (!closed && code !== 0) {
				extensionServer.emit(
					"error",
					new Error(
						`Devin language server exited before shutdown (${signal ?? code}). ${stderr}`,
					),
				);
			}
		});

		const { languageServerPort } = await started;

		return {
			port: languageServerPort,
			async request(method, body = Buffer.alloc(0), signal) {
				const response = await fetch(
					`http://127.0.0.1:${languageServerPort}/exa.language_server_pb.LanguageServerService/${method}`,
					{
						method: "POST",
						headers: {
							"content-type": "application/proto",
							"connect-protocol-version": "1",
							"x-codeium-csrf-token": csrfToken,
						},
						body,
						signal,
					},
				);
				const responseBody = Buffer.from(await response.arrayBuffer());
				if (!response.ok) {
					throw new Error(`${method} failed with HTTP ${response.status}.`);
				}
				return responseBody;
			},
			async close() {
				if (closed) return;
				closed = true;
				child?.kill("SIGTERM");
				await Promise.race([
					child ? waitForExit(child) : Promise.resolve(),
					new Promise((resolve) => setTimeout(resolve, 5_000)),
				]);
				if (child && child.exitCode === null && child.signalCode === null) {
					child.kill("SIGKILL");
				}
				await Promise.all([
					closeServer(extensionServer),
					closeServer(parentPipe),
				]);
				fs.rmSync(tempDir, { recursive: true, force: true });
			},
		};
	} catch (error) {
		closed = true;
		child?.kill("SIGTERM");
		extensionServer.close();
		parentPipe.close();
		fs.rmSync(tempDir, { recursive: true, force: true });
		throw error;
	}
}
