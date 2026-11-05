/**
 * The card bridge a card page gets, if any. A tab an agent added to a card that is not its own (`agentTab`, set by the card API) gets
 * none: with the owner's sign-in the bridge would let that page read and rewrite the owner's other tabs of the card.
 */
export function bridgeFor(card?: { workspace: string; id: string; agentTab?: boolean }): { workspace: string; id: string } | undefined {
  return card && !card.agentTab ? { workspace: card.workspace, id: card.id } : undefined
}
