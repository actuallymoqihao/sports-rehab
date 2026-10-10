/**
 * 方案引擎：把身体资料 + 视频指标 + 有氧 + 三级跳数据 → 评估与训练方案。
 *
 * 阈值与判读顺序严格对齐 assets/generate_report.py 与 references/norms-and-cutoffs.md，
 * 避免手机端和电脑端给出两套互相矛盾的建议。
 */

export const REBOUND_MAX_CONTACT_MS = 400;

const LABELS = {
  weightKg: '体重', squat1RMKg: '深蹲 1RM', relSquat: '相对深蹲 (×体重)',
  standingReachCm: '站立摸高', cmjCm: 'CMJ 高度', sjCm: 'SJ 高度',
  sscGainCm: 'SSC 贡献 (CMJ−SJ)', approachReachCm: '助跑摸高',
  approachGainCm: '助跑增益', rsi: 'RSI (落地反跳指数)',
  lsiPct: '单腿三级跳 LSI', tripleHopLCm: '单腿三级跳 左',
  tripleHopRCm: '单腿三级跳 右', standingTripleJumpCm: '立定三级跳',
  proAgilityS: '5-10-5', t505S: '505 变向', rtMs: '简单视觉反应时',
  painNrs: '晨起疼痛 NRS', run3000S: '3000 m 用时', run12minM: '12 分钟跑',
  restingHr: '静息心率',
};

const UNITS = {
  weightKg: 'kg', squat1RMKg: 'kg', relSquat: '×', standingReachCm: 'cm',
  cmjCm: 'cm', sjCm: 'cm', sscGainCm: 'cm', approachReachCm: 'cm',
  approachGainCm: 'cm', rsi: '', lsiPct: '%', tripleHopLCm: 'cm',
  tripleHopRCm: 'cm', standingTripleJumpCm: 'cm', proAgilityS: 's',
  t505S: 's', rtMs: 'ms', painNrs: '/10', run3000S: 's', run12minM: 'm',
  restingHr: 'bpm',
};

const ORDER = ['weightKg', 'squat1RMKg', 'relSquat', 'standingReachCm', 'cmjCm', 'sjCm',
  'sscGainCm', 'approachReachCm', 'approachGainCm', 'rsi', 'lsiPct',
  'standingTripleJumpCm', 'proAgilityS', 't505S', 'run3000S', 'run12minM',
  'restingHr', 'rtMs', 'painNrs'];

const fmt = (v, unit = '', d = 1) => (v === null || v === undefined || !Number.isFinite(v))
  ? '未填' : `${Number(v.toFixed(d))}${unit ? ' ' + unit : ''}`;

