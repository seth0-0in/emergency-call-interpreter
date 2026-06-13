// ============================================================================
// 메인 런처 (`/`).
//
// 현장(상황실 모니터) 사용 우선. 4 개 카드로 진입점을 노출한다.
//   주요 기능: 상황실 콘솔 / 신고자 시뮬레이터
//   도구    : 업로드 전사 / 결과 문서
//
// 레거시 `/realtime` 은 새 상황실 콘솔이 대체하므로 런처에 노출하지 않는다.
// 라우트 자체와 RealtimePage 파일은 보존 (직접 URL 진입 가능).
// ============================================================================

import { useNavigate } from "react-router-dom";
import { COLORS, TYPO } from "../theme";

type CardSpec = {
  emoji: string;
  title: string;
  description: string;
  to: string;
};

const PRIMARY_CARDS: CardSpec[] = [
  {
    emoji: "🚒",
    title: "상황실 콘솔 시작",
    description: "실시간 통번역 및 기록",
    to: "/console",
  },
  {
    emoji: "🌏",
    title: "신고자 시뮬레이터",
    description: "신고자 테스트 화면",
    to: "/simulator",
  },
];

const TOOL_CARDS: CardSpec[] = [
  {
    emoji: "📂",
    title: "업로드 전사",
    description: "녹음파일 분석",
    to: "/upload",
  },
  {
    emoji: "📄",
    title: "결과 문서",
    description: "저장된 신고 기록 확인",
    to: "/result",
  },
];

export default function LauncherPage() {
  const navigate = useNavigate();

  return (
    <div
      style={{
        minHeight: "100vh",
        backgroundColor: COLORS.pageBg,
        color: COLORS.onDark,
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* 상단 적색 라인 — AppHeader 와 동일 강조 */}
      <div style={{ height: 3, backgroundColor: COLORS.red }} />

      <main
        style={{
          flex: 1,
          maxWidth: 1280,
          width: "100%",
          margin: "0 auto",
          padding: "56px 32px 64px",
          boxSizing: "border-box",
        }}
      >
        {/* 헤더 영역 — 119 배지 + 제목 + 설명 */}
        <section
          style={{
            display: "flex",
            alignItems: "center",
            gap: 18,
            marginBottom: 14,
          }}
        >
          <div
            style={{
              backgroundColor: COLORS.red,
              color: "#fff",
              fontWeight: 900,
              fontSize: 26,
              lineHeight: 1,
              borderRadius: 12,
              padding: "12px 14px",
              letterSpacing: 1,
            }}
          >
            119
          </div>
          <div>
            <h1
              style={{
                margin: 0,
                fontSize: TYPO.fs.display,
                fontWeight: TYPO.fw.extra,
                color: "#ffffff",
                letterSpacing: -0.4,
                lineHeight: 1.2,
              }}
            >
              🚒 119 외국인 신고자 실시간 통번역 시스템
            </h1>
            <p
              style={{
                margin: "8px 0 0",
                color: COLORS.onDarkMuted,
                fontSize: TYPO.fs.md,
                lineHeight: TYPO.lh.normal,
              }}
            >
              외국인 신고자와 119 상황실 간의 실시간 통번역 및 신고 기록
              작성을 지원하는 시스템
            </p>
          </div>
        </section>

        {/* 주요 기능 섹션 */}
        <SectionTitle label="주요 기능" />
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
            gap: 24,
            marginBottom: 48,
          }}
        >
          {PRIMARY_CARDS.map((card) => (
            <PrimaryCard
              key={card.to}
              card={card}
              onClick={() => navigate(card.to)}
            />
          ))}
        </div>

        {/* 도구 섹션 */}
        <SectionTitle label="도구" />
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
            gap: 18,
          }}
        >
          {TOOL_CARDS.map((card) => (
            <ToolCard
              key={card.to}
              card={card}
              onClick={() => navigate(card.to)}
            />
          ))}
        </div>
      </main>
    </div>
  );
}

function SectionTitle({ label }: { label: string }) {
  return (
    <h2
      style={{
        margin: "32px 0 16px",
        fontSize: TYPO.fs.lg,
        fontWeight: TYPO.fw.extra,
        color: "#ffffff",
        display: "flex",
        alignItems: "center",
        gap: 10,
        borderLeft: `4px solid ${COLORS.red}`,
        paddingLeft: 12,
        lineHeight: 1.2,
      }}
    >
      {label}
    </h2>
  );
}

function PrimaryCard({
  card,
  onClick,
}: {
  card: CardSpec;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        textAlign: "left",
        cursor: "pointer",
        backgroundColor: COLORS.cardBg,
        border: `2px solid ${COLORS.red}`,
        borderRadius: 16,
        padding: "32px 28px",
        boxShadow: "0 12px 30px rgba(217, 45, 32, 0.22)",
        display: "flex",
        flexDirection: "column",
        gap: 16,
        minHeight: 200,
        transition: "transform 120ms ease, box-shadow 120ms ease",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = "translateY(-2px)";
        e.currentTarget.style.boxShadow =
          "0 18px 38px rgba(217, 45, 32, 0.30)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = "translateY(0)";
        e.currentTarget.style.boxShadow =
          "0 12px 30px rgba(217, 45, 32, 0.22)";
      }}
    >
      <div
        style={{
          fontSize: 48,
          lineHeight: 1,
        }}
      >
        {card.emoji}
      </div>
      <div
        style={{
          fontSize: TYPO.fs.xl,
          fontWeight: TYPO.fw.extra,
          color: COLORS.ink,
          lineHeight: 1.25,
        }}
      >
        {card.title}
      </div>
      <div
        style={{
          fontSize: TYPO.fs.md,
          fontWeight: TYPO.fw.medium,
          color: COLORS.inkSoft,
          lineHeight: TYPO.lh.normal,
        }}
      >
        {card.description}
      </div>
      <div
        style={{
          marginTop: "auto",
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          color: COLORS.red,
          fontWeight: TYPO.fw.bold,
          fontSize: TYPO.fs.base,
        }}
      >
        바로 가기 →
      </div>
    </button>
  );
}

function ToolCard({
  card,
  onClick,
}: {
  card: CardSpec;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        textAlign: "left",
        cursor: "pointer",
        backgroundColor: COLORS.cardBg,
        border: `1px solid ${COLORS.cardBorder}`,
        borderRadius: 12,
        padding: "20px 22px",
        boxShadow: "0 4px 14px rgba(5, 18, 40, 0.20)",
        display: "flex",
        alignItems: "center",
        gap: 18,
        transition: "transform 120ms ease, box-shadow 120ms ease",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = "translateY(-1px)";
        e.currentTarget.style.boxShadow =
          "0 8px 22px rgba(5, 18, 40, 0.28)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = "translateY(0)";
        e.currentTarget.style.boxShadow =
          "0 4px 14px rgba(5, 18, 40, 0.20)";
      }}
    >
      <div
        style={{
          fontSize: 28,
          lineHeight: 1,
          width: 48,
          height: 48,
          borderRadius: 10,
          backgroundColor: COLORS.navySoft,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        {card.emoji}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <div
          style={{
            fontSize: TYPO.fs.lg,
            fontWeight: TYPO.fw.bold,
            color: COLORS.ink,
            lineHeight: 1.25,
          }}
        >
          {card.title}
        </div>
        <div
          style={{
            fontSize: TYPO.fs.sm,
            color: COLORS.inkMuted,
            lineHeight: TYPO.lh.normal,
          }}
        >
          {card.description}
        </div>
      </div>
    </button>
  );
}
