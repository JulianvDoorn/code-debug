import * as DebugAdapter from 'vscode-debugadapter';
import * as Net from 'net';
import { DebugSession, InitializedEvent, TerminatedEvent, StoppedEvent, ThreadEvent, OutputEvent, ContinuedEvent, Thread, StackFrame, Scope, Source, Handles, ExitedEvent } from 'vscode-debugadapter';
import { DebugProtocol } from 'vscode-debugprotocol';
import { Breakpoint, IBackend, Variable, VariableObject, ValuesFormattingMode, MIError } from './backend/backend';
import { MINode } from './backend/mi_parse';
import { MI2 } from './backend/mi2/mi2';
import { execSync } from 'child_process';
import * as systemPath from "path";
import * as net from "net";
import * as os from "os";
import * as fs from "fs";
import { SourceFileMap } from "./source_file_map";
import { MI2InferiorServer, MI2InferiorSession } from "./miinferior"

export enum RunCommand { CONTINUE, RUN, NONE }

export class ExtendedVariable {
	constructor(public name: string, public options: { "arg": any }) {
	}
}

export class VariableScope {
	constructor(public readonly name: string, public readonly threadId: number, public readonly level: number) {
	}

	public static variableName(handle: number, name: string): string {
		return `var_${handle}_${name}`;
	}
}

export class SharedState {
	miDebugger: MI2;
	threadGroupPids = new Map<string, string>();
	threadToPid = new Map<number, string>();
	mi2Inferiors = new Array();
	inferiorServers = new Array();
	variableHandles = new Handles<VariableScope | string | VariableObject | ExtendedVariable>();
	variableHandlesReverse: { [id: string]: number } = {};
	scopeHandlesReverse: { [key: string]: number } = {};
	stopAtEntry: boolean | string;
	isSSH: boolean;
	sourceFileMap: SourceFileMap;
}

export class MI2DebugSession extends MI2InferiorSession {
	protected initialRunCommand: RunCommand;
	protected commandServer: net.Server;
	protected serverPath: string;

	public constructor(shared: SharedState, debuggerLinesStartAt1?: boolean, isServer?: boolean) {
		super(shared, debuggerLinesStartAt1, isServer);
	}

	protected initDebugger() {
		this.shared.miDebugger.on("launcherror", this.launchError.bind(this));
		this.shared.miDebugger.on("quit", this.quitEvent.bind(this));
		this.shared.miDebugger.on("exited-normally", this.quitEvent.bind(this));
		this.shared.miDebugger.on("stopped", this.stopEvent.bind(this));
		this.shared.miDebugger.on("msg", this.handleMsg.bind(this));
		this.shared.miDebugger.on("breakpoint", this.handleBreakpoint.bind(this));
		this.shared.miDebugger.on("watchpoint", this.handleBreak.bind(this));	// consider to parse old/new, too (otherwise it is in the console only)
		this.shared.miDebugger.on("step-end", this.handleBreak.bind(this));
		//this.shared.miDebugger.on("step-out-end", this.handleBreak.bind(this));  // was combined into step-end
		this.shared.miDebugger.on("step-other", this.handleBreak.bind(this));
		this.shared.miDebugger.on("signal-stop", this.handlePause.bind(this));
		this.shared.miDebugger.on("thread-created", this.threadCreatedEvent.bind(this));
		this.shared.miDebugger.on("thread-exited", this.threadExitedEvent.bind(this));
		this.shared.miDebugger.once("debug-ready", (() => this.sendEvent(new InitializedEvent())));
		this.shared.miDebugger.on("thread-group-started", this.threadGroupStartedEvent.bind(this));
		this.shared.miDebugger.on("thread-group-exited", this.threadGroupExitedEvent.bind(this));
		this.sendEvent(new InitializedEvent());
		try {
			this.commandServer = net.createServer(c => {
				c.on("data", data => {
					const rawCmd = data.toString();
					const spaceIndex = rawCmd.indexOf(" ");
					let func = rawCmd;
					let args = [];
					if (spaceIndex !== -1) {
						func = rawCmd.substring(0, spaceIndex);
						args = JSON.parse(rawCmd.substring(spaceIndex + 1));
					}
					Promise.resolve((this.shared.miDebugger as any)[func].apply(this.shared.miDebugger, args)).then(data => {
						c.write(data.toString());
					});
				});
			});
			this.commandServer.on("error", err => {
				if (process.platform !== "win32")
					this.handleMsg("stderr", "Code-Debug WARNING: Utility Command Server: Error in command socket " + err.toString() + "\nCode-Debug WARNING: The examine memory location command won't work");
			});
			if (!fs.existsSync(systemPath.join(os.tmpdir(), "code-debug-sockets")))
				fs.mkdirSync(systemPath.join(os.tmpdir(), "code-debug-sockets"));
			this.commandServer.listen(this.serverPath = systemPath.join(os.tmpdir(), "code-debug-sockets", ("Debug-Instance-" + Math.floor(Math.random() * 36 * 36 * 36 * 36).toString(36)).toLowerCase()));
		} catch (e) {
			if (process.platform !== "win32")
				this.handleMsg("stderr", "Code-Debug WARNING: Utility Command Server: Failed to start " + e.toString() + "\nCode-Debug WARNING: The examine memory location command won't work");
		}
	}

