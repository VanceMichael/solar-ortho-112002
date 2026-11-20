// 演练走查：按回放阶段逐轮刷新，打印每轮的缺件、凭据、修订通知与覆盖结论。

import { Monitor } from './monitor.mjs';
import { cellReport } from './engine.mjs';

const source = (process.env.SOURCE ?? 'http://127.0.0.1:4100').replace(/\/$/, '');
const monitor = new Monitor(source);

const overview = await (await fetch(`${source}/`)).json();
console.log(`来源 ${source} ，共 ${overview.stages} 个回放阶段`);

for (let stage = 1; stage <= overview.stages; stage += 1) {
  await fetch(`${source}/control?stage=${stage}`, { method: 'POST' });
  const { diff, model } = await monitor.refresh();
  console.log(`\n== 阶段 ${stage} ==`);
  for (const cap of model.captures.values()) {
    if (cap.missing.length > 0) console.log(`缺件 ${cap.id}: ${cap.missing.join('、')}`);
  }
  for (const item of diff.arrived) console.log(`到件 ${item.capture}: ${item.name}`);
  for (const id of diff.newOrders) {
    const c = model.credentials.get(id);
    console.log(`凭据 ${c.id} 组件 ${c.panel} 板位 ${c.cell} ${c.temperature}℃ (${c.capture}@${c.time} ${c.solve})${c.inWindow ? '' : ' [覆盖窗口外]'}`);
  }
  for (const nid of diff.newNotices) {
    const n = model.notices.find((x) => x.id === nid);
    const target = n.toHandlerOf ? `交原接手人(${n.toHandlerOf})` : '交调度台';
    console.log(`修订 ${n.capture} ${n.fromSolve}→${n.toSolve}: 热斑 ${n.from.cell}(${n.from.panel})${n.to ? ` 移至 ${n.to.cell}(${n.to.panel})` : ' 不再成立'}，旧派单 ${n.oldOrder} 留存，${target}${n.newOrder ? `，新凭据 ${n.newOrder} 独立可领` : ''}`);
  }
}

console.log('\n== 覆盖结论（现行视图，窗口内） ==');
const cells = [...new Set(monitor.model.observations.map((o) => o.cell))].sort();
for (const cell of cells) {
  const report = cellReport(monitor.state, monitor.model, cell);
  const current = report.coverage.current;
  for (const install of report.installs) {
    const cov = current[install.panel];
    if (!cov) {
      console.log(`${cell} ${install.panel}: 窗口内无有效观测，不能宣布查过`);
    } else {
      const ratio = cov.ratio === null ? '—' : `${(cov.ratio * 100).toFixed(1)}%`;
      console.log(`${cell} ${install.panel}: 覆盖 ${ratio} ${cov.pass ? '达标' : '未达标'}${cov.uncovered?.length ? ` 未覆盖 ${JSON.stringify(cov.uncovered)}` : ''}`);
    }
  }
}

console.log('\n== 派单凭据 ==');
for (const c of monitor.model.credentials.values()) {
  console.log(`${c.id} ${c.panel} ${c.temperature}℃ 状态 ${c.state}${c.orderRef ? `(${c.orderRef})` : ''}${c.supersededBy ? ` 已被 ${c.supersededBy} 修订留存` : ' 有效'}`);
}
