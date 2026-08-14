# ESS Supply Chain Digital Twin

LG에너지솔루션 북미 ESS 공급망(Cell → Pack → Link → 고객)의 **일 단위 이산 시뮬레이션**과
인터랙티브 시각화. 빌드 스텝 없는 단일 정적 웹 앱.

**핵심 명제** — 한 노드의 문제는 상류에 Blocking, 하류에 Starving으로 *서로 다른 시점에*
나타난다. 물리 리드타임(수송)과 정보 리드타임(계획·인지)이 겹치면서, 문제가 보일 때는
이미 손실이 확정되어 있다. 이 도구는 그 시차를 보이게 만들고, **정보 지연만 제거했을 때의
금액 차이**를 계산한다.

---

## 1. 실행

빌드 도구가 필요 없다. ES modules 를 쓰므로 `file://` 이 아닌 로컬 서버로 열어야 한다.

```bash
python3 -m http.server 8000
# → http://localhost:8000/index.html
```

엔진만 헤드리스로 돌려 검증 게이트를 확인하려면:

```bash
node tools/validate.mjs      # §3.9 검증 게이트 5종 + 성능 · 순수성 확인
node tools/debug.mjs pw1 AZL 40   # 특정 시나리오의 노드 일별 추적
```

### 네트워크 의존성

| 대상 | 용도 | 실패 시 |
|---|---|---|
| Google Fonts (Inter / Roboto Mono) | 타이포그래피 | 시스템 폰트로 대체 |
| `topojson-client` + `us-atlas` (jsDelivr) | 미국 외곽 실루엣 | 실루엣만 생략, 나머지 전부 정상 |

**좌표 투영은 CDN 에 의존하지 않는다.** `src/geo.js` 가 Albers USA 등적 원뿔 투영을 직접
계산한다(d3 와 동일 파라미터: parallels 29.5°/45.5°, rotate 96°, center −0.6°/38.7°).
AZ 가 중서부에서 물리적으로 멀다는 사실이 리드타임의 시각적 근거이므로, 이 부분이 외부
네트워크 상태에 좌우되면 안 된다고 판단했다. 오프라인 환경에서는 위 두 요청이 실패하며
브라우저 콘솔에 네트워크 오류가 남지만, 앱 자체의 에러/경고는 0 이다.

---

## 2. 실행 모델 (가장 중요)

**계산과 재생은 분리되어 있다.** 재생하면서 계산하지 않는다.

```
레버 / 장애 / Action 변경
      ↓  debounce 120ms
runSim(config)  →  120일 전체 계산 (≈8ms)
      ↓
result 객체 (일별 상태·재고·출하·KPI·이벤트 전부 포함)
      ↓
playhead(day = k)  →  result 의 k일 슬라이스만 렌더
```

- 재생 / 일시정지 / 스크럽 / 속도 변경은 **전부 렌더링 계층 동작**이다. `requestAnimationFrame`
  루프가 `playhead` 인덱스만 옮기며, 엔진은 다시 호출되지 않는다.
- `runSim(config)` 은 **순수 함수**다. 상태를 보유하지 않고, `config` 를 변경하지 않으며,
  두 번 호출하면 두 번 다 동일한 결과가 나온다 (`tools/validate.mjs` 에서 검증).
- 레버는 어떤 상태에서도 **잠기지 않는다**. 재생 중에도 조정 가능하고, 재계산 후에도
  플레이헤드 위치는 유지된다.
- `config` 만이 진실의 원천이다. `result` 는 항상 `config` 에서 재계산되는 파생값이며
  절대 직접 수정하지 않는다. URL 해시에는 `config` 의 **기본값 대비 차분** + `playhead` +
  `view` 만 인코딩한다.

### DESIGN / OPERATE

| | **DESIGN** (기본) | **OPERATE** |
|---|---|---|
| 레버 적용 시점 | D+0 부터 | 계획 레이어가 계산한 최단 적용 가능일부터 |
| 이전 이력 | 함께 변경됨 | **고정** |
| 구현 | `config` 직접 변경 | `{day, type, ...}` Action 으로 큐에 추가 |

