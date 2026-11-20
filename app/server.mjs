// 现场查询接口：板位报告、组件报告、派单凭据与追溯。

import { createServer } from 'node:http';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { Monitor } from './monitor.mjs';
import { cellReport, panelReport, orderLineage } from './engine.mjs';

function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

export async function startQuery({ port = 0, host = '127.0.0.1', source } = {}) {
  const monitor = new Monitor(source ?? process.env.SOURCE ?? 'http://127.0.0.1:4100');

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    try {
      if (url.pathname === '/refresh' && request.method === 'POST') {
        const { stage, diff } = await monitor.refresh();
        sendJson(response, 200, { stage, diff });
        return;
      }
      if (request.method !== 'GET') {
        sendJson(response, 405, { error: '仅支持读取与刷新' });
        return;
      }
      if (url.pathname === '/') {
        sendJson(response, 200, {
          source: monitor.baseUrl,
          stage: monitor.stage,
          refreshed: monitor.model !== null,
        });
        return;
      }
      if (!monitor.model) {
        sendJson(response, 409, { error: '尚未刷新，请先 POST /refresh' });
        return;
      }
      const { state, model } = monitor;
      let match;
      if (url.pathname === '/captures') {
        sendJson(response, 200, { captures: [...model.captures.values()] });
      } else if ((match = /^\/captures\/([\w-]+)$/.exec(url.pathname))) {
        const cap = model.captures.get(match[1]);
        if (!cap) sendJson(response, 404, { error: '未找到拍摄' });
        else sendJson(response, 200, cap);
      } else if ((match = /^\/cells\/([\w-]+)$/.exec(url.pathname))) {
        sendJson(response, 200, cellReport(state, model, match[1]));
      } else if ((match = /^\/panels\/([\w-]+)$/.exec(url.pathname))) {
        sendJson(response, 200, panelReport(state, model, match[1]));
      } else if (url.pathname === '/orders') {
        sendJson(response, 200, {
          orders: [...model.credentials.values()].map((c) => ({
            id: c.id,
            panel: c.panel,
            cell: c.cell,
            capture: c.capture,
            solve: c.solve,
            temperature: c.temperature,
            state: c.state,
            orderRef: c.orderRef,
            valid: c.supersededBy === null,
            supersededBy: c.supersededBy,
          })),
        });
      } else if ((match = /^\/orders\/([\w-]+)$/.exec(url.pathname))) {
        const lineage = orderLineage(state, model, match[1]);
        if (!lineage) sendJson(response, 404, { error: '未找到派单凭据' });
        else sendJson(response, 200, lineage);
      } else if (url.pathname === '/notices') {
        sendJson(response, 200, { notices: model.notices });
      } else {
        sendJson(response, 404, { error: '未找到路由' });
      }
    } catch (error) {
      if (!response.headersSent) sendJson(response, 500, { error: `查询失败: ${error.message}` });
      else response.destroy();
    }
  });
  server.listen(port, host);
  await once(server, 'listening');
  return { server, monitor, url: `http://${host}:${server.address().port}` };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const app = await startQuery({ port: Number(process.env.PORT ?? 4200) });
  console.log(`查询服务 ${app.url} ，来源 ${app.monitor.baseUrl}`);
}
