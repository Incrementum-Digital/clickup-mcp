import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockAgent, setGlobalDispatcher } from 'undici';

// Helper to register tool and call handler

test('getTaskById makes correct API calls', async (t) => {
  t.mock.timers.enable();
  process.env.CLICKUP_API_KEY = 'test-key';
  process.env.CLICKUP_TEAM_ID = 'team1';

  const { registerTaskToolsRead } = await import('../tools/task-tools');

  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const client = mockAgent.get('https://api.clickup.com');

  client.intercept({ path: '/api/v2/team', method: 'GET' })
    .reply(200, { teams: [{ id: 'team1', members: [] }] });

  client.intercept({ path: /\/api\/v2\/task\/task123.*/, method: 'GET' })
    .reply(200, {
      id: 'task123',
      name: 'Test Task',
      markdown_description: '',
      attachments: [],
      creator: { username: 'creator', id: '1' },
      assignees: [],
      list: { id: 'list1', name: 'List' },
      space: { id: 'space1', name: 'Space' },
      status: { status: 'open', type: 'open' },
      url: 'https://app.clickup.com/t/task123',
      date_created: '0',
      date_updated: '0'
    });

  client.intercept({ path: /\/api\/v2\/task\/task123\/comment.*/, method: 'GET' })
    .reply(200, { comments: [] });

  client.intercept({ path: '/api/v2/task/task123/time_in_status', method: 'GET' })
    .reply(200, { status_history: [], current_status: null });

  client.intercept({ path: /\/api\/v2\/team\/team1\/time_entries.*/, method: 'GET' })
    .reply(200, { data: [] });

  const tools: Record<string, any> = {};
  const serverStub = {
    tool: (name: string, _desc: string, _schema: any, _opts: any, handler: any) => {
      tools[name] = handler;
    }
  } as any;

  registerTaskToolsRead(serverStub, { user: { username: 'me', id: 'u1' } });

  const result = await tools.getTaskById({ id: 'task123' });
  assert.ok(result.content.some((block: any) =>
    typeof block.text === 'string' && block.text.includes('task_id: task123')
  ));

  (mockAgent as any).assertNoPendingInterceptors();
  await mockAgent.close();
  t.mock.timers.reset();
});


test('getTaskById renders dependencies and linked tasks', async (t) => {
  t.mock.timers.enable();
  process.env.CLICKUP_API_KEY = 'test-key';
  process.env.CLICKUP_TEAM_ID = 'team1';

  const { registerTaskToolsRead } = await import('../tools/task-tools');

  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const client = mockAgent.get('https://api.clickup.com');

  // No /api/v2/team interceptor: the team lookup is memoized by the module and
  // was already resolved by the first test in this file.

  client.intercept({ path: /\/api\/v2\/task\/task123.*/, method: 'GET' })
    .reply(200, {
      id: 'task123',
      name: 'Test Task',
      markdown_description: '',
      attachments: [],
      creator: { username: 'creator', id: '1' },
      assignees: [],
      list: { id: 'list1', name: 'List' },
      space: { id: 'space1', name: 'Space' },
      status: { status: 'open', type: 'open' },
      url: 'https://app.clickup.com/t/task123',
      date_created: '0',
      date_updated: '0',
      // Single flat array for both directions, as the API returns it
      dependencies: [
        { task_id: 'task123', depends_on: 'blocker1', type: 1 },
        { task_id: 'blocked1', depends_on: 'task123', type: 1 }
      ],
      linked_tasks: [{ task_id: 'task123', link_id: 'related1' }]
    });

  client.intercept({ path: /\/api\/v2\/task\/task123\/comment.*/, method: 'GET' })
    .reply(200, { comments: [] });

  client.intercept({ path: '/api/v2/task/task123/time_in_status', method: 'GET' })
    .reply(200, { status_history: [], current_status: null });

  client.intercept({ path: /\/api\/v2\/team\/team1\/time_entries.*/, method: 'GET' })
    .reply(200, { data: [] });

  const tools: Record<string, any> = {};
  const serverStub = {
    tool: (name: string, _desc: string, _schema: any, _opts: any, handler: any) => {
      tools[name] = handler;
    }
  } as any;

  registerTaskToolsRead(serverStub, { user: { username: 'me', id: 'u1' } });

  const result = await tools.getTaskById({ id: 'task123' });
  const text = result.content
    .filter((block: any) => typeof block.text === 'string')
    .map((block: any) => block.text)
    .join('\n');

  assert.match(text, /^waiting_on: blocker1$/m);
  assert.match(text, /^blocking: blocked1$/m);
  assert.match(text, /^linked_tasks: related1$/m);

  (mockAgent as any).assertNoPendingInterceptors();
  await mockAgent.close();
  t.mock.timers.reset();
});

