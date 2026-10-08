// The proof state of one script: the sentences EasyCrypt has processed, the
// queue, and the prover running them. Independent of VS Code, so it can be
// tested against a real EasyCrypt.
//
// Each processed sentence records the state number before it ran. Retracting
// only lowers the target state (`tip`); the worker then sends `undo N.`. A
// reply for a sentence retracted in the meantime is discarded.

import { Reply } from "./protocol";
import { Prover, ProverOptions } from "./prover";
import { byteToCharOffset, nextSentence, Sentence, skipBlanksBackward } from "./sentences";

export interface ProcessedSentence extends Sentence {
  stateBefore: number;
  stateAfter: number;
}

export interface SessionError {
  /** Document offsets. */
  start: number;
  end: number;
  message: string;
}

export interface SessionHost {
  /** Current text of the script. */
  getText(): string;
  /** Something observable changed. */
  changed(): void;
  /** EasyCrypt failed to start, crashed, or could not undo. */
  failed?(message: string): void;
}

type Item =
  | { kind: "sentence"; sentence: Sentence }
  | {
      kind: "command";
      text: string;
      resolve: (reply: Reply) => void;
      reject: (err: Error) => void;
    };

function isBlank(c: string | undefined): boolean {
  return c === " " || c === "\t" || c === "\r" || c === "\n";
}

/** Text for the response pane. */
export function formatResponse(reply: Reply): string {
  const parts: string[] = [];
  if (reply.messages) parts.push(reply.messages);
  for (const w of reply.warnings) parts.push(`Warning: ${w}`);
  if (reply.error) parts.push(reply.error.message);
  return parts.join("\n\n");
}

export class ProofSession {
  processed: ProcessedSentence[] = [];
  goals = "";
  response = "";
  error?: SessionError;
  mode = "check";

  private items: Item[] = [];
  private inFlight?: { item: Item; doomed: boolean };
  private prover?: Prover;
  private tip = 0;
  private working = false;
  private starting = false;
  private disposed = false;
  private idleWaiters: Array<() => void> = [];

  constructor(
    private readonly proverOptions: () => ProverOptions,
    private readonly host: SessionHost,
  ) {}

  // --- Observable state ---

  /** End of the processed region. */
  get processedEnd(): number {
    return this.processed.length ? this.processed[this.processed.length - 1].end : 0;
  }

  /** End of the processed region, the sentence in flight and the queue. */
  get queuedEnd(): number {
    let end = this.processedEnd;
    const inFlight = this.inFlight;
    if (inFlight && !inFlight.doomed && inFlight.item.kind === "sentence") {
      end = Math.max(end, inFlight.item.sentence.end);
    }
    for (const item of this.items) {
      if (item.kind === "sentence") end = Math.max(end, item.sentence.end);
    }
    return end;
  }

  get busy(): boolean {
    return this.starting || this.inFlight !== undefined || this.items.length > 0;
  }

  get running(): boolean {
    return this.prover?.running ?? false;
  }