OPERATE 모드에서 레버를 조정하면 인스펙터에 아래 경고가 뜬다. **컨트롤을 비활성화하는
것이 아니라 경고만 표시한다** — UI 가 임의로 거는 락이 아니라 계획 시스템이 물리적으로
거는 락이기 때문이다.

```
현재 D+050 · PW2 조정 시도
  ├─ 정보 지연         3일  →  D+053
  ├─ 다음 replan 경계       →  D+056
  ├─ frozen window   14일  →  D+070
  └─ ▲ 최단 적용 가능일   D+070
     그러나 AZL STARVED 시작은 D+060 — 이미 늦음
```

PLANNING 패널에서 `infoLagDays` 와 `frozenWindowDays` 를 0 으로 내리면 이 경고가 사라지고
즉시 적용된다.

---

## 3. 파일 구조

```
index.html            셸 마크업
styles.css            Gotham 다크 팔레트 토큰 + 전 컴포넌트
src/data.js           마스터 데이터 + 모든 상수 (이 파일 밖에 수치 하드코딩 없음)
src/sim.js            시뮬레이션 엔진 — DOM 의존 0, runSim(config) 순수 함수
src/cost.js           원가 / 페널티 모델
src/geo.js            Albers USA 투영 + 최소 path 생성기
src/units.js          표시 단위 환산 (MWh / Link / Pack / Cell)
src/components.js     DOM · SVG 헬퍼, 공용 컨트롤 빌더
src/store.js          appState · 재계산 파이프라인 · 액션 · URL 해시
src/ui.js             셸 · 라우팅 · 키보드 · 재생 · 검색 · 설정 · CSV
src/mc-worker.js      Monte Carlo Web Worker
src/views/            network · flow · cost · gantt
src/panels/           inspector · scenario · planning · customers · ontology · right
tools/validate.mjs    §3.9 검증 게이트
tools/debug.mjs       노드 일별 추적 유틸
```

사양서의 파일 구조에 `geo.js` / `units.js` / `components.js` / `store.js` 를 추가했다.
데이터는 전부 `data.js`, 시뮬 로직은 전부 `sim.js` 에 남아 있고 추가된 파일은 표현 계층과
상태 관리 유틸이다.

---

## 4. 검증 게이트 (§3.9)

`node tools/validate.mjs` — UI 를 건드리기 전에 통과시킨 조건들이며 현재 전부 초록이다.

| 게이트 | 결과 |
|---|---|
| 1. 무장애 결정론 → 전 노드 RUNNING, blocked/starved = 0 | blocked 0d · starved 0d |
| 2. Little's Law: 평균 in-transit ≈ 일평균출하 × 평균수송일 (±5%) | +1.03% |
| 3. 물질수지: 투입+기초 = 인도+기말+수율손실 (±0.1%) | 0.00000% |
| 4. BOM 왕복: 1 Link = 84 Pack = 10,080 Cell = 5.134752 MWh | 정확 일치 |
| 5. PW1 5일 정지 → Cell BLOCKED 가 AZL STARVED 보다 먼저 | Cell **+4d** · AZL **+9d** |
| (추가) `runSim` 순수성 — config 미변경 + 동일 결과 | 통과 |
| (추가) 120일 결정론 시뮬 1회 < 50ms | ≈8 ms |
| (추가) PO 48건 (12 고객 × 4개월) | 48건 |

게이트 5 의 §2.8 기대값은 "약 3일 / 약 11일"이고 실측은 +4d / +9d 다. 순서와 시차 규모가
모두 맞는다.

### 베이스라인 용량 설계

| 단계 | 능력 (MWh/day) | 소요 (MWh/day) | 여유 |
|---|---|---|---|
| Cell 5개소 | 26.60 | 23.24 | **+14.4%** |
| **Pack 2개소** | **21.84** | **21.85** | **−0.1% (병목)** |
| Link (AZL) | 22.83 | 20.54 | +11.2% |
| 고객 수요 | — | 20.54 | — |

