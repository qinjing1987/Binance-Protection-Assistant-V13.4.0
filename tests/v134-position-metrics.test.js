// V13.4.0：仓位指标的口径必须全链路一致
//
// 背景：同一屏上「持仓表」与「选中仓诊断」对同一仓位会算出不同的收益率 ——
//   decoratePosition 原以 isolatedMargin 为优先基准，ProtectionManager.diagnostics
//   以 notional/杠杆 为优先基准，两者顺序相反。
//   另有前端保证金显示用裸的 p.isolatedMargin（无回退），而 ROI 用带回退的基准 ——
//   币安该字段为 0 时会出现「保证金 0.00，收益率却非 0」的自相矛盾。
// 统一为 notional/杠杆 优先：币安的 isolatedMargin 含未实现盈亏，会让 ROI 分母
// 随盈亏漂移、自我指涉，不适合当基准。这里用源码断言把口径锁死。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('V13.4.0：decoratePosition 必须把 marginBasis / notional 暴露给前端', () => {
  const app = read('server/app.js');
  assert.ok(app.includes('marginBasis: Number(marginBasis.toFixed(8))'), '必须返回 marginBasis');
  assert.ok(app.includes('marginBasisSource:'), '必须标注基准来源，便于排查');
  assert.ok(app.includes('notional: Number(notional.toFixed(8))'));
  // 基准优先级：notional/杠杆 优先
  assert.ok(
    /const marginBasis = leverage > 0 && notional > 0\s*\?\s*notional \/ leverage/.test(app),
    'decoratePosition 应以 notional/杠杆 为优先基准'
  );
});

test('V13.4.0：ProtectionManager 的保证金基准优先级必须与 decoratePosition 一致', () => {
  const pm = read('server/protection/ProtectionManager.js');
  assert.ok(
    /const positionMarginBasis = leverage != null && Math\.abs\(Number\(p\.notional \|\| 0\)\) > 0/.test(pm),
    '诊断接口应以 notional/杠杆 为优先基准'
  );
  // 两处顺序必须一致 —— 不得有一方改成 isolatedMargin 优先
  const app = read('server/app.js');
  assert.ok(
    !/const marginBasis = Number\(p\.isolatedMargin \|\| 0\) > 0/.test(app),
    'decoratePosition 不应残留 isolatedMargin 优先的旧写法'
  );
});

test('V13.4.0：前端保证金显示必须使用 marginBasis，而不是裸的 isolatedMargin', () => {
  const html = read('frontend/index.html');
  assert.ok(
    html.includes("money(p.marginBasis!=null?p.marginBasis:(p.isolatedMargin||0),2)"),
    '保证金显示应优先用 marginBasis（与 ROI 同一基准）'
  );
});

test('V13.4.0：收益率与价格变化的换算关系（解释用户看到的 ×10 现象）', () => {
  // 持仓表那一列的标签是「收益率（PnL/保证金）」，分母是 notional/杠杆，
  // 而 notional 取的是当前 mark×数量 —— 所以精确关系是：
  //     ROI = 价格变化 × 杠杆 × (entry / mark)
  // 由于 entry≈mark，显示上看起来就是「价格变化 × 杠杆」，例如 -0.172% 与 -1.72%。
  // 用户看到这两个数时它们并不是矛盾，而是标签定义如此。
  const cases = [
    { entry: 4.822, mark: 4.8198945, qty: 1.2, lev: 10, short: true },
    { entry: 0.0448, mark: 0.04477, qty: 136, lev: 10, short: true },
    { entry: 100, mark: 101.5, qty: 0.5, lev: 10, short: false }
  ];
  for (const c of cases) {
    const dir = c.short ? -1 : 1;
    const pnl = (c.mark - c.entry) * c.qty * dir;
    const notional = c.mark * c.qty;
    const roi = pnl / (notional / c.lev) * 100;
    const priceMove = (c.mark - c.entry) / c.entry * 100 * dir;
    assert.ok(
      Math.abs(roi - priceMove * c.lev * (c.entry / c.mark)) < 1e-9,
      `ROI(${roi.toFixed(6)}%) 应等于 价格变化 × 杠杆 × entry/mark`
    );
    // mark≈entry 时 ROI 显示上就是「价格变化 × 杠杆」：对 ORDI 那种 0.04% 的小幅波动，
    // 精确值与 pm×lev 的差在 1e-4 量级，四舍五入到两位小数后完全一致，
    // 所以用户看到 -0.172% 与 -1.72% 是正常的标签定义，不是数据错误。
    // 精确偏差 = |价格变化×杠杆| × |entry/mark − 1|
    const exactDev = Math.abs(priceMove * c.lev) * Math.abs(c.entry / c.mark - 1);
    assert.ok(Math.abs(Math.abs(roi - priceMove * c.lev) - exactDev) < 1e-9,
      `ROI 与 价格变化×杠杆 的偏差应恰为 |pm×lev| × |entry/mark−1|`);
  }
});
