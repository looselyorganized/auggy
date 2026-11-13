/** Raw authoring only: no effective configuration, environment reads or runtime imports. */
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  isAlias,
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  Scalar,
  Pair,
  type YAMLMap,
  type Document,
  type Node,
} from "yaml";
import { VALID_NAME_RE } from "../agent-name";
import { BUILTIN_TYPES } from "../builtin-types";
import {
  AUTHORING_LIMITS,
  type AuthoringDeclaration,
  type AuthoringDocument,
  type DocumentEdit,
  type ExistingFileSnapshot,
  type PlannedFile,
  type RawRecord,
  type RawValue,
} from "./contracts";
import { AuthoringError, decodeSnapshotText, readFileSnapshot, snapshotHash } from "./document-io";

interface PrivateDocument {
  ast: Document;
  metadata: Map<number, Document>;
  configHash: string;
  inputs: readonly { path: string; sha256: string }[];
}
const documents = new WeakMap<AuthoringDocument, PrivateDocument>();
const CORE_TAGS = new Set(
  ["map", "seq", "str", "null", "bool", "int", "float"].map((tag) => `tag:yaml.org,2002:${tag}`),
);
const ENV_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function environmentNames(value: RawValue): readonly string[] {
  const names = new Set<string>();
  const pending: RawValue[] = [value];
  while (pending.length) {
    const next = pending.pop();
    if (typeof next === "string") {
      for (const match of next.matchAll(ENV_PATTERN)) names.add(match[1]!);
    } else if (Array.isArray(next)) pending.push(...next);
    else if (next && typeof next === "object") pending.push(...Object.values(next));
  }
  return [...names].sort();
}

function unresolved(value: string): boolean {
  return environmentNames(value).length > 0;
}

function fail(code: string, message: string, path?: string, field?: string): never {
  throw new AuthoringError(code, message, { path, field });
}

function record(value: RawValue | undefined): value is RawRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** No alias expansion or JS materialization occurs before the iterative bounds check. */
function validateAst(ast: Document, path: string): void {
  if (ast.errors.length || ast.warnings.length) {
    fail(
      "invalid-yaml",
      "Invalid or unsupported YAML; review the file locally and use unique string keys and YAML 1.2 core values.",
      path,
    );
  }
  if (ast.directives?.yaml.version !== "1.2") {
    fail(
      "unsupported-yaml",
      "Use YAML 1.2 core values; review older YAML directives manually.",
      path,
    );
  }
  const pending: { node: unknown; depth: number }[] = [{ node: ast.contents, depth: 0 }];
  let count = 0;
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    if (++count > AUTHORING_LIMITS.yamlNodes || depth > AUTHORING_LIMITS.yamlDepth) {
      fail(
        "yaml-limit",
        "YAML exceeds supported nesting or node limits; simplify it before retrying.",
        path,
      );
    }
    if (node === null) continue;
    if (isAlias(node))
      fail(
        "unsupported-yaml",
        "YAML aliases are unsupported; replace them with explicit values after manual review.",
        path,
      );
    if (!isMap(node) && !isSeq(node) && !isScalar(node)) {
      fail("unsupported-yaml", "Unsupported YAML node; preserve and review it manually.", path);
    }
    if (node.tag && !CORE_TAGS.has(node.tag)) {
      fail(
        "unsupported-yaml",
        "Custom YAML tags are unsupported; preserve and review them manually.",
        path,
      );
    }
    if (isMap(node)) {
      const keys = new Set<string>();
      for (const pair of node.items) {
        if (
          !isScalar(pair.key) ||
          typeof pair.key.value !== "string" ||
          (pair.key.value === "<<" && pair.key.type === "PLAIN") ||
          keys.has(pair.key.value)
        ) {
          fail(
            "invalid-yaml-key",
            "Use unique scalar string keys; merge keys and complex keys require manual review.",
            path,
          );
        }
        keys.add(pair.key.value);
        pending.push({ node: pair.key, depth: depth + 1 }, { node: pair.value, depth: depth + 1 });
      }
    } else if (isSeq(node)) {
      for (const item of node.items) pending.push({ node: item, depth: depth + 1 });
    } else if (isScalar(node)) {
      const value = node.value;
      if (
        typeof value === "number" &&
        (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))
      ) {
        fail(
          "unsafe-number",
          "Numeric values must be finite and integers must be safe; preserve unsupported scalars manually before editing.",
          path,
        );
      }
      if (value !== null && !["boolean", "number", "string"].includes(typeof value)) {
        fail("unsupported-yaml", "Unsupported YAML scalar; preserve and review it manually.", path);
      }
    }
  }
}

