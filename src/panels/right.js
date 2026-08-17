// ═══════════════════════════════════════════════════════════════════════════
// src/panels/right.js — 우측 고정 패널 §4.5
// SYSTEM STATUS · RISK RANKING (TTS) · ALERT FEED
// 예외 우선(§4.8): 알림 피드가 세로 절반을 차지하고, 정상이면 한 줄만 남는다.
// ═══════════════════════════════════════════════════════════════════════════

import { NODES } from '../data.js';
import { el, clear, badge, sparkline } from '../components.js';
import { usd, fmtNum, day as fmtDay, SEVERITY_GLYPH } from '../units.js';
import { appState, setSelection, setPlayhead, setView, revealProjection } from '../store.js';
import { fmtDate } from '../clock.js';

let root = null;
// 예외 우선 (§4.8) — 기본은 WARN/CRIT 만. 정상이면 NO ACTIVE EXCEPTIONS 한 줄.
let sevFilter = 'EXCEPTIONS';

export function mount(container) {
  root = container;
}

/**
 * '이대로 두면?' — 현재 관측 상태가 지속된다고 볼 때의 착지점.
 * 엔진은 이미 120일을 계산해 뒀으므로 새로 돌지 않는다. 이 카드가 하는 일은
 * 계산이 아니라 서사다 — 담당자가 '진단을 실행했다'는 행위를 만들어 준다.
 */
function projectionCard(state) {
  const box = el('div', { style: { padding: '8px 12px', borderBottom: '1px solid var(--border)' } });
  const s = state.result.system;

  if (!state.projectionRevealed) {
    box.appendChild(el('div', {
      class: 'tiny muted', style: { marginBottom: '6px', lineHeight: '1.5' },
      text: '현재 계측 상태가 이대로 지속된다고 가정하고 향후 90일을 투영합니다.',
    }));
    box.appendChild(el('button', {
      class: 'btn primary', style: { width: '100%' },
      text: '▶ 이대로 두면? · 90일 전망',
      onclick: () => revealProjection(),
    }));
    return box;
  }

  const bad = s.otdPct < 99;
  box.appendChild(el('div', { class: 'section-label', style: { padding: '0 0 4px' } },
    el('span', { text: '90일 전망 · 현 상태 지속 시' })));
  const row = (k, v, color) => el('div', { class: 'spread', style: { marginTop: '3px' } },
    el('span', { class: 'tiny muted', text: k }),
    el('span', { class: 'mono tiny', style: color ? { color } : {}, text: v }));
  box.appendChild(row('OTD 착지', `${fmtNum(s.otdPct, 1)}%`,
    bad ? 'var(--status-crit)' : 'var(--status-ok)'));
  box.appendChild(row('LD 페널티', usd(s.costBreakdown.ldPenalty),
    s.costBreakdown.ldPenalty > 0 ? 'var(--status-crit)' : null));
  box.appendChild(row('일실 산출', `${fmtNum(s.totalLostOutputMWh, 1)} MWh`));
  box.appendChild(row('총원가', usd(s.totalCostUSD)));
  box.appendChild(el('div', {
    class: 'tiny muted', style: { marginTop: '6px', lineHeight: '1.45' },
    text: 'PLAN 모드로 전환하면 지금 시점에서 조정 가능한 레버와 그 최단 적용 가능일을 검토할 수 있습니다.',
  }));
  return box;
}

/**
 * 관측 시점까지의 '실적' 집계. 120일 누계를 그대로 보여주면 버튼을 누르기 전에
 * 전망 결과가 새어 나가, 진단 → 투영이라는 순서 자체가 무너진다.
 *
 * 일자별 시계열이 있는 항목(LD 누계 · 처리량 · 상태 타임라인)만 창을 잘라
 * 계산한다. 원가는 일별 시계열이 없으므로 여기서는 아예 내보내지 않는다 —
 * 없는 값을 추정해 KPI 자리에 채우면 그건 실적이 아니라 창작이다.
 */
