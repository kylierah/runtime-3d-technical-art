# Tactical Breach — WebGL / Three.js 3D FPS & Technical Art Pipeline

상용 게임 엔진(Unity/Unreal) 없이 **Three.js(WebGL)와 Rapier 물리 엔진**만으로 구축한 3D 택티컬 FPS 프로토타입입니다.  
생성형 3D AI(**SAM 3D**)와 Google Labs Playground를 활용한 AI 기반 게임 프로토타이핑 및 개발, 생성형 에셋의 비규격·재질 오류와 애니메이션·VFX를 코드 기반 **테크니컬 아트(TA) 파이프라인**으로 제어하여 실시간 60FPS 구동과 Windows 단독 실행 파일(`.exe`) 패키징까지 완료했습니다.

<img width="2240" height="1125" alt="Tactical Breach" src="https://github.com/user-attachments/assets/df7dedf3-fcaa-41db-ada6-d84188a19919" />


---

## Tech Stack & Architecture
- **3D Rendering:** Three.js (`0.185.0`), `@react-three/fiber`, `@react-three/postprocessing` (Bloom)
- **Physics & Math:** `@react-three/rapier`, `three-stdlib` (`GLTFLoader`, `DRACOLoader`, `SkeletonUtils`)
- **Frontend & Packaging:** React 19, TypeScript, Vite, Electron (`win32-x64` Standalone Build)
- **AI & 3D Tools:** SAM 3D (3D Prop Generation), Draco Mesh Compression

---

## Technical Art & Asset Pipeline

### 1. SAM 3D 및 외부 GLB 에셋 자동 정규화 (Asset Normalization)
AI로 생성한 3D 에셋(군용 트럭 등)과 외부 캐릭터 모델은 스케일, 피벗(중심축), PBR 재질 수치가 서로 달라 엔진 내 배치 시 공중에 뜨거나 검게 타는 문제가 발생합니다. 로드 시점에 이를 자동 보정하는 파이프라인을 구축했습니다.
- **Mesh 기반 바운딩 박스 측정:** 더미 노드를 제외하고 실제 `isMesh` 노드만을 순회해 `THREE.Box3`로 외곽 크기를 산출 후 목표 규격(트럭 `9.8m`, 병사 `3.30m`)으로 자동 스케일링.
- **자동 바닥 접지 (Auto-Grounding):** 스케일링된 바운딩 박스의 최하단(`min.y`)을 계산해 지면(`y = 0`)에 오차 없이 밀착.
- **PBR 재질 클램핑 (Material Clamping):** 생성형 에셋의 과도한 `metalness`나 렌더링 누락을 방지하기 위해 `metalness <= 0.35`, `roughness >= 0.45`, `depthWrite = true`, `DoubleSide`로 일괄 정규화.
- **Draco 압축 디코딩:** 웹 환경의 에셋 로딩 병목을 줄이기 위해 `DRACOLoader` 파이프라인 연동.


### 2. 스켈레톤 리타겟팅, 실시간 본 소켓 및 중력 낙하 보정
- **다중 GLB 애니메이션 병합 (`cleanAndRetargetClip`):** 기본 캐릭터 메시(`hjuano.glb`)와 분리된 사격(`r4mabm.glb`)·피격(`vh455p.glb`) 애니메이션 클립을 런타임에 결합하며, 본 비율 왜곡을 일으키는 `.position` / `.scale` 트랙을 제거하고 회전(`.quaternion`) 트랙만 정규화 추출.
- **양손 본 추적 무기 소켓:** 오른손·왼손 본 월드 좌표를 `useFrame`에서 실시간 추적하여 총기(`upvi4m.glb`)의 조준 방향 벡터와 총구 화염(Muzzle Flash) 위치를 동기화.
- **중력 가속 낙하 & 넉백 보정:** 위치 트랙이 제거된 피격 애니메이션(`Fall`) 재생 시 공중에 뜨는 현상을 막기 위해 Ease-Out 중력 곡선(`1 - (1 - progress)^3`)과 후방 넉백 이동을 결합해 바닥(`y = 0.20`)에 안착.

