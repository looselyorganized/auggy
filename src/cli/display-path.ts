import { isAbsolute, relative, resolve } from "node:path";

export function displayPath(path: string, cwd: string | undefined = process.cwd()): string {
  const abs = resolve(path);
  const rel = relative(resolve(cwd), abs);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
}
