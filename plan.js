/**
 * 方案引擎 v2：身体资料 + 视频指标 + 有氧/耐力 + 三级跳 + 疼痛 → 评估与训练方案。
 *
 * v2 相对 v1 的改动（全部依据检索到的文献，见文件末尾 REFERENCES）：
 *  1. 疼痛：从单一 NRS 改为结构化评估（部位/静息/活动/次晨/时间模式/病程/红旗），
 *     并输出绿-黄-红-转诊四级决策与对应处理措施。
 *  2. 耐力：从"只警告干扰"改为给出真正的耐力处方（有氧基础 + HIIT/SIT/RSA）。
 *  3. 修正 v1 的过度断言：
 *     - "深蹲 <1.5×BW 就不该练增强式" → 该阈值无 meta 支持，改为经验性提示。
 *     - "有氧严重干扰爆发力" → 干扰效应比早期认为的小得多（力量 −0.06 ns，爆发力 −0.28），
 *       且主要在训练水平高者身上；业余爱好者预期很小。
 *     - "等长收缩镇痛" → 早期结论已被后续交叉试验推翻。
 *  4. 新增复合训练（complex training）——目前弹跳证据最强的手段。
 *  5. 每条建议标注证据强度：强 / 中 / 弱 / 经验性。
 */

export const REBOUND_MAX_CONTACT_MS = 400;

/** 证据强度标签 */
export const EV = {
  STRONG: '强证据',
  MODERATE: '中等证据',
  WEAK: '弱证据',
  EMPIRICAL: '经验性',
};

const LABELS = {
  weightKg: '体重', squat1RMKg: '深蹲 1RM', relSquat: '相对深蹲 (×体重)',
  standingReachCm: '站立摸高', cmjCm: 'CMJ 高度', sjCm: 'SJ 高度',
  sscGainCm: 'SSC 贡献 (CMJ−SJ)', approachReachCm: '助跑摸高',
  approachGainCm: '助跑增益', rsi: 'RSI (落地反跳指数)',
  lsiPct: '单腿三级跳 LSI', tripleHopLCm: '单腿三级跳 左',
  tripleHopRCm: '单腿三级跳 右', standingTripleJumpCm: '立定三级跳',
  proAgilityS: '5-10-5', t505S: '505 变向', rtMs: '简单视觉反应时',
  run3000S: '3000 m 用时', run12minM: '12 分钟跑', yoyoIr1M: 'Yo-Yo IR1',
  sprint30mS: '30 m 冲刺', restingHr: '静息心率', ankleDfDeg: '踝背屈',
  painRest: '静息疼痛 NRS', painActivity: '活动中疼痛 NRS',
  painNextMorning: '次日晨起疼痛 NRS', painWeeks: '症状持续',
};

const UNITS = {
  weightKg: 'kg', squat1RMKg: 'kg', relSquat: '×', standingReachCm: 'cm',
  cmjCm: 'cm', sjCm: 'cm', sscGainCm: 'cm', approachReachCm: 'cm',
  approachGainCm: 'cm', rsi: '', lsiPct: '%', tripleHopLCm: 'cm',
  tripleHopRCm: 'cm', standingTripleJumpCm: 'cm', proAgilityS: 's',
  t505S: 's', rtMs: 'ms', run3000S: 's', run12minM: 'm', yoyoIr1M: 'm',
  sprint30mS: 's', restingHr: 'bpm', ankleDfDeg: '°', painRest: '/10',
  painActivity: '/10', painNextMorning: '/10', painWeeks: '周',
};

const ORDER = ['weightKg', 'squat1RMKg', 'relSquat', 'standingReachCm', 'cmjCm', 'sjCm',
  'sscGainCm', 'approachReachCm', 'approachGainCm', 'rsi', 'lsiPct',
  'standingTripleJumpCm', 'proAgilityS', 't505S', 'sprint30mS',
  'run3000S', 'run12minM', 'yoyoIr1M', 'restingHr', 'ankleDfDeg', 'rtMs'];

export const PAIN_SITES = [
  { id: 'none', label: '无疼痛' },
  { id: 'patellar', label: '膝前 / 髌腱（跳跃膝）' },
  { id: 'achilles', label: '跟腱' },
  { id: 'plantar', label: '足底 / 足跟' },
  { id: 'ankle', label: '踝关节' },
  { id: 'shin', label: '小腿 / 胫骨' },
  { id: 'kneeOther', label: '膝其他位置' },
  { id: 'lowback', label: '腰部' },
  { id: 'shoulder', label: '肩' },
  { id: 'other', label: '其他' },
];

export const PAIN_PATTERNS = [
  { id: 'warmup', label: '活动初期痛，热身后减轻' },
  { id: 'during', label: '活动中持续痛' },
  { id: 'after', label: '活动后才出现' },
  { id: 'nextday', label: '主要是次日痛' },
  { id: 'progressive', label: '进行性加重（出现得越来越早 / 越来越重）' },
  { id: 'constant', label: '持续痛，与活动关系不明显' },
];

export const RED_FLAGS = [
  { id: 'night', label: '夜间痛或静息持续痛' },
  { id: 'weightbear', label: '无法负重 / 无法正常走路' },
  { id: 'swelling', label: '明显肿胀或关节积液' },
  { id: 'locking', label: '关节交锁或反复打软腿' },
  { id: 'trauma', label: '外伤后突发伸膝障碍 / 腱连续性可疑' },
  { id: 'systemic', label: '发热、全身症状、不明原因体重下降' },
  { id: 'cancer', label: '肿瘤病史' },
];