Pack 이 정확히 병목이 되도록 설계되어 있고(§2.8 의도), 실제로 기준선에서 Pack 가동률이
100.0% 로 나온다. 소요량은 수요에서 단계별 수율을 역산해 얻는다
(`20.54 / 0.94 = 21.85 / 0.94 = 23.24`).

기준선 KPI: **OTD 100%** · LD $0 · 총원가 $6.80M · 처리량 20.53 vs 수요 20.54 MWh/day.

---

## 5. 사양서 대비 명시적 확장 2가지

두 곳에서 사양서 문면을 그대로 구현하면 검증 게이트를 통과할 수 없어 확장했다. 둘 다
`sim.js` 상단과 코드 주석에 근거를 남겼다.

### 5.1 생산 제약에 `byPlan` 추가

§3.2 의 생산 가능량은 `byCapacity` / `bySupply` / `bySpace` 3항이다. 그런데 그것만 쓰면
각 단계가 항상 최대로 밀어내므로 §3.9-① (무장애 시 blocked/starved = 0) 을 만족할 수 없다.
Cell 여유 +14%, Link 여유 +11% 가 곧바로 재고 누적과 기아로 나타나기 때문이다.

그래서 계획 레이어(§3.4)가 산출하는 `byPlan` 을 네 번째 제약으로 넣었다.
이것은 회피가 아니라 이 도구의 명제 자체이기도 하다.

- **정상 시**: 계획 = 실제 흐름 → 누적 없음 → 전 노드 RUNNING
- **장애 시**: 계획이 infoLag/frozen 때문에 못 따라옴 → 상류가 이미 꽉 찬 창고에 계속
  밀어넣음 → **BLOCKING**. 하류는 시차를 두고 **STARVING**.

계획은 replan 시점에 **인지된**(= `infoLagDays` 만큼 지연된) 능력과 재고를 보고
생산율을 다시 잡고, `frozenWindowDays` 뒤에야 발효된다.

### 5.2 보충 목표를 '재고 포지션'으로

목적지 입고 여유를 `창고 용량 − 현 재고 − 이동 중 물량` 으로 잡으면, 창고 일수와 수송
일수가 비슷한 구간에서 현물 재고가 0 으로 수렴한다. AZL 은 창고 5일 / 수송 5일이라 정확히
이 경우이고, 그러면 상류가 조금만 흔들려도 즉시 STARVED 가 된다.

표준 order-up-to 정책대로 **리드타임 소요분을 목표에 더한다**:

```
목표 재고 포지션 = 입고창고 × targetInputFillPct + 리드타임 소요분
여유 = 목표 포지션 − 현 재고 − 이동 중 물량
```

이렇게 하면 현물 재고가 안전재고 수준에 머물고, 파이프라인이 나머지 커버리지를 담당한다.

### 그 외 판단

- **Cell → Pack 배차**는 §2.2 대로 각 Cell 안에서 최단거리 Pack 우선이되, 목적지 여유를
  적체량에 비례해 먼저 나눈다. 정상 흐름에서 Pack 입고 여유가 열리는 양은 소비율과 같아
  거의 0 이므로, 배차를 순서 고정 탐욕으로 하면 가장 먼 공장(UC2)이 영구히 밀려 상시
  BLOCKED 가 된다.
- **주문서에 지평선 너머 1개월치 꼬리**를 붙였다(KPI 집계에서는 제외). D+115 에서 주문이
  뚝 끊기면 AZL 이 출하할 곳을 잃고 막히면서 상류 전체가 인위적으로 BLOCKED 가 된다.
- **Warm start** — D+0 이전에도 네트워크가 돌고 있었다고 가정하고 파이프라인과 첫 달
  출하분을 채운다. 비우고 시작하면 첫 달 전체가 기동 과도현상으로 지연되어 기준선이
  무의미해진다.

---

## 6. 파라미터 사전

전 상수의 의미 · 단위 · 출처 · 검증여부. 전부 `src/data.js` 상단에 모여 있다.

### 6.1 BOM — 확정 (검증됨)

