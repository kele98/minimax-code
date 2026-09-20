import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { visibleWidth } from '../../src/tui/rendering/text.js';
import { TuiSessionManager } from '../../src/tui/features/session/manager.js';
import type { TuiSession } from '../../src/runtime/port.js';

const NOW = new Date('2026-07-26T05:00:00.000Z').getTime();

const sessions: TuiSession[] = [
  {
    sessionId: 'session-current',
    title: 'Fix the login flow',
    workspaceDir: '/workspace',
    updatedAt: NOW - 2 * 60 * 1000,
    status: 'finished',
  },
  {
    sessionId: 'session-other',
    title: 'Refactor the runtime',
    workspaceDir: '/other-workspace',
    updatedAt: NOW - 60 * 60 * 1000,
    status: 'started',
  },
  {
    sessionId: 'session-archived',
    title: 'Archived investigation',
    workspaceDir: '/workspace',
    updatedAt: NOW - 24 * 60 * 60 * 1000,
    archived: true,
  },
];

function sessionById(sessionId: string): TuiSession {
  const session = sessions.find((item) => item.sessionId === sessionId);
  if (!session) throw new Error(`Missing test session: ${sessionId}`);
  return session;
}

function renderPlain(manager: TuiSessionManager, width = 100): string {
  return stripVTControlCharacters(manager.render(width).join('\n'));
}