	// verifies that the specified command can be executed
	protected checkCommand(debuggerName: string): boolean {
		try {
			if (process.platform === 'win32' && debuggerName.includes("\\")) {
				// For Windows paths containing backslashes, check if the file exists directly
				return fs.existsSync(debuggerName);
			}
			else {
				const command = process.platform === 'win32' ? 'where' : 'command -v';
				execSync(`${command} ${debuggerName}`, { stdio: 'ignore' });
				return true;
			}
		} catch (error) {
			return false;
		}
	}

	protected setValuesFormattingMode(mode: ValuesFormattingMode) {
		switch (mode) {
			case "disabled":
				this.useVarObjects = true;
				this.shared.miDebugger.prettyPrint = false;
				break;
			case "prettyPrinters":
				this.useVarObjects = true;
				this.shared.miDebugger.prettyPrint = true;
				break;
			case "parseText":
			default:
				this.useVarObjects = false;
				this.shared.miDebugger.prettyPrint = false;
		}
	}

	protected handleMsg(type: string, msg: string) {
		if (type === "target")
			type = "stdout";
		if (type === "log")
			type = "stderr";
		this.sendEvent(new OutputEvent(msg, type));
	}

	protected handleBreakpoint(info: MINode) {
		let threadId = info.record("thread-id");

		let threadPid = this.shared.threadToPid.get(parseInt(info.record("thread-id"), 10));

		const event = new StoppedEvent("breakpoint", parseInt(info.record("thread-id")));
		(event as DebugProtocol.StoppedEvent).body.allThreadsStopped = info.record("stopped-threads") === "all";

		if (threadPid == this.sessionPid) {
			this.sendEvent(event);
		} else {
			this.shared.mi2Inferiors.forEach(inferior => {
				if (threadPid == inferior.sessionPid) inferior.sendEvent(event)
			});
		}
	}

	protected handleBreak(info?: MINode) {
		let threadPid = this.shared.threadToPid.get(parseInt(info.record("thread-id"), 10));

		const event = new StoppedEvent("step", info ? parseInt(info.record("thread-id")) : 1);
		(event as DebugProtocol.StoppedEvent).body.allThreadsStopped = info ? info.record("stopped-threads") === "all" : true;

		if (threadPid == this.sessionPid) {
			this.sendEvent(event);
		} else {
			this.shared.mi2Inferiors.forEach(inferior => {
				if (threadPid == inferior.sessionPid) inferior.sendEvent(event)
			});
		}
	}

	protected handlePause(info: MINode) {
		let threadPid = this.shared.threadToPid.get(parseInt(info.record("thread-id"), 10));

		const event = new StoppedEvent("user request", parseInt(info.record("thread-id")));
		(event as DebugProtocol.StoppedEvent).body.allThreadsStopped = info.record("stopped-threads") === "all";

		if (threadPid == this.sessionPid) {
			this.sendEvent(event);
		} else {
			this.shared.mi2Inferiors.forEach(inferior => {
				if (threadPid == inferior.sessionPid) inferior.sendEvent(event)
			});
		}
	}

	protected stopEvent(info: MINode) {
		if (!this.started)
			this.crashed = true;
		if (!this.quit) {
			let threadPid = this.shared.threadToPid.get(parseInt(info.record("thread-id"), 10));

			const event = new StoppedEvent("exception", parseInt(info.record("thread-id")));
			(event as DebugProtocol.StoppedEvent).body.allThreadsStopped = info.record("stopped-threads") === "all";

			if (threadPid == this.sessionPid) {
				this.sendEvent(event);
			} else {
				this.shared.mi2Inferiors.forEach(inferior => {
					if (threadPid == inferior.sessionPid) inferior.sendEvent(event)
				});
			}
		}
	}

	protected threadCreatedEvent(info: MINode) {
		let threadId = parseInt(info.record("id"), 10);

		let threadPid = this.shared.threadGroupPids.get(info.record("group-id"));
		this.shared.threadToPid.set(threadId, threadPid);

		if (threadPid == this.sessionPid) {
			this.sendEvent(new ThreadEvent("started", threadId));
		} else {
			this.shared.mi2Inferiors.forEach(inferior => {
				if (threadPid == inferior.sessionPid) inferior.sendEvent(new ThreadEvent("started", threadId));
			});
		}
	}

