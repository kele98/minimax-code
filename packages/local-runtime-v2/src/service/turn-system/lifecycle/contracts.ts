export interface SessionTurnDeletionCapability {
  run(
    sessionId: string,
    cleanup: () => Promise<void>,
    opts?: { readonly expectedArchived?: boolean },
  ): Promise<void>;
}
