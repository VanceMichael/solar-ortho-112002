// 判定引擎：从归一化状态推导观测资格、覆盖视图、复查凭据与定位修订通知。
// 全部输出由输入记录确定性推出，刷新重建不会产生重复凭据。

import { contribution, subtract, unionArea } from './rects.mjs';
import { panelAt, panelsOfCell, formatTime } from './store.mjs';

const CORROBORATE_WITHIN_MINUTES = 5;

function cellKey(cell) {
  const match = /^([A-Za-z]*)(\d+)$/.exec(cell);
  return match ? { prefix: match[1], num: Number(match[2]) } : { prefix: cell, num: 0 };
}

export function adjacentCells(a, b) {
  const ca = cellKey(a);
  const cb = cellKey(b);
  return ca.prefix === cb.prefix && Math.abs(ca.num - cb.num) === 1;
}

export function evaluate(state) {
  const { captures, solutions, rule, coverageRule } = state;
  const boardRect = coverageRule ? [0, 0, coverageRule.board[0], coverageRule.board[1]] : null;
  const boardArea = coverageRule ? coverageRule.board[0] * coverageRule.board[1] : null;

  // ---- 取件状态：索引先到时可以查缺件 ----
  const captureSummaries = new Map();
  for (const [id, cap] of captures) {
    const missing = [];
    const bands = {};
    for (const [band, name] of Object.entries(cap.bands)) {
      const receipt = cap.received.get(name) ?? null;
      if (!receipt) missing.push(name);
      bands[band] = { name, received: receipt !== null, ...(receipt ?? {}) };
    }
    captureSummaries.set(id, {
      id,
      time: cap.timeText,
      attitude: cap.attitude,
      bands,
      missing,
    });
  }

  // ---- 观测：每个定位解的每个板位格各算一次，互不合并 ----
  const observations = [];
  for (const sol of solutions.values()) {
    const cap = captures.get(sol.capture);
    for (const cell of sol.footprint) {
      const install = cap.time != null ? panelAt(state, cell, cap.time) : null;
      const problems = [];
      if (!install) problems.push('板位无生效装机记录');
      for (const band of rule.requiredBands) {
        const name = cap.bands[band];
        const receipt = name ? cap.received.get(name) : null;
        if (!name || !receipt) {
          problems.push(`${band} 原件未交付`);
        } else {
          if (!receipt.located) problems.push(`${band} 原件未定位`);
          if (receipt.saturated) problems.push(`${band} 饱和，不可用于判定`);
          if (receipt.shaded) problems.push(`${band} 阴影，不可用于判定`);
        }
      }
      const area = sol.areas.get(cell) ?? null;
      let contributionRects = null;
      let areaNote = null;
      if (boardRect) {
        if (area) {
          contributionRects = contribution(area.validRects, area.maskedRects);
          if (area.validRects.length === 0 && area.maskedRects.length > 0) {
            areaNote = '遮挡未拆分，不以更大外框计入';
          }
        } else {
          contributionRects = [boardRect];
          areaNote = '无毫米级面积记录，按整板计入';
        }
      }
      const inWindow = rule.window
        ? cap.time >= rule.window[0] && cap.time < rule.window[1]
        : false;
      observations.push({
        capture: sol.capture,
        solve: sol.solve,
        order: sol.order,
        cell,
        time: cap.timeText,
        minutes: cap.time,
        panel: install ? install.panel : null,
        install,
        qualified: problems.length === 0,
        problems,
        inWindow,
        contribution: contributionRects,
        contributionArea: contributionRects ? unionArea(contributionRects) : null,
        areaNote,
        hot: sol.hot.filter((h) => h.cell === cell),
        corroboratedBy: [],
      });
    }
  }

  // 互证：同一定位解、同一板位、相近时刻的其他有资格观测。不跨定位解。
  for (const obs of observations) {
    if (!obs.qualified || obs.minutes == null) continue;
    obs.corroboratedBy = observations
      .filter(
        (other) =>
          other !== obs &&
          other.qualified &&
          other.minutes != null &&
          other.solve === obs.solve &&
          other.cell === obs.cell &&
          other.capture !== obs.capture &&
          Math.abs(other.minutes - obs.minutes) <= CORROBORATE_WITHIN_MINUTES,
      )
      .map((other) => other.capture);
  }

  // ---- 覆盖视图：按定位解分列；现行视图取每次拍摄最新一版解 ----
  const latestOrder = new Map();
  for (const sol of solutions.values()) {
    latestOrder.set(sol.capture, Math.max(latestOrder.get(sol.capture) ?? 0, sol.order));
  }
  const buildView = (pool) => {
    const cells = new Map();
    for (const obs of pool) {
      if (!obs.qualified || !obs.inWindow || !obs.panel) continue;
      if (!cells.has(obs.cell)) cells.set(obs.cell, new Map());
      const byPanel = cells.get(obs.cell);
      if (!byPanel.has(obs.panel)) byPanel.set(obs.panel, []);
      byPanel.get(obs.panel).push(obs);
    }
    const view = new Map();
    for (const [cell, byPanel] of cells) {
      const panels = new Map();
      for (const [panel, usable] of byPanel) {
        const pieces = usable.flatMap((obs) => obs.contribution ?? []);
        let ratio = null;
        let pass = usable.length > 0;
        let uncovered = null;
        if (coverageRule) {
          const covered = unionArea(pieces);
          ratio = covered / boardArea;
          pass = ratio >= coverageRule.passRatio;
          uncovered = subtract([boardRect], pieces);
        }
        panels.set(panel, {
          panel,
          captures: usable.map((obs) => obs.capture),
          ratio,
          pass,
          uncovered,
        });
      }
      view.set(cell, panels);
    }
    return view;
  };

  const views = {
    current: buildView(observations.filter((obs) => obs.order === latestOrder.get(obs.capture))),
    bySolve: {},
  };
  for (const solve of new Set(observations.map((obs) => obs.solve))) {
    views.bySolve[solve] = buildView(observations.filter((obs) => obs.solve === solve));
  }

  // ---- 复查凭据：温度达标且观测有资格即可出证，与覆盖窗口无关 ----
  const credentials = new Map();
  for (const sol of solutions.values()) {
    const cap = captures.get(sol.capture);
    for (const hot of sol.hot) {
      if (rule.issueFrom == null || hot.temperature < rule.issueFrom) continue;
      const obs = observations.find(
        (o) => o.capture === sol.capture && o.solve === sol.solve && o.cell === hot.cell,
      );
      if (!obs || !obs.qualified) continue;
      const id = `RC-${sol.capture}-${sol.solve}-${hot.cell}`;
      credentials.set(id, {
        id,
        capture: sol.capture,
        solve: sol.solve,
        cell: hot.cell,
        panel: obs.panel,
        temperature: hot.temperature,
        time: cap.timeText,
        inWindow: obs.inWindow,
        state: 'open',
        orderRef: null,
        accepts: [],
        supersededBy: null,
        movedTo: null,
      });
    }
  }

  // 现场接单回执：按 组件+拍摄+定位解 挂到凭据上。
  const unmatchedAccepts = [];
  for (const accept of state.accepts) {
    const found = [...credentials.values()].find(
      (c) => c.panel === accept.panel && c.capture === accept.capture && c.solve === accept.solve,
    );
    if (found) {
      found.accepts.push(accept);
      found.state = 'accepted';
      found.orderRef = accept.order;
    } else {
      unmatchedAccepts.push(accept);
    }
  }

  // ---- 定位修订：新解取代旧解的板位解释，旧派单留存，变更交原接手人 ----
  const notices = [];
  for (const cred of credentials.values()) {
    const versions = [...solutions.values()]
      .filter((sol) => sol.capture === cred.capture)
      .sort((a, b) => a.order - b.order);
    const latest = versions[versions.length - 1];
    if (!latest || latest.solve === cred.solve) continue;
    const stillHot = latest.hot.some(
      (h) => h.cell === cred.cell && (rule.issueFrom == null || h.temperature >= rule.issueFrom),
    );
    if (stillHot) continue;
    cred.supersededBy = latest.solve;
    const moved = latest.hot.find(
      (h) =>
        h.cell !== cred.cell &&
        adjacentCells(h.cell, cred.cell) &&
        (rule.issueFrom == null || h.temperature >= rule.issueFrom),
    );
    const newCred = moved ? credentials.get(`RC-${cred.capture}-${latest.solve}-${moved.cell}`) : null;
    if (moved) cred.movedTo = newCred ? newCred.id : null;
    notices.push({
      id: `CN-${cred.capture}-${cred.solve}-${latest.solve}-${cred.cell}`,
      kind: moved ? 'moved' : 'cleared',
      capture: cred.capture,
      fromSolve: cred.solve,
      toSolve: latest.solve,
      from: { cell: cred.cell, panel: cred.panel },
      to: moved ? { cell: moved.cell, panel: newCred ? newCred.panel : null, temperature: moved.temperature } : null,
      oldOrder: cred.id,
      oldOrderRef: cred.orderRef,
      toHandlerOf: cred.orderRef,
      newOrder: newCred ? newCred.id : null,
      oldOrderRetained: true,
    });
  }

  return {
    captures: captureSummaries,
    observations,
    views,
    credentials,
    notices,
    unmatchedAccepts,
    rule,
    coverageRule,
    boardArea,
  };
}

