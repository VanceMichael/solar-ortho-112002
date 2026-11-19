# 光伏巡检影像覆盖与派单凭据的演练来源

这里提供独立来源的本地合成记录，与实际单位、个人和线上业务无关。

## 本地运行

使用 Node.js 22.23.4。只使用 Node.js 自带的运行库。

执行 `npm test` 检查合成来源的接口。执行 `npm start` 启动来源，默认监听 `127.0.0.1:4100`，可通过环境变量 `PORT` 调整端口。访问根路径可看到来源名和当前回放阶段。

## 接口资料

| GET 路由 | 来源约定 |
| --- | --- |
| `/source/imagery` | capture 是拍摄身份；band 可有 IR 与 RGB。index 声明取件名和定位解，received 标记本轮影像站的实物交付。 |
| `/source/geometry` | footprint 为平面格集合，hot 为供应方给出的格内热斑候选。相同 capture 换 solve 后是同一原件的另一定位解释。 |
| `/source/assets` | install 是按格与半开时间范围提供的板位事实。温度达到 issueFrom 即可生成复查凭据。 |

查询参数 `offset` 是从零开始的页偏移，`limit` 默认 3，取值 1 至 100。响应中的 `records` 含 `record` 来源记录键、`availableFrom` 首次出现的回放阶段、`kind` 记录类型、`payload` 业务字段。来源记录键与业务身份分别定义。`next` 为下一页偏移，末页为 `null`。回放阶段中的记录按到达顺序可查。

控制员通过 `POST /control?stage=2` 切换到第 2 阶段，服务会保留更早已可查的记录。每次换阶段后按根路径返回的 `stage` 确认切换成功。原件通过 `GET /original/文件名` 领取，阶段内尚不可领时返回 404。原件文件和摘要记录在 `originals/` 与来源索引。

area 以组件上的毫米坐标给有效矩形 validRects 和需扣除的遮挡矩形 maskedRects，顺序为左、上、右、下。板面范围和合格覆盖比例由 coverage-rule 给出。影像是可读 PGM/PPM，几何与温度由来源侧人工校验记录提供。

覆盖规则定义板面平面和最低比例。area 记录组件内的有效和遮挡矩形，坐标顺序为左上右下，矩形右边和下边不包含在范围中。图像原件可用常见 PGM/PPM 解码。