/** 派生指标 + 物理合理性校验（口径填错是最常见的错误，必须拦下来） */
export function computeDerived(p) {
  const d = {}, notes = [], warnings = [];
  const num = (v) => (v === '' || v === null || v === undefined || Number.isNaN(Number(v))) ? null : Number(v);

  d.weightKg = num(p.weightKg);
  d.squat1RMKg = num(p.squat1RMKg);
  if (d.weightKg && d.squat1RMKg) {
    const rel = d.squat1RMKg / d.weightKg;
    if (rel >= 0.3 && rel <= 3.5) d.relSquat = rel;
    else warnings.push(`相对深蹲算出 ${rel.toFixed(2)}× 体重，超出合理范围（0.3~3.5），请检查体重与深蹲。`);
  } else if (d.squat1RMKg && !d.weightKg) {
    notes.push('缺少体重，无法计算相对深蹲——这是判读的第一顺位指标，务必补上。');
  }

  d.standingReachCm = num(p.standingReachCm);
  const cmj = num(p.cmjCm);
  if (cmj !== null) {
    if (cmj >= 10 && cmj <= 120) d.cmjCm = cmj;
    else warnings.push(`CMJ 高度 ${cmj} cm 超出合理范围（10~120），请检查是否把「摸高绝对值」填进了「跳跃高度」。`);
  }
  const sj = num(p.sjCm);
  if (sj !== null) {
    if (sj >= 5 && sj <= 100) d.sjCm = sj;
    else warnings.push(`SJ 高度 ${sj} cm 超出合理范围（5~100）。sj 应填「跳跃高度」，若你量的是下蹲跳摸高，请换算。`);
  }
  if (d.cmjCm && d.sjCm) {
    const ssc = d.cmjCm - d.sjCm;
    if (ssc >= -10 && ssc <= 25) d.sscGainCm = ssc;
    else warnings.push(`SSC 贡献算出 ${ssc.toFixed(1)} cm，超出物理合理范围：CMJ 与 SJ 口径可能不一致，本项已丢弃。`);
  }

  const ar = num(p.approachReachCm);
  if (ar !== null) d.approachReachCm = ar;
  if (ar !== null && num(p.cmjCm) !== null && d.standingReachCm) {
    const cmjAbs = d.standingReachCm + d.cmjCm;
    const gain = ar - cmjAbs;
    if (gain >= -5 && gain <= 40) d.approachGainCm = gain;
    else warnings.push(`助跑增益算出 ${gain.toFixed(1)} cm，超出合理范围。注意：助跑摸高填绝对值，CMJ 填高度，别混。`);
  }

  const rsi = num(p.rsi);
  if (rsi !== null) {
    if (rsi >= 0.2 && rsi <= 5) d.rsi = rsi;
    else warnings.push(`RSI ${rsi} 超出合理范围（0.2~5.0），请检查触地时间单位是否为毫秒。`);
  }

  d.tripleHopLCm = num(p.tripleHopLCm);
  d.tripleHopRCm = num(p.tripleHopRCm);
  if (d.tripleHopLCm && d.tripleHopRCm) {
    const lo = Math.min(d.tripleHopLCm, d.tripleHopRCm), hi = Math.max(d.tripleHopLCm, d.tripleHopRCm);
    const lsi = (lo / hi) * 100;
    if (lsi >= 50) d.lsiPct = lsi;
    else warnings.push(`单腿三级跳 LSI 算出 ${lsi.toFixed(1)}%，超出合理范围，请检查左右是否填反。`);
  } else if (d.tripleHopLCm || d.tripleHopRCm) {
    notes.push('只填了单侧单腿三级跳，无法算不对称。左右都要测——不对称是判读的第一顺位。');
  }

  for (const k of ['standingTripleJumpCm', 'proAgilityS', 't505S', 'rtMs', 'painNrs',
                   'run3000S', 'run12minM', 'restingHr']) {
    d[k] = num(p[k]);
  }
  return { d, notes, warnings };
}