  /** Resolves when everything queued so far is done. */
  whenIdle(): Promise<void> {
    if (!this.working && !this.starting && !this.needsWork()) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  // --- Navigation (Proof General commands) ---

  /** C-c C-n. Returns false if there is no next sentence. */
  next(): boolean {
    this.error = undefined;
    const s = nextSentence(this.host.getText(), this.queuedEnd);
    if (!s) {
      this.host.changed();
      return false;
    }
    this.items.push({ kind: "sentence", sentence: s });
    this.kick();
    return true;
  }

  /** C-c C-u: retracts the last sentence, wherever it is. */
  undo(): void {
    this.error = undefined;
    for (let i = this.items.length - 1; i >= 0; i--) {
      if (this.items[i].kind === "sentence") {
        this.items.splice(i, 1);
        this.kick();
        return;
      }
    }
    const inFlight = this.inFlight;
    if (inFlight && !inFlight.doomed && inFlight.item.kind === "sentence") {
      this.doomInFlight();
      this.kick();
      return;
    }
    const last = this.processed.pop();
    if (last) this.tip = last.stateBefore;
    this.kick();
  }

  /** C-c C-RET: processes or retracts up to `offset`. */
  gotoOffset(offset: number): void {
    this.error = undefined;
    const text = this.host.getText();
    const target = skipBlanksBackward(text, offset);
    if (target >= this.queuedEnd) {
      let s = nextSentence(text, this.queuedEnd);
      while (s && s.end <= target) {
        this.items.push({ kind: "sentence", sentence: s });
        s = nextSentence(text, s.end);
      }
      this.kick();
    } else {
      this.retractTo(target);
    }
  }

  /** C-c C-b: processes the rest of the script. */
  processBuffer(): void {
    this.gotoOffset(this.host.getText().length);
  }

  /** C-c C-r: retracts everything. */
  retractBuffer(): void {
    this.error = undefined;
    this.retractTo(0);
  }

  /** Keeps only sentences ending at or before `offset`. */
  retractTo(offset: number): void {
    this.items = this.items.filter((item) => item.kind !== "sentence" || item.sentence.end <= offset);
    const inFlight = this.inFlight;
    if (inFlight && !inFlight.doomed && inFlight.item.kind === "sentence" && inFlight.item.sentence.end > offset) {
      this.doomInFlight();
    }
    const idx = this.processed.findIndex((s) => s.end > offset);
    if (idx >= 0) {
      this.tip = this.processed[idx].stateBefore;
      this.processed.length = idx;
    }
    this.kick();
  }

  /**
   * The script changed from `start` on. Retracts the sentences it touches,
   * including one ending at `start` whose `.` is no longer before whitespace.
   */
  edited(start: number, text: string): void {
    let changed = false;
    if (this.error && start <= this.error.end) {
      this.error = undefined;
      changed = true;
    }
    let offset = start;
    const ends: number[] = this.processed.map((s) => s.end);
    if (this.inFlight?.item.kind === "sentence") ends.push(this.inFlight.item.sentence.end);
    for (const item of this.items) if (item.kind === "sentence") ends.push(item.sentence.end);
    if (ends.some((end) => end === start && end < text.length && !isBlank(text[end]))) offset = start - 1;
    if (offset < this.queuedEnd) this.retractTo(offset);
    else if (changed) this.host.changed();
  }

  /** C-c C-c: interrupts the command in flight and empties the queue. */
  interrupt(): void {
    this.items = this.items.filter((item) => {
      if (item.kind === "command") item.reject(new Error("Interrupted"));
      return false;
    });
    this.prover?.interrupt();
    this.host.changed();
  }

  // --- Commands outside the script (print, search, pragmas) ---

  /** Sends `command` after everything already queued. */
  query(command: string): Promise<Reply> {
    return new Promise<Reply>((resolve, reject) => {
      this.items.push({ kind: "command", text: command, resolve, reject });
      this.kick();
    });
  }

  toggleWeakCheck(): Promise<Reply> {
    return this.query(this.mode === "weakcheck" ? "pragma Proofs:check." : "pragma Proofs:weak.");
  }

  // --- Process lifecycle ---

  /** C-c C-x: stops EasyCrypt; nothing stays processed. */
  exit(message = ""): void {
    const prover = this.prover;
    this.prover = undefined;
    this.reset(message);
    prover?.kill();
  }

  /** Stops EasyCrypt and starts it again. */
  async restart(): Promise<void> {
    this.exit();
    await this.ensureProver();
    this.host.changed();
  }

  dispose(): void {
    this.disposed = true;
    this.exit();
  }

  /** C-c C-w: empties the response pane. */
  clearResponse(): void {
    this.response = "";
    this.host.changed();
  }

  /** Stops EasyCrypt after a failure and tells the host. */
  private fail(message: string): void {
    this.exit(message);
    this.host.failed?.(message);
  }

  private reset(message: string): void {
    for (const item of this.items) if (item.kind === "command") item.reject(new Error("EasyCrypt stopped"));
    if (this.inFlight?.item.kind === "command") this.inFlight.item.reject(new Error("EasyCrypt stopped"));
    this.items = [];
    this.inFlight = undefined;
    this.processed = [];
    this.tip = 0;
    this.goals = "";
    this.response = message;
    this.error = undefined;
    this.mode = "check";
    this.host.changed();
  }

  private async ensureProver(): Promise<Prover> {
    if (this.prover?.running) return this.prover;
    const prover = new Prover(this.proverOptions());
    this.prover = prover;
    prover.onExit((err) => {
      if (this.prover === prover) {
        this.prover = undefined;
        this.reset(err.message);
        this.host.failed?.(err.message);
      }
    });
    this.starting = true;
    this.host.changed();
    try {
      const prompt = await prover.start();
      this.tip = prompt.state;
      this.mode = prompt.mode;
      return prover;
    } finally {
      this.starting = false;
      this.notifyIdle();
    }
  }

  // --- Worker ---

  private doomInFlight(): void {
    this.inFlight!.doomed = true;
    this.prover?.interrupt();
  }

  private kick(): void {
    if (!this.working) void this.work();
    this.host.changed();
  }

  private needsWork(): boolean {
    if (this.items.length > 0) return true;
    return this.prover?.running === true && this.prover.prompt.state !== this.tip;
  }

  private async work(): Promise<void> {
    this.working = true;
    try {
      while (!this.disposed && this.needsWork()) {
        let prover: Prover;
        try {
          prover = await this.ensureProver();
        } catch (err) {
          // The exit handler already reset the session; leave nothing queued to retry.
          if (this.items.length > 0) this.reset(err instanceof Error ? err.message : String(err));
          return;
        }
        if (prover.prompt.state !== this.tip) {
          await this.undoTo(prover, this.tip);
          continue;
        }
        const item = this.items.shift();
        if (!item) continue;
        await this.run(prover, item);
      }
    } catch (err) {
      // The process died mid-command; the exit handler reset the session.
      if (this.prover?.running) this.fail(err instanceof Error ? err.message : String(err));
    } finally {
      this.working = false;
      // Work queued while unwinding (e.g. after an exit).
      if (!this.disposed && this.needsWork()) void this.work();
      this.notifyIdle();
      this.host.changed();
    }
  }

  private notifyIdle(): void {
    if (this.working || this.starting) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of waiters) w();
  }

