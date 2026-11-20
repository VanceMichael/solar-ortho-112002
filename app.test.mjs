import assert from 'node:assert/strict';
import { test } from 'node:test';
import { start } from './source-server.mjs';
import { startQuery } from './app/server.mjs';
import { Monitor } from './app/monitor.mjs';
import { cellReport, panelReport, orderLineage } from './app/engine.mjs';
import { contribution, subtract, unionArea } from './app/rects.mjs';

const close = (server) => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));

test('矩形代数：重叠只算一次，遮挡扣除，未覆盖可求', () => {
  // 主航带 75% + 回转段 30%，重叠 5% 只算一次 → 100%
  assert.equal(unionArea([[0, 0, 2000, 750], [0, 700, 2000, 1000]]), 2000000);
  // 有效矩形扣除遮挡
  assert.deepEqual(contribution([[0, 0, 2000, 900]], [[0, 750, 2000, 1000]]), [[0, 0, 2000, 750]]);
  // 未覆盖区域
  assert.deepEqual(subtract([[0, 0, 2000, 1000]], [[0, 700, 2000, 1000]]), [[0, 0, 2000, 700]]);
  // 无交集不受影响
  assert.equal(unionArea([[0, 0, 100, 100], [200, 200, 300, 300]]), 20000);
});

test('四阶段回放：缺件、饱和、重解、换板、窗外补拍', async (t) => {
  const source = await start();
  t.after(() => close(source.server));
  const monitor = new Monitor(source.url);
  const setStage = async (stage) => {
    const res = await fetch(`${source.url}/control?stage=${stage}`, { method: 'POST' });
    assert.equal(res.status, 200);
  };

  // ---------- 阶段 1：索引先到，IR 缺件；饱和波段不可用于判定 ----------
  await setStage(1);
  let { model, state, diff } = await monitor.refresh();

  const c42 = model.captures.get('C42');
  assert.deepEqual(c42.missing, ['t42.pgm'], '索引声明了 IR 与 RGB，只到了 RGB，应报 IR 缺件');
  assert.deepEqual(model.captures.get('C43').missing, []);
  assert.deepEqual(model.captures.get('C45').missing, []);

  const obsOf = (m, capture, solve, cell) =>
    m.observations.find((o) => o.capture === capture && o.solve === solve && o.cell === cell);

  assert.equal(obsOf(model, 'C42', 'P1', 'A1').qualified, false);
  assert.ok(obsOf(model, 'C42', 'P1', 'A1').problems.includes('IR 原件未交付'));
  assert.equal(obsOf(model, 'C43', 'P1', 'A3').qualified, false);
  assert.ok(obsOf(model, 'C43', 'P1', 'A3').problems.some((p) => p.includes('饱和')));
  assert.equal(obsOf(model, 'C45', 'P1', 'A1').qualified, true);

  // 热斑候选因缺件/饱和被挡下，不出凭据；低于阈值的候选也不出
  assert.equal(model.credentials.size, 0);

  // 覆盖：A1 只有回转段 C45 的 30%；A2 的 C45 遮挡未拆分不计入；A3 唯一观测饱和
  let a1 = cellReport(state, model, 'A1');
  assert.equal(a1.coverage.current.P11.ratio, 0.3);
  assert.equal(a1.coverage.current.P11.pass, false);
  let a2 = cellReport(state, model, 'A2');
  assert.equal(a2.coverage.current.P12.ratio, 0, 'C45 对 A2 只有遮挡没有有效矩形，不得以更大外框计入');
  assert.equal(obsOf(model, 'C45', 'P1', 'A2').areaNote, '遮挡未拆分，不以更大外框计入');
  let a3 = cellReport(state, model, 'A3');
  assert.deepEqual(a3.coverage.current, {}, 'A3 窗口内无有资格观测，不能宣布查过');

  // ---------- 阶段 2：IR 到件，出凭据并被接单；重叠区域只算一次 ----------
  await setStage(2);
  ({ model, state, diff } = await monitor.refresh());
  assert.deepEqual(diff.arrived, [{ capture: 'C42', name: 't42.pgm' }]);
  assert.deepEqual(model.captures.get('C42').missing, []);

  assert.deepEqual(diff.newOrders, ['RC-C42-P1-A1']);
  const rc1 = model.credentials.get('RC-C42-P1-A1');
  assert.equal(rc1.panel, 'P11');
  assert.equal(rc1.temperature, 74);
  assert.equal(rc1.state, 'accepted');
  assert.equal(rc1.orderRef, 'WO6', '资产站接单回执应挂到凭据上');
  assert.equal(model.unmatchedAccepts.length, 0);

  a1 = cellReport(state, model, 'A1');
  assert.equal(a1.coverage.current.P11.ratio, 1, '主航带 75% 与回转段 30% 重叠部分只算一次，合并恰好整板');
  assert.equal(a1.coverage.current.P11.pass, true);
  a2 = cellReport(state, model, 'A2');
  assert.equal(a2.coverage.current.P12.ratio, 1);
  // 互证：同解同板位相近时刻的有效观测互相印证
  assert.deepEqual(obsOf(model, 'C42', 'P1', 'A1').corroboratedBy, ['C45']);
  assert.deepEqual(obsOf(model, 'C45', 'P1', 'A1').corroboratedBy, ['C42']);

  // ---------- 阶段 3：定位解重做，热斑移到相邻板位；A1 换板 ----------
  await setStage(3);
  ({ model, state, diff } = await monitor.refresh());

  assert.deepEqual(diff.newOrders, ['RC-C42-P2-A2'], '相邻板位满足复查口径，应有独立可领凭据');
  const rc2 = model.credentials.get('RC-C42-P2-A2');
  assert.equal(rc2.panel, 'P12');
  assert.equal(rc2.state, 'open');

  const rc1After = model.credentials.get('RC-C42-P1-A1');
  assert.equal(rc1After.supersededBy, 'P2', '旧解释被修订');
  assert.equal(rc1After.state, 'accepted', '旧派单留存，接单状态不抹掉');
  assert.equal(rc1After.movedTo, 'RC-C42-P2-A2');

  assert.equal(diff.newNotices.length, 1);
  const notice = model.notices[0];
  assert.equal(notice.kind, 'moved');
  assert.equal(notice.toHandlerOf, 'WO6', '变更交给原接手人');
  assert.equal(notice.oldOrderRetained, true);
  assert.equal(notice.newOrder, 'RC-C42-P2-A2');
  assert.deepEqual(notice.from, { cell: 'A1', panel: 'P11' });
  assert.deepEqual(notice.to, { cell: 'A2', panel: 'P12', temperature: 74 });

  // 不拼解：现行视图里 C42 只取最新解 P2，A1 只剩 C45 的 30%；P1 视图原样保留
  a1 = cellReport(state, model, 'A1');
  assert.equal(a1.coverage.current.P11.ratio, 0.3);
  assert.equal(a1.coverage.current.P11.pass, false);
  assert.deepEqual(a1.coverage.current.P11.uncovered, [[0, 0, 2000, 700]], '需补拍的区域应可指出');
  assert.equal(a1.coverage.bySolve.P1.P11.ratio, 1, '旧解视图作为历史解释保留，不与新解合并');

  // 换板：A1 自 11:00 起装 P31，旧热像不构成新板的复查依据
  const p31 = panelReport(state, model, 'P31');
  assert.deepEqual(p31.orders, []);
  assert.deepEqual(p31.observations, [], 'P31 生效区间内没有任何拍摄，不能宣布查过');
  const p11 = panelReport(state, model, 'P11');
  assert.equal(p11.orders.length, 1, 'P11 的历史凭据仍在');

  // ---------- 阶段 4：窗外补拍可出凭据，但不反填窗口覆盖 ----------
  await setStage(4);
  ({ model, state, diff } = await monitor.refresh());
  assert.deepEqual(diff.newOrders, ['RC-C44-P2-A3']);
  const rc3 = model.credentials.get('RC-C44-P2-A3');
  assert.equal(rc3.panel, 'P13');
  assert.equal(rc3.inWindow, false, '补拍在覆盖窗口外仍可生成复查凭据');

  a3 = cellReport(state, model, 'A3');
  assert.deepEqual(a3.coverage.current.P13.captures, ['C42'], '窗口外补拍不反填当天完整覆盖');
  assert.equal(a3.coverage.current.P13.ratio, 1);
  assert.equal(obsOf(model, 'C44', 'P2', 'A3').inWindow, false);
  assert.equal(obsOf(model, 'C44', 'P2', 'A3').qualified, true);

  // 重复刷新是幂等的：判定由记录推出，不产生重复凭据或通知
  ({ diff } = await monitor.refresh());
  assert.deepEqual(diff, { newOrders: [], newNotices: [], arrived: [] });

  // ---------- 追溯：从已领派单回到热像落板依据 ----------
  const lineage = orderLineage(state, model, 'RC-C42-P1-A1');
  assert.equal(lineage.orderRef, 'WO6');
  assert.equal(lineage.valid, false);
  assert.equal(lineage.lineage.solve, 'P1');
  assert.equal(lineage.lineage.time, '10:02');
  assert.ok(lineage.lineage.attitude, '应保留拍摄姿态');
  assert.deepEqual(lineage.lineage.footprint, ['A1', 'A2']);
  assert.deepEqual(lineage.lineage.install, { cell: 'A1', panel: 'P11', range: ['00:00', '11:00'] });
  assert.equal(lineage.lineage.bands.IR.name, 't42.pgm');
  assert.match(lineage.lineage.bands.IR.sha256, /^[0-9a-f]{64}$/);
  assert.equal(lineage.accepts[0].order, 'WO6');
  assert.equal(lineage.notices.length, 1);
});