| 상수 | 값 | 단위 | 출처 |
|---|---|---|---|
| `BOM.cellWh` | 509.4 | Wh/cell | 확정 |
| `BOM.cellsPerPack` | 120 | — | 확정 |
| `BOM.packsPerLink` | 84 | — | 확정 |
| `UNITS.packMWh` | 0.061128 | MWh | **계산 유도** |
| `UNITS.linkMWh` | 5.134752 | MWh | **계산 유도** |
| `UNITS.cellsPerLink` | 10,080 | — | **계산 유도** |

파생값은 하드코딩하지 않고 전부 BOM 에서 계산한다.

### 6.2 노드 이론 CAPA — 가정치 (§9-6)

| id | MWh/h | 소유 | 위치 |
|---|---|---|---|
| ESMI_H / ESMI_L | 0.42 / 0.28 | LGES | Holland MI / Lansing MI |
| ESST / ESHD / UC2 | 0.24 / 0.22 / 0.18 | JV | Spring Hill TN / Jeffersonville OH / Lordstown OH |
| PW1 / PW2 | 0.62 / 0.48 | 외주 | Holland MI |
| AZL | 1.15 | LGES | Queen Creek AZ |

Pack 이 병목이 되도록 역산한 값이다. 좌표는 placeholder — `// TODO: 실좌표 검증`.

### 6.3 거리 — 일부 미검증 (§9-3)

`DISTANCE_OVERRIDES` 에 슬라이드 확정값을 분리해 두었고, 나머지는 haversine × 1.25.

| 구간 | 마일 | 비고 |
|---|---|---|
| AZL ↔ ESMI_H | 1,882 | |
| AZL ↔ CHI | 2,024 | **검증 필요** — CHI 가 Holland 보다 AZ 에서 멀게 표기됨 |
| AZL ↔ PW1/PW2 | 1,745 | |
| ESMI_H ↔ ESMI_L | 311 | **검증 필요** — 실제 약 90 마일 |
| PW ↔ ESHD / ESST | 517 / 331 | |
| ESMI_H ↔ PW | 174 | |

슬라이드 값을 그대로 쓰되 Lane 인스펙터와 화면 하단에 미검증임을 표기한다.

### 6.4 노드 레버 기본값

| 파라미터 | 기본 | 범위 | 단위 |
|---|---|---|---|
| `operatingHoursPerDay` | 24 | 8–24 | h/day |
| `operatingDaysPerWeek` | 7 | 5 / 6 / 7 | day/week |
| `availability` | 88% | 50–100% | — |
| `yield` | 94% | 80–99.9% | — |
| `inputBufferDays` | 5 | 0.5–30 | day |
| `outputBufferDays` | 4 | 0.5–30 | day |
| `mtbfDays` / `mttrDays` | 45 / 2 | — | day (확률 모드) |

창고 capacity 는 실측값이 없어 **일수로 노출**하고 절대량을 병기한다 (§9-4).

```
outputBufferCapacityMWh = effectiveDailyOutput × outputBufferDays
inputBufferCapacityMWh  = effectiveDailyOutput / yield × inputBufferDays
effectiveDailyOutput    = capaPerHour × hours × (days/7) × availability × yield
```

### 6.5 구간별 적재 단위 — 구간마다 다르다 (§2.5)

| 구간 | 운반 물체 | 기본 적재 | 범위 | ≈ MWh |
|---|---|---|---|---|
| Cell → Pack | Cell | 3,600 | 1,200–12,000 | 1.83 |
| Pack → Link | **Pack** | **39** | 10–120 | **2.38** |
| Link → 고객 | Link | 1 | 1–40 | 5.13 |

Link 완제품 컨테이너는 트럭 1대당 1기가 물리적 한계다. 확인된 "트럭당 39대"는 Pack 단위.
`minLoadPct` 0.8 은 의도적 설계 — 만차 미달분을 대기시켜 계단식 증폭을 만드는 bullwhip
발원지이며, Lane 인스펙터에서 0.1 까지 내리면 증폭이 사라지는 것을 시연할 수 있다.

### 6.6 계획 레이어 (§3.4)

