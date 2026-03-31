import { describe, it, expect } from "vitest";
import { getGstackRoles, registerGstackRoles, unregisterGstackRoles } from "./gstack-roles.js";
import { AgentRegistry, createDefaultRegistry } from "./leader-agent.js";

describe("getGstackRoles() definitions", () => {
  it("defines 8 cognitive roles", () => {
    expect(getGstackRoles()).toHaveLength(8);
  });

  it("all roles have category 'gstack'", () => {
    for (const role of getGstackRoles()) {
      expect(role.category).toBe("gstack");
    }
  });

  it("all roles have unique agentIds", () => {
    const ids = getGstackRoles().map((r) => r.agentId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("all roles have non-empty triggers", () => {
    for (const role of getGstackRoles()) {
      expect(role.triggers.length).toBeGreaterThan(0);
    }
  });

  it("all roles have systemPrompt", () => {
    for (const role of getGstackRoles()) {
      expect(role.systemPrompt).toBeTruthy();
    }
  });

  it("no trigger overlap between gstack and default domain agents", () => {
    const registry = createDefaultRegistry();
    const domainTriggers = new Set<string>();
    for (const agent of registry.getAll()) {
      for (const t of agent.triggers) {
        domainTriggers.add(t.toLowerCase());
      }
    }

    for (const role of getGstackRoles()) {
      for (const trigger of role.triggers) {
        expect(domainTriggers.has(trigger.toLowerCase())).toBe(false);
      }
    }
  });
});

describe("registerGstackRoles", () => {
  it("registers all 8 roles into a registry", () => {
    const registry = new AgentRegistry();
    const count = registerGstackRoles(registry);
    expect(count).toBe(8);
    expect(registry.size).toBe(8);
  });

  it("registers alongside default domain agents", () => {
    const registry = createDefaultRegistry();
    expect(registry.size).toBe(3);

    registerGstackRoles(registry);
    expect(registry.size).toBe(11); // 3 domain + 8 gstack
  });

  it("gstack roles are retrievable by category", () => {
    const registry = createDefaultRegistry();
    registerGstackRoles(registry);

    const gstackAgents = registry.getByCategory("gstack");
    expect(gstackAgents).toHaveLength(8);

    const domainAgents = registry.getByCategory("domain");
    expect(domainAgents).toHaveLength(3);
  });
});

describe("unregisterGstackRoles", () => {
  it("removes all gstack roles", () => {
    const registry = createDefaultRegistry();
    registerGstackRoles(registry);
    expect(registry.size).toBe(11);

    const removed = unregisterGstackRoles(registry);
    expect(removed).toBe(8);
    expect(registry.size).toBe(3); // only domain agents remain
  });

  it("returns 0 if no gstack roles were registered", () => {
    const registry = new AgentRegistry();
    const removed = unregisterGstackRoles(registry);
    expect(removed).toBe(0);
  });
});