test('getTaskById omits dependency lines when there are none', async (t) => {
  t.mock.timers.enable();
  process.env.CLICKUP_API_KEY = 'test-key';
  process.env.CLICKUP_TEAM_ID = 'team1';

  const { registerTaskToolsRead } = await import('../tools/task-tools');

  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const client = mockAgent.get('https://api.clickup.com');

  // No /api/v2/team interceptor: the team lookup is memoized by the module and
  // was already resolved by the first test in this file.

  client.intercept({ path: /\/api\/v2\/task\/task123.*/, method: 'GET' })
    .reply(200, {
      id: 'task123',
      name: 'Test Task',
      markdown_description: '',
      attachments: [],
      creator: { username: 'creator', id: '1' },
      assignees: [],
      list: { id: 'list1', name: 'List' },
      space: { id: 'space1', name: 'Space' },
      status: { status: 'open', type: 'open' },
      url: 'https://app.clickup.com/t/task123',
      date_created: '0',
      date_updated: '0',
      dependencies: [],
      linked_tasks: []
    });

  client.intercept({ path: /\/api\/v2\/task\/task123\/comment.*/, method: 'GET' })
    .reply(200, { comments: [] });

  client.intercept({ path: '/api/v2/task/task123/time_in_status', method: 'GET' })
    .reply(200, { status_history: [], current_status: null });

  client.intercept({ path: /\/api\/v2\/team\/team1\/time_entries.*/, method: 'GET' })
    .reply(200, { data: [] });

  const tools: Record<string, any> = {};
  const serverStub = {
    tool: (name: string, _desc: string, _schema: any, _opts: any, handler: any) => {
      tools[name] = handler;
    }
  } as any;

  registerTaskToolsRead(serverStub, { user: { username: 'me', id: 'u1' } });

  const result = await tools.getTaskById({ id: 'task123' });
  const text = result.content
    .filter((block: any) => typeof block.text === 'string')
    .map((block: any) => block.text)
    .join('\n');

  assert.doesNotMatch(text, /^waiting_on:/m);
  assert.doesNotMatch(text, /^blocking:/m);
  assert.doesNotMatch(text, /^linked_tasks:/m);

  (mockAgent as any).assertNoPendingInterceptors();
  await mockAgent.close();
  t.mock.timers.reset();
});

