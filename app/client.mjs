// 从影像站与资产站拉取记录与原件。只依赖 Node.js 自带运行库。

import { createHash } from 'node:crypto';

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} 失败: ${response.status}`);
  return response.json();
}

export async function pullSource(baseUrl, name) {
  const records = [];
  let offset = 0;
  do {
    const page = await getJson(`${baseUrl}/source/${name}?offset=${offset}&limit=100`);
    records.push(...page.records);
    offset = page.next;
  } while (offset !== null);
  return records;
}

export async function pullAll(baseUrl) {
  const overview = await getJson(`${baseUrl}/`);
  const entries = {};
  for (const name of overview.sources) {
    entries[name] = await pullSource(baseUrl, name);
  }
  return { overview, entries };
}

// 领取一份原件；未到时返回 404 状态，成功时附带本地留存摘要。
export async function fetchOriginal(baseUrl, name) {
  const response = await fetch(`${baseUrl}/original/${name}`);
  if (response.status === 404) return { status: 404, name };
  if (!response.ok) throw new Error(`GET /original/${name} 失败: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    status: 200,
    name,
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}
