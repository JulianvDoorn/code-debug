import { ExtendedVariable, MI2DebugSession, SharedState, VariableScope } from './mibase';
import { DebugSession, InitializedEvent, TerminatedEvent, StoppedEvent, OutputEvent, Thread, StackFrame, Scope, Source, Handles } from 'vscode-debugadapter';
import { Breakpoint, IBackend, Variable, VariableObject, ValuesFormattingMode, MIError } from './backend/backend';
import { expandValue, isExpandable } from './backend/gdb_expansion';
import { DebugProtocol } from 'vscode-debugprotocol';
import { setFlagsFromString } from 'v8';
import { MI2 } from './backend/mi2/mi2';
import { MINode } from './backend/mi_parse';

export interface InferiorAttachRequestArguments extends DebugProtocol.AttachRequestArguments {
	target: string
}

export class MI2InferiorSession extends DebugSession {
	constructor(shared: SharedState, debuggerLinesStartAt1?: boolean, isServer?: boolean) {
		super(debuggerLinesStartAt1, isServer);
		this.shared = shared;
	}

	protected sessionPid: string | undefined;
	protected useVarObjects: boolean;
	protected quit: boolean;
	protected attached: boolean;
	protected started: boolean;
	protected crashed: boolean;
	protected shared: SharedState;