function actualsToDate(state) {
  const r = state.result;
  const now = Math.min(state.nowDay, r.system.horizonDays - 1);

  // 납기가 이미 도래한 PO 만 대상으로 한다. 아직 안 온 납기를 분모에 넣으면
  // 실적이 실제보다 나빠 보인다.
  const due = r.orders.filter((o) => o.dueDay <= now);
  const onTime = due.filter((o) => o.deliveredDay != null && o.deliveredDay <= o.dueDay).length;
  const late = due.filter((o) => o.deliveredDay != null && o.deliveredDay > o.dueDay).length;
  const undelivered = due.filter((o) => o.deliveredDay == null).length;

  let blocked = 0, starved = 0;
  for (const n of NODES) {
    const tl = r.perNode[n.id].stateTimeline;
    for (let d = 0; d <= now; d++) {
      if (tl[d] === 'BLOCKED') blocked++;
      if (tl[d] === 'STARVED') starved++;
    }
  }

  // 처리량은 최근 7일 이동평균 — '지금 얼마나 나오고 있는가'가 관심사다.
  const from = Math.max(0, now - 6);
  let acc = 0;
  for (let d = from; d <= now; d++) acc += r.system.throughputMWhPerDay[d] || 0;

  return {
    now,
    otdPct: due.length ? (onTime / due.length) * 100 : 100,
    ordersDue: due.length,
    onTime, late, undelivered,
    penaltyUSD: r.system.costSeries.ldPenalty[now] || 0,
    totalCostUSD: r.system.totalCostSeries[now] || 0,
    thruput7d: acc / (now - from + 1),
    demandNow: r.system.demandRateSeries[now] || 0,
    blocked, starved,
  };
}

