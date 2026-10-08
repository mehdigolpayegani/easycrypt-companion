// Parses the output of `easycrypt cli -emacs` (src/ecTerminal.ml).
//
// Before reading each command EasyCrypt prints a prompt line `[N|mode]>`:
// N is the state number (for `undo N.`), mode is `check` or `weakcheck`.
// The text before a prompt is the reply to the previous command:
//   `+ line` / `| line`     a notice (`[W]` in front for warnings)
//   `[error-B-E]message`    an error at bytes B..E of the command
//   `Current goal ...`      the goal, on success

export interface Prompt {
  state: number;
  mode: string;
}

export interface ProverError {
  /** Byte offsets within the command. */
  startByte: number;
  endByte: number;
  message: string;
}

export interface Reply extends Prompt {
  /** Text printed before the prompt. */
  raw: string;
  /** Output other than goals and errors. */
  messages: string;
  warnings: string[];
  /** The goal display, if any. */
  goals?: string;
  error?: ProverError;
}

const PROMPT_RE = /(?:^|\n)\[(\d+)\|([A-Za-z]+)\]>\n/;
const ERROR_RE = /^\[error-(\d+)-(\d+)\]/m;
const GOALS_RE = /^(?:Current goal|No more goals|Remaining lemmas to prove:)/m;

/** Splits prover output at prompts. */
export class PromptSplitter {
  private buffer = "";

  /** Adds output; returns each complete reply with its prompt. */
  push(chunk: string): Array<{ body: string; prompt: Prompt }> {
    this.buffer += chunk;
    const out: Array<{ body: string; prompt: Prompt }> = [];
    for (;;) {
      const m = PROMPT_RE.exec(this.buffer);
      if (!m) break;
      const body = this.buffer.slice(0, m.index);
      this.buffer = this.buffer.slice(m.index + m[0].length);
      out.push({ body, prompt: { state: Number(m[1]), mode: m[2] } });
    }
    return out;
  }

  /** Output after the last prompt. */
  pending(): string {
    return this.buffer;
  }
}

/** Removes the `+ ` / `| ` prefixes of notice blocks. */
function stripNoticePrefixes(lines: string[]): string[] {
  const out: string[] = [];
  let inNotice = false;
  for (const line of lines) {
    if (line.startsWith("+ ") || line === "+") {
      out.push(line.slice(2));
      inNotice = true;
    } else if (inNotice && (line.startsWith("| ") || line === "|")) {
      out.push(line.slice(2));
    } else {
      out.push(line);
      inNotice = false;
    }
  }
  return out;
}

function trimBlankLines(s: string): string {
  return s.replace(/^\s*\n/, "").replace(/\s+$/, "");
}

export function parseReply(body: string, prompt: Prompt): Reply {
  const warnings: string[] = [];
  const kept: string[] = [];
  let currentWarning: string[] | undefined;

  for (const line of body.split("\n")) {
    if (line.startsWith("[W]")) {
      const rest = line.slice(3);
      if (rest.startsWith("+ ") || rest === "+") {
        currentWarning = [rest.slice(2)];
        warnings.push("");
      } else if (currentWarning && (rest.startsWith("| ") || rest === "|")) {
        currentWarning.push(rest.slice(2));
      } else {
        currentWarning = [rest];
        warnings.push("");
      }
      warnings[warnings.length - 1] = currentWarning.join("\n");
    } else {
      currentWarning = undefined;
      kept.push(line);
    }
  }

  let text = kept.join("\n");
  let error: ProverError | undefined;
  let goals: string | undefined;

  const em = ERROR_RE.exec(text);
  if (em) {
    error = {
      startByte: Number(em[1]),
      endByte: Number(em[2]),
      message: trimBlankLines(text.slice(em.index + em[0].length)),
    };
    text = text.slice(0, em.index);
  } else {
    let last: RegExpExecArray | undefined;
    const re = new RegExp(GOALS_RE.source, "gm");
    for (let m = re.exec(text); m; m = re.exec(text)) last = m;
    if (last) {
      goals = trimBlankLines(text.slice(last.index));
      text = text.slice(0, last.index);
    }
  }

  return {
    ...prompt,
    raw: body,
    messages: trimBlankLines(stripNoticePrefixes(text.split("\n")).join("\n")),
    warnings: warnings.map(trimBlankLines).filter((w) => w.length > 0),
    goals,
    error,
  };
}
