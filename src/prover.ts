// A running `easycrypt cli -emacs` process; commands are sent one at a time.

import { ChildProcess, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { parseReply, Prompt, PromptSplitter, Reply } from "./protocol";

export interface ProverOptions {
  executable: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Called with everything sent (`>`) and received (`<`). */
  trace?: (direction: ">" | "<", text: string) => void;
}

export class ProverExitedError extends Error {
  constructor(readonly code: number | null, readonly signal: string | null, readonly output: string) {
    super(
      `EasyCrypt exited (${signal ? `signal ${signal}` : `code ${code}`})` +
        (output.trim() ? `:\n${output.trim()}` : ""),
    );
  }
}

interface Pending {
  resolve: (reply: Reply) => void;
  reject: (err: Error) => void;
}

export class Prover {
  private proc?: ChildProcess;
  private splitter = new PromptSplitter();
  private pending?: Pending;
  private startup?: Pending;
  private exitListeners: Array<(err: ProverExitedError) => void> = [];
  private exited = false;
  private lastOutput = "";
  private quietUntil = 0;

  /** From the most recent prompt. */
  prompt: Prompt = { state: 0, mode: "check" };
  /** Output before the first prompt. */
  banner = "";

  constructor(private readonly options: ProverOptions) {}

  get busy(): boolean {
    return this.pending !== undefined;
  }

  get running(): boolean {
    return this.proc !== undefined && !this.exited;
  }

  onExit(listener: (err: ProverExitedError) => void): void {
    this.exitListeners.push(listener);
  }

  /** Starts the process and waits for the first prompt. */
  start(): Promise<Prompt> {
    const { executable, args, cwd, env } = this.options;
    const fullArgs = ["cli", "-emacs", ...args];

    // Merge stderr into stdout so errors stay ordered with prompts.
    const proc =
      process.platform === "win32"
        ? spawn(executable, fullArgs, { cwd, env, stdio: ["pipe", "pipe", "pipe"] })
        : spawn("/bin/sh", ["-c", 'exec "$0" "$@" 2>&1', executable, ...fullArgs], {
            cwd,
            env,
            stdio: ["pipe", "pipe", "pipe"],
          });
    this.proc = proc;

    const decoder = new StringDecoder("utf8");
    const onData = (data: Buffer) => this.onOutput(decoder.write(data));
    proc.stdout!.on("data", onData);
    proc.stderr!.on("data", onData);
    proc.stdin!.on("error", () => undefined); // reported through "exit"

    proc.on("error", (err) => this.onExited(null, null, String(err.message)));
    proc.on("exit", (code, signal) => this.onExited(code, signal, this.lastOutput));

    return new Promise<Reply>((resolve, reject) => {
      this.startup = { resolve, reject };
    }).then((reply) => {
      this.banner = reply.raw;
      return { state: reply.state, mode: reply.mode };
    });
  }

  /** Sends one command and resolves with its reply. One command at a time. */
  async send(command: string): Promise<Reply> {
    if (this.pending || this.startup) throw new Error("EasyCrypt is busy");
    // An interrupt that arrives after its command finished makes EasyCrypt
    // print an extra prompt; let it arrive before sending anything else.
    const quiet = this.quietUntil - Date.now();
    if (quiet > 0) await new Promise((r) => setTimeout(r, quiet));
    if (!this.running) throw new Error("EasyCrypt is not running");
    if (this.pending) throw new Error("EasyCrypt is busy");
    return new Promise<Reply>((resolve, reject) => {
      this.pending = { resolve, reject };
      const text = command + "\n";
      this.options.trace?.(">", text);
      this.proc!.stdin!.write(text);
    });
  }

  /** Interrupts the command in flight (C-c C-c). */
  interrupt(): void {
    if (this.running && this.pending) {
      this.quietUntil = Date.now() + 250;
      this.proc!.kill("SIGINT");
    }
  }

  kill(): void {
    if (this.running) {
      this.proc!.stdin!.end();
      this.proc!.kill("SIGKILL");
    }
  }

  private onOutput(text: string): void {
    this.options.trace?.("<", text);
    this.lastOutput = (this.lastOutput + text).slice(-4000);
    for (const { body, prompt } of this.splitter.push(text)) {
      this.prompt = prompt;
      const reply = parseReply(body, prompt);
      const waiter = this.startup ?? this.pending;
      this.startup = undefined;
      this.pending = undefined;
      // A prompt nobody waits for follows a late interrupt; only its state matters.
      waiter?.resolve(reply);
    }
  }

  private onExited(code: number | null, signal: string | null, output: string): void {
    if (this.exited) return;
    this.exited = true;
    const err = new ProverExitedError(code, signal, output);
    const waiter = this.startup ?? this.pending;
    this.startup = undefined;
    this.pending = undefined;
    waiter?.reject(err);
    for (const l of this.exitListeners) l(err);
  }
}