export function render(state) {
  if (!root || !state.result) return;
  clear(root);
  const r = state.result;
  const cf = state.counterfactual;
  const day = state.playhead;

  // ── SYSTEM STATUS ─────────────────────────────────────────────────────
  root.appendChild(el('div', { class: 'panel-head' },
    el('span', { text: 'System Status' }),
    badge(state.mode, state.mode === 'LIVE' ? 'ok' : 'warn')));

  if (state.mode === 'LIVE') root.appendChild(projectionCard(state));

  const kpi = (label, value, sub, onclick, color) => {
    const row = el('div', { class: 'kpi-row', onclick });
    row.appendChild(el('div', {},
      el('div', { class: 'kpi-label', text: label }),
      sub ? el('div', { class: 'kpi-sub', text: sub }) : null));
    row.appendChild(el('div', { class: 'kpi-value', style: color ? { color } : {}, text: value }));
    return row;
  };

  const s = r.system;
  // LIVE 에서 아직 투영을 실행하지 않았다면 관측 시점까지의 실적만 보여준다.
  const toDate = state.mode === 'LIVE' && !state.projectionRevealed;

  if (toDate) {
    const a = actualsToDate(state);
    root.appendChild(el('div', {
      class: 'kpi-sub', style: { padding: '4px 12px 0', color: 'var(--text-muted)' },
      text: `실적 누계 · ${fmtDate(0)} ~ 현재`,
    }));
    root.appendChild(kpi('OTD', `${fmtNum(a.otdPct, 1)}%`,
      `납기도래 ${a.ordersDue}건 중 정시 ${a.onTime}`,
      () => setSelection({ type: 'customerGroup' }),
      a.otdPct >= 99 ? 'var(--status-ok)' : a.otdPct >= 90 ? 'var(--status-warn)' : 'var(--status-crit)'));

    root.appendChild(kpi('PENALTY 누계', usd(a.penaltyUSD),
      `지연 ${a.late} · 미인도 ${a.undelivered}`,
      () => setSelection({ type: 'customerGroup' }),
      a.penaltyUSD > 0 ? 'var(--status-crit)' : 'var(--text-primary)'));

    root.appendChild(kpi('THRUPUT', `${fmtNum(a.thruput7d, 1)}`,
      `최근 7일 평균 · 계획 ${fmtNum(a.demandNow, 1)} MWh/day`,
      () => setView('FLOW'),
      a.thruput7d < a.demandNow * 0.95 ? 'var(--status-warn)' : null));

    root.appendChild(kpi('TOTAL COST 누계', usd(a.totalCostUSD),
      `blocked ${a.blocked}d · starved ${a.starved}d`,
      () => setView('COST')));
  } else {
    root.appendChild(kpi('OTD', `${fmtNum(s.otdPct, 1)}%`,
      `on-time ${s.ordersOnTime}/${s.ordersTotal}`,
      () => setSelection({ type: 'customerGroup' }),
      s.otdPct >= 99 ? 'var(--status-ok)' : s.otdPct >= 90 ? 'var(--status-warn)' : 'var(--status-crit)'));

    root.appendChild(kpi('PENALTY', usd(s.totalPenaltyUSD),
      `지연 ${s.ordersLate} · 미인도 ${s.ordersUndelivered}`,
      () => setSelection({ type: 'customerGroup' }),
      s.totalPenaltyUSD > 0 ? 'var(--status-crit)' : 'var(--text-primary)'));

    root.appendChild(kpi('THRUPUT', `${fmtNum(s.throughputMWhPerDay[day], 1)}`,
      `계획 ${fmtNum(s.demandRateSeries[day], 1)} MWh/day`,
      () => setView('FLOW')));

    root.appendChild(kpi('TOTAL COST', usd(s.totalCostUSD),
      `blocked ${s.totalBlockedDays}d · starved ${s.totalStarvedDays}d`,
      () => setView('COST')));
  }

  // 반사실 3열
  if (state.showCounterfactual && cf) {
    const saving = s.totalCostUSD - cf.system.totalCostUSD;
    root.appendChild(el('div', { class: 'cf-grid', style: { borderBottom: '1px solid var(--border)' } },
      el('div', { class: 'cf-cell' }, el('div', { class: 'k', text: '현재' }), el('div', { class: 'v', text: usd(s.totalCostUSD) })),
      el('div', { class: 'cf-cell' }, el('div', { class: 'k', text: '즉시대응' }), el('div', { class: 'v', text: usd(cf.system.totalCostUSD) })),
      el('div', { class: 'cf-cell saving' }, el('div', { class: 'k', text: '절감' }), el('div', { class: 'v', text: usd(saving) }))));
  }

  // 처리량 시계열 (확률모드면 P10/P90 밴드)
  const chart = el('div', { style: { padding: '6px 10px 8px', borderBottom: '1px solid var(--border)' } });
  chart.appendChild(el('div', { class: 'kpi-label', text: 'THROUGHPUT MWh/day' }));
  chart.appendChild(throughputChart(state));
  root.appendChild(chart);

  // ── RISK RANKING (TTS §3.8) ───────────────────────────────────────────
  root.appendChild(el('div', { class: 'panel-head' },
    el('span', { text: 'Risk · Time To Survive' }),
    r.tts ? null : badge('계산 중', 'muted')));

  if (r.tts) {
    const rows = NODES
      .map((n) => ({ id: n.id, tts: r.tts[n.id] }))
      .sort((a, b) => (a.tts ?? 9999) - (b.tts ?? 9999));
    const maxT = Math.max(...rows.map((x) => x.tts ?? 0), 1);
    for (const row of rows.slice(0, 6)) {
      const w = row.tts == null ? 100 : (row.tts / maxT) * 100;
      const color = row.tts == null ? 'var(--status-idle)'
        : row.tts <= 10 ? 'var(--status-crit)'
        : row.tts <= 30 ? 'var(--status-warn)' : 'var(--status-ok)';
      root.appendChild(el('div', {
        class: 'risk-row', onclick: () => setSelection({ type: 'node', id: row.id }),
        title: `${row.id} 를 무기한 정지시켰을 때 첫 신규 납기 위반까지 ${row.tts == null ? '지평선 내 없음' : row.tts + '일'}`,
      },
        el('span', { class: 'id', text: row.id }),
        el('span', { class: 'd', text: row.tts == null ? '—' : `${row.tts}d` }),
        el('span', { class: 'risk-bar', style: { width: `${w}%`, background: color } })));
    }
  }

  // ── ALERT FEED ────────────────────────────────────────────────────────
  // 투영 전에는 아직 일어나지 않은 사건을 띄우지 않는다.
  const alerts = r.events.filter((e) => (toDate ? e.day <= state.nowDay : true)).filter((e) =>
    sevFilter === 'ALL' ? true
      : sevFilter === 'EXCEPTIONS' ? e.severity !== 'INFO'
      : e.severity === sevFilter);
  root.appendChild(el('div', { class: 'panel-head' },
    el('span', { text: `Alert Feed (${alerts.length})` }),
    el('div', { style: { display: 'flex', gap: '3px' } },
      ...['EXCEPTIONS', 'CRIT', 'ALL'].map((k) => el('button', {
        class: 'btn', style: { height: '17px', padding: '0 5px', fontSize: '9px' },
        'aria-pressed': String(sevFilter === k),
        text: k === 'EXCEPTIONS' ? 'EXC' : k,
        onclick: () => { sevFilter = k; render(appState); },
      })))));

  const feed = el('div', { id: 'alert-feed' });
  if (!alerts.length) {
    feed.appendChild(el('div', { class: 'empty-state', text: 'NO ACTIVE EXCEPTIONS' }));
  } else {
    // 현재 플레이헤드 부근을 우선 보여준다 (TODAY 앵커, §4.8)
    const near = [...alerts].sort((a, b) => {
      const sev = { CRIT: 0, WARN: 1, INFO: 2 };
      const da = Math.abs(a.day - day);
      const db = Math.abs(b.day - day);
      return sev[a.severity] - sev[b.severity] || da - db;
    }).slice(0, 140);
    for (const e of near) {
      feed.appendChild(el('div', {
        class: `alert ${e.severity}`,
        title: '클릭하면 해당 일자로 이동하고 노드를 선택합니다',
        onclick: () => {
          setPlayhead(e.day);
          if (e.nodeId) {
            const isNode = NODES.some((n) => n.id === e.nodeId);
            setSelection({ type: isNode ? 'node' : 'customer', id: e.nodeId });
          }
        },
      },
        el('span', { class: 'day', text: fmtDay(e.day) }),
        el('span', { class: 'sev', text: SEVERITY_GLYPH[e.severity] }),
        el('span', { class: 'msg', text: `${e.nodeId ? e.nodeId.padEnd(8) + ' ' : ''}${e.message}` })));
    }
  }
  root.appendChild(feed);
}

