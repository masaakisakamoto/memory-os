export type PrePromptHookInput = {
  prompt: string
  project_id: string | null
  session_id: string
  draft_id?: string
}

export type PrePromptHookOutput = {
  allow: boolean
  mode: "pass" | "suggest" | "block"
  message: string | null
  continuity_result: {
    action: string
    severity: string
    issues_count: number
  }
}