// ---- 现场查询：板位报告 ----
export function cellReport(state, model, cell) {
  const viewOf = (view) => {
    const byPanel = view.get(cell);
    if (!byPanel) return {};
    return Object.fromEntries(
      [...byPanel.entries()].map(([panel, cov]) => [
        panel,
        {
          panel,
          captures: cov.captures,
          ratio: cov.ratio,
          pass: cov.pass,
          uncovered: cov.uncovered,
        },
      ]),
    );
  };
  const installs = panelsOfCell(state, cell).map((i) => ({
    panel: i.panel,
    range: [formatTime(i.from), formatTime(i.to)],
  }));
  return {
    cell,
    installs,
    observations: model.observations
      .filter((obs) => obs.cell === cell)
      .map((obs) => ({
        capture: obs.capture,
        solve: obs.solve,
        time: obs.time,
        panel: obs.panel,
        qualified: obs.qualified,
        problems: obs.problems,
        inWindow: obs.inWindow,
        contributionArea: obs.contributionArea,
        areaNote: obs.areaNote,
        hot: obs.hot,
        corroboratedBy: obs.corroboratedBy,
      })),
    coverage: {
      current: viewOf(model.views.current),
      bySolve: Object.fromEntries(
        Object.entries(model.views.bySolve).map(([solve, view]) => [solve, viewOf(view)]),
      ),
    },
    orders: [...model.credentials.values()]
      .filter((cred) => cred.cell === cell)
      .map(publicOrder),
  };
}

