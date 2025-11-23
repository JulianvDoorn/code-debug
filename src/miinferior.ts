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
		this.superiorSession.inferiorThreadsRequest(response,
			this.sessionPid,
			(r: DebugProtocol.ThreadsResponse) => this.sendResponse(r),
			(r: DebugProtocol.ThreadsResponse, c: number, e: string) => this.sendErrorResponse(r, c, e)
		)
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
		this.superiorSession.inferiorScopesRequest(response, args, (r: DebugProtocol.Response) => this.sendResponse(r))
	}

	protected override async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): Promise<void> {
		this.superiorSession.miDebugger.log("stdout", `variables request via inferior ${this.sessionPid}`);
		this.superiorSession.inferiorVariablesRequest(response, args,
			(r: DebugProtocol.Response) => this.sendResponse(r),
			(r: DebugProtocol.Response, n: number, s: string) => this.sendErrorResponse(r, n, s) 
		);
	}

	protected override pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments): void {
		this.superiorSession.miDebugger.log("stdout", `pause request via inferior ${this.sessionPid}`);
		this.superiorSession.miDebugger.interrupt(args.threadId).then(done => {
			this.sendResponse(response);
		}, msg => {
			this.sendErrorResponse(response, 3, `Could not pause: ${msg}`);
		});
	}

	protected override reverseContinueRequest(response: DebugProtocol.ReverseContinueResponse, args: DebugProtocol.ReverseContinueArguments): void {
		this.superiorSession.miDebugger.log("stdout", `reverse continue request via inferior ${this.sessionPid}`);
		this.superiorSession.miDebugger.continue(true, args.threadId).then(done => {
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
		this.superiorSession.miDebugger.log("stdout", `continue request via inferior ${this.sessionPid}`);
		this.superiorSession.miDebugger.continue(false, args.threadId).then(done => {
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
		this.superiorSession.miDebugger.log("stdout", `step back request via inferior ${this.sessionPid}`);
		this.superiorSession.miDebugger.step(true, args.threadId).then(done => {
			this.sendResponse(response);
		}, msg => {
			this.sendErrorResponse(response, 4, `Could not step back: ${msg} - Try running 'target record-full' before stepping back`);
		});
	}

	protected override stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): void {
		this.superiorSession.miDebugger.log("stdout", `step in request via inferior ${this.sessionPid}`);
		this.superiorSession.miDebugger.step(false, args.threadId).then(done => {
			this.sendResponse(response);
		}, msg => {
			this.sendErrorResponse(response, 4, `Could not step in: ${msg}`);
		});
	}

	protected override stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): void {
		this.superiorSession.miDebugger.log("stdout", `step out request via inferior ${this.sessionPid}`);
		this.superiorSession.miDebugger.stepOut(false, args.threadId).then(done => {
			this.sendResponse(response);
		}, msg => {
			this.sendErrorResponse(response, 5, `Could not step out: ${msg}`);
		});
	}

	protected override nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
		this.superiorSession.miDebugger.log("stdout", `next request via inferior ${this.sessionPid}`);
		this.superiorSession.miDebugger.next(false, args.threadId).then(done => {
			this.sendResponse(response);
		}, msg => {
			this.sendErrorResponse(response, 6, `Could not step over: ${msg}`);
		});
	}

	protected override evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): void {
		this.superiorSession.miDebugger.log("stdout", `evaluate request via inferior ${this.sessionPid}`);
		this.superiorSession.inferiorEvaluateRequest(response, args,
			(r: DebugProtocol.Response) => this.sendResponse(r),
			(r: DebugProtocol.Response, n: number, s: string) => this.sendErrorResponse(r, n, s) 
		);
	}

	protected override gotoTargetsRequest(response: DebugProtocol.GotoTargetsResponse, args: DebugProtocol.GotoTargetsArguments): void {
		this.superiorSession.miDebugger.log("stdout", `goto targets request via inferior ${this.sessionPid}`);
		this.superiorSession.inferiorGotoTargetsRequest(response, args,
			(r: DebugProtocol.Response) => this.sendResponse(r),
			(r: DebugProtocol.Response, n: number, s: string) => this.sendErrorResponse(r, n, s) 
		);
	}

	protected override gotoRequest(response: DebugProtocol.GotoResponse, args: DebugProtocol.GotoArguments): void {
		this.superiorSession.miDebugger.log("stdout", `goto request via inferior ${this.sessionPid}`);
		this.sendResponse(response);
	}
}
