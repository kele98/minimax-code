import type { TuiSession } from './port.js';
import { isTuiInternalSubagentSession } from './delegation.js';

const HIDDEN_BRANCH_EXCLUDED_PURPOSE_PREFIXES = ['peek_', 'peek:'] as const;

export interface SessionVisibilityProjection {
  readonly visibility?: string;
  readonly parentSessionId?: string;
  readonly purpose?: string;
}

function isSurfaceableHiddenBranch(session: SessionVisibilityProjection): boolean {
  if (session.visibility !== 'hidden' || !session.parentSessionId) return false;
  const purpose = session.purpose ?? '';
  return !HIDDEN_BRANCH_EXCLUDED_PURPOSE_PREFIXES.some((prefix) => purpose.startsWith(prefix));
}

/**
 * Single source of truth for which sessions the Session manager surfaces:
 * internal sub-agent workers are never listed, and hidden sessions only when
 * they are user-hidden branches (peek sessions stay out). Both the visible
 * list and the bulk-delete enumeration must agree on this predicate, or the
 * confirm count diverges from what the picker shows.
 */
export function isSessionManagerVisible(session: TuiSession): boolean {
  return (
    !isTuiInternalSubagentSession(session) &&
    (session.visibility !== 'hidden' || isSurfaceableHiddenBranch(session))
  );
}