/** 阈值标记。级别 RED / AMBER / INFO / OK */
export function buildFlags(d, targetReachCm = 320) {
  const f = [];
  const push = (lv, t) => f.push({ level: lv, text: t });

  if (d.lsiPct != null) {
    if (d.lsiPct < 85) push('RED', `单腿三级跳 LSI ${d.lsiPct.toFixed(0)}%（<85%）——不对称是首要发现：先做单侧力量与落地控制，暂停高强度双侧增强式。`);
    else if (d.lsiPct < 90) push('AMBER', `单腿三级跳 LSI ${d.lsiPct.toFixed(0)}%（<90%）——需关注左右差，训练加入单侧补偿。`);
    else push('OK', `单腿三级跳 LSI ${d.lsiPct.toFixed(0)}%——左右对称性达标。`);
  }

  if (d.relSquat != null) {
    if (d.relSquat < 1.0) push('RED', `相对深蹲 ${d.relSquat.toFixed(2)}× 体重（<1.0）——力量是主要限制，现阶段增强式必须减量。`);
    else if (d.relSquat < 1.5) push('AMBER', `相对深蹲 ${d.relSquat.toFixed(2)}× 体重（<1.5）——力量尚未打底，优先力量，增强式每周 ≤2 次低量。`);
    else if (d.relSquat < 2.0) push('OK', `相对深蹲 ${d.relSquat.toFixed(2)}× 体重——力量基础良好，可以给增强式上量。`);
    else push('OK', `相对深蹲 ${d.relSquat.toFixed(2)}× 体重——很强，瓶颈多半已不在绝对力量。`);
  }

  if (d.rsi != null) {
    if (d.rsi < 1.0) push('RED', `RSI ${d.rsi.toFixed(2)}（<1.0）——反应力量/肌腱刚度明显不足。`);
    else if (d.rsi < 1.5) push('AMBER', `RSI ${d.rsi.toFixed(2)}（<1.5）——反应力量一般，是当前较划算的提升点。`);
    else push('OK', `RSI ${d.rsi.toFixed(2)}——反应力量良好。`);
  }

  if (d.approachReachCm != null) {
    const gap = targetReachCm - d.approachReachCm;
    if (gap <= 0) push('OK', `助跑摸高 ${fmt(d.approachReachCm, 'cm')} 已达到 ${targetReachCm} cm 目标，缺口闭合。`);
    else {
      const horizon = gap > 30 ? '1–2 年以上的长期项目' : (gap > 10 ? '6–12 个月量级' : '技术优化 + 短周期即可触及');
      push('INFO', `弹跳缺口 ${gap.toFixed(1)} cm（目标 ${targetReachCm} − 当前 ${fmt(d.approachReachCm, 'cm')}）——量级：${horizon}。`);
    }
  } else if (d.standingReachCm && d.cmjCm) {
    const abs = d.standingReachCm + d.cmjCm;
    const gap = targetReachCm - abs;
    push('INFO', `用站立摸高+CMJ 推算原地摸高 ${abs.toFixed(0)} cm，离 ${targetReachCm} cm 缺口 ${gap.toFixed(0)} cm（助跑通常还能多 5–10 cm）。`);
  }

  if (d.approachGainCm != null && d.approachGainCm < 5) {
    push('AMBER', `助跑增益仅 ${d.approachGainCm.toFixed(1)} cm（<5）——助跑节奏与起跳技术没转化出来，技术优先级高。`);
  }
  if (d.sscGainCm != null && d.sscGainCm < 2) {
    push('AMBER', `SSC 贡献仅 ${d.sscGainCm.toFixed(1)} cm（<2）——离心/拉长-缩短循环利用不足。`);
  }
  if (d.painNrs != null) {
    if (d.painNrs > 5) push('RED', `晨起疼痛 NRS ${d.painNrs}/10——停止高强度负荷，建议线下评估。`);
    else if (d.painNrs > 3) push('AMBER', `晨起疼痛 NRS ${d.painNrs}/10——当天减量，观察 48 h。`);
    else push('OK', `晨起疼痛 NRS ${d.painNrs}/10——可正常训练。`);
  }
  if (d.rtMs != null) push('INFO', `简单视觉反应时 ${d.rtMs} ms——只作个人基线，与球场反应关联很弱。`);

  // 有氧：对力量/爆发力项目是有干扰作用的，必须给出排布建议而不是单纯"越多越好"
  if (d.run3000S != null || d.run12minM != null || d.restingHr != null) {
    const bits = [];
    if (d.run3000S != null) bits.push(`3000 m ${Math.floor(d.run3000S / 60)}′${String(Math.round(d.run3000S % 60)).padStart(2, '0')}″`);
    if (d.run12minM != null) bits.push(`12 分钟跑 ${d.run12minM} m`);
    if (d.restingHr != null) bits.push(`静息心率 ${d.restingHr} bpm`);
    push('INFO', `有氧基础：${bits.join('、')}。`);
    push('AMBER', '⚠️ 有氧与力量/爆发力同周期训练存在干扰效应：有氧排在力量之后或另起一天，'
      + '每周控制在 2 次、每次 15–20 分钟，用高强度间歇而不是长距离慢跑。'
      + '为了弹跳去刷长跑，会直接拖慢你要涨的那项。');
    if (d.restingHr != null && d.restingHr > 80) {
      push('AMBER', `静息心率 ${d.restingHr} bpm 偏高，可能反映恢复不足或基础耐力较差，先保证睡眠再谈加量。`);
    }
  }

  return f;
}

const LEVEL_ORDER = { RED: 0, AMBER: 1, INFO: 2, OK: 3 };
export const sortFlags = (flags) => [...flags].sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);

/** 限制因素排序：不对称 → 相对力量 → 弹跳缺口 → 效率 */
export function rankLimiters(d) {
  const out = [];
  if (d.lsiPct != null && d.lsiPct < 90) {
    out.push({ rank: 1, name: '左右不对称',
      evidence: `单腿三级跳 LSI ${d.lsiPct.toFixed(0)}%（左 ${d.tripleHopLCm} / 右 ${d.tripleHopRCm} cm）`,
      impact: '不对称会同时压低双侧表现并抬高受伤风险，处理它比追绝对高度更划算。' });
  }
  if (d.relSquat != null && d.relSquat < 1.5) {
    out.push({ rank: out.length + 1, name: '相对力量不足',
      evidence: `深蹲 ${d.squat1RMKg} kg ÷ 体重 ${d.weightKg} kg = ${d.relSquat.toFixed(2)}×（<1.5）`,
      impact: '绝对力量是弹跳的地板。没打底就上增强式，等于把力气花在关节上。' });
  }
  if (d.rsi != null && d.rsi < 1.5) {
    out.push({ rank: out.length + 1, name: '反应力量 / 肌腱刚度不足',
      evidence: `RSI ${d.rsi.toFixed(2)}（<1.5）`,
      impact: '触地时间长、SSC 利用率低，起跳时"借不到"落地的弹性。' });
  }
  if (d.approachGainCm != null && d.approachGainCm < 5) {
    out.push({ rank: out.length + 1, name: '助跑与起跳技术',
      evidence: `助跑增益仅 ${d.approachGainCm.toFixed(1)} cm（<5）`,
      impact: '助跑动能没转成竖直速度，是纯技术问题，往往几天就能看到改善。' });
  }
  if (d.sscGainCm != null && d.sscGainCm < 2) {
    out.push({ rank: out.length + 1, name: '离心利用不足',
      evidence: `CMJ−SJ = ${d.sscGainCm.toFixed(1)} cm（<2）`,
      impact: '下拉阶段没有被有效利用，等于浪费了反向动作的弹性势能。' });
  }
  return out;
}