	protected override initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
		// Same capabilities as GDBDebugSession
		response.body.supportsGotoTargetsRequest = true;
		response.body.supportsHitConditionalBreakpoints = true;
		response.body.supportsConfigurationDoneRequest = true;
		response.body.supportsConditionalBreakpoints = true;
		response.body.supportsFunctionBreakpoints = true;
		response.body.supportsEvaluateForHovers = true;
		response.body.supportsSetVariable = true;
		response.body.supportsStepBack = true;
		response.body.supportsLogPoints = true;
		this.sendResponse(response);
	}

	protected override disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments): void {
		this.sendResponse(response);
	}

	protected override async setVariableRequest(response: DebugProtocol.SetVariableResponse, args: DebugProtocol.SetVariableArguments): Promise<void> {
		try {
			if (this.useVarObjects) {
				let name = args.name;
				const parent = this.shared.variableHandles.get(args.variablesReference);
				if (parent instanceof VariableScope) {
					name = VariableScope.variableName(args.variablesReference, name);
				} else if (parent instanceof VariableObject) {
					name = `${parent.name}.${name}`;
				}

				const res = await this.shared.miDebugger.varAssign(name, args.value);
				response.body = {
					value: res.result("value")
				};
			} else {
				await this.shared.miDebugger.changeVariable(args.name, args.value);
				response.body = {
					value: args.value
				};
			}
			this.sendResponse(response);
		} catch (err) {
			this.sendErrorResponse(response, 11, `Could not continue: ${err}`);
		}
	}

	protected override threadsRequest(response: DebugProtocol.ThreadsResponse): void {
		if (!this.shared.miDebugger) {
			this.sendResponse(response);
			return;
		}
		this.shared.miDebugger.getThreads().then(threads => {
			response.body = {
				threads: []
			};
			for (const thread of threads) {
				const threadName = thread.name || thread.targetId || "<unnamed>";

				let pid = this.shared.threadToPid.get(thread.id);

				if (pid == this.sessionPid) {
					response.body.threads.push(new Thread(thread.id, `${thread.id}:${threadName}`));
				}
			}
			this.sendResponse(response);
		}).catch((error: MIError) => {
			if (error.message === 'Selected thread is running.') {
				this.sendResponse(response);
				return;
			}
			this.sendErrorResponse(response, 17, `Could not get threads: ${error}`);
		});
	}

	// Supports 65535 threads.
	protected threadAndLevelToFrameId(threadId: number, level: number) {
		return level << 16 | threadId;
	}
	protected frameIdToThreadAndLevel(frameId: number) {
		return [frameId & 0xffff, frameId >> 16];
	}

	protected override stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {
		this.shared.miDebugger.getStack(args.startFrame, args.levels, args.threadId).then(stack => {
			const ret: StackFrame[] = [];
			stack.forEach(element => {
				let source = undefined;
				let path = element.file;
				if (path) {
					if (this.shared.isSSH) {
						// convert ssh path to local path
						path = this.shared.sourceFileMap.toLocalPath(path);
					} else if (process.platform === "win32") {
						if (path.startsWith("\\cygdrive\\") || path.startsWith("/cygdrive/")) {
							path = path[10] + ":" + path.substring(11); // replaces /cygdrive/c/foo/bar.txt with c:/foo/bar.txt
						}
					}
					source = new Source(element.fileName, path);
				}

				ret.push(new StackFrame(
					this.threadAndLevelToFrameId(args.threadId, element.level),
					element.function + (element.address ? "@" + element.address : ""),
					source,
					element.line,
					0));
			});
			response.body = {
				stackFrames: ret
			};
			this.sendResponse(response);
		}, err => {
			this.sendErrorResponse(response, 12, `Failed to get Stack Trace: ${err.toString()}`);
		});
	}

	protected override scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {
		const scopes = new Array<Scope>();
		const [threadId, level] = this.frameIdToThreadAndLevel(args.frameId);

		const createScope = (scopeName: string, expensive: boolean): Scope => {
			const key: string = scopeName + ":" + threadId + ":" + level;
			let handle: number;

			if (this.shared.scopeHandlesReverse.hasOwnProperty(key)) {
				handle = this.shared.scopeHandlesReverse[key];
			} else {
				handle = this.shared.variableHandles.create(new VariableScope(scopeName, threadId, level));
				this.shared.scopeHandlesReverse[key] = handle;
			}

			return new Scope(scopeName, handle, expensive);
		};

		scopes.push(createScope("Locals", false));
		scopes.push(createScope("Registers", false));

		response.body = {
			scopes: scopes
		};
		this.sendResponse(response);
	}

	protected override async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): Promise<void> {
		const variables: DebugProtocol.Variable[] = [];
		const id: VariableScope | string | VariableObject | ExtendedVariable = this.shared.variableHandles.get(args.variablesReference);

		const createVariable = (arg: string | VariableObject, options?: any) => {
			if (options)
				return this.shared.variableHandles.create(new ExtendedVariable(typeof arg === 'string' ? arg : arg.name, options));
			else
				return this.shared.variableHandles.create(arg);
		};

		const findOrCreateVariable = (varObj: VariableObject): number => {
			let id: number;
			if (this.shared.variableHandlesReverse.hasOwnProperty(varObj.name)) {
				id = this.shared.variableHandlesReverse[varObj.name];
			} else {
				id = createVariable(varObj);
				this.shared.variableHandlesReverse[varObj.name] = id;
			}
			return varObj.isCompound() ? id : 0;
		};

		if (id instanceof VariableScope) {
			try {
				if (id.name === "Registers") {
					const registers = await this.shared.miDebugger.getRegisters();
					for (const reg of registers) {
						variables.push({
							name: reg.name,
							value: reg.valueStr,
							variablesReference: 0
						});
					}
				} else {
					const stack: Variable[] = await this.shared.miDebugger.getStackVariables(id.threadId, id.level);
					for (const variable of stack) {
						if (this.useVarObjects) {
							try {
								const varObjName = VariableScope.variableName(args.variablesReference, variable.name);
								let varObj: VariableObject;
								try {
									const changes = await this.shared.miDebugger.varUpdate(varObjName);
									const changelist = changes.result("changelist");
									changelist.forEach((change: any) => {
										const name = MINode.valueOf(change, "name");
										const vId = this.shared.variableHandlesReverse[name];
										const v = this.shared.variableHandles.get(vId) as any;
										v.applyChanges(change);
									});
									const varId = this.shared.variableHandlesReverse[varObjName];
									varObj = this.shared.variableHandles.get(varId) as any;
								} catch (err) {
									if (err instanceof MIError && (err.message === "Variable object not found" || err.message.endsWith("does not exist"))) {
										varObj = await this.shared.miDebugger.varCreate(id.threadId, id.level, variable.name, varObjName);
										const varId = findOrCreateVariable(varObj);
										varObj.exp = variable.name;
										varObj.id = varId;
									} else {
										throw err;
									}
								}
								variables.push(varObj.toProtocolVariable());
							} catch (err) {
								variables.push({
									name: variable.name,
									value: `<${err}>`,
									variablesReference: 0
								});
							}
						} else {
							if (variable.valueStr !== undefined) {
								let expanded = expandValue(createVariable, `{${variable.name}=${variable.valueStr})`, "", variable.raw);
								if (expanded) {
									if (typeof expanded[0] === "string")
										expanded = [
											{
												name: "<value>",
												value: prettyStringArray(expanded),
												variablesReference: 0
											}
										];
									variables.push(expanded[0]);
								}
							} else
								variables.push({
									name: variable.name,
									type: variable.type,
									value: variable.type,
									variablesReference: createVariable(variable.name)
								});
						}
					}
				}
				response.body = {
					variables: variables
				};
				this.sendResponse(response);
			} catch (err) {
				this.sendErrorResponse(response, 1, `Could not expand variable: ${err}`);
			}
		} else if (typeof id === "string") {
			// Variable members
			let variable;
			try {
				// TODO: this evaluates on an (effectively) unknown thread for multithreaded programs.
				variable = await this.shared.miDebugger.evalExpression(JSON.stringify(id), 0, 0);
				try {
					let variableValue = variable.result("value");
					const pattern = /'([^']*)' <repeats (\d+) times>/g;
					variableValue = variableValue.replace(pattern, (_: any, char: string, count: string) => {
						const repeatCount = parseInt(count, 10) + 1;
						const repeatedArray = Array(repeatCount).fill(char);
						return `{${repeatedArray.map(item => `'${item}'`).join(', ')}}`;
					});
					let expanded = expandValue(createVariable, variableValue, id, variable);
					if (!expanded) {
						this.sendErrorResponse(response, 2, `Could not expand variable`);
					} else {
						if (typeof expanded[0] === "string")
							expanded = [
								{
									name: "<value>",
									value: prettyStringArray(expanded),
									variablesReference: 0
								}
							];
						response.body = {
							variables: expanded
						};
						this.sendResponse(response);
					}
				} catch (e) {
					this.sendErrorResponse(response, 2, `Could not expand variable: ${e}`);
				}
			} catch (err) {
				this.sendErrorResponse(response, 1, `Could not expand variable: ${err}`);
			}
		} else if (typeof id === "object") {
			if (id instanceof VariableObject) {
				// Variable members
				let children: VariableObject[];
				try {
					children = await this.shared.miDebugger.varListChildren(id.name);
					const vars = children.map(child => {
						const varId = findOrCreateVariable(child);
						child.id = varId;
						return child.toProtocolVariable();
					});

					response.body = {
						variables: vars
					};
					this.sendResponse(response);
				} catch (err) {
					this.sendErrorResponse(response, 1, `Could not expand variable: ${err}`);
				}
			} else if (id instanceof ExtendedVariable) {
				const varReq = id;
				if (varReq.options.arg) {
					const strArr: DebugProtocol.Variable[] = [];
					let argsPart = true;
					let arrIndex = 0;
					const submit = () => {
						response.body = {
							variables: strArr
						};
						this.sendResponse(response);
					};
					const addOne = async () => {
						// TODO: this evaluates on an (effectively) unknown thread for multithreaded programs.
						const variable = await this.shared.miDebugger.evalExpression(JSON.stringify(`${varReq.name}+${arrIndex})`), 0, 0);
						try {
							const expanded = expandValue(createVariable, variable.result("value"), varReq.name, variable);
							if (!expanded) {
								this.sendErrorResponse(response, 15, `Could not expand variable`);
							} else {
								if (typeof expanded === "string") {
									if (expanded === "<nullptr>") {
										if (argsPart)
											argsPart = false;
										else
											return submit();
									} else if (expanded[0] !== '"') {
										strArr.push({
											name: "[err]",
											value: expanded,
											variablesReference: 0
										});
										return submit();
									}
									strArr.push({
										name: `[${(arrIndex++)}]`,
										value: expanded,
										variablesReference: 0
									});
									addOne();
								} else {
									strArr.push({
										name: "[err]",
										value: expanded,
										variablesReference: 0
									});
									submit();
								}
							}
						} catch (e) {
							this.sendErrorResponse(response, 14, `Could not expand variable: ${e}`);
						}
					};
					addOne();
				} else
					this.sendErrorResponse(response, 13, `Unimplemented variable request options: ${JSON.stringify(varReq.options)}`);
			} else {
				response.body = {
					variables: id
				};
				this.sendResponse(response);
			}
		} else {
			response.body = {
				variables: variables
			};
			this.sendResponse(response);
		}
	}

	protected override pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments): void {
		this.shared.miDebugger.interrupt(args.threadId).then(done => {
			this.sendResponse(response);
		}, msg => {
			this.sendErrorResponse(response, 3, `Could not pause: ${msg}`);
		});
	}

	protected override reverseContinueRequest(response: DebugProtocol.ReverseContinueResponse, args: DebugProtocol.ReverseContinueArguments): void {
		this.shared.miDebugger.continue(true, args.threadId).then(done => {
			if (!response.hasOwnProperty("body")) {
				response.body = Object();
			}

			response.body.allThreadsContinued = false;
			this.sendResponse(response);
		}, msg => {
			this.sendErrorResponse(response, 2, `Could not continue: ${msg}`);
		});
	}

	protected override continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
		this.shared.miDebugger.continue(false, args.threadId).then(done => {
			if (!response.hasOwnProperty("body")) {
				response.body = Object();
			}

			response.body.allThreadsContinued = false;
			this.sendResponse(response);
		}, msg => {
			this.sendErrorResponse(response, 2, `Could not continue: ${msg}`);
		});
	}

	protected override stepBackRequest(response: DebugProtocol.StepBackResponse, args: DebugProtocol.StepBackArguments): void {
		this.shared.miDebugger.step(true, args.threadId).then(done => {
			this.sendResponse(response);
		}, msg => {
			this.sendErrorResponse(response, 4, `Could not step back: ${msg} - Try running 'target record-full' before stepping back`);
		});
	}

	protected override stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): void {
		this.shared.miDebugger.step(false, args.threadId).then(done => {
			this.sendResponse(response);
		}, msg => {
			this.sendErrorResponse(response, 4, `Could not step in: ${msg}`);
		});
	}

	protected override stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): void {
		this.shared.miDebugger.stepOut(false, args.threadId).then(done => {
			this.sendResponse(response);
		}, msg => {
			this.sendErrorResponse(response, 5, `Could not step out: ${msg}`);
		});
	}

	protected override nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
		this.shared.miDebugger.next(false, args.threadId).then(done => {
			this.sendResponse(response);
		}, msg => {
			this.sendErrorResponse(response, 6, `Could not step over: ${msg}`);
		});
	}

	protected override evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): void {
		const [threadId, level] = this.frameIdToThreadAndLevel(args.frameId);
		if (args.context === "watch" || args.context === "hover") {
			this.shared.miDebugger.evalExpression(args.expression, threadId, level).then((res) => {
				response.body = {
					variablesReference: 0,
					result: res.result("value")
				};
				this.sendResponse(response);
			}, msg => {
				if (args.context === "hover") {
					// suppress error for hover as the user may just play with the mouse
					this.sendResponse(response);
				} else {
					this.sendErrorResponse(response, 7, msg.toString());
				}
			});
		} else {
			this.shared.miDebugger.sendUserInput(args.expression, threadId, level).then(output => {
				if (typeof output === "undefined")
					response.body = {
						result: "",
						variablesReference: 0
					};
				else
					response.body = {
						result: JSON.stringify(output),
						variablesReference: 0
					};
				this.sendResponse(response);
			}, msg => {
				this.sendErrorResponse(response, 8, msg.toString());
			});
		}
	}

	protected override gotoTargetsRequest(response: DebugProtocol.GotoTargetsResponse, args: DebugProtocol.GotoTargetsArguments): void {
		const path: string = this.shared.isSSH ? this.shared.sourceFileMap.toRemotePath(args.source.path) : args.source.path;
		this.shared.miDebugger.goto(path, args.line).then(done => {
			response.body = {
				targets: [{
					id: 1,
					label: args.source.name,
					column: args.column,
					line: args.line
				}]
			};
			this.sendResponse(response);
		}, msg => {
			this.sendErrorResponse(response, 16, `Could not jump: ${msg}`);
		});
	}

	protected override gotoRequest(response: DebugProtocol.GotoResponse, args: DebugProtocol.GotoArguments): void {
		this.sendResponse(response);
	}
}

function prettyStringArray(strings: any) {
	if (typeof strings === "object") {
		if (strings.length !== undefined)
			return strings.join(", ");
		else
			return JSON.stringify(strings);
	} else return strings;
}

export class MI2InferiorServer extends MI2InferiorSession {
	protected override attachRequest(response: DebugProtocol.AttachResponse, args: InferiorAttachRequestArguments): void {
		// Attached to server
		this.sessionPid = args.target;
	}
}