function rawNode(node: unknown): RawValue {
  if (node === null) return null;
  if (isScalar(node)) return node.value as RawValue;
  if (isSeq(node)) return Object.freeze(node.items.map(rawNode));
  if (isMap(node)) {
    const value = Object.create(null) as Record<string, RawValue>;
    for (const pair of node.items) value[(pair.key as Scalar<string>).value] = rawNode(pair.value);
    return Object.freeze(value);
  }
  throw new AuthoringError("unsupported-yaml", "Unsupported YAML structure; review it manually.");
}

function readAst(snapshot: ExistingFileSnapshot): Document {
  let ast: Document;
  try {
    ast = parseDocument(decodeSnapshotText(snapshot.bytes), {
      keepSourceTokens: true,
      prettyErrors: false,
      strict: true,
      uniqueKeys: true,
      version: "1.2",
      schema: "core",
      customTags: [],
      resolveKnownTags: false,
    });
  } catch (error) {
    if (error instanceof AuthoringError) throw error;
    fail(
      "invalid-yaml",
      "Cannot parse YAML; review the file locally without exposing its values.",
      snapshot.path,
    );
  }
  validateAst(ast, snapshot.path);
  if (!isMap(ast.contents))
    fail("invalid-document", "Expected a YAML mapping at the document root.", snapshot.path);
  return ast;
}

/** Reject symlinked metadata ancestors without importing descriptor/FFI publication code. */
function assertMetadataPath(projectDir: string, metadataPath: string): void {
  let cursor = projectDir;
  for (const part of relative(projectDir, dirname(metadataPath)).split("/")) {
    cursor = join(cursor, part);
    try {
      const stats = lstatSync(cursor);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        fail(
          "unsafe-metadata-path",
          "Referenced metadata must remain in real project directories; review symlinked paths manually.",
          metadataPath,
        );
      }
    } catch (error) {
      if (error instanceof AuthoringError) throw error;
      fail(
        "missing-metadata",
        "Referenced augment metadata is missing or inaccessible; restore it before retrying.",
        metadataPath,
      );
    }
  }
}

function declaration(
  raw: RawRecord,
  index: number,
  origin: AuthoringDeclaration["origin"],
): AuthoringDeclaration {
  const field = `/augments/${index}`;
  if (typeof raw.type !== "string" || !raw.type)
    fail("invalid-declaration", "Augment type must be a nonempty string.", origin.path, field);
  if (raw.name !== undefined && (typeof raw.name !== "string" || !raw.name))
    fail(
      "invalid-declaration",
      "Augment name must be a nonempty string when present.",
      origin.path,
      field,
    );
  let name =
    typeof raw.name === "string" ? raw.name : BUILTIN_TYPES.has(raw.type) ? raw.type : null;
  if (name && unresolved(name)) name = null;
  if (name && !VALID_NAME_RE.test(name))
    fail(
      "invalid-declaration",
      "Augment names must use letters, digits, hyphens or underscores.",
      origin.path,
      field,
    );
  if (raw.type === "custom" && raw.name === undefined)
    fail(
      "invalid-declaration",
      "Custom augments require an explicit instance name.",
      origin.path,
      field,
    );
  if (raw.source !== undefined && typeof raw.source !== "string")
    fail(
      "invalid-declaration",
      "Augment source must be a string when present.",
      origin.path,
      field,
    );
  if (raw.type === "custom" && (typeof raw.source !== "string" || !raw.source))
    fail(
      "invalid-declaration",
      "Custom augments require a nonempty source string.",
      origin.path,
      field,
    );
  return Object.freeze({
    index,
    name,
    type: raw.type,
    raw,
    ...(typeof raw.source === "string" ? { source: raw.source } : {}),
    ...(Object.hasOwn(raw, "options") ? { options: raw.options } : {}),
    origin: Object.freeze(origin),
    environmentNames: Object.freeze(environmentNames(raw)),
  });
}

