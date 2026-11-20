// 把来源记录归一化为判定用的状态。每次刷新按全量记录重建，保证幂等。

export function parseTime(text) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (!match) throw new Error(`时间格式无效: ${text}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

export function formatTime(minutes) {
  const h = String(Math.floor(minutes / 60)).padStart(2, '0');
  const m = String(minutes % 60).padStart(2, '0');
  return `${h}:${m}`;
}

export function buildState({ imagery = [], geometry = [], assets = [] } = {}) {
  const captures = new Map();
  const solutions = new Map();
  const installs = [];
  const accepts = [];
  const rule = { window: null, issueFrom: null, requiredBands: [] };
  let coverageRule = null;
  let solutionOrder = 0;

  const captureOf = (id) => {
    if (!captures.has(id)) {
      captures.set(id, {
        id,
        time: null,
        timeText: null,
        bands: {},
        attitude: null,
        received: new Map(),
        originals: new Map(),
      });
    }
    return captures.get(id);
  };

  for (const entry of imagery) {
    const { kind, payload } = entry;
    if (kind === 'index') {
      const capture = captureOf(payload.capture);
      capture.time = parseTime(payload.time);
      capture.timeText = payload.time;
      capture.bands = { ...payload.bands };
      capture.attitude = payload.attitude ?? null;
      capture.firstSolve = payload.solve ?? null;
    } else if (kind === 'received') {
      const capture = captureOf(payload.capture);
      capture.received.set(payload.name, {
        located: payload.located !== false,
        saturated: payload.saturated === true,
        shaded: payload.shaded === true,
      });
    }
  }

  for (const entry of geometry) {
    const { kind, payload } = entry;
    if (kind === 'solution') {
      const key = `${payload.capture}|${payload.solve}`;
      solutions.set(key, {
        capture: payload.capture,
        solve: payload.solve,
        order: solutionOrder += 1,
        footprint: [...payload.footprint],
        hot: (payload.hot ?? []).map((h) => ({ cell: h.cell, temperature: h.temperature })),
        areas: new Map(),
      });
      captureOf(payload.capture);
    } else if (kind === 'area') {
      const key = `${payload.capture}|${payload.solve}`;
      const solution = solutions.get(key);
      if (solution) {
        solution.areas.set(payload.cell, {
          validRects: (payload.validRects ?? []).map((r) => [...r]),
          maskedRects: (payload.maskedRects ?? []).map((r) => [...r]),
        });
      }
    }
  }

  for (const entry of assets) {
    const { kind, payload } = entry;
    if (kind === 'install') {
      installs.push({
        cell: payload.cell,
        panel: payload.panel,
        from: parseTime(payload.range[0]),
        to: parseTime(payload.range[1]),
      });
    } else if (kind === 'rule') {
      rule.window = payload.coverageWindow
        ? [parseTime(payload.coverageWindow[0]), parseTime(payload.coverageWindow[1])]
        : null;
      rule.issueFrom = payload.issueFrom ?? null;
      rule.requiredBands = [...(payload.requiredBands ?? [])];
    } else if (kind === 'coverage-rule') {
      coverageRule = { board: [...payload.board], passRatio: payload.passRatio };
    } else if (kind === 'accept') {
      accepts.push({
        order: payload.order,
        panel: payload.panel,
        capture: payload.capture,
        solve: payload.solve,
        time: parseTime(payload.time),
        timeText: payload.time,
      });
    }
  }

  installs.sort((a, b) => a.from - b.from);

  return { captures, solutions, installs, accepts, rule, coverageRule };
}

// 拍摄时刻落在哪块组件的生效区间内（半开 [from, to)）。
export function panelAt(state, cell, time) {
  for (const install of state.installs) {
    if (install.cell === cell && time >= install.from && time < install.to) return install;
  }
  return null;
}

// 板位在任意时刻装过的组件，按生效先后排列。
export function panelsOfCell(state, cell) {
  return state.installs.filter((install) => install.cell === cell);
}