// ---- 现场查询：组件报告（含换板后无依据的判定） ----
export function panelReport(state, model, panel) {
  const installs = state.installs.filter((i) => i.panel === panel);
  const cells = [...new Set(installs.map((i) => i.cell))];
  const observations = model.observations.filter((obs) => obs.panel === panel);
  return {
    panel,
    installs: installs.map((i) => ({ cell: i.cell, range: [formatTime(i.from), formatTime(i.to)] })),
    cells,
    observations: observations.map((obs) => ({
      capture: obs.capture,
      solve: obs.solve,
      cell: obs.cell,
      time: obs.time,
      qualified: obs.qualified,
      problems: obs.problems,
      inWindow: obs.inWindow,
      hot: obs.hot,
    })),
    orders: [...model.credentials.values()]
      .filter((cred) => cred.panel === panel)
      .map(publicOrder),
  };
}

function publicOrder(cred) {
  return {
    id: cred.id,
    panel: cred.panel,
    cell: cred.cell,
    capture: cred.capture,
    solve: cred.solve,
    temperature: cred.temperature,
    time: cred.time,
    inWindow: cred.inWindow,
    state: cred.state,
    orderRef: cred.orderRef,
    valid: cred.supersededBy === null,
    supersededBy: cred.supersededBy,
    movedTo: cred.movedTo,
  };
}

// ---- 现场查询：从已领派单追溯热像如何落到板上 ----
export function orderLineage(state, model, orderId) {
  const cred = model.credentials.get(orderId);
  if (!cred) return null;
  const cap = state.captures.get(cred.capture);
  const sol = state.solutions.get(`${cred.capture}|${cred.solve}`);
  const summary = model.captures.get(cred.capture);
  const bands = {};
  for (const [band, name] of Object.entries(cap.bands)) {
    const receipt = cap.received.get(name) ?? null;
    const original = cap.originals.get(name) ?? null;
    bands[band] = {
      name,
      received: receipt !== null,
      ...(receipt ?? {}),
      sha256: original ? original.sha256 : null,
    };
  }
  return {
    ...publicOrder(cred),
    accepts: cred.accepts,
    notices: model.notices.filter((n) => n.oldOrder === cred.id || n.newOrder === cred.id),
    lineage: {
      capture: cred.capture,
      time: cap.timeText,
      attitude: cap.attitude,
      solve: cred.solve,
      footprint: sol ? [...sol.footprint] : [],
      hot: sol ? sol.hot.map((h) => ({ ...h })) : [],
      bands,
      install: cred.panel
        ? (() => {
            const found = state.installs.find(
              (i) => i.cell === cred.cell && i.panel === cred.panel && cap.time >= i.from && cap.time < i.to,
            );
            return found
              ? { cell: found.cell, panel: found.panel, range: [formatTime(found.from), formatTime(found.to)] }
              : null;
          })()
        : null,
      captureMissing: summary ? summary.missing : [],
    },
  };
}
