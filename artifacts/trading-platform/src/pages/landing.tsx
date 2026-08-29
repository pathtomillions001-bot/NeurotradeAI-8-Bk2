import { motion } from "framer-motion";
import { useEffect, useRef } from "react";
import { ChevronRight, Clock, ShieldCheck, Zap, PlugZap } from "lucide-react";

// ── Floating particles canvas ─────────────────────────────────────────────────
function Particles() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    canvas.width = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;
    const W = canvas.width, H = canvas.height;
    const dots = Array.from({ length: 38 }, () => ({
      x: Math.random() * W,
      y: Math.random() * H,
      r: 0.6 + Math.random() * 1.2,
      vy: -(0.12 + Math.random() * 0.28),
      vx: (Math.random() - 0.5) * 0.12,
      opacity: 0.15 + Math.random() * 0.45,
      color: Math.random() > 0.5 ? "76,201,255" : Math.random() > 0.5 ? "139,92,246" : "0,245,212",
    }));
    let frame = 0;
    let id: number;
    function draw() {
      if (!ctx) return;
      ctx.clearRect(0, 0, W, H);
      frame++;
      for (const d of dots) {
        d.y += d.vy;
        d.x += d.vx;
        if (d.y < -4) { d.y = H + 4; d.x = Math.random() * W; }
        const pulse = 0.5 + 0.5 * Math.sin(frame * 0.03 + d.x);
        ctx.beginPath();
        ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${d.color},${d.opacity * pulse})`;
        ctx.fill();
      }
      id = requestAnimationFrame(draw);
    }
    draw();
    return () => cancelAnimationFrame(id);
  }, []);
  return <canvas ref={ref} className="absolute inset-0 w-full h-full pointer-events-none" />;
}

// ── Holographic market chart canvas ──────────────────────────────────────────
function HoloChart() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const W = canvas.width = 140;
    const H = canvas.height = 140;
    const cx = W / 2;
    const BAR_HEIGHTS = [38, 55, 42, 70, 58, 50, 78, 48];
    const N = BAR_HEIGHTS.length;
    let frame = 0;
    let id: number;
    function draw() {
      if (!ctx) return;
      ctx.clearRect(0, 0, W, H);
      frame++;
      const t = frame * 0.025;
      const barW = 12, barGap = 4;
      const totalW = N * barW + (N - 1) * barGap;
      const startX = (W - totalW) / 2;
      const baseY = H - 22;
      // Platform glow
      const pg = ctx.createRadialGradient(cx, baseY + 6, 0, cx, baseY + 6, 48);
      pg.addColorStop(0, "rgba(76,201,255,0.18)");
      pg.addColorStop(0.5, "rgba(139,92,246,0.07)");
      pg.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = pg;
      ctx.beginPath();
      ctx.ellipse(cx, baseY + 6, 52, 10, 0, 0, Math.PI * 2);
      ctx.fill();
      // Bars
      const heights = BAR_HEIGHTS.map((h, i) => h + Math.sin(t + i * 0.7) * 5);
      const nodePositions: { x: number; y: number }[] = [];
      heights.forEach((h, i) => {
        const x = startX + i * (barW + barGap);
        const y = baseY - h;
        nodePositions.push({ x: x + barW / 2, y });
        const barGrad = ctx.createLinearGradient(x, y, x, baseY);
        barGrad.addColorStop(0, "rgba(76,201,255,0.6)");
        barGrad.addColorStop(0.5, "rgba(139,92,246,0.3)");
        barGrad.addColorStop(1, "rgba(76,201,255,0.05)");
        ctx.fillStyle = barGrad;
        ctx.beginPath();
        ctx.roundRect(x, y, barW, h, 3);
        ctx.fill();
        // Bar shimmer highlight
        const shine = ctx.createLinearGradient(x, y, x + barW, y);
        shine.addColorStop(0, "rgba(255,255,255,0.12)");
        shine.addColorStop(0.5, "rgba(255,255,255,0.04)");
        shine.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = shine;
        ctx.beginPath();
        ctx.roundRect(x, y, barW * 0.5, h, [3, 0, 0, 3]);
        ctx.fill();
      });
      // Neon line
      ctx.beginPath();
      ctx.moveTo(nodePositions[0].x, nodePositions[0].y);
      for (let i = 1; i < nodePositions.length; i++) {
        const mx = (nodePositions[i - 1].x + nodePositions[i].x) / 2;
        const my = (nodePositions[i - 1].y + nodePositions[i].y) / 2;
        ctx.quadraticCurveTo(nodePositions[i - 1].x, nodePositions[i - 1].y, mx, my);
      }
      ctx.lineTo(nodePositions[N - 1].x, nodePositions[N - 1].y);
      ctx.strokeStyle = "rgba(0,245,212,0.85)";
      ctx.lineWidth = 1.5;
      ctx.shadowColor = "#00F5D4";
      ctx.shadowBlur = 8;
      ctx.stroke();
      ctx.shadowBlur = 0;
      // Data nodes
      nodePositions.forEach((p, i) => {
        const pulse = 0.5 + 0.5 * Math.sin(t * 1.5 + i * 0.9);
        const rOuter = 3 + pulse * 1.5;
        const ng = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, rOuter * 2);
        ng.addColorStop(0, "rgba(0,245,212,0.9)");
        ng.addColorStop(0.4, "rgba(76,201,255,0.4)");
        ng.addColorStop(1, "rgba(0,245,212,0)");
        ctx.fillStyle = ng;
        ctx.beginPath();
        ctx.arc(p.x, p.y, rOuter * 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(255,255,255,0.9)";
        ctx.fill();
      });
      id = requestAnimationFrame(draw);
    }
    draw();
    return () => cancelAnimationFrame(id);
  }, []);
  return <canvas ref={ref} width={140} height={140} style={{ imageRendering: "auto" }} />;
}

// ── NeuroAI logo ──────────────────────────────────────────────────────────────
function HexIcon() {
  return (
    <div className="relative w-10 h-10 flex items-center justify-center">
      <img src="/neuroai-logo.png" alt="" aria-hidden="true" className="w-10 h-10 object-contain" />
    </div>
  );
}

const FEATURES = [
  { Icon: Clock,        label: "24/7",   sub: "Markets Never Close", color: "#4CC9FF" },
  { Icon: ShieldCheck,  label: "Secure", sub: "Powered by Deriv",    color: "#00F5D4" },
  { Icon: Zap,          label: "Fast",   sub: "Instant Execution",   color: "#8B5CF6" },
];

export default function LandingPage({ onEnter }: { onEnter: () => void }) {
  const handleDeriv = () => {
    onEnter();
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 overflow-hidden relative"
      style={{ background: "radial-gradient(ellipse 120% 100% at 50% 30%, #0b0f1e 0%, #050816 60%, #050816 100%)" }}>
      {/* Digital grid */}
      <div className="absolute inset-0 pointer-events-none" style={{
        backgroundImage: "linear-gradient(rgba(76,201,255,0.025) 1px, transparent 1px), linear-gradient(90deg, rgba(76,201,255,0.025) 1px, transparent 1px)",
        backgroundSize: "44px 44px",
      }} />
      {/* Particles layer */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <Particles />
      </div>
      {/* Ambient glow spots */}
      <div className="absolute pointer-events-none" style={{ left: "20%", top: "25%", width: 300, height: 300, borderRadius: "50%", background: "radial-gradient(circle, rgba(139,92,246,0.08) 0%, transparent 70%)", filter: "blur(40px)" }} />
      <div className="absolute pointer-events-none" style={{ right: "15%", bottom: "25%", width: 250, height: 250, borderRadius: "50%", background: "radial-gradient(circle, rgba(76,201,255,0.07) 0%, transparent 70%)", filter: "blur(50px)" }} />

      {/* The card */}
      <motion.div
        animate={{ y: [0, -4, 0] }}
        transition={{ duration: 3.5, repeat: Infinity, ease: "easeInOut" }}
        className="relative z-10 w-full max-w-[360px]"
        style={{ filter: "drop-shadow(0 0 32px rgba(76,201,255,0.12)) drop-shadow(0 0 80px rgba(139,92,246,0.08))" }}
      >
        {/* Pulsing neon border */}
        <motion.div
          className="absolute -inset-px rounded-[28px] pointer-events-none"
          animate={{ opacity: [0.5, 1, 0.5] }}
          transition={{ duration: 2.5, repeat: Infinity, ease: "easeInOut" }}
          style={{
            background: "linear-gradient(135deg, rgba(76,201,255,0.6) 0%, rgba(139,92,246,0.4) 40%, rgba(0,245,212,0.5) 100%)",
            borderRadius: 28,
            padding: 1,
          }}
        >
          <div className="w-full h-full rounded-[27px]" style={{ background: "#080d1c" }} />
        </motion.div>

        {/* Card body */}
        <div className="relative rounded-[28px] overflow-hidden" style={{
          background: "linear-gradient(160deg, rgba(15,20,38,0.97) 0%, rgba(8,12,28,0.99) 55%, rgba(11,16,32,0.98) 100%)",
          backdropFilter: "blur(24px)",
          WebkitBackdropFilter: "blur(24px)",
          boxShadow: "0 40px 100px rgba(0,0,0,0.8), inset 0 1px 0 rgba(76,201,255,0.12), inset 0 -1px 0 rgba(139,92,246,0.08)",
          border: "1px solid rgba(76,201,255,0.15)",
        }}>
          {/* Moving light reflection */}
          <motion.div
            className="absolute inset-x-0 top-0 h-px pointer-events-none"
            animate={{ opacity: [0.4, 0.9, 0.4], scaleX: [0.6, 1, 0.6] }}
            transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
            style={{ background: "linear-gradient(90deg, transparent 5%, rgba(76,201,255,0.8) 50%, transparent 95%)", transformOrigin: "center" }}
          />
          <motion.div
            className="absolute pointer-events-none"
            animate={{ x: ["-100%", "200%"] }}
            transition={{ duration: 4, repeat: Infinity, ease: "linear", repeatDelay: 2 }}
            style={{ top: 0, bottom: 0, left: 0, width: "40%", background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.02), transparent)", transform: "skewX(-20deg)" }}
          />

          <div className="p-5">
            {/* Top row */}
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <HexIcon />
                <span className="font-bold text-white text-sm tracking-tight" style={{ fontFamily: "system-ui" }}>NeuroTrade AI</span>
              </div>
              <motion.div
                animate={{ opacity: [0.7, 1, 0.7] }}
                transition={{ duration: 1.8, repeat: Infinity }}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-full"
                style={{ background: "rgba(0,245,212,0.07)", border: "1px solid rgba(0,245,212,0.3)" }}
              >
                <span className="w-1.5 h-1.5 rounded-full inline-block" style={{ background: "#00F5D4", boxShadow: "0 0 6px #00F5D4" }} />
                <span className="text-[10px] font-bold tracking-widest uppercase" style={{ color: "#00F5D4" }}>Market Open</span>
              </motion.div>
            </div>

            {/* Hero section: text + chart */}
            <div className="flex items-start gap-2 mb-4">
              <div className="flex-1">
                <h1 className="text-xl font-black leading-tight tracking-tight text-white mb-1">
                  WELCOME TO<br />
                  <span style={{ background: "linear-gradient(90deg, #4CC9FF, #8B5CF6, #00F5D4)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
                    NEUROTRADE AI
                  </span>
                </h1>
                <p className="text-xs leading-relaxed" style={{ color: "rgba(180,190,220,0.65)" }}>
                  Trade 24/7 on volatility.<br />
                  Opportunities never sleep.
                </p>
              </div>
              {/* Holographic chart */}
              <div className="relative flex-shrink-0">
                <motion.div
                  animate={{ opacity: [0.4, 0.7, 0.4] }}
                  transition={{ duration: 2.8, repeat: Infinity, ease: "easeInOut" }}
                  className="absolute inset-0 rounded-xl pointer-events-none"
                  style={{ background: "radial-gradient(ellipse at center, rgba(76,201,255,0.12) 0%, transparent 70%)", filter: "blur(4px)" }}
                />
                <div className="relative rounded-xl overflow-hidden" style={{ background: "rgba(76,201,255,0.03)", border: "1px solid rgba(76,201,255,0.1)" }}>
                  <HoloChart />
                </div>
              </div>
            </div>

            {/* Separator */}
            <div className="h-px mb-4" style={{ background: "linear-gradient(90deg, transparent, rgba(76,201,255,0.15), rgba(139,92,246,0.15), transparent)" }} />

            {/* Feature icons */}
            <div className="grid grid-cols-3 gap-2 mb-4">
              {FEATURES.map(({ Icon, label, sub, color }) => (
                <div key={label} className="flex flex-col items-center gap-1.5 p-2.5 rounded-xl"
                  style={{ background: "rgba(255,255,255,0.025)", border: "1px solid rgba(76,201,255,0.08)" }}>
                  <Icon className="w-4 h-4" style={{ color }} strokeWidth={1.8} />
                  <span className="text-[11px] font-bold text-white">{label}</span>
                  <span className="text-[9px] text-center leading-snug" style={{ color: "rgba(160,170,200,0.55)" }}>{sub}</span>
                </div>
              ))}
            </div>

            {/* Separator */}
            <div className="h-px mb-4" style={{ background: "linear-gradient(90deg, transparent, rgba(139,92,246,0.12), transparent)" }} />

            {/* AI capability callout */}
            <motion.div
              className="flex items-center gap-2.5 mb-4 px-3 py-2.5 rounded-xl"
              animate={{ opacity: [0.8, 1, 0.8] }}
              transition={{ duration: 3, repeat: Infinity }}
              style={{ background: "rgba(76,201,255,0.05)", border: "1px solid rgba(76,201,255,0.14)" }}
            >
              <div className="flex flex-col gap-0.5 flex-1">
                <span className="text-[10px] font-bold tracking-widest uppercase" style={{ color: "#4CC9FF" }}>
                  8 AI Agents · 17+ Markets
                </span>
                <span className="text-[10px]" style={{ color: "rgba(160,175,210,0.7)" }}>
                  Neural ensemble scoring every tick, every trade.
                </span>
              </div>
              <div className="flex flex-col items-end gap-0.5">
                <span className="text-[9px] font-bold" style={{ color: "#00F5D4" }}>LIVE</span>
                <motion.div
                  className="w-1.5 h-1.5 rounded-full"
                  animate={{ opacity: [1, 0.3, 1] }}
                  transition={{ duration: 1.2, repeat: Infinity }}
                  style={{ background: "#00F5D4", boxShadow: "0 0 6px #00F5D4" }}
                />
              </div>
            </motion.div>

            {/* CTA buttons */}
            <div className="space-y-2">
              <motion.button
                whileHover={{ scale: 1.015 }}
                whileTap={{ scale: 0.985 }}
                onClick={handleDeriv}
                className="w-full flex items-center justify-center gap-2 py-3 rounded-xl font-bold text-sm text-white"
                style={{
                  background: "linear-gradient(135deg, #4CC9FF 0%, #8B5CF6 60%, #00F5D4 100%)",
                  boxShadow: "0 0 28px rgba(76,201,255,0.35), 0 0 60px rgba(139,92,246,0.2), inset 0 1px 0 rgba(255,255,255,0.2)",
                }}
              >
                <PlugZap className="w-4 h-4" />
                Connect with Deriv
                <ChevronRight className="w-3.5 h-3.5" />
              </motion.button>
            </div>

            <p className="text-[9px] text-center mt-3" style={{ color: "rgba(80,90,120,0.7)" }}>
              OAuth · No credentials stored locally · Real-time Deriv trading
            </p>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