	protected threadExitedEvent(info: MINode) {
		let threadId = parseInt(info.record("id"), 10);

		let threadPid = this.shared.threadGroupPids.get(info.record("group-id"));
		this.shared.threadToPid.delete(info.record("group-id"));

		if (threadPid == this.sessionPid) {
			this.sendEvent(new ThreadEvent("exited", threadId));
		} else {
			this.shared.mi2Inferiors.forEach(inferior => {
				if (threadPid == inferior.sessionPid) inferior.sendEvent(new ThreadEvent("exited", threadId));
			});
		}
	}

	private openInferiorDebugServer(superiorServer: MI2DebugSession) {
		function randomIntFromInterval(min: number, max: number) { // min and max included 
		return Math.floor(Math.random() * (max - min + 1) + min);
		}

		const port = 1337 + randomIntFromInterval(1, 1000);

		console.error(`waiting for debug protocol on port ${port}`);

		const server = Net.createServer((socket) => {
			console.error('>> accepted connection from client');
			socket.on('end', () => {
				console.error('>> client connection closed\n');
			});
			const session = new MI2InferiorServer(this.shared, false, true);
			session.setRunAsServer(true);
			session.start(socket, socket);

			this.shared.mi2Inferiors.push(session);
		}).listen(port);

		this.shared.inferiorServers.push(server);
		
		return server;
	}

	protected threadGroupStartedEvent(info: MINode) {
		if (!this.shared.miDebugger.multiProcess) {
			return;
		}

		let pid = info.record("pid");

		if (typeof this.sessionPid === "undefined") {
			this.sessionPid = pid;
		}

		this.shared.threadGroupPids.set(info.record("id"), info.record("pid"));

		// If there are more than 1 threadgroups active, start a new debugger session in VSCode
		// This makes the UI all fancy with subprocesses and threads etc.
		if (this.shared.threadGroupPids.size > 1) {
			// Open a new port for the new DebugSession to attach to
			const server = this.openInferiorDebugServer(this);
			const serverAddress = (server.address() as Net.AddressInfo).port;

			// Necessary until vscode-debugadapter-node supports `startDebuggingRequest`
			this.sendRequest('startDebugging', {
				request: "attach",
				configuration: {
					type: "gdb-inferior",
					target: info.record("pid"),
					name: "Child session",
					cwd: "${workspaceRoot}",
					debugServer: serverAddress
				}
			}, 1000, () => {});

			// this.startDebuggingRequest({
			// 	request: "attach",
			// 	configuration: {
			// 		type: "gdb-inferior",
			// 		target: info.record("pid"),
			// 		name: "Child session",
			// 		cwd: "${workspaceRoot}",
			// 		debugServer: serverAddress
			// 	}
			// }, 1000, () => {})
		}
	}

	protected threadGroupExitedEvent(info: MINode) {
		if (!this.shared.miDebugger.multiProcess) {
			return;
		}

		let pid = this.shared.threadGroupPids.get(info.record("id"));
		let exit_code = info.record("exit-code");

		if (pid == this.sessionPid) {
			// Session has no thread group anymore. Next started thread group will be debugged by this session
			this.sessionPid = undefined;
			this.sendEvent(new ExitedEvent(exit_code));
		}

		this.shared.threadGroupPids.delete(info.record("id"));
	}

	protected quitEvent(info?: MINode) {
		this.quit = true;
		this.sendEvent(new ExitedEvent(0));

		if (this.serverPath)
			fs.unlink(this.serverPath, (err) => {
			// eslint-disable-next-line no-console
			console.error("Failed to unlink debug server");
			});
	}

	protected launchError(err: any) {
		this.handleMsg("stderr", "Could not start debugger process, does the program exist in filesystem?\n");
		this.handleMsg("stderr", err.toString() + "\n");
		this.quitEvent();
	}