function assertUnique(declarations: readonly AuthoringDeclaration[]): void {
  const names = new Set<string>();
  for (const entry of declarations) {
    if (entry.name && names.has(entry.name))
      fail(
        "duplicate-augment",
        "Augment instance names must be unique; review the duplicate declaration.",
        entry.origin.path,
        entry.origin.pointer,
      );
    if (entry.name) names.add(entry.name);
  }
}

export function readAuthoringDocument(configPath: string): AuthoringDocument {
  const selectedPath = resolve(configPath);
  let projectDir: string;
  try {
    projectDir = realpathSync(dirname(selectedPath));
  } catch {
    fail(
      "invalid-project",
      "Project directory is missing or inaccessible; review the selected config path.",
    );
  }
  const canonicalPath = join(projectDir, basename(selectedPath));
  const config = readFileSnapshot(canonicalPath, AUTHORING_LIMITS.documentBytes);
  if (!config.exists) fail("missing-file", "Required config file is missing.");
  const ast = readAst(config);
  const value = rawNode(ast.contents) as RawRecord;
  const entries = value.augments;
  if (entries !== undefined && !Array.isArray(entries))
    fail(
      "invalid-declarations",
      "Augments must be a sequence when present.",
      canonicalPath,
      "/augments",
    );
  if (((entries as readonly RawValue[] | undefined)?.length ?? 0) > AUTHORING_LIMITS.augments)
    fail(
      "augment-limit",
      "Too many augment declarations; reduce the graph before retrying.",
      canonicalPath,
    );
  const inputs = [config];
  const metadata = new Map<number, Document>();
  const declarations: AuthoringDeclaration[] = [];
  let totalBytes = config.bytes.length;
  let referenced = 0;
  for (const [index, entry] of ((entries ?? []) as readonly RawValue[]).entries()) {
    if (typeof entry === "string") {
      if (!VALID_NAME_RE.test(entry) || unresolved(entry))
        fail(
          "unresolved-reference",
          "Referenced augment IDs must be literal safe names; replace environment-derived IDs after manual review.",
          canonicalPath,
          `/augments/${index}`,
        );
      const metadataPath = join(projectDir, "augments", entry, "augment.yaml");
      assertMetadataPath(projectDir, metadataPath);
      const snapshot = readFileSnapshot(metadataPath, AUTHORING_LIMITS.metadataBytes);
      if (!snapshot.exists)
        fail(
          "missing-metadata",
          "Referenced augment metadata is missing; restore it before retrying.",
          metadataPath,
        );
      totalBytes += snapshot.bytes.length;
      if (totalBytes > AUTHORING_LIMITS.aggregateInputBytes)
        fail(
          "input-limit",
          "Raw document inputs exceed the aggregate byte limit; reduce the graph before retrying.",
        );
      inputs.push(snapshot);
      const metadataAst = readAst(snapshot);
      const metadataValue = rawNode(metadataAst.contents) as RawRecord;
      if (
        Object.hasOwn(metadataValue, "config") &&
        metadataValue.config !== null &&
        !record(metadataValue.config)
      )
        fail(
          "invalid-metadata",
          "Referenced augment config must be a mapping or null when present.",
          metadataPath,
          "/config",
        );
      if (typeof metadataValue.type !== "string" || unresolved(metadataValue.type))
        fail(
          "unresolved-reference",
          "Referenced augment types must be literal strings; review the metadata before conversion.",
          metadataPath,
          "/type",
        );
      const raw: Record<string, RawValue> = Object.create(null);
      raw.name = entry;
      raw.type = metadataValue.type;
      if (Object.hasOwn(metadataValue, "config")) raw.options = metadataValue.config!;
      if (Object.hasOwn(metadataValue, "source")) raw.source = metadataValue.source!;
      declarations.push(
        declaration(Object.freeze(raw), index, {
          kind: "referenced",
          path: metadataPath,
          pointer: "",
          sourceBaseDir: dirname(metadataPath),
        }),
      );
      metadata.set(index, metadataAst);
      referenced++;
    } else {
      if (!record(entry))
        fail(
          "invalid-declaration",
          "Each augment must be a mapping or a literal referenced ID.",
          canonicalPath,
          `/augments/${index}`,
        );
      declarations.push(
        declaration(entry, index, {
          kind: "inline",
          path: canonicalPath,
          pointer: `/augments/${index}`,
          sourceBaseDir: projectDir,
        }),
      );
    }
  }
  assertUnique(declarations);
  const document: AuthoringDocument = Object.freeze({
    projectDir,
    configPath: canonicalPath,
    format:
      referenced === 0 ? "inline" : referenced === declarations.length ? "referenced" : "mixed",
    config,
    inputs: Object.freeze(inputs),
    value,
    declarations: Object.freeze(declarations),
  });
  documents.set(document, {
    ast,
    metadata,
    configHash: config.sha256,
    inputs: inputs.map((snapshot) => ({ path: snapshot.path, sha256: snapshot.sha256 })),
  });
  return document;
}