### 3. 공간 반응형 VFX & 렌더링 최적화
- **공간별 환경 반응형 모래먼지 VFX:** 피격 후 지면 충돌 시점(`progress >= 0.35`)에 방사형 빌보드 먼지 파티클을 생성하되, 적의 월드 Z 좌표를 판별해 실내 콘크리트 창고(`z > -28`)에서는 쿨 그레이 먼지, 야외 사막(`z <= -28`)에서는 옐로 오커 모래 먼지로 자동 블렌딩. `meshStandardMaterial`을 적용해 씬 조명·안개에 자연스럽게 스며들고 Bloom 과발광을 방지.
- **절차적 텍스처 (Procedural Textures):** HTML5 Canvas API로 콘크리트, 탄약 상자, 그라데이션 스카이 돔, 지면 경계 모래 데칼, 총구 화염 스프라이트를 코드로 실시간 생성해 텍스처 용량 절감.
- **Draw Call 배칭 (`InstancedMesh`):** 다수의 탄환 궤적(Tracer)과 피격 스파크 파티클을 `InstancedMesh`로 통합 렌더링해 드로우 콜 부하 최소화.

---

## Diegetic UI Visual System & Real-Time TA Debugger
- **Extending the World into the Interface:** 웹 모달 카드와 둥근 모서리(`rounded-none`)를 배제하고, 매트 차콜(`#0a0c0e`)·기밀 문서 오프화이트(`#f2f0eb`)·전술 크림슨(`#d93829`)·사막 오커(`#c89d5c`) 팔레트와 `1px` 헤어라인으로 3D 공간과 일체화된 프론트엔드 구축.
- **3-Tier Typography Hierarchy:** 디스플레이 타이틀(`Orbitron`), 전술 액션/무기명(`Rajdhani`), 텔레메트리 및 `tabular-nums` 탄약 수치(`JetBrains Mono`)로 정보 위계 분리.
- **내장형 TA 실시간 디버거 (`F3` Toggle):** 게임 실행 중 `F3` 키를 눌러 4종 GLB 에셋 로드 상태, 스켈레톤 메시/본 카운트, 실시간 월드 좌표, 애니메이션 스테이트(`idle` / `shoot` / `fall`)를 즉시 검증 가능.

<img width="1864" height="960" alt="tacticalbreach" src="https://github.com/user-attachments/assets/4d18534c-741d-426d-b62a-1a7640570367" />


---

## Spatial Level Architecture (Indoor-to-Outdoor Vertical Slice)
- **Zone 1 — Indoor CQB Warehouse (`60×60m`):** 콘크리트 기둥, 강철 천장 트러스, 엄폐물 클러스터(방벽·탄약 상자·드럼통)가 배치된 근접 교전 구역.
- **Zone 2 — Breach Threshold (`z = -29`):** 철근이 노출된 파괴된 콘크리트 벽과 바람에 날린 모래 그라데이션 데칼로 실내외 공간 전환을 시각적으로 연결.
- **Zone 3 — Outdoor Desert Range (`120×80m`):** 옐로 오커 사막 지형과 그라데이션 스카이 돔, L자형 모래주머니 벙커, 컨테이너, 외곽 감시탑 및 철조망 너머 군용 트럭(SAM 3D 에셋)이 배치된 원거리 교전 구역.

---

## Controls & Standalone Build
- **Keyboard & Mouse:** `WASD` 이동 / `Mouse` 시점 회전 / `좌클릭` 사격 / `R` 재장전 / `F3` TA 디버거 토글
- **Gamepad (Xbox Wireless Controller):** Gamepad API 연동을 통한 아날로그 스틱 이동·조준 및 트리거 사격 지원
- **Standalone Build:** Electron 래퍼를 통해 Windows 환경에서 설치 없이 바로 실행 가능한 `.exe` 패키지로 빌드
