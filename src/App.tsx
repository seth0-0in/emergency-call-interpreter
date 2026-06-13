import { BrowserRouter, Routes, Route } from "react-router-dom";
import LauncherPage from "./pages/LauncherPage";
import UploadPage from "./pages/UploadPage";
import RealtimePage from "./pages/RealtimePage";
import ResultPage from "./pages/ResultPage";
import ConsolePage from "./pages/ConsolePage";
import SimulatorPage from "./pages/SimulatorPage";

// Vite base(예: "/static/119/")에서 동작하도록 Router에 basename을 맞춰준다.
// 새로고침 시 `<host>/static/119/realtime` 같은 경로가 올바르게 라우팅된다.
const ROUTER_BASENAME = import.meta.env.BASE_URL.replace(/\/$/, "") || "/";

function App() {
  return (
    <BrowserRouter basename={ROUTER_BASENAME}>
      <Routes>
        {/* 메인 런처 — 4 개 진입점(콘솔/시뮬레이터/업로드/결과) 카드. */}
        <Route path="/" element={<LauncherPage />} />
        {/* 업로드 전사 — 기존 인덱스가 담당하던 페이지를 명시 라우트로 이관. */}
        <Route path="/upload" element={<UploadPage />} />
        {/* 레거시 실시간 통역 — 상황실 콘솔이 대체하지만 라우트는 보존. */}
        <Route path="/realtime" element={<RealtimePage />} />
        <Route path="/result" element={<ResultPage />} />
        {/* 119 외국인 신고자 상황실 — 콘솔(메인)과 신고자 시뮬레이터(데모). */}
        <Route path="/console" element={<ConsolePage />} />
        <Route path="/simulator" element={<SimulatorPage />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;