test('现场查询接口', async (t) => {
  const source = await start();
  t.after(() => close(source.server));
  await fetch(`${source.url}/control?stage=4`, { method: 'POST' });
  const query = await startQuery({ source: source.url });
  t.after(() => close(query.server));

  let res = await fetch(`${query.url}/cells/A1`);
  assert.equal(res.status, 409, '未刷新前应提示');
  res = await fetch(`${query.url}/refresh`, { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).stage, 4);

  const cell = await (await fetch(`${query.url}/cells/A1`)).json();
  assert.equal(cell.observations.length, 2, 'A1 被 C42/P1 与 C45/P1 各解释一次');
  assert.deepEqual(cell.installs.map((i) => i.panel), ['P11', 'P31']);

  const panel = await (await fetch(`${query.url}/panels/P31`)).json();
  assert.deepEqual(panel.orders, []);

  const orders = await (await fetch(`${query.url}/orders`)).json();
  assert.equal(orders.orders.length, 3);

  const lineage = await (await fetch(`${query.url}/orders/RC-C42-P1-A1`)).json();
  assert.equal(lineage.lineage.bands.IR.sha256.length, 64);

  const notices = await (await fetch(`${query.url}/notices`)).json();
  assert.equal(notices.notices.length, 1);
  assert.equal(notices.notices[0].toHandlerOf, 'WO6');

  const missing = await fetch(`${query.url}/orders/RC-NOPE`);
  assert.equal(missing.status, 404);
});
