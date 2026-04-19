/**
 * Spec simulation tool — spawns a sub-agent that reads specs/ and walks through
 * end-to-end scenarios to find gaps, contradictions, and awkwardness.
 *
 * Usage: The LLM calls simulate_specs with an optional focus area.
 * A pi sub-process runs in JSON mode with a specialized system prompt,
 * reads the specs, simulates usage, and returns findings.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

interface SimulationDetails {
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

function formatUsage(u: SimulationDetails["usage"], model?: string): string {
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
		name: "simulate_specs",
		label: "Simulate Specs",
		description:
			"Simulate the system described in specs/ by walking through end-to-end user scenarios. " +
			"Spawns a sub-agent that reads all specs, mentally executes realistic scenarios, " +
			"and reports gaps, contradictions, and awkwardness. " +
			"Use this to validate specs before implementation.",
		promptSnippet: "Simulate spec-based system to find gaps, contradictions, and design issues before implementation",
		parameters: Type.Object({
			focus: Type.Optional(
				Type.String({
					description:
						"Optional focus area to prioritize, e.g. 'sync workflow failure recovery', " +
						"'multi-spec dependency ordering', 'editor + external edit conflict'. " +
						"If omitted, the agent covers all scenarios broadly.",
				}),
			),
			specs_dir: Type.Optional(
				Type.String({
					description: "Path to specs directory relative to project root. Defaults to 'specs/'.",
				}),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const specsDir = params.specs_dir ?? "specs";
			const agentPromptPath = path.join(path.dirname(new URL(import.meta.url).pathname), "agent.md");

			// Build the task prompt
			let task = `Read all spec files in ${specsDir}/ and simulate the system end-to-end as described in your instructions.`;
			if (params.focus) {
				task += `\n\nFocus area: ${params.focus}. Prioritize scenarios related to this area, but still cover other areas at a high level.`;
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

			const details: SimulationDetails = {
				messages: [],
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
				exitCode: 0,
				stderr: "",
			};

			const emitUpdate = () => {
				if (onUpdate) {
					const output = getFinalOutput(details.messages) || "(simulating...)";
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
							details.messages.push(msg);

							if (msg.role === "assistant") {
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
							emitUpdate();
						}

						if (event.type === "tool_result_end" && event.message) {
							details.messages.push(event.message as Message);
							emitUpdate();
						}
					};

					proc.stdout.on("data", (data: Buffer) => {
						buffer += data.toString();
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
					const errorMsg = details.stderr || "(no output from simulation agent)";
					throw new Error(`Simulation failed (exit ${exitCode}): ${errorMsg}`);
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
			let text = theme.fg("toolTitle", theme.bold("simulate_specs"));
			if (args.focus) {
				text += " " + theme.fg("accent", args.focus);
			} else {
				text += " " + theme.fg("muted", "(full coverage)");
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SimulationDetails | undefined;
			const finalOutput = result.content[0]?.type === "text" ? result.content[0].text : "";
			const isError = result.isError;

			const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
			const mdTheme = getMarkdownTheme();

			if (expanded && finalOutput) {
				const container = new Container();
				container.addChild(
					new Text(`${icon} ${theme.fg("toolTitle", theme.bold("Spec Simulation"))}`, 0, 0),
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

			// Collapsed: show summary
			let text = `${icon} ${theme.fg("toolTitle", theme.bold("Spec Simulation"))}`;

			if (isError) {
				text += "\n" + theme.fg("error", finalOutput.slice(0, 200));
			} else {
				// Extract summary section if present
				const summaryMatch = finalOutput.match(/###\s*Summary\s*\n([\s\S]*?)(?=\n###|$)/);
				if (summaryMatch) {
					text += "\n" + theme.fg("toolOutput", summaryMatch[1].trim().slice(0, 300));
				} else {
					text += "\n" + theme.fg("toolOutput", finalOutput.slice(0, 300));
				}
				if (finalOutput.length > 300) {
					text += theme.fg("muted", "\n(Ctrl+O to expand)");
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

	pi.registerCommand("simulate", {
		description: "Simulate specs to find gaps and contradictions. Optional: /simulate <focus area>",
		handler: async (args, ctx) => {
			const focus = args?.trim() || undefined;
			const focusMsg = focus ? ` with focus on "${focus}"` : "";
			pi.sendUserMessage(
				`Use the simulate_specs tool to simulate the specs${focusMsg} and report findings.`,
				{ deliverAs: "followUp" },
			);
		},
	});
}
