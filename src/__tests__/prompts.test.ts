/**
 * Prompts may only name tools this server actually serves. A prompt that
 * points the model at data no tool returns (patch-gaps did, before the
 * patches domain existed) gets invented answers back.
 */

import { describe, it, expect } from "vitest";
import type { Server } from "@modelcontextprotocol/server";
import { registerPromptHandlers } from "../prompts.js";
import { getAvailableDomains, getDomainHandler } from "../domains/index.js";

type Handler = (request: { params: Record<string, unknown> }) => Promise<unknown>;

interface PromptList {
  prompts: Array<{ name: string }>;
}

interface PromptResult {
  messages: Array<{ content: { text: string } }>;
}

function promptHandlers(): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const stub = {
    setRequestHandler: (method: string, handler: Handler) => handlers.set(method, handler),
  };
  registerPromptHandlers(stub as unknown as Server);
  return handlers;
}

async function servedToolNames(): Promise<Set<string>> {
  const names = new Set(["ninjaone_navigate", "ninjaone_status"]);
  for (const domain of getAvailableDomains()) {
    const handler = await getDomainHandler(domain);
    for (const tool of handler.getTools()) names.add(tool.name);
  }
  return names;
}

async function renderAll(): Promise<Map<string, string>> {
  const handlers = promptHandlers();
  const list = (await handlers.get("prompts/list")!({ params: {} })) as PromptList;
  const rendered = new Map<string, string>();
  for (const { name } of list.prompts) {
    for (const args of [undefined, { org_name: "Acme Corp" }]) {
      const result = (await handlers.get("prompts/get")!({
        params: { name, arguments: args },
      })) as PromptResult;
      const text = result.messages.map((m) => m.content.text).join("\n");
      rendered.set(`${name}${args ? " (org)" : ""}`, text);
    }
  }
  return rendered;
}

describe("prompts", () => {
  it("name only tools this server serves", async () => {
    const tools = await servedToolNames();
    const rendered = await renderAll();

    expect(rendered.size).toBeGreaterThan(0);
    for (const [prompt, text] of rendered) {
      const unknown = (text.match(/ninjaone_[a-z_]+/g) ?? []).filter((t) => !tools.has(t));
      expect(unknown, `prompt ${prompt}`).toEqual([]);
    }
  });

  it("ground patch-gaps in the patch report tools", async () => {
    const rendered = await renderAll();
    const text = rendered.get("patch-gaps")!;

    expect(text).toContain("ninjaone_patches_os_list");
    expect(text).toContain("ninjaone_patches_os_installs_list");
    expect(text).toContain("ninjaone_patches_software_list");
    expect(text).toContain("do not\nestimate counts");
    expect(rendered.get("patch-gaps (org)")).toContain("in Acme Corp");
  });
});