export function assertInlineAuthoring(document: AuthoringDocument): void {
  if (document.format !== "inline") {
    // Shell-quote the bounded navigation path; never interpolate raw YAML values.
    const selector =
      Buffer.byteLength(document.configPath) <= 300 &&
      ![...document.configPath].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
        ? `'${document.configPath.replaceAll("'", "'\\''")}'`
        : "<selected-config-path>";
    fail(
      "migration-required",
      `Referenced augment declarations require migration. Preview: auggy migrate --config ${selector}. Apply: auggy migrate --config ${selector} --apply.`,
      undefined,
      "/augments",
    );
  }
  assertResolved(document.declarations);
}

function assertResolved(declarations: readonly AuthoringDeclaration[]): void {
  for (const entry of declarations) {
    if (entry.name === null || (!BUILTIN_TYPES.has(entry.type) && entry.type !== "custom"))
      fail(
        "unresolved-declaration",
        "Graph mutations require literal supported augment types and unique instance names; review unresolved declarations manually.",
        entry.origin.path,
        entry.origin.pointer,
      );
  }
}

function assertRawInput(value: unknown): number {
  const pending = [{ value, depth: 0 }];
  const seen = new Set<object>();
  let count = 0;
  let bytes = 0;
  while (pending.length) {
    const current = pending.pop()!;
    if (++count > AUTHORING_LIMITS.yamlNodes || current.depth > AUTHORING_LIMITS.yamlDepth)
      fail("yaml-limit", "Edit values exceed supported nesting or node limits.");
    const item = current.value;
    bytes += typeof item === "string" ? Buffer.byteLength(item) : 8;
    if (bytes > AUTHORING_LIMITS.outputBytes)
      fail("output-limit", "Edit values exceed the supported output byte limit.");
    if (item === null || typeof item === "string" || typeof item === "boolean") continue;
    if (
      typeof item === "number" &&
      Number.isFinite(item) &&
      (!Number.isInteger(item) || Number.isSafeInteger(item))
    )
      continue;
    if (typeof item !== "object" || seen.has(item))
      fail(
        "invalid-edit",
        "Edit values must be finite raw YAML values without cycles or shared object aliases.",
      );
    seen.add(item);
    if (
      !Array.isArray(item) &&
      Object.getPrototypeOf(item) !== Object.prototype &&
      Object.getPrototypeOf(item) !== null
    )
      fail("invalid-edit", "Edit mappings must be plain records.");
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(item))) {
      if (!Object.hasOwn(descriptor, "value"))
        fail("invalid-edit", "Edit values cannot contain accessor properties.");
    }
    for (const [key, child] of Object.entries(item)) {
      bytes += Buffer.byteLength(key);
      pending.push({ value: child, depth: current.depth + 1 });
    }
  }
  return bytes;
}

function setNode(mapping: YAMLMap, key: string, value: Node): void {
  const pair = mapping.items.find((entry) => isScalar(entry.key) && entry.key.value === key);
  if (!pair) {
    mapping.items.push(new Pair(new Scalar(key), value));
    return;
  }
  const previous = pair.value;
  if (isScalar(previous) && isScalar(value)) {
    previous.value = value.value;
    return;
  }
  if (isMap(previous) || isSeq(previous) || isScalar(previous)) {
    value.commentBefore ??= previous.commentBefore;
    value.comment ??= previous.comment;
  }
  pair.value = value;
}

