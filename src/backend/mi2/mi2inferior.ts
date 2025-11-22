import { Breakpoint, IBackend, SSHArguments, Stack, Thread, Variable } from "../backend";
import { MI2 } from "./mi2";

export class MI2Inferior implements IBackend {
	load(cwd: string, target: string, procArgs: string, separateConsole: string, autorun: string[]): Thenable<any> {
		return this.superior.load(cwd, target, procArgs, separateConsole, autorun);
	}

	ssh(args: SSHArguments, cwd: string, target: string, procArgs: string, separateConsole: string, attach: boolean, autorun: string[]): Thenable<any> {
		return this.superior.ssh(args, cwd, target, separateConsole, procArgs, attach, autorun);
	}

	attach(cwd: string, executable: string, target: string, autorun: string[]): Thenable<any> {
		return this.superior.attach(cwd, executable, target, autorun);
	}

	connect(cwd: string, executable: string, target: string, autorun: string[]): Thenable<any> {
		return this.superior.attach(cwd, executable, target, autorun);
	}

	start(runToStart: boolean): Thenable<boolean> {
		return this.superior.start(runToStart);
	}

	stop(): void {
		this.superior.stop();
	}

	detach(): void {
		this.superior.detach();
	}

	interrupt(threadId?: number): Thenable<boolean> {
		return this.superior.interrupt(threadId);
	}

	continue(reverse?: boolean, threadId?: number): Thenable<boolean> {
		return this.superior.continue(reverse, threadId);
	}

	next(): Thenable<boolean> {
		return this.superior.next();
	}
	step(): Thenable<boolean> {
		return this.superior.step();
	}

	stepOut(): Thenable<boolean> {
		return this.superior.stepOut();
	}

	loadBreakPoints(breakpoints: Breakpoint[]): Thenable<[boolean, Breakpoint][]> {
		return this.superior.loadBreakPoints(breakpoints);
	}

	addBreakPoint(breakpoint: Breakpoint): Thenable<[boolean, Breakpoint]> {
		return this.superior.addBreakPoint(breakpoint);
	}

	removeBreakPoint(breakpoint: Breakpoint): Thenable<boolean> {
		return this.superior.removeBreakPoint(breakpoint);
	}

	clearBreakPoints(source?: string): Thenable<any> {
		return this.superior.clearBreakPoints(source);
	}

	getThreads(): Thenable<Thread[]> {
		return this.superior.getThreads();
	}

	getStack(startFrame: number, maxLevels: number, thread: number): Thenable<Stack[]> {
		return this.superior.getStack(startFrame, maxLevels, thread);
	}

	getStackVariables(thread: number, frame: number): Thenable<Variable[]> {
		return this.superior.getStackVariables(thread, frame);
	}

	evalExpression(name: string, thread: number, frame: number): Thenable<any> {
		return this.superior.evalExpression(name, thread, frame);
	}

	isReady(): boolean {
		return this.superior.isReady();
	}

	changeVariable(name: string, rawValue: string): Thenable<any> {
		return this.superior.changeVariable(name, rawValue);
	}

	examineMemory(from: number, to: number): Thenable<any> {
		return this.superior.examineMemory(from, to);
	}
	
	private superior: MI2;

	contructor(superior: MI2) {
		this.superior = superior
	}
};