  private async undoTo(prover: Prover, state: number): Promise<void> {
    const reply = await prover.send(`undo ${state}.`);
    if (reply.error || reply.state !== state) {
      this.fail(
        `EasyCrypt could not go back to state ${state}` +
          (reply.error ? `: ${reply.error.message}` : "") +
          ". The prover was stopped; the script is unprocessed.",
      );
      return;
    }
    this.mode = reply.mode;
    this.goals = reply.goals ?? "";
    this.response = "";
  }

  private async run(prover: Prover, item: Item): Promise<void> {
    this.inFlight = { item, doomed: false };
    this.host.changed();

    if (item.kind === "command") {
      let reply: Reply;
      try {
        reply = await prover.send(item.text);
      } catch (err) {
        this.inFlight = undefined;
        item.reject(err as Error);
        throw err;
      }
      this.inFlight = undefined;
      this.mode = reply.mode;
      if (!reply.error) this.tip = reply.state;
      if (reply.goals !== undefined) this.goals = reply.goals;
      this.response = formatResponse(reply);
      item.resolve(reply);
      return;
    }

    const s = item.sentence;
    const command = this.host.getText().slice(s.contentStart, s.end);
    const stateBefore = prover.prompt.state;
    const inFlight = this.inFlight;
    const reply = await prover.send(command);
    const doomed = inFlight.doomed;
    this.inFlight = undefined;
    this.mode = reply.mode;
    if (doomed) return; // retracted meanwhile; the worker undoes it if needed

    if (reply.error) {
      const { startByte, endByte, message } = reply.error;
      let from = byteToCharOffset(command, startByte);
      let to = byteToCharOffset(command, endByte);
      // EasyCrypt's ranges sometimes include surrounding blanks.
      while (from < to && isBlank(command[from])) from++;
      while (to > from && isBlank(command[to - 1])) to--;
      let start = s.contentStart + from;
      let end = s.contentStart + to;
      if (end <= start) {
        start = s.contentStart;
        end = s.end;
      }
      this.error = { start, end, message };
      this.response = formatResponse(reply);
      // Stop at the first error, like Proof General.
      this.items = this.items.filter((i) => i.kind !== "sentence");
      return;
    }

    this.processed.push({ ...s, stateBefore, stateAfter: reply.state });
    this.tip = reply.state;
    this.goals = reply.goals ?? "";
    this.response = formatResponse(reply);
  }
}
