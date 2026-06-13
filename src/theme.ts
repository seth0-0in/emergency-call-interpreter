/**
 * 119 긴급구조 공공 서비스 공통 색상/스타일 토큰.
 * 어두운 네이비 배경 + 흰색 카드 + 강조색(긴급 적색 / 행정 네이비) 구성.
 */

export const COLORS = {
  // 페이지 / 헤더 (어두운 네이비)
  pageBg: "#0b1f3a",
  headerBg: "#0a1b34",
  // 어두운 보조 패널
  panelBg: "#102a4d",
  panelBorder: "#23446f",
  // 흰색 카드 / 행정 문서
  cardBg: "#ffffff",
  cardBorder: "#d3dbe7",
  track: "#eef1f6",
  // 텍스트
  ink: "#1f2a37",
  inkSoft: "#3f4856",
  inkMuted: "#717c8b",
  onDark: "#eef3fa",
  onDarkMuted: "#9db0ca",
  // 강조색
  red: "#d92d20",
  redDark: "#b21e13",
  redSoft: "#fdeceb",
  navy: "#1c4e8f",
  navyDark: "#143a6b",
  navySoft: "#e9f0f9",
  amber: "#b8730a",
  amberSoft: "#fef3c7",
  green: "#0f7b54",
  greenSoft: "#dcfce7",
  violet: "#6d44b8",
  violetSoft: "#ede9fe",
  slate: "#516175",
  slateSoft: "#e2e8f0",
  // 발화자 구분 (신고자 = 적색 계열, 구급대원 = 네이비 계열)
  caller: "#c0392b",
  callerSoft: "#fbeceb",
  operator: "#1c4e8f",
  operatorSoft: "#e9f0f9",
} as const;

/**
 * 긴급도 색 매핑 — 의미 색. 항상 라벨/아이콘과 함께 써서 색만으로 구분되지 않도록.
 *   높음=red, 보통=amber, 낮음=green, 미상=slate
 */
export const URGENCY_COLOR: Record<string, { fg: string; bg: string; border: string }> = {
  "높음": { fg: "#fff", bg: COLORS.red, border: COLORS.redDark },
  "보통": { fg: "#7c3a00", bg: COLORS.amberSoft, border: COLORS.amber },
  "낮음": { fg: "#0f5132", bg: COLORS.greenSoft, border: COLORS.green },
  "미상": { fg: COLORS.inkSoft, bg: COLORS.slateSoft, border: COLORS.cardBorder },
};

/**
 * 사고 유형 배지 색 매핑. summarizeCall.ts 의 IncidentType 과 동일한 키.
 *   구급=red, 화재=amber, 구조=violet, 교통사고=navy, 기타/미상=slate
 */
export const INCIDENT_COLOR: Record<string, { fg: string; bg: string }> = {
  "구급": { fg: "#fff", bg: COLORS.red },
  "화재": { fg: "#7c3a00", bg: COLORS.amberSoft },
  "구조": { fg: "#3b1d6e", bg: COLORS.violetSoft },
  "교통사고": { fg: "#fff", bg: COLORS.navy },
  "기타": { fg: COLORS.inkSoft, bg: COLORS.slateSoft },
  "미상": { fg: COLORS.inkSoft, bg: COLORS.slateSoft },
};

/**
 * 상태 인디케이터 색 — 마이크/번역/전송 등.
 *   live(듣는중)=green, processing=amber, ok=green, error=red, idle=slate.
 */
export const STATUS_COLOR = {
  live:       { fg: COLORS.green, bg: COLORS.greenSoft, dot: COLORS.green },
  processing: { fg: COLORS.amber, bg: COLORS.amberSoft, dot: COLORS.amber },
  ok:         { fg: COLORS.green, bg: COLORS.greenSoft, dot: COLORS.green },
  error:      { fg: COLORS.red,   bg: COLORS.redSoft,   dot: COLORS.red },
  idle:       { fg: COLORS.slate, bg: COLORS.slateSoft, dot: COLORS.slate },
} as const;

/**
 * 타이포 스케일 — 긴급 콘솔용. 본문은 충분히 크게(15px+), 보조정보는 작게(11~12px).
 */
export const TYPO = {
  // 폰트 사이즈 (px)
  fs: {
    xs: 11,
    sm: 13,
    base: 15,
    md: 16,
    lg: 18,
    xl: 22,
    display: 28,
  },
  // 굵기
  fw: {
    normal: 400,
    medium: 500,
    semibold: 600,
    bold: 700,
    extra: 800,
  },
  // 줄 높이
  lh: {
    tight: 1.25,
    normal: 1.45,
    relaxed: 1.6,
  },
} as const;

/** 흰색 카드 공통 스타일 */
export const whiteCard: React.CSSProperties = {
  backgroundColor: COLORS.cardBg,
  border: `1px solid ${COLORS.cardBorder}`,
  borderRadius: 14,
  padding: 22,
  boxShadow: "0 6px 22px rgba(5, 18, 40, 0.28)",
};

/** 카드 내부 섹션 제목 스타일 */
export const sectionHeading: React.CSSProperties = {
  margin: "0 0 14px",
  fontSize: 18,
  fontWeight: 800,
  color: COLORS.ink,
  display: "flex",
  alignItems: "center",
  gap: 8,
  borderLeft: `4px solid ${COLORS.red}`,
  paddingLeft: 10,
  lineHeight: 1.2,
};