async function flushActions(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

function createManager(
  overrides: Partial<ConstructorParameters<typeof TuiSessionManager>[0]> = {},
) {
  const callbacks = {
    onSelect: vi.fn(async () => undefined),
    onNew: vi.fn(async () => undefined),
    onRename: vi.fn(async (sessionId: string, title: string) => {
      const session = sessions.find((item) => item.sessionId === sessionId);
      return { ...(session ?? { sessionId }), title };
    }),
    onSetArchived: vi.fn(async () => undefined),
    onDelete: vi.fn(async () => undefined),
    onEnumerateArchived: vi.fn(async () => [sessionById('session-archived')]),
    onCancel: vi.fn(),
    requestRender: vi.fn(),
  };
  const manager = new TuiSessionManager({
    sessions,
    activeSessionId: 'session-current',
    workspaceDir: '/workspace',
    now: () => NOW,
    ...callbacks,
    ...overrides,
  });
  return { callbacks, manager };
}

describe('TuiSessionManager', () => {
  it('shows navigable hidden branches while hiding delegated workers and peek sessions', () => {
    const child: TuiSession = {
      sessionId: 'session-child',
      agentName: 'verifier',
      title: 'Review recent CLI changes',
      parentSessionId: 'session-current',
      sessionType: 'branch',
      sessionKind: 'task',
      visibility: 'visible',
      purpose: 'local-task:turn-1:tool-1',
      workspaceDir: '/workspace',
      updatedAt: NOW - 60_000,
      status: 'finished',
    };
    const unrelatedHidden: TuiSession = {
      ...child,
      sessionId: 'session-internal',
      sessionKind: 'peek',
      visibility: 'hidden',
      purpose: 'peek:internal',
      title: 'Internal peek',
    };
    const fork: TuiSession = {
      ...child,
      sessionId: 'session-fork',
      agentName: 'mavis',
      sessionKind: 'conversation-rewind',
      visibility: 'hidden',
      purpose: 'conversation-rewind',
      title: 'Fork from login prompt',
    };
    const historicalExplore: TuiSession = {
      sessionId: 'session-historical-explore',
      agentName: 'explore',
      sessionType: 'root',
      sessionKind: 'conversation',
      visibility: 'visible',
      title: 'Historical exploration',
      workspaceDir: '/workspace',
      updatedAt: NOW - 30_000,
    };
    const { manager } = createManager({
      sessions: [...sessions, child, unrelatedHidden, fork, historicalExplore],
    });

    const rendered = renderPlain(manager);
    expect(rendered).not.toContain('Sub-agent · verifier');
    expect(rendered).not.toContain('Review recent CLI changes');
    expect(rendered).not.toContain('Internal peek');
    expect(rendered).not.toContain('Historical exploration');
    expect(rendered).toContain('Fork from login prompt');
  });

  it('keeps recent sessions limited to the current workspace', () => {
    const { manager } = createManager();

    const initial = renderPlain(manager);
    expect(initial).toContain('Sessions');
    expect(initial).toContain('Sessions');
    expect(initial).toMatch(/╰─+╯/);
    expect(initial).toContain('›');
    expect(initial).toContain('current');
    expect(renderPlain(manager)).not.toContain('SESSIONS');
    expect(renderPlain(manager)).toContain('Recent');
    expect(renderPlain(manager)).toContain('This workspace');
    expect(renderPlain(manager)).toContain('1 active · 1 archived');
    expect(renderPlain(manager)).toContain('Fix the login flow');
    expect(renderPlain(manager)).toContain('current');
    expect(renderPlain(manager)).toContain('Today');
    expect(renderPlain(manager)).toContain('Updated');
    expect(renderPlain(manager)).not.toContain('Refactor the runtime');
    expect(renderPlain(manager)).not.toContain('Archived investigation');

    manager.handleInput('\x01');
    expect(renderPlain(manager)).toContain('All sessions');
    expect(renderPlain(manager)).toContain('2 active · 1 archived');
    expect(renderPlain(manager)).toContain('Refactor the runtime');

    manager.handleInput('\t');
    expect(renderPlain(manager)).toContain('Archived');
    expect(renderPlain(manager)).toContain('Archived investigation');
    expect(renderPlain(manager)).not.toContain('Fix the login flow');
  });

  it('searches title and id in the current workspace before switching the selected session', async () => {
    const { callbacks, manager } = createManager();

    manager.handleInput('login');
    expect(renderPlain(manager)).toContain('Search');
    expect(renderPlain(manager)).toContain('Fix the login flow');
    expect(renderPlain(manager)).not.toContain('Refactor the runtime');

    manager.handleInput('\r');
    await vi.waitFor(() =>
      expect(callbacks.onSelect).toHaveBeenCalledWith('session-current', false),
    );
    await flushActions();

    manager.handleInput('\x1b');
    expect(callbacks.onCancel).not.toHaveBeenCalled();
    manager.handleInput('\x1b');
    expect(callbacks.onCancel).toHaveBeenCalledOnce();
  });

  it('starts with the query supplied by /sessions <query>', () => {
    const { manager } = createManager({ initialQuery: 'login' });

    const rendered = renderPlain(manager);

    expect(rendered).toContain('Fix the login flow');
    expect(rendered).not.toContain('Refactor the runtime');
  });

  it('supports structured Session filters without introducing a second catalog', () => {
    const target: TuiSession = {
      sessionId: 'session-target-branch',
      title: 'Target branch',
      parentSessionId: 'session-parent',
      sessionType: 'branch',
      sessionKind: 'conversation-rewind',
      visibility: 'hidden',
      workspaceDir: '/workspace/cli',
      updatedAt: NOW,
      status: 'finished',
      model: { providerId: 'minimax', modelId: 'MiniMax-M3' },
    };
    const { manager } = createManager({
      sessions: [target, ...sessions],
      workspaceDir: '/workspace/cli',
      initialQuery:
        'id:target-branch path:workspace/cli type:branch status:finished model:minimax-m3',
    });

    const rendered = renderPlain(manager);
    expect(rendered).toContain('Target branch');
    expect(rendered).not.toContain('Fix the login flow');
  });

  it('anchors selection by Session ID when the Runtime catalog is refreshed', async () => {
    const first: TuiSession = {
      sessionId: 'session-first',
      title: 'First session',
      workspaceDir: '/workspace',
      updatedAt: NOW,
    };
    const selected: TuiSession = {
      sessionId: 'session-selected',
      title: 'Selected session',
      workspaceDir: '/workspace',
      updatedAt: NOW - 60_000,
    };
    const inserted: TuiSession = {
      sessionId: 'session-inserted',
      title: 'Inserted session',
      workspaceDir: '/workspace',
      updatedAt: NOW + 60_000,
    };
    const { callbacks, manager } = createManager({
      sessions: [first, selected],
      activeSessionId: first.sessionId,
      maxRows: 18,
    });

    manager.handleInput('\u001b[B');
    manager.setSessions([inserted, first, selected]);
    manager.handleInput('\r');

    await vi.waitFor(() =>
      expect(callbacks.onSelect).toHaveBeenCalledWith(selected.sessionId, false),
    );
  });

  it('uses the Pi cancel binding to close an idle Session manager', () => {
    const { callbacks, manager } = createManager();

    manager.handleInput('\x03');

    expect(callbacks.onCancel).toHaveBeenCalledOnce();
  });

  it('keeps Pi cursor and forward-delete commands inside an active search Input', () => {
    const onScopeChange = vi.fn(async () => ({ sessions, hasMore: false }));
    const { callbacks, manager } = createManager({
      initialQuery: 'login',
      onScopeChange,
    });

    manager.handleInput('\u0001');
    manager.handleInput('\u0004');

    expect(renderPlain(manager)).toContain('Search ogin');
    expect(onScopeChange).not.toHaveBeenCalled();
    expect(callbacks.onSetArchived).not.toHaveBeenCalled();
  });

  it('loads every remaining page while a search is active', async () => {
    const onLoadMore = vi.fn(async () => ({
      sessions: [
        {
          sessionId: 'session-later-page',
          title: 'Investigate the search index',
          workspaceDir: '/workspace',
          updatedAt: NOW - 30_000,
        },
      ],
      hasMore: false,
    }));
    const { manager } = createManager({
      sessions: [sessions[0]!],
      hasMore: true,
      initialQuery: 'search index',
      onLoadMore,
    });

    expect(renderPlain(manager)).toContain('Searching saved sessions');
    await vi.waitFor(() => expect(onLoadMore).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(renderPlain(manager)).toContain('Investigate the search index'));
    expect(renderPlain(manager)).not.toContain('No matching sessions');
  });

  it('renames, archives, and restores the selected session from the manager', async () => {
    const { callbacks, manager } = createManager();

    manager.handleInput('\x12');
    expect(renderPlain(manager)).toContain('Rename session');
    expect(renderPlain(manager)).toContain('Fix the login flow');
    manager.handleInput('\x15');
    manager.handleInput('Renamed from CLI');
    manager.handleInput('\r');
    await vi.waitFor(() =>
      expect(callbacks.onRename).toHaveBeenCalledWith('session-current', 'Renamed from CLI'),
    );
    await flushActions();
    expect(renderPlain(manager)).toContain('Renamed from CLI');

    expect(renderPlain(manager)).not.toContain('fork');
    manager.handleInput('\x06');
    expect(renderPlain(manager)).not.toContain('Fork session');

    manager.handleInput('\x04');
    expect(renderPlain(manager)).toContain('Archive session?');
    manager.handleInput('\r');
    await vi.waitFor(() =>
      expect(callbacks.onSetArchived).toHaveBeenCalledWith('session-current', true),
    );
    await flushActions();

    manager.handleInput('\t');
    expect(renderPlain(manager)).toContain('Renamed from CLI');
    manager.handleInput('\x04');
    await vi.waitFor(() =>
      expect(callbacks.onSetArchived).toHaveBeenCalledWith('session-current', false),
    );
  });

  it('prefills rename, rejects empty titles, and skips unchanged titles', async () => {
    const { callbacks, manager } = createManager();

    manager.handleInput('\x12');
    expect(renderPlain(manager)).toContain('Fix the login flow');
    manager.handleInput('\r');
    await flushActions();
    expect(callbacks.onRename).not.toHaveBeenCalled();
    expect(renderPlain(manager)).toContain('Session title unchanged.');

    manager.handleInput('\x12');
    manager.handleInput('\x15');
    manager.handleInput('\r');
    expect(callbacks.onRename).not.toHaveBeenCalled();
    expect(renderPlain(manager)).toContain('Session title cannot be empty.');
  });

  it('opens rename mode for an explicitly selected Session', () => {
    const { manager } = createManager({ initialRenameSessionId: 'session-current' });

    expect(renderPlain(manager)).toContain('Sessions / Rename session');
    expect(renderPlain(manager)).toContain('Fix the login flow');
  });

  it('shows the current title only in the rename input and cancels without saving', () => {
    const { callbacks, manager } = createManager({ initialRenameSessionId: 'session-current' });

    expect(renderPlain(manager).split('Fix the login flow')).toHaveLength(2);
    manager.handleInput('\x15');
    expect(renderPlain(manager)).not.toContain('Fix the login flow');
    manager.handleInput('Unsaved title');
    manager.handleInput('\x1b');

    expect(callbacks.onRename).not.toHaveBeenCalled();
    expect(renderPlain(manager)).not.toContain('Rename session');
    expect(renderPlain(manager)).toContain('Fix the login flow');
  });

  it.each([34, 100])('edits a long title within a %i-column rename panel', async (width) => {
    const title = `WorkBuddy VNC 持久化部署${'很长的会话标题'.repeat(30)} end`;
    const { callbacks, manager } = createManager({
      sessions: [{ ...sessionById('session-current'), title }],
      initialRenameSessionId: 'session-current',
    });

    const lines = manager.render(width);
    expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    expect(stripVTControlCharacters(lines.join('\n'))).not.toContain('WorkBuddy');
    manager.handleInput('\x01');
    expect(renderPlain(manager, width)).toContain('WorkBuddy');
    manager.handleInput('Updated ');
    manager.handleInput('\r');

    await vi.waitFor(() =>
      expect(callbacks.onRename).toHaveBeenCalledWith('session-current', `Updated ${title}`),
    );
  });

  it('surfaces a direct-command fallback when the requested Session is not visible', () => {
    const { manager } = createManager({ initialRenameSessionId: 'session-missing' });

    expect(renderPlain(manager)).toContain('Use /rename <title> to rename it directly.');
  });

  it('keeps the rename editor open when Runtime rejects the new title', async () => {
    const onRename = vi.fn(async () => {
      throw new Error('Runtime rejected the title');
    });
    const { manager } = createManager({ onRename });

    manager.handleInput('\x12');
    manager.handleInput('\x15');
    manager.handleInput('Retry this title');
    manager.handleInput('\r');
    await vi.waitFor(() => expect(onRename).toHaveBeenCalledOnce());
    await flushActions();

    expect(renderPlain(manager)).toContain('Sessions / Rename session');
    expect(renderPlain(manager)).toContain('Session changes were not saved');
  });

  it('restores and opens an archived session with Enter and keeps every line in narrow bounds', async () => {
    const { callbacks, manager } = createManager();
    manager.handleInput('\t');

    const lines = manager.render(34);
    expect(lines.every((line) => visibleWidth(line) <= 34)).toBe(true);
    expect(stripVTControlCharacters(lines.join('\n'))).toContain('Sessions');
    expect(stripVTControlCharacters(lines.join('\n'))).toMatch(/╰─+╯/);

    manager.handleInput('\r');
    await vi.waitFor(() =>
      expect(callbacks.onSelect).toHaveBeenCalledWith('session-archived', true),
    );
  });

  it('reflows an open session card within a short terminal while preserving navigation and closure', () => {
    let maxRows = 24;
    const { manager } = createManager({
      maxRows: () => maxRows,
    });

    expect(manager.render(72).length).toBeGreaterThan(10);

    maxRows = 10;
    const lines = manager.render(24);
    const rendered = stripVTControlCharacters(lines.join('\n'));

    expect(lines.length).toBeLessThanOrEqual(maxRows);
    expect(lines.every((line) => visibleWidth(line) <= 24)).toBe(true);
    expect(rendered).toContain('Sessions');
    expect(rendered).toMatch(/╰─+╯/);
    expect(rendered).toContain('Sessions · Recent');
    expect(rendered).toContain('Workspace');
    expect(rendered).toContain('Search');
    expect(rendered).toContain('Fix the');
    expect(rendered).toContain('Enter');
    expect(rendered).toContain('Esc');
  });

  it('keeps the selected session visible in the six-row inline layout', () => {
    const { manager } = createManager({
      maxRows: 6,
    });

    const initial = renderPlain(manager, 40);
    expect(manager.render(40)).toHaveLength(6);
    expect(initial).toContain('Sessions · Recent');
    expect(initial).toContain('Fix the login flow');
    expect(initial).toContain('Enter');
    expect(initial).toContain('Esc');
    expect(initial).toContain('Search');

    manager.handleInput('\x1b[B');
    const moved = renderPlain(manager, 40);
    expect(moved).toContain('Fix the login flow');
    expect(moved).not.toContain('Refactor the runtime');
  });

  it('shows ten recent sessions in the standard inline selector', () => {
    const manySessions = Array.from(
      { length: 12 },
      (_, index): TuiSession => ({
        sessionId: `session-${String(index + 1).padStart(2, '0')}`,
        title: `Session ${String(index + 1).padStart(2, '0')}`,
        workspaceDir: '/workspace',
        updatedAt: NOW - index * 60_000,
      }),
    );
    const { manager } = createManager({
      sessions: manySessions,
      activeSessionId: manySessions[0]?.sessionId,
      maxRows: 18,
    });

    const lines = manager.render(80);
    const rendered = stripVTControlCharacters(lines.join('\n'));

    expect(lines.length).toBeLessThanOrEqual(18);
    expect(rendered).toContain('Session 01');
    expect(rendered).toContain('Session 10');
    expect(rendered).not.toContain('Session 11');
    expect(rendered).not.toContain('Session 12');
    expect(rendered).toContain('1/12');
  });

  it('loads and de-duplicates the next Runtime-owned session page', async () => {
    const onLoadMore = vi.fn(async () => ({
      sessions: [
        sessionById('session-current'),
        {
          sessionId: 'session-next-page',
          title: 'Loaded from next page',
          workspaceDir: '/workspace',
          updatedAt: NOW - 30 * 60 * 1000,
        },
      ],
      hasMore: false,
    }));
    const { manager } = createManager({
      sessions: [sessionById('session-current')],
      hasMore: true,
      onLoadMore,
    });

    expect(renderPlain(manager)).toContain('More sessions available');
    manager.handleInput('\x0c');

    await vi.waitFor(() => expect(onLoadMore).toHaveBeenCalledOnce());
    await flushActions();
    expect(renderPlain(manager)).toContain('Loaded from next page');
    expect(renderPlain(manager)).toContain('2 active · 0 archived');
    expect(renderPlain(manager)).toContain('All matching sessions loaded');
  });

  it('reloads the catalog with an independent backend scope when Ctrl+A is pressed', async () => {
    const onScopeChange = vi.fn(async (scope: 'workspace' | 'all') => ({
      sessions:
        scope === 'workspace'
          ? [sessionById('session-current')]
          : [sessionById('session-current'), sessionById('session-other')],
      hasMore: scope === 'all',
    }));
    const { manager } = createManager({
      sessions: [sessionById('session-current')],
      hasMore: false,
      onLoadMore: vi.fn(async () => ({ sessions: [], hasMore: false })),
      onScopeChange,
      maxRows: 18,
    });

    const initial = renderPlain(manager);
    expect(initial).toContain('Ctrl+A all');

    manager.handleInput('\x01');
    await vi.waitFor(() => expect(onScopeChange).toHaveBeenCalledWith('all'));
    await flushActions();

    const all = renderPlain(manager);
    expect(all).toContain('All sessions');
    expect(all).toContain('2 active · 0 archived');
    expect(all).toContain('Ctrl+A current');
    expect(all).toContain('Ctrl+L more');

    manager.handleInput('\x01');
    await vi.waitFor(() => expect(onScopeChange).toHaveBeenCalledWith('workspace'));
    await flushActions();
    expect(renderPlain(manager)).toContain('Recent · This workspace');
    expect(renderPlain(manager)).toContain('1 active · 0 archived');
  });

  it('keeps the current workspace catalog when a scope reload fails', async () => {
    const { manager } = createManager({
      sessions: [sessionById('session-current')],
      onScopeChange: vi.fn(async () => {
        throw new Error('Catalog unavailable');
      }),
    });

    manager.handleInput('\x01');

    await vi.waitFor(() =>
      expect(renderPlain(manager)).toContain(
        "Couldn't change the session scope: Catalog unavailable. Retry.",
      ),
    );
    expect(renderPlain(manager)).toContain('Recent · This workspace');
    expect(renderPlain(manager)).toContain('Fix the login flow');
  });

  it('keeps the loaded session page usable when loading more fails', async () => {
    const { manager } = createManager({
      sessions: [sessionById('session-current')],
      hasMore: true,
      onLoadMore: vi.fn(async () => {
        throw new Error('Runtime page unavailable');
      }),
    });

    manager.handleInput('\x0c');

    await vi.waitFor(() =>
      expect(renderPlain(manager)).toContain(
        "Couldn't load more sessions: Runtime page unavailable. Retry.",
      ),
    );
    expect(renderPlain(manager)).toContain('Fix the login flow');
    expect(renderPlain(manager)).toContain('More sessions available');
  });

  it('ignores a loaded page after the manager is disposed', async () => {
    let resolvePage:
      | ((page: { sessions: readonly TuiSession[]; hasMore: boolean }) => void)
      | undefined;
    const page = new Promise<{ sessions: readonly TuiSession[]; hasMore: boolean }>((resolve) => {
      resolvePage = resolve;
    });
    const requestRender = vi.fn();
    const { manager } = createManager({
      sessions: [sessionById('session-current')],
      hasMore: true,
      onLoadMore: vi.fn(() => page),
      requestRender,
    });
    manager.handleInput('\x0c');
    const rendersBeforeDispose = requestRender.mock.calls.length;

    manager.dispose();
    resolvePage?.({
      sessions: [
        {
          sessionId: 'session-after-dispose',
          title: 'Loaded after disposal',
          workspaceDir: '/workspace',
        },
      ],
      hasMore: false,
    });
    await page;
    await Promise.resolve();

    expect(requestRender).toHaveBeenCalledTimes(rendersBeforeDispose);
    expect(renderPlain(manager)).not.toContain('Loaded after disposal');
  });

  it('ignores Ctrl+X delete outside the archived view or while searching', () => {
    const { callbacks, manager } = createManager();

    manager.handleInput('\x18');
    expect(callbacks.onDelete).not.toHaveBeenCalled();
    expect(renderPlain(manager)).not.toContain('Delete session?');

    manager.handleInput('\t');
    manager.handleInput('archived');
    manager.handleInput('\x18');
    expect(callbacks.onDelete).not.toHaveBeenCalled();
    expect(renderPlain(manager)).not.toContain('Delete session?');
  });

  it('permanently deletes the selected archived session after one confirmation', async () => {
    const { callbacks, manager } = createManager();
    manager.handleInput('\t');

    manager.handleInput('\x18');
    expect(renderPlain(manager)).toContain('Delete session?');
    expect(renderPlain(manager)).toContain('Archived investigation');
    expect(renderPlain(manager)).toContain('This cannot be undone.');
    expect(renderPlain(manager)).toContain(
      'Branches are kept and re-attached to their parent chain.',
    );
    expect(renderPlain(manager)).not.toContain('Archive session?');

    manager.handleInput('\r');
    await vi.waitFor(() => expect(callbacks.onDelete).toHaveBeenCalledWith('session-archived'));
    await flushActions();

    expect(renderPlain(manager)).not.toContain('Archived investigation');
    expect(renderPlain(manager)).toContain('Session deleted.');
  });

  it('cancels the delete confirmation with Esc and keeps the session', async () => {
    const { callbacks, manager } = createManager();
    manager.handleInput('\t');

    manager.handleInput('\x18');
    manager.handleInput('\x1b');
    await flushActions();

    expect(callbacks.onDelete).not.toHaveBeenCalled();
    expect(renderPlain(manager)).not.toContain('Delete session?');
    expect(renderPlain(manager)).toContain('Archived investigation');
  });

  it('keeps the archived session and surfaces the failure when deletion fails', async () => {
    const onDelete = vi.fn(async () => {
      throw new Error('This session is owned by a scheduled task.');
    });
    const { manager } = createManager({ onDelete });
    manager.handleInput('\t');

    manager.handleInput('\x18');
    manager.handleInput('\r');
    await vi.waitFor(() => expect(onDelete).toHaveBeenCalledOnce());
    await flushActions();

    expect(renderPlain(manager)).not.toContain('Delete session?');
    expect(renderPlain(manager)).toContain('Session changes were not saved');
    expect(renderPlain(manager)).toContain('Archived investigation');
  });

  it('waits out an in-flight page load before deleting so the row cannot be re-added', async () => {
    let resolvePage:
      | ((page: { sessions: readonly TuiSession[]; hasMore: boolean }) => void)
      | undefined;
    const page = new Promise<{ sessions: readonly TuiSession[]; hasMore: boolean }>((resolve) => {
      resolvePage = resolve;
    });
    const { callbacks, manager } = createManager({
      sessions: [sessionById('session-archived')],
      hasMore: true,
      onLoadMore: vi.fn(() => page),
    });
    manager.handleInput('\t');
    manager.handleInput('\x0c');
    manager.handleInput('\x18');
    manager.handleInput('\r');

    // The delete action waits out the in-flight page load before deleting, so
    // the late page merge cannot resurrect the deleted row.
    resolvePage?.({ sessions: [sessionById('session-archived')], hasMore: false });
    await page;
    await vi.waitFor(() => expect(callbacks.onDelete).toHaveBeenCalledOnce());
    await flushActions();

    expect(renderPlain(manager)).not.toContain('Archived investigation');
    expect(renderPlain(manager)).toContain('Session deleted.');
  });

  it('empties every archived session after the authoritative count confirmation', async () => {
    const extraArchived: TuiSession = {
      sessionId: 'session-archived-2',
      title: 'Older investigation',
      workspaceDir: '/workspace',
      updatedAt: NOW - 48 * 60 * 60 * 1000,
      archived: true,
    };
    const onEnumerateArchived = vi.fn(async () => [
      sessionById('session-archived'),
      extraArchived,
    ]);
    const { callbacks, manager } = createManager({
      sessions: [sessionById('session-current'), sessionById('session-archived'), extraArchived],
      onEnumerateArchived,
    });
    manager.handleInput('\t');

    manager.handleInput('\x05');
    expect(renderPlain(manager)).toContain('Delete all archived sessions?');
    await vi.waitFor(() =>
      expect(renderPlain(manager)).toContain(
        'Permanently delete 2 archived sessions in this workspace?',
      ),
    );
    expect(renderPlain(manager)).toContain(
      'Sessions owned by scheduled tasks are kept.',
    );

    manager.handleInput('\r');
    await vi.waitFor(() => expect(callbacks.onDelete).toHaveBeenCalledTimes(2));
    await flushActions();

    expect(callbacks.onDelete).toHaveBeenNthCalledWith(1, 'session-archived');
    expect(callbacks.onDelete).toHaveBeenNthCalledWith(2, 'session-archived-2');
    expect(renderPlain(manager)).not.toContain('Archived investigation');
    expect(renderPlain(manager)).not.toContain('Older investigation');
    expect(renderPlain(manager)).toContain('Deleted 2 sessions.');
  });

  it('ignores Enter while the bulk count is still loading', () => {
    let resolveEnumeration: ((value: readonly TuiSession[]) => void) | undefined;
    const onEnumerateArchived = vi.fn(
      () =>
        new Promise<readonly TuiSession[]>((resolve) => {
          resolveEnumeration = resolve;
        }),
    );
    const { callbacks, manager } = createManager({ onEnumerateArchived });
    manager.handleInput('\t');

    manager.handleInput('\x05');
    expect(renderPlain(manager)).toContain('Counting archived sessions…');
    manager.handleInput('\r');
    expect(callbacks.onDelete).not.toHaveBeenCalled();
    expect(renderPlain(manager)).toContain('Delete all archived sessions?');

    resolveEnumeration?.([]);
  });

  it('discards a stale enumeration result after leaving and re-entering the confirm', async () => {
    let resolveFirst: ((value: readonly TuiSession[]) => void) | undefined;
    let resolveLater: ((value: readonly TuiSession[]) => void) | undefined;
    let calls = 0;
    const onEnumerateArchived = vi.fn(() => {
      calls += 1;
      return new Promise<readonly TuiSession[]>((resolve) => {
        if (calls === 1) resolveFirst = resolve;
        else resolveLater = resolve;
      });
    });
    const { callbacks, manager } = createManager({ onEnumerateArchived });
    manager.handleInput('\t');

    manager.handleInput('\x05');
    manager.handleInput('\x1b');
    manager.handleInput('\x05');
    await vi.waitFor(() => expect(onEnumerateArchived).toHaveBeenCalledTimes(2));

    // The first (stale) enumeration resolves late; it must be discarded — the
    // panel still waits for the fresh result.
    resolveFirst?.([sessionById('session-archived')]);
    await Promise.resolve();
    await Promise.resolve();
    expect(renderPlain(manager)).toContain('Counting archived sessions…');

    const fresh: TuiSession = {
      sessionId: 'session-archived-fresh',
      title: 'Fresh investigation',
      workspaceDir: '/workspace',
      updatedAt: NOW - 5_000,
      archived: true,
    };
    resolveLater?.([fresh]);
    await vi.waitFor(() =>
      expect(renderPlain(manager)).toContain(
        'Permanently delete 1 archived session in this workspace?',
      ),
    );

    manager.handleInput('\r');
    await vi.waitFor(() => expect(callbacks.onDelete).toHaveBeenCalledTimes(1));
    expect(callbacks.onDelete).toHaveBeenCalledWith('session-archived-fresh');
    expect(callbacks.onDelete).not.toHaveBeenCalledWith('session-archived');
  });

  it('skips deletion when the session was restored while the confirm panel was open', async () => {
    const { callbacks, manager } = createManager();
    manager.handleInput('\t');

    manager.handleInput('\x18');
    // Simulate a cross-window restore merged into the local list while the
    // confirm panel was open.
    manager.setSessions(
      sessions.map((session) =>
        session.sessionId === 'session-archived' ? { ...session, archived: false } : session,
      ),
    );
    manager.handleInput('\r');
    await flushActions();

    expect(callbacks.onDelete).not.toHaveBeenCalled();
    expect(renderPlain(manager)).toContain('Session is no longer archived.');
  });

  it('skips sessions the runtime refuses to delete and reports the summary', async () => {
    const onDelete = vi.fn(async (sessionId: string) => {
      if (sessionId === 'session-archived-2') {
        // The runtime refusal carries its stable AppError key.
        throw Object.assign(new Error('This session is owned by a scheduled task.'), {
          key: 'CRON_OWNED_SESSION',
        });
      }
    });
    const extraArchived: TuiSession = {
      sessionId: 'session-archived-2',
      title: 'Cron-owned investigation',
      workspaceDir: '/workspace',
      updatedAt: NOW - 48 * 60 * 60 * 1000,
      archived: true,
    };
    const onEnumerateArchived = vi.fn(async () => [
      sessionById('session-archived'),
      extraArchived,
    ]);
    const { manager } = createManager({
      sessions: [sessionById('session-archived'), extraArchived],
      onDelete,
      onEnumerateArchived,
    });
    manager.handleInput('\t');

    manager.handleInput('\x05');
    await vi.waitFor(() =>
      expect(renderPlain(manager)).toContain('Permanently delete 2 archived sessions'),
    );
    manager.handleInput('\r');
    await vi.waitFor(() => expect(onDelete).toHaveBeenCalledTimes(2));
    await flushActions();

    expect(renderPlain(manager)).toContain('Deleted 1 session. Kept 1 (scheduled task).');
    expect(renderPlain(manager)).not.toContain('Archived investigation');
    expect(renderPlain(manager)).toContain('Cron-owned investigation');
  });

  it('distinguishes every bulk delete bucket and keeps refused rows', async () => {
    const onDelete = vi.fn(async (sessionId: string) => {
      if (sessionId === 'session-restored') {
        // Runtime refusal shape: AppError carries the stable key.
        throw Object.assign(new Error('no longer archived'), {
          key: 'SESSION_NOT_ARCHIVED',
        });
      }
      if (sessionId === 'session-cron') {
        throw Object.assign(new Error('cron-owned'), { key: 'CRON_OWNED_SESSION' });
      }
      if (sessionId === 'session-broken') {
        throw new Error('Runtime unavailable');
      }
    });
    const extraTargets: TuiSession[] = [
      {
        sessionId: 'session-restored',
        title: 'Restored elsewhere',
        workspaceDir: '/workspace',
        updatedAt: NOW - 1000,
        archived: true,
      },
      {
        sessionId: 'session-cron',
        title: 'Cron-owned investigation',
        workspaceDir: '/workspace',
        updatedAt: NOW - 2000,
        archived: true,
      },
      {
        sessionId: 'session-broken',
        title: 'Broken delete',
        workspaceDir: '/workspace',
        updatedAt: NOW - 3000,
        archived: true,
      },
    ];
    const onEnumerateArchived = vi.fn(async () => [
      sessionById('session-archived'),
      ...extraTargets,
    ]);
    const { manager } = createManager({
      sessions: [...sessions, ...extraTargets],
      onDelete,
      onEnumerateArchived,
    });
    manager.handleInput('\t');

    manager.handleInput('\x05');
    await vi.waitFor(() =>
      expect(renderPlain(manager)).toContain('Permanently delete 4 archived sessions'),
    );
    manager.handleInput('\r');
    await vi.waitFor(() => expect(onDelete).toHaveBeenCalledTimes(4));
    await flushActions();

    expect(renderPlain(manager)).toContain(
      'Deleted 1 session. Skipped 1 (restored). Kept 1 (scheduled task). 1 failed.',
    );
    // The deleted row is removed; refused and failed rows stay listed.
    expect(renderPlain(manager)).not.toContain('Archived investigation');
    expect(renderPlain(manager)).toContain('Restored elsewhere');
    expect(renderPlain(manager)).toContain('Cron-owned investigation');
    expect(renderPlain(manager)).toContain('Broken delete');
  });

  it('states branch retention on both delete confirmation panels', async () => {
    const { manager } = createManager();
    manager.handleInput('\t');

    manager.handleInput('\x18');
    expect(renderPlain(manager)).toContain('Delete session?');
    expect(renderPlain(manager)).toContain('re-attached to their parent chain');
    manager.handleInput('\x1b');

    manager.handleInput('\x05');
    await vi.waitFor(() =>
      expect(renderPlain(manager)).toContain('Permanently delete 1 archived session'),
    );
    expect(renderPlain(manager)).toContain('Delete all archived sessions?');
    expect(renderPlain(manager)).toContain('re-attached to their parent chain');
  });

  it('reports zero archived sessions without asking for confirmation', async () => {
    const onEnumerateArchived = vi.fn(async () => []);
    const { callbacks, manager } = createManager({ onEnumerateArchived });
    manager.handleInput('\t');

    manager.handleInput('\x05');
    await vi.waitFor(() => expect(renderPlain(manager)).toContain('No archived sessions.'));
    expect(callbacks.onDelete).not.toHaveBeenCalled();
    expect(renderPlain(manager)).not.toContain('Permanently delete 0');
  });

  it('stays in the confirm panel when the archived enumeration fails', async () => {
    const onEnumerateArchived = vi.fn(async () => {
      throw new Error('Runtime unavailable');
    });
    const { callbacks, manager } = createManager({ onEnumerateArchived });
    manager.handleInput('\t');

    manager.handleInput('\x05');
    await vi.waitFor(() =>
      expect(renderPlain(manager)).toContain("Couldn't count archived sessions:"),
    );

    manager.handleInput('\r');
    expect(callbacks.onDelete).not.toHaveBeenCalled();
    expect(renderPlain(manager)).toContain('Delete all archived sessions?');
  });

  it('shows the delete and empty shortcuts in the archived footer only', () => {
    const { manager } = createManager();

    expect(renderPlain(manager)).not.toContain('Ctrl+X delete');
    manager.handleInput('\t');
    expect(renderPlain(manager)).toContain('Ctrl+X delete · Ctrl+E empty');
  });
});
