import type { Role } from "../schema/status";

/**
 * Who makes a tool call. Roles work on the active task; the product owner works on a refinement
 * (before the pipeline) and is not a task role.
 */
export type Identity =
  | { kind: "main" }
  | { kind: "role"; role: Role }
  | { kind: "product-owner" }
  | { kind: "other"; agentType: string };

/** Plugin agents report agent_type "aw:coder" (tolerate a "plugin:" prefix). No agent_type = the main session. */
const AW_ROLE_AGENT = /(?:^|:)aw:(tester|reviewer|coder)$/;
const AW_PRODUCT_OWNER_AGENT = /(?:^|:)aw:product-owner$/;

export function identify(agentType: unknown): Identity {
  if (typeof agentType !== "string" || agentType === "") return { kind: "main" };
  const role = AW_ROLE_AGENT.exec(agentType);
  if (role) return { kind: "role", role: role[1] as Role };
  if (AW_PRODUCT_OWNER_AGENT.test(agentType)) return { kind: "product-owner" };
  return { kind: "other", agentType };
}

/** aw's own subagents: the hooks restrict them, and fail closed for them on an internal error. */
export function isAwAgent(identity: Identity): boolean {
  return identity.kind === "role" || identity.kind === "product-owner";
}
