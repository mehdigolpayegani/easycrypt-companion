// Finds the easycrypt binary: configured path, PATH, then opam switches
// (VS Code started from the Dock often lacks opam's PATH).

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

function isExecutableFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function onPath(name: string): string | undefined {
  const exts = process.platform === "win32" ? ["", ".exe", ".cmd"] : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return undefined;
}

function inOpamSwitches(name: string): string | undefined {
  const root = process.env.OPAMROOT ?? join(homedir(), ".opam");
  if (!existsSync(root)) return undefined;
  let switches: string[];
  try {
    switches = readdirSync(root);
  } catch {
    return undefined;
  }
  // Prefer a switch named after EasyCrypt, then the default one.
  switches.sort((a, b) => rank(a) - rank(b));
  for (const sw of switches) {
    const candidate = join(root, sw, "bin", name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

function rank(switchName: string): number {
  if (/easycrypt/i.test(switchName)) return 0;
  if (switchName === "default") return 1;
  return 2;
}

/** Resolves a bare name on PATH and in opam switches; a path is returned as is. */
export function resolveExecutable(configured: string): string {
  const name = configured.trim() || "easycrypt";
  if (isAbsolute(name) || name.includes("/") || name.includes("\\")) return name;
  return onPath(name) ?? inOpamSwitches(name) ?? name;
}
