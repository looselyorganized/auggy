# Mount Permissions Reference

## Permission matrix

| Operation | Read-only | Writable | Writable + Deletable |
|-----------|-----------|----------|---------------------|
| `fs_read` | ✓ | ✓ | ✓ |
| `fs_list` | ✓ | ✓ | ✓ |
| `fs_search` | ✓ | ✓ | ✓ |
| `fs_write` | ✗ | ✓ | ✓ |
| `fs_mkdir` | ✗ | ✓ | ✓ |
| `fs_remove` | ✗ | ✗ | ✓ |

## Mount configuration shape

```typescript
{
  name: string;           // logical name — first path segment
  path: string;           // physical path on disk
  writable?: boolean;     // default false
  deletable?: boolean;    // default false (requires writable: true)
  maxReadSize?: number;   // default 256KB (262144 bytes)
  maxWriteSize?: number;  // default 1MB (1048576 bytes)
  searchExcludes?: string[]; // default [".git", "node_modules", ".next", "__pycache__", ".DS_Store"]
}
```

## Typical mount configurations

### Skills (read-only)
```typescript
{ name: "skills", path: "./augments", writable: false }
```
For reading SKILL.md files, references, and examples. NEVER writable — prevents the agent from modifying its own behavioral teaching.

### Workspace (writable + deletable)
```typescript
{ name: "workspace", path: "./workspace", writable: true, deletable: true }
```
Agent's personal working directory. Full read/write/delete access. Used for notes, drafts, intermediate work products, scratch files.

### Repository (read-only)
```typescript
{ name: "repo", path: "/repos/platform", writable: false }
```
External code repository mounted for review or analysis. Read-only to prevent accidental modification.

### Output (writable, not deletable)
```typescript
{ name: "output", path: "/shared/reports", writable: true, deletable: false }
```
Shared directory for publishing reports. The agent can create and update files but cannot delete published output.

## Size limits

| Limit | Default | What it protects |
|-------|---------|-----------------|
| `maxReadSize` | 256KB | Prevents large files from consuming the context window. Files over this limit are truncated with a `[truncated]` marker. |
| `maxWriteSize` | 1MB | Prevents the agent from writing arbitrarily large files to disk. |
| `fs_search` max results | 100 (configurable up to 1000) | Prevents glob expansion on huge directories from returning overwhelming results. |

## Binary file handling

The following extensions are detected as binary and rejected by `fs_read`:

**Images:** .png, .jpg, .jpeg, .gif, .bmp, .ico, .webp, .svg
**Documents:** .pdf
**Archives:** .zip, .gz, .tar, .bz2, .7z, .rar
**Media:** .mp3, .mp4, .avi, .mov, .wav, .flac
**Fonts:** .woff, .woff2, .ttf, .otf, .eot
**Compiled:** .exe, .dll, .so, .dylib, .o, .a, .wasm, .pyc, .class

Binary files return: `Error: Binary file (.ext, size). Use fs_list to see metadata.`

## Security boundaries

1. **Path traversal**: All paths are resolved via `fs.realpath()` (follows symlinks) and checked against the mount root with `startsWith()`. Paths that resolve outside the mount are rejected.
2. **Symlink escape**: Symlinks that point outside the mount boundary are detected and rejected before the file is read.
3. **Mount isolation**: Each mount is an independent security boundary. No cross-mount path references are possible.
4. **No absolute paths**: The agent always uses logical paths (`mount-name/...`). Physical paths are never exposed.