const fmt = (v, unit = '', d = 1) => (v === null || v === undefined || !Number.isFinite(v))
  ? '未填' : `${Number(v.toFixed(d))}${unit ? ' ' + unit : ''}`;

const ev = (tag) => `【${tag}】`;

/* ------------------------------------------------------------------ */
/* 派生与校验                                                          */
/* ------------------------------------------------------------------ */

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
    notes.push('缺少体重，无法计算相对深蹲。');
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
  if (ar !== null && d.cmjCm !== null && d.standingReachCm) {
    const gain = ar - (d.standingReachCm + d.cmjCm);
    if (gain >= -5 && gain <= 40) d.approachGainCm = gain;
    else warnings.push(`助跑增益算出 ${gain.toFixed(1)} cm，超出合理范围。注意：助跑摸高填绝对值，CMJ 填高度。`);
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
    notes.push('只填了单侧单腿三级跳，无法算不对称。左右都要测。');
  }

  for (const k of ['standingTripleJumpCm', 'proAgilityS', 't505S', 'rtMs',
                   'run3000S', 'run12minM', 'yoyoIr1M', 'sprint30mS', 'restingHr', 'ankleDfDeg',
                   'painRest', 'painActivity', 'painNextMorning', 'painWeeks']) {
    d[k] = num(p[k]);
  }
  d.painSite = p.painSite && p.painSite !== 'none' ? p.painSite : null;
  d.painPattern = p.painPattern || null;
  d.redFlags = Array.isArray(p.redFlags) ? p.redFlags.filter(Boolean) : [];
  d.trainingDays = num(p.trainingDays) || 5;

  // 踝背屈不足是已报道的髌腱病风险因素之一
  if (d.ankleDfDeg != null && d.ankleDfDeg < 36.5) {
    notes.push(`踝背屈 ${d.ankleDfDeg}° 低于 36.5°。有前瞻研究报道该阈值与青少年精英篮球运动员髌腱病风险升高相关，`
      + '限制踝背屈会改变落地与起跳的下肢力学，值得单独处理（活动度 + 小腿柔韧性）。');
  }
  return { d, notes, warnings };
}

/* ------------------------------------------------------------------ */
/* 疼痛评估：绿 / 黄 / 红 / 转诊                                        */
/* ------------------------------------------------------------------ */

/**
 * 疼痛决策树。
 * 证据状态（务必如实呈现）：这是把指南与既有模型转写成可执行规则，
 * 其中 5/10 阈值来自 Silbernagel 模型但**该模型从未在 RCT 中被正式检验**，
 * 且 2025 年交叉试验显示负荷高低与运动中疼痛无必然关系。
 * 因此本函数输出的是"谨慎的负荷管理启发式"，不是诊断，也不是硬阈值。
 */
