// 监视器：每轮刷新拉取全部来源记录，重建状态并评估，再与上一轮比对增量。

import { pullAll, fetchOriginal } from './client.mjs';
import { buildState } from './store.mjs';
import { evaluate } from './engine.mjs';

export class Monitor {
  constructor(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.state = null;
    this.model = null;
    this.stage = null;
    this.previous = null;
  }

  async refresh() {
    const { overview, entries } = await pullAll(this.baseUrl);
    this.stage = overview.stage;
    const state = buildState(entries);

    // 领取已交付的原件并留存摘要；索引有而交付未到的保持缺件状态。
    for (const cap of state.captures.values()) {
      for (const name of cap.received.keys()) {
        if (cap.originals.has(name)) continue;
        const got = await fetchOriginal(this.baseUrl, name);
        if (got.status === 200) {
          cap.originals.set(name, { sha256: got.sha256, bytes: got.bytes.length });
        }
      }
    }

    const model = evaluate(state);
    const diff = this.previous ? diffModels(this.previous, model) : {
      newOrders: [...model.credentials.keys()],
      newNotices: model.notices.map((n) => n.id),
      arrived: [],
    };
    this.state = state;
    this.model = model;
    this.previous = model;
    return { stage: this.stage, diff, model, state };
  }
}

function diffModels(before, after) {
  const newOrders = [...after.credentials.keys()].filter((id) => !before.credentials.has(id));
  const newNotices = after.notices.map((n) => n.id).filter((id) => !before.notices.some((n) => n.id === id));
  const arrived = [];
  for (const [id, cap] of after.captures) {
    const old = before.captures.get(id);
    if (!old) continue;
    for (const name of old.missing) {
      if (!cap.missing.includes(name)) arrived.push({ capture: id, name });
    }
  }
  return { newOrders, newNotices, arrived };
}
