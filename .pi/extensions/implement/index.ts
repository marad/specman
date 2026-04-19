/**
 * Spec implementation tool — spawns a sub-agent that reads a spec,
 * implements it, verifies against ACs, and retrospects on the process.
 *
 * Usage: The LLM calls implement_spec with a FEAT-ID.
 * A pi sub-process implements the feature, runs tests, does AC-by-AC
 * verification, and reports dogfooding findings.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

interface ImplementationDetails {
	messages: Message[];
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens: number;
		turns: number;
	};
	model?: string;
	exitCode: number;
	stderr: string;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsage(u: ImplementationDetails["usage"], model?: string): string {
	const parts: string[] = [];
	if (u.turns) parts.push(`${u.turns} turn${u.turns > 1 ? "s" : ""}`);
	if (u.input) parts.push(`↑${formatTokens(u.input)}`);
	if (u.output) parts.push(`↓${formatTokens(u.output)}`);
	if (u.cacheRead) parts.push(`R${formatTokens(u.cacheRead)}`);
	if (u.cacheWrite) parts.push(`W${formatTokens(u.cacheWrite)}`);
	if (u.cost) parts.push(`$${u.cost.toFixed(4)}`);
	if (u.contextTokens > 0) parts.push(`ctx:${formatTokens(u.contextTokens)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

function getProgressSummary(messages: Message[]): string {
	// Look through messages for tool calls to infer progress
	let lastFile = "";
	let fileCount = 0;
	let testRuns = 0;

	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "tool_use") {
					if (part.name === "write" || part.name === "edit") {
						const input = part.input as Record<string, unknown>;
						if (input.path && typeof input.path === "string") {
							lastFile = input.path;
							fileCount++;
						}
					}
					if (part.name === "bash") {
						const input = part.input as Record<string, unknown>;
						if (typeof input.command === "string" && input.command.includes("deno test")) {
							testRuns++;
						}
					}
				}
			}
		}
	}

	const parts: string[] = [];
	if (fileCount > 0) parts.push(`${fileCount} file ops`);
	if (testRuns > 0) parts.push(`${testRuns} test runs`);
	if (lastFile) parts.push(`last: ${lastFile}`);
	return parts.length > 0 ? parts.join(", ") : "starting...";
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}
	return { command: "pi", args };
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "implement_spec",
		label: "Implement Spec",
		description:
			"Implement a feature from its spec file. Spawns a sub-agent that reads the spec, " +
			"writes implementation code and tests, verifies against every acceptance criterion, " +
			"and retrospects on the process with dogfooding feedback. " +
			"Use this to implement features spec-by-spec.",
		promptSnippet: "Implement a feature from spec, verify ACs, and report dogfooding findings",
		parameters: Type.Object({
			feat_id: Type.String({
				description:
					"The feature ID to implement, e.g. 'FEAT-0003'. " +
					"The spec file must exist in specs/.",
			}),
			guidance: Type.Optional(
				Type.String({
					description:
						"Optional implementation guidance or constraints, e.g. " +
						"'use the existing parser module', 'focus on the drift detection logic first'. " +
						"Passed to the sub-agent as additional context.",
				}),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentPromptPath = path.join(path.dirname(new URL(import.meta.url).pathname), "agent.md");

			// Build the task prompt
			let task = `Implement ${params.feat_id}.\n\n`;
			task += `Read the spec at specs/ (find the file matching ${params.feat_id}), `;
			task += `then follow your instructions to implement, test, verify, and retrospect.\n\n`;
			task += `The project uses Deno (TypeScript). Source code is in src/, CLI entry point is cli.ts, `;
			task += `project config is deno.json. Run tests with: deno test --allow-read --allow-write --allow-env --allow-run\n\n`;
			task += `Important: Read existing source files first to understand the codebase patterns and conventions.`;

			if (params.guidance) {
				task += `\n\nAdditional guidance: ${params.guidance}`;
			}

			const args: string[] = [
				"--mode",
				"json",
				"-p",
				"--no-session",
				"--append-system-prompt",
				agentPromptPath,
				task,
			];

			const details: ImplementationDetails = {
				messages: [],
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
				exitCode: 0,
				stderr: "",
			};

			const emitUpdate = () => {
				if (onUpdate) {
					const progress = getProgressSummary(details.messages);
					const output = getFinalOutput(details.messages) || `Implementing ${params.feat_id}... (${progress})`;
					onUpdate({
						content: [{ type: "text", text: output }],
						details,
					});
				}
			};

			try {
				const exitCode = await new Promise<number>((resolve) => {
					const invocation = getPiInvocation(args);
					const proc = spawn(invocation.command, invocation.args, {
						cwd: ctx.cwd,
						shell: false,
						stdio: ["ignore", "pipe", "pipe"],
					});
					let buffer = "";
					let updateThrottle: ReturnType<typeof setTimeout> | null = null;

					const throttledUpdate = () => {
						if (updateThrottle) return;
						updateThrottle = setTimeout(() => {
							updateThrottle = null;
							emitUpdate();
						}, 500);
					};

					const processLine = (line: string) => {
						if (!line.trim()) return;
						let event: any;
						try {
							event = JSON.parse(line);
						} catch {
							return;
						}

						if (event.type === "message_end" && event.message) {
							const msg = event.message as Message;
							// Only keep assistant final messages and tool results
							// to avoid unbounded memory growth
							if (msg.role === "assistant") {
								// Only keep the last assistant message (the final report)
								// Drop intermediate ones to save memory
								const lastAssistantIdx = details.messages.findLastIndex(
									(m) => m.role === "assistant"
								);
								if (lastAssistantIdx >= 0) {
									details.messages[lastAssistantIdx] = msg;
								} else {
									details.messages.push(msg);
								}
								details.usage.turns++;
								const usage = msg.usage;
								if (usage) {
									details.usage.input += usage.input || 0;
									details.usage.output += usage.output || 0;
									details.usage.cacheRead += usage.cacheRead || 0;
									details.usage.cacheWrite += usage.cacheWrite || 0;
									details.usage.cost += usage.cost?.total || 0;
									details.usage.contextTokens = usage.totalTokens || 0;
								}
								if (!details.model && msg.model) details.model = msg.model;
							}
							throttledUpdate();
						}
						// Skip tool_result_end — we don't need intermediate results
					};

					proc.stdout.on("data", (data: Buffer) => {
						buffer += data.toString();
						// Process complete lines immediately to keep the pipe draining
						let newlineIdx: number;
						while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
							const line = buffer.slice(0, newlineIdx);
							buffer = buffer.slice(newlineIdx + 1);
							processLine(line);
						}
					});

					proc.stderr.on("data", (data: Buffer) => {
						details.stderr += data.toString();
					});

					proc.on("close", (code: number | null) => {
						if (buffer.trim()) processLine(buffer);
						resolve(code ?? 0);
					});

					proc.on("error", () => {
						resolve(1);
					});

					if (signal) {
						const killProc = () => {
							proc.kill("SIGTERM");
							setTimeout(() => {
								if (!proc.killed) proc.kill("SIGKILL");
							}, 5000);
						};
						if (signal.aborted) killProc();
						else signal.addEventListener("abort", killProc, { once: true });
					}
				});

				details.exitCode = exitCode;

				const finalOutput = getFinalOutput(details.messages);
				if (exitCode !== 0 || !finalOutput) {
					const errorMsg = details.stderr || "(no output from implementation agent)";
					throw new Error(`Implementation failed (exit ${exitCode}): ${errorMsg}`);
				}

				return {
					content: [{ type: "text", text: finalOutput }],
					details,
				};
			} catch (error) {
				throw error;
			}
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("implement_spec"));
			text += " " + theme.fg("accent", args.feat_id);
			if (args.guidance) {
				const short = args.guidance.length > 60 ? args.guidance.slice(0, 57) + "..." : args.guidance;
				text += " " + theme.fg("muted", `(${short})`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as ImplementationDetails | undefined;
			const finalOutput = result.content[0]?.type === "text" ? result.content[0].text : "";
			const isError = result.isError;

			const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
			const mdTheme = getMarkdownTheme();

			if (expanded && finalOutput) {
				const container = new Container();
				container.addChild(
					new Text(`${icon} ${theme.fg("toolTitle", theme.bold("Spec Implementation"))}`, 0, 0),
				);
				container.addChild(new Spacer(1));
				container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));

				if (details) {
					const usageStr = formatUsage(details.usage, details.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
				}
				return container;
			}

			// Collapsed view
			let text = `${icon} ${theme.fg("toolTitle", theme.bold("Spec Implementation"))}`;

			if (isError) {
				text += "\n" + theme.fg("error", finalOutput.slice(0, 200));
			} else {
				// Extract verification table or summary
				const verifyMatch = finalOutput.match(/###\s*AC Verification\s*\n([\s\S]*?)(?=\n###|$)/);
				const retroMatch = finalOutput.match(/###\s*Dogfooding Retrospective\s*\n([\s\S]*?)(?=\n###|$)/);

				if (verifyMatch) {
					// Count pass/fail from the table
					const checks = (verifyMatch[1].match(/✅/g) || []).length;
					const warns = (verifyMatch[1].match(/⚠️/g) || []).length;
					const fails = (verifyMatch[1].match(/❌/g) || []).length;
					text += `\n${theme.fg("success", `✅ ${checks}`)} ${warns ? theme.fg("warning", `⚠️ ${warns}`) + " " : ""}${fails ? theme.fg("error", `❌ ${fails}`) : ""}`;
				}

				if (retroMatch) {
					const retro = retroMatch[1].trim();
					const firstFinding = retro.split("\n").find((l: string) => l.startsWith("**") || l.startsWith("-"));
					if (firstFinding) {
						text += "\n" + theme.fg("toolOutput", firstFinding.slice(0, 200));
					}
				}

				if (finalOutput.length > 300) {
					text += "\n" + theme.fg("muted", "(Ctrl+O to expand)");
				}
			}

			if (details) {
				const usageStr = formatUsage(details.usage, details.model);
				if (usageStr) {
					text += "\n" + theme.fg("dim", usageStr);
				}
			}

			return new Text(text, 0, 0);
		},
	});

	pi.registerCommand("implement", {
		description: "Implement a spec feature. Usage: /implement FEAT-0003 [optional guidance]",
		handler: async (args, _ctx) => {
			const parts = (args ?? "").trim().split(/\s+/);
			const featId = parts[0];
			const guidance = parts.slice(1).join(" ") || undefined;

			if (!featId || !/^FEAT-\d+$/i.test(featId)) {
				pi.sendUserMessage(
					"Usage: /implement FEAT-NNNN [optional guidance]\nExample: /implement FEAT-0003",
					{ deliverAs: "followUp" },
				);
				return;
			}

			const guidanceMsg = guidance ? ` with guidance: "${guidance}"` : "";
			pi.sendUserMessage(
				`Use the implement_spec tool to implement ${featId.toUpperCase()}${guidanceMsg}. After seeing the results, summarize the key findings and any spec changes needed.`,
				{ deliverAs: "followUp" },
			);
		},
	});
}
