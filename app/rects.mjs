// 板面矩形代数。矩形为 [左, 上, 右, 下] 半开区间：右边与下边不包含在范围内。

export function rectArea(rect) {
  const [l, t, r, d] = rect;
  return Math.max(0, r - l) * Math.max(0, d - t);
}

export function rectEmpty(rect) {
  return rectArea(rect) === 0;
}

export function intersect(a, b) {
  const hit = [
    Math.max(a[0], b[0]),
    Math.max(a[1], b[1]),
    Math.min(a[2], b[2]),
    Math.min(a[3], b[3]),
  ];
  return rectEmpty(hit) ? null : hit;
}

// rect 减去一块 cutter，剩下 0 至 4 块互不重叠的矩形。
export function subtractOne(rect, cutter) {
  const hit = intersect(rect, cutter);
  if (!hit) return [rect];
  const [l, t, r, d] = rect;
  const [hl, ht, hr, hd] = hit;
  return [
    [l, t, r, ht],
    [l, hd, r, d],
    [l, ht, hl, hd],
    [hr, ht, r, hd],
  ].filter((piece) => !rectEmpty(piece));
}

// 一组矩形依次减去一组扣除矩形，返回互不重叠的剩余矩形。
export function subtract(rects, cutters) {
  let rest = rects.filter((rect) => !rectEmpty(rect));
  for (const cutter of cutters) {
    rest = rest.flatMap((rect) => subtractOne(rect, cutter));
  }
  return rest;
}

// 有效矩形扣除遮挡矩形后，单次观测对板面的净贡献。
export function contribution(validRects, maskedRects) {
  return subtract(validRects, maskedRects);
}

// 并集面积：重叠区域只算一次。
export function unionArea(rects) {
  const kept = [];
  let total = 0;
  for (const rect of rects) {
    if (rectEmpty(rect)) continue;
    const pieces = subtract([rect], kept);
    for (const piece of pieces) total += rectArea(piece);
    kept.push(rect);
  }
  return total;
}