test('getTaskById renders threaded comment replies nested under their parent', async (t) => {
  t.mock.timers.enable();
  process.env.CLICKUP_API_KEY = 'test-key';
  process.env.CLICKUP_TEAM_ID = 'team1';

  const { registerTaskToolsRead } = await import('../tools/task-tools');

  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const client = mockAgent.get('https://api.clickup.com');

  // No /api/v2/team interceptor here: getAllTeamMembers caches its promise
  // globally, so the first getTaskById test in this file already resolved it.

  client.intercept({ path: /\/api\/v2\/task\/task123\?.*/, method: 'GET' })
    .reply(200, {
      id: 'task123',
      name: 'Test Task',
      markdown_description: '',
      attachments: [],
      creator: { username: 'creator', id: '1' },
      assignees: [],
      list: { id: 'list1', name: 'List' },
      space: { id: 'space1', name: 'Space' },
      status: { status: 'open', type: 'open' },
      url: 'https://app.clickup.com/t/task123',
      date_created: '0',
      date_updated: '0'
    });

  // One comment with a thread (reply_count 2) and one without. Only c1 gets a
  // reply request - the c2 case is proven by assertNoPendingInterceptors below,
  // since no /comment/c2/reply interceptor exists to consume.
  client.intercept({ path: '/api/v2/task/task123/comment', method: 'GET' })
    .reply(200, {
      comments: [
        {
          id: 'c1',
          date: '2000',
          comment: [{ text: 'Parent comment' }],
          comment_text: 'Parent comment',
          user: { id: 'u1', username: 'alice' },
          reply_count: 2,
        },
        {
          id: 'c2',
          date: '1000',
          comment: [{ text: 'Lonely comment' }],
          comment_text: 'Lonely comment',
          user: { id: 'u2', username: 'bob' },
          reply_count: 0,
        },
      ]
    });

  // Replies come back unordered - the tool must render them oldest first
  client.intercept({ path: '/api/v2/comment/c1/reply', method: 'GET' })
    .reply(200, {
      comments: [
        {
          id: 'r2',
          date: '4000',
          comment: [{ text: 'Second reply' }],
          comment_text: 'Second reply',
          user: { id: 'u2', username: 'bob' },
        },
        {
          id: 'r1',
          date: '3000',
          comment: [{ text: 'First reply' }],
          comment_text: 'First reply',
          user: { id: 'u1', username: 'alice' },
        },
      ]
    });

  client.intercept({ path: '/api/v2/task/task123/time_in_status', method: 'GET' })
    .reply(200, { status_history: [], current_status: null });

  client.intercept({ path: /\/api\/v2\/team\/team1\/time_entries.*/, method: 'GET' })
    .reply(200, { data: [] });

  const tools: Record<string, any> = {};
  const serverStub = {
    tool: (name: string, _desc: string, _schema: any, _opts: any, handler: any) => {
      tools[name] = handler;
    }
  } as any;

  registerTaskToolsRead(serverStub, { user: { username: 'me', id: 'u1' } });

  const result = await tools.getTaskById({ id: 'task123' });
  const fullText = result.content
    .filter((block: any) => typeof block.text === 'string')
    .map((block: any) => block.text)
    .join('\n');

  // Top-level comments carry their id so editComment/parent_comment_id can address them
  assert.ok(fullText.includes('(comment_id: c1)'), 'parent comment header should include its comment_id');
  assert.ok(fullText.includes('(comment_id: c2)'), 'threadless comment header should include its comment_id');

  // Replies are rendered nested under their parent, oldest first
  const parentIdx = fullText.indexOf('Parent comment');
  const firstReplyIdx = fullText.indexOf('↳ Reply by alice');
  const secondReplyIdx = fullText.indexOf('↳ Reply by bob');
  assert.ok(parentIdx !== -1 && firstReplyIdx !== -1 && secondReplyIdx !== -1, 'parent and both replies should be rendered');
  assert.ok(parentIdx < firstReplyIdx && firstReplyIdx < secondReplyIdx, 'replies should follow their parent, oldest first');
  assert.ok(fullText.includes('First reply') && fullText.includes('Second reply'));

  // Would throw if the reply interceptor was not consumed, and the c2 comment
  // must not trigger any request beyond the registered interceptors.
  (mockAgent as any).assertNoPendingInterceptors();
  await mockAgent.close();
  t.mock.timers.reset();
});


async function runGetTaskByIdTimeInStatus(t: any, args: Record<string, any>) {
  t.mock.timers.enable();
  process.env.CLICKUP_API_KEY = 'test-key';
  process.env.CLICKUP_TEAM_ID = 'team1';

  const { registerTaskToolsRead } = await import('../tools/task-tools');
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const client = mockAgent.get('https://api.clickup.com');

  client.intercept({ path: /\/api\/v2\/task\/task123\?.*/, method: 'GET' })
    .reply(200, {
      id: 'task123', name: 'Test Task', markdown_description: '', attachments: [],
      creator: { username: 'creator', id: '1' }, assignees: [],
      list: { id: 'list1', name: 'List' }, space: { id: 'space1', name: 'Space' },
      status: { status: 'open', type: 'open' }, url: 'https://app.clickup.com/t/task123',
      date_created: '0', date_updated: '0'
    });
  client.intercept({ path: /\/api\/v2\/task\/task123\/comment.*/, method: 'GET' })
    .reply(200, { comments: [] });
  let timeInStatusRequests = 0;
  client.intercept({ path: '/api/v2/task/task123/time_in_status', method: 'GET' })
    .reply(() => {
      timeInStatusRequests++;
      return {
        statusCode: 200,
        data: {
          current_status: { status: 'in progress', total_time: { by_minute: 130, since: '1700000000000' } },
          status_history: [{ status: 'open', total_time: { by_minute: 45, since: '1690000000000' } }],
        },
      };
    });
  client.intercept({ path: /\/api\/v2\/team\/team1\/time_entries.*/, method: 'GET' })
    .reply(200, { data: [] });

  const tools: Record<string, any> = {};
  registerTaskToolsRead({
    tool: (name: string, _d: string, _s: any, _o: any, handler: any) => { tools[name] = handler; }
  } as any, { user: { username: 'me', id: 'u1' } });

  const result = await tools.getTaskById({ id: 'task123', ...args });
  const text = result.content
    .filter((block: any) => typeof block.text === 'string')
    .map((block: any) => block.text)
    .join('\n');

  await mockAgent.close();
  t.mock.timers.reset();
  return { text, timeInStatusRequests };
}

