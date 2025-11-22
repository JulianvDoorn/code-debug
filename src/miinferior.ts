import { MI2DebugSession } from './mibase';
import { DebugSession, InitializedEvent, TerminatedEvent, StoppedEvent, OutputEvent, Thread, StackFrame, Scope, Source, Handles } from 'vscode-debugadapter';
import { DebugProtocol } from 'vscode-debugprotocol';
import { MIError } from './backend/backend';
import { setFlagsFromString } from 'v8';

export interface AttachRequestArguments extends DebugProtocol.AttachRequestArguments {
	parentSession: MI2DebugSession | DebugSession,
	target: string
}

export class MI2InferiorSession extends DebugSession {
	superiorSession: MI2DebugSession;
	sessionPid: string | undefined;

	constructor(superiorSession: MI2DebugSession) {
		super(false, true);

		this.superiorSession = superiorSession;
	}

	protected override initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
		this.superiorSession.miDebugger.log("stdout", `intiialize request via inferior ${this.sessionPid}`);
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

	protected override attachRequest(response: DebugProtocol.AttachResponse, args: AttachRequestArguments): void {
		this.superiorSession.miDebugger.log("stdout", `attach request via inferior ${this.sessionPid}`);
		// Attached to server
		const pargs = JSON.stringify(args);

		this.sessionPid = args.target;

		this.superiorSession.miDebugger.log("stdout", "Received attach request!");
		this.superiorSession.miDebugger.log("stdout", this.sessionPid);
	}

	protected override disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments): void {
		this.superiorSession.miDebugger.log("stdout", `disconnect request via inferior ${this.sessionPid}`);
		this.superiorSession.disconnectRequest(response, args);
	}

	protected override async setVariableRequest(response: DebugProtocol.SetVariableResponse, args: DebugProtocol.SetVariableArguments): Promise<void> {
		this.superiorSession.miDebugger.log("stdout", `set variables request via inferior ${this.sessionPid}`);
		this.superiorSession.setVariableRequest(response, args);
	}

	protected override setFunctionBreakPointsRequest(response: DebugProtocol.SetFunctionBreakpointsResponse, args: DebugProtocol.SetFunctionBreakpointsArguments): void {
		this.superiorSession.miDebugger.log("stdout", `set function breakpoints request via inferior ${this.sessionPid}`);
		this.superiorSession.setFunctionBreakPointsRequest(response, args);
	}

	protected override setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {
		this.superiorSession.miDebugger.log("stdout", `set breakpoints request via inferior ${this.sessionPid}`);
		this.superiorSession.setBreakPointsRequest(response, args);
	}

	protected override threadsRequest(response: DebugProtocol.ThreadsResponse): void {
		this.superiorSession.miDebugger.log("stdout", `Received inferior thread request for ${this.sessionPid}`);

		if (!this.superiorSession.miDebugger) {
			this.sendResponse(response);
			return;
		}
		this.superiorSession.miDebugger.getThreads().then(threads => {
			response.body = {
				threads: []
			};
			for (const thread of threads) {
				const threadName = thread.name || thread.targetId || "<unnamed>";

				
				let pid = this.superiorSession.threadToPid.get(thread.id);


				if (pid == this.sessionPid) {
					this.superiorSession.miDebugger.log("stdout", `Found thead via inferior ${threadName}`)
					this.superiorSession.miDebugger.log("stdout", `pid == this.sessionPid (${pid} == ${this.sessionPid})`)
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

	protected override stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {
		this.superiorSession.miDebugger.log("stdout", `Stack trace request via inferior ${this.sessionPid}`);
		this.superiorSession.inferiorStackTraceRequest(response, args,
			(r: DebugProtocol.StackTraceResponse) => this.sendResponse(r),
			(r: DebugProtocol.StackTraceResponse, c: number, e: string) => this.sendErrorResponse(r, c, e)
		)
		this.superiorSession.miDebugger.log("stdout", `Stack trace request via inferior ${this.sessionPid} completed`);
	}

	protected override configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): void {
		this.superiorSession.miDebugger.log("stdout", `configuration done request via inferior ${this.sessionPid}`);
		this.superiorSession.configurationDoneRequest(response, args);
	}

	protected override scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {
		this.superiorSession.miDebugger.log("stdout", `scopes request via inferior ${this.sessionPid}`);
		this.superiorSession.scopesRequest(response, args);
	}

	protected override async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): Promise<void> {
		this.superiorSession.miDebugger.log("stdout", `variables request via inferior ${this.sessionPid}`);
		this.superiorSession.variablesRequest(response, args);
	}

	protected override pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments): void {
		this.superiorSession.miDebugger.log("stdout", `pause request via inferior ${this.sessionPid}`);
		this.superiorSession.pauseRequest(response, args);
	}

	protected override reverseContinueRequest(response: DebugProtocol.ReverseContinueResponse, args: DebugProtocol.ReverseContinueArguments): void {
		this.superiorSession.miDebugger.log("stdout", `reverse continue request via inferior ${this.sessionPid}`);
		this.superiorSession.reverseContinueRequest(response, args);
	}

	protected override continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
		this.superiorSession.miDebugger.log("stdout", `continue request via inferior ${this.sessionPid}`);
		this.superiorSession.continueRequest(response, args);
	}

	protected override stepBackRequest(response: DebugProtocol.StepBackResponse, args: DebugProtocol.StepBackArguments): void {
		this.superiorSession.miDebugger.log("stdout", `step back request via inferior ${this.sessionPid}`);
		this.superiorSession.stepBackRequest(response, args);
	}

	protected override stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): void {
		this.superiorSession.miDebugger.log("stdout", `step in request via inferior ${this.sessionPid}`);
		this.superiorSession.stepInRequest(response, args);
	}

	protected override stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): void {
		this.superiorSession.miDebugger.log("stdout", `step out request via inferior ${this.sessionPid}`);
		this.superiorSession.stepOutRequest(response, args);
	}

	protected override nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
		this.superiorSession.miDebugger.log("stdout", `next request via inferior ${this.sessionPid}`);
		this.superiorSession.nextRequest(response, args);
	}

	protected override evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): void {
		this.superiorSession.miDebugger.log("stdout", `evaluate request via inferior ${this.sessionPid}`);
		this.superiorSession.evaluateRequest(response, args);
	}

	protected override gotoTargetsRequest(response: DebugProtocol.GotoTargetsResponse, args: DebugProtocol.GotoTargetsArguments): void {
		this.superiorSession.miDebugger.log("stdout", `goto targets request via inferior ${this.sessionPid}`);
		this.superiorSession.gotoTargetsRequest(response, args);
	}

	protected override gotoRequest(response: DebugProtocol.GotoResponse, args: DebugProtocol.GotoArguments): void {
		this.superiorSession.miDebugger.log("stdout", `goto request via inferior ${this.sessionPid}`);
		this.superiorSession.gotoRequest(response, args);
	}
}
