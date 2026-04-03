import type { ContinuityLedgerEvent } from "../types"

export function appendEvent(
  events: ContinuityLedgerEvent[],
  event: ContinuityLedgerEvent,
): ContinuityLedgerEvent[] {
  return [...events, event]
}