/** 处方：单一优先原则 */
export function prescribe(d, goal = 'dunk') {
  // 数据不足时不硬编方案——缺了判读依据就开处方，等于在编。
  const missing = [];
  if (d.relSquat == null) missing.push('体重 + 深蹲 1RM（算相对力量，判读第一优先级）');
  if (d.approachReachCm == null && !(d.standingReachCm && d.cmjCm)) {
    missing.push('站立摸高 + 助跑摸高（算弹跳缺口）');
  }
  if (d.lsiPct == null) missing.push('单腿三级跳左右各一次（算不对称，判读最高优先级）');
  if (missing.length >= 2) {
    return {
      insufficient: true, missing, focus: '数据不足，先补齐评估',
      weekly: [], note: '补齐上面几项才能定位限制因素。在此之前不给训练处方——方向错了练得越多越偏。',
      progression: '', regression: '', retest: '补齐数据后重新生成方案。',
    };
  }

  const plan = { focus: '', weekly: [], progression: '', regression: '', retest: '' };
  const weak = [];

  if (d.lsiPct != null && d.lsiPct < 90) {
    plan.focus = '单侧力量与落地控制（不对称优先）';
    plan.weekly = [
      { day: '周一', items: ['单腿蹲 3×6/侧（RIR 2）', '单腿罗马尼亚硬拉 3×8/侧', '单腿落地控制 3×5/侧'] },
      { day: '周三', items: ['保加利亚分腿蹲 3×8/侧', '侧向弓步 3×8/侧', '低强度跳绳 3×30″'] },
      { day: '周五', items: ['单腿臀桥 3×10/侧', '单腿提踵 3×12/侧', '台阶单腿跳 3×5/侧（低台阶）'] },
    ];
    plan.note = '暂停高强度双侧增强式（跳深、连续深度跳），直到 LSI ≥ 90% 且落地动作可控。';
    weak.push('不对称');
  } else if (d.relSquat != null && d.relSquat < 1.5) {
    plan.focus = '绝对力量打底';
    plan.weekly = [
      { day: '周一', items: ['深蹲 4×5 @ RIR 2', '罗马尼亚硬拉 3×6', '核心 3 组'] },
      { day: '周三', items: ['低量增强式：原地跳 4×5、跳绳 3×30″', '单腿辅助训练 3×8/侧'] },
      { day: '周五', items: ['速度深蹲 5×3 @ 60% 1RM（追求最快速度）', '保加利亚分腿蹲 3×8/侧'] },
    ];
    plan.note = '增强式每周 ≤2 次低量，先把深蹲推到 1.5× 体重。';
    weak.push('相对力量');
  } else if (d.rsi != null && d.rsi < 1.5) {
    plan.focus = '反应力量与肌腱刚度';
    plan.weekly = [
      { day: '周一', items: ['跳深 4×3（30 cm 箱，追求最短触地）', '连续跳 4×5', '深蹲 3×5 @ 80%'] },
      { day: '周三', items: ['快速蹲 5×3 @ 60%（最快速度）', 'Pogo 连续弹跳 4×10', '单腿跳 3×5/侧'] },
      { day: '周五', items: ['助跑摸高 6 次（全部强度，组间充分休息）', '罗马尼亚硬拉 3×6'] },
    ];
    plan.note = '每次跳跃都追求质量而非数量：触地越短越好，累了就停。';
    weak.push('反应力量');
  } else {
    plan.focus = '技术优化 + 爆发力维持';
    plan.weekly = [
      { day: '周一', items: ['深蹲 3×5 @ 85%', '跳深 4×3', '核心'] },
      { day: '周三', items: ['助跑起跳技术 8–10 次（录像复盘）', '速度深蹲 5×3 @ 60%'] },
      { day: '周五', items: ['全场助跑摸高 8 次全部强度', '单腿力量辅助 3×8/侧'] },
    ];
    plan.note = '力量已达标，重点转到助跑节奏、倒数第二步与摆臂时机。';
    weak.push('技术');
  }

  if (d.approachGainCm != null && d.approachGainCm < 5) {
    plan.techNote = '助跑增益偏低：专门练助跑节奏——倒数第二步要长、重心下沉制动、摆臂在离地前最后一刻向上加速。建议每两周拍一次侧面慢动作。';
  }
  plan.aerobicNote = '若有氧训练在同一时期：排在力量/增强式之后，或另起一天；每周 2 次、每次 15–20 分钟高强度间歇，别用长距离慢跑。';
  plan.progression = '连续 2 周所有组次达标，且次日晨起疼痛 ≤2/10 → 加 2.5–5 kg 或加一组。';
  plan.regression = '疼痛 >3/10 或 RSI 下降 >10% → 容量减半，先做技术日。';
  plan.retest = '4 周后重测：CMJ、单腿三级跳（左右都测）、5-10-5；每 8 周重测深蹲与助跑摸高。';
  return plan;
}