/** A literal merge-looking domain key must stay quoted when new AST nodes are built. */
function literalNode(ast: Document, value: RawValue): Node {
  const node = ast.createNode(value);
  const pending: unknown[] = [node];
  while (pending.length) {
    const current = pending.pop();
    if (isMap(current)) {
      for (const pair of current.items) {
        if (isScalar(pair.key) && pair.key.value === "<<") pair.key.type = "QUOTE_DOUBLE";
        pending.push(pair.value);
      }
    } else if (isSeq(current)) pending.push(...current.items);
  }
  return node;
}

function inlineReferences(
  ast: Document,
  document: AuthoringDocument,
  state: PrivateDocument,
): boolean {
  const sequence = ast.get("augments", true);
  if (!isSeq(sequence)) return false;
  let changed = false;
  for (const entry of document.declarations) {
    if (entry.origin.kind !== "referenced") continue;
    if (!BUILTIN_TYPES.has(entry.type) && entry.type !== "custom")
      fail(
        "unresolved-declaration",
        "Referenced augment types must be supported before conversion.",
        entry.origin.path,
        "/type",
      );
    const source = entry.source;
    if (entry.type === "custom" && source && unresolved(source))
      fail(
        "unresolved-source",
        "Environment-derived legacy custom sources cannot preserve both path bases. Replace the source with a reviewed literal equivalent before migration.",
        entry.origin.path,
        "/source",
      );
    const sourceAst = state.metadata.get(entry.index)!;
    const mapping = sourceAst.contents!.clone() as YAMLMap;
    // Metadata-only fields remain in their untouched file. Only runtime declaration fields are copied.
    mapping.items = mapping.items.filter(
      (pair) => isScalar(pair.key) && ["type", "config", "source"].includes(String(pair.key.value)),
    );
    for (const pair of mapping.items) {
      if (isScalar(pair.key) && pair.key.value === "config") pair.key.value = "options";
    }
    mapping.items.unshift(new Pair(new Scalar("name"), new Scalar(entry.name)));
    if (entry.type === "custom" && source !== undefined && !isAbsolute(source)) {
      const rebased = relative(
        document.projectDir,
        resolve(entry.origin.sourceBaseDir, source),
      ).replaceAll("\\", "/");
      setNode(mapping, "source", new Scalar(rebased.startsWith(".") ? rebased : `./${rebased}`));
    }
    const previous = sequence.items[entry.index] as Node;
    mapping.commentBefore =
      [previous.commentBefore, sourceAst.commentBefore, mapping.commentBefore]
        .filter(Boolean)
        .join("\n") || undefined;
    mapping.comment =
      [mapping.comment, previous.comment, sourceAst.comment].filter(Boolean).join("\n") ||
      undefined;
    sequence.items[entry.index] = mapping;
    changed = true;
  }
  return changed;
}

