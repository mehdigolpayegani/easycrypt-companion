// Finds the directories EasyCrypt loads theories from, by asking
// `easycrypt config`.

import { execFile } from "node:child_process";

/** The `-I dir` options among `args`; `easycrypt config` accepts no others. */
export function includeOptions(args: string[]): string[] {
  const options: string[] = [];
  for (let i = 0; i + 1 < args.length; i++) {
    if (args[i] === "-I") options.push("-I", args[++i]);
  }
  return options;
}

/** The directories listed under `load-path:` in the output of `easycrypt config`. */
export function parseLoadPath(output: string): string[] {
  const at = output.indexOf("load-path:");
  if (at < 0) return [];
  const dirs: string[] = [];
  for (const line of output.slice(at).split("\n").slice(1)) {
    const m = /^\s+\S+?@(.+)$/.exec(line); // `  <system>@/path` or `  Name@/path`
    if (!m) break;
    dirs.push(m[1].trim());
  }
  return [...new Set(dirs)];
}

/** Runs `easycrypt config` in `cwd`, so that an `easycrypt.project` there is taken into account. */
export function libraryDirectories(executable: string, args: string[], cwd: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile(executable, ["config", ...includeOptions(args)], { cwd, timeout: 15_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${executable} config failed: ${err.message.trim()}`));
      else resolve(parseLoadPath(`${stderr}\n${stdout}`));
    });
  });
}