export function assessPain(d) {
  const out = {
    hasPain: false, level: null, reasons: [], actions: [],
    tendonProgram: null, evidence: EV.WEAK, caveat: null,
  };

  if (d.redFlags && d.redFlags.length) {
    out.hasPain = true;
    out.level = 'refer';
    const labels = d.redFlags.map((id) => (RED_FLAGS.find((r) => r.id === id) || {}).label || id);
    out.reasons.push('存在需立即线下评估的信号：' + labels.join('；'));
    out.actions.push('停止评估与训练处方，尽快线下就诊（运动医学 / 骨科 / 康复医学科）。');
    out.actions.push('就诊前避免一切诱发症状的负荷，尤其是跳跃与落地。');
    out.evidence = EV.MODERATE;
    out.caveat = '红旗清单属各指南的共识性内容，但 2025 年综述指出 MSK 红旗定义在各指南间并不一致，缺乏标准化。';
    return out;
  }

  const rest = d.painRest, act = d.painActivity, next = d.painNextMorning;
  if (rest == null && act == null && next == null) return out;

  out.hasPain = true;
  const base = rest == null ? 0 : rest;
  const delta = next == null ? null : next - base;
  const progressive = d.painPattern === 'progressive' || d.painPattern === 'constant';

  out.reasons.push(`静息 ${fmt(rest, '/10', 0)}、活动中 ${fmt(act, '/10', 0)}、次日晨起 ${fmt(next, '/10', 0)}`);
  if (d.painPattern) {
    const pl = (PAIN_PATTERNS.find((x) => x.id === d.painPattern) || {}).label || d.painPattern;
    out.reasons.push('时间模式：' + pl);
  }
  if (d.painWeeks != null) out.reasons.push(`病程 ${d.painWeeks} 周`);
  if (delta != null) out.reasons.push(`次晨较静息变化 ${delta >= 0 ? '+' : ''}${delta} 分`);

  if ((act != null && act >= 6) || (delta != null && delta >= 2) || progressive) {
    out.level = 'red';
    out.actions.push('停掉挑衅性负荷（大强度跳跃、落地反跳、冲刺、大重量深蹲），但**不要完全停训**——相对休息而非绝对休息。');
    out.actions.push('保留无痛活动：上肢/核心训练、低强度有氧（骑车或游泳）、等长或慢速低挑衅的下肢练习。');
    out.actions.push('每天记录静息/活动/次晨三个 NRS；连续 3 天次晨回到基线后再按黄色档逐步恢复。');
  } else if ((act != null && act >= 4) || (delta != null && delta > 0)) {
    out.level = 'yellow';
    out.actions.push('总容量下调 20–30%，去掉落地反跳（DJ）与最大强度助跑起跳，保留低量 CMJ 与技术练习。');
    out.actions.push('把挑衅性动作替换为慢速重负荷或等长版本（见下方肌腱方案）。');
    out.actions.push('观察 48–72 h：次晨回到基线即可按 10–20% 阶梯加回；继续升高则降级到红色。');
  } else {
    out.level = 'green';
    out.actions.push('可正常训练。按每周 10–20% 的阶梯增加跳跃量，而不是一次加满。');
    out.actions.push('继续记录三个 NRS；次晨持续高于静息 1 分以上就按黄色处理。');
  }

  // 肌腱方案：膝前/髌腱、跟腱、足底这三类对渐进性肌腱负荷反应模式接近
  const tendonSites = ['patellar', 'achilles', 'plantar'];
  if (d.painSite && tendonSites.includes(d.painSite) && out.level !== 'green') {
    out.tendonProgram = {
      name: '渐进性肌腱负荷（heavy slow resistance 起步，向 PTLE 过渡）',
      evidence: EV.MODERATE,
      why: '在髌腱病中，渐进性肌腱负荷（PTLE）优于离心训练（24 周 VISA-P +28 vs +18，组间差 9，95%CI 1–16，p=0.023）。',
      dose: [
        '动作：深蹲 / 腿举 / 单腿蹲，选一个不加重症状的',
        '组数：每个动作 4 组',
        '强度阶梯：第 1 周 15RM → 12RM → 10RM → 8RM → 第 9–12 周 6RM',
        '节奏：离心 3 秒 + 向心 3 秒（慢速是关键变量）',
        '组间休息：2–3 分钟',
        '频率：每周 3 次，共 12 周',
      ],
      notes: [
        '这个剂量来自 Kongsgaard 2009 的 HSR 方案；半年满意度 73% vs 离心 22%。',
        '指南建议练习中疼痛控制在 ≤3/10；超过就降负荷或用等长替代。',
        '⚠️ 等长收缩「镇痛优于其他形式」这一说法**已被后续随机交叉试验推翻**（等长与动态阻力在即刻与 45 分钟疼痛上无差异），'
          + '荷兰指南也明确等长「不必作为标准治疗」。可以用，但别当特效手段。',
        '⚠️ Spanish squat 没有 RCT 比较证据（仅见电刺激叠加的病例系列），不写入作为证据做法。',
        '⚠️ 整体证据确定性低：Cochrane 2025（7 RCT / 211 人）给出的确定性为低，2026 网络 meta 仍未发现任何干预具统计学优势。'
          + '所以要按反应调整，而不是照搬。',
      ],
    };
  }

  if (d.painWeeks != null && d.painWeeks >= 12 && out.level !== 'green') {
    out.actions.push('症状已持续 ≥12 周：若 12 周结构化负荷训练后仍无临床相关改善（VISA-P 改善 <13 分），'
      + '应转诊考虑附加干预。影像学对髌腱病的附加价值有限，不必以超声结果决定处置。');
  }

  out.caveat = '「活动中 ≤5/10、次晨回到基线」这一阈值来自 Silbernagel 疼痛监测模型（2007，跟腱病），'
    + '但该模型在髌腱病人群中**从未被正式 RCT 检验**（唯一的直接研究是 n=15 的可行性 pilot），'
    + '且 2025 年交叉试验显示 6RM/10RM/14RM 的负荷高低与运动中疼痛无必然关系。'
    + '所以请把它当作**谨慎的启发式**，不是硬门槛，也不是诊断标准。';
  return out;
}

/* ------------------------------------------------------------------ */
/* 耐力训练处方                                                        */
/* ------------------------------------------------------------------ */

export function buildEndurancePlan(d) {
  const has = d.run3000S != null || d.run12minM != null || d.yoyoIr1M != null || d.restingHr != null;
  const plan = { measured: has, level: null, sessions: [], rules: [], evidence: EV.MODERATE, missing: [] };

  if (!has) {
    plan.missing.push('Yo-Yo IR1 距离（篮球最相关）或 12 分钟跑距离');
    plan.missing.push('静息心率');
    plan.missing.push('30 m 冲刺成绩（可选，用来追踪 RSA 相关能力）');
    plan.level = 'unknown';
    return plan;
  }

  // 只作粗略定位，刻意不设"达标线"——现有证据不足以给出篮球人群的硬性门槛
  if (d.yoyoIr1M != null) {
    plan.level = d.yoyoIr1M < 1200 ? '偏低' : (d.yoyoIr1M < 1800 ? '一般' : '良好');
  } else if (d.run12minM != null) {
    plan.level = d.run12minM < 2400 ? '偏低' : (d.run12minM < 2800 ? '一般' : '良好');
  } else if (d.restingHr != null) {
    plan.level = d.restingHr > 80 ? '可能偏低' : '无法判断';
  }

  plan.sessions = [
    {
      name: '冲刺间歇（SIT）—— 与力量/爆发力干扰最小',
      dose: '6–10 × 20–30 m，全力，组间走回完全恢复（约 60–90 秒）',
      freq: '每周 1–2 次',
      why: '2026 年 meta（9 研究 / 177 人）显示冲刺间歇对力量、跳跃、冲刺成绩均无损害，同时 VO₂max +0.78。',
      evidence: EV.MODERATE,
    },
    {
      name: '高强度间歇（HIIT）',
      dose: '4 × 4 分钟（约 90% 最大心率），组间 3 分钟慢跑；或 30 秒快 / 30 秒慢 × 12–16 组',
      freq: '每周 1 次',
      why: 'HIIT 跑 + 力量训练在下肢力量与肥大上的干扰最小（40 研究 meta）。',
      evidence: EV.MODERATE,
    },
    {
      name: '篮球实战 / 小场对抗（SSG）',
      dose: '3 × 4 分钟 3v3 或 4v4，或半场全场来回',
      freq: '每周 1–2 次',
      why: 'SSG 本身就是反复冲刺（RSA）与间歇有氧的有效刺激，且是专项动作模式，性价比最高。',
      evidence: EV.MODERATE,
    },
  ];

  plan.rules = [
    { t: '同一天永远先做爆发力/力量，后做耐力。若必须同一天，两者间隔 ≥6 小时可基本消除顺序影响。', e: EV.MODERATE },
    { t: '不要在力量课前做 HIIT——已有研究报告这样做会降低随后的 CMJ 表现。', e: EV.WEAK },
    { t: '耐力总量控制在每周 2–3 次；避免长距离持续慢跑替代上述间歇形式。', e: EV.MODERATE },
    { t: '跑步形式的耐力比骑行对下肢的干扰更需要注意，但 HIIT 跑在下肢力量上的干扰反而是最小的一档。', e: EV.WEAK },
    { t: '每 4–6 周安排一周降量（容量减 40–60%，强度保留）。', e: EV.EMPIRICAL },
  ];

  plan.caveat = '干扰效应确实存在，但比早期研究认为的小得多：最大力量 SMD −0.06（不显著）、肥大 −0.01（不显著）、'
    + '爆发力 −0.28（显著）。而且效应主要出现在训练水平高的人群；业余爱好者预期干扰很小（未训练者 +0.03，不显著）。'
    + '结论：**为了弹跳，有氧应当被纳入而不是被限制**，但优先级最低、走低容量 + 间歇式 + 不与力量同段的路线。';
  plan.uncertain = '「有氧能加快高强度间歇之间的恢复」这一说法只有叙述性综述级别的证据；'
    + '「有氧能力决定 RSA」的证据是矛盾的（高有氧适能者心率恢复更快，但 RSA 与低有氧者无差异）。'
    + '所以不要用"提升有氧"来承诺球场上的反复冲刺表现。';
  return plan;
}