| 파라미터 | 기본 | 의미 |
|---|---|---|
| `replanCycleDays` | 7 | 계획 재수립 주기 |
| `frozenWindowDays` | 14 | 이 기간 내 계획 변경 불가 |
| `infoLagDays` | 3 | 장애 인지 지연 |
| `allocationRule` | `dueDate` | dueDate / penaltyValue / priorityTier / proRata / fcfs |

**실질 대응 지연 = infoLag + (다음 replan 까지 잔여일) + frozenWindow.**
PLANNING 패널에 28px 대형 숫자로 상시 표시된다.

### 6.7 계약 / LD — 전부 placeholder (§9-5)

| 파라미터 | 기본 | 단위 |
|---|---|---|
| `contractValuePerMWh` | 350,000 | USD/MWh |
| `ldRatePerDay` | 0.2% | 계약가 대비 /일 |
| `ldCapPct` | 10% | 상한 |
| `graceDays` | 3 | day |

```
lateDays = max(0, deliveredDay − dueDay − graceDays)
penalty  = min(qty × 계약가 × 일률 × lateDays, qty × 계약가 × 상한)
```

전역 기본값 + 고객별 오버라이드 2단 구조. 미인도 잔량은 매일 누적되고 horizon 종료 시
`UNDELIVERED` 로 별도 집계된다.

### 6.8 원가율 — 전부 placeholder (§2.7)

| 파라미터 | 기본 | 단위 |
|---|---|---|
| `freightPerMileTruck` | 2.35 | USD/mile |
| `hubHandlingPerTruck` | 180 | USD/트럭 |
| `storagePerMWhDay` | 42 | USD/MWh·day |
| `idleCostPerHour` | CELL 8,500 / PACK 3,200 / LINK 2,400 | USD/h |
| `expediteMultiplier` | 3.2 | × |
| `inventoryValuePerMWh` | 180,000 | USD/MWh — **TODO: 실제 평가액** |

**총비용 = 기준물류비 + Blocking 유휴 + Starving 유휴 + 초과보관비 + 특송비 + LD 페널티**

### 6.9 엔진 상수 — 실측값 부재, 전부 가정 (`SIM`)

| 상수 | 값 | 근거 |
|---|---|---|
| `horizonDays` | 120 | 사양 |
| `daysPerMonth` | 30 | 주문 스케줄 단순화 |
| `roadFactor` | 1.25 | haversine → 도로거리 우회계수 |
| `milesPerDay` | 550 | 트럭 일 주행거리 (레버 400–700) |
| `loadUnloadDays` | 1 | 상하차 (레버 0–3) |
| `hubDwellDays` | 1 | CHI 환적 체류 (레버 0–3) |
| `initialInputFillPct` | 0.25 | 안전재고 = 입고창고의 25% (≈1.25일) |
| `targetInputFillPct` | 0.25 | 보충 목표 (§5.2) |
| `initialOutputFillPct` | CELL/PACK 0.35, LINK 0.6 | 중간 단계 FGI 는 배출될 곳이 없어 낮게, 완제품은 월 5회 인도 러시 대응으로 높게 |
| `targetOutputFillPct` | CELL/PACK 0.35, LINK 0.0 | 계획이 겨냥하는 출고재고 |
| `inventoryCorrectionDays` | 10 | 재고 편차 회복 기간 |
| `inventoryDeadBandPct` | 0.15 | 불감대 — 없으면 되먹임 죽은 시간(7+14일) 때문에 계통이 진동한다 |
| `preShipDays` | 21 | 고객 출하 선행일 (§6.10) |
| `ttsProbeStartDay` | 20 | TTS 계산 시 장애 주입 시점 |
| `freeStorageDays` | 2 | 이 일수 초과분만 초과보관비 부과 |
| `monteCarloRuns` | 200 | 기본 실행 횟수 |

### 6.10 `preShipDays` 가 21일인 이유