export function editAuthoringDocument(
  document: AuthoringDocument,
  edits: readonly DocumentEdit[],
): PlannedFile {
  const state = documents.get(document);
  if (
    !state ||
    state.configHash !== document.config.sha256 ||
    snapshotHash(document.config.bytes) !== state.configHash ||
    document.inputs.length !== state.inputs.length ||
    document.inputs.some((snapshot, index) => {
      const original = state.inputs[index]!;
      return (
        !snapshot.exists ||
        snapshot.path !== original.path ||
        snapshot.sha256 !== original.sha256 ||
        snapshotHash(snapshot.bytes) !== original.sha256
      );
    })
  )
    fail(
      "invalid-document-snapshot",
      "Use an unchanged document returned by the authoring reader.",
    );
  if (edits.length > AUTHORING_LIMITS.plannedWrites)
    fail("edit-limit", "Too many document edits; split the operation after review.");
  let editBytes = 0;
  for (const edit of edits) {
    if (edit.kind === "append-augment") editBytes += assertRawInput(edit.entry);
    if (edit.kind === "set-augment-options") editBytes += assertRawInput(edit.options);
    if (editBytes > AUTHORING_LIMITS.outputBytes)
      fail("output-limit", "Combined edit values exceed the supported output byte limit.");
  }
  const ast = state.ast.clone();
  let changed = false;
  let converted = false;
  for (const edit of edits) {
    if (edit.kind === "inline-references") {
      if (!converted) changed = inlineReferences(ast, document, state) || changed;
      converted = true;
      continue;
    }
    const sequence = ast.get("augments", true);
    const current: AuthoringDeclaration[] = [];
    if (isSeq(sequence)) {
      for (const [index, node] of sequence.items.entries()) {
        const raw = rawNode(node);
        if (!record(raw)) {
          assertInlineAuthoring(document);
          fail("migration-required", "Convert referenced declarations before other edits.");
        }
        current.push(
          declaration(raw, index, {
            kind: "inline",
            path: document.configPath,
            pointer: `/augments/${index}`,
            sourceBaseDir: document.projectDir,
          }),
        );
      }
    }
    assertResolved(current);
    assertUnique(current);
    switch (edit.kind) {
      case "append-augment": {
        const entry = declaration(edit.entry, current.length, {
          kind: "inline",
          path: document.configPath,
          pointer: `/augments/${current.length}`,
          sourceBaseDir: document.projectDir,
        });
        assertResolved([entry]);
        assertUnique([...current, entry]);
        if (current.length >= AUTHORING_LIMITS.augments)
          fail("augment-limit", "Too many augment declarations; reduce the graph before retrying.");
        if (!isSeq(sequence))
          setNode(ast.contents as YAMLMap, "augments", literalNode(ast, [edit.entry]));
        else sequence.add(literalNode(ast, edit.entry));
        changed = true;
        break;
      }
      case "remove-augment":
      case "set-augment-options": {
        const target = current.find((entry) => entry.name === edit.name);
        if (!target || !isSeq(sequence))
          fail("missing-augment", "The requested augment instance is not declared.");
        if (edit.kind === "remove-augment") sequence.items.splice(target.index, 1);
        else {
          setNode(
            sequence.items[target.index] as YAMLMap,
            "options",
            literalNode(ast, edit.options),
          );
        }
        changed = true;
        break;
      }
      case "set-application": {
        const { entrypoint, contractVersion } = edit.application;
        if (
          contractVersion !== 1 ||
          typeof entrypoint !== "string" ||
          !entrypoint.startsWith("./") ||
          entrypoint.trim() !== entrypoint ||
          [...entrypoint].some(
            (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
          ) ||
          entrypoint.includes("${") ||
          entrypoint.includes("\\") ||
          entrypoint.includes(":") ||
          entrypoint.split("/").some((part) => part === ".." || part === "") ||
          Buffer.byteLength(entrypoint) > AUTHORING_LIMITS.pathBytes
        )
          fail(
            "invalid-application",
            "Application contract 1 requires a contained literal project entrypoint.",
          );
        const existing = ast.get("application", true);
        if (existing !== undefined) {
          const raw = rawNode(existing);
          if (
            !record(raw) ||
            raw.entrypoint !== entrypoint ||
            raw.contractVersion !== contractVersion ||
            Object.keys(raw).length !== 2
          )
            fail(
              "application-conflict",
              "An application declaration already exists; review it manually instead of replacing it.",
            );
        } else {
          setNode(ast.contents as YAMLMap, "application", ast.createNode(edit.application));
          changed = true;
        }
        break;
      }
      default:
        fail("invalid-edit", "Unsupported document edit.");
    }
  }
  validateAst(ast, document.configPath);
  let bytes: Uint8Array;
  try {
    bytes = changed
      ? Buffer.from(ast.toString({ lineWidth: 0 }))
      : Buffer.from(document.config.bytes);
  } catch {
    fail("invalid-edit", "Cannot preserve this YAML edit; review it manually.");
  }
  if (bytes.length > AUTHORING_LIMITS.documentBytes)
    fail(
      "output-limit",
      "Edited central YAML exceeds the document byte limit; reduce it so it remains readable.",
    );
  return {
    relativePath: basename(document.configPath),
    before: document.config,
    bytes,
    mode: document.config.identity.mode & 0o777,
    role: "activation",
  };
}
