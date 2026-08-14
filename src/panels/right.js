// ═══════════════════════════════════════════════════════════════════════════
// src/panels/right.js — 우측 고정 패널 §4.5
// SYSTEM STATUS · RISK RANKING (TTS) · ALERT FEED
// 예외 우선(§4.8): 알림 피드가 세로 절반을 차지하고, 정상이면 한 줄만 남는다.
// ═══════════════════════════════════════════════════════════════════════════

import { NODES } from '../data.js';
import { el, clear, badge, sparkline } from '../components.js';
import { usd, fmtNum, qty, day as fmtDay, SEVERITY_GLYPH } from '../units.js';
import { appState, setSelection, setPlayhead, setPanel, setView } from '../store.js';

let root = null;
// 예외 우선 (§4.8) — 기본은 WARN/CRIT 만. 정상이면 NO ACTIVE EXCEPTIONS 한 줄.
let sevFilter = 'EXCEPTIONS';

export function mount(container) {
  root = container;
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
    badge(state.mode, state.mode === 'OPERATE' ? 'warn' : 'info')));

  const kpi = (label, value, sub, onclick, color) => {
    const row = el('div', { class: 'kpi-row', onclick });
    row.appendChild(el('div', {},
      el('div', { class: 'kpi-label', text: label }),
      sub ? el('div', { class: 'kpi-sub', text: sub }) : null));
    row.appendChild(el('div', { class: 'kpi-value', style: color ? { color } : {}, text: value }));
    return row;
  };

  const s = r.system;
  root.appendChild(kpi('OTD', `${fmtNum(s.otdPct, 1)}%`,
    `on-time ${s.ordersOnTime}/${s.ordersTotal}`,
    () => { setPanel('CUSTOMERS'); },
    s.otdPct >= 99 ? 'var(--status-ok)' : s.otdPct >= 90 ? 'var(--status-warn)' : 'var(--status-crit)'));

  root.appendChild(kpi('PENALTY', usd(s.totalPenaltyUSD),
    `지연 ${s.ordersLate} · 미인도 ${s.ordersUndelivered}`,
    () => { setPanel('CUSTOMERS'); },
    s.totalPenaltyUSD > 0 ? 'var(--status-crit)' : 'var(--text-primary)'));

  root.appendChild(kpi('THRUPUT', `${fmtNum(s.throughputMWhPerDay[day], 1)}`,
    `계획 ${fmtNum(s.demandRateSeries[day], 1)} MWh/day`,
    () => setView('FLOW')));

  root.appendChild(kpi('TOTAL COST', usd(s.totalCostUSD),
    `blocked ${s.totalBlockedDays}d · starved ${s.totalStarvedDays}d`,
    () => setView('COST')));

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
  const alerts = r.events.filter((e) =>
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
  const series = r.system.throughputMWhPerDay;
  const max = Math.max(...series, ...r.system.demandRateSeries, 1) * 1.1;

  const box = el('div', { style: { position: 'relative' } });
  const line = sparkline(series, { width: w, height: h, max, color: 'var(--cyan)', marker: state.playhead });

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
  box.appendChild(el('div', { class: 'kpi-sub', style: { marginTop: '2px' },
    text: `평균 ${fmtNum(r.system.throughputAvg, 2)} / 수요 ${fmtNum(r.system.demandAvg, 2)} MWh/day` }));
  return box;
}