고객 인도일이 월 5회(5/10/15/20/25)에 몰려 있어 한 날짜에 최대 29 Link ≈ 149 MWh 가
집중된다. AZL 출고버퍼는 4일 ≈ 91 MWh 뿐이라 **완제품을 쌓아 두고 한 번에 치는 구조가
물리적으로 불가능하다.** 따라서 생산되는 대로 납기 임박순으로 계속 밀어내야 하며, 출하
착수 창을 넉넉히 열어 둔다. 기준선에서 실제 납기 여유는 평균 1.2일(최소 0일)로, 조기
출하가 여유를 만들어 주는 구조가 아니라 빠듯하게 맞물려 돌아간다.

---

## 7. 명시적 가정 (§9)

앱 안 ⚙ 설정 패널에 그대로 표시된다.

1. 상류 자재(양극재/음극재/분리막/전해액)는 **무한 공급** 가정 — 범위 밖
   (`UPSTREAM_MODEL: 'infinite'`, FLOW VIEW 의 Cell 카드에 `UPSTREAM: UNCONSTRAINED` 표기)
2. CHI Hub 는 **통과 환적**(cross-dock), 보관 기능 없음. dwell 일수만 리드타임에 가산되고
   환적 중 물량은 in-transit 재고로 계상
3. 거리 데이터는 LGES 물류 슬라이드 기준, **일부 미검증**
4. 창고 capacity 는 실측값 부재 → **일수 기준 추정, 레버화**
5. 계약가 $350K/MWh, LD 0.2%/일·상한 10% 는 **placeholder**
6. 이론 CAPA 는 Pack 이 병목이 되도록 **역산한 가정치**

---

## 8. 조작

| 키 | 동작 |
|---|---|
| `Space` | 재생 / 정지 |
| `←` / `→` | 1일 이동 |
| `Shift + ←/→` | 7일 이동 |
| `⌘K` / `Ctrl+K` | 검색 (노드 · Lane · 고객 · PO) |
| `1` / `2` / `3` | NETWORK / FLOW / COST |
| `Esc` | 선택 해제 · 모달 닫기 |

- **단위 토글** — 상단바에서 MWh / Link / Pack / Cell 전환. 원가는 항상 USD.
- **CSV export** — ⚙ 설정에서 노드 일별 상태 / PO 납기 실적 / 원가 분해 3종.
- **시나리오 공유** — 🔗 버튼이 레버·장애·플레이헤드 전체 상태를 인코딩한 URL 을 복사한다.
  기본값 대비 차분만 담아 링크가 짧게 유지된다.
- **드릴다운** — 우측 KPI, 원가 워터폴 막대, 알림, 간트 납기 마커 전부 클릭하면 그 숫자를
  만든 원천으로 이동한다.

---

## 9. 확률 모드 / Monte Carlo

- 일 산출량 `× triangular(0.85, 1.00, 1.05)`
- 수송시간 `triangular(base, base×1.15, base×1.60)`
- 비계획 다운타임 MTBF/MTTR 기반 Bernoulli (노드별 레버)
- 기본 200회를 **Web Worker** 에서 실행하고 KPI 를 P10/P50/P90 으로 반환. 진행률 표시.
- 플레이헤드는 시드 고정된 reference run 하나를 훑고, 간트 각 행 하단 스트립이
  "이 노드가 BLOCKED 일 확률" 히트맵이 된다.

기준선에서 확률 모드를 켜면 OTD 중앙값이 크게 떨어진다. Pack 여유가 0% 인 체인에서는
일 산출량 변동의 평균 손실(≈3%)만으로도 회복 불가능한 부족이 쌓이기 때문이며,
**이 네트워크에 완충이 없다는 사실 자체가 결과로 드러난다.**

---

## 10. 알려진 한계

- 상류 자재 제약 미모델링 (확장 지점 — `UPSTREAM_MODEL` 상수로 명시)
- 좌표는 placeholder, 일부 거리는 미검증 (§6.3)
- 원가율 · 계약 조건은 전부 placeholder — 실제 값으로 교체 필요
- Cell → Pack 배분은 거리 기반 휴리스틱이며 최적화가 아니다
- 월 = 30일 고정, 요일/휴일 캘린더 미반영
