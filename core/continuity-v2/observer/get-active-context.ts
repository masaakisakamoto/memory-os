import type {
  ActiveContextSnapshot,
  DecisionRecord,
  PolicyRecord,
  ProjectState,
} from "../types"

export type GetActiveContextInput = {
  project: ProjectState | null
  globalPolicies?: PolicyRecord[]
  projectPolicies?: PolicyRecord[]
  activeDecisions?: DecisionRecord[]
}

export function getActiveContext(
  input: GetActiveContextInput,
): ActiveContextSnapshot {
  return {
    project: input.project,
    globalPolicies: input.globalPolicies ?? [],
    projectPolicies: input.projectPolicies ?? [],
    activeDecisions: input.activeDecisions ?? [],
  }
}
