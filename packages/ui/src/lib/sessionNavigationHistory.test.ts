import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { Session } from '@opencode-ai/sdk/v2';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { createRuntimeOpencodeClient } from '@/lib/opencode/client';
import { getRuntimeKey, MOBILE_DISCONNECTED_RUNTIME_KEY, switchRuntimeEndpoint, UNINITIALIZED_RUNTIME_KEY } from '@/lib/runtime-switch';
import {
  sessionHistory, startSessionHistoryTracking, resolveSessionHistoryDestination,
  navigateSessionHistory, pauseSessionHistory, resumeSessionHistory,
} from './sessionNavigationHistory';

// SAFETY: the UI type-check does not include bun's global types; this declares
// only the local HTTP fixture this test uses.
declare const Bun: {
  serve: (options: { port: number; fetch: () => Response }) => {
    url: URL;
    stop: (force?: boolean) => void;
  };
};

const value = (id: string): Session => ({
  id, slug: id, projectID: 'p', directory: '/project', title: id, version: '1',
  time: { created: 1, updated: 1 },
});

test('seeds an existing selection and records normal store selection changes', () => {
  const ui = useSessionUIStore.getState();
  const global = useGlobalSessionsStore.getState();
  let stop = () => {};
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const browser = new Window({ url: 'http://localhost:4599' });
  Object.defineProperty(browser, '__OPENCHAMBER_API_BASE_URL__', { value: 'http://localhost:4599' });
  Object.defineProperty(globalThis, 'window', { value: browser, configurable: true, writable: true });
  try {
    useGlobalSessionsStore.setState({ entityById: new Map([['A', value('A')], ['B', value('B')]]) });
    useSessionUIStore.setState({ currentSessionId: 'A', newSessionDraft: { ...ui.newSessionDraft, open: false } });
    sessionHistory.setScope('adapter-fixture');
    stop = startSessionHistoryTracking();
    useSessionUIStore.setState({ currentSessionId: 'B' });
    expect(sessionHistory.getSnapshot().canGoBack).toBe(true);
    const before = sessionHistory.getSnapshot();
    useGlobalSessionsStore.getState().upsertSession({ ...value('B'), title: 'renamed' });
    expect(sessionHistory.getSnapshot()).toBe(before);
  } finally {
    stop();
    sessionHistory.setScope('adapter-cleanup');
    useSessionUIStore.setState(ui, true);
    useGlobalSessionsStore.setState(global, true);
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('lookup distinguishes unloaded, archived, authoritative missing and uncertain failure', async () => {
  let status = 200;
  let body: Session | { name: string; data: { message: string } } = value('unloaded');
  let beforeResponse = () => {};
  const server = Bun.serve({ port: 0, fetch: () => {
    beforeResponse();
    return Response.json(body, { status });
  } });
  const client = createRuntimeOpencodeClient({ baseUrl: server.url.toString() });
  const signal = new AbortController().signal;
  const entry = { sessionId: 'unloaded', directory: '/project' };
  const global = useGlobalSessionsStore.getState();
  try {
    useGlobalSessionsStore.setState({ entityById: new Map() });
    expect((await resolveSessionHistoryDestination(entry, signal, client))?.id).toBe('unloaded');
    body = { ...value('unloaded'), time: { created: 1, updated: 1, archived: 2 } };
    expect(await resolveSessionHistoryDestination(entry, signal, client)).toBeNull();
    status = 404;
    body = { name: 'NotFoundError', data: { message: 'Session not found' } };
    expect(await resolveSessionHistoryDestination(entry, signal, client)).toBeNull();
    await expect(resolveSessionHistoryDestination({ ...entry, directory: null }, signal, client)).rejects.toThrow();
    status = 503;
    await expect(resolveSessionHistoryDestination(entry, signal, client)).rejects.toThrow();
    status = 403;
    await expect(resolveSessionHistoryDestination(entry, signal, client)).rejects.toThrow();
    status = 404;
    body = { name: 'ProxyError', data: { message: 'upstream unavailable' } };
    await expect(resolveSessionHistoryDestination(entry, signal, client)).rejects.toThrow();
    status = 200;
    body = value('unloaded');
    beforeResponse = () => { useGlobalSessionsStore.getState().removeSessions(['unloaded']); };
    expect(await resolveSessionHistoryDestination(entry, signal, client)).toBeNull();
    beforeResponse = () => {
      useGlobalSessionsStore.getState().upsertSession({
        ...value('unloaded'), time: { created: 1, updated: 3, archived: 3 },
      });
    };
    expect(await resolveSessionHistoryDestination(entry, signal, client)).toBeNull();
  } finally {
    server.stop(true);
    useGlobalSessionsStore.setState(global, true);
  }
});

// Browser and VS Code bootstrap tests precede `switchRuntimeEndpoint`, which
// pins the runtime key for the rest of this isolated test process.
test('an ordinary browser window without injected endpoint globals records and navigates visits', async () => {
  const ui = useSessionUIStore.getState();
  const global = useGlobalSessionsStore.getState();
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const browser = new Window({ url: 'http://localhost:4599' });
  Object.defineProperty(globalThis, 'window', { value: browser, configurable: true, writable: true });
  let stop = () => {};
  try {
    expect(Object.getOwnPropertyDescriptor(browser, '__OPENCHAMBER_API_BASE_URL__')?.value ?? null).toBeNull();
    useGlobalSessionsStore.setState({ entityById: new Map([['A', value('A')], ['B', value('B')]]) });
    useSessionUIStore.setState({ currentSessionId: 'A', newSessionDraft: { ...ui.newSessionDraft, open: false } });
    stop = startSessionHistoryTracking();
    expect(sessionHistory.getSnapshot().canGoBack).toBe(false);
    useSessionUIStore.setState({ currentSessionId: 'B' });
    expect(sessionHistory.getSnapshot().canGoBack).toBe(true);
    expect(navigateSessionHistory(-1)).toBe(true);
    await Promise.resolve();
    expect(useSessionUIStore.getState().currentSessionId).toBe('A');
    expect(sessionHistory.getSnapshot().canGoBack).toBe(false);
    expect(sessionHistory.getSnapshot().canGoForward).toBe(true);
  } finally {
    stop();
    sessionHistory.setScope('web-scope-cleanup');
    useSessionUIStore.setState(ui, true);
    useGlobalSessionsStore.setState(global, true);
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('desktop vscode bootstrap navigates and reconsiders visits when the workspace changes', async () => {
  const ui = useSessionUIStore.getState();
  const global = useGlobalSessionsStore.getState();
  const projects = useProjectsStore.getState();
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const browser = new Window({ url: 'vscode-webview://history-test/index.html' });
  Object.defineProperty(browser, '__VSCODE_CONFIG__', { value: { workspaceFolder: '/ws', workspaceFolders: [{ name: 'ws', path: '/ws' }], theme: 'dark', connectionStatus: 'connected' } });
  Object.defineProperty(globalThis, 'window', { value: browser, configurable: true, writable: true });
  const inWorkspace = (id: string, directory: string): Session => ({
    id, slug: id, projectID: 'p', directory, title: id, version: '1',
    time: { created: 1, updated: 1 },
  });
  let stop = () => {};
  try {
    expect(getRuntimeKey()).toBe(UNINITIALIZED_RUNTIME_KEY);
    expect(Object.getOwnPropertyDescriptor(browser, '__OPENCHAMBER_API_BASE_URL__')).toBe(undefined);
    useProjectsStore.setState({ projects: [{ id: 'p1', path: '/ws' }], activeProjectId: 'p1' });
    useGlobalSessionsStore.setState({ entityById: new Map([
      ['A', inWorkspace('A', '/ws')],
      ['B', inWorkspace('B', '/other')],
      ['C', inWorkspace('C', '/ws/worktree')],
    ]) });
    useSessionUIStore.setState({ currentSessionId: 'B', newSessionDraft: { ...ui.newSessionDraft, open: false } });
    stop = startSessionHistoryTracking();
    useSessionUIStore.setState({ currentSessionId: 'A' });
    expect(sessionHistory.getSnapshot().canGoBack).toBe(true);
    expect(navigateSessionHistory(-1)).toBe(true);
    await Promise.resolve();
    expect(useSessionUIStore.getState().currentSessionId).toBe('A');
    expect(sessionHistory.getSnapshot().canGoBack).toBe(false);

    useProjectsStore.setState({ projects: [{ id: 'p2', path: '/other' }], activeProjectId: 'p2' });
    expect(sessionHistory.getSnapshot().canGoBack).toBe(true);
    expect(await sessionHistory.navigate(-1)).toBe(true);
    expect(useSessionUIStore.getState().currentSessionId).toBe('B');
    useProjectsStore.setState({ projects: [{ id: 'p1', path: '/ws' }], activeProjectId: 'p1' });
    expect(await sessionHistory.navigate(1)).toBe(true);
    expect(useSessionUIStore.getState().currentSessionId).toBe('A');

    useSessionUIStore.setState({ currentSessionId: 'C' });
    expect(navigateSessionHistory(-1)).toBe(true);
    await Promise.resolve();
    expect(useSessionUIStore.getState().currentSessionId).toBe('A');
  } finally {
    stop();
    sessionHistory.setScope('adapter-vscode-cleanup');
    useSessionUIStore.setState(ui, true);
    useGlobalSessionsStore.setState(global, true);
    useProjectsStore.setState(projects, true);
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('mobile disconnect stays suspended and a server switch resets the browser scope', async () => {
  const ui = useSessionUIStore.getState();
  const global = useGlobalSessionsStore.getState();
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const browser = new Window({ url: 'http://localhost:4599' });
  Object.defineProperty(globalThis, 'window', { value: browser, configurable: true, writable: true });
  let stop = () => {};
  try {
    useGlobalSessionsStore.setState({ entityById: new Map([['A', value('A')], ['B', value('B')]]) });
    useSessionUIStore.setState({ currentSessionId: 'A', newSessionDraft: { ...ui.newSessionDraft, open: false } });
    stop = startSessionHistoryTracking();
    useSessionUIStore.setState({ currentSessionId: 'B' });
    expect(sessionHistory.getSnapshot().canGoBack).toBe(true);

    switchRuntimeEndpoint({ apiBaseUrl: '', clientToken: null, runtimeKey: MOBILE_DISCONNECTED_RUNTIME_KEY });
    resumeSessionHistory();
    expect(sessionHistory.getSnapshot().canGoBack).toBe(false);
    useSessionUIStore.setState({ currentSessionId: 'A' });
    expect(sessionHistory.getSnapshot().canGoBack).toBe(false);
    useSessionUIStore.setState({ currentSessionId: 'B' });
    expect(sessionHistory.getSnapshot().canGoBack).toBe(false);

    switchRuntimeEndpoint({ apiBaseUrl: 'http://localhost:5001', runtimeKey: 'url:http://localhost:5001' });
    resumeSessionHistory();
    expect(sessionHistory.getSnapshot().canGoBack).toBe(false);
    useSessionUIStore.setState({ currentSessionId: 'A' });
    expect(sessionHistory.getSnapshot().canGoBack).toBe(true);
  } finally {
    stop();
    sessionHistory.setScope('web-scope-cleanup');
    useSessionUIStore.setState(ui, true);
    useGlobalSessionsStore.setState(global, true);
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('runtime scope lifecycle preserves, suspends and reseeds visits', async () => {
  const ui = useSessionUIStore.getState();
  const global = useGlobalSessionsStore.getState();
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const browser = new Window({ url: 'http://localhost:4599' });
  Object.defineProperty(browser, '__OPENCHAMBER_API_BASE_URL__', { value: 'http://localhost:4599' });
  Object.defineProperty(globalThis, 'window', { value: browser, configurable: true, writable: true });
  let stop = () => {};
  try {
    useGlobalSessionsStore.setState({ entityById: new Map([['A', value('A')], ['B', value('B')]]) });
    useSessionUIStore.setState({ currentSessionId: 'A', newSessionDraft: { ...ui.newSessionDraft, open: false } });
    switchRuntimeEndpoint({ apiBaseUrl: 'http://localhost:4599', runtimeKey: 'url:http://localhost:4599' });
    resumeSessionHistory();
    stop = startSessionHistoryTracking();
    useSessionUIStore.setState({ currentSessionId: 'B' });
    expect(sessionHistory.getSnapshot().canGoBack).toBe(true);

    pauseSessionHistory();
    expect(sessionHistory.getSnapshot().canGoBack).toBe(false);
    resumeSessionHistory();
    expect(sessionHistory.getSnapshot().canGoBack).toBe(true);

    switchRuntimeEndpoint({ apiBaseUrl: '', clientToken: null, runtimeKey: MOBILE_DISCONNECTED_RUNTIME_KEY });
    resumeSessionHistory();
    expect(sessionHistory.getSnapshot().canGoBack).toBe(false);
    switchRuntimeEndpoint({ apiBaseUrl: 'http://localhost:4599', runtimeKey: 'url:http://localhost:4599' });
    resumeSessionHistory();
    expect(sessionHistory.getSnapshot().canGoBack).toBe(true);

    pauseSessionHistory();
    useSessionUIStore.setState({ currentSessionId: 'A' });
    switchRuntimeEndpoint({ apiBaseUrl: 'http://localhost:5000', runtimeKey: 'url:http://localhost:5000' });
    resumeSessionHistory();
    expect(sessionHistory.getSnapshot().canGoBack).toBe(false);
    useSessionUIStore.setState({ currentSessionId: 'B' });
    expect(sessionHistory.getSnapshot().canGoBack).toBe(true);
    expect(navigateSessionHistory(-1)).toBe(true);
    await Promise.resolve();
    expect(useSessionUIStore.getState().currentSessionId).toBe('A');
  } finally {
    stop();
    sessionHistory.setScope('adapter-scope-cleanup');
    useSessionUIStore.setState(ui, true);
    useGlobalSessionsStore.setState(global, true);
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('restored visits become navigable again without selecting them first', async () => {
  const ui = useSessionUIStore.getState();
  const global = useGlobalSessionsStore.getState();
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const browser = new Window({ url: 'http://localhost:4599' });
  Object.defineProperty(globalThis, 'window', { value: browser, configurable: true, writable: true });
  let stop = () => {};
  try {
    useGlobalSessionsStore.setState({ entityById: new Map(['A', 'B', 'C'].map((id) => [id, value(id)])) });
    useSessionUIStore.setState({ currentSessionId: 'A', newSessionDraft: { ...ui.newSessionDraft, open: false } });
    stop = startSessionHistoryTracking();
    useSessionUIStore.setState({ currentSessionId: 'B' });
    useSessionUIStore.setState({ currentSessionId: 'C' });
    const archive = (id: string) => useGlobalSessionsStore.getState().upsertSession({
      ...value(id), time: { created: 1, updated: 2, archived: 2 },
    });
    const restore = (id: string) => useGlobalSessionsStore.getState().upsertSession({
      ...value(id), time: { created: 1, updated: 3, archived: 0 },
    });
    archive('B');
    expect(await sessionHistory.navigate(-1)).toBe(true);
    expect(useSessionUIStore.getState().currentSessionId).toBe('A');
    restore('B');
    expect(await sessionHistory.navigate(1)).toBe(true);
    expect(useSessionUIStore.getState().currentSessionId).toBe('B');

    // A disabled direction also recovers from an authoritative unarchive.
    archive('A');
    expect(await sessionHistory.navigate(-1)).toBe(false);
    expect(sessionHistory.getSnapshot().canGoBack).toBe(false);
    const before = sessionHistory.getSnapshot();
    for (let i = 0; i < 100; i += 1) {
      useGlobalSessionsStore.getState().upsertSession({ ...value('C'), title: `C ${i}` });
    }
    expect(sessionHistory.getSnapshot()).toBe(before);
    restore('A');
    expect(sessionHistory.getSnapshot().canGoBack).toBe(true);
    expect(await sessionHistory.navigate(-1)).toBe(true);
    expect(useSessionUIStore.getState().currentSessionId).toBe('A');

    archive('B');
    expect(await sessionHistory.navigate(1)).toBe(true);
    expect(useSessionUIStore.getState().currentSessionId).toBe('C');
    pauseSessionHistory();
    restore('B');
    expect(sessionHistory.getSnapshot().canGoBack).toBe(false);
    resumeSessionHistory();
    expect(await sessionHistory.navigate(-1)).toBe(true);
    expect(useSessionUIStore.getState().currentSessionId).toBe('B');
  } finally {
    stop();
    sessionHistory.setScope('restore-cleanup');
    useSessionUIStore.setState(ui, true);
    useGlobalSessionsStore.setState(global, true);
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
