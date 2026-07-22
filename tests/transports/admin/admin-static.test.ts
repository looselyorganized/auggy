import { describe, expect, it } from "bun:test";
import {
  fstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveStaticFile, serveStaticFileWithHooks } from "@/transports/admin/admin-static";

function makeStaticFixture(prefix: string): {
  root: string;
  staticDir: string;
  assetsDir: string;
  assetPath: string;
  outsideDir: string;
  outsideAssetPath: string;
} {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const staticDir = join(root, "dist");
  const assetsDir = join(staticDir, "assets");
  const assetPath = join(assetsDir, "app.js");
  const outsideDir = join(root, "outside");
  const outsideAssetPath = join(outsideDir, "app.js");
  mkdirSync(assetsDir, { recursive: true });
  mkdirSync(outsideDir);
  writeFileSync(assetPath, "SAFE");
  writeFileSync(outsideAssetPath, "SECRET");
  return { root, staticDir, assetsDir, assetPath, outsideDir, outsideAssetPath };
}

function expectClosed(descriptor: number): void {
  expect(() => fstatSync(descriptor)).toThrow();
}

describe("serveStaticFile descriptor confinement", () => {
  it("serves an in-root symlink through its canonical regular file", async () => {
    const fixture = makeStaticFixture("auggy-admin-static-link-");
    const linkedPath = join(fixture.assetsDir, "linked.js");
    symlinkSync("app.js", linkedPath, "file");

    try {
      const response = serveStaticFile(fixture.staticDir, "assets/linked.js");
      expect(response?.status).toBe(200);
      expect(await response?.text()).toBe("SAFE");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects a leaf replaced by an outside symlink before open", async () => {
    const fixture = makeStaticFixture("auggy-admin-static-leaf-race-");
    const retainedPath = join(fixture.assetsDir, "retained.js");
    let beforeOpenCalls = 0;
    let beforeReadCalls = 0;
    let closeCalls = 0;

    try {
      const response = serveStaticFileWithHooks(fixture.staticDir, "assets/app.js", {
        beforeOpen: (path) => {
          beforeOpenCalls += 1;
          renameSync(path, retainedPath);
          symlinkSync(fixture.outsideAssetPath, path, "file");
        },
        beforeRead: () => {
          beforeReadCalls += 1;
        },
        afterClose: () => {
          closeCalls += 1;
        },
      });

      if (response) {
        expect(response.status).toBe(403);
        expect(await response.text()).not.toContain("SECRET");
      } else {
        expect(response).toBeNull();
      }
      expect(readFileSync(fixture.assetPath, "utf8")).toBe("SECRET");
      expect(beforeOpenCalls).toBe(1);
      expect(beforeReadCalls).toBe(0);
      expect(closeCalls).toBe(0);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects a parent replaced by an outside symlink before open", async () => {
    const fixture = makeStaticFixture("auggy-admin-static-parent-race-");
    const retainedAssetsDir = join(fixture.staticDir, "assets-retained");
    let openedDescriptor: number | undefined;
    let beforeReadCalls = 0;
    let closeCalls = 0;

    try {
      const response = serveStaticFileWithHooks(fixture.staticDir, "assets/app.js", {
        beforeOpen: () => {
          renameSync(fixture.assetsDir, retainedAssetsDir);
          symlinkSync(fixture.outsideDir, fixture.assetsDir, "dir");
        },
        afterOpen: (descriptor) => {
          openedDescriptor = descriptor;
        },
        beforeRead: () => {
          beforeReadCalls += 1;
        },
        afterClose: () => {
          closeCalls += 1;
        },
      });

      expect(response?.status).toBe(403);
      expect(await response?.text()).toBe("forbidden");
      expect(readFileSync(fixture.assetPath, "utf8")).toBe("SECRET");
      expect(openedDescriptor).toBeDefined();
      expectClosed(openedDescriptor as number);
      expect(beforeReadCalls).toBe(0);
      expect(closeCalls).toBe(1);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("reads the opened file after the requested path is replaced", async () => {
    const fixture = makeStaticFixture("auggy-admin-static-read-race-");
    const retainedPath = join(fixture.assetsDir, "retained.js");
    const twiceRetainedPath = join(fixture.assetsDir, "opened.js");
    let openedDescriptor: number | undefined;
    let closeCalls = 0;

    try {
      const response = serveStaticFileWithHooks(fixture.staticDir, "assets/app.js", {
        afterOpen: (descriptor, path) => {
          openedDescriptor = descriptor;
          renameSync(path, retainedPath);
          symlinkSync(fixture.outsideAssetPath, path, "file");
        },
        beforeRead: () => {
          renameSync(retainedPath, twiceRetainedPath);
          symlinkSync(fixture.outsideAssetPath, retainedPath, "file");
        },
        afterClose: () => {
          closeCalls += 1;
        },
      });

      expect(response?.status).toBe(200);
      expect(await response?.text()).toBe("SAFE");
      expect(readFileSync(fixture.assetPath, "utf8")).toBe("SECRET");
      expect(readFileSync(retainedPath, "utf8")).toBe("SECRET");
      expect(openedDescriptor).toBeDefined();
      expectClosed(openedDescriptor as number);
      expect(closeCalls).toBe(1);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects a non-regular opened descriptor and still closes it", () => {
    if (process.platform === "win32") return;
    const fixture = makeStaticFixture("auggy-admin-static-directory-");
    let openedDescriptor: number | undefined;
    let closeCalls = 0;

    try {
      const response = serveStaticFileWithHooks(fixture.staticDir, "assets/app.js", {
        beforeOpen: (path) => {
          rmSync(path);
          mkdirSync(path);
        },
        afterOpen: (descriptor) => {
          openedDescriptor = descriptor;
        },
        afterClose: () => {
          closeCalls += 1;
        },
      });

      expect(response).toBeNull();
      expect(openedDescriptor).toBeDefined();
      expectClosed(openedDescriptor as number);
      expect(closeCalls).toBe(1);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("fails closed when the runtime cannot resolve the opened descriptor path", () => {
    const fixture = makeStaticFixture("auggy-admin-static-no-descriptor-path-");
    let openedDescriptor: number | undefined;
    let beforeReadCalls = 0;
    let closeCalls = 0;

    try {
      const response = serveStaticFileWithHooks(fixture.staticDir, "assets/app.js", {
        afterOpen: (descriptor) => {
          openedDescriptor = descriptor;
        },
        resolveOpenedPath: () => undefined,
        beforeRead: () => {
          beforeReadCalls += 1;
        },
        afterClose: () => {
          closeCalls += 1;
        },
      });

      expect(response?.status).toBe(503);
      expect(beforeReadCalls).toBe(0);
      expect(closeCalls).toBe(1);
      expect(openedDescriptor).toBeDefined();
      expectClosed(openedDescriptor as number);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("closes the descriptor when validation succeeds but reading is interrupted", () => {
    const fixture = makeStaticFixture("auggy-admin-static-read-error-");
    let openedDescriptor: number | undefined;
    let closeCalls = 0;

    try {
      const response = serveStaticFileWithHooks(fixture.staticDir, "assets/app.js", {
        afterOpen: (descriptor) => {
          openedDescriptor = descriptor;
        },
        beforeRead: () => {
          throw new Error("simulated read interruption");
        },
        afterClose: () => {
          closeCalls += 1;
        },
      });

      expect(response).toBeNull();
      expect(closeCalls).toBe(1);
      expect(openedDescriptor).toBeDefined();
      expectClosed(openedDescriptor as number);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