function throughputChart(state) {
  const r = state.result;
  const w = 280;
  const h = 40;
  // 투영 전에는 관측 구간까지만 그린다 — 전체를 그리면 수요 서지가 그래프
  // 모양으로 먼저 보여서 '이대로 두면?' 이 물어볼 것이 남지 않는다.
  const toDate = state.mode === 'LIVE' && !state.projectionRevealed;
  const cut = toDate ? Math.min(state.nowDay + 1, r.system.horizonDays) : r.system.horizonDays;
  const series = r.system.throughputMWhPerDay.slice(0, cut);
  const demandSeries = r.system.demandRateSeries.slice(0, cut);
  const max = Math.max(...series, ...demandSeries, 1) * 1.1;

  const box = el('div', { style: { position: 'relative' } });
  const line = sparkline(series, {
    width: w, height: h, max, color: 'var(--cyan)',
    marker: Math.min(state.playhead, cut - 1),
  });

  // 확률 모드 P10/P90 밴드를 배경에 (§1.5.4)
  if (state.mc?.throughputBand) {
    const b = state.mc.throughputBand;
    const x = (i) => (i / (series.length - 1)) * w;
    const y = (v) => h - Math.max(0, Math.min(1, v / max)) * h;
    let d = `M${x(0)},${y(b.p90[0])}`;
    for (let i = 1; i < b.p90.length; i++) d += `L${x(i)},${y(b.p90[i])}`;
    for (let i = b.p10.length - 1; i >= 0; i--) d += `L${x(i)},${y(b.p10[i])}`;
    d += 'Z';
    const band = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    band.setAttribute('d', d);
    band.setAttribute('fill', 'var(--ghost)');
    band.setAttribute('opacity', '0.35');
    line.insertBefore(band, line.children[1] || null);
  }
  box.appendChild(line);
  const avg = series.reduce((a, b) => a + b, 0) / Math.max(1, series.length);
  const dem = demandSeries.reduce((a, b) => a + b, 0) / Math.max(1, demandSeries.length);
  box.appendChild(el('div', { class: 'kpi-sub', style: { marginTop: '2px' },
    text: `${toDate ? '실적' : '평균'} ${fmtNum(avg, 2)} / 수요 ${fmtNum(dem, 2)} MWh/day` }));
  return box;
}
