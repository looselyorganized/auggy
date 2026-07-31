import { describe, expect, it } from "bun:test";
import { adminActionRegistryKey, buildAdminActionRegistry } from "@/transports/admin/index";
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
    expect(registry.get(adminActionRegistryKey("test", "test-action"))?.augmentName).toBe("test");
    expect(registry.get(adminActionRegistryKey("test", "test-action"))?.isRowAction).toBe(false);
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
    expect(registry.get(adminActionRegistryKey("test", "act"))?.inputs).toHaveLength(1);
    expect(registry.get(adminActionRegistryKey("test", "act"))?.inputs[0]?.name).toBe("n");
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
              rowActions: [
                {
                  id: "erase",
                  label: "Erase",
                  confirmRequired: true,
                  rowKeyColumn: 0,
                  inputs: [
                    {
                      name: "expectedVersion",
                      label: "Version",
                      type: "number",
                      required: true,
                    },
                  ],
                },
              ],
            },
          ],
        }),
        adminActions: { erase: async () => ({ ok: true, message: "" }) },
      },
    ];
    const registry = await buildAdminActionRegistry(augments);
    expect(registry.get(adminActionRegistryKey("memory", "erase"))?.isRowAction).toBe(true);
    expect(registry.get(adminActionRegistryKey("memory", "erase"))?.inputs[0]?.name).toBe(
      "expectedVersion",
    );
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

  it("registers the same action id independently for two augment targets", async () => {
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
    const registry = await buildAdminActionRegistry(augments);
    expect(registry.size).toBe(2);
    expect(registry.get(adminActionRegistryKey("first", "shared"))?.augmentName).toBe("first");
    expect(registry.get(adminActionRegistryKey("second", "shared"))?.augmentName).toBe("second");
  });

  it("rejects duplicate mounted augment names before action registration", async () => {
    const augments: Augment[] = [{ name: "duplicate" }, { name: "duplicate" }];
    await expect(buildAdminActionRegistry(augments)).rejects.toThrow(
      /duplicate mounted augment name "duplicate"/,
    );
  });

  it("keys renamed augments by mounted runtime name instead of presentation fallback", async () => {
    const augments: Augment[] = [
      {
        name: "mail-west",
        adminInfo: async () => ({
          augmentName: "agent-mail",
          title: "Mail",
          sections: [],
          actions: [{ id: "sync", label: "Sync", confirmRequired: false }],
        }),
        adminActions: { sync: async () => ({ ok: true, message: "ok" }) },
      },
    ];
    const registry = await buildAdminActionRegistry(augments);
    expect(registry.has(adminActionRegistryKey("mail-west", "sync"))).toBe(true);
    expect(registry.has(adminActionRegistryKey("agent-mail", "sync"))).toBe(false);
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
    expect(registry.get(adminActionRegistryKey("budgets", "budget-reset"))?.augmentName).toBe(
      "budgets",
    );
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
    expect(registry.has(adminActionRegistryKey("ok", "ok-action"))).toBe(true);
  });
});