test('getTaskById omits the Time in status section by default and makes no extra request', async (t) => {
  const { text, timeInStatusRequests } = await runGetTaskByIdTimeInStatus(t, {});
  assert.ok(!text.includes('Time in status'));
  // The single request is the one that feeds the status history
  assert.equal(timeInStatusRequests, 1);
});

test('getTaskById appends a Time in status section when asked, reusing the same request', async (t) => {
  const { text, timeInStatusRequests } = await runGetTaskByIdTimeInStatus(t, { include_time_in_status: true });
  assert.ok(text.includes('Time in status:'));
  assert.ok(text.includes('Current status: in progress - 2h 10m'));
  assert.ok(text.includes('1. open - 45m'));
  assert.ok(text.indexOf('Time in status:') > text.indexOf("Status set to 'open'"));
  assert.equal(timeInStatusRequests, 1);
});

async function setupFailingTask(t: any, taskReply: (client: any) => void) {
  t.mock.timers.enable();
  process.env.CLICKUP_API_KEY = 'test-key';
  process.env.CLICKUP_TEAM_ID = 'team1';

  const { registerTaskToolsRead } = await import('../tools/task-tools');
  const { __resetClickUpFetchState } = await import('../shared/clickup-fetch');
  __resetClickUpFetchState();

  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const client = mockAgent.get('https://api.clickup.com');

  taskReply(client);

  // Follow-up requests that must NOT happen when the task itself cannot be loaded
  const followUps: string[] = [];
  const spy = (path: RegExp) =>
    client.intercept({ path, method: 'GET' }).reply((opts: any) => {
      followUps.push(String(opts.path));
      return { statusCode: 200, data: JSON.stringify({ comments: [], data: [], status_history: [] }) };
    }).persist();
  spy(/\/api\/v2\/task\/task123\/comment.*/);
  spy(/\/api\/v2\/task\/task123\/time_in_status/);
  spy(/\/api\/v2\/team\/team1\/time_entries.*/);
  spy(/\/api\/v2\/space\/.*/);

  const tools: Record<string, any> = {};
  registerTaskToolsRead({
    tool: (name: string, _d: string, _s: any, _o: any, handler: any) => { tools[name] = handler; }
  } as any, { user: { username: 'me', id: 'u1' } });

  const cleanup = async () => {
    await mockAgent.close();
    t.mock.timers.reset();
    __resetClickUpFetchState();
  };
  return { tools, followUps, cleanup };
}

test('getTaskById reports a 429 as a rate limit error and sends no follow-up requests', async (t) => {
  const { tools, followUps, cleanup } = await setupFailingTask(t, (client) => {
    client.intercept({ path: /\/api\/v2\/task\/task123\?.*/, method: 'GET' })
      .reply(429, { err: 'Rate limit reached', ECODE: 'APP_002' }, {
        headers: { 'retry-after': '37', 'x-ratelimit-limit': '100', 'x-ratelimit-remaining': '0' }
      });
  });

  const result = await tools.getTaskById({ id: 'task123' });
  assert.equal(result.isError, true);
  const text = result.content[0].text;
  assert.match(text, /rate limit reached/i);
  assert.match(text, /Retry after 37s/);
  assert.deepEqual(followUps, [], 'no comments / time in status / time entries / space requests');
  await cleanup();
});

test('getTaskById reports a 404 as task not found and sends no follow-up requests', async (t) => {
  const { tools, followUps, cleanup } = await setupFailingTask(t, (client) => {
    client.intercept({ path: /\/api\/v2\/task\/task123\?.*/, method: 'GET' })
      .reply(404, { err: 'Task not found', ECODE: 'ITEM_013' });
  });

  const result = await tools.getTaskById({ id: 'task123' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /not found/i);
  assert.match(result.content[0].text, /task123/);
  assert.deepEqual(followUps, []);
  await cleanup();
});

test('getTaskById reports any other non-ok task response as an error', async (t) => {
  const { tools, followUps, cleanup } = await setupFailingTask(t, (client) => {
    client.intercept({ path: /\/api\/v2\/task\/task123\?.*/, method: 'GET' })
      .reply(401, { err: 'Oauth token invalid' });
  });

  const result = await tools.getTaskById({ id: 'task123' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /401/);
  assert.deepEqual(followUps, []);
  await cleanup();
});