/* ------------------------------------------------------------------ */
/* 阈值标记                                                            */
/* ------------------------------------------------------------------ */

export function buildFlags(d, targetReachCm = 320) {
  const f = [];
  const push = (lv, t, e) => f.push({ level: lv, text: t, evidence: e || null });

  if (d.lsiPct != null) {
    if (d.lsiPct < 85) push('RED', `单腿三级跳 LSI ${d.lsiPct.toFixed(0)}%（<85%）——不对称是首要发现：先做单侧力量与落地控制，暂停高强度双侧增强式。`, EV.MODERATE);
    else if (d.lsiPct < 90) push('AMBER', `单腿三级跳 LSI ${d.lsiPct.toFixed(0)}%（<90%）——需关注左右差，训练加入单侧补偿。`, EV.MODERATE);
    else push('OK', `单腿三级跳 LSI ${d.lsiPct.toFixed(0)}%——左右对称性达标。`, EV.MODERATE);
  }

  if (d.relSquat != null) {
    if (d.relSquat < 1.0) push('AMBER', `相对深蹲 ${d.relSquat.toFixed(2)}× 体重——偏弱。力量是弹跳的基础，但请注意：`
      + `「达到某个倍数才能开始增强式」这一说法**没有 meta 分析支持**，它只是教练经验。先把增强式控制在低量、高质量即可。`, EV.EMPIRICAL);
    else if (d.relSquat < 1.5) push('INFO', `相对深蹲 ${d.relSquat.toFixed(2)}× 体重——处于一般水平。可正常安排增强式（低量起步），`
      + `同时推进力量。1.5× 这个门槛属经验值，不是证据阈值。`, EV.EMPIRICAL);
    else push('OK', `相对深蹲 ${d.relSquat.toFixed(2)}× 体重——力量基础良好。`, EV.EMPIRICAL);
  }

  if (d.rsi != null) {
    if (d.rsi < 1.0) push('AMBER', `RSI ${d.rsi.toFixed(2)}（<1.0）——反应力量/肌腱刚度偏低，优先低量高质量的落地反跳与连续跳。`, EV.MODERATE);
    else if (d.rsi < 1.5) push('INFO', `RSI ${d.rsi.toFixed(2)}（<1.5）——反应力量一般，是当前较划算的提升点。`, EV.MODERATE);
    else push('OK', `RSI ${d.rsi.toFixed(2)}——反应力量良好。`, EV.MODERATE);
  }

  if (d.approachReachCm != null) {
    const gap = targetReachCm - d.approachReachCm;
    if (gap <= 0) push('OK', `助跑摸高 ${fmt(d.approachReachCm, 'cm')} 已达到 ${targetReachCm} cm 目标。`, null);
    else {
      const horizon = gap > 30 ? '1–2 年以上的长期项目' : (gap > 10 ? '6–12 个月量级' : '技术优化 + 短周期即可触及');
      push('INFO', `弹跳缺口 ${gap.toFixed(1)} cm（目标 ${targetReachCm} − 当前 ${fmt(d.approachReachCm, 'cm')}）——量级：${horizon}。`, EV.EMPIRICAL);
    }
  } else if (d.standingReachCm && d.cmjCm) {
    const abs = d.standingReachCm + d.cmjCm;
    push('INFO', `用站立摸高 + CMJ 推算原地摸高 ${abs.toFixed(0)} cm，离 ${targetReachCm} cm 缺口 ${(targetReachCm - abs).toFixed(0)} cm（助跑通常还能多 5–10 cm）。`, EV.EMPIRICAL);
  }

  if (d.approachGainCm != null && d.approachGainCm < 5) {
    push('AMBER', `助跑增益仅 ${d.approachGainCm.toFixed(1)} cm（<5）——助跑节奏与起跳技术没转化出来，技术优先级高。`
      + `注意：篮球助跑起跳的 penultimate step 目前**没有干预性研究**，建议来自跳远/跳高的描述性生物力学。`, EV.WEAK);
  }
  if (d.sscGainCm != null && d.sscGainCm < 2) {
    push('AMBER', `SSC 贡献仅 ${d.sscGainCm.toFixed(1)} cm（<2）——离心/拉长-缩短循环利用不足。`, EV.WEAK);
  }
  if (d.rtMs != null) push('INFO', `简单视觉反应时 ${d.rtMs} ms——只作个人基线，与球场反应关联很弱。`, EV.WEAK);

  // 跳跃运动员髌腱问题高发，主动提示
  if (d.painSite == null) {
    push('INFO', '未报告疼痛。仍需留意：跳跃运动员髌腱病（jumper\'s knee）总体患病率约 18.3%，**篮球约 20.8%**；'
      + '大学男篮中 21.1% 符合髌腱病标准、33.7% 至少一侧超声异常。超声异常与症状往往不相关，'
      + '所以别靠影像判断，靠症状与负荷反应。', EV.MODERATE);
  }
  return f;
}