	public override disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments): void {
		if (this.attached)
			this.shared.miDebugger.detach();
		else
			this.shared.miDebugger.stop();
		this.commandServer.close();
		this.commandServer = undefined;
		this.sendResponse(response);
	}

	public override setFunctionBreakPointsRequest(response: DebugProtocol.SetFunctionBreakpointsResponse, args: DebugProtocol.SetFunctionBreakpointsArguments): void {
		const all: Thenable<[boolean, Breakpoint]>[] = [];
		args.breakpoints.forEach(brk => {
			all.push(this.shared.miDebugger.addBreakPoint({ raw: brk.name, condition: brk.condition, countCondition: brk.hitCondition }));
		});
		Promise.all(all).then(brkpoints => {
			const finalBrks: DebugProtocol.Breakpoint[] = [];
			brkpoints.forEach(brkp => {
				if (brkp[0])
					finalBrks.push({ line: brkp[1].line, verified: true });
			});
			response.body = {
				breakpoints: finalBrks
			};
			this.sendResponse(response);
		}, msg => {
			this.sendErrorResponse(response, 10, msg.toString());
		});
	}

	public override setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {
		let path = args.source.path;
		if (this.shared.isSSH) {
			// convert local path to ssh path
			path = this.shared.sourceFileMap.toRemotePath(path);
		}
		this.shared.miDebugger.clearBreakPoints(path).then(() => {
			const all = args.breakpoints.map(brk => {
				return this.shared.miDebugger.addBreakPoint({ file: path, line: brk.line, condition: brk.condition, countCondition: brk.hitCondition, logMessage: brk.logMessage });
			});
			Promise.all(all).then(brkpoints => {
				const finalBrks: DebugProtocol.Breakpoint[] = [];
				brkpoints.forEach(brkp => {
					// TODO: Currently all breakpoints returned are marked as verified,
					// which leads to verified breakpoints on a broken lldb.
					if (brkp[0])
						finalBrks.push(new DebugAdapter.Breakpoint(true, brkp[1].line));
				});
				response.body = {
					breakpoints: finalBrks
				};
				this.sendResponse(response);
			}, msg => {
				this.sendErrorResponse(response, 9, msg.toString());
			});
		}, msg => {
			this.sendErrorResponse(response, 9, msg.toString());
		});
	}

	public override configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): void {
		const promises: Thenable<any>[] = [];
		let entryPoint: string | undefined = undefined;
		let runToStart: boolean = false;
		// Setup temporary breakpoint for the entry point if needed.
		switch (this.initialRunCommand) {
			case RunCommand.CONTINUE:
			case RunCommand.NONE:
				if (typeof this.shared.stopAtEntry === 'boolean' && this.shared.stopAtEntry)
					entryPoint = "main"; // sensible default
				else if (typeof this.shared.stopAtEntry === 'string')
					entryPoint = this.shared.stopAtEntry;
				break;
			case RunCommand.RUN:
				if (typeof this.shared.stopAtEntry === 'boolean' && this.shared.stopAtEntry) {
					if (this.shared.miDebugger.features.includes("exec-run-start-option"))
						runToStart = true;
					else
						entryPoint = "main"; // sensible fallback
				} else if (typeof this.shared.stopAtEntry === 'string')
					entryPoint = this.shared.stopAtEntry;
				break;
			default:
				throw new Error('Unhandled run command: ' + RunCommand[this.initialRunCommand]);
		}
		if (entryPoint)
			promises.push(this.shared.miDebugger.setEntryBreakPoint(entryPoint));
		switch (this.initialRunCommand) {
			case RunCommand.CONTINUE:
				promises.push(this.shared.miDebugger.continue().then(() => {
					// Some debuggers will provide an out-of-band status that they are stopped
					// when attaching (e.g., gdb), so the client assumes we are stopped and gets
					// confused if we start running again on our own.
					//
					// If we don't send this event, the client may start requesting data (such as
					// stack frames, local variables, etc.) since they believe the target is
					// stopped.  Furthermore, the client may not be indicating the proper status
					// to the user (may indicate stopped when the target is actually running).
					this.sendEvent(new ContinuedEvent(1, true));
				}));
				break;
			case RunCommand.RUN:
				promises.push(this.shared.miDebugger.start(runToStart).then(() => {
					this.started = true;
					if (this.crashed)
						this.handlePause(undefined);
				}));
				break;
			case RunCommand.NONE: {
				// Not all debuggers seem to provide an out-of-band status that they are stopped
				// when attaching (e.g., lldb), so the client assumes we are running and gets
				// confused when we don't actually run or continue.  Therefore, we'll force a
				// stopped event to be sent to the client (just in case) to synchronize the state.
				const event: DebugProtocol.StoppedEvent = new StoppedEvent("pause", 1);
				event.body.description = "paused on attach";
				event.body.allThreadsStopped = true;
				this.sendEvent(event);
				break;
			}
			default:
				throw new Error('Unhandled run command: ' + RunCommand[this.initialRunCommand]);
		}
		Promise.all(promises).then(() => {
			this.sendResponse(response);
		}).catch(err => {
			this.sendErrorResponse(response, 18, `Could not run/continue: ${err.toString()}`);
		});
	}

	protected setSourceFileMap(configMap: { [index: string]: string }, fallbackGDB: string, fallbackIDE: string): void {
		if (configMap === undefined) {
			this.shared.sourceFileMap = new SourceFileMap({ [fallbackGDB]: fallbackIDE });
		} else {
			this.shared.sourceFileMap = new SourceFileMap(configMap, fallbackGDB);
		}
	}
}