export function renderMarkdown(d, flags, limiters, plan, profile = {}) {
  const L = [];
  L.push('# 运动能力评估与训练方案', '');
  if (profile.name) L.push(`- 对象：${profile.name}`);
  L.push(`- 生成日期：${new Date().toISOString().slice(0, 10)}`);
  L.push('');

  L.push('## 1. 概览', '');
  L.push('| 指标 | 数值 |');
  L.push('|---|---|');
  for (const k of ORDER) {
    if (d[k] !== null && d[k] !== undefined && Number.isFinite(d[k])) {
      L.push(`| ${LABELS[k]} | ${fmt(d[k], UNITS[k] ?? '')} |`);
    }
  }
  const aerobic = [];
  if (d.run3000S != null) aerobic.push(`3000 m ${Math.floor(d.run3000S / 60)}′${String(Math.round(d.run3000S % 60)).padStart(2, '0')}″`);
  if (d.run12minM != null) aerobic.push(`12 分钟跑 ${d.run12minM} m`);
  if (aerobic.length) L.push(`| 有氧 | ${aerobic.join('、')} |`);
  const tj = d.standingTripleJumpCm != null ? `${d.standingTripleJumpCm} cm` : null;
  if (tj) L.push(`| 立定三级跳 | ${tj} |`);
  L.push('');

  L.push('## 2. 判读与标记', '');
  for (const f of sortFlags(flags)) {
    const icon = { RED: '🔴', AMBER: '🟠', INFO: 'ℹ️', OK: '✅' }[f.level];
    L.push(`- ${icon} ${f.text}`);
  }
  L.push('');

  L.push('## 3. 限制因素排序', '');
  if (limiters.length === 0) {
    L.push('未发现达到阈值的限制因素。若仍有提升需求，优先优化助跑与起跳技术。');
  } else {
    for (const l of limiters) {
      L.push(`**${l.rank}. ${l.name}**`);
      L.push(`- 证据：${l.evidence}`);
      L.push(`- 影响：${l.impact}`);
      L.push('');
    }
    L.push('> 先修最上游的一项，不要同时开三张处方。');
  }
  L.push('');

  L.push('## 4. 训练方案', '');
  L.push(`**主攻方向：${plan.focus}**`);
  L.push('');
  if (plan.insufficient) {
    L.push('当前数据不足以定位限制因素，需要先补：', '');
    for (const m of plan.missing) L.push(`- [ ] ${m}`);
    L.push('');
    if (plan.note) L.push(`> ${plan.note}`, '');
    L.push(`- **复查**：${plan.retest}`);
    L.push('');
    L.push('---', '');
    L.push('> ⚠️ 本评估为运动能力测试与训练建议，**不是医学诊断**，不能替代临床检查。');
    return L.join('\n');
  }
  L.push('| 日 | 内容 |');
  L.push('|---|---|');
  for (const w of plan.weekly) L.push(`| ${w.day} | ${w.items.join('<br>')} |`);
  L.push('');
  if (plan.note) L.push(`> ${plan.note}`, '');
  if (plan.techNote) L.push(`> ${plan.techNote}`, '');
  if (plan.aerobicNote) L.push(`> ${plan.aerobicNote}`, '');
  L.push(`- **进阶条件**：${plan.progression}`);
  L.push(`- **退阶条件**：${plan.regression}`);
  L.push(`- **复查**：${plan.retest}`);
  L.push('');
  L.push('---', '');
  L.push('> ⚠️ 本评估为运动能力测试与训练建议，**不是医学诊断**，不能替代临床检查。');
  L.push('> 参考区间为经验值，存在个体差异。出现静息痛、夜间痛、肿胀、交锁、打软腿或神经症状，请立即停止并线下就诊。');
  return L.join('\n');
}
