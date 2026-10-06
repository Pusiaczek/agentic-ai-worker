import { z } from "zod";
import type { Role } from "../schema/status";

/**
 * Who makes a tool call: the main session, a task role (tester, reviewer, coder), the product owner
 * (works on a refinement before the pipeline, not a task role), or another agent (e.g. Explore).
 */
export const IdentityKind = z.enum(["mainSession", "taskRole", "productOwner", "otherAgent"]);

/** Check the kind with the predicates below (`isTaskRole(who)`), not by comparing `who.kind` by hand. */
export type Identity =
  | { kind: typeof IdentityKind.enum.mainSession }
  | { kind: typeof IdentityKind.enum.taskRole; role: Role }
  | { kind: typeof IdentityKind.enum.productOwner }
  | { kind: typeof IdentityKind.enum.otherAgent; agentType: string };

/** aw:tester, aw:reviewer or aw:coder, with its role. */
export type TaskRoleIdentity = Extract<Identity, { kind: typeof IdentityKind.enum.taskRole }>;

/** Plugin agents report agent_type "aw:coder" (tolerate a "plugin:" prefix). No agent_type = the main session. */
const AW_ROLE_AGENT = /(?:^|:)aw:(tester|reviewer|coder)$/;
const AW_PRODUCT_OWNER_AGENT = /(?:^|:)aw:product-owner$/;

export function identify(agentType: unknown): Identity {
  if (typeof agentType !== "string" || agentType === "") return { kind: IdentityKind.enum.mainSession };
  const role = AW_ROLE_AGENT.exec(agentType);
  if (role) return { kind: IdentityKind.enum.taskRole, role: role[1] as Role };
  if (AW_PRODUCT_OWNER_AGENT.test(agentType)) return { kind: IdentityKind.enum.productOwner };
  return { kind: IdentityKind.enum.otherAgent, agentType };
}

/** aw:tester, aw:reviewer or aw:coder. After this check, `who.role` says which. */
export function isTaskRole(who: Identity): who is TaskRoleIdentity {
  return who.kind === IdentityKind.enum.taskRole;
}

/** aw:product-owner, which splits a slice into tasks (`aw refine`). */
export function isProductOwner(who: Identity): boolean {
  return who.kind === IdentityKind.enum.productOwner;
}

/** A subagent that isn't aw's own, e.g. Explore or general-purpose. */
export function isOtherAgent(who: Identity): boolean {
  return who.kind === IdentityKind.enum.otherAgent;
}

/** aw's own subagents: the hooks restrict them, and fail closed for them on an internal error. */
export function isAwAgent(who: Identity): boolean {
  return isTaskRole(who) || isProductOwner(who);
}
