import { KeyedOperationLane } from '@mavis/shared/keyed-operation-lane';

import { SessionServiceError } from '../../session-system/sessions/errors.js';
import type { TurnController } from '../execution/contracts.js';
import type { TurnRepository } from '../persistence/contracts.js';
import type { QueueDispatcher } from '../queue.dispatcher.js';
import type { SessionTurnDeletionCapability } from './contracts.js';
import { type SessionOperationGate } from './session-operation-gate.js';

export interface SessionTurnDeletionServiceOptions {
  readonly repository: Pick<
    TurnRepository,
    'beginSessionDeletion' | 'readSessionDeletion' | 'deleteSessionData' | 'completeSessionDeletion'
  >;
  readonly controller: Pick<TurnController, 'abort' | 'activeTurnId'>;
  readonly dispatcher: Pick<QueueDispatcher, 'quiesceSession'>;
  readonly operations: SessionOperationGate;
  readonly beginProcessDeletion: (
    sessionId: string,
  ) => Promise<{ readonly status: 'started' | 'already-deleting' | 'not-found' }>;
  readonly completeProcessDeletion: (sessionId: string) => void;
  readonly disposeRuntimeSession: (sessionId: string) => Promise<void>;
  /** Best-effort sink for release failures during a refused deletion. */
  readonly onSessionDeletionReleaseFailure?: (input: {
    readonly sessionId: string;
    readonly error: unknown;
  }) => void;
}

export function createSessionTurnDeletionService(
  options: SessionTurnDeletionServiceOptions,
): SessionTurnDeletionCapability {
  const lane = new KeyedOperationLane<string>();

  return {
    run: (sessionId, cleanup, opts) =>
      lane.run(sessionId, async () => {
        const gate = await options.beginProcessDeletion(sessionId);
        if (gate.status === 'not-found') {
          await options.repository.completeSessionDeletion(sessionId);
          options.operations.release(sessionId);
          return;
        }
        const operationDrain = options.operations.block(sessionId);
        try {
          const dispatchDrain = options.dispatcher.quiesceSession(sessionId);
          // A refusal below rethrows without awaiting the dispatch drain, so
          // keep that promise observed to avoid an unhandled rejection.
          void dispatchDrain.catch(() => undefined);
          await options.repository.beginSessionDeletion(sessionId, opts);
          await Promise.all([operationDrain, dispatchDrain]);
          await requireQuiescentTurn(options, sessionId);
          await options.disposeRuntimeSession(sessionId);
          await options.repository.deleteSessionData(sessionId);
          await cleanup();
        } catch (error) {
          // Both refusal points share this release: the conditional claim
          // (the session was restored before any lock row was written) and
          // the guarded terminal row delete. Without the release the
          // in-memory process gate and the operations block would stay
          // taken until restart, and a restart-resume would pick the
          // restored session up and delete it unconditionally.
          if (error instanceof SessionServiceError && error.reason === 'session-not-archived') {
            await releaseSessionDeletionState(options, sessionId);
          }
          throw error;
        }
        await options.repository.completeSessionDeletion(sessionId);
        options.completeProcessDeletion(sessionId);
        options.operations.release(sessionId);
      }),
  };
}

/**
 * Same release trio as the success path, made best-effort: each release is
 * reported and skipped on failure so a broken release can never mask the
 * original session-not-archived refusal.
 */
async function releaseSessionDeletionState(
  options: SessionTurnDeletionServiceOptions,
  sessionId: string,
): Promise<void> {
  try {
    await options.repository.completeSessionDeletion(sessionId);
  } catch (error) {
    options.onSessionDeletionReleaseFailure?.({ sessionId, error });
  }
  try {
    options.completeProcessDeletion(sessionId);
  } catch (error) {
    options.onSessionDeletionReleaseFailure?.({ sessionId, error });
  }
  try {
    options.operations.release(sessionId);
  } catch (error) {
    options.onSessionDeletionReleaseFailure?.({ sessionId, error });
  }
}

async function requireQuiescentTurn(
  options: SessionTurnDeletionServiceOptions,
  sessionId: string,
): Promise<void> {
  const activeTurnId = options.controller.activeTurnId(sessionId);
  const abort = await options.controller.abort({
    sessionId,
    ...(activeTurnId ? { turnId: activeTurnId } : {}),
    reason: 'session-delete',
  });
  if (abort.status === 'abort-timeout') {
    throw new Error(
      `Active Turn did not release before Session deletion: ${sessionId}/${abort.turnId}`,
    );
  }
  const durable = await options.repository.readSessionDeletion(sessionId);
  const remainingTurnId = options.controller.activeTurnId(sessionId);
  if (durable.status === 'active' || remainingTurnId) {
    throw new Error(
      `Active Turn did not reach deletion quiescence: ${sessionId}/${
        durable.status === 'active' ? durable.turnId : remainingTurnId
      }`,
    );
  }
  if (durable.status !== 'quiescent') {
    throw new Error(`Turn deletion lock was lost: ${sessionId}`);
  }
}
