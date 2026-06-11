import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export function loadEnvFiles(cwd = process.cwd(), env = process.env) {
  const protectedKeys = new Set(Object.keys(env));
  const files = [
    resolve(cwd, ".env"),
    resolve(cwd, ".env.local"),
    ...(env.TOSSINVEST_ENV_FILE ? [resolve(cwd, env.TOSSINVEST_ENV_FILE)] : []),
  ];
  const loaded: string[] = [];

  for (const file of files) {
    if (!existsSync(file)) {
      continue;
    }

    const parsed = parseEnvFile(readFileSync(file, "utf8"));
    for (const [key, value] of Object.entries(parsed)) {
      if (!protectedKeys.has(key)) {
        env[key] = value;
      }
    }
    loaded.push(file);
  }

  return loaded;
}

function parseEnvFile(contents: string) {
  const result: Record<string, string> = {};

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const equalsIndex = normalized.indexOf("=");
    if (equalsIndex <= 0) {
      continue;
    }

    const key = normalized.slice(0, equalsIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }

    result[key] = parseEnvValue(normalized.slice(equalsIndex + 1).trim());
  }

  return result;
}

function parseEnvValue(value: string) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    const unquoted = value.slice(1, -1);
    return value.startsWith('"')
      ? unquoted
          .replace(/\\n/g, "\n")
          .replace(/\\r/g, "\r")
          .replace(/\\t/g, "\t")
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, "\\")
      : unquoted;
  }

  const commentIndex = value.search(/\s#/);
  return commentIndex >= 0 ? value.slice(0, commentIndex).trim() : value;
}
