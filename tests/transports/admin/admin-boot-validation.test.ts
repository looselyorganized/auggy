import { describe, expect, it } from "bun:test";
import { buildAdminActionRegistry } from "@/transports/admin/index";
import type { Augment } from "@/types";

describe("buildAdminActionRegistry", () => {
  it("returns empty registry when no augment declares adminInfo", async () => {
    const augments: Augment[] = [{ name: "test" }];
    const registry = await buildAdminActionRegistry(augments);
    expect(registry.size).toBe(0);
  });

  it("registers action handlers when adminInfo's declared actions all have handlers", async () => {
    const augments: Augment[] = [
      {
        name: "test",
        adminInfo: async () => ({
          augmentName: "test",
          title: "Test",
          sections: [],
          actions: [{ id: "test-action", label: "Do it", confirmRequired: false }],
        }),
        adminActions: {
          "test-action": async () => ({ ok: true, message: "ok" }),
        },
      },
    ];
    const registry = await buildAdminActionRegistry(augments);
    expect(registry.size).toBe(1);
    expect(registry.get("test-action")?.augmentName).toBe("test");
    expect(registry.get("test-action")?.isRowAction).toBe(false);
  });

  it("registers inputs from the action declaration", async () => {
    const augments: Augment[] = [
      {
        name: "test",
        adminInfo: async () => ({
          augmentName: "test",
          title: "Test",
          sections: [],
          actions: [
            {
              id: "act",
              label: "X",
              confirmRequired: false,
              inputs: [{ name: "n", label: "N", type: "number", required: true }],
            },
          ],
        }),
        adminActions: { act: async () => ({ ok: true, message: "" }) },
      },
    ];
    const registry = await buildAdminActionRegistry(augments);
    expect(registry.get("act")?.inputs).toHaveLength(1);
    expect(registry.get("act")?.inputs[0]?.name).toBe("n");
  });

  it("registers row actions with isRowAction=true", async () => {
    const augments: Augment[] = [
      {
        name: "memory",
        adminInfo: async () => ({
          augmentName: "memory",
          title: "Memory",
          sections: [
            {
              kind: "table",
              columns: ["peer"],
              rows: [["a"]],
              rowActions: [{ id: "erase", label: "Erase", confirmRequired: true, rowKeyColumn: 0 }],
            },
          ],
        }),
        adminActions: { erase: async () => ({ ok: true, message: "" }) },
      },
    ];
    const registry = await buildAdminActionRegistry(augments);
    expect(registry.get("erase")?.isRowAction).toBe(true);
  });

  it("throws when adminInfo declares an action with no matching handler", async () => {
    const augments: Augment[] = [
      {
        name: "test",
        adminInfo: async () => ({
          augmentName: "test",
          title: "Test",
          sections: [],
          actions: [{ id: "missing", label: "Missing", confirmRequired: false }],
        }),
        adminActions: {},
      },
    ];
    await expect(buildAdminActionRegistry(augments)).rejects.toThrow(
      /augment "test" declares action "missing" but does not provide an adminActions handler/,
    );
  });

  it("throws when rowAction in a table section has no matching handler", async () => {
    const augments: Augment[] = [
      {
        name: "test",
        adminInfo: async () => ({
          augmentName: "test",
          title: "Test",
          sections: [
            {
              kind: "table",
              columns: ["id"],
              rows: [["a"]],
              rowActions: [
                { id: "row-missing", label: "Erase", confirmRequired: false, rowKeyColumn: 0 },
              ],
            },
          ],
        }),
        adminActions: {},
      },
    ];
    await expect(buildAdminActionRegistry(augments)).rejects.toThrow(
      /augment "test" declares action "row-missing" but does not provide an adminActions handler/,
    );
  });

  it("throws when two augments declare the same action id (O12 uniqueness)", async () => {
    const augments: Augment[] = [
      {
        name: "first",
        adminInfo: async () => ({
          augmentName: "first",
          title: "First",
          sections: [],
          actions: [{ id: "shared", label: "X", confirmRequired: false }],
        }),
        adminActions: { shared: async () => ({ ok: true, message: "" }) },
      },
      {
        name: "second",
        adminInfo: async () => ({
          augmentName: "second",
          title: "Second",
          sections: [],
          actions: [{ id: "shared", label: "Y", confirmRequired: false }],
        }),
        adminActions: { shared: async () => ({ ok: true, message: "" }) },
      },
    ];
    await expect(buildAdminActionRegistry(augments)).rejects.toThrow(
      /action id "shared" declared by multiple augments/,
    );
  });

  it("registers reset actions from keyValue sections", async () => {
    const augments: Augment[] = [
      {
        name: "budgets",
        adminInfo: async () => ({
          augmentName: "budgets",
          title: "Budgets",
          sections: [
            {
              kind: "keyValue",
              rows: [
                {
                  label: "Daily cap",
                  value: "$30",
                  resetAction: { id: "budget-reset", label: "Reset" },
                },
              ],
            },
          ],
        }),
        adminActions: { "budget-reset": async () => ({ ok: true, message: "" }) },
      },
    ];
    const registry = await buildAdminActionRegistry(augments);
    expect(registry.get("budget-reset")?.augmentName).toBe("budgets");
  });

  it("skips augment whose adminInfo throws (logs warning, doesn't fail boot)", async () => {
    const augments: Augment[] = [
      {
        name: "broken",
        adminInfo: async () => {
          throw new Error("kaboom");
        },
        adminActions: {},
      },
      {
        name: "ok",
        adminInfo: async () => ({
          augmentName: "ok",
          title: "OK",
          sections: [],
          actions: [{ id: "ok-action", label: "OK", confirmRequired: false }],
        }),
        adminActions: { "ok-action": async () => ({ ok: true, message: "" }) },
      },
    ];
    const registry = await buildAdminActionRegistry(augments);
    expect(registry.has("ok-action")).toBe(true);
  });
});