const LEVEL_ORDER = { RED: 0, AMBER: 1, INFO: 2, OK: 3 };
export const sortFlags = (flags) => [...flags].sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);

/** 限制因素排序：不对称 → 疼痛 → 力量/反应力量 → 缺口 → 技术 */
export function rankLimiters(d, pain) {
  const out = [];
  if (pain && (pain.level === 'red' || pain.level === 'refer')) {
    out.push({ rank: 0, name: '疼痛 / 负荷不耐受（压倒一切）',
      evidence: pain.reasons.join('；'),
      impact: '在有症状的情况下继续堆量，会把可管理的负荷问题变成慢性问题。先解决耐受性再谈能力提升。' });
  }
  if (d.lsiPct != null && d.lsiPct < 90) {
    out.push({ rank: out.length + 1, name: '左右不对称',
      evidence: `单腿三级跳 LSI ${d.lsiPct.toFixed(0)}%（左 ${d.tripleHopLCm} / 右 ${d.tripleHopRCm} cm）`,
      impact: '不对称会同时压低双侧表现并抬高受伤风险。注意：单侧训练能改善单腿表现与变向，但不会让双侧跳跃超过双侧方案。' });
  }
  if (d.relSquat != null && d.relSquat < 1.5) {
    out.push({ rank: out.length + 1, name: '相对力量偏低',
      evidence: `深蹲 ${d.squat1RMKg} kg ÷ 体重 ${d.weightKg} kg = ${d.relSquat.toFixed(2)}×`,
      impact: '力量是弹跳的地板。但这是排序依据，不是"达标才能练增强式"的门槛——后者无证据支持。' });
  }
  if (d.rsi != null && d.rsi < 1.5) {
    out.push({ rank: out.length + 1, name: '反应力量 / 肌腱刚度不足',
      evidence: `RSI ${d.rsi.toFixed(2)}（<1.5）`,
      impact: '触地时间长、SSC 利用率低，起跳时借不到落地的弹性。复合训练与落地反跳是针对性手段。' });
  }
  if (d.approachGainCm != null && d.approachGainCm < 5) {
    out.push({ rank: out.length + 1, name: '助跑与起跳技术',
      evidence: `助跑增益仅 ${d.approachGainCm.toFixed(1)} cm（<5）`,
      impact: '助跑动能没转成竖直速度。证据级别弱（无篮球专项干预研究），但成本低、风险低，值得做。' });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 主处方                                                              */
/* ------------------------------------------------------------------ */

export function prescribe(d, pain, endurance, goal = 'dunk') {
  const missing = [];
  if (d.relSquat == null) missing.push('体重 + 深蹲 1RM');
  if (d.approachReachCm == null && !(d.standingReachCm && d.cmjCm)) missing.push('站立摸高 + 助跑摸高');
  if (d.lsiPct == null) missing.push('单腿三级跳左右各一次');
  if (missing.length >= 2) {
    return { insufficient: true, missing, focus: '数据不足，先补齐评估', weekly: [], blocks: [],
      note: '补齐上面几项才能定位限制因素。在此之前不给训练处方——方向错了练得越多越偏。', retest: '补齐后重新生成。' };
  }

  const red = pain && (pain.level === 'red' || pain.level === 'refer');
  const yellow = pain && pain.level === 'yellow';
  const deload = red || yellow;

  const plan = { focus: '', weekly: [], blocks: [], keyBlocks: [], note: '', retest: '', evidence: EV.MODERATE };

  // ---- 核心训练块（按证据强度排序）----
  plan.keyBlocks.push({
    name: '复合训练（complex training）—— 目前弹跳证据最强的手段',
    evidence: EV.STRONG,
    why: '网络 meta（34 研究 / 1057 人）：只有复合训练显著优于单纯力量训练，CMJ +2.5 cm、20 m −0.10 s；'
      + '另一项 meta 报告复合训练对 CMJ +5.0 cm，优于单纯力量（+2.6）与单纯增强式（+2.9）。',
    dose: [
      '重负荷组：深蹲 3–4 次（约 85–90% 1RM）',
      '休息 4–6 分钟（这一步不能省，否则变成代谢疲劳）',
      '爆发组：CMJ 或箱跳 3–5 次',
      '2–4 组；每周 2 次；持续 ≥8 周（>7.5 周效果更好）',
    ],
    caution: red ? '⚠️ 当前疼痛等级下暂停这一块，等回到绿色档再引入。' : '',
  });

  plan.keyBlocks.push({
    name: '力量基础',
    evidence: EV.MODERATE,
    why: '力量是所有跳跃方案的地板。深蹲 1.5×BW 不是证据阈值，但相对力量越高，弹跳的天花板越高。',
    dose: [
      '深蹲 / 六角杠硬拉 3–5 组 × 3–5 次，RPE 7–8',
      '单腿蹲 / 单腿罗马尼亚硬拉 2–3 组 × 6–8 次/侧',
      '每周 2 次，与大强度跳跃日错开',
    ],
    caution: '',
  });

  plan.keyBlocks.push({
    name: '增强式训练',
    evidence: EV.STRONG,
    why: 'de Villarreal 2009（56 研究）：>10 周、>20 次课、单次 >50 次落地收益最大；SJ + CMJ + DJ 组合优于单一动作。'
      + '负重增强式未显示额外收益。篮球运动员单独增强式：CMJ g=0.77、SJ g=0.86。',
    dose: [
      '单次落地 60–80 次起步，每周递增 10–20%，上限约 120–140 次',
      '动作：CMJ、pogo、跳箱、落地反跳（从 30 cm 起）',
      '落地反跳高度按蹲跳高度（SJH）定：bounce DJ 用 75–100% SJH，countermovement DJ 用 100–125% SJH 时 RSI 最优',
      '每周 2–3 次，两次之间 ≥48 h',
      '单次落地 212 次即出现急性外周疲劳——别一次加太猛',
    ],
    caution: red ? '⚠️ 疼痛红灯期只保留低强度技术性跳跃（≤2/10 疼痛），去掉落地反跳与最大强度助跑。'
      : (yellow ? '⚠️ 黄灯期去掉落地反跳与最大强度助跑起跳，保留低量 CMJ 与技术练习。' : ''),
  });

  plan.keyBlocks.push({
    name: '单侧训练',
    evidence: EV.MODERATE,
    why: '单侧 vs 双侧增强式（11 研究 / 388 人）：双侧跳、冲刺、变向无差异，但单腿 CMJ 与单腿变向单侧更优；'
      + '篮球亚组中单侧训练在冲刺与变向上更有利。',
    dose: [
      '单腿跳、单腿落地控制、低箱单腿落地反跳',
      '每周 1–2 次，补充到双侧方案里（不是替代）',
    ],
    caution: '',
  });

  plan.keyBlocks.push({
    name: '助跑与起跳技术',
    evidence: EV.WEAK,
    why: '篮球助跑 penultimate step 目前没有干预性研究，证据来自跳远/跳高的描述性生物力学。但成本低、风险低。',
    dose: ['3–5 步助跑 × 8–10 次，全强度，组间充分休息', '要点：倒数第二步长、末步短快，摆臂在离地前最后加速', '每周 2 次，拍侧面慢动作复盘'],
    caution: red ? '⚠️ 疼痛红灯期改为原地技术练习或不练。' : '',
  });

  // ---- 每周排布 ----
  const days = Math.max(3, Math.min(7, d.trainingDays || 5));
  const W = [];
  W.push({ day: 'D1', items: ['复合训练（重蹲 → 休息 4–6 min → CMJ/箱跳）', '力量：深蹲 3–5×3–5', '低量增强式 60–80 次落地'] });
  W.push({ day: 'D2', items: ['敏捷：5-10-5 / 505 / 变向', '冲刺间歇 SIT 6–10×20–30 m', '单侧力量 2–3×6–8/侧'] });
  W.push({ day: 'D3', items: ['上肢 + 核心', '有氧：20–30 min 低强度（LISS，骑车或慢跑）'] });
  W.push({ day: 'D4', items: ['篮球实战 / 小场对抗 SSG（同时满足 RSA 与间歇有氧）', '短冲刺 ≤10 s × 6–8'] });
  W.push({ day: 'D5', items: ['低量增强式 + 助跑技术 8–10 次', 'HIIT 4×4 min（放在最后，不与力量同段）'] });
  if (days >= 6) W.push({ day: 'D6', items: ['单侧训练 + 落地控制', '可选：20 min 低强度有氧'] });
  if (days >= 7) W.push({ day: 'D7', items: ['完全休息 或 轻度活动', '记录晨起疼痛与静息心率'] });

  plan.weekly = W;
  plan.focus = red ? '先解决疼痛耐受性（暂停高强度跳跃）'
    : (d.lsiPct != null && d.lsiPct < 90 ? '单侧力量与落地控制（不对称优先）'
      : (d.rsi != null && d.rsi < 1.5 ? '复合训练 + 反应力量' : '复合训练 + 技术优化'));

  plan.note = '复合训练是目前唯一在 meta 层面显著优于单纯力量训练的弹跳手段，应当成为主项。';
  plan.deloadNote = '每 4–6 周安排一周降量：容量减 40–60%，强度保留 80–90%（不要全停）。';
  plan.progression = '连续 2 周所有组次达标且次日晨起疼痛回到基线 → 跳跃量 +10–20%，或加 2.5–5 kg。';
  plan.regression = '次晨疼痛比静息高 1 分以上，或 RSI 下降 >10% → 容量减 30–50%，去掉落地反跳。';
  plan.retest = '4 周后重测 CMJ、单腿三级跳（左右）、5-10-5；8 周后重测深蹲与助跑摸高；≥8–10 周才评估方案是否有效。';
  plan.painModified = deload;
  return plan;
}

/* ------------------------------------------------------------------ */
/* 报告渲染                                                            */
/* ------------------------------------------------------------------ */

const EV_ICON = { [EV.STRONG]: '🟢', [EV.MODERATE]: '🟡', [EV.WEAK]: '🟠', [EV.EMPIRICAL]: '⚪' };

export const REFERENCES = [
  { t: 'Schumann 2022, Sports Med — 同期训练对力量/肥大/爆发力的影响（爆发力 SMD −0.28）', u: 'https://europepmc.org/articles/PMC8891239' },
  { t: 'Petré 2021, Sports Med — 训练水平调节干扰效应', u: 'https://europepmc.org/articles/PMC8053170' },
  { t: 'Ferraro-Farro 2026 — 冲刺间歇训练不损害力量/跳跃/冲刺', u: 'https://doi.org/10.1055/a-2820-4527' },
  { t: 'Chen 2024（40 研究 meta）— HIIT 跑 + 力量在下肢力量/肥大上干扰最小', u: 'https://europepmc.org/articles/PMC10767279' },
  { t: 'Fyfe 2016 — HIIT 与中等强度持续训练同样削弱 1RM/CMJ 力量与 RFD（争议）', u: 'https://europepmc.org/articles/PMC5093324' },
  { t: 'de Villarreal 2009（56 研究）— 增强式剂量-反应', u: 'https://europepmc.org/article/MED/19197203' },
  { t: '复合训练网络 meta（34 研究/1057 人）— CMJ +2.5 cm', u: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC12903741/' },
  { t: '复合训练 meta — CMJ +5.0 cm，优于单纯力量与增强式', u: 'https://europepmc.org/article/MED/40469865' },
  { t: '单侧 vs 双侧增强式（11 研究/388 人）', u: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC13158094/' },
  { t: '落地反跳高度按蹲跳高度百分比确定（男篮）', u: 'https://europepmc.org/article/MED/39919724' },
  { t: '单次 212 次落地致急性外周疲劳', u: 'https://europepmc.org/article/MED/19528848' },
  { t: '髌腱病患病率：运动员 18.3%、篮球 20.8%', u: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC10280536/' },
  { t: '大学男篮 21.1% 符合髌腱病、33.7% 超声异常', u: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC6795094/' },
  { t: '踝背屈 <36.5° 与青少年精英篮球髌腱病风险升高相关', u: 'https://pubmed.ncbi.nlm.nih.gov/21917610/' },
  { t: 'PTLE 优于离心训练（24 周 VISA-P +28 vs +18, p=0.023）', u: 'https://pubmed.ncbi.nlm.nih.gov/33219115/' },
  { t: 'Kongsgaard 2009 — HSR 方案（4 组，15RM→6RM，3 次/周 ×12 周）', u: 'https://pubmed.ncbi.nlm.nih.gov/19793213/' },
  { t: 'Silbernagel 2007 — 疼痛监测模型原始 RCT（跟腱病）', u: 'https://pubmed.ncbi.nlm.nih.gov/17307888/' },
  { t: '髌腱病疼痛监测模型唯一直接研究仅为可行性 pilot（n=15）', u: 'https://pubmed.ncbi.nlm.nih.gov/33632313/' },
  { t: '2025 交叉试验 — 6RM/10RM/14RM 负荷与运动中疼痛无必然关系', u: 'https://pubmed.ncbi.nlm.nih.gov/39440865/' },
  { t: '等长收缩镇痛不优于动态阻力（推翻早期结论）', u: 'https://pubmed.ncbi.nlm.nih.gov/31735531/' },
  { t: 'Spanish squat 无 RCT 比较证据', u: 'https://pubmed.ncbi.nlm.nih.gov/38050553/' },
  { t: 'Cochrane 2025 — 髌腱病运动疗法整体证据确定性低', u: 'https://pubmed.ncbi.nlm.nih.gov/40421598/' },
  { t: 'ESSKA/荷兰指南 — 负荷管理与 12 周转诊节点', u: 'https://pubmed.ncbi.nlm.nih.gov/39045713/' },
];

export function renderMarkdown(d, flags, limiters, plan, pain, endurance, profile = {}) {
  const L = [];
  L.push('# 运动能力评估与训练方案', '');
  if (profile.name) L.push(`- 对象：${profile.name}`);
  L.push(`- 生成日期：${new Date().toISOString().slice(0, 10)}`);
  L.push('- 说明：每条建议标注证据强度 🟢强 / 🟡中 / 🟠弱 / ⚪经验性');
  L.push('');

  // 1 概览
  L.push('## 1. 概览', '');
  L.push('| 指标 | 数值 |');
  L.push('|---|---|');
  for (const k of ORDER) {
    if (d[k] !== null && d[k] !== undefined && Number.isFinite(d[k])) {
      let v = fmt(d[k], UNITS[k] ?? '');
      if (k === 'run3000S') v = `${Math.floor(d[k] / 60)}′${String(Math.round(d[k] % 60)).padStart(2, '0')}″`;
      L.push(`| ${LABELS[k]} | ${v} |`);
    }
  }
  if (d.painSite) {
    const pl = (PAIN_SITES.find((x) => x.id === d.painSite) || {}).label || d.painSite;
    L.push(`| 疼痛部位 | ${pl} |`);
  }
  L.push('');

  // 2 疼痛评估
  if (pain && pain.hasPain) {
    const badge = { green: '🟢 绿档 · 可正常训练', yellow: '🟡 黄档 · 减量并替换挑衅负荷',
      red: '🔴 红档 · 停挑衅负荷，相对休息', refer: '⛔ 转诊 · 停止评估与处方' }[pain.level];
    L.push('## 2. 疼痛评估与处理', '');
    L.push(`**${badge}**  ${ev(pain.evidence)}`);
    L.push('');
    L.push('判读依据：' + pain.reasons.join('；'));
    L.push('');
    L.push('**处理措施**');
    for (const a of pain.actions) L.push(`- ${a}`);
    L.push('');
    if (pain.tendonProgram) {
      const tp = pain.tendonProgram;
      L.push(`### 肌腱负荷方案：${tp.name}  ${ev(tp.evidence)}`);
      L.push('');
      L.push(`依据：${tp.why}`);
      L.push('');
      for (const x of tp.dose) L.push(`- ${x}`);
      L.push('');
      for (const x of tp.notes) L.push(`> ${x}`);
      L.push('');
    }
    if (pain.caveat) { L.push(`> ⚠️ ${pain.caveat}`); L.push(''); }
  } else if (pain) {
    L.push('## 2. 疼痛评估', '');
    L.push('未报告疼痛。仍建议每周记录一次静息/活动/次日晨起 NRS，作为负荷监控基线。');
    L.push(`> 跳跃运动员髌腱病患病率约 18.3%，篮球约 20.8%；大学男篮 21.1% 符合标准、33.7% 超声异常。`
      + `超声异常与症状常不相关，别靠影像判断。${ev(EV.MODERATE)}`);
    L.push('');
  }

  // 3 标记
  L.push('## 3. 判读与标记', '');
  for (const f of sortFlags(flags)) {
    const icon = { RED: '🔴', AMBER: '🟠', INFO: 'ℹ️', OK: '✅' }[f.level];
    L.push(`- ${icon} ${f.text}${f.evidence ? '  ' + ev(f.evidence) : ''}`);
  }
  L.push('');

  // 4 限制因素
  L.push('## 4. 限制因素排序', '');
  if (limiters.length === 0) L.push('未发现达到阈值的限制因素。优先优化助跑与起跳技术。');
  else {
    for (const l of limiters) {
      L.push(`**${l.rank}. ${l.name}**`);
      L.push(`- 证据：${l.evidence}`);
      L.push(`- 影响：${l.impact}`);
      L.push('');
    }
    L.push('> 先修最上游的一项，不要同时开三张处方。');
  }
  L.push('');

  // 5 训练方案
  L.push('## 5. 训练方案', '');
  L.push(`**主攻方向：${plan.focus}**`);
  L.push('');
  if (plan.insufficient) {
    L.push('当前数据不足以定位限制因素，需要先补：', '');
    for (const m of plan.missing) L.push(`- [ ] ${m}`);
    L.push('');
    if (plan.note) L.push(`> ${plan.note}`, '');
  } else {
    L.push('### 5.1 核心训练块（按证据强度排序）', '');
    for (const b of plan.keyBlocks) {
      L.push(`**${b.name}**  ${ev(b.evidence)}`);
      L.push('');
      L.push(`依据：${b.why}`);
      L.push('');
      for (const x of b.dose) L.push(`- ${x}`);
      L.push('');
      if (b.caution) { L.push(`> ${b.caution}`); L.push(''); }
    }

    L.push('### 5.2 每周排布', '');
    L.push('| 日 | 内容 |');
    L.push('|---|---|');
    for (const w of plan.weekly) L.push(`| ${w.day} | ${w.items.join('<br>')} |`);
    L.push('');
    if (plan.note) L.push(`> ${plan.note}`, '');
    L.push(`> ${plan.deloadNote}`, '');
    L.push(`- **进阶条件**：${plan.progression}`);
    L.push(`- **退阶条件**：${plan.regression}`);
    L.push(`- **复查**：${plan.retest}`);
    L.push('');
  }

  // 6 耐力
  if (endurance) {
    L.push('## 6. 耐力训练', '');
    if (!endurance.measured) {
      L.push('未填耐力数据，建议先测：');
      for (const m of endurance.missing) L.push(`- [ ] ${m}`);
      L.push('');
    } else {
      if (endurance.level) L.push(`- 当前定位：${endurance.level}（仅作粗略参考，无篮球人群硬性门槛）`);
      L.push('');
      L.push('### 6.1 三类耐力课');
      L.push('');
      for (const s of endurance.sessions) {
        L.push(`**${s.name}**  ${ev(s.evidence)}`);
        L.push(`- 剂量：${s.dose}`);
        L.push(`- 频率：${s.freq}`);
        L.push(`- 依据：${s.why}`);
        L.push('');
      }
      L.push('### 6.2 排布规则');
      L.push('');
      for (const r of endurance.rules) L.push(`- ${r.t}  ${ev(r.e)}`);
      L.push('');
      if (endurance.caveat) { L.push(`> ${endurance.caveat}`); L.push(''); }
      if (endurance.uncertain) { L.push(`> ⚠️ ${endurance.uncertain}`); L.push(''); }
    }
  }

  // 7 边界
  L.push('## 7. 依据与边界', '');
  L.push('**证据强度图例**：🟢 强证据（多项 meta/RCT 一致）｜🟡 中等｜🟠 弱（单研究或间接）｜⚪ 经验性');
  L.push('');
  L.push('主要参考文献：');
  for (const r of REFERENCES) L.push(`- ${r.t} — ${r.u}`);
  L.push('');
  L.push('---', '');
  L.push('> ⚠️ 本评估为运动能力测试与训练建议，**不是医学诊断**，不能替代临床检查。');
  L.push('> 参考区间为经验值，存在个体差异。出现夜间痛、静息痛、肿胀、交锁、打软腿或神经症状，请立即停止并线下就诊。');
  L.push('> 本方案中的阈值多数来自运动队/青少年样本，往训练年限低的业余爱好者外推需谨慎。');
  return L.join('\n');
}
